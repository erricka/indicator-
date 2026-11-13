/**
 * Clarity SMC — signal engine.
 *
 * Pure functions only (no DOM), shared by the browser and the Node tests.
 * Every event is computed bar-by-bar using only data available at the close
 * of that bar, so signals never repaint once a bar has closed.
 *
 * Concepts
 *  - Swing highs/lows: pivots with `swingLength` bars on each side
 *    (confirmed `swingLength` bars after the pivot).
 *  - BSL / SSL: buy-side liquidity rests above swing highs, sell-side below swing lows.
 *  - LS (liquidity sweep): wick through a liquidity level and close back inside.
 *  - BOS: close beyond the last swing point in the direction of the trend.
 *  - MSS: close beyond the last swing point against the trend (trend flips).
 *  - OB: origin candle of the leg that produced a BOS/MSS.
 *  - FVG: three-candle imbalance (gap between candle 1 and candle 3).
 *  - HV: volume >= `hvMult` x the average of the previous `volLength` bars.
 */

export const DEFAULTS = Object.freeze({
  swingLength: 5,
  atrLength: 14,
  volLength: 20,
  hvMult: 2.0,
  lvMult: 0.6,
  emaLength: 50,
  fvgMinAtr: 0.2,
  setupFvgMinAtr: 0.35,
  liqMaxAge: 500,
  fvgMaxAge: 300,
  obMaxAge: 500,
  maxTracked: 12,
  minSweepAge: 10,
  setupCooldown: 10,
  mssFvgWindow: 3,
  sweepMssWindow: 20,
  obRetestMaxBars: 80,
  recentSweepBars: 30,
  recentStructureBars: 60,
  recentSetupBars: 20,
  combos: Object.freeze({ sweepHv: true, mssFvg: true, bosOb: true, sweepMssHv: true }),
});

export const COMBOS = Object.freeze([
  { id: 'sweepHv', label: 'Liquidity Sweep + High Volume', short: 'LS + HV' },
  { id: 'mssFvg', label: 'MSS + Fair Value Gap', short: 'MSS + FVG' },
  { id: 'bosOb', label: 'BOS + Order Block retest', short: 'BOS + OB' },
  { id: 'sweepMssHv', label: 'Liquidity Sweep + MSS + Volume Spike', short: 'LS + MSS + HV' },
]);

const REASON_ORDER = ['LS', 'MSS', 'BOS', 'OB', 'FVG', 'HV'];

export function mergeOptions(options = {}) {
  const o = { ...DEFAULTS, ...options };
  o.combos = { ...DEFAULTS.combos, ...(options.combos || {}) };
  o.swingLength = clampInt(o.swingLength, 2, 30);
  o.volLength = clampInt(o.volLength, 5, 200);
  o.atrLength = clampInt(o.atrLength, 2, 200);
  o.emaLength = clampInt(o.emaLength, 2, 400);
  return o;
}

function clampInt(v, lo, hi) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function isPivotHigh(H, p, len) {
  const v = H[p];
  for (let k = 1; k <= len; k++) {
    if (H[p - k] >= v || H[p + k] > v) return false;
  }
  return true;
}

function isPivotLow(L, p, len) {
  const v = L[p];
  for (let k = 1; k <= len; k++) {
    if (L[p - k] <= v || L[p + k] < v) return false;
  }
  return true;
}

/**
 * @param {{time:number, open:number, high:number, low:number, close:number, volume?:number}[]} bars
 * @param {object} [options]
 */
