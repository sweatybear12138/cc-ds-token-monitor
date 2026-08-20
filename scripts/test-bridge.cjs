/**
 * test-bridge.cjs — 运行时脚本手工测试（桥接文件双文件隔离 + 原子写 + 边界行为）。
 * 直接 spawn node 执行脚本、喂假 stdin，全部在临时目录进行，不碰真实 ~/.claude。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const SRC = __dirname;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ds-test-'));
const bridgePath = path.join(TMP, 'bridge.json');
const warningPath = path.join(TMP, 'warning.json');

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
function assertClose(name, actual, expected, tol) {
  const cond = Math.abs(actual - expected) <= (tol ?? 1e-6);
  if (cond) {
    pass++;
    console.log(`  ✓ ${name} (${actual})`);
  } else {
    fail++;
    console.error(`  ✗ ${name}: 期望 ${expected}，实际 ${actual}`);
  }
}

const SAMPLE_STDIN = JSON.stringify({
  session_id: 'e5fb9f9b-bb32-49f7-8fa9-0186dd3b4221',
  transcript_path: 'C:\\Users\\example\\.claude\\projects\\C--Users-example\\e5fb9f9b-bb32-49f7-8fa9-0186dd3b4221.jsonl',
  cwd: 'C:\\Users\\example',
  model: { id: 'deepseek-v4-pro[1m]', display_name: 'deepseek-v4-pro[1m]' },
  cost: { total_cost_usd: 0.055 },
  context_window: {
    used_percentage: 62.3,
    remaining_percentage: 37.7,
    context_window_size: 1048576,
    total_input_tokens: 652000,
    total_output_tokens: 12000,
    current_usage: { input_tokens: 1692, output_tokens: 762, cache_creation_input_tokens: 0, cache_read_input_tokens: 360192 },
  },
});

function runBridge(stdinObj) {
  const r = spawnSync(process.execPath, [path.join(SRC, 'bridge-write.cjs'), bridgePath], {
    input: JSON.stringify(stdinObj),
    encoding: 'utf8',
  });
  return r;
}
function runHook(stdinObj) {
  return spawnSync(process.execPath, [path.join(SRC, 'hook-precompact.cjs'), warningPath], {
    input: JSON.stringify(stdinObj),
    encoding: 'utf8',
  });
}

console.log('== 1. statusline → bridge.json ==');
let r = runBridge(JSON.parse(SAMPLE_STDIN));
ok('exit 0', r.status === 0);
ok('无 tmp 残留（原子写）', !fs.existsSync(bridgePath + '.tmp'));
const bridge = JSON.parse(fs.readFileSync(bridgePath, 'utf8'));
assertClose('命中率 0.995324', bridge.stats.cacheHitRate, 360192 / 361884);
const isPeak = bridge.stats.isPeakTime;
const expectCost = isPeak ? 0.1438596 : 0.0719298;
assertClose('费用与峰谷标志一致', bridge.stats.costTurnYuan, expectCost);
ok('model.id 保留 [1m]', bridge.model.id === 'deepseek-v4-pro[1m]');
ok('pricingKnown=true', bridge.model.pricingKnown === true);
ok('pricingSource 非空', bridge.model.pricingSource === 'default' || bridge.model.pricingSource === 'config');
ok('current 四类 token 齐全', bridge.context.current.inputTokens === 1692 && bridge.context.current.cacheReadTokens === 360192);
ok('usedPct 透传', bridge.context.usedPct === 62.3);
ok('stdout 含状态文本', /缓存/.test(r.stdout));

console.log('== 2. current_usage=null（首次调用前 / compact 后）==');
r = runBridge({ ...JSON.parse(SAMPLE_STDIN), context_window: { used_percentage: 5, context_window_size: 1048576, current_usage: null } });
const b2 = JSON.parse(fs.readFileSync(bridgePath, 'utf8'));
ok('current=null 不崩溃', b2.context.current === null);
ok('命中率为 null', b2.stats.cacheHitRate === null);
ok('费用为 null', b2.stats.costTurnYuan === null);
ok('exit 0', r.status === 0);

console.log('== 3. cache_creation>0 → lastError 提示（不静默）==');
r = runBridge({
  ...JSON.parse(SAMPLE_STDIN),
  context_window: { current_usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 50, cache_read_input_tokens: 100 } },
});
const b3 = JSON.parse(fs.readFileSync(bridgePath, 'utf8'));
ok('lastError 含价格模型复核提示', /cache_creation|复核/.test(b3.lastError || ''));
ok('exit 0（提示但不中断）', r.status === 0);

console.log('== 4. 坏 stdin → source:error ==');
r = spawnSync(process.execPath, [path.join(SRC, 'bridge-write.cjs'), bridgePath], { input: 'not-json{{{', encoding: 'utf8' });
const b4 = JSON.parse(fs.readFileSync(bridgePath, 'utf8'));
ok('source=error', b4.source === 'error');
ok('lastError 非空', !!b4.lastError);
ok('exit 0', r.status === 0);

console.log('== 4b. 空 stdin（面板启动锚定）→ 写 panel-anchor 而非 error ==');
fs.rmSync(bridgePath, { force: true });
r = spawnSync(process.execPath, [path.join(SRC, 'bridge-write.cjs'), bridgePath], { input: '', encoding: 'utf8' });
ok('exit 0', r.status === 0);
const b5 = JSON.parse(fs.readFileSync(bridgePath, 'utf8'));
ok('source=panel-anchor', b5.source === 'panel-anchor');
ok('transcriptPath 指向最新 transcript', !!b5.transcriptPath && b5.transcriptPath.endsWith('.jsonl'));
ok('sessionId 从文件名提取', !!b5.sessionId && /^[0-9a-f-]{36}$/.test(b5.sessionId));
ok('stats 全 null（锚点不是数据源）', b5.stats.cacheHitRate === null && b5.context.usedPct === null);
r = runBridge(JSON.parse(SAMPLE_STDIN)); // 恢复后续测试所需状态

console.log('== 5. 双文件隔离：hook 只写 warning.json，不碰 bridge.json ==');
r = runBridge(JSON.parse(SAMPLE_STDIN)); // 恢复 bridge.json 正常状态
const bridgeBefore = fs.readFileSync(bridgePath, 'utf8');
r = runHook({ trigger: 'auto', session_id: 'abc-123', transcript_path: 'x.jsonl', hook_event_name: 'PreCompact' });
ok('hook exit 0', r.status === 0);
const warning = JSON.parse(fs.readFileSync(warningPath, 'utf8'));
ok('auto → active=true', warning.active === true && warning.trigger === 'auto');
ok('warning 有 sessionId', warning.sessionId === 'abc-123');
ok('bridge.json 字节不变（单写者隔离）', fs.readFileSync(bridgePath, 'utf8') === bridgeBefore);
r = runHook({ trigger: 'manual', session_id: 'abc-123', hook_event_name: 'PreCompact' });
const warning2 = JSON.parse(fs.readFileSync(warningPath, 'utf8'));
ok('manual → active=false（解除预警）', warning2.active === false && warning2.trigger === 'manual');
ok('bridge.json 仍字节不变', fs.readFileSync(bridgePath, 'utf8') === bridgeBefore);

console.log('== 6. 模型未知 → pricingKnown:false ==');
r = runBridge({ ...JSON.parse(SAMPLE_STDIN), model: { id: 'future-model-x' } });
const b6 = JSON.parse(fs.readFileSync(bridgePath, 'utf8'));
ok('pricingKnown=false', b6.model.pricingKnown === false);
ok('费用 null 不猜价', b6.stats.costTurnYuan === null);

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
