import { analyze, selectDrawings, eventsAt, DEFAULTS, COMBOS } from './engine.js';
import { SmcOverlay } from './overlay.js';
import { THEMES } from './theme.js';

const LWC = window.LightweightCharts;
const STORE_KEY = 'clarity-smc:v1';
const TIMEFRAMES = ['5m', '15m', '1h', '4h', '1d'];
const TF_LABEL = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1H', '4h': '4H', '1d': '1D' };

const LAYERS = [
  { id: 'bubbles', label: 'Volume Bubbles', swatch: 'sw-dot sw-hv' },
  { id: 'liquidity', label: 'Liquidity (BSL · SSL · LS)', swatch: 'sw-line sw-liq' },
  { id: 'structure', label: 'BOS / MSS', swatch: 'sw-dash' },
  { id: 'ob', label: 'Order Blocks', swatch: 'sw-box sw-ob' },
  { id: 'fvg', label: 'Fair Value Gaps', swatch: 'sw-box sw-fvg-bull' },
  { id: 'dashboard', label: 'Dashboard', swatch: null },
  { id: 'setups', label: 'Buy / Sell Setup Labels', swatch: 'sw-setup-buy' },
];

const DEFAULT_PREFS = {
  symbol: 'BTCUSDT',
  tf: '1h',
  theme: null,
  layers: { bubbles: true, liquidity: true, structure: true, ob: true, fvg: true, dashboard: true, setups: true },
  combos: { ...DEFAULTS.combos },
  swingLength: DEFAULTS.swingLength,
  hvMult: DEFAULTS.hvMult,
  maxZones: 2,
  dashCollapsed: null,
  keyOpen: false,
};

const FALLBACK_CATALOG = [
  { group: 'Crypto', items: [{ symbol: 'BTCUSDT', label: 'BTC/USDT', name: 'Bitcoin' }, { symbol: 'ETHUSDT', label: 'ETH/USDT', name: 'Ethereum' }] },
  { group: 'Stocks', items: [{ symbol: 'AAPL', label: 'AAPL', name: 'Apple' }, { symbol: 'SPY', label: 'SPY', name: 'S&P 500 ETF' }] },
];

// ---------- Preferences ----------
const clone = (o) => JSON.parse(JSON.stringify(o));
function loadPrefs() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch { p = {}; }
  const base = clone(DEFAULT_PREFS);
  const out = {
    ...base, ...p,
    layers: { ...base.layers, ...(p.layers || {}) },
    combos: { ...base.combos, ...(p.combos || {}) },
  };
  const qs = new URLSearchParams(location.search);
  if (qs.get('symbol')) out.symbol = qs.get('symbol').toUpperCase().slice(0, 20);
  if (TIMEFRAMES.includes(qs.get('tf'))) out.tf = qs.get('tf');
  if (!TIMEFRAMES.includes(out.tf)) out.tf = '1h';
  return out;
}
function savePrefs() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(prefs)); } catch { /* storage unavailable */ }
}

const prefs = loadPrefs();
const $ = (id) => document.getElementById(id);
const els = {
  chart: $('chart'), stage: document.querySelector('.stage'), loading: $('loading'), loadingText: $('loadingText'),
  symbolBtn: $('symbolBtn'), symbolLabel: $('symbolLabel'), symbolMenu: $('symbolMenu'), symbolSearch: $('symbolSearch'), symbolList: $('symbolList'),
  tfGroup: $('tfGroup'), layersBtn: $('layersBtn'), layersPanel: $('layersPanel'), themeBtn: $('themeBtn'),
  lgSymbol: $('lgSymbol'), lgTf: $('lgTf'), lgSource: $('lgSource'), lgOhlc: $('lgOhlc'), lgEvents: $('lgEvents'),
  dash: $('dash'), dashToggle: $('dashToggle'), dStrength: $('dStrength'),
  dTrend: $('dTrend'), dVolume: $('dVolume'), dStructure: $('dStructure'), dSweep: $('dSweep'), dBias: $('dBias'),
  key: $('key'), keyToggle: $('keyToggle'), keyBody: $('keyBody'),
  liveDot: $('liveDot'), statusText: $('statusText'), statusUpdated: $('statusUpdated'), toast: $('toast'),
};

const state = {
  bars: [],
  meta: null,
  result: null,
  sel: null,
  closedCount: -1,
  intervalSec: 3600,
  clockOffset: 0,
  loadToken: 0,
  pollTimer: null,
  hoverIdx: null,
  catalog: FALLBACK_CATALOG,
  precision: 2,
  lastUpdate: null,
  stream: null,
  lastTickAt: 0,
  pollSoonTimer: null,
  renderQueued: false,
  okFetch: true,
};

