import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GuruBackendError, normalizeGuruCatalog, normalizeGuruPoints, decodeGuruQuotation,
  normalizeGuruTicks, aggregateGuruTicks, createGuruBackend as createBackend,
} from '../guru-backend.mjs';
const createGuruBackend = options => createBackend({ orderDbPath: ':memory:', webSocketFactory: null, ...options });

// Minimal GuruTrade-shaped fixtures (field names verified from the live probes in analysis/).
const CATALOG = [{
  productType: 'currency',
  productList: [
    { symbol: 'fx_ojpythb', name: 'JPY/THB', productId: '10095', currentPrice: '0.2341', profit: '0.82', accuracy: '4', changeRate: '0.1', isLimited: '00', currencyType: 'rupee', min: '1', max: '1000' },
    { symbol: 'fx_ojpythb', name: 'JPY/THB dup', productId: '10095', currentPrice: '0.2341' }, // duplicate symbol dropped
    { symbol: 'stk_omsft', name: 'MSFT', productId: '20001', currentPrice: '400', profit: '0.80', accuracy: '2', isLimited: '01' },
  ],
}];

// Build a getNewlist-style encoded string with the adapter's own decoder's inverse, so the decoder round-trips.
function encodeGuru(value, direction = 7, shift = 3) {
  const inner = Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
  const bytes = Buffer.from(inner, 'ascii');
  for (let i = 0; i < bytes.length; i++) {
    // decode rotates left for dir 8 and right for dir 7/9; encode applies the inverse rotation.
    bytes[i] = direction === 8 ? ((bytes[i] >>> shift) | (bytes[i] << (8 - shift))) & 255 : ((bytes[i] << shift) | (bytes[i] >>> (8 - shift))) & 255;
  }
  const hex = bytes.toString('hex');
  const header = String.fromCharCode(direction * 10 + shift);
  return Buffer.from(header + hex, 'utf8').toString('base64');
}

test('normalizeGuruCatalog dedupes by symbol, derives payout, and validates metadata', () => {
  const markets = normalizeGuruCatalog(CATALOG);
  assert.equal(markets.length, 2);
  const jpy = markets[0];
  assert.equal(jpy.symbol, 'fx_ojpythb');
  assert.equal(jpy.payout, 82); // 0.82 -> 82%
  assert.equal(jpy.tradable, true); // isLimited '00'
  assert.equal(markets[1].tradable, false); // isLimited '01'
  assert.throws(() => normalizeGuruCatalog([{ productList: [{ symbol: 'bad symbol!', productId: '1', name: 'x' }] }]), GuruBackendError);
  assert.throws(() => normalizeGuruCatalog('nope'), GuruBackendError);
});

test('normalizeGuruPoints sorts, dedupes timestamps, and rejects bad samples', () => {
  const points = normalizeGuruPoints([{ ct: 1700000060, cp: '1.1' }, { ct: 1700000000, cp: '1.0' }, { ct: 1700000000, cp: '1.05' }]);
  assert.deepEqual(points.map(p => p.time), [1700000000, 1700000060]);
  assert.equal(points[0].value, 1.05); // later duplicate wins
  assert.throws(() => normalizeGuruPoints([{ ct: 1700000000, cp: '-1' }]), GuruBackendError);
  assert.throws(() => normalizeGuruPoints([{ ct: 1, cp: '1' }]), GuruBackendError); // out of epoch range
});

test('decodeGuruQuotation round-trips the recovered web encoding and rejects garbage', () => {
  const payload = { data: [{ ct: '1700000000000', cp: '1.2345' }] };
  assert.deepEqual(decodeGuruQuotation(encodeGuru(payload, 7, 3)), payload);
  assert.deepEqual(decodeGuruQuotation(encodeGuru(payload, 9, 5)), payload);
  assert.throws(() => decodeGuruQuotation('!!!not base64'), GuruBackendError);
  assert.throws(() => decodeGuruQuotation(12345), GuruBackendError);
});

