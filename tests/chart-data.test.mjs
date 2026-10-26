import test from 'node:test';
import assert from 'node:assert/strict';
import { chartView } from '../public/chart-data.mjs';

test('full-hour price history survives a recent dense candle window without a last-N slice', () => {
  const end = 1792900000;
  const points = Array.from({ length: 60 }, (_, i) => ({ time: end - 3600 + i * 60, value: 100 + i }));
  for (let i = 0; i < 180; i++) points.push({ time: end - 180 + i, value: 160 + i / 100 });
  const candles = [end - 180, end - 120, end - 60].map(time => ({ time, open: 160, high: 162, low: 159, close: 161 }));
  const view = chartView({ points, candles, serverTime: end * 1000 });
  assert.equal(view.start, end - 3600);
  assert.equal(view.end, end);
  assert.equal(view.points.length, points.length);
  assert.equal(view.points[0].time, end - 3600);
  assert.deepEqual(view.candles, []);
});

test('chart range clips older/future samples and zoom follows time rather than sample count', () => {
  const end = 1792900000;
  const points = [-4000, -3500, -1800, -900, -100, 1].map(offset => ({ time: end + offset, value: 10 }));
  const full = chartView({ points, serverTime: end * 1000 });
  assert.deepEqual(full.points.map(p => p.time - end), [-3500, -1800, -900, -100]);
  const zoom = chartView({ points, serverTime: end * 1000, zoom: 50 });
  assert.equal(zoom.start, end - 1800);
  assert.deepEqual(zoom.points.map(p => p.time - end), [-1800, -900, -100]);
});

test('line, area, bars and candles select their own data without suppressing OHLC', () => {
  const end = 1792900000;
  const points = [{ time: end - 3500, value: 10 }, { time: end - 0.9, value: 11 }, { time: end - 0.5, value: 12 }];
  const candles = [{ time: end - 60, open: 10, high: 12, low: 9, close: 11 }];
  for (const type of ['candles', 'bars']) {
    const view = chartView({ points, candles, serverTime: end * 1000, type });
    assert.deepEqual(view.candles, candles);
    assert.deepEqual(view.points, []);
  }
  for (const type of ['line', 'area']) {
    const view = chartView({ points, candles, serverTime: end * 1000, type });
    assert.deepEqual(view.points, points);
    assert.deepEqual(view.candles, []);
  }
});
