import * as path from 'path';
import * as vscode from 'vscode';
import { RenderState } from '../types';

export interface HostOptions {
  mediaDir: string;
  getThresholds: () => { warn: number; critical: number };
  onSetTitle: (sessionId: string, title: string) => void;
  onPin: (path: string | null) => void;
  onPinCurrent: () => void;
  getBalanceEnabled: () => boolean;
  onToggleBalance: () => void;
}

/**
 * 仪表盘共享宿主：独立面板（DashboardPanel）与侧边栏视图（SidebarViewProvider）
 * 共用同一份 HTML 模板、消息协议与历史 ring buffer。
 */
export class DashboardHost {
  private readonly history: Array<{ t: number; state: RenderState }> = [];
  private lastPoint = { key: '', t: 0 };
  private lastState: RenderState | null = null;

  constructor(
    private readonly webview: vscode.Webview,
    private readonly opts: HostOptions
  ) {}

  bind(): vscode.Disposable {
    return this.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
  }

  buildHtml(): string {
    const uri = (f: string) => this.webview.asWebviewUri(vscode.Uri.file(path.join(this.opts.mediaDir, f))).toString();
    const csp = this.webview.cspSource;
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp}; script-src ${csp}; img-src ${csp} data:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>cc-ds 用量仪表盘</title>
  <link rel="stylesheet" href="${uri('dashboard.css')}">
</head>
<body>
  <div id="warn-banner" class="banner hidden" role="alert">
    <span class="banner-icon">⚠</span>
    <div><strong>上下文过长，Claude Code 即将自动压缩！</strong><span id="warn-at" class="note"></span></div>
  </div>
  <header class="head">
    <div>
      <h1>cc-ds 用量仪表盘</h1>
      <p class="sub">Claude Code × DeepSeek 实时监控</p>
    </div>
    <div class="head-right">
      <div class="badges">
        <span id="badge-mode" class="badge">—</span>
        <span id="badge-peak" class="badge">—</span>
        <span id="badge-price" class="badge">—</span>
      </div>
      <button id="b-balance" class="btn-ghost" type="button">余额监测：关</button>
      <button id="b-refresh" class="btn-ghost" type="button">⟳ 立即刷新</button>
    </div>
  </header>
  <section class="cards">
    <div class="card">
      <div class="label">缓存命中率</div>
      <div class="value" id="v-hit">—</div>
      <div class="note" id="n-hit">—</div>
    </div>
    <div class="card">
      <div class="label">本轮费用</div>
      <div class="value" id="v-cost">—</div>
      <div class="label sub-label">今日全部会话</div>
      <div class="value med" id="v-today">—</div>
      <div class="label sub-label">本会话累计</div>
      <div class="value med" id="v-session">—</div>
    </div>
    <div class="card">
      <div class="label">今日会话（点击切换监控）</div>
      <div id="session-list" class="session-list"></div>
      <div class="pin-actions">
        <button id="b-pin-current" class="btn-ghost" type="button">🎯 当前对话</button>
        <button id="b-unpin" class="btn-ghost" type="button">↺ 跟随最新</button>
      </div>
    </div>
    <div class="card">
      <div class="label">账户余额</div>
      <div class="value" id="v-balance">—</div>
      <div class="note" id="n-balance">—</div>
    </div>
    <div class="card">
      <div class="label">模型 / 会话</div>
      <div class="value small" id="v-model">—</div>
      <div class="note mono" id="n-session">—</div>
    </div>
    <div class="card">
      <div class="label">上下文使用率</div>
      <div class="value" id="v-ctx">—</div>
      <div class="bar"><div id="b-ctx" class="fill"></div></div>
      <div class="note" id="n-ctx">—</div>
    </div>
  </section>
  <section class="grid">
    <div class="card chart">
      <div class="label">上下文使用率趋势</div>
      <canvas id="c-ctx"></canvas>
      <div class="legend"><span class="dot dot-warn"></span>黄色预警线 <span class="dot dot-danger"></span>红色预警线</div>
    </div>
    <div class="card chart">
      <div class="label">每轮 token 构成</div>
      <canvas id="c-tok"></canvas>
      <div class="legend"><span class="dot dot-miss"></span>未命中输入 <span class="dot dot-hit"></span>缓存命中 <span class="dot dot-out"></span>输出</div>
    </div>
    <div class="card chart">
      <div class="label">缓存命中率趋势</div>
      <canvas id="c-hit"></canvas>
      <div class="legend"><span class="dot dot-accent"></span>命中率 %</div>
    </div>
    <div class="card chart">
      <div class="label">会话累计费用（¥）</div>
      <canvas id="c-yen"></canvas>
      <div class="legend"><span class="dot dot-accent"></span>累计 ¥</div>
    </div>
  </section>
  <section class="row">
    <div class="card">
      <div class="label">会话详情</div>
      <table class="kv" id="t-session"></table>
    </div>
    <div class="card">
      <div class="label">预警阈值</div>
      <div class="form">
        <label class="field">黄色预警 %
          <input type="number" id="i-warn" min="1" max="99" step="1" aria-describedby="save-msg">
        </label>
        <label class="field">红色预警 %
          <input type="number" id="i-critical" min="2" max="100" step="1" aria-describedby="save-msg">
        </label>
        <button id="b-save" type="button">保存</button>
        <span id="save-msg" class="note" role="status" aria-live="polite"></span>
      </div>
      <p class="note">自动压缩阈值由 Claude Code 内部决定（官方未公开），这里只设置本扩展的预警线。</p>
    </div>
  </section>
  <footer class="foot" id="foot">—</footer>
  <script src="${uri('dashboard.js')}"></script>
  <script src="${uri('canvas-charts.js')}"></script>
</body>
</html>`;
  }

  /** webview 就绪 → 回放历史 + 阈值/余额配置 + 当前状态 */
  onReady(): void {
    void this.webview.postMessage({
      type: 'config',
      ...this.opts.getThresholds(),
      balanceEnabled: this.opts.getBalanceEnabled(),
    });
    void this.webview.postMessage({ type: 'history', history: this.history });
    if (this.lastState) void this.webview.postMessage({ type: 'update', state: this.lastState });
  }

  /** 变化才记点（或 60s 兜底），避免 1s tick 刷爆历史 */
  push(state: RenderState): void {
    this.lastState = this.snapshot(state);
    const d = state.data;
    const key = d
      ? [
          d.source,
          d.stats.tokensInTurn ?? '',
          d.stats.cacheHitRate?.toFixed(4) ?? '',
          d.context.usedPct?.toFixed(1) ?? '',
          d.stats.costTurnYuan?.toFixed(4) ?? '',
          state.warning?.active ? 'w' : '',
          d.sessionId ?? '',
        ].join(':')
      : '';
    const now = Date.now();
    if (key !== this.lastPoint.key || now - this.lastPoint.t > 60_000) {
      this.history.push({ t: now, state: this.snapshot(state) });
      if (this.history.length > 300) this.history.shift();
      this.lastPoint = { key, t: now };
    }
    void this.webview.postMessage({ type: 'update', state: this.snapshot(state) });
  }

  private onMessage(msg: { type: string; warn?: number; critical?: number; sessionId?: string; title?: string; path?: string }): void {
    switch (msg.type) {
      case 'ready':
        this.onReady();
        break;
      case 'refresh':
        void vscode.commands.executeCommand('ccDsMonitor.refreshNow');
        break;
      case 'setTitle':
        if (typeof msg.sessionId === 'string' && msg.sessionId) {
          this.opts.onSetTitle(msg.sessionId, typeof msg.title === 'string' ? msg.title : '');
        }
        break;
      case 'pinSession':
        this.opts.onPin(typeof msg.path === 'string' && msg.path ? msg.path : null);
        break;
      case 'pinCurrent':
        this.opts.onPinCurrent();
        break;
      case 'unpinSession':
        this.opts.onPin(null);
        break;
      case 'toggleBalance':
        this.opts.onToggleBalance();
        break;
      case 'setThreshold':
        if (
          typeof msg.warn === 'number' &&
          typeof msg.critical === 'number' &&
          msg.warn >= 1 &&
          msg.critical > msg.warn &&
          msg.critical <= 100
        ) {
          const cfg = vscode.workspace.getConfiguration('ccDsMonitor');
          void cfg.update('warnThreshold', msg.warn, vscode.ConfigurationTarget.Global);
          void cfg.update('criticalThreshold', msg.critical, vscode.ConfigurationTarget.Global);
        }
        break;
      default:
        break;
    }
  }

  private snapshot(state: RenderState): RenderState {
    return JSON.parse(JSON.stringify(state)) as RenderState;
  }
}
