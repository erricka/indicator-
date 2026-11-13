// Clarity SMC — tiny zero-dependency web server.
// Serves the chart app and proxies free public market data with fallbacks.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 10000;
const MAX_BARS = 1000;
const BUILD_ID = (process.env.RENDER_GIT_COMMIT || String(Date.now())).slice(0, 10);
const UA = 'Mozilla/5.0 (compatible; ClaritySMC/1.0)';

const VENDOR = {
  '/vendor/lightweight-charts.js': path.join(
    ROOT, 'node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.js',
  ),
};

export const TIMEFRAMES = {
  '1m': { sec: 60, binance: '1m', kraken: 1, yahoo: { interval: '1m', range: '5d' } },
  '5m': { sec: 300, binance: '5m', kraken: 5, yahoo: { interval: '5m', range: '1mo' } },
  '15m': { sec: 900, binance: '15m', kraken: 15, yahoo: { interval: '15m', range: '1mo' } },
  '1h': { sec: 3600, binance: '1h', kraken: 60, yahoo: { interval: '60m', range: '6mo' } },
  '4h': { sec: 14400, binance: '4h', kraken: 240, yahoo: { interval: '60m', range: '1y', aggregate: 14400 } },
  '1d': { sec: 86400, binance: '1d', kraken: 1440, yahoo: { interval: '1d', range: '5y' } },
};

export const CATALOG = [
  {
    group: 'Crypto',
    items: [
      { symbol: 'BTCUSDT', label: 'BTC/USDT', name: 'Bitcoin' },
      { symbol: 'ETHUSDT', label: 'ETH/USDT', name: 'Ethereum' },
      { symbol: 'SOLUSDT', label: 'SOL/USDT', name: 'Solana' },
      { symbol: 'BNBUSDT', label: 'BNB/USDT', name: 'BNB' },
      { symbol: 'XRPUSDT', label: 'XRP/USDT', name: 'XRP' },
      { symbol: 'DOGEUSDT', label: 'DOGE/USDT', name: 'Dogecoin' },
    ],
  },
  {
    group: 'Stocks',
    items: [
      { symbol: 'AAPL', label: 'AAPL', name: 'Apple' },
      { symbol: 'NVDA', label: 'NVDA', name: 'NVIDIA' },
      { symbol: 'TSLA', label: 'TSLA', name: 'Tesla' },
      { symbol: 'MSFT', label: 'MSFT', name: 'Microsoft' },
      { symbol: 'AMZN', label: 'AMZN', name: 'Amazon' },
    ],
  },
  {
    group: 'Indices & ETFs',
    items: [
      { symbol: 'SPY', label: 'SPY', name: 'S&P 500 ETF' },
      { symbol: 'QQQ', label: 'QQQ', name: 'Nasdaq-100 ETF' },
      { symbol: '^GSPC', label: 'SPX', name: 'S&P 500 Index' },
      { symbol: '^NDX', label: 'NDX', name: 'Nasdaq-100 Index' },
    ],
  },
  {
    group: 'Forex',
    items: [
      { symbol: 'EURUSD=X', label: 'EUR/USD', name: 'Euro / US Dollar' },
      { symbol: 'GBPUSD=X', label: 'GBP/USD', name: 'British Pound / US Dollar' },
      { symbol: 'USDJPY=X', label: 'USD/JPY', name: 'US Dollar / Japanese Yen' },
    ],
  },
  {
    group: 'Commodities',
    items: [
      { symbol: 'GC=F', label: 'GOLD', name: 'Gold Futures' },
      { symbol: 'SI=F', label: 'SILVER', name: 'Silver Futures' },
      { symbol: 'CL=F', label: 'CRUDE', name: 'Crude Oil Futures' },
    ],
  },
];

const CATALOG_INDEX = new Map(
  CATALOG.flatMap((g) => g.items.map((it) => [it.symbol, { ...it, group: g.group }])),
);
const CRYPTO_QUOTES = ['USDT', 'USDC', 'FDUSD', 'BTC', 'ETH'];

export function resolveSymbol(raw) {
  const symbol = String(raw || '').trim().toUpperCase();
  if (!/^[A-Z0-9^=.\-]{1,20}$/.test(symbol)) return null;
  const known = CATALOG_INDEX.get(symbol);
  if (known) return { ...known, kind: known.group === 'Crypto' ? 'crypto' : 'yahoo' };
  const quote = CRYPTO_QUOTES.find((q) => symbol.endsWith(q) && symbol.length > q.length + 1);
  if (quote && /^[A-Z0-9]+$/.test(symbol)) {
    const base = symbol.slice(0, -quote.length);
    return { symbol, label: `${base}/${quote}`, name: base, group: 'Crypto', kind: 'crypto' };
  }
  return { symbol, label: symbol.replace(/=X$|=F$/, ''), name: symbol, group: 'Custom', kind: 'yahoo' };
}

// ---------- Upstream providers ----------

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) throw new Error(`${new URL(url).host} HTTP ${res.status}`);
  return res.json();
}

