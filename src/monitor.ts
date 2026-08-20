import * as fs from 'fs';
import * as path from 'path';
import { BalanceChecker } from './balance';
import { BridgeFiles } from './bridge';
import { DailyTotals } from './daily';
import { JsonlFallback } from './jsonl';
import { TitleStore } from './titles';
import { BridgeData, RenderState, SourceMode, WarningData } from './types';

const LOG_MAX = 100 * 1024; // ext.log 上限 100KB，超限截半

/**
 * 主编排 + SourceMode 状态机：
 *   bridge —— 桥接文件新鲜（age ≤ stalenessMs）
 *   jsonl  —— 桥接缺失/陈旧 → JSONL 兜底（桥接恢复后自动切回）
 *   none   —— 运行时目录尚未安装
 * 扩展是只读方：桥接文件由 statusline/hook 脚本单写者写入。
 */
export class Monitor {
  private mode: SourceMode = 'none';
  private stale = false;
  private sessionChurn = false;
  private bridgeData: BridgeData | null = null;
  private warningData: WarningData | null = null;
  private anchor: { transcriptPath: string | null; sessionId: string | null } | null = null;
  private lastAnchorKey = '';
  private ticker: NodeJS.Timeout | null = null;
  private recentSessions: Array<{ id: string; t: number }> = [];
  private disposed = false;

  private readonly files: BridgeFiles;
  private readonly jsonl: JsonlFallback;
  private readonly daily: DailyTotals;

  constructor(
    private readonly runDir: string,
    private refreshMs: number,
    private stalenessMs: number,
    private readonly onState: (state: RenderState) => void,
    projectsDirOverride?: string,
    private readonly titleStore?: TitleStore,
    private readonly balanceChecker?: BalanceChecker
  ) {
    this.files = new BridgeFiles(runDir, () => {
      this.readFiles();
      this.evaluate();
      this.emit();
    });
    this.jsonl = new JsonlFallback(
      (data) => {
        this.log(`jsonl 产出: source=${data.source} hit=${data.stats.cacheHitRate ?? 'null'} transcript=${data.transcriptPath ?? 'null'}`);
        if (this.mode === 'jsonl') {
          this.bridgeData = data;
          this.emit();
        }
      },
      projectsDirOverride
    );
    this.daily = new DailyTotals(projectsDirOverride ? projectsDirOverride : undefined);
  }

  /** 诊断日志：写 runDir/ext.log（截断式，上限 100KB），排障时直接读文件 */
  private log(msg: string): void {
    try {
      const p = path.join(this.runDir, 'ext.log');
      const line = `${new Date().toISOString()} ${msg}\n`;
      let content = '';
      try {
        content = fs.readFileSync(p, 'utf8');
      } catch {
        /* 首次写入 */
      }
      content += line;
      if (content.length > LOG_MAX) content = content.slice(content.length - LOG_MAX / 2);
      fs.mkdirSync(this.runDir, { recursive: true });
      fs.writeFileSync(p, content);
    } catch {
      /* 日志失败不影响主流程 */
    }
  }

  private dailyRefresh(): void {
    try {
      this.daily.refresh();
      this.balanceChecker?.setCostToday(this.daily.total ?? 0);
    } catch (e) {
      this.log(`daily 刷新异常: ${String(e)}`);
    }
  }

  start(): void {
    this.log(`Monitor 启动: runDir=${this.runDir} refreshMs=${this.refreshMs} stalenessMs=${this.stalenessMs}`);
    this.readFiles();
    this.files.start();
    this.evaluate();
    this.dailyRefresh();
    this.balanceChecker?.start();
    this.emit();
    this.restartTicker();
  }

  updateIntervals(refreshMs: number, stalenessMs: number): void {
    this.refreshMs = refreshMs;
    this.stalenessMs = stalenessMs;
    this.restartTicker();
  }

  /** 用户从会话列表钉选/解除：钉选后一直监控该会话；null = 回到"跟随最新" */
  pinTranscript(p: string | null): void {
    if (this.mode === 'jsonl') {
      this.log(`钉选会话: ${p ?? '(解除, 跟随最新)'}`);
      this.jsonl.pin(p);
    }
    this.refreshNow(false);
  }

  /** "当前对话"：钉选最后一条用户消息最新的会话（屏幕上正在显示的对话的最佳代理） */
  pinCurrentConversation(): void {
    this.dailyRefresh();
    const p = this.daily.currentConversationPath();
    this.log(`钉选"当前对话": ${p ?? '(未找到)'}`);
    if (p) this.pinTranscript(p);
  }

  refreshNow(force = false): void {
    if (force && this.mode === 'jsonl') {
      this.log('手动强制刷新（丢弃会话选择，重选最新活跃者）');
      this.jsonl.forceRefresh();
    }
    this.readFiles();
    this.evaluate();
    if (this.mode === 'jsonl') this.jsonl.poll();
    this.dailyRefresh();
    this.emit();
  }

