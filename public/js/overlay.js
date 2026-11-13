// Canvas overlay for Lightweight Charts (series primitive).
// Zones and lines render beneath the candles; labels render on top with
// collision avoidance so text never stacks on other text.
import { alpha } from './theme.js';

const FONT = 'Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const EXTEND_BARS = 9; // live zones extend this many bars past the last candle

export class SmcOverlay {
  constructor() {
    this.model = null;
    this._chart = null;
    this._series = null;
    this._request = null;
    this._views = [
      new OverlayView(this, 'bottom', 'drawBack'),
      new OverlayView(this, 'top', 'drawFront'),
    ];
  }

  attached({ chart, series, requestUpdate }) {
    this._chart = chart;
    this._series = series;
    this._request = requestUpdate;
  }

  detached() {
    this._chart = null;
    this._series = null;
    this._request = null;
  }

  update(model) {
    this.model = model;
    if (this._request) this._request();
  }

  redraw() {
    if (this._request) this._request();
  }

  updateAllViews() {}

  paneViews() {
    return this._views;
  }

  _frame(mediaSize) {
    const m = this.model;
    if (!m || !m.result || !this._chart || !this._series) return null;
    const ts = this._chart.timeScale();
    const range = ts.getVisibleLogicalRange();
    if (!range) return null;
    const X = (i) => ts.logicalToCoordinate(i);
    const Y = (p) => this._series.priceToCoordinate(p);
    const x0 = X(0);
    const x1 = X(1);
    if (x0 === null || x1 === null) return null;
    const spacing = Math.max(0.5, x1 - x0);
    const lastX = X(m.lastIdx);
    const rightEdge = Math.min(mediaSize.width + 2, lastX + EXTEND_BARS * spacing);
    return {
      m, X, Y, spacing, range, rightEdge, W: mediaSize.width, H: mediaSize.height, t: m.theme,
      visible: (i, pad = 2) => i >= range.from - pad && i <= range.to + pad,
    };
  }

