// Pine scripts page: shows the TradingView indicators with line numbers and lets the user copy or
// download them. The code is fetched from /pine/<file> (served read-only by server.js).

const SCRIPTS = {
  footprint: {
    title: 'Footprint Overlay',
    file: 'footprint_overlay.pine',
    guide: 'FOOTPRINT.md',
    desc: 'Draws TradingView’s own volume footprint rows on the price chart: sell volume left and buy volume right of each candle (or one delta column), the Point of Control, the value area, diagonal and stacked imbalances, a volume / delta / delta % summary under each candle, and alerts on candle close.',
    facts: [
      { text: 'Needs a TradingView Premium or Ultimate plan (footprint data).', warn: true },
      { text: 'Buy / sell volume is TradingView’s intrabar up/down estimate, not exchange-reported aggressor trades.', warn: true },
      { text: 'Set “Ticks per row” for about 8–20 rows per candle, then zoom in to roughly 100–150 px per bar.' },
      { text: 'The open candle updates live and stays provisional until it closes.' },
    ],
  },
  clarity: {
    title: 'Clarity SMC',
    file: 'clarity_smc.pine',
    guide: 'README.md',
    desc: 'Smart Money Concepts overlay: liquidity (BSL / SSL / sweeps), BOS / MSS, order blocks, fair value gaps, volume statistics and bubbles, confluence setups, automatic stop loss and take-profit levels, and a trade dashboard. Tuned for XAUUSD on 1m–1h.',
    facts: [
      { text: 'Works on any TradingView plan; uses the chart’s own volume.' },
      { text: 'Signals are evaluated on closed candles; setups on the open candle are shown as provisional.' },
      { text: 'Setups highlight confluence only. They are not financial advice.', warn: true },
    ],
  },
};

const KEYWORDS = new Set([
  'if', 'else', 'for', 'to', 'by', 'in', 'while', 'switch', 'var', 'varip', 'type', 'method', 'import', 'export',
  'and', 'or', 'not', 'true', 'false', 'na', 'const', 'simple', 'series', 'int', 'float', 'bool', 'string', 'color',
  'array', 'matrix', 'map', 'label', 'line', 'box', 'table', 'linefill', 'polyline', 'footprint', 'volume_row',
  'break', 'continue', 'enum', 'once',
]);

const $ = (id) => document.getElementById(id);
const els = {
  tabs: [...document.querySelectorAll('.tabs [role="tab"]')],
  panel: $('panel'),
  title: $('title'),
  meta: $('meta'),
  desc: $('desc'),
  facts: $('facts'),
  copyBtn: $('copyBtn'),
  copyLabel: $('copyLabel'),
  dlBtn: $('dlBtn'),
  guideBtn: $('guideBtn'),
  status: $('status'),
  fileName: $('fileName'),
  lineCount: $('lineCount'),
  gutter: $('gutter'),
  code: $('code'),
  scroll: $('codeScroll'),
};

const cache = new Map();
let current = null;
let currentText = '';
let resetTimer = 0;

// ---------- Theme: follow the chart's saved choice, otherwise the system setting ----------
(function applyTheme() {
  let saved = null;
  try { saved = (JSON.parse(localStorage.getItem('clarity-smc:v1') || '{}') || {}).theme || null; } catch { saved = null; }
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
  const light = saved ? saved === 'light' : window.matchMedia?.('(prefers-color-scheme: light)').matches;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', light ? '#FFFFFF' : '#0B0E14');
})();

// ---------- Syntax colouring (comments, strings, keywords, numbers and colours) ----------
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const TOKEN = /(#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?\b)|\b([A-Za-z_]\w*)\b|((?<![\w#.])\d+(?:\.\d+)?(?:[eE][-+]?\d+)?\b)/g;

function colourPlain(text) {
  return esc(text).replace(TOKEN, (m, hex, word, num) => {
    if (hex) return `<span class="n">${hex}</span>`;
    if (word) return KEYWORDS.has(word) ? `<span class="k">${word}</span>` : word;
    return `<span class="n">${num}</span>`;
  });
}

function colourLine(line) {
  let out = '';
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '/' && line[i + 1] === '/') {
      out += `<span class="c">${esc(line.slice(i))}</span>`;
      break;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < line.length && line[j] !== ch) j += line[j] === '\\' ? 2 : 1;
      out += `<span class="s">${esc(line.slice(i, j + 1))}</span>`;
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < line.length && line[j] !== '"' && line[j] !== "'" && !(line[j] === '/' && line[j + 1] === '/')) j++;
    out += colourPlain(line.slice(i, j));
    i = j;
  }
  return out;
}

