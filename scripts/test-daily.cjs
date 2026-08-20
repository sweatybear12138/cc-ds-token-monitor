/**
 * test-daily.cjs — 今日全部会话合计（北京时间日切 + 峰谷计价 + 增量缓存）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { DailyTotals } = require(path.join(__dirname, '..', 'dist', 'daily.js'));

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
function assertClose(name, actual, expected) {
  const c = Math.abs(actual - expected) < 1e-9;
  if (c) {
    pass++;
    console.log(`  ✓ ${name} (${actual})`);
  } else {
    fail++;
    console.error(`  ✗ ${name}: 期望 ${expected}，实际 ${actual}`);
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ds-daily-'));
const projA = path.join(TMP, 'proj-a');
fs.mkdirSync(projA, { recursive: true });

function line(model, usage, ts) {
  return JSON.stringify({ type: 'assistant', message: { model, usage }, timestamp: ts }) + '\n';
}
function userLine(text, ts) {
  return JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text }] }, timestamp: ts }) + '\n';
}

// 固定"现在"= 2026-08-20T04:00Z（北京 12:00，8月20日）
const NOW = new Date('2026-08-20T04:00:00.000Z');
const daily = new DailyTotals(TMP, () => NOW);

// 文件1：今天 2 条 + 昨天 1 条
const today1 = { input_tokens: 1000, cache_read_input_tokens: 100000, cache_creation_input_tokens: 0, output_tokens: 500 };
const today2 = { input_tokens: 2000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1000 };
const yest = { input_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 50 };
fs.writeFileSync(
  path.join(projA, 's1.jsonl'),
  line('deepseek-v4-pro', today1, '2026-08-20T02:00:00.000Z') + // 北京 10:00 峰
  line('deepseek-v4-flash', today2, '2026-08-20T03:00:00.000Z') + // 北京 11:00 峰
  line('deepseek-v4-pro', yest, '2026-08-19T12:00:00.000Z') // 北京 08-19 20:00 → 不算今天
);
// 文件2：今天 1 条（谷时）+ 最近一条用户消息（"当前对话"信号）
fs.writeFileSync(
  path.join(projA, 's2.jsonl'),
  line('deepseek-v4-pro', { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 }, '2026-08-20T00:00:00.000Z') + // 北京 08:00 谷
    userLine('刚才在 s2 里发的话', '2026-08-20T04:01:00.000Z')
);

console.log('== 今日合计（北京时间日切 + 峰谷计价 + 跨文件求和）==');
const expected =
  (1000 * 9.0 + 100000 * 0.3 + 500 * 27.0) / 1e6 + // v4-pro 峰
  (2000 * 3.0 + 0 + 1000 * 9.0) / 1e6 + // v4-flash 峰
  (100 * 4.5) / 1e6; // v4-pro 谷
const total = daily.refresh();
assertClose('首刷合计', total, expected);

console.log('== 增量缓存 ==');
daily.refresh();
assertClose('二次刷新一致（缓存命中）', daily.total, expected);

console.log('== 新消息增量 ==');
fs.appendFileSync(
  path.join(projA, 's1.jsonl'),
  line('deepseek-v4-pro', { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 }, '2026-08-20T04:30:00.000Z') // 北京 12:30 谷（峰=9-12/14-18）
);
const total2 = daily.refresh();
assertClose('追加后合计', total2, expected + (1000 * 4.5) / 1e6);

console.log('== 会话清单 ==');
const list = daily.listToday();
ok('清单含 2 个会话', list.length === 2);
ok('按最后活动倒序', list[0].lastActivityMs >= list[1].lastActivityMs);
ok('清单会话 ID 从文件名提取', list.every((s) => s.path.endsWith(s.sessionId + '.jsonl')));
assertClose('清单合计与 total 一致', list.reduce((a, s) => a + s.yuanToday, 0), daily.total);

console.log('== 会话列表自动标题（第一条真人消息）==');
ok('自动标题提取到 s2 的消息', list.some((s) => s.sessionId === 's2' && s.autoTitle === '刚才在 s2 里发的话'));
ok('无用户消息的 s1 自动标题为 null', list.some((s) => s.sessionId === 's1' && s.autoTitle === null));

console.log('== "当前对话"定位（最后用户消息最新者）==');
const currentPath = daily.currentConversationPath();
ok('定位到 s2（其用户消息最新）', currentPath === path.join(projA, 's2.jsonl'), 'got ' + currentPath);

console.log('== 日切（跨天后昨天的消息不再计入）==');
const NOW2 = new Date('2026-08-21T04:00:00.000Z');
const daily2 = new DailyTotals(TMP, () => NOW2);
assertClose('新的一天合计为 0', daily2.refresh(), 0);

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