function cleanBars(rows) {
  const out = [];
  let lastT = -Infinity;
  for (const r of rows) {
    const [t, o, h, l, c, v] = r;
    if (![t, o, h, l, c].every(Number.isFinite) || t <= lastT) continue;
    const hi = Math.max(h, o, c);
    const lo = Math.min(l, o, c);
    out.push([t, o, hi, lo, c, Number.isFinite(v) ? v : 0]);
    lastT = t;
  }
  return out.slice(-MAX_BARS);
}

async function fromBinance(sym, tf) {
  const qs = `symbol=${encodeURIComponent(sym.symbol)}&interval=${tf.binance}&limit=${MAX_BARS}`;
  const hosts = ['https://data-api.binance.vision', 'https://api.binance.com'];
  let lastErr;
  for (const host of hosts) {
    try {
      const rows = await getJson(`${host}/api/v3/klines?${qs}`);
      if (!Array.isArray(rows) || !rows.length) throw new Error('Binance: empty');
      return {
        source: 'binance', sourceLabel: 'Binance',
        bars: cleanBars(rows.map((k) => [k[0] / 1000, +k[1], +k[2], +k[3], +k[4], +k[5]])),
      };
    } catch (err) { lastErr = err; }
  }
  throw lastErr;
}

async function fromKraken(sym, tf) {
  const quote = CRYPTO_QUOTES.find((q) => sym.symbol.endsWith(q)) || 'USDT';
  let base = sym.symbol.slice(0, -quote.length);
  if (base === 'BTC') base = 'XBT';
  const krakenQuote = quote.startsWith('USD') || quote === 'FDUSD' ? 'USD' : quote === 'BTC' ? 'XBT' : quote;
  const data = await getJson(`https://api.kraken.com/0/public/OHLC?pair=${base}${krakenQuote}&interval=${tf.kraken}`);
  if (data.error && data.error.length) throw new Error(`Kraken: ${data.error[0]}`);
  const key = Object.keys(data.result || {}).find((k) => k !== 'last');
  const rows = key ? data.result[key] : [];
  if (!rows.length) throw new Error('Kraken: empty');
  return {
    source: 'kraken', sourceLabel: 'Kraken',
    bars: cleanBars(rows.map((k) => [+k[0], +k[1], +k[2], +k[3], +k[4], +k[6]])),
  };
}

function aggregate(bars, bucketSec) {
  const out = [];
  for (const b of bars) {
    const t = Math.floor(b[0] / bucketSec) * bucketSec;
    const cur = out[out.length - 1];
    if (cur && cur[0] === t) {
      cur[2] = Math.max(cur[2], b[2]);
      cur[3] = Math.min(cur[3], b[3]);
      cur[4] = b[4];
      cur[5] += b[5];
    } else {
      out.push([t, b[1], b[2], b[3], b[4], b[5]]);
    }
  }
  return out;
}

