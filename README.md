# GuruTrade web terminal

The terminal connects directly to GuruTrade for account sign-in, real/demo balances, the instrument catalogue, quotes, and open positions. It has no separate local paper login. Higher/Lower are fixed-time broker predictions; stock option puts and calls are not offered by this integration. No indicators are attached.

Requires Node.js 24 or later. No dependency installation is needed.

## Run

```powershell
cd C:\Users\thiru\Documents\Trading
.\start.ps1
```

Terminal: `http://127.0.0.1:8765/`. Click **Connect GuruTrade** to sign in. An existing root `.cred` containing `mail="..."` and `pass="..."` optionally signs in at startup; it is ignored by Git. Set `GURU_AUTO_LOGIN=0` to disable this. Passwords and broker tokens are never returned to the browser or written to the database.

Demo is selected initially. Real orders are disabled unless you start with `./start.ps1 -AllowRealOrders` (or `GURU_ALLOW_REAL=1` when starting Node directly). Selecting Real in the interface requires an authenticated broker account, a fresh quote, and a confirmation for each order. This is a single-user local terminal: all tabs share one broker session. Keep it bound to loopback.

Orders validate instrument limits, amount precision, direction, session and quote freshness. A unique request ID is recorded in `data/guru-orders.sqlite` before submission. Reusing that ID cannot send another upstream order, including after restart. A timeout or missing broker order ID produces an **unconfirmed** state. Check the broker's history before clearing the notice or placing a new order. Recorded submissions are an app journal; settled broker history, deposits, withdrawals, OTP, OAuth and KYC are handled on the official broker site.

Charts backfill the last hour of dense broker ticks through the authenticated `QUOTATION_HIS` WebSocket transport, then receive live updates. Subsecond timestamps are preserved. Line/area display all received ticks; bars/candles display OHLC aggregated from those ticks. The candle API supplies completed bars. The visible range and count are displayed. If the socket fails, REST samples are a labelled fallback. These are broker OTC observations, not original exchange OHLC; volume is unavailable. Collectors are bounded, stop when idle, and remain in memory.

Live prices are pushed to the browser through `GET /api/guru/stream?symbol=...` (SSE), then rendered on the next animation frame. The UI updates the current forming candle and labels it live; the candle API still supplies completed bars. Catalogue and account polling run separately. If the push connection fails, the app reconnects and retains REST polling as a fallback. No synthetic 50 ms prices are generated: update frequency follows actual broker ticks. `node scripts/check-live-feed.mjs` measures source intervals and local push delivery without placing orders.

The catalogue follows the supplied APK: `/ou/product/list/v3` with `appSource: GP` and `interfaceVersion: 3.0`, joined with `/ou/product/list` master metadata. The checked response contains 140 distinct instruments and 373 product variants, including 9 commodities. Symbols absent from the current app list are displayed as unavailable; product variants are retained in the API instead of silently discarded.

Trade durations come from `tradeTimeRespList`, not the product's `unit` label. Available options include 5/10/15 seconds and 1/3/5 minutes; some instruments also offer 30/45 seconds. The API sends the matching `timeUnit` and `timeUnitType` fields recovered from the APK's `DealMorePresent`. Unsupported values are rejected before submission. The default is 1 minute when offered. Live order acceptance and resulting expiry have not been exercised during repair.

### Connection check

```powershell
node scripts/check-connection.mjs
```

This checks login (if `.cred` is present), balances, catalogue, quotes, open positions and chart data. It submits no orders and prints no credentials. Automated tests mock order submission; they do not prove live execution or profitability.

## Scanner, history, backtest, risk guard

Broker ticks for every collected asset are stored in `data/guru-orders.sqlite` (table `ticks`). On start the server watches up to 30 tradable assets paying at least 82%, so history builds up while it runs. Backtests can only use ticks stored since then (plus about an hour of backfill per asset).

- `GET /api/candles?asset=<symbol>&tf=1m|5m|15m[&from=<ms>&to=<ms>]`: completed candles from stored ticks. The default is the last 24 hours and the maximum range is 31 days. There is no volume.
- `GET /api/signals`: setups on the newest closed bar. A setup needs RSI at an extreme, a Bollinger band pierce that closes back inside with a long rejection wick, and 15m and 30m trends (EMA of the closed bars) that agree. `warming` lists assets without enough stored history yet.
- `GET /api/backtest?asset=<symbol>|all&days=7`: replays the same rules over stored ticks. Entry is the first tick after the signal bar; exit is the last tick at or before expiry. One trade per asset at a time. The response gives the win rate, the Wilson 95% lower bound, the break-even rate (`1/(1+payout)`, 54.9% at 82%) and net stakes. `edgeConfirmed` is true only when the lower bound beats break-even.
- Rule overrides, accepted by both signals and backtest: `rsiLow, rsiHigh, rsiPeriod, bbPeriod, wick (0–1), trend=with|against|off, trendPeriod, duration (s), tf=60|300, payout`.

