import test from 'node:test';
import assert from 'node:assert/strict';
import { sma, ema, bollinger, rsi, heikinAshi, macd, kdj } from '../deferred/terminal/indicators.mjs';

test('moving averages seed correctly and bands use population deviation', () => {
  assert.deepEqual(sma([1, 2, 3, 4], 3), [null, null, 2, 3]);
  assert.deepEqual(ema([1, 2, 3, 4], 3), [null, null, 2, 3]);
  const band = bollinger([1, 2, 3], 3)[2];
  assert.equal(band.middle, 2);
  assert.ok(Math.abs(band.upper - (2 + 2 * Math.sqrt(2 / 3))) < 1e-12);
});

test('RSI handles rising, falling, and flat prices without NaN', () => {
  assert.equal(rsi(Array.from({ length: 20 }, (_, i) => i)).at(-1), 100);
  assert.equal(rsi(Array.from({ length: 20 }, (_, i) => 20 - i)).at(-1), 0);
  assert.equal(rsi(Array(20).fill(10)).at(-1), 50);
  assert.equal(rsi([1, 2, 3]).at(-1), null);
});

test('Heikin-Ashi preserves price extremes and seeds from the first candle', () => {
  const candles = [{ time: 1, open: 10, close: 12, high: 14, low: 9 }, { time: 2, open: 12, close: 14, high: 15, low: 11 }];
  const result = heikinAshi(candles);
  assert.equal(result[0].open, 11);
  assert.equal(result[0].close, 11.25);
  assert.equal(result[1].open, 11.125);
  assert.equal(result[1].high, 15);
});

test('MACD warms up before emitting a signal and flat KDJ remains neutral', () => {
  const output = macd(Array(50).fill(10));
  assert.equal(output[24], null);
  assert.deepEqual(output[33], { value: 0, signal: 0, histogram: 0 });
  assert.deepEqual(kdj(Array(20).fill({ high: 10, low: 10, close: 10 })).at(-1), { k: 50, d: 50, j: 50 });
});
