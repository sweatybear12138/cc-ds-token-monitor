import * as fs from 'fs';
import * as path from 'path';
import { homeDir } from './homedir';
import { costYuan, loadPricing } from './pricing';
import { extractUserText } from './usertext';

interface FileSum {
  size: number;
  mtimeMs: number;
  yuanToday: number;
  /** 最后一条用户消息的时间戳（"当前对话"定位信号） */
  lastUserMs: number;
  /** 第一条真人消息自动提取的标题（列表自动命名） */
  autoTitle: string | null;
}

export interface SessionTodayInfo {
  path: string;
  sessionId: string;
  yuanToday: number;
  lastActivityMs: number;
  lastUserMs: number;
  autoTitle: string | null;
}

/**
 * 今日（北京时间）全部会话合计费用。
 * 按 (path, size) 增量缓存：只有文件变大才重解析，其余直接复用缓存和。
 */
export class DailyTotals {
  private readonly cache = new Map<string, FileSum>();
  private readonly pricing = loadPricing(path.join(homeDir(), '.claude', 'cc-ds-monitor', 'pricing.json'));
  private lastTotal: number | null = null;

  constructor(
    private readonly projectsDir: string = path.join(homeDir(), '.claude', 'projects'),
    private readonly nowProvider: () => Date = () => new Date()
  ) {}

  /** 北京时间日期键 YYYY-MM-DD（判断消息是否属于"今天"） */
  private beijingDateKey(d: Date): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(d);
  }

  refresh(): number {
    const todayKey = this.beijingDateKey(this.nowProvider());
    let total = 0;
    const seen = new Set<string>();
    try {
      for (const entry of fs.readdirSync(this.projectsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        for (const f of fs.readdirSync(path.join(this.projectsDir, entry.name))) {
          if (!f.endsWith('.jsonl')) continue;
          const p = path.join(this.projectsDir, entry.name, f);
          seen.add(p);
          let size = 0;
          let mtimeMs = 0;
          try {
            const st = fs.statSync(p);
            size = st.size;
            mtimeMs = st.mtimeMs;
          } catch {
            continue;
          }
          const prev = this.cache.get(p);
          if (prev && prev.size === size) {
            total += prev.yuanToday;
            continue;
          }
          const parsed = this.parseFile(p, todayKey);
          this.cache.set(p, {
            size,
            mtimeMs,
            yuanToday: parsed.yuanToday,
            lastUserMs: parsed.lastUserMs,
            autoTitle: parsed.autoTitle,
          });
          total += parsed.yuanToday;
        }
      }
    } catch {
      /* 目录不可读 → 保持缓存和 */
    }
    for (const p of [...this.cache.keys()]) {
      if (!seen.has(p)) this.cache.delete(p);
    }
    this.lastTotal = total;
    return total;
  }

  get total(): number | null {
    return this.lastTotal;
  }

  /** 今日会话清单（按最后活动倒序），供仪表盘"今日会话"列表用 */
  listToday(): SessionTodayInfo[] {
    const out: SessionTodayInfo[] = [];
    for (const [p, v] of this.cache) {
      out.push({
        path: p,
        sessionId: path.basename(p).replace(/\.jsonl$/, ''),
        yuanToday: v.yuanToday,
        lastActivityMs: v.mtimeMs,
        lastUserMs: v.lastUserMs,
        autoTitle: v.autoTitle,
      });
    }
    out.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
    return out;
  }

  /** "当前对话"：最后一条用户消息最新的会话（无界面 API 时的最佳代理信号） */
  currentConversationPath(): string | null {
    let best: string | null = null;
    let bestMs = 0;
    for (const [p, v] of this.cache) {
      if (v.lastUserMs > bestMs) {
        bestMs = v.lastUserMs;
        best = p;
      }
    }
    return best;
  }

  /** 单文件解析：今日费用和 + 最后一条用户消息时间戳 + 自动标题 */
  private parseFile(p: string, todayKey: string): { yuanToday: number; lastUserMs: number; autoTitle: string | null } {
    let sum = 0;
    let lastUserMs = 0;
    let autoTitle: string | null = null;
    try {
      const raw = fs.readFileSync(p, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        let rec: {
          type?: string;
          message?: { usage?: Record<string, number>; model?: string; content?: unknown };
          model?: string;
          timestamp?: string;
        };
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        if (!rec?.timestamp) continue;
        const ts = new Date(rec.timestamp);
        if (Number.isNaN(ts.getTime())) continue;
        if (rec.type === 'user') {
          if (ts.getTime() > lastUserMs) lastUserMs = ts.getTime();
          if (!autoTitle && rec.message?.content != null) {
            const text = extractUserText(rec.message.content);
            if (text) autoTitle = text.slice(0, 60);
          }
          continue;
        }
        if (rec.type !== 'assistant' || !rec.message?.usage) continue;
        if (this.beijingDateKey(ts) !== todayKey) continue;
        const u = rec.message.usage;
        const cost = costYuan(
          this.pricing,
          rec.message?.model ?? rec.model ?? null,
          { input: u.input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, output: u.output_tokens || 0 },
          ts
        );
        if (cost.yuan != null) sum += cost.yuan;
      }
    } catch {
      /* 读取失败 → 0 */
    }
    return { yuanToday: sum, lastUserMs, autoTitle };
  }
}
