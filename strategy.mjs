import { rsi, bollinger, ema } from './deferred/terminal/indicators.mjs';

// One rule set drives both the live scanner and the backtest, so a backtested idea is exactly what gets scanned.
export const DEFAULT_RULES = Object.freeze({ tf: 60, rsiPeriod: 14, rsiLow: 30, rsiHigh: 70, bbPeriod: 20, wick: 0.5, trend: 'with', trendPeriod: 10, duration: 60, payout: 82 });
const TREND_TFS = [900, 1800];
const LIMITS = { rsiPeriod: [2, 100, true], rsiLow: [0, 100], rsiHigh: [0, 100], bbPeriod: [2, 200, true], wick: [0, 1], trendPeriod: [2, 100, true], duration: [5, 3600, true], payout: [1, 100] };
const invalid = message => Object.assign(new Error(message), { status: 400 });

export function parseRules(input = {}) {
  const rules = { ...DEFAULT_RULES };
  for (const [key, [min, max, integer]] of Object.entries(LIMITS)) {
    if (input[key] === undefined || input[key] === '') continue;
    const value = Number(input[key]);
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw invalid(`${key} must be ${integer ? 'an integer ' : ''}between ${min} and ${max}`);
    rules[key] = value;
  }
  if (input.tf !== undefined && input.tf !== '') {
    if (!['60', '300'].includes(String(input.tf))) throw invalid('tf must be 60 or 300 seconds');
    rules.tf = Number(input.tf);
  }
  if (input.trend !== undefined && input.trend !== '') {
    if (!['with', 'against', 'off'].includes(input.trend)) throw invalid('trend must be with, against or off');
    rules.trend = input.trend;
  }
  if (rules.rsiLow >= rules.rsiHigh) throw invalid('rsiLow must be below rsiHigh');
  return rules;
}

export function resample(candles, seconds) {
  const out = [];
  for (const c of candles) {
    const time = Math.floor(c.time / seconds) * seconds, last = out.at(-1);
    if (last?.time === time) { last.high = Math.max(last.high, c.high); last.low = Math.min(last.low, c.low); last.close = c.close; }
    else out.push({ time, open: c.open, high: c.high, low: c.low, close: c.close });
  }
  return out;
}

// Trend at each base bar from the last *completed* higher-timeframe bar only (no lookahead): 1 up, -1 down, 0 flat, null unknown.
export function trendSeries(candles, tf, seconds, period) {
  const higher = resample(candles, seconds), average = ema(higher.map(c => c.close), period);
  let k = -1;
  return candles.map(c => {
    while (k + 1 < higher.length && higher[k + 1].time + seconds <= c.time + tf) k++;
    return k < 0 || average[k] === null ? null : Math.sign(higher[k].close - average[k]);
  });
}

export function signals(candles, rules = DEFAULT_RULES) {
  const closes = candles.map(c => c.close), strength = rsi(closes, rules.rsiPeriod), bands = bollinger(closes, rules.bbPeriod);
  const trends = rules.trend === 'off' ? [] : TREND_TFS.map(seconds => trendSeries(candles, rules.tf, seconds, rules.trendPeriod));
  const out = [];
  candles.forEach((c, i) => {
    const band = bands[i], range = c.high - c.low;
    if (strength[i] === null || !band || range <= 0) return;
    const lowerWick = (Math.min(c.open, c.close) - c.low) / range, upperWick = (c.high - Math.max(c.open, c.close)) / range;
    // Rejection: price pierced the band, closed back inside it, and left a long wick.
    const direction = strength[i] <= rules.rsiLow && c.low <= band.lower && c.close > band.lower && lowerWick >= rules.wick ? 1
      : strength[i] >= rules.rsiHigh && c.high >= band.upper && c.close < band.upper && upperWick >= rules.wick ? -1 : 0;
    if (!direction) return;
    const wanted = rules.trend === 'with' ? direction : -direction;
    if (!trends.every(t => t[i] === wanted)) return;
    out.push({ index: i, time: c.time, direction, rsi: strength[i], lower: band.lower, upper: band.upper, trend: trends.map(t => t[i]) });
  });
  return out;
}

