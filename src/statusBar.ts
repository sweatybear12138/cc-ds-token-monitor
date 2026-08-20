import * as vscode from 'vscode';
import { RenderState } from './types';

const GREEN = '#4ec9b0';
const YELLOW = '#dcdcaa';
const RED = '#f48771';
const GRAY = '#858585';

/** VSCode 状态栏项：`💾 缓存 99.5% · ¥0.072 · 上下文 62%`，绿/黄/红配色 */
export class StatusBar implements vscode.Disposable {
  readonly item: vscode.StatusBarItem;

  constructor(private readonly getThresholds: () => { warn: number; critical: number }) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'ccDsMonitor.openDashboard';
    this.item.tooltip = 'cc-ds：Claude Code × DeepSeek 用量监控（点击打开仪表盘）';
  }

  render(state: RenderState): void {
    const { data, warning, mode, stale, sessionChurn } = state;
    this.item.show();

    if (!data || mode === 'none') {
      this.item.text = '$(circle-slash) cc-ds 未连接';
      this.item.color = GRAY;
      this.item.tooltip = '未检测到桥接数据。请运行 install:scripts 并在 ~/.claude/settings.json 配置 statusLine。';
      return;
    }
    if (data.source === 'error') {
      this.item.text = '$(warning) cc-ds 数据异常';
      this.item.color = GRAY;
      this.item.tooltip = data.lastError ?? '桥接数据异常，详情见仪表盘';
      return;
    }

    const hit = data.stats.cacheHitRate != null ? (data.stats.cacheHitRate * 100).toFixed(1) + '%' : '—';
    const cost = data.stats.costTurnYuan != null ? '¥' + data.stats.costTurnYuan.toFixed(3) : '—';
    const { warn, critical } = this.getThresholds();

    let icon = '$(check)';
    let color = GREEN;
    if (warning?.active) {
      icon = '$(error)';
      color = RED;
    } else if (data.context.usedPct != null && data.context.usedPct >= critical) {
      icon = '$(error)';
      color = RED;
    } else if (data.context.usedPct != null && data.context.usedPct >= warn) {
      icon = '$(warning)';
      color = YELLOW;
    } else if (stale) {
      icon = '$(sync)';
      color = GRAY;
    }

    // 兜底模式无上下文% → 显示正在监控的会话标题/ID（用户切换会话后一眼可见是否跟上）
    const sessionLabel = (data.sessionTitle || data.sessionId || '').slice(0, 12);
    const tail =
      data.context.usedPct == null && sessionLabel
        ? ` · 会话 ${sessionLabel}`
        : ` · 上下文 ${Math.round(data.context.usedPct ?? 0)}%`;
    this.item.text = `${icon} 缓存 ${hit} · ${cost}${tail}${stale ? ' · 兜底' : ''}`;
    this.item.color = color;
    this.item.tooltip = this.buildTooltip(state, warn, critical);
  }

  private buildTooltip(state: RenderState, warn: number, critical: number): vscode.MarkdownString {
    const { data, warning, mode, stale, sessionChurn } = state;
    if (!data) return new vscode.MarkdownString('');
    const md = new vscode.MarkdownString('', true);
    md.isTrusted = true;
    const cur = data.context.current;
    const lines: string[] = [
      `**cc-ds Monitor**（数据源: ${mode === 'bridge' ? 'statusline 桥接' : mode === 'jsonl' ? 'JSONL 兜底' : '无'}${stale ? '，桥接已陈旧' : ''}）`,
      `— 缓存命中率: ${data.stats.cacheHitRate != null ? (data.stats.cacheHitRate * 100).toFixed(2) + '%' : '—'}（${cur ? (cur.cacheReadTokens + cur.inputTokens).toLocaleString() : '—'} tokens/轮）`,
      `— 本轮费用: ${data.stats.costTurnYuan != null ? '¥' + data.stats.costTurnYuan.toFixed(4) : '—'}${data.stats.isPeakTime ? '（峰时）' : data.stats.isPeakTime === false ? '（谷时）' : ''}`,
      `— 今日全部会话合计: ${state.todayYuan != null ? '¥' + state.todayYuan.toFixed(4) : '—'}`,
      `— 上下文: ${data.context.usedPct != null ? data.context.usedPct.toFixed(1) + '%' : '—'}${data.context.windowSize != null ? ' / ' + data.context.windowSize.toLocaleString() : ''}`,
      `— 最近响应: ${cur ? `in ${cur.inputTokens} · cache读 ${cur.cacheReadTokens} · cache写 ${cur.cacheCreationTokens} · out ${cur.outputTokens}` : '（首次调用前或 /compact 后）'}`,
      `— 模型: ${data.model.id ?? '未知'}${data.model.pricingKnown ? `（价格: ${data.model.pricingSource === 'config' ? '自定义 pricing.json' : '内置默认'})` : '（价格未确认）'}`,
      `— 预警阈值: 黄 ${warn}% / 红 ${critical}%（可在设置中修改）`,
    ];
    if (warning?.active) lines.push(`**⚠ 自动压缩即将发生**（trigger=auto，${warning.at ? new Date(warning.at).toLocaleTimeString() : ''}）`);
    if (sessionChurn) lines.push('⚠ 检测到多个会话并发写入，仅显示最近会话（v1 单活跃会话监控）');
    md.appendMarkdown(lines.join('\n\n'));
    return md;
  }

  dispose(): void {
    this.item.dispose();
  }
}
