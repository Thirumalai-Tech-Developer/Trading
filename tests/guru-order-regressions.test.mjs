import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGuruBackend, brokerDuration } from '../guru-backend.mjs';

const NOW = 1792900000000;
const ORDER = { symbol: 'fx_test', buySell: 1, amount: '20', requestId: 'order-unique-1' };
function fixture(overrides = {}, options = {}) {
  const calls = [];
  const routes = {
    '/ou/product/list': [],
    '/ou/user/webLogin': { userId: 'u', token: 'private-token', accountNumber: 'account@test.invalid' },
    '/ou/product/list/v3': [{ productList: [{ symbol: 'fx_test', productId: '42', name: 'Test', isLimited: '00', min: '10', max: '100', profit: '0.8', accuracy: '4', unit: '1MIN' }] }],
    '/ou/quotation/current': { fullPrice: '1.25', fullTime: NOW - 1000 },
    '/ou/simulation/trade/submit2/auth': { positionId: 'demo-position' },
    '/ou/trade/submit2/auth': { positionId: 'real-position' },
    '/ou/user/getBalance/auth': { balance: '100', simulation: '1000', bonus: '0' },
    '/ou/simulation/trade/unliquidated/list/auth': [],
    ...overrides,
  };
  const guru = createGuruBackend({ now: () => NOW, orderDbPath: ':memory:', webSocketFactory: null, ...options, fetchImpl: async (url, init) => {
    const endpoint = new URL(url).pathname, body = JSON.parse(init.body);
    calls.push({ endpoint, body });
    if (!(endpoint in routes)) throw new Error('Unexpected request');
    const route = routes[endpoint];
    const result = typeof route === 'function' ? await route(body) : { status: '0', data: route };
    return new Response(JSON.stringify(result));
  } });
  return { guru, calls };
}
const submissions = calls => calls.filter(c => c.endpoint.includes('/trade/submit'));

test('real policy is enforced at the adapter for every caller', async t => {
  const { guru, calls } = fixture({}, { allowReal: false }); t.after(() => guru.close());
  await guru.login({ accountNumber: 'account@test.invalid', passWord: 'password' });
  await assert.rejects(guru.submitTrade({ ...ORDER, real: true }), { code: 'GURU_REAL_DISABLED' });
  assert.equal(guru.status().orderExecution, false);
  assert.equal(submissions(calls).length, 0);
});

test('amount precision, instrument limits, request IDs and boolean modes reject before a submission', async t => {
  const { guru, calls } = fixture(); t.after(() => guru.close());
  for (const change of [{ amount: '1' }, { amount: '101' }, { amount: '20.001' }, { amount: '2e1' }, { amount: true }, { real: 'false' }, { requestId: undefined }]) {
    await assert.rejects(guru.submitTrade({ ...ORDER, ...change }), { code: 'GURU_INVALID_TRADE' });
  }
  assert.equal(submissions(calls).length, 0);
});

test('duration choices follow product metadata and unsupported durations never place an order', async t => {
  assert.equal(brokerDuration('1MIN'), 60);
  assert.equal(brokerDuration('5SEC'), 5);
  assert.equal(brokerDuration('15S'), 15);
  assert.equal(brokerDuration('unknown'), null);
  const { guru, calls } = fixture(); t.after(() => guru.close());
  assert.deepEqual((await guru.getMarkets()).markets[0].supportedDurations, [60]);
  for (const duration of [5, 10, 15, 30, '60', 1.5]) await assert.rejects(guru.submitTrade({ ...ORDER, duration }), { code: 'GURU_UNSUPPORTED_DURATION' });
  assert.equal(submissions(calls).length, 0);
  const result = await guru.submitTrade({ ...ORDER, duration: 60 });
  assert.equal(result.duration, 60);
  assert.equal(submissions(calls).length, 1);
  assert.ok(!('timeUnit' in submissions(calls)[0].body));
});

test('stale quotes cannot place trades even when the catalog is fresh', async t => {
  const { guru, calls } = fixture({ '/ou/quotation/current': { fullPrice: '1.25', fullTime: NOW - 31000 } }); t.after(() => guru.close());
  await assert.rejects(guru.submitTrade(ORDER), { code: 'GURU_STALE_QUOTE' });
  assert.equal(submissions(calls).length, 0);
});

