/**
 * hook-precompact.cjs — PreCompact 预警写入方（warning.json 唯一写入方）。
 * 与 bridge.json 完全隔离：只写 warning.json，绝不触碰 bridge.json（单写者/文件，消除竞态）。
 * 用法: node hook-precompact.cjs [warningPath]
 *   默认 warningPath = ~/.claude/cc-ds-monitor/warning.json
 * stdin: Claude Code PreCompact hook JSON（trigger: "auto" | "manual"）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const warningPath = process.argv[2] || path.join(os.homedir(), '.claude', 'cc-ds-monitor', 'warning.json');
const runDir = path.dirname(warningPath);

function debugDump(kind, raw) {
  if (process.env.DEBUG_DS !== '1') return;
  try {
    const dir = path.join(runDir, 'debug');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${kind}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), raw);
  } catch {
    /* 忽略 */
  }
}

let rawIn = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (rawIn += c));
process.stdin.on('end', () => {
  debugDump('precompact-stdin', rawIn);
  let ev = {};
  try {
    ev = JSON.parse(rawIn);
  } catch {
    /* 解析失败也照写空预警状态，保证文件存在且结构正确 */
  }
  const isAuto = ev.trigger === 'auto';
  const nowIso = new Date().toISOString();
  const out = {
    schemaVersion: 1,
    updatedAt: nowIso,
    sessionId: ev.session_id ?? null,
    transcriptPath: ev.transcript_path ?? null,
    active: isAuto, // auto → 激活预警；manual（用户主动 /compact）→ 解除预警
    trigger: ev.trigger ?? null,
    at: nowIso,
  };
  try {
    const tmp = warningPath + '.tmp';
    fs.mkdirSync(path.dirname(warningPath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
    fs.renameSync(tmp, warningPath);
  } catch {
    /* 写入失败静默：预警功能降级，不影响会话 */
  }
  process.exit(0);
});