test('normalizeGuruTicks and aggregateGuruTicks build labeled derived bars, never fabricating volume', () => {
  const base = 1700000040000; // minute-aligned so a complete bar survives the partial-bar filter
  const ticks = normalizeGuruTicks([
    { ct: base, cp: '1.0' }, { ct: base + 1000, cp: '1.2' }, { ct: base + 2000, cp: '0.9' },
    { ct: base + 60000, cp: '1.1' }, { ct: base + 61000, cp: '1.3' },
  ]);
  const bars = aggregateGuruTicks(ticks, 60, base + 200000);
  assert.ok(bars.length >= 1);
  const first = bars[0];
  assert.equal(first.open, 1.0);
  assert.equal(first.high, 1.2);
  assert.equal(first.low, 0.9);
  assert.equal(first.close, 0.9);
  assert.equal(first.volume, 0); // volume is never invented
  assert.throws(() => aggregateGuruTicks(ticks, 0), GuruBackendError);
});

// --- adapter flow with a stubbed fetch (no network) ---
function stubFetch(routes) {
  return async (fullUrl, init) => {
    const endpoint = fullUrl.replace('https://api.guruserv.com', '');
    const handler = routes[endpoint] || (endpoint === '/ou/product/list' ? () => ({ status: '0', data: [] }) : null);
    if (!handler) throw new Error(`unexpected endpoint ${endpoint}`);
    const body = handler(JSON.parse(init.body));
    return {
      ok: true,
      headers: { get: () => null },
      body: (async function* () { yield Buffer.from(JSON.stringify(body)); })(),
    };
  };
}

const OK = data => () => ({ status: '0', data });

test('createGuruBackend: visitor login then markets, and caches the catalog', async () => {
  let logins = 0, catalogs = 0;
  const guru = createGuruBackend({ fetchImpl: stubFetch({
    '/ou/user/webLogin': () => { logins++; return { status: '0', data: { userId: 'u1', token: 't1', accountNumber: 'a1' } }; },
    '/ou/product/list/v3': () => { catalogs++; return { status: '0', data: CATALOG }; },
  }) });
  const first = await guru.getMarkets();
  const second = await guru.getMarkets();
  assert.equal(first.markets.length, 2);
  assert.equal(second.markets.length, 2);
  assert.equal(catalogs, 1); // catalogue cached within 30s
  assert.equal(guru.status().connected, true);
  guru.close();
});

test('createGuruBackend: quote validates freshness and rejects unknown symbols', async () => {
  const now = () => 1700000100000;
  const guru = createGuruBackend({ now, fetchImpl: stubFetch({
    '/ou/user/webLogin': () => ({ status: '0', data: { userId: 'u', token: 't', accountNumber: 'a' } }),
    '/ou/product/list/v3': OK(CATALOG),
    '/ou/quotation/current': OK({ fullPrice: '0.2342', fullTime: 1700000099000 }),
  }) });
  const quote = await guru.getQuote({ symbol: 'fx_ojpythb' });
  assert.equal(quote.price, 0.2342);
  assert.equal(quote.stale, false);
  await assert.rejects(() => guru.getQuote({ symbol: 'nope_absent' }), /absent from the current/);
  await assert.rejects(() => guru.getQuote({ symbol: 'bad symbol!' }), /valid GuruTrade instrument/);
  guru.close();
});

test('createGuruBackend: rejects upstream error status and surfaces it with a status code', async () => {
  const guru = createGuruBackend({ fetchImpl: stubFetch({
    '/ou/user/webLogin': () => ({ status: '0', data: { userId: 'u', token: 't', accountNumber: 'a' } }),
    '/ou/product/list/v3': () => ({ status: '1', code: '10100', msg: 'Required parameter missing' }),
  }) });
  await assert.rejects(() => guru.getMarkets(), err => err instanceof GuruBackendError && err.status === 502);
  guru.close();
});

