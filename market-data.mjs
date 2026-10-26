import { readFile, stat } from 'node:fs/promises';

const REQUIRED = ['timestamp', 'symbol', 'open', 'high', 'low', 'close'];
const FIELDS = [...REQUIRED, 'volume'];
const SYMBOLS = new Set(['NIFTY', 'BANKNIFTY']);

export class DataError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// RFC 4180 quoting, escaped quotes, CRLF, and a UTF-8 BOM are supported.
export function parseCSV(source) {
  const rows = [];
  let row = [], field = '', quoted = false, afterQuote = false;
  source = source.replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === '"') {
        if (source[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; afterQuote = true; }
      } else field += c;
    } else if (c === '"') {
      if (field || afterQuote) throw new Error('Unexpected quote in CSV field');
      quoted = true;
    } else if (c === ',' || c === '\r' || c === '\n') {
      row.push(field); field = ''; afterQuote = false;
      if (c !== ',') {
        if (c === '\r' && source[i + 1] === '\n') i++;
        if (row.length !== 1 || row[0] !== '') rows.push(row);
        row = [];
      }
    } else {
      if (afterQuote) throw new Error('Unexpected character after closing CSV quote');
      field += c;
    }
  }
  if (quoted) throw new Error('Unclosed CSV quote');
  if (field || row.length || afterQuote) {
    row.push(field);
    if (row.length !== 1 || row[0] !== '') rows.push(row);
  }
  return rows;
}

function number(value, field, line) {
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) throw new Error(`Row ${line}: invalid ${field}`);
  const result = Number(value);
  if (!Number.isFinite(result) || result > Number.MAX_SAFE_INTEGER) throw new Error(`Row ${line}: invalid ${field}`);
  return result;
}

export function parseBars(source) {
  const rows = parseCSV(source);
  if (!rows.length) throw new Error('CSV is empty; expected timestamp,symbol,open,high,low,close,volume');
  const headers = rows.shift().map(value => value.trim());
  if (new Set(headers).size !== headers.length || REQUIRED.some(field => !headers.includes(field))) {
    throw new Error('CSV requires unique timestamp,symbol,open,high,low,close columns; volume is optional');
  }
  const seen = new Set();
  return rows.map((values, i) => {
    const line = i + 2;
    if (values.length !== headers.length) throw new Error(`Row ${line}: column count does not match the header`);
    const raw = Object.fromEntries(headers.map((header, index) => [header, values[index].trim()]));
    if (!SYMBOLS.has(raw.symbol)) throw new Error(`Row ${line}: symbol must be NIFTY or BANKNIFTY`);
    // Require a complete ISO timestamp; Date.parse alone normalizes invalid dates.
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):00(?:\.0{1,3})?(Z|[+-](\d{2}):(\d{2}))$/.exec(raw.timestamp);
    if (!match) throw new Error(`Row ${line}: timestamp must be a timezone-aware ISO 8601 completed minute`);
    const [, year, month, day, hour, minute, zone, offsetHour, offsetMinute] = match;
    const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
    if (+year < 1970 || +month < 1 || +month > 12 || +day < 1 || +day > days || +hour > 23 || +minute > 59 || +(offsetHour || 0) > 14 || +(offsetMinute || 0) > 59 || (+offsetHour === 14 && +offsetMinute !== 0)) {
      throw new Error(`Row ${line}: invalid calendar date or timezone offset`);
    }
    const time = Date.parse(raw.timestamp);
    if (!Number.isFinite(time) || time % 60000 !== 0) throw new Error(`Row ${line}: invalid completed minute`);
    const key = `${raw.symbol}:${time}`;
    if (seen.has(key)) throw new Error(`Row ${line}: duplicate symbol and candle timestamp`);
    seen.add(key);
    const bar = { timestamp: `${year}-${month}-${day}T${hour}:${minute}:00${zone}`, symbol: raw.symbol };
    for (const field of ['open', 'high', 'low', 'close']) bar[field] = number(raw[field], field, line);
    if (bar.low <= 0 || bar.high < bar.low || bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close)) throw new Error(`Row ${line}: invalid OHLC price range`);
    bar.volume = raw.volume == null || raw.volume === '' ? 0 : number(raw.volume, 'volume', line);
    if (!Number.isSafeInteger(bar.volume)) throw new Error(`Row ${line}: volume must be a nonnegative safe integer`);
    return { time, bar };
  }).sort((a, b) => a.time - b.time || a.bar.symbol.localeCompare(b.bar.symbol));
}