// ---------- Theme ----------
function currentThemeName() {
  if (prefs.theme === 'light' || prefs.theme === 'dark') return prefs.theme;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
let theme = THEMES[currentThemeName()];

// ---------- Chart ----------
const tzOffsetSec = -new Date().getTimezoneOffset() * 60;
let shiftTime = true;
const toChartTime = (t) => (shiftTime ? t + tzOffsetSec : t);

const chart = LWC.createChart(els.chart, {
  autoSize: true,
  layout: {
    background: { type: LWC.ColorType.Solid, color: theme.bg },
    textColor: theme.muted,
    fontFamily: 'Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    fontSize: 11,
    attributionLogo: true,
  },
  grid: { vertLines: { color: theme.grid }, horzLines: { color: theme.grid } },
  crosshair: {
    mode: LWC.CrosshairMode.Normal,
    vertLine: { color: theme.crosshair, width: 1, style: LWC.LineStyle.Dashed, labelBackgroundColor: '#283041' },
    horzLine: { color: theme.crosshair, width: 1, style: LWC.LineStyle.Dashed, labelBackgroundColor: '#283041' },
  },
  rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.17, bottom: 0.18 } },
  timeScale: {
    borderVisible: false, rightOffset: 14, barSpacing: 7, minBarSpacing: 1.5, timeVisible: true, secondsVisible: false,
  },
});

const candles = chart.addSeries(LWC.CandlestickSeries, {
  upColor: theme.up, downColor: theme.down, wickUpColor: theme.up, wickDownColor: theme.down,
  borderVisible: false, priceLineVisible: true, priceLineWidth: 1, priceLineStyle: LWC.LineStyle.Dotted, lastValueVisible: true,
});
const volume = chart.addSeries(LWC.HistogramSeries, {
  priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false,
});
chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.86, bottom: 0 }, visible: false });

const overlay = new SmcOverlay();
candles.attachPrimitive(overlay);

function applyTheme() {
  theme = THEMES[currentThemeName()];
  document.documentElement.dataset.theme = theme.name;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme.bg);
  const lbl = theme.name === 'dark' ? '#283041' : '#475569';
  chart.applyOptions({
    layout: { background: { type: LWC.ColorType.Solid, color: theme.bg }, textColor: theme.muted },
    grid: { vertLines: { color: theme.grid }, horzLines: { color: theme.grid } },
    crosshair: { vertLine: { color: theme.crosshair, labelBackgroundColor: lbl }, horzLine: { color: theme.crosshair, labelBackgroundColor: lbl } },
  });
  candles.applyOptions({ upColor: theme.up, downColor: theme.down, wickUpColor: theme.up, wickDownColor: theme.down });
  els.themeBtn.setAttribute('aria-label', theme.name === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  paintVolume();
  pushOverlay();
}

// ---------- Formatting ----------
let priceFmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const volFmt = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });
const timeFmtIntraday = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const timeFmtDaily = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
const clockFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function setPrecision(bars, meta) {
  const p = bars.length ? bars[bars.length - 1].close : 1;
  let precision;
  if (meta.group === 'Forex') precision = /JPY/.test(meta.symbol) ? 3 : 5;
  else if (p >= 10) precision = 2;
  else if (p >= 1) precision = 4;
  else if (p >= 0.01) precision = 5;
  else precision = 8;
  state.precision = precision;
  priceFmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: precision, maximumFractionDigits: precision });
  candles.applyOptions({ priceFormat: { type: 'price', precision, minMove: 1 / 10 ** precision } });
  chart.applyOptions({ localization: { priceFormatter: (v) => priceFmt.format(v) } });
}

// ---------- Data ----------
async function fetchCandles(symbol, tf) {
  const res = await fetch(`/api/candles?symbol=${encodeURIComponent(symbol)}&tf=${encodeURIComponent(tf)}`, { cache: 'no-store' });
  let json = {};
  try { json = await res.json(); } catch { json = {}; }
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  if (!Array.isArray(json.bars) || !json.bars.length) throw new Error('No data returned');
  return json;
}

const toBar = ([t, o, h, l, c, v]) => ({ time: t, open: o, high: h, low: l, close: c, volume: v });
const toCandle = (b) => ({ time: toChartTime(b.time), open: b.open, high: b.high, low: b.low, close: b.close });

function volumeColor(i) {
  const b = state.bars[i];
  const r = state.result;
  if (prefs.layers.bubbles && r && i < state.closedCount && r.hasVolume && r.volRatio[i] >= r.options.hvMult) return theme.volHv;
  return b.close >= b.open ? theme.volUp : theme.volDown;
}

const noVolume = () => state.result && !state.result.hasVolume;

function paintVolume() {
  if (!state.bars.length) return;
  // Instruments without volume (e.g. forex) would otherwise draw a flat zero line.
  if (noVolume()) { volume.setData([]); return; }
  volume.setData(state.bars.map((b, i) => ({ time: toChartTime(b.time), value: b.volume, color: volumeColor(i) })));
}

