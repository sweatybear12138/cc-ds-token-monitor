/**
 * test-titles.cjs — 自定义会话标题：设置/读取/持久化/删除回退。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { TitleStore } = require(path.join(__dirname, '..', 'dist', 'titles.js'));

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ds-titles-'));
const p = path.join(TMP, 'titles.json');

console.log('== 自定义标题 CRUD ==');
const store = new TitleStore(p);
ok('初始无自定义 → null', store.get('sess-1') === null);
store.set('sess-1', '开发deepseek监控插件');
ok('设置后读取', store.get('sess-1') === '开发deepseek监控插件');
const store2 = new TitleStore(p);
ok('持久化（新实例可读）', store2.get('sess-1') === '开发deepseek监控插件');
store.set('sess-1', '   ');
ok('空标题 → 删除自定义', store.get('sess-1') === null);
ok('删除后文件无该键', !fs.readFileSync(p, 'utf8').includes('sess-1'));

console.log('== 长度截断 ==');
store.set('sess-2', 'x'.repeat(100));
ok('超长截断到 60', store.get('sess-2').length === 60);

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
