import { writeFile } from 'node:fs/promises';
const symbol = process.argv[2] || 'cmd_oxauusd';
if (!/^[A-Za-z0-9_]{1,64}$/.test(symbol)) throw new Error('Invalid symbol');
const controller = new AbortController();
const limit = setTimeout(() => controller.abort(), 30000);
const samples = [];
let reader;
try {
  const response = await fetch(`http://127.0.0.1:8765/api/guru/stream?symbol=${symbol}`, { signal: controller.signal });
  if (!response.ok) throw new Error(`Feed HTTP ${response.status}`);
  reader = response.body.getReader();
  const decoder = new TextDecoder(); let buffer = '';
  while (samples.length < 15) {
    const chunk = await reader.read(); if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
      if (!frame.startsWith('data: ')) continue;
      const event = JSON.parse(frame.slice(6));
      if (!event.ticks?.length) continue;
      const receivedAt = Date.now();
      for (const tick of event.ticks) if (!samples.length || tick.time > samples.at(-1).tickAt) samples.push({ tickAt: tick.time, receivedAt, transport: event.transport, localDeliveryMs: receivedAt - event.serverTime });
    }
  }
} catch (error) {
  if (!samples.length) throw error;
} finally { clearTimeout(limit); await reader?.cancel().catch(() => {}); controller.abort(); }
const median = values => { const sorted = values.slice().sort((a,b)=>a-b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null; };
const intervals = samples.slice(1).map((s,i)=>s.tickAt-samples[i].tickAt);
const report = { capturedAt: new Date().toISOString(), symbol, events: samples.length, transports: [...new Set(samples.map(s=>s.transport))], medianBrokerTickIntervalMs: median(intervals), minimumBrokerTickIntervalMs: intervals.length ? Math.min(...intervals) : null, medianLocalPushDeliveryMs: median(samples.map(s=>s.localDeliveryMs)), maximumLocalPushDeliveryMs: samples.length ? Math.max(...samples.map(s=>s.localDeliveryMs)) : null, ordersSubmitted: 0 };
await writeFile(new URL('../analysis/live-feed-verification.json', import.meta.url), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (samples.length < 2) process.exitCode = 1;