async function load() {
  const token = ++state.loadToken;
  clearTimeout(state.pollTimer);
  closeStream();
  showLoading(state.bars.length ? 'overlay' : 'full', 'Loading market data…');
  const slow = setTimeout(() => {
    if (token === state.loadToken) els.loadingText.textContent = 'Waking up the server… free hosting can take up to a minute on the first visit.';
  }, 4000);
  try {
    const data = await fetchCandles(prefs.symbol, prefs.tf);
    if (token !== state.loadToken) return;
    applyData(data, true);
    hideLoading();
    openStream();
    if (data.notice) toast(data.notice, 6000);
  } catch (err) {
    if (token !== state.loadToken) return;
    setStatus('error', `Could not load ${prefs.symbol}: ${err.message}`);
    els.loadingText.textContent = `Could not load ${prefs.symbol}. Retrying…`;
    clearTimeout(slow);
    state.pollTimer = setTimeout(load, 6000);
    return;
  }
  clearTimeout(slow);
  schedulePoll();
}

function applyData(data, reset) {
  const incoming = data.bars.map(toBar);
  state.clockOffset = data.serverTime - Date.now();
  state.intervalSec = data.intervalSec;
  state.lastBarOpen = data.lastBarOpen !== false;
  const sourceChanged = state.meta && state.meta.source !== data.source;
  const { bars: _bars, ...meta } = data;
  if (reset || sourceChanged || !mergeBars(incoming)) {
    state.meta = meta;
    state.bars = incoming;
    state.closedCount = -1;
    shiftTime = data.intervalSec < 86400;
    setPrecision(incoming, data);
    chart.applyOptions({
      localization: { timeFormatter: (t) => formatBarTime(shiftTime ? t - tzOffsetSec : t) },
    });
    chart.timeScale().applyOptions({ timeVisible: shiftTime });
    candles.setData(incoming.map(toCandle));
    recompute(true);
    const n = incoming.length;
    const show = Math.round(Math.min(200, Math.max(60, els.chart.clientWidth / 7)));
    // Leave room on the right so the newest candles sit clear of the dashboard.
    const pad = Math.max(14, Math.round(show * 0.2));
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - show), to: n - 1 + pad });
    renderHeader();
  } else {
    state.meta = meta; // fresh session state and price age
    recompute(false);
  }
  state.lastUpdate = Date.now();
  state.okFetch = true;
  updateStatus();
  updateLegend();
}

function mergeBars(incoming) {
  const cur = state.bars;
  if (!cur.length || !incoming.length) return false;
  const lastT = cur[cur.length - 1].time;
  const start = incoming.findIndex((b) => b.time === lastT);
  if (start < 0) return false;
  const tail = incoming.slice(start);
  cur[cur.length - 1] = mergeLive(cur[cur.length - 1], tail[0]);
  tail[0] = cur[cur.length - 1];
  for (let k = 1; k < tail.length; k++) cur.push(tail[k]);
  for (let k = 0; k < tail.length; k++) {
    const i = cur.length - tail.length + k;
    candles.update(toCandle(tail[k]));
    if (!noVolume()) volume.update({ time: toChartTime(tail[k].time), value: tail[k].volume, color: volumeColor(i) });
  }
  return true;
}

function analysisOptions() {
  return { swingLength: prefs.swingLength, hvMult: prefs.hvMult, combos: prefs.combos };
}

// Signals use closed candles only, so nothing repaints while a candle is still forming.
function recompute(force) {
  const now = Date.now() + state.clockOffset;
  // The server reports whether the newest bar is still trading (exchange session for stocks,
  // time grid for crypto). Between polls, a grid bar also closes once its interval has elapsed.
  let closed = state.bars.length;
  const last = state.bars[closed - 1];
  if (last && state.lastBarOpen && (state.meta?.source === 'yahoo' || (last.time + state.intervalSec) * 1000 > now)) closed--;
  if (force || closed !== state.closedCount) {
    state.closedCount = closed;
    const closedBars = state.bars.slice(0, closed);
    state.result = analyze(closedBars, analysisOptions());
    state.sel = selectDrawings(state.result, closedBars, {
      maxZones: prefs.maxZones, maxLiquidity: prefs.maxZones,
    });
    paintVolume();
    updateDashboard();
  }
  pushOverlay();
}

function pushOverlay() {
  if (!state.result) return;
  positionDash();
  overlay.update({
    bars: state.bars, result: state.result, sel: state.sel, layers: prefs.layers, theme,
    lastIdx: state.bars.length - 1, avoid: avoidRects(),
  });
}

// Screen areas (in chart-pane coordinates) that chart labels must not be placed under.
function avoidRects() {
  const base = els.chart.getBoundingClientRect();
  const out = [];
  for (const el of [els.dash, document.getElementById('legend')]) {
    if (!el || el.hidden) continue;
    const r = el.getBoundingClientRect();
    if (!r.width) continue;
    out.push({ x: r.left - base.left - 4, y: r.top - base.top - 2, w: r.width + 8, h: r.height + 4 });
  }
  return out;
}

