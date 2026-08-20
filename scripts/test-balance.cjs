/**
 * test-balance.cjs — 余额预估纯函数：北京午夜计算 + 可用天数外推。
 */
'use strict';
const path = require('path');
const { beijingMidnight, estimateDays } = require(path.join(__dirname, '..', 'dist', 'balance.js'));

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

console.log('== 北京午夜 ==');
// 北京 2026-08-20 00:00 = UTC 2026-08-19 16:00
assertClose('北京午夜(UTC 时刻)', beijingMidnight(new Date('2026-08-20T04:00:00.000Z')), Date.UTC(2026, 7, 19, 16));
assertClose('北京午夜(另一个日期)', beijingMidnight(new Date('2026-08-19T20:00:00.000Z')), Date.UTC(2026, 7, 19, 16));
// 北京 08-19 23:59 → 午夜应为 08-19 00:00 = UTC 08-18 16:00
assertClose('北京午夜(晚 23:59)', beijingMidnight(new Date('2026-08-19T15:59:00.000Z')), Date.UTC(2026, 7, 18, 16));

console.log('== 可用天数外推 ==');
// 北京 12:00（已过 12h），今日花费 ¥1.2 → 日速率 2.4 → 余额 100 → 41.67 天
assertClose('常规外推', estimateDays(100, 1.2, new Date('2026-08-20T04:00:00.000Z')), 100 / 2.4);
// 刚过午夜（按最少 0.5h 计）：今日花费 0.06 → 日速率 2.88 → 余额 50 → 17.36 天
assertClose('最少 0.5h 保护', estimateDays(50, 0.06, new Date('2026-08-19T16:10:00.000Z')), 50 / ((0.06 / 0.5) * 24));
ok('今日无消耗 → null', estimateDays(100, 0, new Date('2026-08-20T04:00:00.000Z')) === null);
ok('余额缺失 → null', estimateDays(null, 1.2, new Date('2026-08-20T04:00:00.000Z')) === null);
ok('余额为 0 → null', estimateDays(0, 1.2, new Date('2026-08-20T04:00:00.000Z')) === null);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
