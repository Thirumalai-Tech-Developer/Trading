import test from 'node:test';
import assert from 'node:assert/strict';
import { connectGuruStream, guruSocketUrl } from '../guru-stream.mjs';
import { normalizeGuruTicks } from '../guru-backend.mjs';

class Socket {
  readyState = 0;
  handlers = new Map();
  sent = [];
  addEventListener(name, action) { this.handlers.set(name, action); }
  send(message) { this.sent.push(JSON.parse(message)); }
  close() { this.readyState = 3; this.handlers.get('close')?.(); }
  open() { this.readyState = 1; this.handlers.get('open')(); }
  message(businessType, data) { this.handlers.get('message')({ data: JSON.stringify({ businessType, data }) }); }
}
const session = { userId: 'test-user', accountNumber: 'test@example.invalid', token: 'test-token' };

test('socket authentication preserves the broker-required raw Base64 signature', () => {
  const url = guruSocketUrl(session, 'device', () => 'a+b/c==');
  assert.ok(url.includes('&sign=a+b/c==&appSource=WEB'));
  assert.ok(!url.includes('%2B'));
  assert.ok(url.includes('accountNumber=test@example.invalid'));
  assert.ok(!url.includes(session.token));
});

test('socket backfills an hour, preserves subsecond ticks and receives live updates', async t => {
  const socket = new Socket(), ticks = new Map(), errors = [];
  const now = 1792900000000;
  const stream = connectGuruStream({ session, deviceId: 'device', symbol: 'fx_test', productId: '42', now: () => now, socketFactory: () => socket, decode: value => value, onError: error => errors.push(error), onTicks: rows => {
    const result = normalizeGuruTicks(rows);
    for (const tick of result) ticks.set(tick.time, tick.price);
    return result;
  } }); t.after(() => stream.close());
  socket.open();
  assert.deepEqual(socket.sent.map(m => m.businessType), ['HEARTBEAT', 'PRODUCT_CHOOSE', 'QUOTATION_LIST']);
  socket.message('QUOTATION_LIST', { symbol: 'fx_test', quotationList: [{ ct: now - 500, cp: 2 }, { ct: now - 900, cp: 1 }, { ct: now - 180000, cp: 1.5 }] });
  assert.equal(socket.sent.at(-1).businessType, 'QUOTATION_HIS');
  assert.equal(socket.sent.at(-1).data.startTime, now - 180000);
  socket.message('QUOTATION_HIS', { symbol: 'fx_test', quotationList: [{ ct: now - 3601000, cp: 1.1 }, { ct: now - 180001, cp: 1.2 }] });
  await stream.ready;
  assert.equal(stream.historyComplete(), true);
  assert.equal(ticks.size, 5);
  assert.equal(ticks.get(now - 900), 1);
  assert.equal(ticks.get(now - 500), 2);
  socket.message('QUOTATION', { symbol: 'other', ct: now, cp: 99 });
  assert.equal(ticks.size, 5);
  socket.message('QUOTATION', { symbol: 'fx_test', ct: now, cp: 1.8 });
  assert.equal(ticks.get(now), 1.8);
  assert.equal(stream.healthy(), true);
  assert.deepEqual(errors, []);
});

test('rejected socket authentication resolves readiness for REST fallback and closes the socket', async () => {
  const socket = new Socket(), errors = [];
  const stream = connectGuruStream({ session, deviceId: 'device', symbol: 'fx_test', productId: '42', socketFactory: () => socket, decode: value => value, onTicks: () => [], onError: error => errors.push(error) });
  socket.open(); socket.message('LOGIN_FAIL');
  await stream.ready;
  assert.equal(stream.historyComplete(), false);
  assert.equal(stream.healthy(), false);
  assert.equal(socket.readyState, 3);
  assert.equal(errors.length, 1);
});