function schedulePoll() {
  clearTimeout(state.pollTimer);
  let ms = prefs.tf === '5m' ? 10000 : prefs.tf === '15m' || prefs.tf === '1h' ? 15000 : 30000;
  // Binance streams the full candle (price and volume), so polling is only a safety net there.
  if (state.meta?.source === 'binance' && streamFresh()) ms = 60000;
  state.pollTimer = setTimeout(poll, ms);
}

// ---------- Real-time stream ----------
// Crypto: Binance pushes the exchange's own forming candle (OHLC + volume) about every second.
// Yahoo markets: Yahoo pushes each traded price; it updates the forming candle's close/high/low.
// Candle volume for Yahoo markets is never estimated from ticks — it comes from the polled candles.
const streamFresh = () => state.lastTickAt > 0 && Date.now() - state.lastTickAt < (state.meta?.source === 'binance' ? 15000 : 120000);

function openStream() {
  closeStream();
  const m = state.meta;
  if (!window.EventSource || !m || (m.source !== 'binance' && m.source !== 'yahoo')) return;
  const token = state.loadToken;
  const es = new EventSource(`/api/stream?symbol=${encodeURIComponent(prefs.symbol)}&tf=${encodeURIComponent(prefs.tf)}`);
  state.stream = es;
  es.addEventListener('bar', (e) => { if (token === state.loadToken) onStreamBar(JSON.parse(e.data)); });
  es.addEventListener('tick', (e) => { if (token === state.loadToken) onStreamTick(JSON.parse(e.data)); });
  es.onerror = () => updateStatus();
}

function closeStream() {
  if (state.stream) state.stream.close();
  state.stream = null;
  state.lastTickAt = 0;
}

function onStreamBar({ bar }) {
  if (state.meta?.source !== 'binance' || !Array.isArray(bar)) return;
  const b = toBar(bar);
  const bars = state.bars;
  const last = bars[bars.length - 1];
  if (!last || b.time < last.time) return;
  if (b.time === last.time) bars[bars.length - 1] = b;
  else if (b.time === last.time + state.intervalSec) bars.push(b);
  else { pollSoon(); return; } // a gap: reload candles instead of guessing
  candles.update(toCandle(b));
  if (!noVolume()) volume.update({ time: toChartTime(b.time), value: b.volume, color: volumeColor(bars.length - 1) });
  state.lastTickAt = Date.now();
  renderSoon();
}

function onStreamTick(t) {
  if (state.meta?.source !== 'yahoo' || !Number.isFinite(t.price) || !Number.isFinite(t.time)) return;
  if (t.marketHours !== 1) return; // pre/post-market trades are not part of these candles
  const last = state.bars[state.bars.length - 1];
  if (!last || t.time < last.time) return;
  if (t.time >= last.time + state.intervalSec) { pollSoon(); return; } // belongs to a new candle
  last.close = t.price;
  last.high = Math.max(last.high, t.price);
  last.low = Math.min(last.low, t.price);
  candles.update(toCandle(last));
  state.lastTickAt = Date.now();
  renderSoon();
}

// Keep live updates from the stream when a poll returns the same forming candle.
function mergeLive(cur, rest) {
  if (!cur || cur.time !== rest.time || !streamFresh()) return rest;
  if (state.meta?.source === 'binance') return cur; // the stream is newer than the polled copy
  return { ...rest, high: Math.max(rest.high, cur.high), low: Math.min(rest.low, cur.low), close: cur.close };
}

function pollSoon() {
  if (state.pollSoonTimer) return;
  state.pollSoonTimer = setTimeout(() => { state.pollSoonTimer = null; poll(); }, 1500);
}

function renderSoon() {
  if (state.renderQueued) return;
  state.renderQueued = true;
  requestAnimationFrame(() => {
    state.renderQueued = false;
    recompute(false);
    updateLegend();
    updateStatus();
  });
}

async function poll() {
  const token = state.loadToken;
  if (document.hidden) return schedulePoll();
  try {
    const data = await fetchCandles(prefs.symbol, prefs.tf);
    if (token !== state.loadToken) return;
    applyData(data, false);
  } catch {
    if (token !== state.loadToken) return;
    state.okFetch = false;
    updateStatus();
  }
  schedulePoll();
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.bars.length) poll();
});

// ---------- Legend ----------
function formatBarTime(t) {
  const d = new Date(t * 1000);
  return state.intervalSec >= 86400 ? timeFmtDaily.format(d) : timeFmtIntraday.format(d);
}

function renderHeader() {
  const m = state.meta;
  els.symbolLabel.textContent = m.label || m.symbol;
  els.lgSymbol.textContent = m.label || m.symbol;
  els.lgTf.textContent = `${TF_LABEL[m.tf] || m.tf} · ${m.name && m.name !== m.label ? m.name : m.group}`;
  els.lgSource.textContent = m.source === 'demo' ? 'Demo data' : m.sourceLabel;
  els.lgSource.classList.toggle('demo', m.source === 'demo');
  document.title = `${m.label || m.symbol} ${TF_LABEL[m.tf]} · Clarity SMC Chart`;
}

