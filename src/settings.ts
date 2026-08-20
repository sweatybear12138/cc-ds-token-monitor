import * as vscode from 'vscode';

/**
 * 扩展配置读取（ccDsMonitor.* 节）。
 * 重要教训（本机实证 2026-08-20）：缓存的 WorkspaceConfiguration 实例读的是
 * 创建时的快照，config.update 写入的新值它看不见 → 每次读取都必须重新 getConfiguration。
 */
export class Settings {
  private cfg(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('ccDsMonitor');
  }

  get warnThreshold(): number {
    return this.cfg().get<number>('warnThreshold', 75);
  }
  get criticalThreshold(): number {
    return this.cfg().get<number>('criticalThreshold', 85);
  }
  get refreshMs(): number {
    return this.cfg().get<number>('refreshMs', 1000);
  }
  get stalenessMs(): number {
    return this.cfg().get<number>('stalenessMs', 30000);
  }
  get enableBalanceCheck(): boolean {
    return this.cfg().get<boolean>('enableBalanceCheck', false);
  }

  onChange(cb: () => void): vscode.Disposable {
    // 配置变更事件挂在 vscode.workspace 上（WorkspaceConfiguration 对象没有此方法）
    return vscode.workspace.onDidChangeConfiguration((e: vscode.ConfigurationChangeEvent) => {
      if (e.affectsConfiguration('ccDsMonitor')) cb();
    });
  }
}