test('createGuruBackend: login stores an account and trade sends the expected payload', async () => {
  const sent = [];
  const guru = createGuruBackend({ allowReal: true, now: () => 1700000100000, fetchImpl: stubFetch({
    '/ou/user/webLogin': () => ({ status: '0', data: { userId: 'ru', token: 'rt', accountNumber: 'trader@example.com' } }),
    '/ou/product/list/v3': OK(CATALOG),
    '/ou/quotation/current': OK({ fullPrice: '0.2342', fullTime: 1700000099000 }),
    '/ou/trade/submit2/auth': body => { sent.push(body); return { status: '0', data: { positionId: 'p1', openPrice: '0.2342', openPositionTimestamp: 1700000099000 } }; },
  }) });
  const login = await guru.login({ accountNumber: 'trader@example.com', passWord: 'secret' });
  assert.equal(login.real, true);
  assert.equal(guru.status().loggedIn, true);
  assert.equal(guru.status().orderExecution, true);
  const up = await guru.submitTrade({ symbol: 'fx_ojpythb', buySell: 1, amount: '10', oneClick: 1, real: true, requestId: 'real-order-1' });
  assert.equal(up.placed, true);
  assert.equal(up.buySell, 1);
  assert.equal(up.quotationTime, 1700000099000); // milliseconds, from the fresh quote's fullTime (seconds is rejected with 10316)
  assert.equal(up.positionId, 'p1');
  guru.logout();
  assert.equal(guru.status().loggedIn, false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].productId, '10095');
  assert.equal(sent[0].buySell, 1);
  assert.equal(sent[0].amount, '10');
  assert.equal(sent[0].quotationTime, 1700000099000);
  assert.equal(sent[0].token, 'rt');
  guru.close();
});

test('createGuruBackend: trade rejects bad direction/amount; real trade needs login', async () => {
  const guru = createGuruBackend({ now: () => 1700000100000, fetchImpl: stubFetch({
    '/ou/user/webLogin': () => ({ status: '0', data: { userId: 'u', token: 't', accountNumber: 'a' } }),
    '/ou/product/list/v3': OK(CATALOG),
    '/ou/quotation/current': OK({ fullPrice: '0.2342', fullTime: 1700000099000 }),
    '/ou/simulation/trade/submit2/auth': () => ({ status: '0', data: { positionId: 'd1' } }),
  }) });
  await assert.rejects(() => guru.submitTrade({ symbol: 'fx_ojpythb', buySell: 2, amount: '10' }), err => err.code === 'GURU_INVALID_TRADE');
  await assert.rejects(() => guru.submitTrade({ symbol: 'fx_ojpythb', buySell: 1, amount: '-5' }), err => err.code === 'GURU_INVALID_TRADE');
  await assert.rejects(() => guru.submitTrade({ symbol: 'stk_omsft', buySell: 1, amount: '10', requestId: 'closed-order' }), err => err.code === 'GURU_MARKET_CLOSED'); // isLimited '01'
  await assert.rejects(() => guru.submitTrade({ symbol: 'fx_ojpythb', buySell: 1, amount: '10', real: true }), err => err.code === 'GURU_NOT_AUTHENTICATED' && err.status === 401);
  // demo trade works with the anonymous visitor, no login required
  const demo = await guru.submitTrade({ symbol: 'fx_ojpythb', buySell: -1, amount: '10', requestId: 'demo-order-1' });
  assert.equal(demo.real, false);
  assert.equal(demo.buySell, -1);
  guru.close();
});

test('createGuruBackend: balance and deals require login and normalize rows', async () => {
  const guru = createGuruBackend({ fetchImpl: stubFetch({
    '/ou/user/webLogin': () => ({ status: '0', data: { userId: 'u', token: 't', accountNumber: 'a' } }),
    '/ou/user/getBalance/auth': OK({ balance: '2500.50', simulation: '9802.32', bonus: '0' }),
    '/ou/trade/unliquidated/list/auth': OK({ list: [{ positionId: 'p1', symbol: 'fx_ojpythb', buySell: '1', amount: '10', openPrice: '0.23', openPositionTimestamp: 1700000099000 }] }),
  }) });
  await assert.rejects(() => guru.getBalance(), err => err.code === 'GURU_NOT_AUTHENTICATED');
  await guru.login({ accountNumber: 'a@b.com', passWord: 'x' });
  const balance = await guru.getBalance();
  assert.equal(balance.real, 2500.5);
  assert.equal(balance.demo, 9802.32);
  assert.equal(balance.bonus, 0);
  const { deals } = await guru.getActiveDeals();
  assert.equal(deals.length, 1);
  assert.equal(deals[0].buySell, 1);
  assert.equal(deals[0].symbol, 'fx_ojpythb');
  guru.close();
});