function updateLegend() {
  const bars = state.bars;
  if (!bars.length) return;
  const idx = state.hoverIdx ?? bars.length - 1;
  const b = bars[idx];
  const prev = bars[idx - 1];
  const chg = prev ? ((b.close - prev.close) / prev.close) * 100 : 0;
  const cls = b.close >= b.open ? 'up' : 'down';
  const r = state.result;
  const ratio = r && idx < state.closedCount && Number.isFinite(r.volRatio[idx]) ? r.volRatio[idx] : null;
  const volPart = r && r.hasVolume
    ? `<span class="vol">Vol<b class="${ratio !== null && ratio >= r.options.hvMult ? 'hv-text' : ''}">${volFmt.format(b.volume)}${ratio !== null ? ` · ${ratio.toFixed(1)}×` : ''}</b></span>`
    : '';
  els.lgOhlc.innerHTML = `
    <span>O<b class="${cls}">${priceFmt.format(b.open)}</b></span>
    <span>H<b class="${cls}">${priceFmt.format(b.high)}</b></span>
    <span>L<b class="${cls}">${priceFmt.format(b.low)}</b></span>
    <span>C<b class="${cls}">${priceFmt.format(b.close)}</b></span>
    <span><b class="${chg >= 0 ? 'up' : 'down'}">${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%</b></span>
    ${volPart}`;

  els.lgEvents.textContent = '';
  if (!r) return;
  if (state.hoverIdx === null) {
    const hint = document.createElement('span');
    hint.className = 'legend-hint';
    hint.textContent = idx >= state.closedCount ? 'Live candle · signals confirm at close' : '';
    els.lgEvents.append(hint);
    return;
  }
  for (const ev of eventsAt(r, idx)) {
    const chip = document.createElement('span');
    chip.className = 'ev ' + evClass(ev);
    chip.textContent = ev.type === 'HV' ? `HV ${ev.ratio.toFixed(1)}×` : `${ev.type}${ev.dir > 0 && !ev.type.includes('SETUP') ? ' ▲' : ev.dir < 0 && !ev.type.includes('SETUP') ? ' ▼' : ''}`;
    els.lgEvents.append(chip);
  }
}

function evClass(ev) {
  if (ev.type.includes('SETUP')) return ev.dir > 0 ? 'setup-bull' : 'setup-bear';
  if (ev.type === 'HV') return 'hv';
  if (ev.type === 'OB') return 'ob';
  if (ev.type === 'FVG') return ev.dir > 0 ? 'fvg-bull' : 'fvg-bear';
  return ev.dir > 0 ? 'bull' : 'bear';
}

chart.subscribeCrosshairMove((p) => {
  let idx = null;
  if (p && p.point && p.logical !== undefined && p.logical !== null) {
    const i = Math.round(p.logical);
    if (i >= 0 && i < state.bars.length) idx = i;
  }
  if (idx !== state.hoverIdx) {
    state.hoverIdx = idx;
    updateLegend();
  }
});

// ---------- Dashboard ----------
const dirWord = (d) => (d > 0 ? 'Bullish' : d < 0 ? 'Bearish' : 'Neutral');
const dirCls = (d) => (d > 0 ? 'bull' : d < 0 ? 'bear' : '');
const ago = (n) => (n === 0 ? 'this bar' : n === 1 ? '1 bar ago' : `${n} bars ago`);

function setVal(el, dotCls, text, sub) {
  el.textContent = '';
  const dot = document.createElement('i');
  dot.className = `dot ${dotCls}`;
  const t = document.createElement('span');
  t.textContent = text;
  el.append(dot, t);
  if (sub) {
    const s = document.createElement('span');
    s.className = 'sub';
    s.textContent = sub;
    el.append(s);
  }
}

function updateDashboard() {
  const s = state.result && state.result.state;
  if (!s) return;
  const trendDir = s.trend === 'Bullish' ? 1 : s.trend === 'Bearish' ? -1 : 0;
  setVal(els.dTrend, dirCls(trendDir), s.trend);
  if (s.volume === 'N/A') setVal(els.dVolume, 'low', 'N/A', 'no volume data');
  else setVal(els.dVolume, s.volume === 'High' ? 'hv' : s.volume === 'Low' ? 'low' : '', s.volume, `${s.volumeRatio.toFixed(1)}× avg`);
  if (s.structure) setVal(els.dStructure, dirCls(s.structure.dir), s.structure.kind, `${s.structure.dir > 0 ? '▲' : '▼'} ${ago(s.structure.barsAgo)}`);
  else setVal(els.dStructure, '', 'None');
  if (s.sweep) setVal(els.dSweep, dirCls(s.sweep.dir), dirWord(s.sweep.dir), ago(s.sweep.barsAgo));
  else setVal(els.dSweep, '', 'None');
  const biasDir = s.bias === 'Bullish' ? 1 : s.bias === 'Bearish' ? -1 : 0;
  els.dBias.textContent = s.bias;
  els.dBias.className = `bias-pill ${dirCls(biasDir)}`;
  els.dStrength.textContent = s.biasStrength;
  els.dash.title = `Bias score ${s.score > 0 ? '+' : ''}${s.score} (trend, structure, sweep and latest setup combined)`;
}

