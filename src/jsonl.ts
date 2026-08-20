import * as fs from 'fs';
import * as path from 'path';
import { BridgeData } from './types';
import { homeDir } from './homedir';
import { cacheHitRate, costYuan, loadPricing, lookupPrice } from './pricing';

interface MsgUsage {
  input: number;
  cacheRead: number;
  cacheCreation: number;
  output: number;
  /** 消息时间戳（逐消息峰谷计价用） */
  ts: string | null;
}

/**
 * JSONL 兜底数据源：当 statusline 桥接缺失/陈旧时，解析会话 transcript 提供数据。
 * 优先级：bridge.transcriptPath 提示路径 → mtime 最新 JSONL（兜底模式专用，多会话跳动已文档化）。
 * 缓存策略：按 (path, size) 只在文件变大时重解析全量。
 */
export class JsonlFallback {
  private transcriptPath: string | null = null;
  private lastSize = -1;
  private lastEmitKey = '';
  private readonly pricing = loadPricing(path.join(homeDir(), '.claude', 'cc-ds-monitor', 'pricing.json'));
  private totals = { input: 0, cacheRead: 0, cacheCreation: 0, output: 0 };
  private costTotalYuan = 0;
  private lastUsage: MsgUsage | null = null;
  private modelId: string | null = null;
  private sessionId: string | null = null;
  private cwd: string | null = null;
  private sessionTitle: string | null = null;
  private stopped = true;
  private pinned: string | null = null;

  constructor(
    private readonly onUpdate: (data: BridgeData) => void,
    private readonly projectsDir: string = path.join(homeDir(), '.claude', 'projects')
  ) {}

  start(hintPath: string | null): void {
    this.stopped = false;
    // 粘性优先（旧文件 60s 内更新 → 继续盯），其次接受锚点提示（面板会话/陈旧桥接，5 分钟内有效）
    let chosen: string | null = this.stickyOrScan();
    if (hintPath) {
      try {
        if (fs.existsSync(hintPath) && Date.now() - fs.statSync(hintPath).mtimeMs < 5 * 60_000) chosen = hintPath;
      } catch {
        /* 忽略 */
      }
    }
    this.transcriptPath = chosen;
    this.lastSize = -1; // 强制首轮解析
    this.lastEmitKey = '';
  }

  /** 手动刷新：丢弃当前选择，下次 poll 重选最新活跃者并重解析 */
  forceRefresh(): void {
    this.pinned = null;
    this.transcriptPath = null;
    this.lastSize = -1;
    this.lastEmitKey = '';
  }

  /** 用户钉选某会话：一直监控该会话直到解除（unpin 或文件消失） */
  pin(p: string | null): void {
    this.pinned = p;
    this.transcriptPath = p;
    this.lastSize = -1;
    this.lastEmitKey = '';
  }

  get pinnedPath(): string | null {
    return this.pinned;
  }

  stop(): void {
    this.stopped = true;
  }

  get active(): boolean {
    return !this.stopped;
  }

  /** Monitor 每个 tick 调用；仅新数据才触发 onUpdate */
  poll(): void {
    if (this.stopped) return;
    const p = this.stickyOrScan();
    if (!p) return;
    if (p !== this.transcriptPath) {
      this.transcriptPath = p;
      this.lastSize = -1;
    }
    let size: number;
    try {
      size = fs.statSync(p).size;
    } catch {
      return;
    }
    if (size !== this.lastSize) {
      this.parse(p);
      this.lastSize = size;
    }
    const key = `${p}:${this.lastSize}`;
    if (key !== this.lastEmitKey) {
      this.lastEmitKey = key;
      this.emit();
    }
  }

  /**
   * 粘性选择：已选定文件 60s 内有更新就继续盯它，避免多会话并发时在文件间跳来跳去
   * （跳变会导致数字冻结的假象）；当前文件陈旧/消失后才切到最新活跃者。
   */
  /**
   * 活跃会话跟随（防抖）：
   * - 刚选定的文件 10s 内不被抢走（切换后保护期，防两会话同时聊天时抖动）
   * - 另一个文件比当前更新超过 5s 且当前已安静 10s+ → 跟随（用户切换会话后 ~2s 内跟上）
   * - 当前文件 60s 内更新过 → 继续盯；否则重选最新活跃者
   */
  private stickyOrScan(): string | null {
    if (this.pinned) {
      try {
        if (fs.existsSync(this.pinned)) return this.pinned;
      } catch {
        /* 文件消失 → 解除钉选 */
      }
      this.pinned = null;
    }
    const best = this.scanNewest();
    if (this.transcriptPath) {
      try {
        const curM = fs.statSync(this.transcriptPath).mtimeMs;
        const age = Date.now() - curM;
        if (best && best !== this.transcriptPath) {
          const bestM = fs.statSync(best).mtimeMs;
          // 按用户要求：及时响应优先，防抖窗口 1s（margin + 保护期都 1s）
          if (bestM - curM > 1000 && age > 1000) return best;
        }
        if (age < 60_000) return this.transcriptPath;
      } catch {
        /* 文件消失 → 重选 */
      }
    }
    return best;
  }