  // ---------- Background layer: zones, lines, bubbles ----------
  drawBack({ context: ctx, mediaSize }) {
    const f = this._frame(mediaSize);
    if (!f) return;
    const { m, X, Y, t, rightEdge, W } = f;
    const { sel, layers } = m;
    ctx.save();
    ctx.lineWidth = 1;

    if (layers.fvg) {
      for (const z of sel.fvgs) {
        const xa = X(z.startIdx);
        const ya = Y(z.top);
        const yb = Y(z.bottom);
        if (xa === null || ya === null || yb === null || xa > W || rightEdge < 0) continue;
        const color = z.dir > 0 ? t.fvgBull : t.fvgBear;
        const top = Math.min(ya, yb);
        const h = Math.max(1, Math.abs(yb - ya));
        ctx.fillStyle = alpha(color, t.fvgFill);
        ctx.fillRect(xa, top, rightEdge - xa, h);
        ctx.fillStyle = alpha(color, 0.32);
        ctx.fillRect(xa, Math.round(top), rightEdge - xa, 1); // thin edges give the zone its colour identity
        ctx.fillRect(xa, Math.round(top + h) - 1, rightEdge - xa, 1);
        ctx.fillStyle = alpha(color, 0.6);
        ctx.fillRect(xa, top, 1.5, h); // origin accent
      }
    }

    if (layers.ob) {
      for (const z of sel.obs) {
        const xa = X(z.idx);
        const ya = Y(z.top);
        const yb = Y(z.bottom);
        if (xa === null || ya === null || yb === null || xa > W || rightEdge < 0) continue;
        const top = Math.min(ya, yb);
        const h = Math.max(1, Math.abs(yb - ya));
        ctx.fillStyle = alpha(t.ob, z.tappedIdx === null ? t.obFill : t.obFillTapped);
        ctx.fillRect(xa, top, rightEdge - xa, h);
        ctx.strokeStyle = alpha(t.ob, z.tappedIdx === null ? 0.6 : 0.35);
        ctx.strokeRect(Math.round(xa) + 0.5, Math.round(top) + 0.5, Math.round(rightEdge - xa), Math.round(h));
      }
    }

    if (layers.liquidity) {
      for (const lv of sel.liquidity) {
        const xa = X(lv.idx);
        const y = Y(lv.price);
        if (xa === null || y === null) continue;
        const active = lv.endIdx === null;
        const xb = active ? rightEdge : X(lv.endIdx);
        if (xb === null || xa > W || xb < 0) continue;
        const yy = Math.round(y) + 0.5;
        ctx.strokeStyle = alpha(t.liq, active ? 0.85 : 0.45);
        ctx.setLineDash(active ? [] : [2, 3]);
        ctx.beginPath();
        ctx.moveTo(xa, yy);
        ctx.lineTo(xb, yy);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = alpha(t.liq, active ? 0.9 : 0.5);
        ctx.beginPath();
        ctx.arc(xa, yy, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (layers.structure) {
      ctx.setLineDash([4, 3]);
      for (const s of sel.structure) {
        const xa = X(s.fromIdx);
        const xb = X(s.idx);
        const y = Y(s.price);
        if (xa === null || xb === null || y === null || xa > W || xb < 0) continue;
        const yy = Math.round(y) + 0.5;
        ctx.strokeStyle = alpha(s.dir > 0 ? t.bull : t.bear, s.kind === 'MSS' ? 0.95 : 0.7);
        ctx.lineWidth = s.kind === 'MSS' ? 1.25 : 1;
        ctx.beginPath();
        ctx.moveTo(xa, yy);
        ctx.lineTo(xb, yy);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
    }

    if (layers.bubbles && m.result.hasVolume) this._drawBubbles(ctx, f);

    ctx.restore();
  }

  _drawBubbles(ctx, f) {
    const { m, X, Y, t, spacing, visible } = f;
    const bars = m.bars;
    const hvMult = m.result.options.hvMult;
    const base = Math.min(9, Math.max(2.5, spacing * 0.55));
    const items = [];
    for (const h of m.sel.hv) {
      if (!visible(h.idx)) continue;
      const b = bars[h.idx];
      const x = X(h.idx);
      const y = Y((b.high + b.low + b.close) / 3);
      if (x === null || y === null) continue;
      const r = base * Math.min(2.3, Math.max(1, Math.sqrt(h.ratio / hvMult)));
      items.push({ x, y, r, ratio: h.ratio });
    }
    // Largest first; drop smaller bubbles that would overlap a bigger one.
    items.sort((a, b) => b.ratio - a.ratio);
    const placed = [];
    for (const it of items) {
      if (placed.some((p) => Math.hypot(p.x - it.x, p.y - it.y) < (p.r + it.r) * 0.85)) continue;
      placed.push(it);
    }
    for (const it of placed) {
      ctx.beginPath();
      ctx.arc(it.x, it.y, it.r, 0, Math.PI * 2);
      ctx.fillStyle = alpha(t.hv, t.bubbleFill);
      ctx.fill();
      ctx.strokeStyle = alpha(t.hv, 0.8);
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    m._bubbles = placed;
  }

  // ---------- Foreground layer: markers and labels ----------
  drawFront({ context: ctx, mediaSize }) {
    const f = this._frame(mediaSize);
    if (!f) return;
    const { m, X, Y, t, rightEdge, W, H, spacing, visible } = f;
    const { sel, layers, bars } = m;
    const placer = new LabelPlacer(ctx, W, H);
    for (const r of m.avoid || []) placer.rects.push(r); // keep labels out from under UI cards
    ctx.save();
    ctx.textBaseline = 'middle';

    // 1) Setups — highest priority, always shown when on screen.
    if (layers.setups) {
      const recent = sel.setups.slice(-2);
      for (const s of sel.setups.slice().reverse()) {
        if (!visible(s.idx, 1)) continue;
        s._faded = !recent.includes(s);
        const x = X(s.idx);
        let ext = s.dir > 0 ? Infinity : -Infinity;
        for (let j = Math.max(0, s.idx - 1); j <= Math.min(bars.length - 1, s.idx + 1); j++) {
          ext = s.dir > 0 ? Math.min(ext, bars[j].low) : Math.max(ext, bars[j].high);
        }
        const y = Y(ext);
        if (x === null || y === null) continue;
        this._drawSetup(ctx, placer, t, s, x, y);
      }
    }

    // 2) Market structure.
    if (layers.structure) {
      for (const s of sel.structure.slice().reverse()) {
        const xa = X(s.fromIdx);
        const xb = X(s.idx);
        const y = Y(s.price);
        if (xa === null || xb === null || y === null || xb < 0 || xa > W) continue;
        const color = s.dir > 0 ? t.bull : t.bear;
        const mid = Math.max(14, Math.min(W - 14, (xa + xb) / 2));
        placer.text({
          text: s.kind, x: mid, y: s.dir > 0 ? y - 2 : y + 2, dir: s.dir > 0 ? 'up' : 'down',
          color, bg: t.labelBg, border: s.kind === 'MSS' ? alpha(color, 0.8) : null,
          weight: s.kind === 'MSS' ? 700 : 600, size: 9.5,
        });
      }
    }

    // 3) Liquidity sweeps.
    if (layers.liquidity) {
      const setupLs = new Set(layers.setups
        ? sel.setups.filter((u) => u.reasons.includes('LS')).map((u) => u.idx) : []);
      for (const s of sel.sweeps.slice().reverse()) {
        if (!visible(s.idx, 1)) continue;
        const b = bars[s.idx];
        const x = X(s.idx);
        const yl = Y(s.price);
        const yw = Y(s.dir < 0 ? b.high : b.low);
        if (x === null || yl === null || yw === null) continue;
        // Cross where the level was taken.
        ctx.strokeStyle = alpha(t.liq, 0.95);
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.moveTo(x - 3, yl - 3); ctx.lineTo(x + 3, yl + 3);
        ctx.moveTo(x + 3, yl - 3); ctx.lineTo(x - 3, yl + 3);
        ctx.stroke();
        if (setupLs.has(s.idx)) continue; // the setup label already names the sweep
        placer.text({
          text: s.dir > 0 ? 'LS ▲' : 'LS ▼', x, y: s.dir < 0 ? yw - 4 : yw + 4, dir: s.dir < 0 ? 'up' : 'down',
          color: s.dir > 0 ? t.bull : t.bear, bg: t.labelBg, border: alpha(t.liq, 0.7), weight: 700, size: 9.5,
        });
      }
    }

    // 4) Zone and level tags at the live edge.
    const tagX = Math.min(rightEdge, W) - 4;
    if (layers.ob) {
      for (const z of sel.obs) {
        const ya = Y(z.top);
        const yb = Y(z.bottom);
        if (ya === null || yb === null || tagX < 20) continue;
        placer.text({
          text: z.dir > 0 ? 'OB ▲' : 'OB ▼', x: tagX, y: (ya + yb) / 2, dir: 'center', align: 'right',
          color: t.obText, bg: t.labelBg, weight: 700, size: 9, tries: 1,
        });
      }
    }
    if (layers.fvg) {
      for (const z of sel.fvgs) {
        const ya = Y(z.top);
        const yb = Y(z.bottom);
        if (ya === null || yb === null || tagX < 20) continue;
        placer.text({
          text: 'FVG', x: tagX, y: (ya + yb) / 2, dir: 'center', align: 'right',
          color: z.dir > 0 ? t.fvgBullText : t.fvgBearText, bg: t.labelBg, weight: 700, size: 9, tries: 1,
        });
      }
    }
    if (layers.liquidity) {
      for (const lv of sel.liquidity) {
        if (lv.endIdx !== null) continue;
        const y = Y(lv.price);
        if (y === null || tagX < 20) continue;
        placer.text({
          text: lv.side, x: tagX, y: lv.dir > 0 ? y - 1 : y + 1, dir: lv.dir > 0 ? 'up' : 'down', align: 'right',
          color: t.liqText, bg: null, weight: 700, size: 9, tries: 0,
        });
      }
    }

    // 5) High-volume tags only for the strongest, well-spaced spikes.
    if (layers.bubbles && m._bubbles && spacing >= 5) {
      const strong = m.result.options.hvMult * 1.5;
      for (const bub of m._bubbles.filter((b) => b.ratio >= strong).slice(0, 3)) {
        placer.text({
          text: `HV ${bub.ratio.toFixed(1)}×`, x: bub.x, y: bub.y - bub.r - 2, dir: 'up',
          color: t.hv, bg: t.labelBg, weight: 700, size: 8.5, tries: 1,
        });
      }
    }

    ctx.restore();
  }

  _drawSetup(ctx, placer, t, s, x, y) {
    const buy = s.dir > 0;
    const color = buy ? t.bull : t.bear;
    const title = buy ? 'BUY SETUP' : 'SELL SETUP';
    const sub = s.reasons.join(' · ');
    ctx.font = `700 10.5px ${FONT}`;
    const tw = ctx.measureText(title).width;
    ctx.font = `600 9px ${FONT}`;
    const sw = ctx.measureText(sub).width;
    const w = Math.ceil(Math.max(tw, sw) + 16);
    const h = 30;
    const gap = 9;
    ctx.save();
    if (s._faded) ctx.globalAlpha = 0.8;
    const rect = placer.reserve({
      x: x - w / 2, y: buy ? y + gap : y - gap - h, w, h, step: buy ? h + 4 : -(h + 4), tries: 3, force: true,
    });
    if (!rect) { ctx.restore(); return; }
    const ax = x;
    const ay = buy ? y + 2 : y - 2;
    const edgeY = buy ? rect.y : rect.y + rect.h;
    // Leader line from the candle extreme to the label.
    ctx.strokeStyle = alpha(color, 0.9);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(ax, edgeY);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(ax - 3.5, ay + (buy ? 5 : -5));
    ctx.lineTo(ax + 3.5, ay + (buy ? 5 : -5));
    ctx.closePath();
    ctx.fill();
    // Pill with a soft glow so it stands out from everything else.
    // Latest setups are solid with a glow; older ones are outlined so the newest reads first.
    ctx.save();
    if (s._faded) {
      ctx.fillStyle = t.labelBg;
      roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 4);
      ctx.fill();
      ctx.strokeStyle = alpha(color, 0.85);
      ctx.lineWidth = 1;
      roundRect(ctx, rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1, 4);
      ctx.stroke();
    } else {
      ctx.shadowColor = alpha(color, 0.55);
      ctx.shadowBlur = 10;
      ctx.fillStyle = color;
      roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 4);
      ctx.fill();
    }
    ctx.restore();
    ctx.fillStyle = s._faded ? color : t.setupText;
    ctx.textAlign = 'center';
    ctx.font = `700 10.5px ${FONT}`;
    ctx.fillText(title, rect.x + rect.w / 2, rect.y + 10.5);
    ctx.font = `600 9px ${FONT}`;
    ctx.fillStyle = s._faded ? alpha(color, 0.85) : 'rgba(255,255,255,0.88)';
    ctx.fillText(sub, rect.x + rect.w / 2, rect.y + 21.5);
    ctx.restore();
  }
}

class OverlayView {
  constructor(source, z, method) {
    this._source = source;
    this._z = z;
    this._method = method;
  }

  zOrder() {
    return this._z;
  }

  renderer() {
    return {
      draw: (target) => target.useMediaCoordinateSpace((scope) => this._source[this._method](scope)),
    };
  }
}

class LabelPlacer {
  constructor(ctx, W, H) {
    this.ctx = ctx;
    this.W = W;
    this.H = H;
    this.rects = [];
  }

  collides(r) {
    return this.rects.some((o) => r.x < o.x + o.w + 2 && r.x + r.w + 2 > o.x && r.y < o.y + o.h + 1 && r.y + r.h + 1 > o.y);
  }

  reserve({ x, y, w, h, step, tries = 3, force = false }) {
    let last = null;
    for (let k = 0; k <= tries; k++) {
      const r = { x: Math.max(2, Math.min(this.W - w - 2, x)), y: y + k * step, w, h };
      if (r.y + r.h < 0 || r.y > this.H) break;
      last = r;
      if (!this.collides(r)) {
        this.rects.push(r);
        return r;
      }
    }
    if (force && last) {
      this.rects.push(last);
      return last;
    }
    return null;
  }

  text({ text, x, y, dir = 'up', align = 'center', color, bg, border = null, weight = 600, size = 9.5, tries = 3 }) {
    const ctx = this.ctx;
    ctx.font = `${weight} ${size}px ${FONT}`;
    const padX = bg ? 4 : 1;
    const w = Math.ceil(ctx.measureText(text).width + padX * 2);
    const h = Math.ceil(size + 6);
    const left = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    let top;
    let step;
    if (dir === 'up') { top = y - h; step = -(h + 1); }
    else if (dir === 'down') { top = y; step = h + 1; }
    else { top = y - h / 2; step = h + 1; }
    let rect = null;
    if (dir === 'center') {
      // Alternate below/above the anchor, never drifting far from what the tag labels.
      for (let k = 0; k <= tries * 2 && !rect; k++) {
        const off = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * step;
        rect = this.reserve({ x: left, y: top + off, w, h, step: 0, tries: 0 });
      }
    } else {
      rect = this.reserve({ x: left, y: top, w, h, step, tries });
    }
    if (!rect) return null;
    if (bg) {
      ctx.fillStyle = bg;
      roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 3);
      ctx.fill();
      if (border) {
        ctx.strokeStyle = border;
        ctx.lineWidth = 1;
        roundRect(ctx, rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1, 3);
        ctx.stroke();
      }
    }
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, rect.x + rect.w / 2, rect.y + rect.h / 2 + 0.5);
    return rect;
  }
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}
