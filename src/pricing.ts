/**
 * DeepSeek 价格与峰谷时段计算（纯函数模块，可在 node 下直接测试）
 * 红线：价格/时段走 pricing.json 配置；未知模型显式 pricingKnown:false，绝不静默猜价；
 *       缓存命中率用 DeepSeek 公式 cacheRead/(cacheRead+input)，绝不用 Anthropic 公式。
 */
import * as fs from 'fs';

export interface ModelPrice {
  hitOff: number;
  hitPeak: number;
  missOff: number;
  missPeak: number;
  outOff: number;
  outPeak: number;
}

export interface PricingConfig {
  source: 'default' | 'config';
  /** 北京时间高峰小时区间 [start, end)，其余为谷时 */
  peakHours: Array<{ start: number; end: number }>;
  models: Record<string, ModelPrice>;
}

/** 内置默认价格表（DeepSeek 官方 2026-08，¥/1M tokens；随 pricing.json 可覆盖） */
export const DEFAULT_PRICING: PricingConfig = {
  source: 'default',
  peakHours: [
    { start: 9, end: 12 },
    { start: 14, end: 18 },
  ],
  models: {
    'deepseek-v4-pro': { hitOff: 0.15, hitPeak: 0.3, missOff: 4.5, missPeak: 9.0, outOff: 13.5, outPeak: 27.0 },
    'deepseek-v4-flash': { hitOff: 0.05, hitPeak: 0.1, missOff: 1.5, missPeak: 3.0, outOff: 4.5, outPeak: 9.0 },
  },
};

/** 读取 pricing.json；缺失/损坏 → 内置默认（并保持 source:'default' 供 UI 标注） */
export function loadPricing(pricingPath: string): PricingConfig {
  try {
    const raw = fs.readFileSync(pricingPath, 'utf8');
    const cfg = JSON.parse(raw) as Partial<PricingConfig>;
    const models: Record<string, ModelPrice> = { ...DEFAULT_PRICING.models, ...(cfg.models ?? {}) };
    const peakHours = Array.isArray(cfg.peakHours) && cfg.peakHours.length > 0 ? cfg.peakHours : DEFAULT_PRICING.peakHours;
    return { source: 'config', peakHours, models };
  } catch {
    return { ...DEFAULT_PRICING, models: { ...DEFAULT_PRICING.models } };
  }
}

/** 剥掉模型名的上下文后缀 [1m]/[256k]/[128k]/[64k]/[32k] 再查表（JSONL 里无后缀，env 里有） */
export function modelKey(id: string | undefined | null): string {
  return String(id ?? '')
    .replace(/\[(1m|256k|128k|64k|32k)\]/i, '')
    .trim()
    .toLowerCase();
}

export function lookupPrice(
  cfg: PricingConfig,
  modelId: string | undefined | null
): { price: ModelPrice | null; known: boolean; key: string } {
  const key = modelKey(modelId);
  const price = cfg.models[key];
  return price ? { price, known: true, key } : { price: null, known: false, key };
}

/** 北京时间当前小时（Intl Asia/Shanghai，与系统/Git Bash 时区无关） */
export function beijingHour(now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const h = parts.find((p) => p.type === 'hour')?.value ?? '0';
  return Number(h);
}

export function isPeakTime(cfg: PricingConfig, now: Date = new Date()): boolean {
  const h = beijingHour(now);
  return cfg.peakHours.some((r) => h >= r.start && h < r.end);
}

/**
 * DeepSeek 计费：miss = input_tokens，hit = cache_read_input_tokens。
 * cache_creation 恒为 0 不参与计费（本机 JSONL 实证）。
 */
export function costYuan(
  cfg: PricingConfig,
  modelId: string | undefined | null,
  usage: { input: number; cacheRead: number; output: number },
  now: Date = new Date()
): { yuan: number | null; known: boolean; peak: boolean } {
  const { price, known } = lookupPrice(cfg, modelId);
  const peak = isPeakTime(cfg, now);
  if (!price) return { yuan: null, known: false, peak };
  const miss = usage.input || 0;
  const hit = usage.cacheRead || 0;
  const out = usage.output || 0;
  const yuan =
    (miss * (peak ? price.missPeak : price.missOff) +
      hit * (peak ? price.hitPeak : price.hitOff) +
      out * (peak ? price.outPeak : price.outOff)) /
    1e6;
  return { yuan, known, peak };
}

/** DeepSeek 缓存命中率：cacheRead / (cacheRead + input)。总输入为 0 → null */
export function cacheHitRate(input: number, cacheRead: number): number | null {
  const total = (input || 0) + (cacheRead || 0);
  return total > 0 ? (cacheRead || 0) / total : null;
}