function positionDash() {
  let w = 64;
  try { w = chart.priceScale('right').width(); } catch { /* not ready */ }
  els.dash.style.right = `${w + 10}px`;
}

function applyDashVisibility() {
  els.dash.hidden = !prefs.layers.dashboard;
  const collapsed = prefs.dashCollapsed ?? window.innerWidth < 720;
  els.dash.classList.toggle('collapsed', collapsed);
  els.dashToggle.setAttribute('aria-expanded', String(!collapsed));
  pushOverlay();
}

els.dashToggle.addEventListener('click', () => {
  prefs.dashCollapsed = !els.dash.classList.contains('collapsed');
  savePrefs();
  applyDashVisibility();
});

// ---------- Status ----------
function setStatus(kind, text) {
  els.liveDot.className = `live-dot ${kind}`;
  els.statusText.textContent = text;
}

// The status line reports what is measured: streaming now, delayed by a measured amount, or closed.
function updateStatus() {
  const m = state.meta;
  if (!m) return;
  const src = m.sourceLabel;
  if (tvOn) setStatus('live', 'TradingView chart · prices, data and delays as shown by TradingView');
  else if (m.source === 'demo') setStatus('warn', 'Demo data — live feed unavailable');
  else if (!state.okFetch && !streamFresh()) setStatus('warn', `Reconnecting to ${src}…`);
  else if (streamFresh()) setStatus('live', `Real-time · ${src} stream`);
  else if (m.source === 'yahoo' && m.lastBarOpen === false) setStatus('', `Market closed · ${src}`);
  else if (m.source === 'yahoo' && m.priceAgeSec >= 120) setStatus('warn', `${src} · delayed ${Math.round(m.priceAgeSec / 60)} min by the exchange feed`);
  else if (m.source === 'yahoo') setStatus('live', `${src} · updates every ${prefs.tf === '5m' ? 10 : prefs.tf === '15m' || prefs.tf === '1h' ? 15 : 30} s`);
  else setStatus('live', `Live · ${src}`);
  const last = Math.max(state.lastUpdate || 0, state.lastTickAt || 0);
  if (last) els.statusUpdated.textContent = `Updated ${clockFmt.format(new Date(last))}`;
}
setInterval(updateStatus, 5000);

function showLoading(mode, text) {
  els.loading.classList.remove('hide');
  els.loading.classList.toggle('overlay', mode === 'overlay');
  els.loadingText.textContent = text;
}

function hideLoading() {
  els.loading.classList.add('hide');
}

let toastTimer = null;
function toast(msg, ms = 4000) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, ms);
}

// ---------- Timeframes ----------
function renderTimeframes() {
  for (const btn of els.tfGroup.querySelectorAll('button')) {
    btn.setAttribute('aria-checked', String(btn.dataset.tf === prefs.tf));
  }
}

els.tfGroup.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tf]');
  if (!btn || btn.dataset.tf === prefs.tf) return;
  prefs.tf = btn.dataset.tf;
  savePrefs();
  syncUrl();
  renderTimeframes();
  load();
  if (tvOn) renderTradingView();
});

function syncUrl() {
  const qs = new URLSearchParams({ symbol: prefs.symbol, tf: prefs.tf });
  history.replaceState(null, '', `${location.pathname}?${qs}`);
}

// ---------- Symbol picker ----------
async function loadCatalog() {
  try {
    const res = await fetch('/api/symbols');
    if (res.ok) {
      const j = await res.json();
      if (Array.isArray(j.catalog)) state.catalog = j.catalog;
    }
  } catch { /* keep fallback */ }
}

function renderSymbolList() {
  const q = els.symbolSearch.value.trim().toUpperCase();
  els.symbolList.textContent = '';
  let matches = 0;
  let exact = false;
  for (const g of state.catalog) {
    const items = g.items.filter((it) => !q || it.symbol.includes(q) || it.label.toUpperCase().includes(q) || it.name.toUpperCase().includes(q));
    if (!items.length) continue;
    if (items.some((it) => it.symbol === q || it.label.toUpperCase() === q)) exact = true;
    const head = document.createElement('div');
    head.className = 'symbol-group';
    head.textContent = g.group;
    els.symbolList.append(head, ...items.map((it) => symbolItem(it)));
    matches += items.length;
  }
  // Offer the typed text as a custom ticker after the catalogue matches.
  if (q && !exact && /^[A-Z0-9^=.\-]{1,20}$/.test(q)) {
    const head = document.createElement('div');
    head.className = 'symbol-group';
    head.textContent = 'Custom';
    els.symbolList.append(head, symbolItem({ symbol: q, label: q, name: 'Crypto pair (…USDT) or stock ticker' }, true));
    matches += 1;
  }
  if (!matches) {
    const empty = document.createElement('div');
    empty.className = 'symbol-group';
    empty.textContent = 'No matches';
    els.symbolList.append(empty);
  }
}

