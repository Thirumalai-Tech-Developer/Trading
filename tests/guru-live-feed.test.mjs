import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuruBackend } from '../guru-backend.mjs';
import { createApp } from '../server.mjs';
import { applyLiveTicks } from '../public/chart-data.mjs';

const NOW = 1792910400000;
function liveFixture({ stallHistory = false } = {}) {
  let now = NOW;
  const calls = [], sockets = [];
  class Socket {
    readyState = 0;
    listeners = new Map();
    constructor() {
      sockets.push(this);
      queueMicrotask(() => { this.readyState = 1; this.listeners.get('open')?.(); });
    }
    addEventListener(name, handler) { this.listeners.set(name, handler); }
    close() { this.readyState = 3; this.listeners.get('close')?.(); }
    send(raw) {
      const message = JSON.parse(raw);
      if (message.businessType === 'QUOTATION_LIST') queueMicrotask(() => this.message('QUOTATION_LIST', [{ ct: now - 100, cp: 2 }]));
      if (message.businessType === 'QUOTATION_HIS' && !stallHistory) queueMicrotask(() => this.message('QUOTATION_HIS', [{ ct: now - 3600100, cp: 1 }]));
    }
    message(businessType, quotationList) { this.listeners.get('message')?.({ data: JSON.stringify({ businessType, data: { symbol: 'cmd_test', quotationList } }) }); }
  }
  const options = {
    now: () => now, orderDbPath: ':memory:', webSocketFactory: () => new Socket(),
    fetchImpl: async (url) => {
      const endpoint = new URL(url).pathname; calls.push(endpoint);
      let data;
      if (endpoint === '/ou/product/list/v3') data = { productData: [], productInfoAll: [{ symbol: 'cmd_test', productId: '30001', name: 'Test commodity', productType: 'Commodities', isLimited: '00', accuracy: 4 }] };
      else if (endpoint === '/ou/product/list') data = [];
      else if (endpoint === '/ou/user/webLogin') data = { userId: 'fixture', token: 'private-test-token', accountNumber: 'fixture-account' };
      else throw new Error(`Unexpected request ${endpoint}`);
      return new Response(JSON.stringify({ status: '0', data }));
    },
  };
  return { options, calls, sockets, tick(price, advance = 50) { now += advance; sockets[0].message('QUOTATION', [{ ct: now, cp: price }]); return now; } };
}

test('live subscriptions push ticks immediately and getQuote uses the same source', async t => {
  const fixture = liveFixture(), received = [];
  const guru = createGuruBackend(fixture.options); t.after(() => guru.close());
  const detach = await guru.subscribeTicks({ symbol: 'cmd_test', onTicks: update => received.push(update) });
  assert.equal(received.length, 1); // one current snapshot, not each historical page
  assert.equal(received[0].ticks[0].price, 2);
  const timestamp = fixture.tick(2.1);
  assert.equal(received.length, 2);
  assert.equal(received[1].ticks[0].time, timestamp);
  assert.equal(received[1].transport, 'websocket');
  const quote = await guru.getQuote({ symbol: 'cmd_test' });
  assert.equal(quote.price, 2.1); assert.equal(quote.quotedAt, timestamp);
  assert.equal(fixture.calls.includes('/ou/quotation/current'), false);
  detach(); fixture.tick(2.2);
  assert.equal(received.length, 2);
});

test('a cold subscription receives live ticks while the hour backfill is still loading', async () => {
  const fixture = liveFixture({ stallHistory: true }), received = [];
  const guru = createGuruBackend(fixture.options);
  const subscribed = guru.subscribeTicks({ symbol: 'cmd_test', onTicks: update => received.push(update) });
  while (!fixture.sockets[0] || fixture.sockets[0].readyState !== 1) await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  const timestamp = fixture.tick(2.1);
  assert.equal(received.length, 1);
  assert.equal(received[0].ticks[0].time, timestamp);
  guru.close();
  await subscribed.catch(() => {});
  assert.equal(received.length, 1); // no stale snapshot after a live tick was already delivered
});

test('HTTP SSE sends public price events and shuts down cleanly with open clients', async t => {
  const fixture = liveFixture();
  const app = createApp({ dbPath: ':memory:', now: fixture.options.now, guruOptions: fixture.options });
  let closed = false; t.after(() => closed ? undefined : app.close());
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await fetch(base + '/api/guru/stream?symbol=bad%20symbol')).status, 400);
  assert.equal((await fetch(base + '/api/guru/stream?symbol=cmd_test', { headers: { Origin: 'https://attacker.test' } })).status, 403);
  const response = await fetch(base + '/api/guru/stream?symbol=cmd_test');
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '';
  async function nextEvent() {
    for (;;) {
      const end = buffer.indexOf('\n\n');
      if (end >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (frame.startsWith('data: ')) return JSON.parse(frame.slice(6));
        continue;
      }
      const result = await reader.read();
      if (result.done) return null;
      buffer += decoder.decode(result.value, { stream: true });
    }
  }
  const snapshot = await nextEvent();
  assert.equal(snapshot.ticks[0].price, 2);
  assert.ok(!JSON.stringify(snapshot).includes('private-test-token'));
  fixture.tick(2.15);
  const pushed = await nextEvent();
  assert.equal(pushed.ticks[0].price, 2.15);
  assert.equal(pushed.serverTime, NOW + 50);
  await app.close(); closed = true;
  assert.equal(await nextEvent(), null);
});

test('live chart preserves subsecond ticks and updates the forming candle without losing history', () => {
  const previous = { time: NOW / 1000 - 60, open: 1, high: 2, low: 1, close: 2 };
  const chart = { candles: [previous], points: [{ time: NOW / 1000 - 1, value: 2 }] };
  const update = applyLiveTicks(chart, [{ time: NOW + 50, price: 2.1 }, { time: NOW + 100, price: 1.9 }], 60, NOW + 100);
  assert.equal(update.points.length, 3);
  assert.equal(update.candles.length, 2);
  assert.deepEqual(update.candles[0], { ...previous, forming: false });
  assert.equal(update.candles[1].open, 2.1);
  assert.equal(update.candles[1].high, 2.1);
  assert.equal(update.candles[1].low, 1.9);
  assert.equal(update.candles[1].close, 1.9);
  assert.equal(update.candles[1].forming, true);
  const next = applyLiveTicks(update, [{ time: NOW + 60050, price: 2.2 }], 60, NOW + 60050);
  assert.equal(next.candles[1].forming, false);
  assert.equal(next.candles[2].forming, true);
  assert.equal(chart.points.length, 1); // input snapshot is immutable
});

test('sparse fallback history does not become invented historical OHLC during live updates', () => {
  const points = Array.from({ length: 59 }, (_, i) => ({ time: NOW / 1000 - (59 - i) * 60, value: 2 }));
  const result = applyLiveTicks({ points, candles: [] }, [{ time: NOW + 100, price: 2.1 }], 60, NOW + 100, false);
  assert.equal(result.candles.length, 1);
  assert.equal(result.candles[0].partial, true);
  for (const bad of [{ time: NOW, price: 0 }, { time: NOW + 0.5, price: 2 }, { time: NOW, price: NaN }]) assert.throws(() => applyLiveTicks({ points: [], candles: [] }, [bad], 60, NOW));
});