async function fromYahoo(sym, tf) {
  const { interval, range, aggregate: agg } = tf.yahoo;
  const qs = `interval=${interval}&range=${range}&includePrePost=false&events=div%2Csplit`;
  let lastErr;
  for (const host of ['query1', 'query2']) {
    try {
      const data = await getJson(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym.symbol)}?${qs}`);
      const r = data?.chart?.result?.[0];
      if (!r || !r.timestamp) throw new Error(data?.chart?.error?.description || 'Yahoo: no data');
      const q = r.indicators.quote[0];
      let bars = r.timestamp.map((t, i) => [t, q.open[i], q.high[i], q.low[i], q.close[i], q.volume[i]]);
      bars = cleanBars(bars.filter((b) => b[1] !== null && b[4] !== null));
      // Yahoo appends flat zero-volume placeholder prints (e.g. the closing auction tick); drop them
      // when the instrument normally reports volume so they do not distort volume analysis.
      const withVol = bars.filter((b) => b[5] > 0).length;
      if (withVol > bars.length * 0.5) {
        bars = bars.filter((b) => !(b[5] === 0 && b[1] === b[2] && b[2] === b[3] && b[3] === b[4]));
      }
      if (agg) bars = aggregate(bars, agg);
      if (!bars.length) throw new Error('Yahoo: empty');
      return {
        source: 'yahoo', sourceLabel: 'Yahoo Finance', delayed: true,
        bars: bars.slice(-MAX_BARS),
        currency: r.meta?.currency || null,
        session: r.meta?.currentTradingPeriod?.regular || null,
      };
    } catch (err) { lastErr = err; }
  }
  throw lastErr;
}

// Deterministic synthetic market so the chart still works if every feed is down.
function demoBars(sym, tf) {
  const seed = createHash('sha256').update(`${sym.symbol}:${tf.sec}`).digest().readUInt32LE(0);
  let s = seed || 1;
  const rand = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 1e9) / 1e9; };
  const count = 600;
  const end = Math.floor(Date.now() / 1000 / tf.sec) * tf.sec;
  let price = 100 + (seed % 900);
  let drift = 0;
  const bars = [];
  for (let i = 0; i < count; i++) {
    if (i % 60 === 0) drift = (rand() - 0.5) * 0.004;
    const vol = price * (0.004 + rand() * 0.006);
    const open = price;
    const close = Math.max(1, open + (rand() - 0.5) * vol * 2 + drift * price);
    const high = Math.max(open, close) + rand() * vol;
    const low = Math.min(open, close) - rand() * vol;
    const spike = rand() > 0.94 ? 2.5 + rand() * 2 : 1;
    bars.push([end - (count - 1 - i) * tf.sec, open, high, Math.max(0.5, low), close, Math.round((800 + rand() * 600) * spike)]);
    price = close;
  }
  return { source: 'demo', sourceLabel: 'Demo data', bars };
}

// Is the newest bar still trading? Crypto bars sit on a fixed time grid; Yahoo bars start at the
// session open, so for them the exchange session tells us whether the last bar can still change.
function withOpenFlag(out, tf) {
  const nowS = Date.now() / 1000;
  const last = out.bars[out.bars.length - 1];
  const { session, ...rest } = out;
  const lastBarOpen = session ? nowS >= session.start && nowS < session.end : last[0] + tf.sec > nowS;
  return { ...rest, lastBarOpen };
}

const cache = new Map();

export async function getCandles(rawSymbol, tfKey) {
  const sym = resolveSymbol(rawSymbol);
  const tf = TIMEFRAMES[tfKey];
  if (!sym) throw Object.assign(new Error('Invalid symbol'), { status: 400 });
  if (!tf) throw Object.assign(new Error('Invalid timeframe'), { status: 400 });
  const key = `${sym.symbol}|${tfKey}`;
  const ttl = tf.sec >= 86400 ? 60_000 : 8_000;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.promise;

  const promise = (async () => {
    const providers = sym.kind === 'crypto' ? [fromBinance, fromKraken] : [fromYahoo];
    const errors = [];
    for (const provider of providers) {
      try {
        const out = await provider(sym, tf);
        if (out.bars.length >= 30) return withOpenFlag(out, tf);
        errors.push(`${out.sourceLabel}: only ${out.bars.length} bars`);
      } catch (err) {
        errors.push(err.message);
      }
    }
    console.warn(`[data] ${key} falling back to demo: ${errors.join(' | ')}`);
    return withOpenFlag({ ...demoBars(sym, tf), notice: 'Live data unavailable — showing synthetic demo data.' }, tf);
  })().then((out) => ({
    symbol: sym.symbol, label: sym.label, name: sym.name, group: sym.group,
    tf: tfKey, intervalSec: tf.sec, serverTime: Date.now(), ...out,
  }));

  cache.set(key, { t: Date.now(), promise });
  promise.then((out) => {
    // Do not keep demo fallbacks around long: retry the real feed soon.
    if (out.source === 'demo') cache.set(key, { t: Date.now() - ttl + 3000, promise });
  }, () => cache.delete(key));
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return promise;
}

// ---------- HTTP ----------

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
  ].join('; '),
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function sendJson(res, status, obj, extra = {}) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store', ...extra });
}

const fileCache = new Map();
async function loadFile(file) {
  if (process.env.NODE_ENV === 'production' && fileCache.has(file)) return fileCache.get(file);
  let buf = await readFile(file);
  if (file.endsWith('index.html')) buf = Buffer.from(buf.toString('utf8').replaceAll('__BUILD__', BUILD_ID));
  const entry = { buf, etag: `"${createHash('sha1').update(buf).digest('base64url').slice(0, 20)}"` };
  fileCache.set(file, entry);
  return entry;
}

async function serveStatic(req, res, pathname) {
  let file = VENDOR[pathname];
  if (!file) {
    let rel;
    try {
      rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    } catch {
      return send(res, 400, 'Bad request');
    }
    file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  }
  try {
    const { buf, etag } = await loadFile(file);
    const ext = path.extname(file);
    const headers = {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      // Vendor bundle is version-pinned; app files revalidate so a redeploy is picked up immediately.
      'Cache-Control': VENDOR[pathname] ? 'public, max-age=604800' : 'no-cache',
      ETag: etag,
    };
    if (req.headers['if-none-match'] === etag) return send(res, 304, undefined, headers);
    send(res, 200, req.method === 'HEAD' ? undefined : buf, headers);
  } catch {
    send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      if (pathname === '/healthz') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });
      if (pathname === '/api/symbols') {
        return sendJson(res, 200, { catalog: CATALOG, timeframes: Object.keys(TIMEFRAMES) }, { 'Cache-Control': 'public, max-age=3600' });
      }
      if (pathname === '/api/candles') {
        const data = await getCandles(url.searchParams.get('symbol') || 'BTCUSDT', url.searchParams.get('tf') || '1h');
        return sendJson(res, 200, data);
      }
      return serveStatic(req, res, pathname);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(err);
      return sendJson(res, status, { error: err.message || 'Server error' });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createServer().listen(PORT, () => console.log(`Clarity SMC listening on http://localhost:${PORT}`));
}
