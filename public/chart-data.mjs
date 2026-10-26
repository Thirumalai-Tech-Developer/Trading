export function chartView({ candles = [], points = [], serverTime = Date.now(), zoom = 100, type = 'auto' } = {}) {
  const end = serverTime / 1000;
  const start = end - 3600 * Math.max(15, Math.min(100, zoom)) / 100;
  const visiblePoints = points.filter(p => p.time >= start && p.time <= end);
  const visibleCandles = candles.filter(c => c.time >= start && c.time <= end);
  // Older close samples contain useful history but cannot supply OHLC extremes.
  const usePoints = visiblePoints.length && (['line', 'area'].includes(type) || (!['bars', 'candles'].includes(type) && (visibleCandles.length < 2 || visiblePoints[0].time < visibleCandles[0].time)));
  return { start, end, points: usePoints ? visiblePoints : [], candles: usePoints ? [] : visibleCandles };
}

export function applyLiveTicks({ points = [], candles = [] }, ticks, interval, serverTime, denseHistory = true) {
  if (!Number.isInteger(interval) || interval < 1 || interval > 3600 || !Number.isFinite(serverTime) || !Array.isArray(ticks)) throw new Error('Invalid live chart update');
  const merged = new Map(points.map(p => [p.time, p.value]));
  const touched = new Map();
  for (const tick of ticks) {
    if (!Number.isInteger(tick.time) || !Number.isFinite(tick.price) || tick.price <= 0 || tick.time < 946684800000 || tick.time > serverTime + 60000) throw new Error('Invalid live price tick');
    if (tick.time < serverTime - 3600000) continue;
    const time = tick.time / 1000;
    merged.set(time, tick.price);
    const bucket = Math.floor(time / interval) * interval;
    if (!touched.has(bucket)) touched.set(bucket, []);
    touched.get(bucket).push({ time, value: tick.price });
  }
  const resultPoints = [...merged].filter(([time]) => time >= serverTime / 1000 - 3600 && time <= serverTime / 1000 + 60).sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time, value }));
  const bars = new Map(candles.map(c => [c.time, { ...c }]));
  for (const [time, received] of touched) {
    const samples = denseHistory ? resultPoints.filter(p => p.time >= time && p.time < time + interval) : received.sort((a, b) => a.time - b.time);
    if (!samples.length) continue;
    const previous = bars.get(time);
    const values = samples.map(p => p.value);
    bars.set(time, { time, open: !denseHistory && previous ? previous.open : samples[0].value, high: Math.max(...values, ...(!denseHistory && previous ? [previous.high] : [])), low: Math.min(...values, ...(!denseHistory && previous ? [previous.low] : [])), close: samples.at(-1).value, volume: 0, observations: samples.length, partial: !denseHistory });
  }
  return { points: resultPoints, candles: [...bars.values()].filter(c => c.time >= serverTime / 1000 - 3600).sort((a, b) => a.time - b.time).map(c => ({ ...c, forming: (c.time + interval) * 1000 > serverTime })) };
}
