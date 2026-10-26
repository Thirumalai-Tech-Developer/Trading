import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp, amountCents, priceAt } from '../server.mjs';

async function launch(options = {}) {
  const app = createApp({ dbPath: ':memory:', ...options });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  function client() {
    let cookie = '', csrf = '';
    return {
      async request(route, body, method = body === undefined ? 'GET' : 'POST', extra = {}) {
        const response = await fetch(base + route, {
          method, headers: { Cookie: cookie, 'X-CSRF-Token': csrf, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const data = await response.json();
        if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
        if (data.csrf) csrf = data.csrf;
        return { status: response.status, data, headers: response.headers };
      },
      async register(suffix = 'one') {
        const result = await this.request('/api/auth/register', { name: 'Trader', email: `${suffix}@example.test`, password: 'correct horse battery' });
        assert.equal(result.status, 201, JSON.stringify(result.data));
        return result;
      },
    };
  }
  return { ...app, client, base };
}

test('money parser uses exact cents and rejects invalid or out-of-range input', () => {
  assert.equal(amountCents('123.45'), 12345);
  assert.equal(amountCents(1.2), 120);
  assert.equal(amountCents('100000'), 10000000);
  for (const value of [true, null, [], {}, '', '-1', '0', '0.01', '1e3', '1.001', 'Infinity', Infinity, NaN, '100000.01']) assert.throws(() => amountCents(value));
  assert.equal(priceAt('EURUSD', 1792800000000), priceAt('EURUSD', 1792800000000));
  assert.throws(() => priceAt('INVALID', 1));
});

test('GuruTrade HTTP routes use broker login, validate order mode, and retain confirmations', async t => {
  let submissions = 0;
  const app = await launch({ now: () => 1792900000000, guruOptions: { allowReal: false, fetchImpl: async (url, init) => {
    const endpoint = new URL(url).pathname;
    let data;
    if (endpoint === '/ou/user/webLogin') data = { userId: 'test-user', token: 'do-not-expose', accountNumber: 'broker@test.invalid' };
    else if (endpoint === '/ou/product/list/v3') data = [{ productList: [{ symbol: 'fx_test', name: 'Test', productId: 'p1', min: '10', max: '100', isLimited: '00' }] }];
    else if (endpoint === '/ou/product/list') data = [];
    else if (endpoint === '/ou/quotation/current') data = { fullPrice: '1.5', fullTime: 1792899999000 };
    else if (endpoint === '/ou/simulation/trade/submit2/auth') { submissions++; data = { positionId: 'confirmed-1' }; assert.equal(JSON.parse(init.body).buySell, -1); }
    else if (endpoint === '/ou/user/getBalance/auth') data = { balance: '50', simulation: '1000' };
    else throw new Error('Unexpected network request');
    return new Response(JSON.stringify({ status: '0', data }));
  } } });
  t.after(app.close);
  const client = app.client();
  const login = await client.request('/api/guru/login', { accountNumber: 'broker@test.invalid', passWord: 'password' });
  assert.equal(login.status, 200);
  assert.equal(login.data.loggedIn, true);
  assert.ok(!JSON.stringify(login.data).includes('do-not-expose'));
  const order = { symbol: 'fx_test', buySell: -1, amount: '20', requestId: 'http-order-1' };
  assert.equal((await client.request('/api/guru/trade', { ...order, real: 'false' })).status, 400);
  assert.equal((await client.request('/api/guru/trade', { ...order, real: true })).status, 403);
  const placed = await client.request('/api/guru/trade', { ...order, real: false });
  assert.equal(placed.status, 200);
  assert.equal(placed.data.positionId, 'confirmed-1');
  assert.equal((await client.request('/api/guru/trade', { ...order, real: false })).data.positionId, 'confirmed-1');
  assert.equal(submissions, 1);
  const history = await client.request('/api/guru/orders?demo=1');
  assert.equal(history.data.orders[0].positionId, 'confirmed-1');
  assert.equal((await client.request('/api/guru/balance?demo=garbage')).status, 400);
  assert.equal((await client.request('/api/guru/logout', {}, 'POST', { Origin: 'https://attacker.test' })).status, 403);
  await client.request('/api/guru/logout', {});
  assert.equal((await client.request('/api/guru/status')).data.loggedIn, false);
});

test('opening the terminal from an external link is allowed while cross-site APIs stay blocked', async t => {
  const app = await launch(); t.after(app.close);
  const headers = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
  // Fetch overwrites Sec-Fetch-Mode; raw HTTP preserves browser navigation metadata.
  const status = (pathname, headers) => new Promise((resolve, reject) => {
    http.get(app.base + pathname, { headers }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(await status('/', headers), 200);
  assert.equal(await status('/api/guru/status', headers), 403);
  assert.equal(await status('/', { ...headers, Origin: 'https://attacker.test' }), 403);
});

test('register/login/logout, session protection, recovery rotation, and data isolation', async t => {
  const app = await launch(); t.after(app.close);
  const alice = app.client(), bob = app.client(), guest = app.client();
  assert.equal((await guest.request('/api/session')).data.user, null);
  assert.equal((await guest.request('/api/account')).status, 401);
  const registered = await alice.register('alice');
  assert.match(registered.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal(registered.data.user.email, 'alice@example.test');
  assert.ok(!('password_hash' in registered.data.user));
  assert.equal((await alice.request('/api/account')).data.balance, 10000);
  await bob.register('bob');
  await alice.request('/api/profile', { name: 'Alice', country: 'AE', phone: '+971 123' }, 'PATCH');
  assert.equal((await bob.request('/api/account')).data.user.name, 'Trader');
  assert.equal((await alice.request('/api/wallet', { type: 'deposit', amount: 10, requestId: 'csrf-test' }, 'POST', { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await alice.request('/api/auth/logout', {})).status, 200);
  assert.equal((await alice.request('/api/account')).status, 401);
  assert.equal((await alice.request('/api/auth/login', { email: 'alice@example.test', password: 'wrong password' })).status, 401);
  assert.equal((await alice.request('/api/auth/login', { email: 'alice@example.test', password: 'correct horse battery' })).status, 200);
  const reset = await guest.request('/api/auth/recover', { email: 'alice@example.test', recoveryCode: registered.data.recoveryCode, password: 'new secure password' });
  assert.equal(reset.status, 200);
  assert.notEqual(reset.data.recoveryCode, registered.data.recoveryCode);
  assert.equal((await alice.request('/api/account')).status, 401);
  assert.equal((await guest.request('/api/auth/recover', { email: 'alice@example.test', recoveryCode: registered.data.recoveryCode, password: 'another secure password' })).status, 401);
  assert.equal((await alice.request('/api/auth/login', { email: 'alice@example.test', password: 'correct horse battery' })).status, 401);
  assert.equal((await alice.request('/api/auth/login', { email: 'ALICE@example.test', password: 'new secure password' })).status, 200);
});

test('host/origin, JSON, path and input boundaries reject hostile requests', async t => {
  const app = await launch(); t.after(app.close);
  const client = app.client(); await client.register();
  assert.equal((await client.request('/api/wallet', { type: 'deposit', amount: 1, requestId: 'origin-test' }, 'POST', { Origin: 'https://evil.example' })).status, 403);
  const hostileHost = await new Promise((resolve, reject) => {
    http.get(app.base + '/api/session', { headers: { Host: `evil.example:${app.server.address().port}` } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(hostileHost, 403);
  assert.equal((await client.request('/api/session', undefined, 'GET', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await client.request('/api/wallet', { type: 'deposit', amount: 1, requestId: 'content-type-test' }, 'POST', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await client.request('/api/preferences', { favorites: ['EVIL'], theme: 'dark' }, 'PATCH')).status, 400);
  assert.equal((await client.request('/api/candles?symbol=INVALID')).status, 400);
  assert.equal((await client.request('/api/candles?interval=1')).status, 400);
  for (const route of ['/server.mjs', '/data/trading.sqlite', '/%2e%2e%2fserver.mjs', '/%00']) assert.equal((await fetch(app.base + route)).status, 404);
});

test('wallet and trading actions are idempotent, atomic, isolated, and settle once', async t => {
  let clock = 1792800000000;
  const app = await launch({ now: () => clock }); t.after(app.close);
  const alice = app.client(), bob = app.client(); await alice.register('alice'); await bob.register('bob');
  const deposit = { type: 'deposit', amount: '10.21', requestId: 'deposit-0001' };
  assert.equal((await alice.request('/api/wallet', deposit)).data.balance, 10010.21);
  assert.equal((await alice.request('/api/wallet', deposit)).data.balance, 10010.21);
  assert.equal((await alice.request('/api/wallet', { ...deposit, amount: 20 })).status, 409);
  assert.equal((await alice.request('/api/wallet', { type: 'withdraw', amount: 20000, requestId: 'withdraw-0001' })).status, 400);
  assert.equal((await alice.request('/api/trades', { symbol: 'EURUSD', direction: 'up', amount: '0.01', duration: 5, requestId: 'trade-invalid' })).status, 400);
  const order = { symbol: 'EURUSD', direction: 'up', amount: '100.01', duration: 5, requestId: 'trade-0001' };
  const placed = await alice.request('/api/trades', order);
  assert.equal(placed.status, 201);
  assert.equal(placed.data.balance, 9910.2);
  assert.equal(placed.data.trade.payout, 80);
  assert.equal(placed.data.trade.entryPrice, priceAt('EURUSD', clock));
  const duplicate = await alice.request('/api/trades', order);
  assert.equal(duplicate.data.trade.id, placed.data.trade.id);
  assert.equal(duplicate.data.balance, 9910.2);
  assert.deepEqual((await bob.request('/api/trades')).data.trades, []);
  clock += 6000;
  const settled = (await alice.request('/api/trades')).data.trades[0];
  const won = priceAt('EURUSD', clock - 1000) > placed.data.trade.entryPrice;
  assert.equal(settled.exitPrice, priceAt('EURUSD', placed.data.trade.expiresAt));
  assert.equal(settled.status, won ? 'won' : 'lost');
  assert.equal(settled.profit, won ? 80 : -100.01);
  const expected = won ? 10090.21 : 9910.2;
  assert.equal((await alice.request('/api/account')).data.balance, expected);
  assert.equal((await alice.request('/api/account')).data.balance, expected);
  assert.equal((await alice.request('/api/account')).data.stats.trades, 1);
  assert.equal((await alice.request('/api/trades', order)).data.trade.status, settled.status);
  const withdrawal = { type: 'withdraw', amount: '9000', requestId: 'withdraw-concurrent-a' };
  const responses = await Promise.all([alice.request('/api/wallet', withdrawal), alice.request('/api/wallet', { ...withdrawal, requestId: 'withdraw-concurrent-b' })]);
  assert.deepEqual(responses.map(r => r.status).sort(), [201, 400]);
  assert.equal((await bob.request('/api/account')).data.balance, 10000);
});

test('preferences, notifications, support tickets and password changes persist privately', async t => {
  const app = await launch(); t.after(app.close);
  const alice = app.client(), secondSession = app.client(), bob = app.client();
  await alice.register('alice'); await bob.register('bob');
  await secondSession.request('/api/auth/login', { email: 'alice@example.test', password: 'correct horse battery' });
  assert.equal((await alice.request('/api/preferences', { favorites: ['BTCUSD', 'EURUSD', 'BTCUSD'], theme: 'light' }, 'PATCH')).status, 200);
  assert.deepEqual((await alice.request('/api/account')).data.preferences, { favorites: ['BTCUSD', 'EURUSD'], theme: 'light' });
  const ticket = await alice.request('/api/support', { subject: 'Practice funds', message: 'How do I add more practice funds?' });
  assert.equal(ticket.status, 201);
  assert.equal((await alice.request('/api/support')).data.tickets.length, 1);
  assert.equal((await bob.request('/api/support')).data.tickets.length, 0);
  await alice.request('/api/notifications/read', {});
  assert.ok((await alice.request('/api/notifications')).data.notifications.every(n => n.read));
  assert.equal((await alice.request('/api/auth/password', { currentPassword: 'incorrect password', password: 'updated secure password' })).status, 401);
  assert.equal((await alice.request('/api/auth/password', { currentPassword: 'correct horse battery', password: 'updated secure password' })).status, 200);
  assert.equal((await secondSession.request('/api/account')).status, 401);
  assert.equal((await alice.request('/api/account')).status, 200);
});

test('expired trades settle on restart and account/ledger survive process lifetime', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'guru-trade-test-'));
  let clock = 1792800000000;
  const options = { dbPath: path.join(folder, 'trading.sqlite'), now: () => clock };
  let app = await launch(options);
  t.after(async () => { await app.close(); await rm(folder, { recursive: true, force: true }); });
  const client = app.client(); await client.register();
  const placed = await client.request('/api/trades', { symbol: 'BTCUSD', direction: 'down', amount: 10, duration: 5, requestId: 'restart-trade' });
  assert.equal(placed.status, 201);
  await app.close(); clock += 10000;
  app = await launch(options);
  const returning = app.client();
  assert.equal((await returning.request('/api/auth/login', { email: 'one@example.test', password: 'correct horse battery' })).status, 200);
  assert.notEqual((await returning.request('/api/trades')).data.trades[0].status, 'open');
  assert.equal((await returning.request('/api/account')).data.stats.trades, 1);
  const candles = (await returning.request('/api/candles?symbol=BTCUSD&interval=15')).data.candles;
  assert.equal(candles.length, 100);
  assert.ok(candles.every(c => c.high >= c.open && c.high >= c.close && c.low <= c.open && c.low <= c.close));
  assert.equal(candles.at(-1).close, priceAt('BTCUSD', clock));
});
