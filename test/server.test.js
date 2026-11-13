import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, resolveSymbol } from '../server.js';

let server;
let base;

before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

test('resolveSymbol routes crypto pairs and stock tickers', () => {
  assert.equal(resolveSymbol('btcusdt').kind, 'crypto');
  assert.equal(resolveSymbol('ADAUSDT').label, 'ADA/USDT');
  assert.equal(resolveSymbol('AAPL').kind, 'yahoo');
  assert.equal(resolveSymbol('EURUSD=X').group, 'Forex');
  assert.equal(resolveSymbol('^GSPC').label, 'SPX');
  assert.equal(resolveSymbol('bad symbol!'), null);
  assert.equal(resolveSymbol('../etc/passwd'), null);
});

test('serves the app shell with a build id and security headers', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<title>Clarity SMC Chart<\/title>/);
  assert.doesNotMatch(html, /__BUILD__/);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(res.headers.get('content-security-policy'), /frame-src [^;]*tradingview-widget\.com/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  const etag = res.headers.get('etag');
  const again = await fetch(`${base}/`, { headers: { 'If-None-Match': etag } });
  assert.equal(again.status, 304);
});

test('serves the chart library and app modules', async () => {
  const lib = await fetch(`${base}/vendor/lightweight-charts.js`);
  assert.equal(lib.status, 200);
  assert.match(lib.headers.get('content-type'), /javascript/);
  const mod = await fetch(`${base}/js/engine.js`);
  assert.equal(mod.status, 200);
  assert.match(await mod.text(), /export function analyze/);
});

test('health check, validation and path traversal', async () => {
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  const bad = await fetch(`${base}/api/candles?symbol=BTCUSDT&tf=7m`);
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /timeframe/i);
  const badSym = await fetch(`${base}/api/candles?symbol=${encodeURIComponent('<script>')}&tf=1h`);
  assert.equal(badSym.status, 400);
  assert.equal((await fetch(`${base}/%E0%A4%A`)).status, 400, 'malformed escape is a client error');
  const trav = await fetch(`${base}/%2e%2e/server.js`);
  assert.ok([403, 404].includes(trav.status));
  const badStream = await fetch(`${base}/api/stream?symbol=${encodeURIComponent('<x>')}&tf=1h`);
  assert.equal(badStream.status, 400);
  const badTf = await fetch(`${base}/api/stream?symbol=BTCUSDT&tf=9m`);
  assert.equal(badTf.status, 400);
  const sym = await (await fetch(`${base}/api/symbols`)).json();
  assert.ok(sym.catalog.length >= 4);
});
