/**
 * install-scripts.cjs — 把运行时脚本安装到 ~/.claude/cc-ds-monitor/。
 * - 复制 statusline.sh / bridge-write.cjs / hook-precompact.sh / hook-precompact.cjs
 * - pricing-default.json → pricing.json（已存在则不覆盖，保留用户修改）
 * - 校验 bash 可用
 * - 用 os.homedir() 动态生成 settings 合并片段（不硬编码用户名/路径）
 * - 绝不自动修改 settings.json（合并动作由人工/会话在备份后执行）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const SRC = __dirname;
const DST = path.join(os.homedir(), '.claude', 'cc-ds-monitor');
const PROJECT_ROOT = path.join(__dirname, '..');

const FILES = ['statusline.sh', 'bridge-write.cjs', 'hook-precompact.sh', 'hook-precompact.cjs'];

function main() {
  fs.mkdirSync(DST, { recursive: true });

  for (const f of FILES) {
    fs.copyFileSync(path.join(SRC, f), path.join(DST, f));
    console.log(`复制 ${f} → ${DST}`);
  }

  const dstPricing = path.join(DST, 'pricing.json');
  if (!fs.existsSync(dstPricing)) {
    fs.copyFileSync(path.join(SRC, 'pricing-default.json'), dstPricing);
    console.log(`生成 ${dstPricing}（默认价格表，可自行修改）`);
  } else {
    console.log(`保留现有 ${dstPricing}（不覆盖）`);
  }

  const bash = spawnSync('bash', ['--version'], { encoding: 'utf8' });
  if (bash.status !== 0) {
    console.error('⚠ 未检测到 Git Bash，statusline/hook 命令将无法执行。请先安装 Git for Windows。');
    process.exit(1);
  }
  console.log('✓ Git Bash 可用');

  // 动态生成合并片段（占位符 <HOME> 替换为真实 home，统一正斜杠）
  const home = os.homedir().replace(/\\/g, '/');
  const snippet = {
    statusLine: {
      type: 'command',
      command: `bash "${home}/.claude/cc-ds-monitor/statusline.sh"`,
      refreshInterval: 5,
      padding: 0,
    },
    hooks: {
      PreCompact: [
        {
          matcher: 'start',
          hooks: [
            {
              type: 'command',
              command: `bash "${home}/.claude/cc-ds-monitor/hook-precompact.sh"`,
            },
          ],
        },
      ],
    },
  };
  const outPath = path.join(PROJECT_ROOT, 'settings-merge-snippet.generated.json');
  fs.writeFileSync(outPath, JSON.stringify(snippet, null, 2));
  console.log(`✓ 合并片段已生成: ${outPath}`);
  console.log('\n将该片段中的 statusLine 与 hooks 两个键合并进 ~/.claude/settings.json（先备份！不要动其他键）:');
  console.log(JSON.stringify(snippet, null, 2));
}

main();
