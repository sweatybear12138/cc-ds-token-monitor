/**
 * test-monitor.cjs — SourceMode 状态机单元测试（脱离 VSCode，纯 node）。
 * 覆盖：无桥接→jsonl 兜底 / 桥接新鲜→bridge / 桥接陈旧→兜底 / 恢复→自动切回 /
 *       warning 透传 / 多会话 churn 检测 / jsonl 解析真实字段。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Monitor } = require(path.join(__dirname, '..', 'dist', 'monitor.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ds-monitor-test-'));
const runDir = path.join(TMP, 'cc-ds-monitor');
const projDir = path.join(TMP, 'projects');
fs.mkdirSync(runDir, { recursive: true });
fs.mkdirSync(path.join(projDir, 'test-project'), { recursive: true });

const bridgePath = path.join(runDir, 'bridge.json');
const warningPath = path.join(runDir, 'warning.json');

function makeBridge(sessionId, updatedAt, overrides) {
  return {
    schemaVersion: 1,
    source: 'statusline',
    updatedAt,
    sessionId,
    transcriptPath: path.join(projDir, 'test-project', 's.jsonl'),
    cwd: 'C:\\test',
    model: { id: 'deepseek-v4-pro[1m]', pricingKnown: true, pricingSource: 'default' },
    context: {
      windowSize: 1048576,
      usedPct: 62.3,
      remainingPct: 37.7,
      totalInputTokens: 652000,
      totalOutputTokens: 12000,
      current: { inputTokens: 1692, outputTokens: 762, cacheReadTokens: 360192, cacheCreationTokens: 0 },
    },
    stats: { cacheHitRate: 360192 / 361884, costSessionUsd: null, costTurnYuan: 0.0719, costSessionYuan: null, tokensInTurn: 361884, isPeakTime: false },
    lastError: null,
    ...overrides,
  };
}

// 兜底用假 transcript：1 条真人用户消息（标题来源）+ 3 条 assistant 消息
const ts1 = '2026-08-19T20:00:00.000Z';
const ts2 = '2026-08-19T20:01:00.000Z';
const transcriptLines = [
  JSON.stringify({ type: 'user', timestamp: '2026-08-19T19:59:00.000Z', message: { content: [{ type: 'text', text: '测试会话标题：开发deepseek监控插件' }] } }),
  JSON.stringify({ type: 'user', timestamp: '2026-08-19T19:59:01.000Z', message: { content: '<task-notification>系统通知应被跳过</task-notification>' } }),
  JSON.stringify({ type: 'assistant', model: 'deepseek-v4-pro', timestamp: ts1, message: { usage: { input_tokens: 1000, cache_read_input_tokens: 100000, cache_creation_input_tokens: 0, output_tokens: 500 } } }),
  JSON.stringify({ type: 'assistant', model: 'deepseek-v4-pro', timestamp: ts2, message: { usage: { input_tokens: 1692, cache_read_input_tokens: 360192, cache_creation_input_tokens: 0, output_tokens: 762 } } }),
];
const transcriptPath = path.join(projDir, 'test-project', 's.jsonl');
fs.writeFileSync(transcriptPath, transcriptLines.join('\n') + '\n');

let states = [];
function newMonitor(stalenessMs = 60000) {
  states = [];
  const m = new Monitor(runDir, 60000, stalenessMs, (s) => states.push(s), projDir);
  return m;
}

console.log('== 1. 无桥接 → jsonl 兜底（解析真实 transcript）==');
{
  const m = newMonitor();
  m.refreshNow();
  const s = states[states.length - 1];
  ok('mode=jsonl', s.mode === 'jsonl');
  ok('stale=true', s.stale === true);
  ok('数据来自 jsonl', s.data && s.data.source === 'jsonl');
  ok('累计费用按消息时间戳计价', s.data && Math.abs(s.data.stats.costSessionYuan - (1000 * 4.5 + 100000 * 0.15 + 500 * 13.5 + 1692 * 4.5 + 360192 * 0.15 + 762 * 13.5) / 1e6) < 1e-9);
  ok('命中率=最后一轮 DeepSeek 口径', s.data && Math.abs(s.data.stats.cacheHitRate - 360192 / 361884) < 1e-9);
  ok('jsonl 模式 usedPct=null（不硬编码窗口）', s.data && s.data.context.usedPct === null);
  ok('会话标题从第一条真人消息提取', s.data && s.data.sessionTitle === '测试会话标题：开发deepseek监控插件');
  // 回归测试：后续 tick 不得清空 jsonl 数据（曾导致状态栏 1 秒后闪回"未连接"）
  m.refreshNow();
  const s2 = states[states.length - 1];
  ok('再次 tick 后 jsonl 数据仍在（回归）', s2.data && s2.data.source === 'jsonl' && s2.data.stats.cacheHitRate != null);
  ok('todayYuan 已计算（数字）', typeof s2.todayYuan === 'number');
  m.dispose();
}

console.log('== 1b. 活跃跟随（防抖）：10s 保护期 + 5s margin，用户切换会话后跟上 ==');
{
  const pA = path.join(projDir, 'test-project', 'a.jsonl');
  const pB = path.join(projDir, 'test-project', 'b.jsonl');
  fs.writeFileSync(pA, transcriptLines.join('\n') + '\n');
  fs.writeFileSync(pB, transcriptLines.join('\n') + '\n');
  const t0 = Date.now();
  // 把第 1 节的 s.jsonl 做旧，排除干扰（所有 mtime 用真实过去时戳，不用未来时戳）
  fs.utimesSync(path.join(projDir, 'test-project', 's.jsonl'), (t0 - 300000) / 1000, (t0 - 300000) / 1000);
  const m = newMonitor();
  fs.utimesSync(pA, (t0 - 2000) / 1000, (t0 - 2000) / 1000);
  fs.utimesSync(pB, (t0 - 7000) / 1000, (t0 - 7000) / 1000);
  m.refreshNow(); // 选中 a（最新）
  let s = states[states.length - 1];
  ok('初始选中最新 a', s.data && s.data.transcriptPath === pA);
  fs.utimesSync(pB, (t0 - 1500) / 1000, (t0 - 1500) / 1000); // b 只新 a 0.5s < margin 1s
  m.refreshNow();
  s = states[states.length - 1];
  ok('margin 内不抖动（0.5s）', s.data && s.data.transcriptPath === pA);
  fs.utimesSync(pA, (t0 - 120000) / 1000, (t0 - 120000) / 1000); // a 已安静 120s
  fs.utimesSync(pB, (t0 - 20000) / 1000, (t0 - 20000) / 1000); // b 20s 前活动
  m.refreshNow();
  s = states[states.length - 1];
  ok('用户切走 → 跟随到 b', s.data && s.data.transcriptPath === pB);
  fs.utimesSync(pA, (t0 - 2000) / 1000, (t0 - 2000) / 1000); // 用户切回 a 并聊天
  m.refreshNow();
  s = states[states.length - 1];
  ok('切回 → 跟随到 a', s.data && s.data.transcriptPath === pA);
  m.dispose();
  fs.rmSync(pA, { force: true });
  fs.rmSync(pB, { force: true });
}

console.log('== 1c. 面板锚点（panel-anchor）初始定向 + 手动刷新 ==');
{
  const pA = path.join(projDir, 'test-project', 'anchor-target.jsonl');
  fs.writeFileSync(pA, transcriptLines.join('\n') + '\n');
  const t0 = Date.now();
  fs.utimesSync(pA, (t0 - 2000) / 1000, (t0 - 2000) / 1000);
  fs.writeFileSync(
    bridgePath,
    JSON.stringify({
      schemaVersion: 1,
      source: 'panel-anchor',
      updatedAt: new Date().toISOString(),
      sessionId: 'anchor-sess',
      transcriptPath: pA,
      cwd: null,
      model: { id: null, pricingKnown: false, pricingSource: null },
      context: {},
      stats: {},
      lastError: null,
    })
  );
  const m = newMonitor();
  m.refreshNow();
  let s = states[states.length - 1];
  ok('mode=jsonl（锚点不当数据源）', s.mode === 'jsonl');
  ok('初始定向到锚点会话', s.data && s.data.source === 'jsonl' && s.data.transcriptPath === pA);
  // 手动刷新：丢弃选择 → 重选最新活跃者（新写一个比锚点更新的 c.jsonl）
  const pC = path.join(projDir, 'test-project', 'c.jsonl');
  fs.writeFileSync(pC, transcriptLines.join('\n') + '\n');
  fs.utimesSync(pC, t0 / 1000, t0 / 1000);
  m.refreshNow(true);
  s = states[states.length - 1];
  ok('手动刷新后重选最新活跃者', s.data && s.data.transcriptPath === pC);
  m.dispose();
  fs.rmSync(pA, { force: true });
  fs.rmSync(pC, { force: true });
  fs.rmSync(bridgePath, { force: true });
}

console.log('== 1d. 用户钉选会话 → 无视跟随逻辑一直监控；解除 → 回到跟随 ==');
{
  const pA = path.join(projDir, 'test-project', 'pin-a.jsonl');
  const pB = path.join(projDir, 'test-project', 'pin-b.jsonl');
  fs.writeFileSync(pA, transcriptLines.join('\n') + '\n');
  fs.writeFileSync(pB, transcriptLines.join('\n') + '\n');
  const t0 = Date.now();
  fs.utimesSync(pA, (t0 - 120000) / 1000, (t0 - 120000) / 1000); // a 陈旧
  fs.utimesSync(pB, (t0 - 5000) / 1000, (t0 - 5000) / 1000); // b 较新
  const m = newMonitor();
  m.refreshNow();
  let s = states[states.length - 1];
  ok('初始跟随最新 b', s.data && s.data.transcriptPath === pB);
  m.pinTranscript(pA);
  s = states[states.length - 1];
  ok('钉选后切到 a（尽管 a 陈旧）', s.data && s.data.transcriptPath === pA);
  m.refreshNow();
  s = states[states.length - 1];
  ok('钉选后不被 b 抢走', s.data && s.data.transcriptPath === pA && s.pinnedPath === pA);
  m.pinTranscript(null);
  m.refreshNow();
  s = states[states.length - 1];
  ok('解除钉选后回到跟随最新', s.data && s.data.transcriptPath !== pA && s.pinnedPath === null);
  m.dispose();
  fs.rmSync(pA, { force: true });
  fs.rmSync(pB, { force: true });
}

console.log('== 2. 桥接新鲜 → bridge 模式 ==');
{
  const m = newMonitor();
  fs.writeFileSync(bridgePath, JSON.stringify(makeBridge('sess-a', new Date().toISOString())));
  m.refreshNow();
  const s = states[states.length - 1];
  ok('mode=bridge', s.mode === 'bridge');
  ok('stale=false', s.stale === false);
  ok('命中率透传', s.data && Math.abs(s.data.stats.cacheHitRate - 360192 / 361884) < 1e-9);
  m.dispose();
}

console.log('== 3. 桥接陈旧 → 切兜底，恢复 → 自动切回 ==');
{
  const m = newMonitor(1000); // staleness 1s
  fs.writeFileSync(bridgePath, JSON.stringify(makeBridge('sess-a', new Date(Date.now() - 60_000).toISOString())));
  m.refreshNow();
  let s = states[states.length - 1];
  ok('陈旧 → mode=jsonl', s.mode === 'jsonl');
  ok('陈旧 → stale=true', s.stale === true);
  ok('兜底数据 source=jsonl', s.data && s.data.source === 'jsonl');

  fs.writeFileSync(bridgePath, JSON.stringify(makeBridge('sess-a', new Date().toISOString())));
  m.refreshNow();
  s = states[states.length - 1];
  ok('恢复 → mode=bridge', s.mode === 'bridge');
  ok('恢复 → stale=false', s.stale === false);
  m.dispose();
}

console.log('== 4. warning.json 透传 ==');
{
  const m = newMonitor();
  fs.writeFileSync(bridgePath, JSON.stringify(makeBridge('sess-a', new Date().toISOString())));
  fs.writeFileSync(warningPath, JSON.stringify({ schemaVersion: 1, updatedAt: new Date().toISOString(), sessionId: 'sess-a', transcriptPath: null, active: true, trigger: 'auto', at: new Date().toISOString() }));
  m.refreshNow();
  const s = states[states.length - 1];
  ok('warning.active=true 透传', s.warning && s.warning.active === true && s.warning.trigger === 'auto');
  m.dispose();
}

console.log('== 5. 多会话 churn 检测（60s 内 ≥3 个 sessionId）==');
{
  const m = newMonitor();
  for (const id of ['sess-1', 'sess-2', 'sess-3']) {
    fs.writeFileSync(bridgePath, JSON.stringify(makeBridge(id, new Date().toISOString())));
    m.refreshNow();
  }
  const s = states[states.length - 1];
  ok('sessionChurn=true', s.sessionChurn === true);
  m.dispose();
}

console.log('== 6. 桥接 source=error → 数据异常透传 ==');
{
  const m = newMonitor();
  fs.writeFileSync(bridgePath, JSON.stringify(makeBridge('sess-a', new Date().toISOString(), { source: 'error', lastError: 'stdin 解析失败' })));
  m.refreshNow();
  const s = states[states.length - 1];
  ok('lastError 透传', s.data && s.data.lastError === 'stdin 解析失败');
  m.dispose();
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
