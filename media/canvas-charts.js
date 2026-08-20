/**
 * canvas-charts.js — 手绘 canvas 图表（零依赖、零 CDN，webview 专用）。
 * 主题色从 dashboard.css 的 CSS 变量实时读取，深/浅主题自动适配。
 */
(function () {
  'use strict';

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback || '#888';
  }

  /** 高分屏适配 + 清屏，返回 {ctx, w, h}（CSS 像素） */
  function prepare(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    return { ctx, w: rect.width, h: rect.height };
  }

  function axis(ctx, w, h, padL, padB, maxVal, minVal) {
    ctx.strokeStyle = cssVar('--color-rule');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, h - padB);
    ctx.lineTo(w - 8, h - padB);
    ctx.stroke();
    const ticks = 4;
    ctx.fillStyle = cssVar('--color-ink-2');
    ctx.font = '10px ' + cssVar('--font-num', 'monospace');
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= ticks; i++) {
      const v = minVal + ((maxVal - minVal) * i) / ticks;
      const y = h - padB - ((h - padB - 8) * i) / ticks;
      ctx.fillText(String(Math.round(v)), padL - 6, y);
    }
    return { x0: padL, y0: h - padB, plotH: h - padB - 8 };
  }

  function band(ctx, x0, x1, yFrom, yTo, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x0, yTo, x1 - x0, yFrom - yTo);
  }

  /** 折线图：points=[{x,y}]（已按 x 升序）；opts={min,max,bands:[{from,to,color}],color,area} */
  function drawLine(canvas, points, opts) {
    const p = prepare(canvas);
    if (!p) return;
    const { ctx, w, h } = p;
    const min = opts.min ?? 0;
    const max = opts.max ?? 100;
    const padL = 34;
    const padB = 18;
    const { x0, y0, plotH } = axis(ctx, w, h, padL, padB, max, min);
    if (!points.length) return;
    const t0 = points[0].x;
    const t1 = points[points.length - 1].x;
    const X = (x) => x0 + (t1 === t0 ? 0 : ((x - t0) / (t1 - t0)) * (w - 8 - x0));
    const Y = (v) => y0 - ((v - min) / (max - min)) * plotH;

    // 阈值带（先画，线压在上面）
    for (const b of opts.bands || []) {
      const from = Math.max(min, Math.min(max, b.from));
      const to = Math.max(min, Math.min(max, b.to));
      band(ctx, x0, w - 8, Y(from), Y(to), b.color);
    }

    ctx.beginPath();
    points.forEach((pt, i) => {
      const x = X(pt.x);
      const y = Math.max(4, Math.min(y0, Y(pt.y)));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = opts.color || cssVar('--color-accent');
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.stroke();

    if (opts.area) {
      ctx.lineTo(X(t1), y0);
      ctx.lineTo(x0, y0);
      ctx.closePath();
      ctx.fillStyle = opts.areaColor || cssVar('--color-accent-soft');
      ctx.fill();
    }
  }

  /** 堆叠柱：points=[{x, seg:[v1,v2,v3]}]，series=[{color}] */
  function drawStackedBars(canvas, points, series) {
    const p = prepare(canvas);
    if (!p) return;
    const { ctx, w, h } = p;
    const padL = 34;
    const padB = 18;
    let maxSum = 1;
    for (const pt of points) {
      const s = pt.seg.reduce((a, b) => a + b, 0);
      if (s > maxSum) maxSum = s;
    }
    const { x0, y0, plotH } = axis(ctx, w, h, padL, padB, maxSum, 0);
    if (!points.length) return;
    const n = points.length;
    const slot = (w - 8 - x0) / Math.max(n, 1);
    const bw = Math.max(2, Math.min(28, slot * 0.7));
    points.forEach((pt, i) => {
      const cx = x0 + slot * i + slot / 2;
      let acc = 0;
      pt.seg.forEach((v, si) => {
        if (v <= 0) return;
        const yTop = y0 - ((acc + v) / maxSum) * plotH;
        const yBot = y0 - (acc / maxSum) * plotH;
        ctx.fillStyle = (series[si] && series[si].color) || '#888';
        ctx.fillRect(cx - bw / 2, yTop, bw, yBot - yTop);
        acc += v;
      });
    });
  }

  window.ccdsCharts = { drawLine, drawStackedBars };
})();
