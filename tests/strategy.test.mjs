import test from 'node:test';
import assert from 'node:assert/strict';
import { backtest, parseRules, signals, summarize, trendSeries } from '../strategy.mjs';

// 30 falling minute bars, then a bar that pierces the lower band and closes back inside with a long lower wick.
function oversoldRejection() {
  const candles = Array.from({ length: 30 }, (_, i) => { const close = 100 - i * 0.1; return { time: i * 60, open: close + 0.1, high: close + 0.12, low: close - 0.02, close }; });
  candles.push({ time: 1800, open: 97.12, high: 97.14, low: 95, close: 97.1 });
  return candles;
}
const OFF = parseRules({ trend: 'off' });

test('an oversold band rejection is a Higher signal on that bar only', () => {
  const found = signals(oversoldRejection(), OFF);
  assert.equal(found.length, 1);
  assert.equal(found[0].index, 30);
  assert.equal(found[0].direction, 1);
  assert.equal(signals(oversoldRejection().slice(0, 30), OFF).length, 0);
  assert.equal(signals(oversoldRejection(), parseRules({ trend: 'off', wick: 1 })).length, 0);
});

test('trend filter uses only completed higher-timeframe bars', () => {
  const candles = Array.from({ length: 120 }, (_, i) => ({ time: i * 60, open: i, high: i + 1, low: i - 1, close: i + 0.5 }));
  const trend = trendSeries(candles, 60, 900, 3);
  assert.equal(trend[43], null); // only two 15m bars have closed by minute 44
  assert.equal(trend[44], 1);
  // Trading with the trend, a Higher signal needs both 15m and 30m trends up.
  assert.equal(signals(oversoldRejection(), parseRules({ trend: 'with', trendPeriod: 2 })).length, 0); // falling 15m, unknown 30m
});

test('backtest enters after the signal bar, exits at expiry, and scores against break-even', () => {
  const ticks = [{ time: 1860000, price: 97.1 }, { time: 1919000, price: 97.3 }];
  const prices = { after: t => ticks.find(x => x.time >= t) ?? null, before: t => ticks.findLast(x => x.time <= t) ?? null };
  const result = backtest(oversoldRejection(), prices, OFF);
  assert.equal(result.trades, 1);
  assert.equal(result.wins, 1);
  assert.deepEqual(result.list[0], { time: 1860000, direction: 'higher', entry: 97.1, exit: 97.3, result: 'won' });
  assert.equal(backtest(oversoldRejection(), { after: () => null, before: () => null }, OFF).trades, 0); // no data, no trade
});

test('summary needs the pessimistic win rate above break-even to call an edge', () => {
  const trades = n => Array.from({ length: n }, (_, i) => ({ result: i % 10 < 6 ? 'won' : 'lost' }));
  assert.ok(Math.abs(summarize([], 82).breakEven - 0.5495) < 1e-4);
  assert.equal(summarize(trades(20), 82).edgeConfirmed, false); // 60% on 20 trades is noise
  assert.equal(summarize(trades(2000), 82).edgeConfirmed, true);
  assert.equal(summarize(trades(10), 82).netStakes, 6 * 0.82 - 4);
});

test('rule input is validated', () => {
  for (const bad of [{ rsiLow: 80 }, { tf: 120 }, { trend: 'up' }, { duration: 1.5 }, { wick: 'x' }]) assert.throws(() => parseRules(bad), { status: 400 });
  assert.equal(parseRules({ rsiLow: '25', duration: '30' }).rsiLow, 25);
});