  private restartTicker(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = setInterval(() => this.tick(), Math.max(this.refreshMs, 1000));
  }

  private readFiles(): void {
    const b = this.files.readBridge();
    if (b && b.source === 'panel-anchor') {
      // 面板会话锚点（空 stdin 的 statusline 调用写的）：只作为兜底模式的会话定位提示，不当作数据源
      this.anchor = { transcriptPath: b.transcriptPath, sessionId: b.sessionId };
    } else {
      const age = this.files.ageMs(b);
      const fresh = b != null && age != null && age <= this.stalenessMs;
      // jsonl 模式下桥接不新鲜 → 保持 jsonl 回调写入的数据，不被每 tick 清空
      // （否则状态栏会在数据到达后 1 秒闪回"未连接"）
      if (fresh || this.mode !== 'jsonl') {
        this.bridgeData = b;
      }
    }
    this.warningData = this.files.readWarning();
  }

  private evaluate(): void {
    const isBridgeSource = this.bridgeData != null && this.bridgeData.source !== 'jsonl';
    const age = this.files.ageMs(this.bridgeData);
    if (isBridgeSource && age != null && age <= this.stalenessMs) {
      if (this.mode !== 'bridge') {
        this.log(`模式切换: ${this.mode} → bridge（桥接新鲜, age=${age}ms）`);
        this.mode = 'bridge';
        this.stale = false;
        this.jsonl.stop();
      }
    } else if (this.bridgeData) {
      // 桥接陈旧 → 兜底（优先用锚点/陈旧桥接里的 transcriptPath 定位会话）
      if (this.mode !== 'jsonl') {
        this.log(`模式切换: ${this.mode} → jsonl（桥接陈旧, age=${age ?? 'null'}ms）`);
        this.mode = 'jsonl';
        this.stale = true;
        this.lastAnchorKey = this.anchor?.transcriptPath ?? '';
        this.jsonl.start(this.anchor?.transcriptPath ?? this.bridgeData.transcriptPath ?? null);
      }
    } else if (this.mode !== 'jsonl') {
      this.log('模式切换: ' + this.mode + ' → jsonl（无桥接文件）');
      this.mode = 'jsonl';
      this.stale = true;
      this.lastAnchorKey = this.anchor?.transcriptPath ?? '';
      this.jsonl.start(this.anchor?.transcriptPath ?? null);
    }
    // 已在 jsonl 模式时收到新锚点（用户开了新的面板会话）→ 重新定向
    const anchorKey = this.anchor?.transcriptPath ?? '';
    if (this.mode === 'jsonl' && anchorKey && anchorKey !== this.lastAnchorKey) {
      this.log(`锚点更新 → jsonl 重新定向: ${anchorKey}`);
      this.lastAnchorKey = anchorKey;
      this.jsonl.start(anchorKey);
    }
    if (this.bridgeData?.sessionId) this.trackSession(this.bridgeData.sessionId);
  }

  /** 单活跃会话监控：60s 内桥接文件出现 ≥3 个不同 sessionId → 提示多会话并发 */
  private trackSession(id: string): void {
    const now = Date.now();
    this.recentSessions.push({ id, t: now });
    this.recentSessions = this.recentSessions.filter((s) => now - s.t < 60_000);
    this.sessionChurn = new Set(this.recentSessions.map((s) => s.id)).size >= 3;
  }

  private tick(): void {
    if (this.disposed) return;
    try {
      this.readFiles();
      this.evaluate();
      if (this.mode === 'jsonl') this.jsonl.poll();
      // 今日合计每 tick（1s）刷新：stat 全部文件 + 只重解析变化的文件（增量缓存），数字实时累加
      this.dailyRefresh();
      this.emit();
    } catch (e) {
      this.log(`tick 异常: ${String(e)}`);
    }
  }

  private emit(): void {
    let data = this.bridgeData;
    // 用户自定义标题优先（titles.json），无自定义则用 transcript 自动提取值
    if (data && data.sessionId && this.titleStore) {
      const custom = this.titleStore.get(data.sessionId);
      if (custom) data = { ...data, sessionTitle: custom };
    }
    this.onState({
      data,
      warning: this.warningData,
      mode: this.mode,
      stale: this.stale,
      sessionChurn: this.sessionChurn,
      todayYuan: this.daily.total,
      sessions: this.daily.listToday().map((s) => ({
        ...s,
        title: this.titleStore?.get(s.sessionId) ?? s.sessionId.slice(0, 8),
      })),
      pinnedPath: this.jsonl.pinnedPath,
      balance: this.balanceChecker?.result ?? null,
    });
  }

  dispose(): void {
    this.disposed = true;
    if (this.ticker) clearInterval(this.ticker);
    this.files.dispose();
    this.jsonl.dispose();
    this.balanceChecker?.dispose();
  }
}

/** 运行时目录（供 extension.ts 引用，避免魔法路径散落） */
export function runDirPath(): string {
  return path.join(require('./homedir').homeDir(), '.claude', 'cc-ds-monitor');
}
