# cc-ds-monitor

Claude Code × DeepSeek 实时用量监控 VSCode 扩展。在状态栏与仪表盘中实时显示：

- **缓存命中率**（DeepSeek 口径：`cache读 / (cache读 + 未命中输入)`）
- **token 消耗**（每轮未命中输入 / 缓存读 / 缓存写 / 输出）与 **¥ 费用**（峰/谷分时计价）
- **上下文过长预警**（可配置黄/红阈值 + Claude Code 自动压缩前的事件级预警）
- **今日全部会话合计**（北京时间日切，每秒自动累加）
- **今日会话列表**（点击钉选切换监控目标，可自定义会话标题）
- **账户余额 + 可用天数预估**（DeepSeek 官方余额接口，可选开启）

## 架构

```
Claude Code (statusLine, 每5s) ──► bridge-write.cjs ──► ~/.claude/cc-ds-monitor/bridge.json
Claude Code (PreCompact hook)  ──► hook-precompact.cjs ─► ~/.claude/cc-ds-monitor/warning.json
                                                        │
VSCode 扩展（只读监听，fs.watch + SourceMode 状态机）◄────┘
   ├─ 状态栏：💾 缓存 99.5% · ¥0.072 · 会话 标题/ID（绿/黄/红）
   ├─ 仪表盘：趋势图（上下文%/token构成/命中率/累计¥）+ 会话列表 + 余额 + 阈值设置
   └─ 兜底：桥接缺失/陈旧 → 自动切换解析会话 JSONL，恢复后自动切回
```

设计要点：

- **双文件单写者**：`bridge.json` 只有 statusline 脚本写，`warning.json` 只有 PreCompact hook 写，扩展只读——无竞态。
- **面板模式实证**：VSCode Claude Code 面板只在窗口启动时调一次 statusline 且 stdin 为空 → 面板场景 JSONL 兜底转正；空 stdin 调用被用作"会话锚点"。
- **会话跟随**：1s 轮询 + 1s 防抖，切换会话后 ~1-2 秒自动跟上；钉选后固定监控。
- **红线**：不硬编码自动压缩阈值（官方未公布）；不用 Anthropic 命中率公式；未知模型明示"价格未确认"绝不猜价；`cache_creation>0` 时提示价格模型需复核。
- **价格表可配置**：`~/.claude/cc-ds-monitor/pricing.json`（内置 DeepSeek 官方价格：v4-pro / v4-flash，峰=北京时间 9:00–12:00 / 14:00–18:00），政策变动改文件即可。
- **API key 安全**：余额查询从 `~/.claude/settings.json` 读取，只存内存，绝不落盘。

## 安装

```bash
cd cc-ds-monitor
npm install          # 一次性
npm run build        # tsc → dist/
npm run test         # 109 项断言（数学/脚本/状态机/日合计/标题/余额）
npm run install:scripts   # 复制运行时脚本到 ~/.claude/cc-ds-monitor/，生成合并片段
npm run package      # 产出 cc-ds-monitor-<version>.vsix
code --install-extension cc-ds-monitor-<version>.vsix --force
```

settings 合并：把生成的 `settings-merge-snippet.generated.json` 中的 `statusLine` 与 `hooks` 两个键合并进 `~/.claude/settings.json`（**先备份**，不要动 `env`/`permissions` 等其他键），然后重载 VSCode 窗口。

## 配置（设置 → CC-DS Monitor）

- `warnThreshold`（默认 75）/ `criticalThreshold`（默认 85）：上下文使用率黄/红预警线（%）
- `refreshMs`（默认 1000）：状态栏刷新间隔（毫秒）
- `stalenessMs`（默认 30000）：桥接数据超过此时长视为陈旧，切换 JSONL 兜底
- `enableBalanceCheck`（默认 false）：余额查询与可用天数预估（仪表盘右上角按钮可直接切换）

## 验证

1. 新会话跑几轮对话，观察 `~/.claude/cc-ds-monitor/bridge.json` 每 5s 更新（终端场景）。
2. VSCode 状态栏出现 `💾 缓存 … · ¥… · 会话 …`，点击或命令面板 `cc-ds：打开用量仪表盘` 看趋势图与会话列表。
3. 命中率/费用与 DeepSeek 控制台账单对账（±2%，峰谷边界 12:00/18:00 可能有少量偏差）。
4. 开启余额监测 → 卡片 1~2 秒内显示余额与预估天数。

## 已知限制

- **单活跃会话监控**：多会话并发时显示最近活跃者，可在"今日会话"列表手动钉选。
- JSONL 兜底模式无窗口信息，不显示上下文使用率（不硬编码任何窗口大小/压缩阈值）。

## 故障排查

| 现象 | 处理 |
|---|---|
| 状态栏"cc-ds 未连接" | 确认已运行 `install:scripts`、已合并 settings、已重载窗口；读 `~/.claude/cc-ds-monitor/ext.log` 看诊断 |
| 数据异常 ⚠ | 看仪表盘页脚 `lastError`；`DEBUG_DS=1` 可 dump statusline stdin 到 `debug/` 目录 |
| 价格显示"未确认" | 模型名不在 pricing.json 里 → 手动加一条 |
| 想改价格/峰谷时段 | 编辑 `~/.claude/cc-ds-monitor/pricing.json`，下次刷新即生效 |
| 余额卡显示错误信息 | 读 `ext.log` 的 `balance.check` 行定位（key 缺失/网络/HTTP 状态） |
