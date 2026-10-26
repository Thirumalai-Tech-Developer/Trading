import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuruBackend, normalizeGuruCatalog } from '../guru-backend.mjs';

// Shape recovered from the supplied APK's ProductTotalBean and live list/v3 response.
const TIMES = [{ timeUnit: 5, timeUnitType: 's', profit: 0 }, { timeUnit: 10, timeUnitType: 's', profit: 0 }, { timeUnit: 15, timeUnitType: 's', profit: 0 }, { timeUnit: 1, timeUnitType: 'm', profit: 0 }, { timeUnit: 3, timeUnitType: 'm', profit: 0 }, { timeUnit: 5, timeUnitType: 'm', profit: 0 }];
const GOLD = { symbol: 'cmd_oxauusd', productId: '30020', name: 'Gold (OTC)', productType: 'Commodities', isLimited: '00', currentPrice: 2000, accuracy: 2, profit: 0.3, min: 20, max: 5000, unit: '1MIN', tradeTimeRespList: TIMES };
const COFFEE = { ...GOLD, symbol: 'cmd_ocoffee', productId: '30186', name: 'Coffee (OTC)', isLimited: '01' };
const STOCK = { ...GOLD, symbol: 'stk_test', productId: '30001', name: 'Test stock', productType: 'Stocks' };
const APP = { productData: [{ productType: 'Popular', productIds: ['30020','30186','30001'] }, { productType: 'Commodities', productIds: ['30020','30186'] }], productInfoAll: [GOLD, COFFEE, STOCK] };
const MASTER = [{ ...GOLD, productId: '40020', aType: '4' }, { symbol: 'fx_unavailable', productId: '10188', name: 'Unavailable forex', productType: 'Currencies', unit: '1MIN' }];
const NOW = 1792900000000;

test('app v3 metadata preserves commodity categories, all symbols, and product variants', () => {
  const markets = normalizeGuruCatalog(APP, MASTER);
  assert.equal(markets.length, 4);
  const gold = markets.find(m => m.symbol === GOLD.symbol);
  assert.equal(gold.category, 'Commodities');
  assert.equal(gold.productId, '30020');
  assert.deepEqual(gold.variants.map(v => v.productId), ['30020','40020']);
  assert.deepEqual(gold.supportedDurations, [5,10,15,60,180,300]);
  assert.equal(gold.durationSource, 'tradeTimeRespList');
  assert.equal(markets.find(m => m.symbol === COFFEE.symbol).tradable, false);
  const unavailable = markets.find(m => m.symbol === 'fx_unavailable');
  assert.equal(unavailable.catalogueSource, 'master');
  assert.equal(unavailable.marketStatus, 'unavailable');
  assert.equal(unavailable.tradable, false);
});

test('app v3 rejects missing product metadata and malformed explicit duration options', () => {
  assert.throws(() => normalizeGuruCatalog({ ...APP, productInfoAll: [GOLD] }), { code: 'GURU_BAD_CATALOG' });
  assert.throws(() => normalizeGuruCatalog({ productData: [], productInfoAll: [{ ...GOLD, tradeTimeRespList: [{ timeUnit: 1.5, timeUnitType: 's' }] }] }), { code: 'GURU_BAD_CATALOG' });
});

function adapter({ masterFails = false } = {}) {
  let clock = NOW;
  const calls = [];
  const guru = createGuruBackend({ now: () => clock, orderDbPath: ':memory:', webSocketFactory: null, fetchImpl: async (url, init) => {
    const endpoint = new URL(url).pathname, body = JSON.parse(init.body);
    calls.push({ endpoint, body });
    let data;
    if (endpoint === '/ou/product/list/v3') {
      assert.equal(body.appSource, 'GP'); assert.equal(body.interfaceVersion, '3.0');
      data = APP;
    } else if (endpoint === '/ou/product/list') {
      if (masterFails) return new Response(JSON.stringify({ status: '1', code: 'MASTER_UNAVAILABLE' }));
      data = MASTER;
    } else if (endpoint === '/ou/user/webLogin') data = { userId: 'u', token: 't', accountNumber: 'fixture' };
    else if (endpoint === '/ou/quotation/current') data = { fullPrice: 2000, fullTime: clock - 100 };
    else if (endpoint === '/ou/simulation/trade/submit3/auth') data = { positionId: `position-${calls.length}` };
    else throw new Error('Unexpected request');
    return new Response(JSON.stringify({ status: '0', data }));
  } });
  return { guru, calls, advance: ms => { clock += ms; } };
}

test('adapter loads app and master catalogues and caches static master metadata', async t => {
  const { guru, calls, advance } = adapter(); t.after(() => guru.close());
  const result = await guru.getMarkets();
  assert.equal(result.catalogueComplete, true);
  assert.equal(result.markets.length, 4);
  assert.equal(result.productVariantCount, 5);
  advance(31000);
  const second = await guru.getMarkets();
  assert.equal(second.serverTime, NOW + 31000);
  assert.equal(calls.filter(c => c.endpoint === '/ou/product/list').length, 1);
  assert.equal(calls.filter(c => c.endpoint === '/ou/product/list/v3').length, 2);
});

test('a missing master source is reported as partial rather than claiming a complete catalogue', async t => {
  const { guru } = adapter({ masterFails: true }); t.after(() => guru.close());
  const result = await guru.getMarkets();
  assert.equal(result.markets.length, 3);
  assert.equal(result.catalogueComplete, false);
  assert.match(result.catalogueWarning, /Master catalogue/);
});

test('timed orders send the APK timeUnit/timeUnitType fields for seconds and minutes', async t => {
  const { guru, calls } = adapter(); t.after(() => guru.close());
  for (const duration of [5,10,15,60,180,300]) {
    const result = await guru.submitTrade({ symbol: GOLD.symbol, buySell: 1, amount: 20, duration, requestId: `timed-order-${duration}` });
    assert.equal(result.duration, duration);
    const body = calls.filter(c => c.endpoint.includes('/trade/submit')).at(-1).body;
    assert.equal(calls.filter(c => c.endpoint.includes('/trade/submit')).at(-1).endpoint, '/ou/simulation/trade/submit3/auth');
    assert.equal(body.productId, GOLD.productId);
    assert.equal(body.timeUnit, duration < 60 ? duration : duration / 60);
    assert.equal(body.timeUnitType, duration < 60 ? 's' : 'm');
  }
  await assert.rejects(guru.submitTrade({ symbol: GOLD.symbol, buySell: 1, amount: 20, duration: 120, requestId: 'unsupported-expiry' }), { code: 'GURU_UNSUPPORTED_DURATION' });
  await assert.rejects(guru.submitTrade({ symbol: 'fx_unavailable', buySell: 1, amount: 20, requestId: 'unavailable-order' }), { code: 'GURU_MARKET_CLOSED' });
  assert.equal(calls.filter(c => c.endpoint.includes('/trade/submit')).length, 6);
});