**Real-order risk guard.** This runs in the server, so every caller is covered. It rejects a real order when: the stake is above `GURU_MAX_REAL_STAKE` (default ₹20); the broker balance minus the stake would fall below `GURU_BALANCE_FLOOR`; or today's worst-case loss would pass `GURU_DAILY_LOSS_CAP`. Worst-case loss counts settled losses net of wins, plus every unsettled stake as lost. If the floor or the cap is unset, real orders are refused. Demo orders are not limited.

**Settlement log.** Every confirmed order is written to the `settlements` table and to `data/settlements.csv` about 3 s after expiry, with the broker balance after the trade. The won/lost result comes from stored ticks at expiry, not from a broker settlement record, so it can differ from the broker on near-ties.

## Separate AI candle endpoint

`http://127.0.0.1:8765/v1/data` supplies completed one-minute underlying candles for AI testing.

Put your actual `bars.csv` in this folder. Alternatively, select its location before starting:

```powershell
$env:BARS_CSV = 'C:\path\to\bars.csv'
node server.mjs
```

A missing, unreadable, oversized, or malformed CSV returns HTTP **503** with `{ "error": "..." }`. This endpoint never substitutes GuruTrade OTC prices or simulated data. A valid header-only file returns an empty result. NIFTY and BANKNIFTY candles must be supplied in the CSV; the GuruTrade connection does not supply these indices.

## Source contract

CSV header:

```csv
timestamp,symbol,open,high,low,close,volume
```

| Field | Meaning |
| --- | --- |
| `timestamp` | **Close time** of a completed one-minute candle, ISO 8601 with a timezone, e.g. `2026-10-23T09:16:00+05:30`. Seconds must be `00`. The offset is preserved. |
| `symbol` | Exactly `NIFTY` or `BANKNIFTY`. |
| `open,high,low,close` | Positive finite index prices. High/low must contain open/close. |
| `volume` | Nonnegative integer actual volume; missing column or blank value becomes `0`. |

Supply actual one-minute underlying index candles. If your provider timestamps candles by **open time**, convert each timestamp to its close time before writing this file. The API cannot infer the provider's convention or verify that submitted prices are genuine one-minute market observations. Gaps are retained; no missing candles or volumes are invented. Unknown columns are ignored. Duplicate symbol/close-time pairs and malformed rows reject the source rather than silently altering training data.

UTF-8, optional BOM, CRLF/LF, quoted fields and escaped quotes are supported. Maximum file size: 64 MiB. The file is reloaded when its identity, size or timestamps change. Prefer an atomic file replacement when updating it; a file modified during a read is rejected until a later successful read. Future close timestamps are omitted.

## Requests

```powershell
Invoke-RestMethod 'http://127.0.0.1:8765/v1/data?symbol=NIFTY&limit=100'
Invoke-RestMethod 'http://127.0.0.1:8765/v1/data?symbol=BANKNIFTY&limit=100'
Invoke-WebRequest 'http://127.0.0.1:8765/v1/data?format=csv&limit=10000' -OutFile bars-export.csv
```

| Query | Behavior |
| --- | --- |
| `symbol` | Optional `NIFTY` or `BANKNIFTY`; omitted returns both. |
| `from`, `to` | Optional inclusive timezone-aware ISO timestamps. URL-encode `+` as `%2B`. `to` cannot expose future candles. |
| `limit` | Most recent matching rows, default `1000`, maximum `10000`. Returned in ascending timestamp order, then symbol. |
| `format` | `json` by default; `csv` downloads `bars.csv` with exactly the seven specified columns. |

JSON envelope contains `interval: "1m"`, `timestampMeaning: "candle_close"`, `source: "bars.csv"`, `count`, `total`, `truncated`, and `data`. Each `data` row contains exactly `timestamp,symbol,open,high,low,close,volume`; prices and volume are JSON numbers. `total` is the number matching the filters before the limit. Use bounded time ranges when `truncated` is true.

No login is required for this local testing endpoint. Invalid queries return **400**, unsupported methods **405**. Binding defaults to loopback; cross-origin requests are rejected. No API token, social login, payment, order, indicator or AI inference is involved in `/v1/data`.

## Verification

```powershell
node --test tests/*.test.mjs
```

Data tests use clearly labeled synthetic fixtures in temporary directories to verify CSV parsing, date/timezone/OHLC validation, unknown volume, symbol filters, limits, future-candle exclusion, file reload, missing/invalid sources, JSON/CSV responses, and method errors. Test fixture prices are never installed as `bars.csv` or returned by the normal running service.

## Evidence and limits

APK/backend investigation records are in `analysis/`. The current browser controller is `public/app.js`; `deferred/terminal/` is historical and is not served. Legacy local simulation API routes remain for existing tests/data but are not used by the terminal. See `GURU-MCP.md` for the optional agent tool server. Real order acceptance and settlement have not been exercised during repair; no real or demo orders were submitted during live connection checks. The app does not promise profits or implement an autonomous trading strategy.