export function analyze(bars, options = {}) {
  const o = mergeOptions(options);
  const n = bars.length;
  const O = new Float64Array(n);
  const H = new Float64Array(n);
  const L = new Float64Array(n);
  const C = new Float64Array(n);
  const V = new Float64Array(n);
  let volBars = 0;
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    O[i] = b.open; H[i] = b.high; L[i] = b.low; C[i] = b.close;
    V[i] = Number.isFinite(b.volume) ? b.volume : 0;
    if (V[i] > 0) volBars++;
  }
  const hasVolume = n > 0 && volBars >= n * 0.5;

  // --- Indicators (all causal) ---
  const atr = new Float64Array(n);
  const ema = new Float64Array(n);
  const volAvg = new Float64Array(n).fill(NaN);
  const volRatio = new Float64Array(n).fill(NaN);
  const k = 2 / (o.emaLength + 1);
  let trSum = 0;
  let volSum = 0;
  for (let i = 0; i < n; i++) {
    const tr = i === 0 ? H[i] - L[i]
      : Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1]));
    if (i < o.atrLength) {
      trSum += tr;
      atr[i] = trSum / (i + 1);
    } else {
      atr[i] = (atr[i - 1] * (o.atrLength - 1) + tr) / o.atrLength;
    }
    ema[i] = i === 0 ? C[i] : C[i] * k + ema[i - 1] * (1 - k);
    // Average of the *previous* volLength bars so a spike does not inflate its own baseline.
    if (i >= o.volLength) {
      volAvg[i] = volSum / o.volLength;
      volSum -= V[i - o.volLength];
    }
    volSum += V[i];
    if (hasVolume && volAvg[i] > 0) volRatio[i] = V[i] / volAvg[i];
  }
  const isHV = (i) => hasVolume && i >= 0 && i < n && volRatio[i] >= o.hvMult;
  const anyHV = (from, to) => {
    for (let j = Math.max(0, from); j <= to; j++) if (isHV(j)) return true;
    return false;
  };

  const swings = [];
  const liquidity = [];
  const activeLiq = { 1: [], [-1]: [] }; // 1: BSL (above highs), -1: SSL (below lows)
  const structure = [];
  const sweeps = [];
  const fvgs = [];
  const activeFvg = [];
  const obs = [];
  const activeOb = [];
  const hv = [];
  const setups = [];

  let trend = 0;
  let swingHigh = null;
  let swingLow = null;
  const lastSweep = { 1: null, [-1]: null };
  const lastMss = { 1: null, [-1]: null };
  const lastSetup = { 1: null, [-1]: null };
  const lastFvgIdx = { 1: -Infinity, [-1]: -Infinity }; // last FVG large enough to confirm displacement
  const len = o.swingLength;

  const createOb = (dir, fromIdx, breakIdx, origin) => {
    // Origin of the impulse leg: extreme candle between the broken swing and the break.
    let m = -1;
    for (let j = fromIdx + 1; j <= breakIdx; j++) {
      if (m < 0 || (dir > 0 ? L[j] <= L[m] : H[j] >= H[m])) m = j;
    }
    if (m < 0) return;
    // Prefer the last opposite-colour candle at (or just before) the extreme.
    let ob = m;
    for (let j = m; j >= Math.max(fromIdx + 1, m - 2); j--) {
      if (dir > 0 ? C[j] < O[j] : C[j] > O[j]) { ob = j; break; }
    }
    let top;
    let bottom;
    if (dir > 0) {
      top = H[ob];
      bottom = Math.min(L[ob], L[m]);
      if (top - bottom > 2.5 * atr[breakIdx]) top = Math.max(O[ob], C[ob]);
    } else {
      bottom = L[ob];
      top = Math.max(H[ob], H[m]);
      if (top - bottom > 2.5 * atr[breakIdx]) bottom = Math.min(O[ob], C[ob]);
    }
    // A block taller than 3 ATR is not a precise zone — skip it rather than paint half the chart.
    if (!(top > bottom) || top - bottom > 3 * atr[breakIdx]) return;
    // Replace an overlapping older block on the same side to avoid stacked boxes.
    for (let j = activeOb.length - 1; j >= 0; j--) {
      const z = activeOb[j];
      if (z.dir === dir && z.bottom <= top && z.top >= bottom) {
        z.endIdx = breakIdx;
        z.outcome = 'replaced';
        activeOb.splice(j, 1);
      }
    }
    const zone = { dir, idx: ob, createdIdx: breakIdx, top, bottom, origin, endIdx: null, outcome: null, tappedIdx: null, retestDone: false };
    obs.push(zone);
    activeOb.push(zone);
    if (activeOb.length > o.maxTracked * 2) {
      const old = activeOb.shift();
      old.endIdx = breakIdx;
      old.outcome = 'expired';
    }
  };

  for (let i = 0; i < n; i++) {
    const obRetest = { 1: false, [-1]: false };

    // 1) Order block mitigation (zones created on earlier bars).
    for (let j = activeOb.length - 1; j >= 0; j--) {
      const z = activeOb[j];
      if (i <= z.createdIdx) continue;
      if (i - z.createdIdx > o.obMaxAge) {
        z.endIdx = i; z.outcome = 'expired'; activeOb.splice(j, 1); continue;
      }
      const invalid = z.dir > 0 ? C[i] < z.bottom : C[i] > z.top;
      if (invalid) {
        z.endIdx = i; z.outcome = 'invalidated'; activeOb.splice(j, 1); continue;
      }
      const touched = z.dir > 0 ? L[i] <= z.top : H[i] >= z.bottom;
      if (touched && z.tappedIdx === null) z.tappedIdx = i;
      // Retest confirmation: within 2 bars of the first tap a candle closes in the block's
      // direction while the block holds (a rejection), in a trend that has not flipped.
      if (z.tappedIdx !== null && !z.retestDone && i - z.tappedIdx <= 2) {
        const held = z.dir > 0 ? C[i] > O[i] && C[i] > z.bottom : C[i] < O[i] && C[i] < z.top;
        if (held) {
          z.retestDone = true;
          if (z.origin === 'BOS' && trend === z.dir && z.tappedIdx - z.createdIdx >= 2
              && z.tappedIdx - z.createdIdx <= o.obRetestMaxBars) {
            obRetest[z.dir] = true;
          }
        }
      }
    }

    // 2) FVG mitigation — gaps shrink as they are filled and disappear once closed.
    for (let j = activeFvg.length - 1; j >= 0; j--) {
      const f = activeFvg[j];
      if (i <= f.createdIdx) continue;
      if (i - f.createdIdx > o.fvgMaxAge) {
        f.endIdx = i; f.outcome = 'expired'; activeFvg.splice(j, 1); continue;
      }
      if (f.dir > 0) {
        if (L[i] <= f.bottom) { f.endIdx = i; f.outcome = 'filled'; activeFvg.splice(j, 1); }
        else if (L[i] < f.top) f.top = L[i];
      } else if (H[i] >= f.top) { f.endIdx = i; f.outcome = 'filled'; activeFvg.splice(j, 1); }
      else if (H[i] > f.bottom) f.bottom = H[i];
    }

    // 3) Liquidity: sweep (wick through, close back inside) or break (close through).
    for (const dir of [1, -1]) {
      const list = activeLiq[dir];
      let swept = null;
      for (let j = list.length - 1; j >= 0; j--) {
        const lv = list[j];
        if (i - lv.idx > o.liqMaxAge) {
          lv.endIdx = i; lv.outcome = 'expired'; list.splice(j, 1); continue;
        }
        const pierced = dir > 0 ? H[i] > lv.price : L[i] < lv.price;
        if (!pierced) continue;
        const closedBack = dir > 0 ? C[i] < lv.price : C[i] > lv.price;
        lv.endIdx = i;
        lv.outcome = closedBack ? 'sweep' : 'break';
        list.splice(j, 1);
        if (closedBack && (!swept || (dir > 0 ? lv.price > swept.price : lv.price < swept.price))) swept = lv;
      }
      // Only liquidity that has rested for a while counts as a meaningful sweep.
      if (swept && i - swept.idx < o.minSweepAge) { swept.outcome = 'minor'; swept = null; }
      if (swept) {
        // Sweeping buy-side liquidity is bearish, sweeping sell-side is bullish.
        const ev = {
          dir: -dir, idx: i, price: swept.price, levelIdx: swept.idx,
          side: dir > 0 ? 'BSL' : 'SSL', hv: anyHV(i - 1, i), usedHv: false, usedMss: false,
        };
        sweeps.push(ev);
        lastSweep[-dir] = ev;
      }
    }

    // 4) Market structure (close-based) + order block creation.
    let mssDir = 0;
    if (swingHigh && !swingHigh.broken && C[i] > swingHigh.price) {
      const kind = trend === -1 ? 'MSS' : 'BOS';
      swingHigh.broken = true;
      const ev = { kind, dir: 1, fromIdx: swingHigh.idx, idx: i, price: swingHigh.price };
      structure.push(ev);
      trend = 1;
      createOb(1, swingHigh.idx, i, kind);
      if (kind === 'MSS') { lastMss[1] = { ...ev, usedFvg: false }; mssDir = 1; }
    }
    if (swingLow && !swingLow.broken && C[i] < swingLow.price) {
      const kind = trend === 1 ? 'MSS' : 'BOS';
      swingLow.broken = true;
      const ev = { kind, dir: -1, fromIdx: swingLow.idx, idx: i, price: swingLow.price };
      structure.push(ev);
      trend = -1;
      createOb(-1, swingLow.idx, i, kind);
      if (kind === 'MSS') { lastMss[-1] = { ...ev, usedFvg: false }; mssDir = -1; }
    }

    // 5) Swing confirmation (pivot `len` bars ago) -> new liquidity levels.
    const p = i - len;
    if (p >= len) {
      if (isPivotHigh(H, p, len)) {
        swingHigh = { idx: p, price: H[p], broken: false };
        swings.push({ type: 'high', idx: p, price: H[p], confirmedIdx: i });
        const lv = { side: 'BSL', dir: 1, idx: p, price: H[p], createdIdx: i, endIdx: null, outcome: null };
        liquidity.push(lv);
        activeLiq[1].push(lv);
        if (activeLiq[1].length > o.maxTracked) {
          const old = activeLiq[1].shift(); old.endIdx = i; old.outcome = 'expired';
        }
      }
      if (isPivotLow(L, p, len)) {
        swingLow = { idx: p, price: L[p], broken: false };
        swings.push({ type: 'low', idx: p, price: L[p], confirmedIdx: i });
        const lv = { side: 'SSL', dir: -1, idx: p, price: L[p], createdIdx: i, endIdx: null, outcome: null };
        liquidity.push(lv);
        activeLiq[-1].push(lv);
        if (activeLiq[-1].length > o.maxTracked) {
          const old = activeLiq[-1].shift(); old.endIdx = i; old.outcome = 'expired';
        }
      }
    }

    // 6) Fair value gaps (candles i-2, i-1, i).
    if (i >= 2 && atr[i] > 0) {
      const minGap = o.fvgMinAtr * atr[i];
      if (L[i] > H[i - 2] && L[i] - H[i - 2] >= minGap && C[i - 1] > O[i - 1]) addFvg(1, H[i - 2], L[i], i);
      if (H[i] < L[i - 2] && L[i - 2] - H[i] >= minGap && C[i - 1] < O[i - 1]) addFvg(-1, H[i], L[i - 2], i);
    }

    // 7) High volume.
    if (isHV(i)) hv.push({ idx: i, ratio: volRatio[i] });

    // 8) Confluence setups — only when the selected confirmations line up.
    for (const dir of [1, -1]) {
      const reasons = new Set();
      const combos = [];
      const s = lastSweep[dir];
      const m = lastMss[dir];
      if (o.combos.sweepHv && s && !s.usedHv && s.idx === i && s.hv) {
        s.usedHv = true;
        reasons.add('LS').add('HV');
        combos.push('sweepHv');
      }
      if (o.combos.mssFvg && m && !m.usedFvg && i - m.idx <= o.mssFvgWindow
          && lastFvgIdx[dir] >= m.idx - o.mssFvgWindow) {
        m.usedFvg = true;
        reasons.add('MSS').add('FVG');
        combos.push('mssFvg');
      }
      if (o.combos.bosOb && obRetest[dir]) {
        reasons.add('BOS').add('OB');
        combos.push('bosOb');
      }
      if (o.combos.sweepMssHv && mssDir === dir && s && !s.usedMss && s.idx <= i
          && i - s.idx <= o.sweepMssWindow && anyHV(s.idx - 1, i)) {
        s.usedMss = true;
        reasons.add('LS').add('MSS').add('HV');
        combos.push('sweepMssHv');
      }
      if (!reasons.size) continue;
      const prev = lastSetup[dir];
      if (prev && i - prev.idx < o.setupCooldown && reasons.size <= prev.reasons.length) continue;
      const setup = {
        dir, idx: i, price: dir > 0 ? L[i] : H[i],
        reasons: REASON_ORDER.filter((r) => reasons.has(r)), combos, grade: reasons.size,
      };
      setups.push(setup);
      lastSetup[dir] = setup;
    }
  }

  function addFvg(dir, bottom, top, i) {
    if (top - bottom >= o.setupFvgMinAtr * atr[i]) lastFvgIdx[dir] = i;
    // Merge with a touching gap from the same impulse so a strong run draws one zone, not a ladder.
    for (let j = activeFvg.length - 1; j >= 0; j--) {
      const f = activeFvg[j];
      if (f.dir === dir && i - f.createdIdx <= 2 && bottom <= f.top && top >= f.bottom) {
        f.top = Math.max(f.top, top);
        f.bottom = Math.min(f.bottom, bottom);
        f.origTop = Math.max(f.origTop, top);
        f.origBottom = Math.min(f.origBottom, bottom);
        f.createdIdx = i;
        return;
      }
    }
    const f = { dir, startIdx: i - 1, createdIdx: i, top, bottom, origTop: top, origBottom: bottom, endIdx: null, outcome: null };
    fvgs.push(f);
    activeFvg.push(f);
    if (activeFvg.length > o.maxTracked * 2) {
      const old = activeFvg.shift(); old.endIdx = i; old.outcome = 'expired';
    }
  }

  const state = summarize({
    n, C, ema, volRatio, hasVolume, trend, structure, sweeps, setups, o,
  });

  return {
    n, options: o, hasVolume, atr, ema, volRatio,
    swings, liquidity, structure, sweeps, fvgs, obs, hv, setups, state,
    trend,
  };
}

