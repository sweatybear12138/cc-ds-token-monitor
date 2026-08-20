/**
 * dashboard.js — webview 侧逻辑：状态卡、徽章、预警横幅、会话表、阈值表单、图表驱动。
 * 数据来自扩展消息：{type:'history', history}（重放）与 {type:'update', state}（实时）。
 */
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();

  /* ---------- 状态 ---------- */
  let history = []; // [{t, state}]（扩展去重后的历史）
  let latest = null; // RenderState
  let lastKey = '';
  let lastTokensInTurn = null;
  let cumYen = 0; // 桥接模式：按轮去重累计 ¥
  let cumSeries = []; // [{x, y}] 累计费用序列

  const $ = (id) => document.getElementById(id);

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function stateKey(state) {
    const d = state && state.data;
    if (!d) return '';
    return [
      d.source,
      d.stats.tokensInTurn ?? '',
      d.stats.cacheHitRate != null ? d.stats.cacheHitRate.toFixed(4) : '',
      d.context.usedPct != null ? d.context.usedPct.toFixed(1) : '',
      d.stats.costTurnYuan != null ? d.stats.costTurnYuan.toFixed(4) : '',
      state.warning && state.warning.active ? 'w' : '',
      d.sessionId ?? '',
    ].join(':');
  }

  function appendHistory(state) {
    const key = stateKey(state);
    if (key && key !== lastKey) {
      lastKey = key;
      history.push({ t: Date.now(), state });
      if (history.length > 300) history.shift();
      // 累计费用：新的一轮（tokensInTurn 变化）才加
      const d = state.data;
      const tt = d && d.stats.tokensInTurn;
      if (tt != null && tt !== lastTokensInTurn && d.stats.costTurnYuan != null) {
        lastTokensInTurn = tt;
        cumYen += d.stats.costTurnYuan;
      }
      if (d && d.stats.costSessionYuan != null) cumYen = d.stats.costSessionYuan; // jsonl 模式：用 transcript 累计值
    }
  }

  /* ---------- 渲染 ---------- */
  function render(state) {
    latest = state;
    appendHistory(state);
    const d = state.data;
    const w = state.warning;

    // 预警横幅
    const banner = $('warn-banner');
    if (w && w.active) {
      banner.classList.remove('hidden');
      $('warn-at').textContent = w.at ? ' · ' + new Date(w.at).toLocaleTimeString('zh-CN') : '';
    } else {
      banner.classList.add('hidden');
    }

    // 徽章
    const modeText = { bridge: 'statusline 桥接', jsonl: 'JSONL 兜底', none: '未连接' }[state.mode] || '—';
    $('badge-mode').textContent = (state.stale ? '⚠ ' : '') + modeText;
    const peakBadge = $('badge-peak');
    if (d && d.stats.isPeakTime === true) {
      peakBadge.textContent = '峰时计费';
      peakBadge.className = 'badge peak';
    } else if (d && d.stats.isPeakTime === false) {
      peakBadge.textContent = '谷时计费';
      peakBadge.className = 'badge offpeak';
    } else {
      peakBadge.textContent = '时段未知';
      peakBadge.className = 'badge';
    }
    const priceBadge = $('badge-price');
    if (!d) {
      priceBadge.textContent = '—';
    } else if (!d.model.pricingKnown) {
      priceBadge.textContent = '价格未确认';
      priceBadge.className = 'badge peak';
    } else {
      priceBadge.textContent = d.model.pricingSource === 'config' ? '自定义价格表' : '内置价格表';
      priceBadge.className = 'badge';
    }

    if (!d || state.mode === 'none') {
      renderEmpty();
      return;
    }

    // 命中率卡
    if (d.stats.cacheHitRate != null) {
      $('v-hit').textContent = (d.stats.cacheHitRate * 100).toFixed(1) + '%';
      const cur = d.context.current;
      $('n-hit').textContent = cur
        ? '缓存读 ' + cur.cacheReadTokens.toLocaleString() + ' · 轮输入 ' + (cur.cacheReadTokens + cur.inputTokens).toLocaleString() + ' tokens'
        : '本轮无数据（首次调用前或 /compact 后）';
    } else {
      $('v-hit').textContent = '—';
      $('n-hit').textContent = '本轮无数据';
    }

    // 费用卡：本轮（大）→ 今日全部会话（第二位）→ 本会话累计（第三位）
    $('v-cost').textContent = d.stats.costTurnYuan != null ? '¥' + d.stats.costTurnYuan.toFixed(3) : '—';
    $('v-today').textContent = state.todayYuan != null ? '¥' + state.todayYuan.toFixed(4) : '—';
    $('v-session').textContent = '¥' + cumYen.toFixed(4) + (d.stats.costSessionYuan != null ? '' : '（按轮累计）');

    // 上下文卡
    const ctx = d.context.usedPct;
    const fill = $('b-ctx');
    if (ctx != null) {
      $('v-ctx').textContent = ctx.toFixed(1) + '%';
      fill.style.width = Math.min(100, Math.max(0, ctx)) + '%';
      const critical = Number($('i-critical').value) || 85;
      const warn = Number($('i-warn').value) || 75;
      fill.className = 'fill' + (ctx >= critical ? ' danger' : ctx >= warn ? ' warn' : '');
      $('n-ctx').textContent =
        (d.context.windowSize != null ? '窗口 ' + d.context.windowSize.toLocaleString() + ' · ' : '') +
        '剩余 ' +
        (d.context.remainingPct != null ? d.context.remainingPct.toFixed(1) + '%' : '—');
    } else {
      $('v-ctx').textContent = '—';
      fill.style.width = '0%';
      fill.className = 'fill';
      $('n-ctx').textContent = state.mode === 'jsonl' ? 'JSONL 模式无窗口信息' : '无数据';
    }

    // 模型/会话卡
    $('v-model').textContent = d.model.id || '未知模型';
    $('n-session').textContent = d.sessionTitle ? d.sessionTitle.slice(0, 24) + (d.sessionTitle.length > 24 ? '…' : '') : d.sessionId ? '会话 ' + d.sessionId.slice(0, 8) + '…' : '—';

    // 账户余额卡
    const bal = state.balance;
    if (bal && bal.yuan != null) {
      $('v-balance').textContent = '¥' + bal.yuan.toFixed(2);
      $('n-balance').textContent = bal.daysRemaining != null ? '约 ' + bal.daysRemaining.toFixed(1) + ' 天可用（按今日消耗速率）' : '今日暂无消耗，无法预估';
    } else if (bal && bal.error) {
      $('v-balance').textContent = '—';
      $('n-balance').textContent = bal.error;
    } else {
      $('v-balance').textContent = '—';
      $('n-balance').textContent = '未启用（点击右上角「余额监测」按钮开启）';
    }

    // 今日会话列表（点击钉选切换监控）
    const listEl = $('session-list');
    const sess = state.sessions || [];
    if (sess.length) {
      listEl.innerHTML = sess
        .map((s) => {
          const pinned = state.pinnedPath === s.path;
          const active = d.transcriptPath === s.path;
          const t = new Date(s.lastActivityMs).toLocaleTimeString('zh-CN');
          return (
            '<div class="s-row' + (pinned ? ' pinned' : '') + (active ? ' active' : '') + '" data-path="' + escapeHtml(s.path) + '">' +
            '<span class="s-title">' + (pinned ? '📌 ' : '') + escapeHtml(s.title) + '</span>' +
            '<span class="s-meta">¥' + s.yuanToday.toFixed(4) + ' · ' + t + '</span>' +
            '</div>'
          );
        })
        .join('');
    } else {
      listEl.innerHTML = '<div class="note">今日暂无会话活动</div>';
    }

    // 会话详情表（标题行可自定义改名）
    const cur = d.context.current;
    const rows = [
      ['会话 ID', d.sessionId || '—'],
      ['数据源', state.mode === 'bridge' ? 'statusline 桥接' : state.mode === 'jsonl' ? 'JSONL 兜底' : '—'],
      ['最近响应', cur ? 'in ' + cur.inputTokens + ' · cache读 ' + cur.cacheReadTokens + ' · cache写 ' + cur.cacheCreationTokens + ' · out ' + cur.outputTokens : '—'],
      ['模型', d.model.id || '—'],
      ['更新于', new Date(d.updatedAt).toLocaleTimeString('zh-CN')],
      ['transcript', d.transcriptPath || '—'],
    ];
    if (!editingTitle) {
      const titleRow =
        '<tr><td>标题</td><td><span id="t-title"></span>' +
        '<span id="title-edit" class="hidden"><input type="text" id="i-title" maxlength="60">' +
        '<button id="b-save-title" class="btn-ghost" type="button">保存</button>' +
        '<button id="b-cancel-title" class="btn-ghost" type="button">取消</button></span>' +
        '<button id="b-edit-title" class="btn-ghost" type="button">✎ 改名</button></td></tr>';
      $('t-session').innerHTML =
        titleRow + rows.map((r) => '<tr><td>' + r[0] + '</td><td>' + escapeHtml(String(r[1])) + '</td></tr>').join('');
      $('t-title').textContent = d.sessionTitle || '—';
    }

    // 页脚
    $('foot').textContent =
      '数据源: ' +
      (state.mode === 'bridge' ? 'statusline 桥接（每 5s）' : state.mode === 'jsonl' ? 'JSONL 兜底（每 2s）' : '无') +
      (state.stale ? ' · 桥接不可用，已自动切换 JSONL 兜底' : '') +
      (state.sessionChurn ? ' · ⚠ 检测到多会话并发，仅显示最近会话' : '') +
      (d.lastError ? ' · ⚠ ' + d.lastError : '') +
      ' · 命中率口径 = cache读/(cache读+未命中输入)';

    drawCharts();
  }

  function renderEmpty() {
    $('v-hit').textContent = '—';
    $('v-cost').textContent = '—';
    $('v-today').textContent = '—';
    $('v-session').textContent = '—';
    $('v-ctx').textContent = '—';
    $('v-model').textContent = '—';
    $('n-session').textContent = '—';
    $('v-balance').textContent = '—';
    $('session-list').innerHTML = '<div class="note">暂无数据</div>';
    $('t-session').innerHTML = '<tr><td>状态</td><td>未检测到桥接数据</td></tr>';
    $('foot').textContent = '请先运行 install:scripts 并在 ~/.claude/settings.json 配置 statusLine，然后在新会话中测试。';
    drawCharts();
  }

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ---------- 图表 ---------- */
  const warnColor = () => cssVar('--color-warn-soft') || 'rgba(201,162,39,0.14)';
  const dangerColor = () => cssVar('--color-danger-soft') || 'rgba(214,95,95,0.16)';
  const accentColor = () => cssVar('--color-accent') || '#2f9e87';

  function drawCharts() {
    if (!window.ccdsCharts) return;
    const pts = history.filter((h) => h.state && h.state.data).map((h) => ({ x: h.t, state: h.state }));
    const warn = Number($('i-warn').value) || 75;
    const critical = Number($('i-critical').value) || 85;

    // 上下文使用率
    const ctxPts = pts
      .filter((p) => p.state.data.context.usedPct != null)
      .map((p) => ({ x: p.x, y: p.state.data.context.usedPct }));
    window.ccdsCharts.drawLine($('c-ctx'), ctxPts, {
      min: 0,
      max: 100,
      color: accentColor(),
      bands: [
        { from: warn, to: 100, color: warnColor() },
        { from: critical, to: 100, color: dangerColor() },
      ],
    });

    // 每轮 token 构成（最近 40 轮）
    const tokPts = pts
      .filter((p) => p.state.data.context.current)
      .slice(-40)
      .map((p) => {
        const c = p.state.data.context.current;
        return { x: p.x, seg: [c.inputTokens, c.cacheReadTokens, c.outputTokens] };
      });
    window.ccdsCharts.drawStackedBars($('c-tok'), tokPts, [
      { color: cssVar('--color-miss') || '#c98a4c' },
      { color: cssVar('--color-hit') || '#4c9ec7' },
      { color: cssVar('--color-out') || '#a678c9' },
    ]);

    // 命中率
    const hitPts = pts
      .filter((p) => p.state.data.stats.cacheHitRate != null)
      .map((p) => ({ x: p.x, y: p.state.data.stats.cacheHitRate * 100 }));
    window.ccdsCharts.drawLine($('c-hit'), hitPts, { min: 0, max: 100, color: accentColor() });

    // 累计费用：从历史重建（与 appendHistory 同口径）
    let acc = 0;
    let lastTT = null;
    const yenPts = [];
    for (const p of pts) {
      const s = p.state.data.stats;
      if (s.costSessionYuan != null) acc = s.costSessionYuan;
      else if (s.tokensInTurn != null && s.tokensInTurn !== lastTT && s.costTurnYuan != null) {
        lastTT = s.tokensInTurn;
        acc += s.costTurnYuan;
      }
      yenPts.push({ x: p.x, y: acc });
    }
    window.ccdsCharts.drawLine($('c-yen'), yenPts, { min: 0, max: Math.max(acc, 0.01), color: accentColor(), area: true, areaColor: cssVar('--color-accent-soft') || 'rgba(47,158,135,0.14)' });
  }

  /* ---------- 阈值表单 ---------- */
  function validateThresholds() {
    const warn = Number($('i-warn').value);
    const critical = Number($('i-critical').value);
    const ok = Number.isFinite(warn) && Number.isFinite(critical) && warn >= 1 && critical > warn && critical <= 100;
    $('i-warn').classList.toggle('invalid', !ok);
    $('i-critical').classList.toggle('invalid', !ok);
    return ok ? { warn, critical } : null;
  }

  $('b-save').addEventListener('click', () => {
    const v = validateThresholds();
    const msg = $('save-msg');
    if (!v) {
      msg.textContent = '无效：需 1 ≤ 黄 < 红 ≤ 100';
      msg.className = 'note err';
      return;
    }
    vscode.postMessage({ type: 'setThreshold', warn: v.warn, critical: v.critical });
    msg.textContent = '已保存 ✓';
    msg.className = 'note ok';
    setTimeout(() => {
      msg.textContent = '';
      msg.className = 'note';
    }, 3000);
    drawCharts(); // 阈值带即时重绘
  });
  $('i-warn').addEventListener('input', () => {
    $('save-msg').textContent = '';
    $('save-msg').className = 'note';
    drawCharts();
  });
  $('i-critical').addEventListener('input', () => {
    $('save-msg').textContent = '';
    $('save-msg').className = 'note';
    drawCharts();
  });

  /* ---------- 今日会话列表：点击钉选 / 跟随最新（委托，避免重渲染丢监听） ---------- */
  $('session-list').addEventListener('click', (e) => {
    const row = e.target.closest('.s-row');
    if (row && row.dataset.path) vscode.postMessage({ type: 'pinSession', path: row.dataset.path });
  });
  $('b-unpin').addEventListener('click', () => {
    vscode.postMessage({ type: 'unpinSession' });
  });

  /* ---------- 会话标题自定义（改名/保存/取消，委托到表格容器，避免每次重渲染丢监听） ---------- */
  let editingTitle = false;
  $('t-session').addEventListener('click', (e) => {
    const id = e.target && e.target.id;
    if (id === 'b-edit-title') {
      editingTitle = true;
      const current = $('t-title').textContent;
      $('i-title').value = current === '—' ? '' : current;
      $('title-edit').classList.remove('hidden');
      $('b-edit-title').classList.add('hidden');
    } else if (id === 'b-save-title') {
      const sid = (latest && latest.data && latest.data.sessionId) || '';
      vscode.postMessage({ type: 'setTitle', sessionId: sid, title: $('i-title').value.trim() });
    } else if (id === 'b-cancel-title') {
      editingTitle = false;
      $('title-edit').classList.add('hidden');
      $('b-edit-title').classList.remove('hidden');
    }
  });

  /* ---------- 余额监测开关（仪表盘头部按钮） ---------- */
  let balanceOn = false;
  function updateBalanceBtn() {
    $('b-balance').textContent = balanceOn ? '余额监测：开' : '余额监测：关';
  }
  $('b-balance').addEventListener('click', () => {
    balanceOn = !balanceOn;
    updateBalanceBtn();
    vscode.postMessage({ type: 'toggleBalance' });
  });

  /* ---------- 手动刷新（按钮即时反馈，消除延迟手感） ---------- */
  function restoreRefreshBtn() {
    const btn = $('b-refresh');
    btn.textContent = '⟳ 立即刷新';
    btn.disabled = false;
  }
  $('b-refresh').addEventListener('click', () => {
    vscode.postMessage({ type: 'refresh' });
    const btn = $('b-refresh');
    btn.textContent = '⟳ 刷新中…';
    btn.disabled = true;
    $('foot').textContent += ' · 正在重新定位活跃会话…';
  });

  /* ---------- 消息协议 ---------- */
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'config': {
        if (msg.warn != null) $('i-warn').value = msg.warn;
        if (msg.critical != null) $('i-critical').value = msg.critical;
        if (msg.balanceEnabled != null) {
          balanceOn = !!msg.balanceEnabled;
          updateBalanceBtn();
        }
        break;
      }
      case 'history': {
        history = Array.isArray(msg.history) ? msg.history.slice(-300) : [];
        lastKey = '';
        lastTokensInTurn = null;
        cumYen = 0;
        for (const h of history) appendHistory(h.state);
        if (latest) render(latest);
        break;
      }
      case 'update': {
        restoreRefreshBtn(); // 数据回流即恢复按钮 = 肉眼可见的"已刷新"
        render(msg.state);
        break;
      }
      default:
        break;
    }
  });

  // 图表自适应：面板尺寸变化时重绘
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(drawCharts, 150);
  });

  // 就绪握手 → 扩展回放 history + config + 当前状态
  vscode.postMessage({ type: 'ready' });
})();
