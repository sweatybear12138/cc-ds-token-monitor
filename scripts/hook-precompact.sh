#!/usr/bin/env bash
# hook-precompact.sh — Claude Code PreCompact hook 入口。
# stdin 收到 hook JSON（含 trigger: "auto" | "manual"）。
# trigger=auto（自动压缩即将发生）→ warning.json active=true；manual → active=false。
# 绝不非零退出（红线）。
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
node "$DIR/hook-precompact.cjs"
exit 0
