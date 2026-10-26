export function sma(values, period = 20) {
  let sum = 0;
  return values.map((value, i) => {
    sum += value;
    if (i >= period) sum -= values[i - period];
    return i >= period - 1 ? sum / period : null;
  });
}

export function ema(values, period = 20) {
  const seed = sma(values, period);
  let last;
  return values.map((value, i) => {
    if (i < period - 1) return null;
    last = i === period - 1 ? seed[i] : value * (2 / (period + 1)) + last * (1 - 2 / (period + 1));
    return last;
  });
}

export function bollinger(values, period = 20) {
  const middle = sma(values, period);
  return middle.map((mean, i) => {
    if (mean === null) return null;
    const variance = values.slice(i - period + 1, i + 1).reduce((sum, x) => sum + (x - mean) ** 2, 0) / period;
    return { middle: mean, upper: mean + 2 * Math.sqrt(variance), lower: mean - 2 * Math.sqrt(variance) };
  });
}

export function rsi(values, period = 14) {
  let gain = 0, loss = 0;
  return values.map((value, i) => {
    if (i === 0) return null;
    const delta = value - values[i - 1];
    if (i <= period) {
      gain += Math.max(delta, 0) / period;
      loss += Math.max(-delta, 0) / period;
    } else {
      gain = (gain * (period - 1) + Math.max(delta, 0)) / period;
      loss = (loss * (period - 1) + Math.max(-delta, 0)) / period;
    }
    return i < period ? null : loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
  });
}

export function heikinAshi(candles) {
  let previous;
  return candles.map(candle => {
    const close = (candle.open + candle.high + candle.low + candle.close) / 4;
    const open = previous ? (previous.open + previous.close) / 2 : (candle.open + candle.close) / 2;
    return previous = { time: candle.time, open, close, high: Math.max(candle.high, open, close), low: Math.min(candle.low, open, close) };
  });
}

export function macd(values) {
  const fast = ema(values, 12), slow = ema(values, 26);
  const difference = slow.map((value, i) => value === null ? null : fast[i] - value);
  const signal = ema(difference.slice(25), 9);
  return difference.map((value, i) => value === null ? null : { value, signal: signal[i - 25] ?? null, histogram: signal[i - 25] == null ? null : value - signal[i - 25] });
}

export function kdj(candles, period = 9) {
  let k = 50, d = 50;
  return candles.map((candle, i) => {
    if (i < period - 1) return null;
    const window = candles.slice(i - period + 1, i + 1);
    const high = Math.max(...window.map(x => x.high)), low = Math.min(...window.map(x => x.low));
    const raw = high === low ? 50 : 100 * (candle.close - low) / (high - low);
    k = (2 * k + raw) / 3;
    d = (2 * d + k) / 3;
    return { k, d, j: 3 * k - 2 * d };
  });
}
