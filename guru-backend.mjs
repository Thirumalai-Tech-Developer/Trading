import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectGuruStream } from './guru-stream.mjs';

const API_BASE = 'https://api.guruserv.com';
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export class GuruBackendError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = 'GuruBackendError';
    this.code = code;
    this.status = status;
  }
}

function finite(value) {
  if ((typeof value !== 'string' && typeof value !== 'number') || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function brokerDuration(unit) {
  const match = /^(\d+)(SEC|SECOND|S|MIN|MINUTE|M|HOUR|H)$/i.exec(typeof unit === 'string' ? unit : '');
  if (!match) return null;
  const seconds = Number(match[1]) * (/^S/i.test(match[2]) ? 1 : /^M/i.test(match[2]) ? 60 : 3600);
  return Number.isInteger(seconds) && seconds > 0 && seconds <= 86400 ? seconds : null;
}

function durationOptions(row) {
  if (row.tradeTimeRespList !== undefined) {
    if (!Array.isArray(row.tradeTimeRespList) || row.tradeTimeRespList.length > 100) throw new GuruBackendError('GURU_BAD_CATALOG', 'Invalid broker duration options');
    const options = new Map();
    for (const option of row.tradeTimeRespList) {
      const seconds = brokerDuration(`${option?.timeUnit}${option?.timeUnitType}`);
      if (seconds === null || !Number.isInteger(option.timeUnit)) throw new GuruBackendError('GURU_BAD_CATALOG', 'Invalid broker duration option');
      const profit = finite(option.profit);
      options.set(seconds, { seconds, timeUnit: option.timeUnit, timeUnitType: option.timeUnitType, payout: profit !== null && profit > 0 && profit <= 10 ? profit * 100 : null });
    }
    return [...options.values()].sort((a, b) => a.seconds - b.seconds);
  }
  const seconds = brokerDuration(row.unit);
  return seconds === null ? [] : [{ seconds, payout: null }];
}

export function normalizeGuruCatalog(data, master = []) {
  if (data && !Array.isArray(data) && typeof data === 'object') {
    if (!Array.isArray(data.productData) || !Array.isArray(data.productInfoAll) || data.productInfoAll.length > 5000 || data.productData.length > 100) throw new GuruBackendError('GURU_BAD_CATALOG', 'GuruTrade returned an invalid app catalogue');
    const info = new Map(data.productInfoAll.map(row => [String(row?.productId), row]));
    const groups = data.productData.map(group => {
      if (!group || !Array.isArray(group.productIds) || group.productIds.length > 5000) throw new GuruBackendError('GURU_BAD_CATALOG', 'GuruTrade returned invalid product groups');
      return { productType: group.productType, productList: group.productIds.map(id => {
        const row = info.get(String(id));
        if (!row) throw new GuruBackendError('GURU_BAD_CATALOG', 'Broker product group references missing metadata');
        return row;
      }) };
    });
    groups.push({ productList: data.productInfoAll });
    data = groups;
  }
  if (!Array.isArray(data) || data.length > 100) throw new GuruBackendError('GURU_BAD_CATALOG', 'GuruTrade returned an invalid instrument catalog');
  if (!Array.isArray(master) || master.length > 5000) throw new GuruBackendError('GURU_BAD_CATALOG', 'GuruTrade returned an invalid master catalogue');
  data = [...data, { productList: master, master: true }];
  const instruments = new Map();
  for (const group of data) {
    if (!group || !Array.isArray(group.productList) || group.productList.length > 2000) throw new GuruBackendError('GURU_BAD_CATALOG', 'GuruTrade returned an invalid instrument group');
    for (const row of group.productList) {
      if (!row || !/^[A-Za-z0-9_]{1,64}$/.test(row.symbol || '') || !row.productId || typeof row.name !== 'string') throw new GuruBackendError('GURU_BAD_CATALOG', 'GuruTrade returned invalid instrument metadata');
      const previous = instruments.get(row.symbol);
      const variant = { productId: String(row.productId), aType: row.aType ?? null, availableInApp: !group.master, payout: finite(row.profit) === null ? null : Number(row.profit) * 100 };
      if (previous) {
        if (!previous.variants.some(v => v.productId === variant.productId)) previous.variants.push(variant);
        continue;
      }
      const price = finite(row.currentPrice), profit = finite(row.profit), precision = finite(row.accuracy);
      const durations = durationOptions(row);
      instruments.set(row.symbol, {
        symbol: row.symbol, name: row.name, category: row.productType || group.productType,
        productId: String(row.productId), precision: Number.isInteger(precision) && precision >= 0 && precision <= 12 ? precision : null,
        price: price !== null && price > 0 ? price : null,
        change: null, rawChangeRate: finite(row.changeRate),
        payout: profit !== null && profit >= 0 && profit <= 10 ? Number((profit * 100).toFixed(6)) : null,
        tradable: !group.master && row.isLimited === '00', marketStatus: group.master ? 'unavailable' : row.isLimited,
        catalogueSource: group.master ? 'master' : 'app', variants: [variant],
        currency: typeof row.currencyType === 'string' ? row.currencyType : null,
        minimumAmount: finite(row.min), maximumAmount: finite(row.max),
        demoMinimumAmount: finite(row.demoMin) ?? finite(row.min), demoMaximumAmount: finite(row.demoMax) ?? finite(row.max),
        durationUnit: typeof row.unit === 'string' ? row.unit : null,
        durationOptions: durations, durationSource: row.tradeTimeRespList !== undefined ? 'tradeTimeRespList' : 'unit', supportedDurations: durations.map(d => d.seconds),
      });
    }
  }
  if (!instruments.size) throw new GuruBackendError('GURU_EMPTY_CATALOG', 'GuruTrade returned no instruments');
  return [...instruments.values()];
}

export function normalizeGuruPoints(data) {
  if (!Array.isArray(data) || data.length > 20000) throw new GuruBackendError('GURU_BAD_HISTORY', 'GuruTrade returned invalid price history');
  const points = new Map();
  for (const row of data) {
    const time = finite(row.ct), value = finite(row.cp);
    if (!Number.isInteger(time) || time < 946684800 || time > 4102444800 || value === null || value <= 0) throw new GuruBackendError('GURU_BAD_HISTORY', 'GuruTrade returned an invalid price sample');
    points.set(time, { time, value });
  }
  return [...points.values()].sort((a, b) => a.time - b.time);
}

export function decodeGuruQuotation(encoded) {
  if (typeof encoded !== 'string' || encoded.length > MAX_RESPONSE_BYTES || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new GuruBackendError('GURU_BAD_ENCODING', 'GuruTrade returned invalid encoded quote data');
  const outer = Buffer.from(encoded, 'base64').toString('utf8');
  const header = outer.charCodeAt(0), direction = Math.trunc(header / 10), shift = header % 10;
  if (!outer || outer.length % 2 !== 1 || !/^[0-9a-f]+$/i.test(outer.slice(1)) || ![7, 8, 9].includes(direction) || shift > 7) throw new GuruBackendError('GURU_BAD_ENCODING', 'GuruTrade quotation encoding is unsupported');
  const bytes = Buffer.from(outer.slice(1), 'hex');
  for (let i = 0; i < bytes.length; i++) bytes[i] = direction === 8 ? ((bytes[i] << shift) | (bytes[i] >>> (8 - shift))) & 255 : ((bytes[i] >>> shift) | (bytes[i] << (8 - shift))) & 255;
  const decoded = bytes.toString('ascii');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(decoded)) throw new GuruBackendError('GURU_BAD_ENCODING', 'GuruTrade quotation encoding is invalid');
  try { return JSON.parse(Buffer.from(decoded, 'base64').toString('utf8')); }
  catch { throw new GuruBackendError('GURU_BAD_ENCODING', 'GuruTrade quotation data could not be decoded'); }
}

export function normalizeGuruTicks(data) {
  if (!Array.isArray(data) || data.length > 50000) throw new GuruBackendError('GURU_BAD_HISTORY', 'GuruTrade returned invalid tick history');
  const ticks = new Map();
  for (const row of data) {
    const time = finite(row.ct), price = finite(row.cp);
    if (!Number.isInteger(time) || time < 946684800000 || time > 4102444800000 || price === null || price <= 0) throw new GuruBackendError('GURU_BAD_HISTORY', 'GuruTrade returned an invalid price tick');
    ticks.set(time, { time, price });
  }
  return [...ticks.values()].sort((a, b) => a.time - b.time);
}

export function aggregateGuruTicks(ticks, interval = 60, serverTime = Date.now()) {
  if (!Number.isInteger(interval) || interval < 1 || interval > 3600) throw new GuruBackendError('GURU_UNSUPPORTED_INTERVAL', 'Invalid bar interval', 400);
  const buckets = new Map(), width = interval * 1000;
  for (const tick of ticks) {
    if (tick.time > serverTime) continue;
    const time = Math.floor(tick.time / width) * interval;
    let bar = buckets.get(time);
    if (!bar) {
      bar = { time, open: tick.price, high: tick.price, low: tick.price, close: tick.price, volume: 0, observations: 0, firstTickAt: tick.time, lastTickAt: tick.time };
      buckets.set(time, bar);
    }
    bar.high = Math.max(bar.high, tick.price); bar.low = Math.min(bar.low, tick.price);
    bar.close = tick.price; bar.lastTickAt = tick.time; bar.observations++;
  }
  const first = ticks[0]?.time;
  return [...buckets.values()].filter(bar => bar.time * 1000 >= first && (bar.time + interval) * 1000 <= serverTime);
}

const envNumber = name => process.env[name] === undefined || process.env[name] === '' ? null : Number(process.env[name]);
const milliseconds = value => value === null || value === undefined ? null : value < 1e12 ? value * 1000 : value;

export function createGuruBackend({ fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 12000, allowReal = process.env.GURU_ALLOW_REAL === '1', webSocketFactory = url => new WebSocket(url), orderDbPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'guru-orders.sqlite'),
  settlementCsvPath = orderDbPath === ':memory:' ? null : path.join(path.dirname(orderDbPath), 'settlements.csv'),
  risk = { maxStake: Number(process.env.GURU_MAX_REAL_STAKE || 20), balanceFloor: envNumber('GURU_BALANCE_FLOOR'), dailyLossCap: envNumber('GURU_DAILY_LOSS_CAP') } } = {}) {
  const deviceId = randomUUID();
  const cache = new Map(), pending = new Map(), controllers = new Set();
  let visitor = null, visitorPending = null, account = null, closed = false;
  let sessionVersion = 0, orderDb = null;
  const orders = new Map();
  let lastCatalogAt = null, lastQuoteAt = null, lastHistoryAt = null, lastError = null, catalogCount = 0;
  function assertOpen() {
    if (closed) throw new GuruBackendError('GURU_CLOSED', 'GuruTrade connection is closed', 503);
  }
  async function post(endpoint, payload = {}, authenticated = false, { retryTransient = false } = {}) {
    for (let attempt = 0; ; attempt++) {
      try { return await postOnce(endpoint, payload, authenticated); }
      catch (error) {
        // 10316 is the broker's transient "try again" error; retry idempotent reads, never a trade/login.
        if (error.code === 'GURU_TRANSIENT' && retryTransient && attempt < 2) { await new Promise(resolve => setTimeout(resolve, 300 + attempt * 400)); continue; }
        throw error;
      }
    }
  }
  async function postOnce(endpoint, payload = {}, authenticated = false) {
    assertOpen();
    const body = { appSource: 'WEB', deviceId, gaid: deviceId };
    let session;
    if (authenticated) {
      session = account ?? await ensureVisitor();
      for (const key of ['userId', 'token', 'deviceId', 'gaid', 'accountNumber']) if (session[key] !== undefined) body[key] = session[key];
    }
    const controller = new AbortController(); controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(API_BASE + endpoint, {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Origin: 'https://www.gurutrade7.com', Referer: 'https://www.gurutrade7.com/' },
        body: JSON.stringify({ ...body, ...payload }),
      });
      if (!response.ok) throw new GuruBackendError('GURU_HTTP_ERROR', `GuruTrade market service returned HTTP ${response.status}`);
      const length = Number(response.headers.get('content-length'));
      if (length > MAX_RESPONSE_BYTES) throw new GuruBackendError('GURU_RESPONSE_TOO_LARGE', 'GuruTrade response exceeds the size limit');
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > MAX_RESPONSE_BYTES) { controller.abort(); throw new GuruBackendError('GURU_RESPONSE_TOO_LARGE', 'GuruTrade response exceeds the size limit'); }
        chunks.push(Buffer.from(chunk));
      }
      let result;
      try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new GuruBackendError('GURU_BAD_RESPONSE', 'GuruTrade returned a non-JSON response'); }
      if (!result || typeof result !== 'object' || Array.isArray(result) || result.status === undefined) throw new GuruBackendError('GURU_BAD_RESPONSE', 'GuruTrade returned an invalid response envelope');
      if (String(result.status) !== '0') {
        if (String(result.status) === '2') {
          if (session === account) { account = null; sessionVersion++; }
          if (session === visitor) visitor = null;
          cache.clear();
          throw new GuruBackendError('GURU_SESSION_EXPIRED', 'GuruTrade session expired. Sign in again.', 401);
        }
        const code = result.code ? String(result.code).slice(0, 30) : '';
        if (code === '10316') throw new GuruBackendError('GURU_TRANSIENT', 'GuruTrade is busy right now — please try again in a moment.', 503);
        throw new GuruBackendError('GURU_REJECTED', `GuruTrade rejected the request${code ? ` (code ${code})` : ''}`);
      }
      assertOpen();
      if (authenticated && session !== (account ?? visitor)) throw new GuruBackendError('GURU_SESSION_CHANGED', 'Account changed while the request was running', 409);
      lastError = null;
      return result.data;
    } catch (error) {
      const failure = error instanceof GuruBackendError ? error : new GuruBackendError(controller.signal.aborted ? 'GURU_TIMEOUT' : 'GURU_UNREACHABLE', controller.signal.aborted ? 'GuruTrade market request timed out' : 'Cannot reach GuruTrade market service', 503);
      lastError = { code: failure.code, message: failure.message, at: now() };
      throw failure;
    } finally { clearTimeout(timer); controllers.delete(controller); }
  }
  async function ensureVisitor() {
    assertOpen();
    if (visitor) return visitor;
    if (!visitorPending) visitorPending = post('/ou/user/webLogin', { source: 'simulation', accountNumber: deviceId, passWord: deviceId }).then(data => {
      if (!data?.token || !data?.userId || !data?.accountNumber) throw new GuruBackendError('GURU_BAD_VISITOR', 'GuruTrade did not initialize a visitor session');
      assertOpen();
      visitor = Object.fromEntries(['userId', 'token', 'deviceId', 'gaid', 'accountNumber'].filter(key => data[key] !== undefined).map(key => [key, data[key]]));
      return visitor;
    }).finally(() => { visitorPending = null; });
    return visitorPending;
  }
  async function cached(key, lifetime, producer) {
    assertOpen();
    key = `${sessionVersion}:${key}`;
    const version = sessionVersion;
    const previous = cache.get(key);
    if (previous && previous.expiresAt > now()) return structuredClone(previous.value);
    if (!pending.has(key)) pending.set(key, Promise.resolve().then(producer).then(value => {
      if (closed || version !== sessionVersion) return value;
      cache.delete(key);
      cache.set(key, { expiresAt: now() + lifetime, value });
      while (cache.size > 64) cache.delete(cache.keys().next().value);
      return value;
    }).finally(() => pending.delete(key)));
    return structuredClone(await pending.get(key));
  }
  async function getMarkets() {
    const result = await cached('catalog', 30000, async () => {
      const app = { appSource: 'GP', interfaceVersion: '3.0', os: 'android', terminal: 'android', pName: 'com.gurutrade7.app', version: '3.5.3.2' };
      const [catalogue, master] = await Promise.allSettled([
        post('/ou/product/list/v3', app, false, { retryTransient: true }),
        cached('master-catalog', 3600000, () => post('/ou/product/list', app, false, { retryTransient: true })),
      ]);
      if (catalogue.status !== 'fulfilled') throw catalogue.reason;
      const markets = normalizeGuruCatalog(catalogue.value, master.status === 'fulfilled' ? master.value : []);
      lastCatalogAt = now(); catalogCount = markets.length;
      return { markets, source: 'guru', mode: 'live', catalogueComplete: master.status === 'fulfilled', catalogueWarning: master.status === 'rejected' ? 'Master catalogue is unavailable; showing the current app list.' : null, productVariantCount: markets.reduce((count, m) => count + m.variants.length, 0), endpoints: ['/ou/product/list/v3', '/ou/product/list'], fetchedAt: lastCatalogAt, changeRateUnits: 'unverified' };
    });
    return { ...result, serverTime: now() };
  }
  async function instrument(symbol) {
    if (typeof symbol !== 'string' || !/^[A-Za-z0-9_]{1,64}$/.test(symbol)) throw new GuruBackendError('GURU_INVALID_SYMBOL', 'Choose a valid GuruTrade instrument', 400);
    const result = (await getMarkets()).markets.find(row => row.symbol === symbol);
    if (!result) throw new GuruBackendError('GURU_UNKNOWN_SYMBOL', 'Instrument is absent from the current GuruTrade catalog', 404);
    return result;
  }
  async function getQuote({ symbol }) {
    const market = await instrument(symbol);
    const collector = collectors.get(symbol);
    if (collector?.stream?.healthy() && collector.latestTick) {
      const tick = collector.latestTick;
      lastQuoteAt = now();
      return { symbol, price: tick.price, quotedAt: tick.time, precision: market.precision, source: 'guru', mode: 'live', transport: 'websocket', serverTime: now(), ageMs: Math.max(0, now() - tick.time), stale: now() - tick.time > 30000 };
    }
    const quote = await cached(`quote:${symbol}`, 1000, async () => {
      const data = await post('/ou/quotation/current', { symbol, productId: market.productId }, true, { retryTransient: true });
      const price = finite(data?.fullPrice), time = finite(data?.fullTime);
      if (price === null || price <= 0 || !Number.isInteger(time) || time < 946684800000 || time > now() + 60000) throw new GuruBackendError('GURU_BAD_QUOTE', 'GuruTrade returned an invalid current quote');
      lastQuoteAt = now();
      return { symbol, price, quotedAt: time, precision: market.precision, source: 'guru', mode: 'live', serverTime: now(), ageMs: Math.max(0, now() - time), stale: now() - time > 30000 };
    });
    return { ...quote, serverTime: now(), ageMs: Math.max(0, now() - quote.quotedAt), stale: now() - quote.quotedAt > 30000 };
  }
  // --- continuous high-frequency tick collector (for AI data + candle history) ---
  // getNewlist returns an encoded {quotationList:[{ct:<ms>,cp}]} dense sub-second feed; queryDate polls only newer ticks.
  const MAX_TICKS = 100000, COLLECT_MS = 1000, COLLECTOR_IDLE_MS = 120000, MAX_COLLECTORS = 40;
  const collectors = new Map();
  function decodeQuotationList(raw) {
    const decoded = typeof raw === 'string' ? decodeGuruQuotation(raw) : raw;
    const list = decoded?.quotationList ?? (Array.isArray(decoded) ? decoded : decoded?.data) ?? [];
    return normalizeGuruTicks(list); // validates millisecond ct, dedupes, sorts ascending
  }
  async function pollNewlist(productId, symbol, queryDate) {
    const payload = { symbol, productId, interval: 3 };
    if (queryDate) payload.queryDate = String(queryDate);
    return decodeQuotationList(await post('/ou/quotation/getNewlist', payload, true, { retryTransient: true }));
  }
  function stopCollector(symbol) {
    const c = collectors.get(symbol);
    if (c) {
      clearInterval(c.timer); c.stream?.close(); collectors.delete(symbol);
      for (const listener of c.listeners) { try { listener.onClose?.(); } catch {} }
      c.listeners.clear();
    }
  }
  function publishTicks(c, ticks, transport) {
    if (!ticks.length) return;
    const event = { symbol: c.symbol, ticks, transport, serverTime: now() };
    for (const listener of c.listeners) {
      try { listener.onTicks(event); } catch { c.listeners.delete(listener); }
    }
  }
  function collectorTicks(symbol) { const c = collectors.get(symbol); return c ? [...c.ticks.entries()].map(([time, price]) => ({ time, price })).sort((a, b) => a.time - b.time) : []; }
  async function ensureCollector(symbol, wait = true) {
    const market = await instrument(symbol);
    let c = collectors.get(symbol);
    if (c) { c.lastAccess = now(); if (wait) await c.ready; return c; }
    if (collectors.size >= MAX_COLLECTORS) {
      const oldest = [...collectors.values()].sort((a, b) => a.lastAccess - b.lastAccess)[0];
      stopCollector(oldest.symbol);
    }
    c = { symbol, productId: market.productId, ticks: new Map(), points: [], lastCt: 0, latestTick: null, listeners: new Set(), lastAccess: now(), timer: null, error: null, startedAt: now(), running: false };
    collectors.set(symbol, c);
    const add = t => { c.ticks.set(t.time, t.price); if (t.time >= c.lastCt) { c.lastCt = t.time; c.latestTick = t; } };
    const addAll = ticks => { for (const t of ticks) add(t); storeTicks(symbol, ticks); };
    c.ready = (async () => {
    if (webSocketFactory) {
      try {
        const session = account ?? await ensureVisitor();
        c.stream = connectGuruStream({ session, deviceId, symbol, productId: c.productId, now, socketFactory: webSocketFactory, decode: decodeGuruQuotation, onError: message => { c.error = message; c.historyError = message; }, onTicks: (rows, metadata) => {
          const ticks = normalizeGuruTicks(rows);
          addAll(ticks);
          lastHistoryAt = now();
          if (metadata.live) publishTicks(c, ticks, 'websocket');
          return ticks;
        } });
        await c.stream.ready;
      } catch { c.error = 'Tick history connection failed; REST fallback is active.'; c.historyError = c.error; }
    }
    assertOpen();
    if (collectors.get(symbol) !== c) throw new GuruBackendError('GURU_SESSION_CHANGED', 'Account changed while loading history', 409);
    if (!c.ticks.size) {
    // Minute samples are line history; they cannot reconstruct a candle's high and low.
    try { c.points = normalizeGuruPoints(await post('/ou/quotation/getlist', { symbol, productId: c.productId, interval: 60 }, true, { retryTransient: true })); }
    catch (error) { c.error = error.message; }
    try { addAll(await pollNewlist(c.productId, symbol)); c.error = null; lastHistoryAt = now(); }
    catch (error) { c.error = error.message; }
    }
    const step = async () => {
      if (closed || collectors.get(symbol) !== c) return;
      if (c.listeners.size) c.lastAccess = now();
      if (now() - c.lastAccess > COLLECTOR_IDLE_MS) return stopCollector(symbol);
      for (const time of c.ticks.keys()) if (time < now() - 3600000) c.ticks.delete(time);
      if (c.ticks.size > MAX_TICKS) { const keys = [...c.ticks.keys()].sort((a, b) => a - b); for (let i = 0; i < keys.length - MAX_TICKS; i++) c.ticks.delete(keys[i]); }
      c.stream?.heartbeat();
      if (c.stream?.healthy()) return;
      if (c.running) return;
      c.running = true;
      try {
        const previous = c.lastCt;
        const ticks = await pollNewlist(c.productId, symbol, c.lastCt || undefined);
        addAll(ticks);
        publishTicks(c, ticks.filter(tick => tick.time > previous), 'rest');
        if (c.ticks.size > MAX_TICKS) { const keys = [...c.ticks.keys()].sort((a, b) => a - b); for (let i = 0; i < keys.length - MAX_TICKS; i++) c.ticks.delete(keys[i]); }
        c.error = null; lastHistoryAt = now();
      } catch (error) { c.error = error.message; }
      finally { c.running = false; }
    };
    if (closed || collectors.get(symbol) !== c) return;
    c.timer = setInterval(() => { step().catch(() => {}); }, COLLECT_MS); c.timer.unref?.();
    })();
    if (!wait) return c;
    await c.ready;
    assertOpen();
    return c;
  }
  async function getTicks({ symbol, since = 0, limit = 20000 } = {}) {
    if (!Number.isInteger(since) || since < 0 || !Number.isInteger(limit) || limit < 1 || limit > MAX_TICKS) throw new GuruBackendError('GURU_INVALID_QUERY', 'since must be a nonnegative millisecond timestamp; limit must be 1–100000', 400);
    const c = await ensureCollector(symbol);
    let ticks = collectorTicks(symbol);
    if (since) ticks = ticks.filter(t => t.time > Number(since));
    if (ticks.length > limit) ticks = ticks.slice(-limit);
    return { symbol, ticks, count: ticks.length, retained: c.ticks.size, firstCt: collectorTicks(symbol)[0]?.time ?? null, lastCt: c.lastCt || null, collecting: Boolean(c.timer), error: c.error, serverTime: now() };
  }
  async function subscribeTicks({ symbol, onTicks, onClose } = {}) {
    if (typeof onTicks !== 'function') throw new GuruBackendError('GURU_INVALID_QUERY', 'A tick listener is required', 400);
    // Listen before the hour backfill finishes; it can take up to the stream timeout while live ticks already flow.
    const c = await ensureCollector(symbol, false);
    let delivered = false;
    const listener = { onTicks: event => { delivered = true; onTicks(event); }, onClose };
    c.listeners.add(listener); c.lastAccess = now();
    const detach = () => { c.listeners.delete(listener); c.lastAccess = now(); };
    try {
      await c.ready;
      assertOpen();
      if (!delivered && c.latestTick && c.listeners.has(listener)) onTicks({ symbol, ticks: [c.latestTick], transport: c.stream?.healthy() ? 'websocket' : 'rest', serverTime: now() });
    } catch (error) { detach(); throw error; }
    return detach;
  }
  const CANDLE_INTERVALS = [5, 10, 15, 30, 60, 180, 300, 900, 1800, 3600];
  async function getCandles({ symbol, interval = 60 }) {
    interval = Number(interval);
    if (!CANDLE_INTERVALS.includes(interval)) throw new GuruBackendError('GURU_UNSUPPORTED_INTERVAL', 'Unsupported chart interval', 400);
    const c = await ensureCollector(symbol);
    const ticks = collectorTicks(symbol).filter(t => t.time >= now() - 3600000);
    const candles = aggregateGuruTicks(ticks, interval, now()).map(bar => ({ time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: 0, observations: bar.observations }));
    const points = [...new Map([...c.points, ...ticks.map(t => ({ time: t.time / 1000, value: t.price }))].filter(p => p.time >= now() / 1000 - 3600 && p.time <= now() / 1000).map(p => [p.time, p])).values()].sort((a, b) => a.time - b.time);
    return { kind: candles.length ? 'candles' : 'line', candles, points, symbol, interval, retainedTicks: c.ticks.size, source: 'guru', mode: 'live', serverTime: now(), volumeAvailable: false, collectorError: c.historyError || c.error, historyComplete: c.stream?.historyComplete() ?? false, provenance: { endpoint: c.stream?.historyComplete() ? 'websocket:QUOTATION_HIS' : '/ou/quotation/getNewlist', representation: 'aggregated_broker_ticks', nativeOhlc: false, ohlcAvailable: candles.length > 0 } };
  }
  function sanitizeSession(data) {
    if (!data?.token || !data?.userId || !data?.accountNumber) throw new GuruBackendError('GURU_BAD_SESSION', 'GuruTrade did not return a valid session', 502);
    return Object.fromEntries(['userId', 'token', 'deviceId', 'gaid', 'accountNumber'].filter(key => data[key] !== undefined).map(key => [key, data[key]]));
  }
  async function login({ accountNumber, passWord } = {}) {
    if (typeof accountNumber !== 'string' || accountNumber.length < 3 || accountNumber.length > 254) throw new GuruBackendError('GURU_INVALID_LOGIN', 'Enter a valid account', 400);
    if (typeof passWord !== 'string' || passWord.length < 1 || passWord.length > 256) throw new GuruBackendError('GURU_INVALID_LOGIN', 'Enter your password', 400);
    const version = ++sessionVersion;
    const session = sanitizeSession(await post('/ou/user/webLogin', { source: 'email', accountNumber: accountNumber.trim(), passWord }));
    assertOpen();
    if (version !== sessionVersion) throw new GuruBackendError('GURU_SESSION_CHANGED', 'Account changed while signing in. Please retry.', 409);
    account = session;
    for (const symbol of [...collectors.keys()]) stopCollector(symbol);
    cache.clear();
    return { accountNumber: account.accountNumber, loggedIn: true, real: true };
  }
  function logout() { sessionVersion++; account = null; visitor = null; cache.clear(); for (const symbol of [...collectors.keys()]) stopCollector(symbol); return { loggedIn: false }; }
  function requireAccount() {
    if (!account) throw new GuruBackendError('GURU_NOT_AUTHENTICATED', 'Log in to your GuruTrade account first', 401);
  }
  function openOrders() {
    if (!orderDb) {
      if (orderDbPath !== ':memory:') mkdirSync(path.dirname(orderDbPath), { recursive: true });
      orderDb = new DatabaseSync(orderDbPath);
      orderDb.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
        CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL, result TEXT);
        CREATE TABLE IF NOT EXISTS ticks (symbol TEXT NOT NULL, time INTEGER NOT NULL, price REAL NOT NULL, PRIMARY KEY(symbol,time)) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS settlements (id TEXT PRIMARY KEY REFERENCES orders(id), real INTEGER NOT NULL, symbol TEXT NOT NULL, buy_sell INTEGER NOT NULL, amount REAL NOT NULL,
          duration INTEGER, open_time INTEGER, open_price REAL, close_time INTEGER, close_price REAL, result TEXT NOT NULL, profit REAL, balance_after REAL, settled_at INTEGER NOT NULL);`);
      try { orderDb.exec('ALTER TABLE orders ADD COLUMN created_at INTEGER'); } catch {} // pre-existing journals lack it
    }
    return orderDb;
  }
  const orderOwner = (session, real) => createHash('sha256').update(`${session.userId}:${real}`).digest('hex');
  // shortcut: every broker tick is kept forever; add pruning once data/guru-orders.sqlite grows too large.
  function storeTicks(symbol, ticks) {
    if (closed || !ticks.length) return;
    const db = openOrders(), insert = db.prepare('INSERT OR IGNORE INTO ticks VALUES(?,?,?)');
    db.exec('BEGIN');
    try { for (const t of ticks) insert.run(symbol, t.time, t.price); db.exec('COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); lastError = `Tick storage failed: ${error.message}`; }
  }
  function tickAt(symbol, time, side) {
    return openOrders().prepare(side === 'after' ? 'SELECT time,price FROM ticks WHERE symbol=? AND time>=? ORDER BY time LIMIT 1' : 'SELECT time,price FROM ticks WHERE symbol=? AND time<=? ORDER BY time DESC LIMIT 1').get(symbol, time) ?? null;
  }
  // Completed candles from stored ticks; the forming bar is excluded.
  function storedCandles({ symbol, from, to, interval = 60 }) {
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from || to - from > 31 * 86400000) throw new GuruBackendError('GURU_INVALID_QUERY', 'from/to must be millisecond timestamps at most 31 days apart', 400);
    if (!Number.isInteger(interval) || interval < 1) throw new GuruBackendError('GURU_INVALID_QUERY', 'Invalid candle interval', 400);
    const size = interval * 1000, end = Math.min(to, Math.floor(now() / size) * size);
    return openOrders().prepare(`SELECT b*?4 AS time, (SELECT price FROM ticks WHERE symbol=?1 AND time=f) AS open, hi AS high, lo AS low, (SELECT price FROM ticks WHERE symbol=?1 AND time=l) AS close, n AS ticks
      FROM (SELECT time/CAST(?5 AS INTEGER) AS b, MIN(time) f, MAX(time) l, MIN(price) lo, MAX(price) hi, COUNT(*) n FROM ticks WHERE symbol=?1 AND time>=?2 AND time<?3 GROUP BY b) ORDER BY b`)
      .all(symbol, Math.floor(from / size) * size, end, interval, size).map(row => ({ ...row }));
  }
  const storedSymbols = () => openOrders().prepare('SELECT DISTINCT symbol FROM ticks').all().map(row => row.symbol);
  // Worst case for today: settled real results plus every unsettled stake counted as lost.
  function dailyLoss(owner, since) {
    return openOrders().prepare("SELECT o.fingerprint, s.profit FROM orders o LEFT JOIN settlements s ON s.id=o.id WHERE o.created_at>=? AND o.state!='rejected' AND json_extract(o.fingerprint,'$[0]')=?").all(since, owner)
      .reduce((loss, row) => loss + (row.profit === null ? Number(JSON.parse(row.fingerprint)[3]) : -row.profit), 0);
  }
  async function checkRisk(session, value) {
    if (!(value <= risk.maxStake)) throw new GuruBackendError('GURU_RISK_STAKE', `Real orders above ₹${risk.maxStake} are blocked`, 403);
    if (!Number.isFinite(risk.balanceFloor) || !Number.isFinite(risk.dailyLossCap)) throw new GuruBackendError('GURU_RISK_UNCONFIGURED', 'Set GURU_BALANCE_FLOOR and GURU_DAILY_LOSS_CAP before placing real orders', 403);
    const { real: balance } = await getBalance();
    if (balance - value < risk.balanceFloor) throw new GuruBackendError('GURU_RISK_FLOOR', `This order could take the balance below the ₹${risk.balanceFloor} floor`, 403);
    const day = new Date(now()); day.setHours(0, 0, 0, 0);
    if (dailyLoss(orderOwner(session, true), day.getTime()) + value > risk.dailyLossCap) throw new GuruBackendError('GURU_RISK_DAILY_CAP', `Today's loss could exceed the ₹${risk.dailyLossCap} cap`, 403);
  }
  let realQueue = Promise.resolve();
  // Real orders pass the risk check one at a time, so two clicks cannot both fit under the same limit.
  function realLock() { let release; const previous = realQueue; realQueue = new Promise(resolve => { release = resolve; }); return previous.then(() => release); }
  const CSV_COLUMNS = ['settled_at', 'id', 'real', 'symbol', 'buy_sell', 'amount', 'duration', 'open_time', 'open_price', 'close_time', 'close_price', 'result', 'profit', 'balance_after'];
  let settling = false;
  // Result is derived from stored broker ticks at expiry (no verified broker settlement endpoint); balance_after is the broker's.
  async function settleDue() {
    if (!orderDb || closed || settling) return;
    settling = true;
    try {
      const rows = orderDb.prepare("SELECT o.id, o.result FROM orders o LEFT JOIN settlements s ON s.id=o.id WHERE o.state='confirmed' AND s.id IS NULL AND o.created_at IS NOT NULL").all();
      for (const row of rows) {
        const r = JSON.parse(row.result), openTime = milliseconds(r.openPositionTimestamp) ?? r.quotationTime;
        const closeTime = milliseconds(r.closeTime) ?? openTime + (r.duration ?? 60) * 1000;
        if (now() < closeTime + 3000) continue;
        const near = (time, side) => { const tick = tickAt(r.symbol, time, side); return tick && Math.abs(tick.time - time) <= 5000 ? tick.price : null; };
        const openPrice = r.openPrice ?? near(openTime, 'before'), closePrice = near(closeTime, 'before');
        if ((openPrice === null || closePrice === null) && now() < closeTime + 60000) continue;
        const move = openPrice === null || closePrice === null ? null : Math.sign(closePrice - openPrice) * r.buySell;
        const result = move === null ? 'unknown' : move > 0 ? 'won' : move < 0 ? 'lost' : 'draw';
        const profit = result === 'won' ? (r.payout === null || r.payout === undefined ? null : Math.round(r.amount * r.payout) / 100) : result === 'lost' ? -r.amount : result === 'draw' ? 0 : null;
        let balanceAfter = null;
        try { const balance = await getBalance({ demo: !r.real }); balanceAfter = r.real ? balance.real : balance.demo; } catch {}
        if (closed) return;
        const record = { settled_at: now(), id: row.id, real: r.real ? 1 : 0, symbol: r.symbol, buy_sell: r.buySell, amount: r.amount, duration: r.duration ?? null, open_time: openTime, open_price: openPrice, close_time: closeTime, close_price: closePrice, result, profit, balance_after: balanceAfter };
        if (!orderDb.prepare(`INSERT OR IGNORE INTO settlements(${CSV_COLUMNS}) VALUES(${CSV_COLUMNS.map(() => '?')})`).run(...CSV_COLUMNS.map(k => record[k])).changes) continue;
        if (settlementCsvPath) {
          const line = CSV_COLUMNS.map(k => record[k] ?? '').join(',') + '\n';
          appendFileSync(settlementCsvPath, existsSync(settlementCsvPath) ? line : CSV_COLUMNS.join(',') + '\n' + line);
        }
      }
    } finally { settling = false; }
  }
  const settleTimer = setInterval(() => { settleDue().catch(error => { lastError = `Settlement logging failed: ${error.message}`; }); }, 5000);
  settleTimer.unref?.();
  async function getOrderHistory({ demo = false } = {}) {
    assertOpen();
    if (!demo) requireAccount();
    const session = account ?? await ensureVisitor();
    const owner = orderOwner(session, !demo);
    const rows = openOrders().prepare("SELECT * FROM orders WHERE json_extract(fingerprint,'$[0]')=? ORDER BY rowid DESC LIMIT 100").all(owner);
    return { source: 'local_order_journal', settlementAvailable: false, real: !demo, orders: rows.map(row => {
      const [, symbol, buySell, amount] = JSON.parse(row.fingerprint);
      return { requestId: row.id, symbol, buySell, amount: Number(amount), state: row.state === 'pending' ? 'unconfirmed' : row.state, ...(row.state === 'confirmed' ? JSON.parse(row.result) : {}) };
    }) };
  }
  // getBalance returns both wallets at once: `balance` is real money, `simulation` is the demo balance (verified live).
  async function getBalance({ demo = false } = {}) {
    if (!demo) requireAccount();
    const data = await post('/ou/user/getBalance/auth', {}, true, { retryTransient: true });
    const real = account ? finite(data?.balance) : null, simulation = finite(data?.simulation);
    if (simulation === null || simulation < 0 || (account && (real === null || real < 0))) throw new GuruBackendError('GURU_BAD_BALANCE', 'GuruTrade returned an invalid balance');
    return { real, demo: simulation, bonus: finite(data?.bonus), currency: 'rupee', serverTime: now() };
  }
  async function getActiveDeals({ demo = false } = {}) {
    if (!demo) requireAccount();
    const data = await post(demo ? '/ou/simulation/trade/unliquidated/list/auth' : '/ou/trade/unliquidated/list/auth', {}, true, { retryTransient: true });
    const rows = Array.isArray(data) ? data : Array.isArray(data?.list) ? data.list : null;
    if (!rows) throw new GuruBackendError('GURU_BAD_RESPONSE', 'GuruTrade returned invalid open deals', 502);
    if (rows.length > 500) throw new GuruBackendError('GURU_BAD_RESPONSE', 'GuruTrade returned too many open deals', 502);
    return { deals: rows.map(row => ({ positionId: row.positionId ?? row.id ?? null, symbol: typeof row.symbol === 'string' ? row.symbol : null, buySell: finite(row.buySell), amount: finite(row.amount), openPrice: finite(row.openPrice), openPositionTimestamp: finite(row.openPositionTimestamp ?? row.openPositionTime) })), real: !demo, serverTime: now() };
  }
  // Web submit payload (RE'd): {productId, amount, buySell(1=up,-1=down), oneClick, quotationTime}. No duration field exists.
  async function submitTrade({ symbol, buySell, amount, oneClick = 1, real = false, requestId, duration } = {}) {
    assertOpen();
    if (typeof real !== 'boolean') throw new GuruBackendError('GURU_INVALID_TRADE', 'real must be a boolean', 400);
    if (real) requireAccount();
    if (real && !allowReal) throw new GuruBackendError('GURU_REAL_DISABLED', 'Real orders are disabled. Set GURU_ALLOW_REAL=1 and restart to enable them.', 403);
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(requestId)) throw new GuruBackendError('GURU_INVALID_TRADE', 'A unique requestId is required for every order', 400);
    if (buySell !== 1 && buySell !== -1) throw new GuruBackendError('GURU_INVALID_TRADE', 'Direction must be 1 (up) or -1 (down)', 400);
    if (oneClick !== 0 && oneClick !== 1) throw new GuruBackendError('GURU_INVALID_TRADE', 'oneClick must be 0 or 1', 400);
    const value = finite(amount);
    if (duration !== undefined && (!Number.isInteger(duration) || duration < 1)) throw new GuruBackendError('GURU_UNSUPPORTED_DURATION', 'Duration must be an available number of seconds', 400);
    if (value === null || !/^\d{1,9}(?:\.\d{1,2})?$/.test(String(amount)) || value <= 0 || value > 1e9) throw new GuruBackendError('GURU_INVALID_TRADE', 'Enter a positive trade amount with at most two decimal places', 400);
    const session = account ?? await ensureVisitor();
    const version = sessionVersion;
    const key = requestId;
    const fingerprint = JSON.stringify([orderOwner(session, real), symbol, buySell, String(value), oneClick, real, duration ?? null]);
    if (orders.has(key)) {
      if (orders.get(key).fingerprint !== fingerprint) throw new GuruBackendError('GURU_ORDER_CONFLICT', 'Request ID was already used for a different order', 409);
      return orders.get(key).promise;
    }
    openOrders();
    const previous = orderDb.prepare('SELECT * FROM orders WHERE id=?').get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new GuruBackendError('GURU_ORDER_CONFLICT', 'Request ID was already used for a different order', 409);
      if (previous.state === 'confirmed') return JSON.parse(previous.result);
      const failure = previous.state === 'rejected' ? JSON.parse(previous.result) : { code: 'GURU_ORDER_UNKNOWN', message: 'This order may already have been placed. Check broker trades before submitting a new order.', status: 409 };
      throw new GuruBackendError(failure.code, failure.message, failure.status);
    }
    const execution = (async () => {
    const release = real ? await realLock() : null;
    try {
    const market = await instrument(symbol);
    const selectedDuration = duration ?? (market.supportedDurations.includes(60) ? 60 : market.supportedDurations[0]);
    if (selectedDuration !== undefined && !market.supportedDurations.includes(selectedDuration)) throw new GuruBackendError('GURU_UNSUPPORTED_DURATION', 'This duration is not offered for this broker product. Choose an enabled duration.', 400);
    const timeOption = market.durationOptions.find(option => option.seconds === selectedDuration);
    if (!market.tradable) throw new GuruBackendError('GURU_MARKET_CLOSED', 'This instrument is not currently tradable', 409);
    const minimum = real ? market.minimumAmount : market.demoMinimumAmount, maximum = real ? market.maximumAmount : market.demoMaximumAmount;
    if ((minimum !== null && value < minimum) || (maximum !== null && value > maximum)) throw new GuruBackendError('GURU_INVALID_TRADE', 'Trade amount is outside this instrument’s limits', 400);
    if (real) await checkRisk(session, value);
    const quote = await getQuote({ symbol });
    if (quote.stale) throw new GuruBackendError('GURU_STALE_QUOTE', 'The broker quote is stale. Wait for a fresh quote.', 409);
    if (version !== sessionVersion || session !== (account ?? visitor)) throw new GuruBackendError('GURU_SESSION_CHANGED', 'Account changed before submission. Please retry.', 409);
    // quotationTime MUST be milliseconds (the broker rejects a seconds value with code 10316). requestTime matches the web client.
    const payload = { productId: market.productId, symbol, amount: String(value), buySell, oneClick, quotationTime: quote.quotedAt, requestTime: now() };
    if (market.durationSource === 'tradeTimeRespList' && timeOption) { payload.timeUnit = timeOption.timeUnit; payload.timeUnitType = timeOption.timeUnitType; }
    const endpoint = real ? '/ou/trade/submit2/auth' : market.durationSource === 'tradeTimeRespList' ? '/ou/simulation/trade/submit3/auth' : '/ou/simulation/trade/submit2/auth';
    // Persist before sending: a lost response or restart must never cause an automatic resubmission.
    const inserted = orderDb.prepare("INSERT OR IGNORE INTO orders(id,fingerprint,state,result,created_at) VALUES(?,?,'pending',NULL,?)").run(key, fingerprint, now());
    if (!inserted.changes) throw new GuruBackendError('GURU_ORDER_UNKNOWN', 'This request is already recorded. Check broker trades before submitting again.', 409);
    release?.();
    ensureCollector(symbol, false).catch(() => {}); // settlement needs ticks at expiry
    try {
    const data = await post(endpoint, payload, true);
    if (!data?.positionId || !['string', 'number'].includes(typeof data.positionId)) throw new GuruBackendError('GURU_ORDER_UNKNOWN', 'Broker returned no order ID. Check broker trades before submitting another order.', 409);
    const result = {
      placed: true, requestId, real, symbol, buySell, amount: value, oneClick, duration: selectedDuration ?? null, quotationTime: payload.quotationTime,
      positionId: data?.positionId ?? null, openPrice: finite(data?.openPrice), openPositionTimestamp: finite(data?.openPositionTimestamp),
      closeTime: finite(data?.closeTime), settleTimestamp: finite(data?.settleTimestamp), grossProfit: finite(data?.grossProfit),
      currency: typeof data?.currencyType === 'string' ? data.currencyType : null, payout: timeOption?.payout ?? market.payout, serverTime: now(),
    };
    orderDb.prepare("UPDATE orders SET state='confirmed',result=? WHERE id=?").run(JSON.stringify(result), key);
    return result;
    } catch (error) {
      if (['GURU_REJECTED', 'GURU_TRANSIENT', 'GURU_SESSION_EXPIRED'].includes(error.code)) {
        orderDb.prepare("UPDATE orders SET state='rejected',result=? WHERE id=?").run(JSON.stringify({ code: error.code, message: error.message, status: error.status }), key);
        throw error;
      }
      throw new GuruBackendError('GURU_ORDER_UNKNOWN', 'Order confirmation was lost. Check broker trades before submitting a new order.', 409);
    }
    } finally { release?.(); }
    })();
    orders.set(key, { fingerprint, promise: execution });
    try { return await execution; } finally {
      orders.delete(key);
      if (closed && !orders.size && orderDb) { orderDb.close(); orderDb = null; }
    }
  }
  function status() {
    return { source: 'guru', mode: 'live', connected: !closed && lastCatalogAt !== null && now() - lastCatalogAt < 30000, closed, catalogCount, lastCatalogAt, lastQuoteAt, lastHistoryAt, lastError, anonymousVisitor: visitor !== null, loggedIn: account !== null, accountNumber: account?.accountNumber ?? null, ohlcAvailable: false, volumeAvailable: false, realOrdersEnabled: allowReal, orderExecution: account !== null && allowReal, demoOrderExecution: !closed, collectors: [...collectors.values()].map(c => ({ symbol: c.symbol, retained: c.ticks.size, lastCt: c.lastCt || null, error: c.error })) };
  }
  function close() {
    closed = true; sessionVersion++; visitor = null; account = null; cache.clear(); clearInterval(settleTimer);
    for (const symbol of [...collectors.keys()]) stopCollector(symbol);
    for (const controller of controllers) controller.abort();
    if (!orders.size && orderDb) { orderDb.close(); orderDb = null; }
  }
  const watch = async symbol => { await ensureCollector(symbol, false); };
  return { getMarkets, getQuote, getCandles, getTicks, subscribeTicks, watch, storedCandles, storedSymbols, tickAt, settleDue, login, logout, getBalance, getActiveDeals, getOrderHistory, submitTrade, status, close };
}
