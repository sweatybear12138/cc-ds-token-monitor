/**
 * bridge-write.cjs — statusline 数据泵（bridge.json 唯一写入方）。
 * 用法: node bridge-write.cjs [bridgePath]
 *   默认 bridgePath = ~/.claude/cc-ds-monitor/bridge.json（测试时可传临时路径）
 * stdin: Claude Code statusLine JSON 一行
 * stdout: 一行紧凑状态文本（终端 statusline 用）
 * 红线: DeepSeek 命中率 = cacheRead/(cacheRead+input)；cache_creation 恒 0 不参与；
 *       cache_creation>0 时写 lastError 提示，绝不静默忽略；
 *       所有写为同目录 temp+rename 原子写；任何异常 exit 0。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const bridgePath = process.argv[2] || path.join(os.homedir(), '.claude', 'cc-ds-monitor', 'bridge.json');
const runDir = path.dirname(bridgePath);
const pricingPath = path.join(path.dirname(process.argv[1]), 'pricing.json');

/* ---------- 面板锚点：空 stdin 时定位"刚启动的会话" ---------- */
function findNewestTranscript() {
  const projDir = path.join(os.homedir(), '.claude', 'projects');
  try {
    let best = null;
    let bestM = 0;
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
    return best;
  } catch {
    return null;
  }
}

/* ---------- 工具 ---------- */
function safeRead(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}
function atomicWrite(p, obj) {
  const tmp = p + '.tmp';
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}
/** DEBUG_DS=1 时把 stdin 原样落盘，供实机字段核实（外部评审建议） */
function debugDump(kind, raw) {
  if (process.env.DEBUG_DS !== '1') return;
  try {
    const dir = path.join(runDir, 'debug');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${kind}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), raw);
  } catch {
    /* 调试落盘失败不影响主流程 */
  }
}

/* ---------- 价格逻辑（与 src/pricing.ts 保持一致） ---------- */
const DEFAULT_PRICING = {
  peakHours: [
    { start: 9, end: 12 },
    { start: 14, end: 18 },
  ],
  models: {
    'deepseek-v4-pro': { hitOff: 0.15, hitPeak: 0.3, missOff: 4.5, missPeak: 9.0, outOff: 13.5, outPeak: 27.0 },
    'deepseek-v4-flash': { hitOff: 0.05, hitPeak: 0.1, missOff: 1.5, missPeak: 3.0, outOff: 4.5, outPeak: 9.0 },
  },
};
function loadPricing() {
  try {
    const cfg = JSON.parse(fs.readFileSync(pricingPath, 'utf8'));
    return {
      source: 'config',
      peakHours: Array.isArray(cfg.peakHours) && cfg.peakHours.length > 0 ? cfg.peakHours : DEFAULT_PRICING.peakHours,
      models: { ...DEFAULT_PRICING.models, ...(cfg.models || {}) },
    };
  } catch {
    return { source: 'default', peakHours: DEFAULT_PRICING.peakHours, models: { ...DEFAULT_PRICING.models } };
  }
}
const PRICING = loadPricing();
function modelKey(id) {
  return String(id || '').replace(/\[(1m|256k|128k|64k|32k)\]/i, '').trim().toLowerCase();
}
function beijingHour(now) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now || new Date());
  const h = parts.find((p) => p.type === 'hour')?.value || '0';
  return Number(h);
}
function isPeak(now) {
  const h = beijingHour(now);
  return PRICING.peakHours.some((r) => h >= r.start && h < r.end);
}
function turnCostYuan(price, usage, peak) {
  const miss = usage.input || 0;
  const hit = usage.cacheRead || 0;
  const out = usage.output || 0;
  return (
    (miss * (peak ? price.missPeak : price.missOff) +
      hit * (peak ? price.hitPeak : price.hitOff) +
      out * (peak ? price.outPeak : price.outOff)) /
    1e6
  );
}
function fmtYuan(v) {
  return v == null ? '—' : '¥' + v.toFixed(3);
}
function fmtPct(v, digits) {
  return v == null ? '—' : (v * 100).toFixed(digits || 1) + '%';
}