test('concurrent and repeated order requests submit once, and conflicts reject', async t => {
  const { guru, calls } = fixture(); t.after(() => guru.close());
  const [a, b] = await Promise.all([guru.submitTrade(ORDER), guru.submitTrade(ORDER)]);
  assert.equal(a.positionId, b.positionId);
  assert.deepEqual(await guru.submitTrade(ORDER), a);
  await assert.rejects(guru.submitTrade({ ...ORDER, amount: '21' }), { code: 'GURU_ORDER_CONFLICT' });
  assert.equal(submissions(calls).length, 1);
  const history = await guru.getOrderHistory({ demo: true });
  assert.equal(history.orders[0].state, 'confirmed');
  assert.equal(history.settlementAvailable, false);
  assert.ok(!JSON.stringify(history).includes('private-token'));
});

test('a lost response stays unconfirmed across restart and cannot resubmit', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'guru-journal-'));
  let second;
  t.after(async () => { first.guru.close(); second?.guru.close(); await rm(folder, { recursive: true, force: true }); });
  const orderDbPath = path.join(folder, 'orders.sqlite');
  const first = fixture({ '/ou/simulation/trade/submit2/auth': () => { throw new Error('Socket closed after order accepted'); } }, { orderDbPath });
  await assert.rejects(first.guru.submitTrade(ORDER), { code: 'GURU_ORDER_UNKNOWN' });
  assert.equal(submissions(first.calls).length, 1);
  first.guru.close();
  second = fixture({}, { orderDbPath });
  await assert.rejects(second.guru.submitTrade(ORDER), { code: 'GURU_ORDER_UNKNOWN' });
  assert.equal(submissions(second.calls).length, 0);
  assert.equal((await second.guru.getOrderHistory({ demo: true })).orders[0].state, 'unconfirmed');
});

test('a success envelope without an order ID is not reported as a placed trade', async t => {
  const { guru, calls } = fixture({ '/ou/simulation/trade/submit2/auth': {} }); t.after(() => guru.close());
  await assert.rejects(guru.submitTrade(ORDER), { code: 'GURU_ORDER_UNKNOWN' });
  await assert.rejects(guru.submitTrade(ORDER), { code: 'GURU_ORDER_UNKNOWN' });
  assert.equal(submissions(calls).length, 1);
});

test('expired account sessions clear login and execution readiness', async t => {
  const { guru } = fixture({ '/ou/user/getBalance/auth': () => ({ status: '2' }) }, { allowReal: true }); t.after(() => guru.close());
  await guru.login({ accountNumber: 'account@test.invalid', passWord: 'password' });
  await assert.rejects(guru.getBalance(), { code: 'GURU_SESSION_EXPIRED' });
  assert.equal(guru.status().loggedIn, false);
  assert.equal(guru.status().orderExecution, false);
});

test('logout invalidates a pending login rather than allowing it to restore the account', async t => {
  let resolveLogin;
  const { guru } = fixture({ '/ou/user/webLogin': () => new Promise(resolve => { resolveLogin = resolve; }) }); t.after(() => guru.close());
  const pending = guru.login({ accountNumber: 'account@test.invalid', passWord: 'password' });
  guru.logout();
  resolveLogin({ status: '0', data: { userId: 'u', token: 't', accountNumber: 'a' } });
  await assert.rejects(pending, { code: 'GURU_SESSION_CHANGED' });
  assert.equal(guru.status().loggedIn, false);
});

test('anonymous demo balances/deals work and invalid balances do not become zero', async t => {
  const { guru } = fixture(); t.after(() => guru.close());
  const b = await guru.getBalance({ demo: true });
  assert.equal(b.demo, 1000); assert.equal(b.real, null);
  assert.deepEqual((await guru.getActiveDeals({ demo: true })).deals, []);
  const bad = fixture({ '/ou/user/getBalance/auth': { simulation: 'unknown' } }); t.after(() => bad.guru.close());
  await assert.rejects(bad.guru.getBalance({ demo: true }), { code: 'GURU_BAD_BALANCE' });
});

test('minute samples remain line history and every advertised chart interval is supported', async t => {
  const { guru } = fixture({
    '/ou/quotation/getlist': Array.from({ length: 10 }, (_, i) => ({ ct: Math.floor(NOW / 1000) - (10 - i) * 60, cp: '1.25' })),
    '/ou/quotation/getNewlist': { quotationList: [] },
  }); t.after(() => guru.close());
  for (const interval of [5, 15, 60, 180, 300, 900, 1800, 3600]) {
    const chart = await guru.getCandles({ symbol: 'fx_test', interval });
    assert.equal(chart.kind, 'line'); assert.deepEqual(chart.candles, []); assert.equal(chart.points.length, 10);
  }
  await assert.rejects(guru.getTicks({ symbol: 'fx_test', since: -1 }), { code: 'GURU_INVALID_QUERY' });
  await assert.rejects(guru.getTicks({ symbol: 'fx_test', limit: 0 }), { code: 'GURU_INVALID_QUERY' });
});
