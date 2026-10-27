import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBarsReader, dataQuery, barsCSV } from './market-data.mjs';
import { createGuruBackend } from './guru-backend.mjs';
import { backtest, createScanner, parseRules, summarize } from './strategy.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const derive = promisify(scrypt);
const hash = value => createHash('sha256').update(value).digest('hex');
const dollars = cents => cents / 100;
const SESSION_MS = 7 * 86400000;
const PAYOUT = 80;
const TIMEFRAMES = { '1m': 60, '5m': 300, '15m': 900 };
const MARKETS = [
  ['EURUSD', 'EUR/USD', 'Forex', 1.0864, 5],
  ['GBPUSD', 'GBP/USD', 'Forex', 1.2941, 5],
  ['USDJPY', 'USD/JPY', 'Forex', 149.42, 3],
  ['AUDUSD', 'AUD/USD', 'Forex', 0.6642, 5],
  ['EURJPY', 'EUR/JPY', 'Forex', 162.31, 3],
  ['BTCUSD', 'Bitcoin', 'Crypto', 67420, 2],
  ['ETHUSD', 'Ethereum', 'Crypto', 2624.8, 2],
  ['XAUUSD', 'Gold', 'Commodities', 2721.5, 2],
];

export function priceAt(symbol, milliseconds) {
  const index = MARKETS.findIndex(market => market[0] === symbol);
  if (index < 0 || !Number.isFinite(milliseconds)) throw new Error('Unknown market or invalid time');
  const [, , , base, precision] = MARKETS[index];
  // shortcut: deterministic synthetic quotes, replace with an authenticated feed for live trading.
  const t = (milliseconds - 1792800000000) / 1000;
  const variation = Math.sin(t / 71 + index * 2) * 0.0018 + Math.sin(t / 19 + index) * 0.0007 + Math.sin(t / 3.7 + index * 3) * 0.00022;
  return Number((base * (1 + variation)).toFixed(precision));
}

export function amountCents(value) {
  if (!['number', 'string'].includes(typeof value) || !/^\d{1,9}(?:\.\d{1,2})?$/.test(String(value))) {
    throw new HttpError(400, 'Enter an amount with at most two decimal places');
  }
  const [whole, fraction = ''] = String(value).split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (cents < 100 || cents > 10000000) throw new HttpError(400, 'Amount must be between $1 and $100,000');
  return cents;
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function text(value, label, min, max) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new HttpError(400, `${label} must be ${min}–${max} characters`);
  }
  return value.trim();
}

function email(value) {
  const result = text(value, 'Email', 3, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) throw new HttpError(400, 'Enter a valid email');
  return result;
}

function password(value) {
  if (typeof value !== 'string' || value.length < 10 || value.length > 128) throw new HttpError(400, 'Password must be 10–128 characters');
  return value;
}

async function passwordHash(value) {
  const salt = randomBytes(16).toString('hex');
  const result = await derive(value, salt, 64);
  return `${salt}:${result.toString('hex')}`;
}

async function checkPassword(value, stored) {
  const [salt, expected] = (stored || `${'0'.repeat(32)}:${'0'.repeat(128)}`).split(':');
  const actual = await derive(typeof value === 'string' ? value : '', salt, 64);
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}

