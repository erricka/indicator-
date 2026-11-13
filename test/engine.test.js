import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, selectDrawings, eventsAt } from '../public/js/engine.js';

const mk = (rows, vol = 100) => rows.map(([o, h, l, c, v], i) => ({
  time: 1_700_000_000 + i * 3600, open: o, high: h, low: l, close: c, volume: v ?? vol,
}));

// Deterministic synthetic market with trends, ranges and volume spikes.
function synthetic(n, seed = 7) {
  let s = seed;
  const rand = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  const bars = [];
  let price = 100;
  let drift = 0;
  for (let i = 0; i < n; i++) {
    if (i % 80 === 0) drift = (rand() - 0.5) * 0.6;
    const o = price;
    const c = Math.max(1, o + (rand() - 0.5) * 2.4 + drift);
    const h = Math.max(o, c) + rand() * 1.2;
    const l = Math.min(o, c) - rand() * 1.2;
    const v = Math.round((900 + rand() * 400) * (rand() > 0.93 ? 3 + rand() * 2 : 1));
    bars.push({ time: 1_700_000_000 + i * 900, open: o, high: h, low: l, close: c, volume: v });
    price = c;
  }
  return bars;
}

test('BOS in a new trend, then MSS when structure flips', () => {
  const bars = mk([
    [100, 101, 99, 100],
    [100, 102, 99.5, 101],
    [101, 105, 100, 104], // swing high 105
    [103, 103.5, 101, 102],
    [102, 102.5, 100.5, 101],
    [101, 106.5, 100.8, 106], // close above 105 -> BOS up
    [106, 107, 104, 106],
    [106, 106.5, 103, 103.5],
    [103.5, 104, 100, 101], // swing low 100
    [101, 102.5, 101, 102],
    [102, 103, 102, 102.5],
    [102.5, 102.6, 98, 98.5], // close below 100 against the trend -> MSS down
  ]);
  const r = analyze(bars, { swingLength: 2 });
  assert.deepEqual(
    r.structure.map(({ kind, dir, fromIdx, idx, price }) => ({ kind, dir, fromIdx, idx, price })),
    [
      { kind: 'BOS', dir: 1, fromIdx: 2, idx: 5, price: 105 },
      { kind: 'MSS', dir: -1, fromIdx: 8, idx: 11, price: 100 },
    ],
  );
  assert.equal(r.trend, -1);
  // Each break creates an order block on the origin of the impulse leg.
  assert.equal(r.obs.filter((z) => z.createdIdx === 5 && z.dir === 1).length, 1);
  // Closing through sell-side liquidity is a break, not a sweep.
  assert.equal(r.sweeps.length, 0);
  assert.equal(r.liquidity.find((lv) => lv.idx === 8).outcome, 'break');
});

test('liquidity sweep = wick through a resting level and close back inside; HV confirms a setup', () => {
  const rows = [
    [100, 101, 99, 100],
    [100, 102, 99.5, 101],
    [101, 105, 100, 104], // swing high 105 -> buy-side liquidity
    [103, 103.5, 101, 102],
    [102, 102.5, 100.5, 101],
  ];
  for (let i = 0; i < 7; i++) rows.push([101, 102, 100.5, 101.2]);
  rows.push([101.2, 106, 101, 104.2, 600]); // idx 12: raid above 105, close back below, 6x volume
  const r = analyze(mk(rows), { swingLength: 2, volLength: 5 });
  assert.equal(r.sweeps.length, 1);
  const sw = r.sweeps[0];
  assert.deepEqual({ dir: sw.dir, idx: sw.idx, price: sw.price, side: sw.side }, { dir: -1, idx: 12, price: 105, side: 'BSL' });
  assert.equal(r.structure.length, 0, 'no close above the high, so no BOS');
  assert.equal(r.setups.length, 1);
  assert.deepEqual({ dir: r.setups[0].dir, idx: r.setups[0].idx, reasons: r.setups[0].reasons }, { dir: -1, idx: 12, reasons: ['LS', 'HV'] });
  assert.equal(r.state.sweep.dir, -1);

  // The same raid on normal volume is still a sweep but not a setup.
  rows[12] = [101.2, 106, 101, 104.2, 100];
  const quiet = analyze(mk(rows), { swingLength: 2, volLength: 5 });
  assert.equal(quiet.sweeps.length, 1);
  assert.equal(quiet.setups.length, 0);

  // Disabling the combo removes the setup.
  rows[12] = [101.2, 106, 101, 104.2, 600];
  const off = analyze(mk(rows), { swingLength: 2, volLength: 5, combos: { sweepHv: false } });
  assert.equal(off.setups.length, 0);
});

