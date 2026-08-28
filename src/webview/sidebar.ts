import * as vscode from 'vscode';
import { RenderState } from '../types';
import { DashboardHost, HostOptions } from './host';

/**
 * 侧边栏视图（活动栏图标点开，内嵌在左侧栏）：薄壳，全部逻辑在共享宿主 DashboardHost。
 * 视图被折叠/关闭重建时 resolveWebviewView 会重新执行，onReady 回放历史，数据不丢。
 */
export class SidebarViewProvider implements vscode.WebviewViewProvider {
  private host: DashboardHost | null = null;

  constructor(private readonly hostOpts: HostOptions) {}

  push(state: RenderState): void {
    this.host?.push(state);
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(this.hostOpts.mediaDir)],
    };
    this.host = new DashboardHost(webviewView.webview, this.hostOpts);
    webviewView.webview.html = this.host.buildHtml();
    this.host.bind();
    this.host.onReady();
    webviewView.onDidDispose(() => {
      this.host = null;
    });
  }
}