export function createApp({ dbPath = path.join(ROOT, 'data', 'trading.sqlite'), barsPath = process.env.BARS_CSV || path.join(ROOT, 'bars.csv'), now = Date.now, guruOptions = {} } = {}) {
  const readBars = createBarsReader(barsPath);
  const guru = createGuruBackend({ now, ...(dbPath === ':memory:' ? { orderDbPath: ':memory:', webSocketFactory: null } : {}), ...guruOptions });
  const scanner = createScanner({ guru, now });
  if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, password_hash TEXT NOT NULL,
      recovery_hash TEXT NOT NULL, country TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
      balance INTEGER NOT NULL CHECK(balance >= 0), preferences TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), csrf TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), symbol TEXT NOT NULL,
      direction TEXT NOT NULL, amount INTEGER NOT NULL, entry_price REAL NOT NULL, exit_price REAL,
      opened_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open',
      profit INTEGER NOT NULL DEFAULT 0, payout INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS trades_due ON trades(status,expires_at);
    CREATE INDEX IF NOT EXISTS trades_user ON trades(user_id,opened_at);
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), type TEXT NOT NULL,
      amount INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS requests (
      user_id TEXT NOT NULL REFERENCES users(id), request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      kind TEXT NOT NULL, result_id TEXT NOT NULL, PRIMARY KEY(user_id,request_id)
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL,
      message TEXT NOT NULL, created_at INTEGER NOT NULL, read INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), subject TEXT NOT NULL,
      message TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open'
    );`);
  const run = (sql, ...params) => db.prepare(sql).run(...params);
  const get = (sql, ...params) => db.prepare(sql).get(...params);
  const all = (sql, ...params) => db.prepare(sql).all(...params);
  const userView = user => ({ id: user.id, name: user.name, email: user.email, country: user.country, phone: user.phone });
  const balance = id => dollars(get('SELECT balance FROM users WHERE id=?', id).balance);
  const tradeView = row => ({ id: row.id, symbol: row.symbol, direction: row.direction, amount: dollars(row.amount), entryPrice: row.entry_price, exitPrice: row.exit_price, openedAt: row.opened_at, expiresAt: row.expires_at, status: row.status, profit: dollars(row.profit), payout: row.payout });
  const transactionView = row => ({ id: row.id, type: row.type, amount: dollars(row.amount), createdAt: row.created_at, status: 'completed' });
  function atomic(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function notify(id, title, message) {
    run('INSERT INTO notifications(id,user_id,title,message,created_at) VALUES(?,?,?,?,?)', randomUUID(), id, title, message, now());
  }
  function ledger(id, type, amount) {
    const record = { id: randomUUID(), user_id: id, type, amount, created_at: now() };
    run('INSERT INTO transactions VALUES(?,?,?,?,?)', record.id, id, type, amount, record.created_at);
    return record;
  }
  function settle() {
    atomic(() => {
      for (const trade of all("SELECT * FROM trades WHERE status='open' AND expires_at<=?", now())) {
        const exit = priceAt(trade.symbol, trade.expires_at);
        const change = Math.sign(exit - trade.entry_price) * (trade.direction === 'up' ? 1 : -1);
        const status = change > 0 ? 'won' : change < 0 ? 'lost' : 'draw';
        const profit = change > 0 ? Math.floor(trade.amount * trade.payout / 100) : change < 0 ? -trade.amount : 0;
        const credit = trade.amount + profit;
        run('UPDATE trades SET exit_price=?,status=?,profit=? WHERE id=?', exit, status, profit, trade.id);
        run('UPDATE users SET balance=balance+? WHERE id=?', credit, trade.user_id);
        if (credit) ledger(trade.user_id, 'settlement', credit);
        notify(trade.user_id, `Trade ${status}`, `${trade.symbol} ${trade.direction}: ${status === 'draw' ? 'stake refunded' : `${profit < 0 ? '-' : '+'}$${dollars(Math.abs(profit)).toFixed(2)}`}`);
      }
    });
  }
  settle();
  function issueSession(id, response) {
    const token = randomBytes(32).toString('hex');
    const csrf = randomBytes(24).toString('hex');
    run('DELETE FROM sessions WHERE expires_at<=?', now());
    run('INSERT INTO sessions VALUES(?,?,?,?)', hash(token), id, csrf, now() + SESSION_MS);
    response.setHeader('Set-Cookie', `guru_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`);
    return { user: userView(get('SELECT * FROM users WHERE id=?', id)), csrf };
  }
  function authenticate(request) {
    const token = /(?:^|;\s*)guru_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.cookie || '')?.[1];
    if (!token) return null;
    return get('SELECT sessions.token_hash,sessions.csrf,users.* FROM sessions JOIN users ON users.id=sessions.user_id WHERE token_hash=? AND expires_at>?', hash(token), now()) || null;
  }
  const attempts = new Map();
  function rateLimit(request) {
    const key = request.socket.remoteAddress;
    const current = attempts.get(key);
    if (!current || current.until <= now()) {
      attempts.set(key, { count: 1, until: now() + 15 * 60000 });
      if (attempts.size > 1000) for (const [key, value] of attempts) if (value.until <= now()) attempts.delete(key);
    } else if (++current.count > 30) throw new HttpError(429, 'Too many authentication attempts; retry in 15 minutes');
  }
  function requestIdentity(userId, body, kind, payload) {
    const id = text(body.requestId, 'Request ID', 8, 128);
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new HttpError(400, 'Invalid request ID');
    const fingerprint = hash(JSON.stringify([kind, payload]));
    const previous = get('SELECT * FROM requests WHERE user_id=? AND request_id=?', userId, id);
    if (previous && previous.fingerprint !== fingerprint) throw new HttpError(409, 'Request ID was already used for a different action');
    return { id, fingerprint, previous };
  }
  async function readBody(request) {
    if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) throw new HttpError(415, 'Content-Type must be application/json');
    let size = 0;
    const parts = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 16384) throw new HttpError(413, 'Request is too large');
      parts.push(chunk);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(parts).toString('utf8')); }
    catch { throw new HttpError(400, 'Invalid JSON'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Expected a JSON object');
    return body;
  }
  function verifyHost(request) {
    let host;
    try { host = new URL(`http://${request.headers.host}`); }
    catch { throw new HttpError(403, 'Invalid host'); }
    const allowed = new Set(['127.0.0.1', 'localhost', '[::1]', request.socket.localAddress, `[${request.socket.localAddress}]`]);
    if (!allowed.has(host.hostname) || Number(host.port || 80) !== request.socket.localPort) throw new HttpError(403, 'Host is not allowed');
    if (request.headers.origin && request.headers.origin !== host.origin) throw new HttpError(403, 'Origin is not allowed');
    const documentNavigation = ['GET', 'HEAD'].includes(request.method) && request.headers['sec-fetch-mode'] === 'navigate' && request.headers['sec-fetch-dest'] === 'document' && ['/', '/index.html', '/data.html'].includes(request.url.split('?')[0]);
    if (request.headers['sec-fetch-site'] === 'cross-site' && !documentNavigation) throw new HttpError(403, 'Cross-site requests are not allowed');
  }
  const feeds = new Set();
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const send = (data, status = 200) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(data));
    };
    try {
      verifyHost(request);
      const url = new URL(request.url, 'http://local');
      const route = `${request.method} ${url.pathname}`;
      if (route === 'GET /api/guru/stream') {
        const symbol = url.searchParams.get('symbol');
        if (typeof symbol !== 'string' || !/^[A-Za-z0-9_]{1,64}$/.test(symbol)) throw new HttpError(400, 'Choose a valid instrument');
        if (feeds.size >= 32) throw new HttpError(429, 'Too many live feeds');
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        response.socket?.setNoDelay(true);
        response.flushHeaders();
        response.write('retry: 1000\n\n');
        let unsubscribe, finished = false;
        const cleanup = () => {
          if (finished) return;
          finished = true; clearInterval(heartbeat); unsubscribe?.(); feeds.delete(end);
        };
        const end = () => { response.end(); cleanup(); };
        const heartbeat = setInterval(() => { if (!response.write(': heartbeat\n\n')) response.destroy(); }, 15000);
        heartbeat.unref();
        feeds.add(end); response.once('close', cleanup);
        try {
          const detach = await guru.subscribeTicks({ symbol, onClose: end, onTicks: event => {
            if (!finished && !response.write(`data: ${JSON.stringify(event)}\n\n`)) response.destroy();
          } });
          if (finished) detach(); else unsubscribe = detach;
        } catch (error) {
          if (!finished) { response.write(`event: feed-error\ndata: ${JSON.stringify({ error: error.status ? error.message : 'Live feed unavailable' })}\n\n`); end(); }
        }
        return;
      }
      if (url.pathname === '/v1/data') {
        if (request.method !== 'GET') {
          response.setHeader('Allow', 'GET');
          throw new HttpError(405, 'Use GET /v1/data');
        }
        const query = dataQuery(url.searchParams);
        const result = await readBars(query, now());
        if (query.format === 'csv') {
          response.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="bars.csv"', 'Cache-Control': 'no-store' });
          response.end(barsCSV(result));
          return;
        }
        return send(result);
      }
      if (!url.pathname.startsWith('/api/')) {
        if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'Method not allowed');
        let pathname;
        try { pathname = decodeURIComponent(url.pathname); } catch { throw new HttpError(400, 'Invalid path'); }
        if (pathname.includes('\0') || pathname.includes('\\')) throw new HttpError(404, 'Not found');
        const directory = path.join(ROOT, 'public');
        const requested = path.resolve(directory, `.${pathname === '/' ? '/index.html' : pathname}`);
        if (!requested.startsWith(directory + path.sep)) throw new HttpError(404, 'Not found');
        let file;
        try { file = await realpath(requested); } catch { throw new HttpError(404, 'Not found'); }
        if (!file.startsWith(directory + path.sep)) throw new HttpError(404, 'Not found');
        const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.ttf': 'font/ttf' }[path.extname(file)];
        if (!mime || !(await stat(file)).isFile()) throw new HttpError(404, 'Not found');
        const content = await readFile(file);
        response.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache', 'Content-Length': content.length });
        response.end(request.method === 'HEAD' ? undefined : content);
        return;
      }
      const mutation = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method);
      const body = mutation ? await readBody(request) : {};
      const user = authenticate(request);
      const publicRoute = ['GET /api/session', 'GET /api/markets', 'GET /api/candles', 'GET /api/signals', 'GET /api/backtest', 'GET /api/guru/markets', 'GET /api/guru/candles', 'GET /api/guru/quote', 'GET /api/guru/ticks', 'GET /api/guru/status', 'GET /api/guru/balance', 'GET /api/guru/deals', 'POST /api/guru/login', 'POST /api/guru/logout', 'POST /api/guru/trade', 'POST /api/auth/register', 'POST /api/auth/login', 'POST /api/auth/recover'].includes(route);
      if (!publicRoute && route !== 'GET /api/guru/orders' && !user) throw new HttpError(401, 'Sign in to continue');
      if (mutation && user && !url.pathname.startsWith('/api/guru/') && !['POST /api/auth/register', 'POST /api/auth/login', 'POST /api/auth/recover'].includes(route) && request.headers['x-csrf-token'] !== user.csrf) throw new HttpError(403, 'Invalid session verification token; refresh and retry');
      settle();
      if (route === 'GET /api/session') return send(user ? { user: userView(user), csrf: user.csrf } : { user: null });
      if (route === 'GET /api/markets') return send({ mode: 'simulated', serverTime: now(), markets: MARKETS.map(([symbol, name, category, , precision]) => {
        const price = priceAt(symbol, now());
        return { symbol, name, category, precision, price, change: Number(((price / priceAt(symbol, now() - 86400000) - 1) * 100).toFixed(3)), payout: PAYOUT };
      }) });
      const query = Object.fromEntries(url.searchParams);
      if (route === 'GET /api/candles' && url.searchParams.has('asset')) {
        const interval = TIMEFRAMES[query.tf || '1m'];
        if (!interval) throw new HttpError(400, 'tf must be 1m, 5m or 15m');
        const to = query.to ? Number(query.to) : now(), from = query.from ? Number(query.from) : to - 86400000;
        await guru.watch(query.asset); // validates the symbol and keeps history accumulating
        return send({ asset: query.asset, tf: query.tf || '1m', candles: guru.storedCandles({ symbol: query.asset, from, to, interval }), source: 'stored_broker_ticks', volumeAvailable: false, serverTime: now() });
      }
      if (route === 'GET /api/signals') { scanner.start(); return send(await scanner.scan(parseRules(query))); }
      if (route === 'GET /api/backtest') {
        const rules = parseRules(query), days = Number(query.days || 7);
        if (!(days > 0 && days <= 30)) throw new HttpError(400, 'days must be between 0 and 30');
        if (!query.asset) throw new HttpError(400, 'asset is required (a symbol or "all")');
        const to = now(), from = Math.round(to - days * 86400000);
        const assets = (query.asset === 'all' ? guru.storedSymbols() : [query.asset]).map(symbol => {
          const prices = { after: time => guru.tickAt(symbol, time, 'after'), before: time => guru.tickAt(symbol, time, 'before') };
          const candles = guru.storedCandles({ symbol, from, to, interval: rules.tf });
          return { symbol, candles: candles.length, firstBar: candles[0]?.time ?? null, ...backtest(candles, prices, rules) };
        });
        const { list, ...total } = summarize(assets.flatMap(a => a.list), rules.payout);
        return send({ rules, days, total, assets: assets.map(({ list, ...a }) => a), note: 'Uses only ticks this server has stored; results are ex-ante rules on past data, not a forecast.', serverTime: now() });
      }
      if (route === 'GET /api/candles') {
        const symbol = url.searchParams.get('symbol') || 'EURUSD';
        const interval = Number(url.searchParams.get('interval') || 5);
        if (!MARKETS.some(market => market[0] === symbol) || ![5, 10, 15, 60, 180, 300, 900, 1800, 3600].includes(interval)) throw new HttpError(400, 'Invalid market or chart interval');
        const end = Math.floor(now() / (interval * 1000)) * interval;
        const candles = Array.from({ length: 100 }, (_, i) => {
          const time = end - (99 - i) * interval;
          const until = Math.min(now(), (time + interval) * 1000 - 1);
          const values = Array.from({ length: 21 }, (_, j) => priceAt(symbol, time * 1000 + (until - time * 1000) * j / 20));
          return { time, open: values[0], high: Math.max(...values), low: Math.min(...values), close: values.at(-1) };
        });
        return send({ candles, serverTime: now() });
      }
      if (route === 'GET /api/guru/markets') return send(await guru.getMarkets());
      if (route === 'GET /api/guru/candles') return send(await guru.getCandles({ symbol: url.searchParams.get('symbol'), interval: Number(url.searchParams.get('interval') || 60) }));
      if (route === 'GET /api/guru/quote') return send(await guru.getQuote({ symbol: url.searchParams.get('symbol') }));
      if (route === 'GET /api/guru/ticks') return send(await guru.getTicks({ symbol: url.searchParams.get('symbol'), since: Number(url.searchParams.get('since') || 0), limit: Number(url.searchParams.get('limit') || 20000) }));
      if (route === 'GET /api/guru/status') return send(guru.status());
      if (route === 'POST /api/guru/login') { rateLimit(request); return send(await guru.login({ accountNumber: body.accountNumber, passWord: body.passWord })); }
      if (route === 'POST /api/guru/logout') return send(guru.logout());
      if (route === 'GET /api/guru/balance' || route === 'GET /api/guru/deals' || route === 'GET /api/guru/orders') {
        const demo = url.searchParams.get('demo');
        if (demo !== null && !['0', '1'].includes(demo)) throw new HttpError(400, 'demo must be 0 or 1');
        return send(await (route.endsWith('/balance') ? guru.getBalance({ demo: demo === '1' }) : route.endsWith('/orders') ? guru.getOrderHistory({ demo: demo === '1' }) : guru.getActiveDeals({ demo: demo === '1' })));
      }
      if (route === 'POST /api/guru/trade') return send(await guru.submitTrade({ symbol: body.symbol, buySell: body.buySell, amount: body.amount, oneClick: body.oneClick, real: body.real, requestId: body.requestId, duration: body.duration }));
      if (route === 'POST /api/auth/register') {
        rateLimit(request);
        const address = email(body.email), name = text(body.name, 'Name', 1, 80);
        const encoded = await passwordHash(password(body.password));
        const recoveryCode = randomBytes(18).toString('hex');
        const id = randomUUID();
        atomic(() => {
          if (get('SELECT id FROM users WHERE email=?', address)) throw new HttpError(409, 'Email is already registered');
          run('INSERT INTO users(id,email,name,password_hash,recovery_hash,balance,preferences,created_at) VALUES(?,?,?,?,?,?,?,?)', id, address, name, encoded, hash(recoveryCode), 1000000, JSON.stringify({ favorites: ['EURUSD'], theme: 'dark' }), now());
          ledger(id, 'deposit', 1000000);
          notify(id, 'Your practice account is ready', '$10,000 in virtual funds is available. All quotes and transactions are simulated.');
        });
        return send({ ...issueSession(id, response), recoveryCode }, 201);
      }
      if (route === 'POST /api/auth/login') {
        rateLimit(request);
        const address = email(body.email);
        const supplied = password(body.password);
        const account = get('SELECT * FROM users WHERE email=?', address);
        if (!(await checkPassword(supplied, account?.password_hash)) || !account || get('SELECT password_hash FROM users WHERE id=?', account.id)?.password_hash !== account.password_hash) throw new HttpError(401, 'Incorrect email or password');
        return send(issueSession(account.id, response));
      }
      if (route === 'POST /api/auth/recover') {
        rateLimit(request);
        const address = email(body.email), supplied = text(body.recoveryCode, 'Recovery code', 10, 100);
        const encoded = await passwordHash(password(body.password));
        const account = get('SELECT * FROM users WHERE email=?', address);
        const expected = Buffer.from(account?.recovery_hash || '0'.repeat(64), 'hex');
        if (!timingSafeEqual(Buffer.from(hash(supplied), 'hex'), expected) || !account) throw new HttpError(401, 'Incorrect email or recovery code');
        const recoveryCode = randomBytes(18).toString('hex');
        atomic(() => {
          run('UPDATE users SET password_hash=?,recovery_hash=? WHERE id=?', encoded, hash(recoveryCode), account.id);
          run('DELETE FROM sessions WHERE user_id=?', account.id);
          notify(account.id, 'Password reset', 'Your password and recovery code were changed. All sessions were signed out.');
        });
        response.setHeader('Set-Cookie', 'guru_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
        return send({ ok: true, recoveryCode });
      }
      if (route === 'POST /api/auth/logout') {
        run('DELETE FROM sessions WHERE token_hash=?', user.token_hash);
        response.setHeader('Set-Cookie', 'guru_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
        return send({ ok: true });
      }
      if (route === 'POST /api/auth/password') {
        rateLimit(request);
        if (!(await checkPassword(password(body.currentPassword), user.password_hash))) throw new HttpError(401, 'Current password is incorrect');
        const encoded = await passwordHash(password(body.password));
        atomic(() => {
          if (!run('UPDATE users SET password_hash=? WHERE id=? AND password_hash=?', encoded, user.id, user.password_hash).changes) throw new HttpError(409, 'Password changed during this request; sign in again');
          run('DELETE FROM sessions WHERE user_id=? AND token_hash<>?', user.id, user.token_hash);
          notify(user.id, 'Password changed', 'Other sessions were signed out.');
        });
        return send({ ok: true });
      }
      if (route === 'GET /api/account') {
        const account = get('SELECT * FROM users WHERE id=?', user.id);
        const stats = get("SELECT count(*) trades,coalesce(sum(status='won'),0) wins,coalesce(sum(profit),0) profit FROM trades WHERE user_id=? AND status<>'open'", user.id);
        return send({ user: userView(account), balance: dollars(account.balance), stats: { ...stats, profit: dollars(stats.profit) }, preferences: JSON.parse(account.preferences) });
      }
      if (route === 'GET /api/trades') return send({ trades: all('SELECT * FROM trades WHERE user_id=? ORDER BY opened_at DESC,rowid DESC LIMIT 500', user.id).map(tradeView) });
      if (route === 'POST /api/trades') {
        const amount = amountCents(body.amount), { symbol, direction, duration } = body;
        if (!MARKETS.some(market => market[0] === symbol) || !['up', 'down'].includes(direction) || ![5, 10, 15, 30, 60, 120, 180, 300].includes(duration)) throw new HttpError(400, 'Invalid market, direction, or duration');
        const identity = requestIdentity(user.id, body, 'trade', [symbol, direction, amount, duration]);
        const result = atomic(() => {
          if (identity.previous) return get('SELECT * FROM trades WHERE id=? AND user_id=?', identity.previous.result_id, user.id);
          if (!run('UPDATE users SET balance=balance-? WHERE id=? AND balance>=?', amount, user.id, amount).changes) throw new HttpError(400, 'Insufficient practice balance');
          const id = randomUUID(), opened = now();
          run('INSERT INTO trades(id,user_id,symbol,direction,amount,entry_price,opened_at,expires_at,payout) VALUES(?,?,?,?,?,?,?,?,?)', id, user.id, symbol, direction, amount, priceAt(symbol, opened), opened, opened + duration * 1000, PAYOUT);
          ledger(user.id, 'trade', -amount);
          run('INSERT INTO requests VALUES(?,?,?,?,?)', user.id, identity.id, identity.fingerprint, 'trade', id);
          return get('SELECT * FROM trades WHERE id=?', id);
        });
        return send({ trade: tradeView(result), balance: balance(user.id) }, identity.previous ? 200 : 201);
      }
      if (route === 'GET /api/wallet') return send({ balance: balance(user.id), transactions: all('SELECT * FROM transactions WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 500', user.id).map(transactionView) });
      if (route === 'POST /api/wallet') {
        const amount = amountCents(body.amount), { type } = body;
        if (!['deposit', 'withdraw'].includes(type)) throw new HttpError(400, 'Invalid transaction type');
        const identity = requestIdentity(user.id, body, 'wallet', [type, amount]);
        const transaction = atomic(() => {
          if (identity.previous) return get('SELECT * FROM transactions WHERE id=? AND user_id=?', identity.previous.result_id, user.id);
          const signed = type === 'deposit' ? amount : -amount;
          if (!run('UPDATE users SET balance=balance+? WHERE id=? AND balance+?>=0 AND balance+?<=?', signed, user.id, signed, signed, 10000000000).changes) throw new HttpError(400, type === 'withdraw' ? 'Insufficient practice balance' : 'Practice balance limit reached');
          const record = ledger(user.id, type, signed);
          run('INSERT INTO requests VALUES(?,?,?,?,?)', user.id, identity.id, identity.fingerprint, 'wallet', record.id);
          notify(user.id, `Practice ${type} completed`, `$${dollars(amount).toFixed(2)} in virtual funds ${type === 'deposit' ? 'added' : 'removed'}. No real payment was made.`);
          return record;
        });
        return send({ balance: balance(user.id), transaction: transactionView(transaction) }, identity.previous ? 200 : 201);
      }
      if (route === 'PATCH /api/profile') {
        const name = text(body.name, 'Name', 1, 80), country = text(body.country ?? '', 'Country', 0, 80), phone = text(body.phone ?? '', 'Phone', 0, 30);
        if (phone && !/^[+\d() .-]+$/.test(phone)) throw new HttpError(400, 'Enter a valid phone number');
        run('UPDATE users SET name=?,country=?,phone=? WHERE id=?', name, country, phone, user.id);
        return send({ user: userView(get('SELECT * FROM users WHERE id=?', user.id)) });
      }
      if (route === 'PATCH /api/preferences') {
        const previous = JSON.parse(get('SELECT preferences FROM users WHERE id=?', user.id).preferences);
        const favorites = body.favorites ?? previous.favorites, theme = body.theme ?? previous.theme;
        if (!Array.isArray(favorites) || favorites.length > MARKETS.length || !favorites.every(symbol => MARKETS.some(market => market[0] === symbol)) || !['dark', 'light'].includes(theme)) throw new HttpError(400, 'Invalid preferences');
        const preferences = { favorites: [...new Set(favorites)], theme };
        run('UPDATE users SET preferences=? WHERE id=?', JSON.stringify(preferences), user.id);
        return send({ preferences });
      }
      if (route === 'GET /api/notifications') return send({ notifications: all('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100', user.id).map(row => ({ id: row.id, title: row.title, message: row.message, createdAt: row.created_at, read: Boolean(row.read) })) });
      if (route === 'POST /api/notifications/read') { run('UPDATE notifications SET read=1 WHERE user_id=?', user.id); return send({ ok: true }); }
      if (route === 'GET /api/support') return send({ tickets: all('SELECT * FROM tickets WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100', user.id).map(row => ({ id: row.id, subject: row.subject, message: row.message, status: row.status, createdAt: row.created_at })) });
      if (route === 'POST /api/support') {
        const subject = text(body.subject, 'Subject', 3, 120), message = text(body.message, 'Message', 5, 4000);
        const id = randomUUID();
        run('INSERT INTO tickets(id,user_id,subject,message,created_at) VALUES(?,?,?,?,?)', id, user.id, subject, message, now());
        return send({ ticket: { id, subject, message, status: 'open', createdAt: now() } }, 201);
      }
      throw new HttpError(404, 'API route not found');
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      if (!error.status) console.error('Request failed:', error.message);
      send({ error: error.status ? error.message : 'Server could not complete the request', ...(error.code?.startsWith('GURU_') ? { code: error.code } : {}) }, error.status || 500);
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  const timer = setInterval(() => { try { settle(); } catch (error) { console.error('Settlement failed:', error.message); } }, 1000);
  timer.unref();
  async function close() {
    clearInterval(timer);
    scanner.stop();
    for (const end of feeds) end();
    guru.close();
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.close();
  }
  return { server, close, guru, scanner };
}

// Optional local credentials; interactive sign-in also supports expired sessions.
async function autoLoginFromCred(guru) {
  if (process.env.GURU_AUTO_LOGIN === '0') return;
  let text;
  try { text = await readFile(path.join(ROOT, '.cred'), 'utf8'); } catch { return; }
  const field = key => text.match(new RegExp(`${key}="([^"]*)"`))?.[1];
  const accountNumber = field('mail'), passWord = field('pass');
  if (!accountNumber || !passWord) return;
  try { await guru.login({ accountNumber, passWord }); console.log('GuruTrade: signed in'); }
  catch (error) { console.error(`GuruTrade auto-login failed (${error.code || 'error'}); sign in from the terminal`); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argument = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
  const port = Number(argument('--port') || process.env.PORT || 8765);
  const host = argument('--host') || '127.0.0.1';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  const app = createApp();
  app.server.listen(port, host, () => {
    console.log(`Trading data API: http://${host}:${port}/v1/data\nCandle source: ${process.env.BARS_CSV || path.join(ROOT, 'bars.csv')}\n/v1/data uses source OHLCV only. Separate /api/* practice routes use simulations.`);
    autoLoginFromCred(app.guru);
    app.scanner.start();
  });
  app.server.on('error', error => { console.error(error.message); app.close().finally(() => process.exit(1)); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close().then(() => process.exit(0)));
}
