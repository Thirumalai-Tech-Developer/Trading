# GuruTrade MCP server

An MCP server that lets an agent (Codex, Claude Code, Claude Desktop, …) trade on GuruTrade.
It wraps the reverse-engineered GuruTrade backend (`guru-backend.mjs`) and talks stdio JSON-RPC.
Dependency-free; needs Node 24+.

File: `guru-mcp.mjs`. Account sign-in is read from `.cred` (`mail="…"`, `pass="…"`) at startup.

## Safety

- **Demo is the default.** `guru_place_order` uses the demo wallet unless `demo: false` is passed.
- **Real money is OFF by default.** A real-money order (`demo: false`) is refused unless the server
  is started with the environment variable `GURU_ALLOW_REAL=1`. Without it the tool returns
  `GURU_REAL_DISABLED`. Only set it when you intend an agent to spend real funds.
- `.cred` holds your password in plaintext — keep it private (it is git-ignored).

## Tools

| Tool | Args | Does |
| --- | --- | --- |
| `guru_status` | — | Connection/account status + active tick collectors |
| `guru_login` | accountNumber, passWord | Sign in (usually auto from `.cred`) |
| `guru_balance` | demo | Broker balances; anonymous demo returns `real: null` |
| `guru_logout` | — | Disconnect the account |
| `guru_orders` | demo | Durable app submission journal (no settlement results) |
| `guru_markets` | — | All instruments (symbol, payout %, price, min/max, tradable) |
| `guru_quote` | symbol | Current price (ms timestamp, staleness) |
| `guru_candles` | symbol, interval | OHLC candles (interval 5/10/15/30/60/180/300 s) |
| `guru_ticks` | symbol, since, limit | Raw high-frequency ticks `{time ms, price}`; `since` for incremental pulls |
| `guru_open_trades` | demo | Open/unsettled trades (demo default true) |
| `guru_place_order` | symbol, direction (`up`/`down`), amount, requestId, demo, flash, duration | Place a fixed-time order; duration must match `supportedDurations` |

Order semantics: `direction: "up"` = Higher, `"down"` = Lower; `amount` in rupee; `flash` (default true)
= one-click. Expiry is selected from the instrument's `supportedDurations` and encoded using its advertised `timeUnit` / `timeUnitType`. Payout per instrument is in `guru_markets`. `requestId` is required (8–128 letters, digits, `_` or `-`); generate it once for each intended order. Reusing it replays a known confirmation or refuses an uncertain submission, including after restart. Never generate a new ID merely to retry a lost confirmation. An accepted envelope without an order ID is unconfirmed, not success.

## Register it

### Claude Code
```bash
claude mcp add gurutrade -- node C:/Users/thiru/Documents/Trading/guru-mcp.mjs
# to allow REAL-money orders as well:
claude mcp add gurutrade --env GURU_ALLOW_REAL=1 -- node C:/Users/thiru/Documents/Trading/guru-mcp.mjs
```
Or add to `.mcp.json` / settings:
```json
{ "mcpServers": { "gurutrade": { "command": "node", "args": ["C:/Users/thiru/Documents/Trading/guru-mcp.mjs"] } } }
```

### Codex
Add to `~/.codex/config.toml`:
```toml
[mcp_servers.gurutrade]
command = "node"
args = ["C:/Users/thiru/Documents/Trading/guru-mcp.mjs"]
# env = { GURU_ALLOW_REAL = "1" }   # only to allow real-money orders
```

### Claude Desktop
`claude_desktop_config.json`:
```json
{ "mcpServers": { "gurutrade": { "command": "node", "args": ["C:/Users/thiru/Documents/Trading/guru-mcp.mjs"] } } }
```

After registering, restart the client and confirm the `guru_*` tools appear.

## Notes / limits

- Quotes/ticks are broker OTC data (no real volume; candle `volume` is always 0).
- Full tick history is backfilled through `QUOTATION_HIS` over WebSocket. The raw query convention matches the shipped web client; encoding the signature or account query value causes login failure. The rolling hour is retained, with REST samples as a fallback. Tick collectors are not persisted.
- Each running MCP process keeps its own session and in-memory tick buffers.
- HTTP and MCP both enforce `GURU_ALLOW_REAL=1` at the backend. Input types, flags and directions are validated before calling the broker.
- The durable journal is shared at `data/guru-orders.sqlite`; it stores no account password or token. Order execution is mocked in automated tests. Live connection verification submits no orders and does not establish profitability.
- Set `GURU_AUTO_LOGIN=0` to disable startup credential loading.
- Trade durations come from the APK v3 catalogue's `tradeTimeRespList`. 5/10/15-second and minute options are available per instrument. Orders send the exact advertised `timeUnit` / `timeUnitType` pair. The product label `unit: 1MIN` does not constrain this list. Live execution is still untested; chart intervals are independent of order expiry.
