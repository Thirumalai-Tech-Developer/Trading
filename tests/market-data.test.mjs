import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseCSV, parseBars, dataQuery, createBarsReader, barsCSV } from '../market-data.mjs';
import { createApp } from '../server.mjs';

// These prices are explicit test fixtures, not a market dataset.
const header = 'timestamp,symbol,open,high,low,close,volume';
const fixture = `${header}\r\n2026-10-23T09:17:00+05:30,NIFTY,24100,24120,24090,24110,\r\n2026-10-23T09:16:00+05:30,BANKNIFTY,51000,51040,50980,51020,100\r\n2026-10-23T09:16:00+05:30,NIFTY,24090,24110,24080,24100,0\r\n2026-10-23T09:18:00+05:30,NIFTY,24110,24130,24100,24120,0\r\n`;
const now = Date.parse('2026-10-23T09:17:30+05:30');

test('CSV handles BOM, quoted fields, escaped quotes, newlines, and CRLF', () => {
  assert.deepEqual(parseCSV('\uFEFFone,two\r\n"a,b","c""d"\r\n"e\nf",g\r\n'), [['one', 'two'], ['a,b', 'c"d'], ['e\nf', 'g']]);
  for (const source of ['"unterminated', 'a"b,c', '"a"b,c']) assert.throws(() => parseCSV(source));
});

test('bars enforce timezone, calendar date, OHLC, volume, and unique candle identity', () => {
  const result = parseBars(fixture);
  assert.equal(result.length, 4);
  assert.equal(result[0].bar.symbol, 'BANKNIFTY');
  assert.equal(result[2].bar.volume, 0);
  assert.equal(result[2].bar.timestamp, '2026-10-23T09:17:00+05:30');
  const valid = '2026-10-23T09:16:00+05:30,NIFTY,100,110,90,105,0';
  const invalid = [
    valid.replace('+05:30', ''), valid.replace('09:16:00', '09:16:01'),
    valid.replace('2026-10-23', '2026-02-30'), valid.replace('+05:30', '+15:00'),
    valid.replace('NIFTY', 'UNKNOWN'), valid.replace(',110,', ',99,'),
    valid.replace(',90,', ',106,'), valid.replace(',100,', ',NaN,'),
    valid.replace(/,0$/, ',-1'), valid.replace(/,0$/, ',1.2'),
    valid.replace(/,0$/, ',9007199254740992'), `${valid}\n${valid}`,
  ];
  for (const row of invalid) assert.throws(() => parseBars(`${header}\n${row}`), undefined, row);
  assert.throws(() => parseBars('timestamp,symbol,open,high,low,close,close\n'));
  assert.throws(() => parseBars(`${header}\n${valid},extra`));
  assert.throws(() => parseBars(`${header}\n,,,,,,`));
  assert.equal(parseBars('timestamp,symbol,open,high,low,close\n2026-10-23T03:46:00Z,NIFTY,100,110,90,105')[0].bar.volume, 0);
});

test('query validates symbols, limits, formats, filters, and repeated fields', () => {
  const query = dataQuery(new URLSearchParams('symbol=NIFTY&limit=25&format=csv&from=2026-10-23T03:46:00Z'));
  assert.equal(query.limit, 25);
  assert.equal(query.from, Date.parse('2026-10-23T03:46:00Z'));
  for (const input of ['symbol=BTCUSD', 'symbol=', 'limit=0', 'limit=10001', 'limit=1.2', 'limit=1e2', 'format=xml', 'interval=5m', 'symbol=NIFTY&symbol=BANKNIFTY', 'from=2026-10-23', 'from=2026-02-30T00:00:00Z', 'from=2026-10-23T24:00:00Z', 'from=2026-10-23T00:00:00%2B14:30', 'from=2026-10-24T00:00:00Z&to=2026-10-23T00:00:00Z']) {
    assert.throws(() => dataQuery(new URLSearchParams(input)), error => error.status === 400, input);
  }
});

test('reader excludes unfinished candles, filters, limits, and reloads on file replacement', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'trading-data-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'bars.csv'), read = createBarsReader(file);
  await assert.rejects(read(dataQuery(new URLSearchParams()), now), error => error.status === 503);
  await writeFile(file, fixture);
  const result = await read(dataQuery(new URLSearchParams()), now);
  assert.equal(result.count, 3);
  assert.equal(result.data.at(-1).timestamp, '2026-10-23T09:17:00+05:30');
  assert.deepEqual(Object.keys(result.data[0]), ['timestamp', 'symbol', 'open', 'high', 'low', 'close', 'volume']);
  const recent = await read(dataQuery(new URLSearchParams('symbol=NIFTY&limit=1')), now);
  assert.equal(recent.total, 2); assert.equal(recent.truncated, true); assert.equal(recent.data.length, 1);
  const exact = await read(dataQuery(new URLSearchParams('from=2026-10-23T03:46:00Z&to=2026-10-23T03:46:00Z')), now);
  assert.equal(exact.count, 2);
  assert.equal(barsCSV(recent), `${header}\r\n2026-10-23T09:17:00+05:30,NIFTY,24100,24120,24090,24110,0\r\n`);
  await writeFile(file, `${header}\n`);
  assert.equal((await read(dataQuery(new URLSearchParams()), now)).count, 0);
  await writeFile(file, 'corrupt');
  await assert.rejects(read(dataQuery(new URLSearchParams()), now), error => error.status === 503 && error.message.includes('Invalid bars.csv'));
});

test('GET /v1/data serves JSON/CSV without login and validates methods and missing data', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'trading-http-data-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'bars.csv');
  const app = createApp({ dbPath: ':memory:', barsPath: file, now: () => now }); t.after(app.close);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const missing = await fetch(base + '/v1/data');
  assert.equal(missing.status, 503); assert.match((await missing.json()).error, /No simulated data/);
  await writeFile(file, fixture);
  const response = await fetch(base + '/v1/data?symbol=NIFTY');
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json(); assert.equal(body.interval, '1m'); assert.equal(body.count, 2); assert.equal(body.data[0].symbol, 'NIFTY');
  const csv = await fetch(base + '/v1/data?symbol=BANKNIFTY&format=csv');
  assert.equal(csv.status, 200); assert.match(csv.headers.get('content-type'), /text\/csv/); assert.match(csv.headers.get('content-disposition'), /bars.csv/);
  assert.equal(parseBars(await csv.text()).length, 1);
  assert.equal((await fetch(base + '/v1/data?symbol=EURUSD')).status, 400);
  const method = await fetch(base + '/v1/data', { method: 'POST' }); assert.equal(method.status, 405); assert.equal(method.headers.get('allow'), 'GET');
  assert.equal((await fetch(base + '/bars.csv')).status, 404);
  assert.equal((await fetch(base + '/')).status, 200);
});