// prices.after(ms) / prices.before(ms) return the first tick at/after or last tick at/before a time, or null.
export function backtest(candles, prices, rules = DEFAULT_RULES) {
  const trades = [];
  let busyUntil = -Infinity;
  for (const s of signals(candles, rules)) {
    const signalAt = (s.time + rules.tf) * 1000;
    if (signalAt < busyUntil) continue; // one open trade per asset, like a manual trader
    const entry = prices.after(signalAt);
    if (!entry || entry.time - signalAt > 5000) continue;
    const expiry = entry.time + rules.duration * 1000, exit = prices.before(expiry);
    if (!exit || exit.time <= entry.time || expiry - exit.time > 5000) continue;
    const move = Math.sign(exit.price - entry.price) * s.direction;
    trades.push({ time: entry.time, direction: s.direction === 1 ? 'higher' : 'lower', entry: entry.price, exit: exit.price, result: move > 0 ? 'won' : move < 0 ? 'lost' : 'draw' });
    busyUntil = expiry;
  }
  return summarize(trades, rules.payout);
}

export function summarize(trades, payout) {
  const wins = trades.filter(t => t.result === 'won').length, losses = trades.filter(t => t.result === 'lost').length, n = wins + losses;
  const p = n ? wins / n : null, z = 1.96;
  // Wilson 95% lower bound: an edge only counts when even this pessimistic rate clears break-even.
  const low = n ? (p + z * z / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / (1 + z * z / n) : null;
  const breakEven = 1 / (1 + payout / 100), net = wins * payout / 100 - losses;
  return { trades: trades.length, wins, losses, draws: trades.length - n, winRate: p, winRateLow95: low, breakEven, netStakes: net, perTradeStakes: trades.length ? net / trades.length : null, edgeConfirmed: low !== null && low > breakEven, list: trades.slice(-500) };
}

export function createScanner({ guru, now = Date.now, minPayout = 82, maxAssets = 30, intervalMs = 15000 }) {
  let timer = null;
  async function eligible() {
    const { markets } = await guru.getMarkets();
    return markets.filter(m => m.tradable && m.payout >= minPayout).sort((a, b) => b.payout - a.payout).slice(0, maxAssets);
  }
  // Keeps collectors alive so every eligible asset accumulates stored history even when nobody is looking at it.
  async function watchAll() { for (const m of await eligible()) await guru.watch(m.symbol).catch(() => {}); }
  async function scan(rules = DEFAULT_RULES) {
    const markets = await eligible(), lookback = (rules.trend === 'off' ? rules.tf * (rules.bbPeriod + rules.rsiPeriod + 2) : Math.max(...TREND_TFS) * (rules.trendPeriod + 2)) * 1000;
    const setups = [], warming = [];
    for (const m of markets) {
      guru.watch(m.symbol).catch(() => {});
      const candles = guru.storedCandles({ symbol: m.symbol, from: now() - lookback, to: now(), interval: rules.tf });
      const last = signals(candles, rules).at(-1), latest = candles.at(-1);
      if (!latest || (latest.time - candles[0].time + rules.tf) * 1000 < lookback * 0.9) warming.push(m.symbol);
      // Only a signal on the newest bar, and only while that bar just closed, is actionable.
      if (last && last.index === candles.length - 1 && (latest.time + 2 * rules.tf) * 1000 > now()) {
        setups.push({ symbol: m.symbol, name: m.name, payout: m.payout, direction: last.direction === 1 ? 'higher' : 'lower', barTime: last.time, rsi: last.rsi, trend: last.trend, durations: m.supportedDurations });
      }
    }
    return { setups, watched: markets.map(m => m.symbol), warming, rules, minPayout, scannedAt: now() };
  }
  return {
    start() { if (!timer) { watchAll().catch(() => {}); timer = setInterval(() => watchAll().catch(() => {}), intervalMs); timer.unref?.(); } },
    stop() { clearInterval(timer); timer = null; },
    scan,
  };
}
