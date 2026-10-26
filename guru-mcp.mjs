#!/usr/bin/env node
// GuruTrade MCP server (stdio, JSON-RPC 2.0, dependency-free).
// Exposes the GuruTrade backend as agent tools so Codex / Claude Code can trade.
// Real-money orders are disabled unless GURU_ALLOW_REAL=1 is set in the environment.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuruBackend, GuruBackendError } from './guru-backend.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ALLOW_REAL = process.env.GURU_ALLOW_REAL === '1';
const PROTOCOL_VERSION = '2024-11-05';
const guru = createGuruBackend({});

// Auto sign-in from the root .cred file (mail="..."/pass="..."), best-effort.
let loginReady = Promise.resolve();
try {
  if (process.env.GURU_AUTO_LOGIN === '0') throw new Error('Auto-login disabled');
  const text = readFileSync(path.join(ROOT, '.cred'), 'utf8');
  const field = key => text.match(new RegExp(`${key}="([^"]*)"`))?.[1];
  const accountNumber = field('mail'), passWord = field('pass');
  if (accountNumber && passWord) loginReady = guru.login({ accountNumber, passWord }).catch(() => {});
} catch { /* no .cred: tools still work for public market data, and guru_login can be called */ }

const num = { type: 'number' }, str = { type: 'string' }, bool = { type: 'boolean' };
const TOOLS = [
  { name: 'guru_status', description: 'GuruTrade connection/account status: logged-in account, order-execution readiness, and active tick collectors.',
    inputSchema: { type: 'object', properties: {} }, handler: () => guru.status() },
  { name: 'guru_login', description: 'Sign in to a GuruTrade account (real). Usually unnecessary — the server auto-signs-in from .cred.',
    inputSchema: { type: 'object', properties: { accountNumber: str, passWord: str }, required: ['accountNumber', 'passWord'] },
    handler: a => guru.login(a) },
  { name: 'guru_balance', description: 'Account balances: { real, demo, bonus } in rupee. Real money vs demo/practice wallet.',
    inputSchema: { type: 'object', properties: { demo: bool } }, handler: a => guru.getBalance({ demo: a.demo !== false }) },
  { name: 'guru_logout', description: 'Disconnect the current GuruTrade account.',
    inputSchema: { type: 'object', properties: {} }, handler: () => guru.logout() },
  { name: 'guru_orders', description: 'Recorded submissions from this app. This is an order journal, not broker settlement history.',
    inputSchema: { type: 'object', properties: { demo: bool } }, handler: a => guru.getOrderHistory({ demo: a.demo !== false }) },
  { name: 'guru_markets', description: 'List all tradable instruments (symbol, name, category, payout %, price, min/max amount, tradable).',
    inputSchema: { type: 'object', properties: {} }, handler: () => guru.getMarkets() },
  { name: 'guru_quote', description: 'Current price for one instrument symbol (price, quotedAt ms, ageMs, stale).',
    inputSchema: { type: 'object', properties: { symbol: str }, required: ['symbol'] }, handler: a => guru.getQuote(a) },
  { name: 'guru_candles', description: 'OHLC candles aggregated from broker quotes (no volume). interval seconds: 5/10/15/30/60/180/300. History up to ~1h, grows while the server runs.',
    inputSchema: { type: 'object', properties: { symbol: str, interval: num }, required: ['symbol'] }, handler: a => guru.getCandles(a) },
  { name: 'guru_ticks', description: 'Raw high-frequency price ticks {time ms, price} for AI/analysis. Starts a continuous collector. Use `since` (ms) to pull only newer ticks incrementally.',
    inputSchema: { type: 'object', properties: { symbol: str, since: num, limit: num }, required: ['symbol'] }, handler: a => guru.getTicks(a) },
  { name: 'guru_open_trades', description: 'List open (unsettled) trades. demo=true for the demo wallet, false for real.',
    inputSchema: { type: 'object', properties: { demo: bool }, required: [] }, handler: a => guru.getActiveDeals({ demo: a.demo !== false }) },
  { name: 'guru_place_order', description: `Place a fixed-time (binary) order. direction "up"=Higher, "down"=Lower. amount in rupee. flash=one-click. demo=true (default) uses virtual funds; demo=false places REAL money${ALLOW_REAL ? '' : ' and is DISABLED (set GURU_ALLOW_REAL=1 to enable)'}.`,
    inputSchema: { type: 'object', properties: { symbol: str, direction: { type: 'string', enum: ['up', 'down'] }, amount: num, demo: bool, flash: bool, duration: { type: 'number', description: 'Seconds; must be one of the instrument supportedDurations from guru_markets.' }, requestId: { type: 'string', minLength: 8, maxLength: 128 } }, required: ['symbol', 'direction', 'amount', 'requestId'] },
    handler: a => {
      const real = a.demo === false;
      if (real && !ALLOW_REAL) throw new GuruBackendError('GURU_REAL_DISABLED', 'Real-money orders are disabled. Restart the server with GURU_ALLOW_REAL=1 to allow them.', 403);
      return guru.submitTrade({ symbol: a.symbol, buySell: a.direction === 'up' ? 1 : -1, amount: a.amount, oneClick: a.flash === false ? 0 : 1, real, requestId: a.requestId, duration: a.duration });
    } },
];
for (const tool of TOOLS) tool.inputSchema.additionalProperties = false;
const BY_NAME = new Map(TOOLS.map(t => [t.name, t]));