/* ---------- 主流程 ---------- */
let rawIn = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (rawIn += c));
process.stdin.on('end', () => {
  debugDump('statusline-stdin', rawIn);
  // 空 stdin：VSCode 面板在会话启动时调一次 statusline 但不给数据（本机实证 2026-08-19）。
  // 把"最新 transcript"写成会话锚点（panel-anchor），供扩展兜底模式盯住正在使用的面板会话；
  // 绝不写 error 文件（那会让扩展误报"数据异常"）。
  if (!rawIn || rawIn.trim() === '') {
    const newest = findNewestTranscript();
    const nowIso = new Date().toISOString();
    atomicWrite(bridgePath, {
      schemaVersion: 1,
      source: 'panel-anchor',
      updatedAt: nowIso,
      sessionId: newest ? path.basename(newest).replace(/\.jsonl$/, '') : null,
      transcriptPath: newest,
      cwd: null,
      model: { id: null, pricingKnown: false, pricingSource: PRICING.source },
      context: { windowSize: null, usedPct: null, remainingPct: null, totalInputTokens: null, totalOutputTokens: null, current: null },
      stats: { cacheHitRate: null, costSessionUsd: null, costTurnYuan: null, costSessionYuan: null, tokensInTurn: null, isPeakTime: null },
      lastError: null,
    });
    process.exit(0);
  }
  let s = null;
  try {
    s = JSON.parse(rawIn);
  } catch (e) {
    // stdin 解析失败 → 写错误状态，绝不中断会话
    atomicWrite(bridgePath, {
      schemaVersion: 1,
      source: 'error',
      updatedAt: new Date().toISOString(),
      sessionId: null,
      transcriptPath: null,
      cwd: null,
      model: { id: null, pricingKnown: false, pricingSource: null },
      context: { windowSize: null, usedPct: null, remainingPct: null, totalInputTokens: null, totalOutputTokens: null, current: null },
      stats: { cacheHitRate: null, costSessionUsd: null, costTurnYuan: null, tokensInTurn: null, isPeakTime: null },
      lastError: 'statusline stdin 解析失败: ' + String(e && e.message),
    });
    console.log('cc-ds 数据异常');
    process.exit(0);
  }

  const cw = (s && s.context_window) || {};
  const cu = cw.current_usage || null; // 首次调用前 / compact 后为 null → 只渲染累计值
  const modelId = (s && s.model && (s.model.id || s.model.display_name)) || null;
  const key = modelKey(modelId);
  const price = PRICING.models[key] || null;
  const peak = isPeak();
  const nowIso = new Date().toISOString();

  let lastError = null;
  // cache_creation > 0：与 DeepSeek 现状（恒 0）不符 → 必须提示价格模型需复核，不静默忽略
  if (cu && (cu.cache_creation_input_tokens || 0) > 0) {
    lastError = '检测到 cache_creation_input_tokens > 0，价格模型需复核（当前计费公式未计入缓存写入）';
  }

  let hitRate = null;
  let turnIn = null;
  let costYuan = null;
  if (cu) {
    turnIn = (cu.cache_read_input_tokens || 0) + (cu.input_tokens || 0);
    hitRate = turnIn > 0 ? (cu.cache_read_input_tokens || 0) / turnIn : null; // DeepSeek 公式
    if (price) {
      costYuan = turnCostYuan(price, { input: cu.input_tokens, cacheRead: cu.cache_read_input_tokens, output: cu.output_tokens }, peak);
    }
  }

  const out = {
    schemaVersion: 1,
    source: 'statusline',
    updatedAt: nowIso,
    sessionId: (s && s.session_id) || null,
    transcriptPath: (s && s.transcript_path) || null,
    cwd: (s && s.cwd) || null,
    model: { id: modelId, pricingKnown: !!price, pricingSource: PRICING.source },
    context: {
      windowSize: cw.context_window_size ?? null,
      usedPct: cw.used_percentage ?? null,
      remainingPct: cw.remaining_percentage ?? null,
      totalInputTokens: cw.total_input_tokens ?? null,
      totalOutputTokens: cw.total_output_tokens ?? null,
      current: cu
        ? {
            inputTokens: cu.input_tokens ?? null,
            outputTokens: cu.output_tokens ?? null,
            cacheReadTokens: cu.cache_read_input_tokens ?? null,
            cacheCreationTokens: cu.cache_creation_input_tokens ?? null,
          }
        : null,
    },
    stats: {
      cacheHitRate: hitRate,
      costSessionUsd: (s && s.cost && s.cost.total_cost_usd) ?? null,
      costTurnYuan: costYuan,
      costSessionYuan: null,
      tokensInTurn: turnIn,
      isPeakTime: peak,
    },
    lastError,
  };
  atomicWrite(bridgePath, out);

  // stdout 第一行 = 终端状态栏（VSCode 面板不渲染也无害；扩展显示走桥接文件）
  const ctxTxt = cw.used_percentage != null ? Math.round(cw.used_percentage) + '%' : '—';
  const priceNote = price ? '' : ' 价格未确认';
  console.log(`💾 缓存 ${fmtPct(hitRate)} · ${fmtYuan(costYuan)} · 上下文 ${ctxTxt}${priceNote}`);
  process.exit(0);
});
