#!/usr/bin/env bash
# statusline.sh — Claude Code statusLine 入口。
# stdin 收到一行 statusline JSON（非环境变量）；stdout 第一行渲染为终端状态栏。
# 数据由 bridge-write.cjs 计算并原子写入 ~/.claude/cc-ds-monitor/bridge.json。
# 绝不非零退出（红线：脚本故障不能打断会话）。
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
# 心跳：每次被 CC 调用就 touch 一次（mtime = 调用时间，用于诊断"CC 到底有没有调 statusline"）
touch "$HOME/.claude/cc-ds-monitor/statusline-heartbeat.txt" 2>/dev/null || true
node "$DIR/bridge-write.cjs"
exit 0