function symbolItem(it, custom = false) {
  const b = document.createElement('button');
  b.className = `symbol-item${custom ? ' custom' : ''}${it.symbol === prefs.symbol ? ' active' : ''}`;
  b.dataset.symbol = it.symbol;
  const s = document.createElement('span');
  s.className = 's';
  s.textContent = it.label;
  const n = document.createElement('span');
  n.className = 'n';
  n.textContent = it.name;
  b.append(s, n);
  return b;
}

function chooseSymbol(sym) {
  closePopovers();
  if (!sym || sym === prefs.symbol) return;
  prefs.symbol = sym;
  savePrefs();
  syncUrl();
  els.symbolLabel.textContent = sym;
  load();
  if (tvOn) renderTradingView();
}

els.symbolBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = els.symbolMenu.hidden;
  closePopovers();
  if (open) {
    els.symbolMenu.hidden = false;
    els.symbolBtn.setAttribute('aria-expanded', 'true');
    els.symbolSearch.value = '';
    renderSymbolList();
    els.symbolSearch.focus();
  }
});
els.symbolSearch.addEventListener('input', renderSymbolList);
els.symbolSearch.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const first = els.symbolList.querySelector('.symbol-item');
    if (first) chooseSymbol(first.dataset.symbol);
  }
});
els.symbolList.addEventListener('click', (e) => {
  const item = e.target.closest('.symbol-item');
  if (item) chooseSymbol(item.dataset.symbol);
});

// ---------- Layers panel ----------
function renderLayersPanel() {
  const list = $('layerToggles');
  list.textContent = '';
  for (const layer of LAYERS) {
    const row = document.createElement('label');
    row.className = 'toggle-row';
    const lbl = document.createElement('span');
    lbl.className = 'lbl';
    if (layer.swatch) {
      const sw = document.createElement('i');
      sw.className = `sw ${layer.swatch}`;
      lbl.append(sw);
    }
    lbl.append(layer.label);
    const sw = document.createElement('span');
    sw.className = 'switch';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!prefs.layers[layer.id];
    input.setAttribute('aria-label', layer.label);
    input.addEventListener('change', () => {
      prefs.layers[layer.id] = input.checked;
      savePrefs();
      if (layer.id === 'dashboard') applyDashVisibility();
      if (layer.id === 'bubbles') paintVolume();
      pushOverlay();
    });
    const track = document.createElement('span');
    track.className = 'track';
    sw.append(input, track);
    row.append(lbl, sw);
    list.append(row);
  }

  const combos = $('comboToggles');
  combos.textContent = '';
  for (const c of COMBOS) {
    const row = document.createElement('label');
    row.className = 'check-row';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!prefs.combos[c.id];
    input.addEventListener('change', () => {
      prefs.combos[c.id] = input.checked;
      savePrefs();
      recompute(true);
      updateLegend();
    });
    const text = document.createElement('span');
    text.textContent = c.label;
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = c.short;
    row.append(input, text, tag);
    combos.append(row);
  }

  bindRange('swingInput', 'swingVal', 'swingLength', (v) => `${v} bars`, true);
  bindRange('hvInput', 'hvVal', 'hvMult', (v) => `${Number(v).toFixed(1)}× avg`, false);
  bindRange('zonesInput', 'zonesVal', 'maxZones', (v) => `${v}`, true);
}

function bindRange(inputId, valId, key, fmt, isInt) {
  const input = $(inputId);
  const val = $(valId);
  input.value = prefs[key];
  val.textContent = fmt(prefs[key]);
  input.oninput = () => {
    const v = isInt ? parseInt(input.value, 10) : parseFloat(input.value);
    prefs[key] = v;
    val.textContent = fmt(v);
    savePrefs();
    recompute(true);
    updateLegend();
  };
}

function positionLayersPanel() {
  const r = els.layersBtn.getBoundingClientRect();
  const panel = els.layersPanel;
  const width = Math.min(300, window.innerWidth - 32);
  panel.style.top = `${r.bottom + 6}px`;
  panel.style.left = `${Math.max(16, Math.min(window.innerWidth - width - 16, r.right - width))}px`;
}

els.layersBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = els.layersPanel.hidden;
  closePopovers();
  if (open) {
    renderLayersPanel();
    positionLayersPanel();
    els.layersPanel.hidden = false;
    els.layersBtn.setAttribute('aria-expanded', 'true');
  }
});

$('resetBtn').addEventListener('click', () => {
  const keep = { symbol: prefs.symbol, tf: prefs.tf, theme: prefs.theme };
  Object.assign(prefs, clone(DEFAULT_PREFS), keep);
  savePrefs();
  renderLayersPanel();
  applyDashVisibility();
  recompute(true);
  updateLegend();
});

