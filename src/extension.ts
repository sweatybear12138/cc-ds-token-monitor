import * as fs from 'fs';
import * as vscode from 'vscode';
import * as path from 'path';
import { BalanceChecker } from './balance';
import { homeDir } from './homedir';
import { Monitor } from './monitor';
import { Notifier } from './notifier';
import { Settings } from './settings';
import { StatusBar } from './statusBar';
import { TitleStore } from './titles';
import { DashboardPanel } from './webview/dashboard';
import { HostOptions } from './webview/host';
import { SidebarViewProvider } from './webview/sidebar';

/**
 * cc-ds-monitor：Claude Code × DeepSeek 实时用量监控。
 * 数据链路：statusline 脚本写 bridge.json / PreCompact hook 写 warning.json（单写者/文件）
 *         → 本扩展只读监听 → 状态栏 + 仪表盘 + 阈值/压缩预警。
 */
export function activate(context: vscode.ExtensionContext): void {
  const settings = new Settings();
  const runDir = path.join(homeDir(), '.claude', 'cc-ds-monitor');
  const thresholds = () => ({ warn: settings.warnThreshold, critical: settings.criticalThreshold });

  const statusBar = new StatusBar(thresholds);
  const notifier = new Notifier(thresholds);
  const titleStore = new TitleStore(path.join(runDir, 'titles.json'));
  const balance = new BalanceChecker(
    // 新鲜读取开关状态（不能用缓存的 Settings 实例快照——本机实证的坑）
    () => vscode.workspace.getConfiguration('ccDsMonitor').get<boolean>('enableBalanceCheck', false),
    () => readApiKeyFromSettings(),
    () => new Date(),
    (msg) => {
      try {
        fs.appendFileSync(path.join(runDir, 'ext.log'), `${new Date().toISOString()} ${msg}\n`);
      } catch {
        /* 日志失败不影响 */
      }
    }
  );
  let monitor: Monitor;
  // 两个仪表盘入口（独立页面 + 侧边栏视图）共享同一套宿主配置与回调
  const hostOpts: HostOptions = {
    mediaDir: path.join(context.extensionPath, 'media'),
    getThresholds: thresholds,
    onSetTitle: (id: string, title: string) => {
      titleStore.set(id, title);
      monitor.refreshNow(false); // 重新 emit，应用新标题
    },
    onPin: (p: string | null) => {
      monitor.pinTranscript(p);
    },
    onPinCurrent: () => {
      monitor.pinCurrentConversation();
    },
    getBalanceEnabled: () => settings.enableBalanceCheck,
    onToggleBalance: () => {
      const cur = settings.enableBalanceCheck;
      // update 是异步的：必须等写入完成后再查，否则 check() 读到的还是旧开关状态
      void vscode.workspace
        .getConfiguration('ccDsMonitor')
        .update('enableBalanceCheck', !cur, vscode.ConfigurationTarget.Global)
        .then(() => balance.check());
    },
  };
  const dashboard = new DashboardPanel(context, hostOpts);
  const sidebar = new SidebarViewProvider(hostOpts);
  monitor = new Monitor(runDir, settings.refreshMs, settings.stalenessMs, (state) => {
    try {
      statusBar.render(state);
      notifier.onState(state);
      dashboard.push(state);
      sidebar.push(state);
    } catch (e) {
      console.error('[cc-ds] render 异常:', e);
    }
  }, undefined, titleStore, balance);

  // 先注册全部订阅，最后才启动监控——注册阶段若有异常，VS Code 会统一清理，不留孤儿状态栏
  context.subscriptions.push(
    statusBar,
    dashboard,
    vscode.window.registerWebviewViewProvider('ccDsMonitor.dashboardView', sidebar),
    vscode.commands.registerCommand('ccDsMonitor.openDashboard', () => dashboard.show()),
    vscode.commands.registerCommand('ccDsMonitor.refreshNow', () => monitor.refreshNow(true)),
    settings.onChange(() => {
      monitor.updateIntervals(settings.refreshMs, settings.stalenessMs);
    }),
    new vscode.Disposable(() => monitor.dispose())
  );
  monitor.start();
}

export function deactivate(): void {
  /* 订阅项统一由 subscriptions 释放 */
}

/** 从 ~/.claude/settings.json 的 env 块读 DeepSeek API key（只内存使用，不落盘） */
function readApiKeyFromSettings(): string | null {
  try {
    const raw = fs.readFileSync(path.join(homeDir(), '.claude', 'settings.json'), 'utf8');
    const cfg = JSON.parse(raw) as { env?: Record<string, string> };
    return cfg.env?.ANTHROPIC_AUTH_TOKEN ?? null;
  } catch {
    return null;
  }
}
