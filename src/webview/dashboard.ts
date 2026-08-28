import * as vscode from 'vscode';
import { RenderState } from '../types';
import { DashboardHost, HostOptions } from './host';

/**
 * 独立监控页面（Beside 面板）：薄壳，全部逻辑在共享宿主 DashboardHost。
 */
export class DashboardPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | null = null;
  private host: DashboardHost | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly hostOpts: HostOptions
  ) {}

  push(state: RenderState): void {
    this.host?.push(state);
  }

  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      'ccDsMonitor.dashboard',
      'cc-ds 用量仪表盘',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        enableForms: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(this.hostOpts.mediaDir)],
      }
    );
    this.host = new DashboardHost(this.panel.webview, this.hostOpts);
    this.panel.webview.html = this.host.buildHtml();
    this.host.bind();
    this.host.onReady();
    this.panel.onDidDispose(() => {
      this.panel = null;
      this.host = null;
    });
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = null;
    this.host = null;
  }
}
