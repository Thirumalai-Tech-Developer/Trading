import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'guru-mcp.mjs');

// Drive the stdio JSON-RPC server: send requests, collect newline-delimited responses by id.
function rpc(requests, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    // GURU_ALLOW_REAL unset: real orders must be refused. No .cred needed for guru_status/tools.
    const child = spawn(process.execPath, [SERVER], { env: { ...process.env, GURU_ALLOW_REAL: '', GURU_AUTO_LOGIN: '0' }, stdio: ['pipe', 'pipe', 'inherit'] });
    const byId = new Map(); let buffer = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('timeout')); }, timeoutMs);
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.id !== undefined) byId.set(message.id, message);
        if (byId.size === requests.filter(r => r.id !== undefined).length) { clearTimeout(timer); child.stdin.end(); resolve(byId); }
      }
    });
    child.on('error', reject);
    for (const request of requests) child.stdin.write(JSON.stringify(request) + '\n');
  });
}

test('MCP server: initialize, tools/list, and a no-network tool call', async () => {
  const responses = await rpc([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'guru_status', arguments: {} } },
  ]);

  assert.equal(responses.get(1).result.serverInfo.name, 'gurutrade');
  assert.ok(responses.get(1).result.capabilities.tools);

  const tools = responses.get(2).result.tools.map(t => t.name);
  for (const name of ['guru_status', 'guru_markets', 'guru_quote', 'guru_candles', 'guru_ticks', 'guru_balance', 'guru_open_trades', 'guru_place_order']) assert.ok(tools.includes(name), `missing tool ${name}`);

  const status = JSON.parse(responses.get(3).result.content[0].text);
  assert.equal(status.source, 'guru');
  assert.equal(typeof status.loggedIn, 'boolean');
});

test('MCP server: real-money order is refused unless GURU_ALLOW_REAL=1', async () => {
  const responses = await rpc([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'guru_place_order', arguments: { symbol: 'fx_ojpythb', direction: 'up', amount: 20, demo: false, requestId: 'real-disabled-1' } } },
  ]);
  const call = responses.get(2).result;
  assert.equal(call.isError, true);
  assert.match(call.content[0].text, /GURU_REAL_DISABLED/);
});

test('MCP validates directions, flags, argument types and request IDs before executing', async () => {
  const argumentsList = [
    { direction: 'sideways', demo: true, requestId: 'mcp-order-1' },
    { direction: 'up', demo: 'false', requestId: 'mcp-order-2' },
    { direction: 'up', demo: true },
    { direction: 'up', demo: true, requestId: 'mcp-order-3', surprise: 1 },
  ];
  const responses = await rpc(argumentsList.map((args, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: { name: 'guru_place_order', arguments: { symbol: 'fx_test', amount: 20, ...args } } })));
  for (const response of responses.values()) {
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /GURU_INVALID_ARGUMENTS/);
  }
});
