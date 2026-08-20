import { BalanceInfo } from './types';

/** 北京时间当日 0 点对应的 UTC 毫秒时间戳 */
export function beijingMidnight(now: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  // 北京午夜（UTC+8）= 该北京日期的 UTC 零点减去 8 小时
  return Date.UTC(get('year'), get('month') - 1, get('day')) - 8 * 3_600_000;
}

/**
 * 可用天数预估（纯函数，可测）：
 * 按今日消耗速率（今日费用 ÷ 今日已过小时数，最少按 0.5h 计）外推。
 * 余额或今日费用缺失 → null（不编造）。
 */
export function estimateDays(balanceYuan: number | null, costToday: number, now: Date): number | null {
  if (balanceYuan == null || balanceYuan <= 0 || costToday <= 0) return null;
  const hours = Math.max((now.getTime() - beijingMidnight(now)) / 3_600_000, 0.5);
  const perDay = (costToday / hours) * 24;
  if (perDay <= 0) return null;
  return balanceYuan / perDay;
}

/**
 * DeepSeek 账户余额查询（可选功能，开关关闭时不发任何网络请求）。
 * API: GET https://api.deepseek.com/user/balance（Authorization: Bearer <key>）
 * key 只从内存读取（~/.claude/settings.json 的 env），绝不落盘。
 */
export class BalanceChecker {
  private current: BalanceInfo | null = null;
  private timer: NodeJS.Timeout | null = null;
  private disposed = false;
  private costToday = 0;

  constructor(
    private readonly enabled: () => boolean,
    private readonly getKey: () => string | null,
    private readonly nowProvider: () => Date = () => new Date(),
    private readonly log?: (msg: string) => void
  ) {}

  /** 由 Monitor 在每次 daily.refresh 后喂入今日合计（用于可用天数预估） */
  setCostToday(v: number): void {
    this.costToday = v;
  }

  start(): void {
    void this.check();
    this.timer = setInterval(() => {
      if (this.disposed) return;
      void this.check();
    }, 5 * 60_000); // 5 分钟一查
  }

  get result(): BalanceInfo | null {
    return this.current;
  }

  async check(): Promise<void> {
    const nowIso = this.nowProvider().toISOString();
    if (!this.enabled()) {
      this.log?.('balance.check: 开关关闭，跳过');
      this.current = null;
      return;
    }
    const key = this.getKey();
    if (!key) {
      this.log?.('balance.check: 未找到 API key');
      this.current = { yuan: null, daysRemaining: null, error: '未找到 API key（读 ~/.claude/settings.json 的 env.ANTHROPIC_AUTH_TOKEN）', checkedAt: nowIso };
      return;
    }
    try {
      const res = await fetch('https://api.deepseek.com/user/balance', {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = (await res.json()) as { balance_infos?: Array<{ currency?: string; total_balance?: string | number }> };
      const info = j.balance_infos?.[0];
      const yuan = typeof info?.total_balance === 'number' ? info.total_balance : typeof info?.total_balance === 'string' ? parseFloat(info.total_balance) : null;
      this.current = {
        yuan,
        daysRemaining: estimateDays(yuan, this.costToday, this.nowProvider()),
        error: null,
        checkedAt: nowIso,
      };
      this.log?.(`balance.check: 成功 yuan=${yuan} days=${this.current.daysRemaining}`);
    } catch (e) {
      this.current = {
        yuan: this.current?.yuan ?? null,
        daysRemaining: null,
        error: String(e && (e as Error).message ? (e as Error).message : e),
        checkedAt: nowIso,
      };
      this.log?.('balance.check: 失败 ' + this.current.error);
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
  }
}
