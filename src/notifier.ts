import * as vscode from 'vscode';
import { RenderState } from './types';

const RENOTIFY_MS = 30 * 60 * 1000; // 阈值通知 30 分钟节流（PreCompact-auto 不受此限）

/**
 * 通知器：阈值穿越（黄/红）节流通知 + PreCompact-auto 权威预警。
 * PreCompact-auto 不设时长节流，按 warning.at 去重；用户手动 /compact（manual）后 active=false 自动复位。
 */
export class Notifier {
  private warnCrossed = false;
  private criticalCrossed = false;
  private lastPrecompactAt: string | null = null;
  private lastNotified = { warn: 0, critical: 0 };

  constructor(private readonly getThresholds: () => { warn: number; critical: number }) {}

  onState(state: RenderState): void {
    if (!state.data || state.data.source === 'error') return;
    const ctx = state.data.context.usedPct;
    const { warn, critical } = this.getThresholds();

    if (ctx != null) {
      if (ctx >= critical && !this.criticalCrossed) {
        this.criticalCrossed = true;
        this.warnCrossed = true;
        this.notify(
          'critical',
          vscode.window.showErrorMessage,
          `上下文使用率已达 ${Math.round(ctx)}%，超过红色阈值 ${critical}%！建议尽快 /compact 释放上下文。`
        );
      } else if (ctx >= warn && ctx < critical && !this.warnCrossed) {
        this.warnCrossed = true;
        this.notify(
          'warn',
          vscode.window.showWarningMessage,
          `上下文使用率已达 ${Math.round(ctx)}%，接近自动压缩区间（黄色阈值 ${warn}%），可以提前 /compact。`
        );
      } else if (ctx < warn) {
        this.warnCrossed = false;
        this.criticalCrossed = false;
      }
    }

    // PreCompact-auto：Claude Code 即将自动压缩的权威事件
    if (state.warning?.active && state.warning.trigger === 'auto' && state.warning.at && state.warning.at !== this.lastPrecompactAt) {
      this.lastPrecompactAt = state.warning.at;
      void vscode.window
        .showErrorMessage('⚠ 上下文过长，Claude Code 即将自动压缩！', '查看仪表盘')
        .then((sel) => this.openDashboard(sel));
    }
  }

  private notify(level: 'warn' | 'critical', fn: (msg: string, ...items: string[]) => Thenable<string | undefined>, message: string): void {
    const now = Date.now();
    if (now - this.lastNotified[level] < RENOTIFY_MS) return;
    this.lastNotified[level] = now;
    void fn.call(vscode.window, message, '查看仪表盘').then((sel) => this.openDashboard(sel));
  }

  private openDashboard(sel: string | undefined): void {
    if (sel === '查看仪表盘') void vscode.commands.executeCommand('ccDsMonitor.openDashboard');
  }
}
