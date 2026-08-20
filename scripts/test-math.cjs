/**
 * test-math.cjs — pricing 数学单元断言（需先 npm run build 产出 dist/pricing.js）。
 * 红线对照：DeepSeek 命中率公式 / 峰谷边界 / [1m] 剥离 / 未知模型不猜价 / pricing.json 可覆盖。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { cacheHitRate, costYuan, loadPricing, modelKey, lookupPrice, beijingHour, isPeakTime, DEFAULT_PRICING } = require(path.join(__dirname, '..', 'dist', 'pricing.js'));

let pass = 0;
let fail = 0;
function assertEq(name, actual, expected, tol) {
  const ok = typeof expected === 'number' ? Math.abs(actual - expected) <= (tol ?? 1e-9) : actual === expected;
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}: 期望 ${expected}，实际 ${actual}`);
  }
}
function assertTrue(name, cond) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}`);
  }
}

console.log('== 命中率（DeepSeek 公式 cacheRead/(cacheRead+input)）==');
// 本机真实 JSONL 样本: input 1692 / cache_read 360192 / output 762 → 360192/361884
assertEq('真实样本命中率', cacheHitRate(1692, 360192), 360192 / 361884);
assertEq('总输入为 0 → null', cacheHitRate(0, 0), null);

console.log('== 计费（真实样本，谷/峰）==');
const usage = { input: 1692, cacheRead: 360192, output: 762 };
// 谷时: (1692*4.5 + 360192*0.15 + 762*13.5)/1e6 = 0.0719298
// 峰时: (1692*9.0 + 360192*0.30 + 762*27.0)/1e6 = 0.1438596
const off = costYuan(DEFAULT_PRICING, 'deepseek-v4-pro', usage, new Date('2026-08-19T20:00:00Z')); // 北京 04:00 谷
assertEq('谷时费用 ¥0.0719298', off.yuan, 0.0719298);
assertTrue('谷时 isPeak=false', !off.peak);
const peak = costYuan(DEFAULT_PRICING, 'deepseek-v4-pro', usage, new Date('2026-08-19T02:00:00Z')); // 北京 10:00 峰
assertEq('峰时费用 ¥0.1438596', peak.yuan, 0.1438596);
assertTrue('峰时 isPeak=true', peak.peak);
const flashOff = costYuan(DEFAULT_PRICING, 'deepseek-v4-flash[256k]', usage, new Date('2026-08-19T20:00:00Z'));
assertEq('v4-flash 谷时 (1692*1.5+360192*0.05+762*4.5)/1e6', flashOff.yuan, (1692 * 1.5 + 360192 * 0.05 + 762 * 4.5) / 1e6);

console.log('== 峰谷边界（北京时间）==');
assertTrue('11:59 峰 (UTC 03:59)', isPeakTime(DEFAULT_PRICING, new Date('2026-08-19T03:59:00Z')));
assertTrue('12:00 谷 (UTC 04:00)', !isPeakTime(DEFAULT_PRICING, new Date('2026-08-19T04:00:00Z')));
assertTrue('17:59 峰 (UTC 09:59)', isPeakTime(DEFAULT_PRICING, new Date('2026-08-19T09:59:00Z')));
assertTrue('18:00 谷 (UTC 10:00)', !isPeakTime(DEFAULT_PRICING, new Date('2026-08-19T10:00:00Z')));
assertTrue('08:59 谷 (UTC 00:59)', !isPeakTime(DEFAULT_PRICING, new Date('2026-08-19T00:59:00Z')));
assertTrue('09:00 峰 (UTC 01:00)', isPeakTime(DEFAULT_PRICING, new Date('2026-08-19T01:00:00Z')));
assertEq('beijingHour(UTC 02:00)=10', beijingHour(new Date('2026-08-19T02:00:00Z')), 10);

console.log('== 模型名归一化 ==');
assertEq('[1m] 剥离', modelKey('deepseek-v4-pro[1m]'), 'deepseek-v4-pro');
assertEq('大小写+[256K] 剥离', modelKey('DEEPSEEK-V4-PRO[256K]'), 'deepseek-v4-pro');
assertEq('空值安全', modelKey(null), '');

console.log('== 未知模型不猜价 ==');
const unknown = lookupPrice(DEFAULT_PRICING, 'some-future-model');
assertTrue('lookupPrice known=false', !unknown.known);
const costUnknown = costYuan(DEFAULT_PRICING, 'some-future-model', usage);
assertEq('未知模型 cost yuan=null', costUnknown.yuan, null);
assertTrue('未知模型 cost known=false', !costUnknown.known);

console.log('== pricing.json 可覆盖 ==');
assertEq('缺失文件 → default 源', loadPricing(path.join(os.tmpdir(), 'no-such-pricing-' + process.pid + '.json')).source, 'default');
const tmpCfg = path.join(os.tmpdir(), 'cc-ds-test-pricing-' + process.pid + '.json');
fs.writeFileSync(
  tmpCfg,
  JSON.stringify({ peakHours: [{ start: 0, end: 24 }], models: { 'deepseek-v4-pro': { hitOff: 1, hitPeak: 1, missOff: 1, missPeak: 1, outOff: 1, outPeak: 1 } } })
);
const cfg2 = loadPricing(tmpCfg);
assertEq('自定义文件 → config 源', cfg2.source, 'config');
const customCost = costYuan(cfg2, 'deepseek-v4-pro', { input: 1000000, cacheRead: 0, output: 0 }, new Date('2026-08-19T20:00:00Z'));
assertEq('覆盖后价格生效 ¥1/1M', customCost.yuan, 1);
assertEq('覆盖文件缺的模型沿用默认表', cfg2.models['deepseek-v4-flash'].hitOff, 0.05);
fs.unlinkSync(tmpCfg);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