function closePopovers() {
  els.symbolMenu.hidden = true;
  els.layersPanel.hidden = true;
  els.symbolBtn.setAttribute('aria-expanded', 'false');
  els.layersBtn.setAttribute('aria-expanded', 'false');
}

document.addEventListener('click', (e) => {
  if (!els.symbolMenu.hidden && !els.symbolMenu.contains(e.target)) closePopovers();
  if (!els.layersPanel.hidden && !els.layersPanel.contains(e.target)) closePopovers();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closePopovers();
});
window.addEventListener('resize', () => {
  if (!els.layersPanel.hidden) positionLayersPanel();
  pushOverlay();
});

// ---------- TradingView view ----------
// TradingView's official embeddable chart: TradingView's own prices and data, shown by TradingView.
// (TradingView has no public data API, so its data is used through its widget, not copied.)
const TV_SYMBOLS = {
  BTCUSDT: 'BINANCE:BTCUSDT', ETHUSDT: 'BINANCE:ETHUSDT', SOLUSDT: 'BINANCE:SOLUSDT', BNBUSDT: 'BINANCE:BNBUSDT',
  XRPUSDT: 'BINANCE:XRPUSDT', DOGEUSDT: 'BINANCE:DOGEUSDT',
  AAPL: 'NASDAQ:AAPL', NVDA: 'NASDAQ:NVDA', TSLA: 'NASDAQ:TSLA', MSFT: 'NASDAQ:MSFT', AMZN: 'NASDAQ:AMZN',
  SPY: 'AMEX:SPY', QQQ: 'NASDAQ:QQQ', '^GSPC': 'SP:SPX', '^NDX': 'NASDAQ:NDX',
  'EURUSD=X': 'FX:EURUSD', 'GBPUSD=X': 'FX:GBPUSD', 'USDJPY=X': 'FX:USDJPY',
  'GC=F': 'COMEX:GC1!', 'SI=F': 'COMEX:SI1!', 'CL=F': 'NYMEX:CL1!',
};
const TV_INTERVAL = { '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': 'D' };
const tvEls = {
  btn: $('tvBtn'), panel: $('tvPanel'), mount: $('tvMount'), close: $('tvClose'),
  picks: document.querySelector('.tv-picks'),
};
let tvOn = false;
let tvPick = 'current';

function tvSymbol(sym) {
  if (TV_SYMBOLS[sym]) return TV_SYMBOLS[sym];
  if (/^[A-Z0-9]+(USDT|USDC|FDUSD|BTC|ETH)$/.test(sym)) return `BINANCE:${sym}`;
  return sym.replace(/=X$/, '').replace(/^\^/, '');
}

function renderTradingView() {
  tvEls.mount.textContent = '';
  if (!tvOn) return;
  const box = document.createElement('div');
  box.className = 'tradingview-widget-container';
  const inner = document.createElement('div');
  inner.className = 'tradingview-widget-container__widget';
  const script = document.createElement('script');
  script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
  script.async = true;
  let tz = 'Etc/UTC';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || tz; } catch { /* default */ }
  script.textContent = JSON.stringify({
    autosize: true,
    symbol: tvPick === 'current' ? tvSymbol(prefs.symbol) : tvPick,
    interval: TV_INTERVAL[prefs.tf] || '60',
    timezone: tz,
    theme: theme.name,
    style: '1',
    locale: 'en',
    allow_symbol_change: true,
    save_image: false,
    calendar: false,
    support_host: 'https://www.tradingview.com',
  });
  box.append(inner, script);
  tvEls.mount.append(box);
}

function setTradingView(on) {
  tvOn = on;
  tvEls.panel.hidden = !on;
  els.stage.classList.toggle('tv-on', on);
  tvEls.btn.setAttribute('aria-pressed', String(on));
  renderTradingView();
  updateStatus();
}

tvEls.btn.addEventListener('click', () => setTradingView(!tvOn));
tvEls.close.addEventListener('click', () => setTradingView(false));
tvEls.picks.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tv]');
  if (!b) return;
  tvPick = b.dataset.tv;
  for (const x of tvEls.picks.querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
  renderTradingView();
});

// ---------- Key + theme ----------
function applyKey() {
  els.keyBody.hidden = !prefs.keyOpen;
  els.keyToggle.setAttribute('aria-expanded', String(prefs.keyOpen));
  els.keyToggle.textContent = prefs.keyOpen ? 'Hide key' : 'Key';
}
els.keyToggle.addEventListener('click', () => {
  prefs.keyOpen = !prefs.keyOpen;
  savePrefs();
  applyKey();
});

els.themeBtn.addEventListener('click', () => {
  prefs.theme = theme.name === 'dark' ? 'light' : 'dark';
  savePrefs();
  applyTheme();
  renderTradingView();
});
if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => {
    if (!prefs.theme) applyTheme();
  });
}

// ---------- Boot ----------
applyTheme();
applyDashVisibility();
applyKey();
renderTimeframes();
syncUrl();
els.symbolLabel.textContent = prefs.symbol;
loadCatalog();
load();
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => overlay.redraw());
