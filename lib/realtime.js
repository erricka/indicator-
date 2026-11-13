// Real-time price feeds, shared by every browser that is connected to this server.
//  • Yahoo Finance streamer (stocks, ETFs, indices, forex, futures): one WebSocket, symbols are
//    subscribed while at least one viewer needs them. Messages are base64 protobuf "PricingData".
//  • Binance market-data kline stream (crypto): the exchange's own candle for the selected timeframe,
//    pushed about every second while it forms.
// Nothing here invents data: Yahoo ticks carry only the traded price and time; candle volume keeps
// coming from the REST candles (polled), because a tick does not say how much traded in the candle.

const YAHOO_WS = 'wss://streamer.finance.yahoo.com/?version=2';
const BINANCE_WS = 'wss://data-stream.binance.vision/ws/';

// ---------- Minimal protobuf decoder for Yahoo's PricingData message ----------
const FIELDS = {
  1: ['id', 'string'], 2: ['price', 'float'], 3: ['time', 'sint64'], 4: ['currency', 'string'],
  5: ['exchange', 'string'], 6: ['quoteType', 'int'], 7: ['marketHours', 'int'], 8: ['changePercent', 'float'],
  9: ['dayVolume', 'sint64'], 10: ['dayHigh', 'float'], 11: ['dayLow', 'float'], 12: ['change', 'float'],
  13: ['shortName', 'string'], 15: ['openPrice', 'float'], 16: ['previousClose', 'float'],
  22: ['lastSize', 'sint64'], 23: ['bid', 'float'], 25: ['ask', 'float'], 27: ['priceHint', 'sint64'],
  31: ['lastMarket', 'string'],
};

function readVarint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  for (;;) {
    if (pos >= buf.length) throw new Error('truncated varint');
    const b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) return [result, pos];
    shift += 7n;
    if (shift > 70n) throw new Error('varint too long');
  }
}

export function decodePricing(base64) {
  const buf = Buffer.from(base64, 'base64');
  const out = {};
  let pos = 0;
  while (pos < buf.length) {
    let key;
    [key, pos] = readVarint(buf, pos);
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    const spec = FIELDS[field];
    if (wire === 0) {
      let v;
      [v, pos] = readVarint(buf, pos);
      if (spec) out[spec[0]] = spec[1] === 'sint64' ? Number((v >> 1n) ^ -(v & 1n)) : Number(BigInt.asIntN(64, v));
    } else if (wire === 5) {
      if (spec) out[spec[0]] = buf.readFloatLE(pos);
      pos += 4;
    } else if (wire === 1) {
      pos += 8;
    } else if (wire === 2) {
      let len;
      [len, pos] = readVarint(buf, pos);
      const n = Number(len);
      if (spec) out[spec[0]] = buf.toString('utf8', pos, pos + n);
      pos += n;
    } else {
      throw new Error(`unsupported wire type ${wire}`);
    }
  }
  // Prices travel as 32-bit floats; round to the instrument's own price precision.
  const dp = Number.isFinite(out.priceHint) ? Math.min(8, Math.max(0, out.priceHint)) : 6;
  for (const k of ['price', 'dayHigh', 'dayLow', 'openPrice', 'previousClose', 'bid', 'ask', 'change']) {
    if (Number.isFinite(out[k])) out[k] = Number(out[k].toFixed(dp));
  }
  return out;
}

// ---------- Yahoo hub: one socket, reference-counted subscriptions ----------
export class YahooHub {
  constructor({ log = () => {} } = {}) {
    this.log = log;
    this.listeners = new Map(); // symbol -> Set(fn)
    this.last = new Map(); // symbol -> last tick
    this.ws = null;
    this.retry = 0;
    this.timer = null;
  }

  subscribe(symbol, fn) {
    let set = this.listeners.get(symbol);
    if (!set) {
      set = new Set();
      this.listeners.set(symbol, set);
      this.send({ subscribe: [symbol] });
    }
    set.add(fn);
    this.ensure();
    const last = this.last.get(symbol);
    if (last) fn(last);
    return () => {
      set.delete(fn);
      if (!set.size) {
        this.listeners.delete(symbol);
        this.send({ unsubscribe: [symbol] });
        if (!this.listeners.size) this.close();
      }
    };
  }

  send(msg) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  ensure() {
    if (this.ws || !this.listeners.size) return;
    let ws;
    try {
      ws = new WebSocket(YAHOO_WS);
    } catch (err) {
      this.log(`[yahoo-stream] cannot connect: ${err.message}`);
      this.schedule();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.send({ subscribe: [...this.listeners.keys()] });
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.type !== 'pricing' || !msg.message) return;
        const tick = decodePricing(msg.message);
        if (!tick.id || !Number.isFinite(tick.price) || !Number.isFinite(tick.time)) return;
        this.last.set(tick.id, tick);
        for (const fn of this.listeners.get(tick.id) || []) fn(tick);
      } catch (err) {
        this.log(`[yahoo-stream] bad message: ${err.message}`);
      }
    };
    ws.onclose = () => {
      this.ws = null;
      if (this.listeners.size) this.schedule();
    };
    ws.onerror = () => {};
  }

  schedule() {
    clearTimeout(this.timer);
    const delay = Math.min(30000, 1000 * 2 ** this.retry++);
    this.timer = setTimeout(() => this.ensure(), delay);
  }

  close() {
    clearTimeout(this.timer);
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      try { ws.close(); } catch { /* already closed */ }
    }
  }
}

// ---------- Binance kline stream: one socket per symbol+interval, shared by viewers ----------
export class BinanceHub {
  constructor({ log = () => {} } = {}) {
    this.log = log;
    this.streams = new Map(); // key -> { ws, listeners, retry, timer, last }
  }

  subscribe(symbol, interval, fn) {
    const key = `${symbol.toLowerCase()}@kline_${interval}`;
    let s = this.streams.get(key);
    if (!s) {
      s = { key, ws: null, listeners: new Set(), retry: 0, timer: null, last: null };
      this.streams.set(key, s);
      this.open(s);
    }
    s.listeners.add(fn);
    if (s.last) fn(s.last);
    return () => {
      s.listeners.delete(fn);
      if (!s.listeners.size) {
        clearTimeout(s.timer);
        this.streams.delete(key);
        if (s.ws) { try { s.ws.close(); } catch { /* closed */ } }
        s.ws = null;
      }
    };
  }

  open(s) {
    let ws;
    try {
      ws = new WebSocket(BINANCE_WS + s.key);
    } catch (err) {
      this.log(`[binance-stream] cannot connect: ${err.message}`);
      return this.retryLater(s);
    }
    s.ws = ws;
    ws.onopen = () => { s.retry = 0; };
    ws.onmessage = (ev) => {
      try {
        const k = JSON.parse(String(ev.data)).k;
        if (!k) return;
        // The exchange's own candle: open time, OHLC, base-asset volume, closed flag.
        const bar = { bar: [k.t / 1000, +k.o, +k.h, +k.l, +k.c, +k.v], closed: !!k.x, time: Date.now() };
        s.last = bar;
        for (const fn of s.listeners) fn(bar);
      } catch (err) {
        this.log(`[binance-stream] bad message: ${err.message}`);
      }
    };
    ws.onclose = () => {
      s.ws = null;
      if (this.streams.get(s.key) === s && s.listeners.size) this.retryLater(s);
    };
    ws.onerror = () => {};
    return undefined;
  }

  retryLater(s) {
    clearTimeout(s.timer);
    s.timer = setTimeout(() => this.open(s), Math.min(30000, 1000 * 2 ** s.retry++));
  }
}