  private scanNewest(): string | null {
    const projDir = this.projectsDir;
    let best: string | null = null;
    let bestM = 0;
    try {
      for (const entry of fs.readdirSync(projDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        for (const f of fs.readdirSync(path.join(projDir, entry.name))) {
          if (!f.endsWith('.jsonl')) continue;
          const p = path.join(projDir, entry.name, f);
          try {
            const m = fs.statSync(p).mtimeMs;
            if (m > bestM) {
              bestM = m;
              best = p;
            }
          } catch {
            /* 跳过 */
          }
        }
      }
    } catch {
      /* 目录不可读 → null */
    }
    return best;
  }

  /** 全量解析：累计会话 token/费用（逐消息按时间戳判定峰谷）+ 最近一次 usage */
  private parse(p: string): void {
    try {
      const raw = fs.readFileSync(p, 'utf8');
      this.totals = { input: 0, cacheRead: 0, cacheCreation: 0, output: 0 };
      this.costTotalYuan = 0;
      this.lastUsage = null;
      this.modelId = null;
      this.sessionId = null;
      this.cwd = null;
      this.sessionTitle = null;
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        let rec: {
          type?: string;
          message?: { usage?: Record<string, number>; model?: string; content?: unknown };
          model?: string;
          timestamp?: string;
          sessionId?: string;
          cwd?: string;
        };
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        // 标题：第一条"真人"用户消息（跳过系统通知/XML 内容）
        if (!this.sessionTitle && rec?.type === 'user' && rec.message?.content != null) {
          const text = this.extractUserText(rec.message.content);
          if (text) this.sessionTitle = text.slice(0, 60);
        }
        if (rec?.type !== 'assistant' || !rec.message?.usage) continue;
        const u = rec.message.usage;
        const input = u.input_tokens || 0;
        const cacheRead = u.cache_read_input_tokens || 0;
        const cacheCreation = u.cache_creation_input_tokens || 0;
        const output = u.output_tokens || 0;
        this.totals.input += input;
        this.totals.cacheRead += cacheRead;
        this.totals.cacheCreation += cacheCreation;
        this.totals.output += output;
        // 本机实证（CC 2.1.x JSONL）：model 在 message.model，顶层无 model；sessionId/cwd 在顶层
        const model = rec.message?.model ?? rec.model ?? null;
        if (!this.modelId && model) this.modelId = model;
        if (!this.sessionId && rec.sessionId) this.sessionId = rec.sessionId;
        if (!this.cwd && rec.cwd) this.cwd = rec.cwd;
        const ts = rec.timestamp ?? null;
        const cost = costYuan(this.pricing, model, { input, cacheRead, output }, ts ? new Date(ts) : new Date());
        if (cost.yuan != null) this.costTotalYuan += cost.yuan;
        this.lastUsage = { input, cacheRead, cacheCreation, output, ts };
      }
    } catch {
      /* 读取失败 → 保持上次数据 */
    }
  }

  /** 从用户消息 content 提取纯文本（string 或 [{type:'text',text}] 数组；跳过系统 XML/Caveat） */
  private extractUserText(content: unknown): string | null {
    if (typeof content === 'string') {
      const t = content.trim();
      if (!t || t.startsWith('<') || t.startsWith('Caveat:')) return null;
      return t;
    }
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content) {
        if (
          block &&
          typeof block === 'object' &&
          (block as { type?: string }).type === 'text' &&
          typeof (block as { text?: string }).text === 'string'
        ) {
          parts.push((block as { text: string }).text.trim());
        }
      }
      const t = parts.join(' ').trim();
      if (!t || t.startsWith('<') || t.startsWith('Caveat:')) return null;
      return t;
    }
    return null;
  }

  private emit(): void {
    const cur = this.lastUsage;
    const { known } = lookupPrice(this.pricing, this.modelId);
    const lastCost = cur
      ? costYuan(this.pricing, this.modelId, { input: cur.input, cacheRead: cur.cacheRead, output: cur.output }, cur.ts ? new Date(cur.ts) : new Date())
      : { yuan: null, known, peak: false };
    const data: BridgeData = {
      schemaVersion: 1,
      source: 'jsonl',
      updatedAt: new Date().toISOString(),
      sessionId: this.sessionId ?? (this.transcriptPath ? path.basename(this.transcriptPath).replace(/\.jsonl$/, '') : null),
      sessionTitle: this.sessionTitle,
      transcriptPath: this.transcriptPath,
      cwd: this.cwd,
      model: { id: this.modelId, pricingKnown: known, pricingSource: this.pricing.source },
      context: {
        windowSize: null, // JSONL 无窗口信息 → 不显示上下文%（红线：不硬编码任何窗口大小/压缩阈值）
        usedPct: null,
        remainingPct: null,
        totalInputTokens: this.totals.input + this.totals.cacheRead + this.totals.cacheCreation,
        totalOutputTokens: this.totals.output,
        current: cur
          ? { inputTokens: cur.input, outputTokens: cur.output, cacheReadTokens: cur.cacheRead, cacheCreationTokens: cur.cacheCreation }
          : null,
      },
      stats: {
        cacheHitRate: cur ? cacheHitRate(cur.input, cur.cacheRead) : null,
        costSessionUsd: null,
        costTurnYuan: lastCost.yuan,
        costSessionYuan: this.costTotalYuan,
        tokensInTurn: cur ? cur.input + cur.cacheRead : null,
        isPeakTime: lastCost.peak,
      },
      lastError: this.totals.cacheCreation > 0 ? 'transcript 中出现 cache_creation_input_tokens > 0，价格模型需复核' : null,
    };
    this.onUpdate(data);
  }

  dispose(): void {
    this.stop();
  }
}