function validateArgs(args, schema) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new GuruBackendError('GURU_INVALID_ARGUMENTS', 'Tool arguments must be an object', 400);
  for (const key of schema.required || []) if (!(key in args)) throw new GuruBackendError('GURU_INVALID_ARGUMENTS', `Missing ${key}`, 400);
  for (const [key, value] of Object.entries(args)) {
    const field = schema.properties[key];
    if (!field || typeof value !== field.type || (field.type === 'number' && !Number.isFinite(value)) || (field.enum && !field.enum.includes(value)) || (field.minLength && value.length < field.minLength) || (field.maxLength && value.length > field.maxLength)) throw new GuruBackendError('GURU_INVALID_ARGUMENTS', `Invalid ${key}`, 400);
  }
}

function send(message) { process.stdout.write(JSON.stringify(message) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function fail(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handle(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return fail(null, -32600, 'Invalid Request');
  const { id, method, params } = message;
  if (id === undefined && !method.startsWith('notifications/')) return;
  if (method === 'initialize') return reply(id, { protocolVersion: params?.protocolVersion || PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'gurutrade', version: '1.0.0' } });
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return; // notifications: no reply
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  if (method === 'tools/call') {
    const tool = BY_NAME.get(params?.name);
    if (!tool) return reply(id, { content: [{ type: 'text', text: `Unknown tool: ${params?.name}` }], isError: true });
    try {
      validateArgs(params.arguments ?? {}, tool.inputSchema);
      if (['guru_login', 'guru_logout', 'guru_balance', 'guru_open_trades', 'guru_orders', 'guru_place_order'].includes(tool.name)) await loginReady;
      const result = await tool.handler(params.arguments || {});
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
    } catch (error) {
      const text = error instanceof GuruBackendError ? `${error.code}: ${error.message}` : `Error: ${error.message}`;
      return reply(id, { content: [{ type: 'text', text }], isError: true });
    }
  }
  if (id !== undefined) fail(id, -32601, `Method not found: ${method}`);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  if (Buffer.byteLength(buffer) > 1024 * 1024) { buffer = ''; fail(null, -32600, 'Request exceeds size limit'); return; }
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { fail(null, -32700, 'Parse error'); continue; }
    handle(message).catch(error => { if (message?.id !== undefined) fail(message.id, -32603, String(error?.message || error)); });
  }
});
process.stdin.on('end', () => { guru.close(); process.exit(0); });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { guru.close(); process.exit(0); });
