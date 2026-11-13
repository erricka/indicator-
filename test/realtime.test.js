import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePricing } from '../lib/realtime.js';

// A real message captured from Yahoo's streamer (EUR/USD).
const SAMPLE = 'CghFVVJVU0Q9WBXir40/GLDz9Lu6aCoDQ0NZMA44AUWEUQY+ZQAQvjrYAQj1AgAQvjr9AoRRBj4=';

test('decodes Yahoo PricingData protobuf ticks', () => {
  const t = decodePricing(SAMPLE);
  assert.equal(t.id, 'EURUSD=X');
  assert.equal(t.price, 1.1069, 'price rounded to the instrument precision (priceHint 4)');
  assert.equal(t.time, 1794553847000, 'exchange time in milliseconds');
  assert.equal(t.exchange, 'CCY');
  assert.equal(t.marketHours, 1, 'regular market');
  assert.equal(t.priceHint, 4);
});

test('decoder handles zig-zag negatives, skips unknown fields and rejects truncation', () => {
  // field 3 (time, sint64) = -1 -> zig-zag 1; field 99 (unknown, varint) = 5; field 1 (id) = "X"
  const buf = Buffer.from([0x18, 0x01, 0x98, 0x06, 0x05, 0x0a, 0x01, 0x58]);
  const t = decodePricing(buf.toString('base64'));
  assert.equal(t.time, -1);
  assert.equal(t.id, 'X');
  assert.throws(() => decodePricing(Buffer.from([0x18]).toString('base64')), /truncated/);
});