function renderCode(text) {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
  els.gutter.textContent = lines.map((_, i) => i + 1).join('\n');
  els.code.innerHTML = lines.map(colourLine).join('\n');
  els.lineCount.textContent = `${lines.length.toLocaleString()} lines`;
  return lines.length;
}

// ---------- Loading and switching scripts ----------
async function loadText(file) {
  if (cache.has(file)) return cache.get(file);
  const res = await fetch(`/pine/${file}`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  cache.set(file, text);
  return text;
}

function setStatus(text, kind = '') {
  els.status.textContent = text;
  els.status.className = `status${kind ? ` ${kind}` : ''}`;
}

async function show(key) {
  const s = SCRIPTS[key] || SCRIPTS.footprint;
  key = SCRIPTS[key] ? key : 'footprint';
  current = key;
  els.tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.script === key)));
  els.panel.setAttribute('aria-labelledby', `tab-${key}`);
  els.title.textContent = s.title;
  els.desc.textContent = s.desc;
  els.facts.replaceChildren(...s.facts.map((f) => {
    const li = document.createElement('li');
    li.textContent = f.text;
    if (f.warn) li.className = 'warn';
    return li;
  }));
  els.dlBtn.href = `/pine/${s.file}`;
  els.dlBtn.setAttribute('download', s.file);
  els.guideBtn.href = `/pine/${s.guide}`;
  els.fileName.textContent = s.file;
  els.meta.textContent = '';
  els.lineCount.textContent = '';
  els.copyBtn.disabled = true;
  resetCopyButton();
  setStatus('Loading…');
  currentText = '';
  els.gutter.textContent = '';
  els.code.textContent = 'Loading…';
  try {
    const text = await loadText(s.file);
    if (current !== key) return; // the user switched tabs while loading
    currentText = text;
    const n = renderCode(text);
    els.meta.textContent = `Pine Script v6 · ${n.toLocaleString()} lines · ${(new Blob([text]).size / 1024).toFixed(0)} KB`;
    els.copyBtn.disabled = false;
    setStatus('');
    els.scroll.scrollTo(0, 0);
  } catch (err) {
    if (current !== key) return;
    els.code.textContent = '';
    setStatus(`Could not load ${s.file} (${err.message}). Reload the page to try again.`, 'err');
  }
}

// ---------- Copy ----------
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* fall back below (older browsers, non-secure origins) */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

function resetCopyButton() {
  clearTimeout(resetTimer);
  els.copyBtn.classList.remove('done');
  els.copyLabel.textContent = 'Copy code';
}

els.copyBtn.addEventListener('click', async () => {
  if (!currentText) return;
  const lines = currentText.replace(/\n$/, '').split('\n').length;
  if (await copyText(currentText)) {
    els.copyBtn.classList.add('done');
    els.copyLabel.textContent = 'Copied';
    setStatus(`Copied all ${lines.toLocaleString()} lines. Paste them into an empty Pine Editor.`, 'ok');
    clearTimeout(resetTimer);
    resetTimer = setTimeout(resetCopyButton, 2500);
  } else {
    setStatus('Your browser blocked copying. Use Download .pine, or select the code below and copy it.', 'err');
  }
});

els.tabs.forEach((t) => t.addEventListener('click', () => {
  if (t.dataset.script === current) return;
  history.replaceState(null, '', `#${t.dataset.script}`);
  show(t.dataset.script);
}));

// Arrow keys move between tabs (WAI-ARIA tabs pattern).
document.querySelector('.tabs').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const i = els.tabs.findIndex((t) => t.dataset.script === current);
  const next = els.tabs[(i + (e.key === 'ArrowRight' ? 1 : els.tabs.length - 1)) % els.tabs.length];
  next.focus();
  next.click();
});

window.addEventListener('hashchange', () => show(location.hash.slice(1)));
show(location.hash.slice(1) || 'footprint');