function summarize({ n, C, ema, volRatio, hasVolume, trend, structure, sweeps, setups, o }) {
  if (!n) {
    return {
      trend: 'Neutral', volume: 'N/A', volumeRatio: null, structure: null, sweep: null,
      setup: null, bias: 'Neutral', biasStrength: '', score: 0,
    };
  }
  const last = n - 1;
  const aboveEma = C[last] > ema[last];
  let trendLabel = 'Neutral';
  if (trend === 1 && aboveEma) trendLabel = 'Bullish';
  else if (trend === -1 && !aboveEma) trendLabel = 'Bearish';

  let volume = 'N/A';
  const ratio = Number.isFinite(volRatio[last]) ? volRatio[last] : null;
  if (hasVolume && ratio !== null) {
    volume = ratio >= o.hvMult ? 'High' : ratio <= o.lvMult ? 'Low' : 'Normal';
  }

  const lastStruct = structure.length ? structure[structure.length - 1] : null;
  const structRecent = lastStruct && last - lastStruct.idx <= o.recentStructureBars ? lastStruct : null;
  const lastSw = sweeps.length ? sweeps[sweeps.length - 1] : null;
  const sweepRecent = lastSw && last - lastSw.idx <= o.recentSweepBars ? lastSw : null;
  const lastSu = setups.length ? setups[setups.length - 1] : null;
  const setupRecent = lastSu && last - lastSu.idx <= o.recentSetupBars ? lastSu : null;

  let score = 0;
  if (trendLabel === 'Bullish') score += 2;
  else if (trendLabel === 'Bearish') score -= 2;
  else score += trend; // structure without EMA agreement counts half
  if (structRecent) score += structRecent.dir;
  if (sweepRecent) score += sweepRecent.dir;
  if (setupRecent) score += setupRecent.dir;

  const bias = score >= 2 ? 'Bullish' : score <= -2 ? 'Bearish' : 'Neutral';
  const mag = Math.abs(score);
  const biasStrength = bias === 'Neutral' ? '' : mag >= 4 ? 'Strong' : 'Moderate';

  const ago = (ev) => (ev ? last - ev.idx : null);
  return {
    trend: trendLabel,
    structureTrend: trend,
    aboveEma,
    volume,
    volumeRatio: ratio,
    structure: structRecent ? { kind: structRecent.kind, dir: structRecent.dir, barsAgo: ago(structRecent) } : null,
    sweep: sweepRecent ? { dir: sweepRecent.dir, side: sweepRecent.side, barsAgo: ago(sweepRecent) } : null,
    setup: setupRecent ? { dir: setupRecent.dir, reasons: setupRecent.reasons, barsAgo: ago(setupRecent) } : null,
    bias,
    biasStrength,
    score,
  };
}