test('createGuruBackend: getCandles aggregates dense points into OHLC bars', async () => {
  const base = 1700000040; // seconds, minute-aligned
  const dense = [];
  for (let i = 0; i <= 80; i++) dense.push({ ct: base + i * 3, cp: (1 + Math.sin(i / 5) * 0.01).toFixed(5) }); // 3-second points over ~4 min
  const guru = createGuruBackend({ now: () => (base + 400) * 1000, fetchImpl: stubFetch({
    '/ou/user/webLogin': () => ({ status: '0', data: { userId: 'u', token: 't', accountNumber: 'a' } }),
    '/ou/product/list/v3': OK(CATALOG),
    '/ou/quotation/getlist': OK(dense.filter((_, i) => i % 20 === 0)),
    '/ou/quotation/getNewlist': OK({ quotationList: dense.map(p => ({ ct: p.ct * 1000, cp: p.cp })) }),
  }) });
  const result = await guru.getCandles({ symbol: 'fx_ojpythb', interval: 60 });
  assert.equal(result.kind, 'candles');
  assert.ok(result.candles.length >= 2);
  for (const c of result.candles) { assert.ok(c.high >= c.open && c.high >= c.close && c.low <= c.open && c.low <= c.close); assert.equal(c.volume, 0); }
  assert.equal(result.provenance.nativeOhlc, false);
  guru.close();
});

test('createGuruBackend: tick collector seeds from encoded getNewlist and serves raw ms ticks', async () => {
  const base = 1700000000000; // ms
  const quotationList = Array.from({ length: 40 }, (_, i) => ({ ct: String(base + i * 500), cp: (1 + i * 0.001).toFixed(5) }));
  const guru = createGuruBackend({ now: () => base + 60000, fetchImpl: stubFetch({
    '/ou/user/webLogin': () => ({ status: '0', data: { userId: 'u', token: 't', accountNumber: 'a' } }),
    '/ou/product/list/v3': OK(CATALOG),
    '/ou/quotation/getNewlist': () => ({ status: '0', data: encodeGuru({ quotationList }, 7, 3) }),
  }) });
  const result = await guru.getTicks({ symbol: 'fx_ojpythb', since: 0, limit: 100 });
  assert.equal(result.count, 40);
  assert.equal(result.ticks[0].time, base); // milliseconds, ascending
  assert.ok(result.ticks[0].time < result.ticks[1].time);
  const partial = await guru.getTicks({ symbol: 'fx_ojpythb', since: base + 10000 });
  assert.ok(partial.count < 40 && partial.count > 0); // `since` filters to newer ticks only
  guru.close();
  assert.equal(guru.status().collectors.length, 0); // collector stopped on close
});

test('createGuruBackend: unsupported candle interval and closed adapter both error cleanly', async () => {
  const guru = createGuruBackend({ fetchImpl: stubFetch({
    '/ou/user/webLogin': () => ({ status: '0', data: { userId: 'u', token: 't', accountNumber: 'a' } }),
    '/ou/product/list/v3': OK(CATALOG),
  }) });
  await assert.rejects(() => guru.getCandles({ symbol: 'fx_ojpythb', interval: 7 }), err => err.code === 'GURU_UNSUPPORTED_INTERVAL' && err.status === 400);
  guru.close();
  await assert.rejects(() => guru.getMarkets(), err => err.code === 'GURU_CLOSED' && err.status === 503);
});