test('young liquidity (< minSweepAge bars) is consumed without a sweep signal', () => {
  const rows = [
    [100, 101, 99, 100],
    [100, 102, 99.5, 101],
    [101, 105, 100, 104],
    [103, 103.5, 101, 102],
    [102, 102.5, 100.5, 101],
    [101.2, 106, 101, 104.2], // only 3 bars after the pivot
  ];
  const r = analyze(mk(rows), { swingLength: 2 });
  assert.equal(r.sweeps.length, 0);
  assert.equal(r.liquidity[0].outcome, 'minor');
});

test('fair value gap is detected, shrinks while filling and is removed when filled', () => {
  const bars = mk([
    [100, 101, 99, 100.5],
    [100.5, 106.5, 100.4, 106], // displacement candle
    [106, 107, 103, 106.5], // low 103 > high[0] 101 -> bullish FVG 101..103
    [106.5, 106.8, 102, 104], // partial fill
    [104, 104.5, 100.5, 101], // fully filled
  ]);
  const r = analyze(bars, { swingLength: 2 });
  assert.equal(r.fvgs.length, 1);
  const f = r.fvgs[0];
  assert.equal(f.dir, 1);
  assert.equal(f.origBottom, 101);
  assert.equal(f.origTop, 103);
  assert.equal(f.top, 102, 'shrinks to the unfilled part');
  assert.equal(f.endIdx, 4);
  assert.equal(f.outcome, 'filled');
  assert.deepEqual(eventsAt(r, 2).map((e) => e.type), ['FVG']);
});

test('no repainting: events on closed bars never change when more bars arrive', () => {
  const bars = synthetic(1500);
  const full = analyze(bars);
  const pick = (r, m) => ({
    structure: r.structure.filter((e) => e.idx < m).map(({ kind, dir, fromIdx, idx, price }) => ({ kind, dir, fromIdx, idx, price })),
    sweeps: r.sweeps.filter((e) => e.idx < m).map(({ dir, idx, price }) => ({ dir, idx, price })),
    setups: r.setups.filter((e) => e.idx < m).map(({ dir, idx, reasons }) => ({ dir, idx, reasons })),
    hv: r.hv.filter((e) => e.idx < m).map(({ idx }) => idx),
    obs: r.obs.filter((e) => e.createdIdx < m).map(({ dir, idx, createdIdx, top, bottom }) => ({ dir, idx, createdIdx, top, bottom })),
  });
  assert.ok(full.setups.length > 5, 'synthetic data should produce setups');
  assert.ok(full.structure.length > 10);
  for (const m of [200, 377, 640, 901, 1234, 1499]) {
    assert.deepEqual(pick(analyze(bars.slice(0, m)), m), pick(full, m), `prefix ${m}`);
  }
});

test('instruments without volume disable volume features instead of guessing', () => {
  const bars = synthetic(400).map((b) => ({ ...b, volume: 0 }));
  const r = analyze(bars);
  assert.equal(r.hasVolume, false);
  assert.equal(r.hv.length, 0);
  assert.equal(r.state.volume, 'N/A');
  assert.ok(r.setups.every((s) => !s.reasons.includes('HV')));
});

test('drawing selection keeps the chart clean', () => {
  const bars = synthetic(1500, 99);
  const r = analyze(bars);
  const sel = selectDrawings(r, bars, { maxZones: 2, maxLiquidity: 2, maxSetups: 6 });
  for (const dir of [1, -1]) {
    assert.ok(sel.fvgs.filter((z) => z.dir === dir).length <= 2);
    assert.ok(sel.obs.filter((z) => z.dir === dir).length <= 2);
    assert.ok(sel.liquidity.filter((z) => z.dir === dir && z.endIdx === null).length <= 2);
  }
  assert.ok(sel.fvgs.every((z) => z.endIdx === null), 'filled gaps are removed');
  assert.ok(sel.obs.every((z) => z.endIdx === null), 'invalidated blocks are removed');
  assert.ok(sel.setups.length <= 6);
  assert.ok(sel.structure.length <= 6);
});

test('dashboard summary is well-formed', () => {
  const r = analyze(synthetic(800, 3));
  const s = r.state;
  assert.ok(['Bullish', 'Bearish', 'Neutral'].includes(s.trend));
  assert.ok(['High', 'Normal', 'Low'].includes(s.volume));
  assert.ok(['Bullish', 'Bearish', 'Neutral'].includes(s.bias));
  assert.ok(s.structure === null || ['BOS', 'MSS'].includes(s.structure.kind));
  assert.ok(s.sweep === null || [1, -1].includes(s.sweep.dir));
  assert.deepEqual(analyze([]).state.bias, 'Neutral');
});