/**
 * Choose what to draw so the chart stays readable: only live zones nearest to
 * price, the most recent structure/sweeps/setups, and nothing that has expired.
 */
export function selectDrawings(result, bars, limits = {}) {
  const lim = {
    maxZones: 2, maxLiquidity: 2, maxStructure: 6, maxSweeps: 5, maxSetups: 6, recentSweptBars: 40,
    ...limits,
  };
  const n = result.n;
  if (!n) return { fvgs: [], obs: [], liquidity: [], structure: [], sweeps: [], setups: [], hv: [] };
  const last = n - 1;
  const price = bars[last].close;
  const dist = (z) => (price > z.top ? price - z.top : price < z.bottom ? z.bottom - price : 0);
  const nearest = (items, count) => {
    const out = [];
    for (const dir of [1, -1]) {
      out.push(...items.filter((z) => z.dir === dir).sort((a, b) => dist(a) - dist(b)).slice(0, count));
    }
    return out;
  };

  const fvgs = nearest(result.fvgs.filter((f) => f.endIdx === null), lim.maxZones);
  const obs = nearest(result.obs.filter((z) => z.endIdx === null), lim.maxZones);

  // Liquidity: nearest live levels per side; levels within 0.25 ATR are one pool (equal highs/lows).
  const tol = 0.25 * (result.atr[last] || 0);
  const liquidity = [];
  for (const dir of [1, -1]) {
    const pools = [];
    const active = result.liquidity
      .filter((lv) => lv.dir === dir && lv.endIdx === null)
      .sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price));
    for (const lv of active) {
      const pool = pools.find((p) => Math.abs(p.price - lv.price) <= tol);
      if (pool) {
        pool.count += 1;
        if (dir > 0 ? lv.price > pool.price : lv.price < pool.price) Object.assign(pool, { price: lv.price });
        pool.idx = Math.min(pool.idx, lv.idx);
      } else if (pools.length < lim.maxLiquidity) {
        pools.push({ ...lv, count: 1 });
      }
    }
    const swept = result.liquidity
      .filter((lv) => lv.dir === dir && lv.outcome === 'sweep' && last - lv.endIdx <= lim.recentSweptBars)
      .slice(-2);
    liquidity.push(...pools, ...swept);
  }

  return {
    fvgs,
    obs,
    liquidity,
    structure: result.structure.slice(-lim.maxStructure),
    sweeps: result.sweeps.slice(-lim.maxSweeps),
    setups: result.setups.slice(-lim.maxSetups),
    hv: result.hv,
  };
}

/** Events that happened on a given bar, used by the hover legend. */
export function eventsAt(result, idx) {
  const out = [];
  for (const s of result.setups) if (s.idx === idx) out.push({ type: s.dir > 0 ? 'BUY SETUP' : 'SELL SETUP', dir: s.dir });
  for (const s of result.structure) if (s.idx === idx) out.push({ type: s.kind, dir: s.dir });
  for (const s of result.sweeps) if (s.idx === idx) out.push({ type: 'LS', dir: s.dir });
  for (const z of result.obs) if (z.createdIdx === idx) out.push({ type: 'OB', dir: z.dir });
  for (const f of result.fvgs) if (f.startIdx + 1 === idx) out.push({ type: 'FVG', dir: f.dir });
  for (const h of result.hv) if (h.idx === idx) out.push({ type: 'HV', dir: 0, ratio: h.ratio });
  return out;
}