function filterTime(value, name) {
  if (value === null) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  let valid = Boolean(match) && Number.isFinite(Date.parse(value));
  if (valid) {
    const [, year, month, day, hour, minute, second = '00', , offsetHour = '0', offsetMinute = '0'] = match;
    const calendar = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
    const local = new Date(`${calendar}Z`);
    valid = +year >= 1970 && Number.isFinite(local.getTime()) && local.toISOString().startsWith(calendar) && +offsetHour <= 14 && +offsetMinute <= 59 && !(+offsetHour === 14 && +offsetMinute !== 0);
  }
  if (!valid) {
    throw new DataError(400, `${name} must be a timezone-aware ISO 8601 timestamp (encode + as %2B in URLs)`);
  }
  return Date.parse(value);
}

export function dataQuery(params) {
  for (const key of params.keys()) {
    if (!['symbol', 'from', 'to', 'limit', 'format'].includes(key)) throw new DataError(400, `Unknown query parameter: ${key}`);
    if (params.getAll(key).length !== 1) throw new DataError(400, `Repeated query parameter: ${key}`);
  }
  const symbol = params.get('symbol');
  if (symbol !== null && !SYMBOLS.has(symbol)) throw new DataError(400, 'symbol must be NIFTY or BANKNIFTY');
  const limit = params.get('limit') ?? '1000';
  if (!/^[1-9]\d{0,4}$/.test(limit) || Number(limit) > 10000) throw new DataError(400, 'limit must be an integer from 1 to 10000');
  const format = params.get('format') ?? 'json';
  if (!['json', 'csv'].includes(format)) throw new DataError(400, 'format must be json or csv');
  const from = filterTime(params.get('from'), 'from'), to = filterTime(params.get('to'), 'to');
  if (from !== null && to !== null && from > to) throw new DataError(400, 'from must be before or equal to to');
  return { symbol, from, to, limit: Number(limit), format };
}

export function createBarsReader(filename) {
  let cached;
  return async (query, now = Date.now()) => {
    let info;
    try { info = await stat(filename); }
    catch (error) {
      if (error.code === 'ENOENT') throw new DataError(503, 'bars.csv is not available. Supply completed one-minute NIFTY/BANKNIFTY candles at BARS_CSV or ./bars.csv. No simulated data is substituted.');
      throw new DataError(503, 'Cannot read the configured bars.csv source');
    }
    if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new DataError(503, 'bars.csv must be a regular UTF-8 file no larger than 64 MiB');
    const signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    if (cached?.signature !== signature) {
      let rows;
      try {
        const source = await readFile(filename, 'utf8');
        const after = await stat(filename);
        if (source.includes('\uFFFD') || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs || after.ino !== info.ino) throw new Error('Source changed while reading or is not valid UTF-8; retry after the file is fully written');
        rows = parseBars(source);
      } catch (error) {
        throw new DataError(503, `Invalid bars.csv: ${error.code ? 'source could not be read' : error.message}`);
      }
      cached = { signature, rows };
    }
    const through = Math.min(query.to ?? now, now);
    const matching = cached.rows.filter(row => row.time <= through && (query.from === null || row.time >= query.from) && (!query.symbol || row.bar.symbol === query.symbol));
    // shortcut: timestamp is the source's candle-close time; source producers must not label open times as close times.
    return { interval: '1m', timestampMeaning: 'candle_close', source: 'bars.csv', count: Math.min(matching.length, query.limit), total: matching.length, truncated: matching.length > query.limit, data: matching.slice(-query.limit).map(row => row.bar) };
  };
}

export function barsCSV(result) {
  return `${FIELDS.join(',')}\r\n${result.data.map(bar => FIELDS.map(field => bar[field]).join(',')).join('\r\n')}${result.data.length ? '\r\n' : ''}`;
}
