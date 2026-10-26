# Claude Code handover

Updated: 2026-10-25. Workspace: `C:\Users\thiru\Documents\Trading`.

Read this file first. Earlier sections of `checkpoint.md` contain superseded catalogue counts, duration assumptions and polling behavior.

## Pending user request: “all stocks”

The user said “all stocks” immediately after reporting slow price updates and asking whether values change every 50 ms. Work was interrupted to request this handover.

- Treat the pending work as applying/verifying fast live updates across stock instruments. The user did not specify whether they mean each selected stock or every watchlist row simultaneously.
- **Currently implemented:** one live browser feed for the selected instrument. It is generic and supports published stock symbols, commodities, forex, indices and crypto.
- **Not implemented/verified:** simultaneous live prices for every stock/watchlist row. The watchlist currently displays names, categories and payout percentages; it does not show live prices for all rows.
- **Not verified:** source cadence and live push behavior for every individual stock. Gold was the instrument measured during the latency repair.
- The last attempted command was a read-only request to enumerate stocks from `/api/guru/markets`; the user aborted it before a result was reviewed. No code changes or orders followed “all stocks.”

### Next actions

1. Enumerate the current Stocks catalogue through `GET http://127.0.0.1:8765/api/guru/markets`. The last complete catalogue contained 25 stocks.
2. Read `startLiveFeed`, `refreshFeed`, `selectSymbol` and the timers in `public/app.js`; read `subscribeTicks`/collector handling in `guru-backend.mjs` and the SSE route in `server.mjs`.
3. Verify live updates on representative stock symbols using the existing generic path, then cover the remaining stock catalogue appropriately. Do not report an untested stock as verified or promise a 50 ms source cadence.
4. If implementing simultaneous watchlist updates, investigate the APK's batch-price contract first. Recovered candidates include `/ou/product/currentList`, `RequestProductListCP`, and `ReqProductPriceList`. Their full batch request/response contract has not been implemented here. Preserve real symbols, timestamps and market availability.
5. Do not open unbounded sockets or poll each stock every 50 ms. Current limits are **8 symbol collectors** and **32 SSE connections**. Evicting an actively subscribed collector ends its SSE feed; opening more symbols than the collector limit can cause reconnect churn. Resolve that design explicitly before a 25-stock simultaneous feed.
6. Add meaningful regression coverage for any change; run appropriate tests, verify the live read-only flow and browser UI, then update this handover/checkpoint.

## Running application

- URL: **http://127.0.0.1:8765/**
- Listener verified at handover: `127.0.0.1:8765`, Node PID **43044**. PIDs are volatile; inspect again before process operations.
- The server runs in a hidden process. Leave it running for the user.
- The Chrome deliverable tab was on Gold (OTC), with Commodities selected, the live tick indicator and a forming candle. Refresh already-open tabs after controller changes.
- Real orders are **disabled** on the running server. No real or demo broker orders were submitted during this work. Automated order tests use mocks.
- Existing `.cred` optionally signs in to the user's GuruTrade account at startup. Never print, copy into a report, commit or expose its contents. Tokens stay in server memory.
- This is a single-user loopback terminal; local browser tabs share the broker session. It has no separate local paper login in its interface.

### Commands

```powershell
cd C:\Users\thiru\Documents\Trading
rtk npm test
rtk proxy node scripts/check-connection.mjs
rtk proxy node scripts/check-live-feed.mjs cmd_oxauusd
```

`check-connection.mjs` can sign in from `.cred` and reads market/account endpoints. It submits no orders. Set `GURU_AUTO_LOGIN=0` to skip credential loading.

```powershell
# Foreground startup; real orders disabled by default:
.\start.ps1

# Restart only this verified workspace's port-8765 listener, hidden, with real orders OFF:
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\restart-local.ps1
```

`start.ps1 -AllowRealOrders` is an explicit manual configuration option; do not enable it merely to verify market data. Preserve unrelated user processes, especially any port-3000 service.

Local instruction `C:\Users\thiru\.codex\RTK.md` requires shell commands to use `rtk`. For PowerShell cmdlets use `rtk proxy powershell -NoProfile -Command "..."`; `rtk Get-Content` does not work because a cmdlet is not a standalone executable.

## Catalogue correction: use the APK, not the old web list

Source APK:

`C:\Users\thiru\Downloads\gurutrade7-3-5-3-2.apk`

SHA-256:

`746ec3dea42ef7c75f9dff03eeea3cc2e3487f05d7320face36249408238f2c1`

Actual REA/JADX inspection recovered:

- `BaseRequest`: `appSource: GP`, Android envelope, version `3.5.3.2`.
- `RequestProductAll`: interface version `3.0` when the newer app branch is active.
- `ProductListPresent.reqProductAll` calls `requestBProductAll`.
- B catalogue endpoint: **`/ou/product/list/v3`**.
- Response: `productData` groups contain `productIds`; join these with `productInfoAll` records.
- Master metadata: **`/ou/product/list`**. Preserve variant IDs and master-only instruments.

The old `/ou/product/all` web interface `2.0` returned only 62 symbols and one commodity. That was an incomplete view and is no longer the application catalogue source.

Last complete live result:

| Category | Distinct symbols |
| --- | ---: |
| Currencies | 59 |
| Forex | 1 |
| Stocks | 25 |
| Crypto | 35 |
| Indices | 11 |
| Commodities | 9 |
| **Total** | **140** |

The frontend groups Currencies and Forex together. There are **373 product-ID variants** retained in API metadata. The current app list supplies 138 symbols; master metadata adds two unavailable symbols. Availability is not inferred from membership in the master list.

Commodities verified from the app response: **Gold, Gold/Silver, Cocoa, Coffee, Cotton, Sugar, Uranium, Platinum and Palladium**, all OTC in this snapshot. There is no fabricated standalone Silver entry.

Normalizing/deduplicating by symbol must not discard product variants or let the Popular group replace a real category. Current app product IDs determine the available contract; arbitrary master-only variants are not selectable trading contracts in the UI.

## Expiries and order contract

The earlier `unit: 1MIN` expiry restriction was wrong. **`tradeTimeRespList`** is the duration source. Checked commodities offer 5/10/15 seconds and 1/3/5 minutes; some instruments also offer 30/45 seconds.

REA decompiled `DealMorePresent.reqRealTradeSubmit` and `reqTradeSubmit`. They set `productId`, `symbol`, `amount`, `buySell`, `oneClick`, **`timeUnit`** and **`timeUnitType`**; e.g. 5 seconds is `5` + `s`, one minute is `1` + `m`.

- Timed demo route: **`/ou/simulation/trade/submit3/auth`** (`SocializeApi.g0`).
- Real route: **`/ou/trade/submit2/auth`** (`SocializeApi.F`).
- Legacy metadata without explicit timed options still uses the existing legacy demo route.
- Direction, exact amount precision, asset limits, session, current quote, duration and request ID are validated.
- Real access requires `GURU_ALLOW_REAL=1`; HTTP and MCP enforce this in the shared adapter.
- `data/guru-orders.sqlite` records a request ID before sending. Replays return known confirmations or refuse uncertain/conflicting requests. Lost confirmations must not create another upstream order, including after restart.
- A success envelope without a broker position ID is **unconfirmed**, not success.

Wire fields and routing have static APK evidence and mocked request tests. **Live order acceptance, expiry and settlement have not been exercised.** No profitability claim or autonomous strategy is implemented.

## Market history and live transport

- Backend host: `https://api.guruserv.com`.
- WebSocket: `wss://api.guruserv.com/trade/webSocket`.
- Signing follows the shipped web client: raw query values, including account identifier and Base64 RSA signature. URLSearchParams encoding failed authentication; do not reintroduce that change without verified evidence.
- `PRODUCT_CHOOSE` selects the symbol; `QUOTATION_LIST` seeds recent ticks; paginated **`QUOTATION_HIS`** backfills the previous hour using `startTime`.
- `QUOTATION` supplies live updates. Millisecond timestamps, including multiple ticks in one second, are preserved.
- Price line/area uses observed ticks. Bars/candles aggregate actual ticks into OHLC. Volume is unavailable, represented as zero where the schema requires it.
- REST samples are labelled fallback data. Sparse old close samples cannot be turned into invented historical candle extremes.
- Tick collectors are bounded and held in memory, not persisted; idle timeout is 120 seconds when there are no subscribers.
- The candle API supplies completed bars. The browser additionally updates a clearly labelled **forming/live candle** from incoming ticks.

### Latency repair just completed

The UI used to fetch history and quotes every 2.5 seconds, adding avoidable delay. It now uses:

1. Shared backend WebSocket collector.
2. **`GET /api/guru/stream?symbol=...`**, a same-origin SSE stream carrying public price ticks only.
3. Browser `EventSource`, preserving ticks and rendering on the next animation frame.

Selected-price REST responses cannot overwrite a newer pushed price. `getQuote` uses a healthy collector's latest actual tick when available. Candle updates preserve historical OHLC and mark forming/partial bars.

Catalogue polling is separate (30 seconds); account polling is 5 seconds. REST market polling remains at 2.5 seconds only if push is stale. Hidden tabs stop their feed; foreground/reconnect reloads history to recover gaps. A closed SSE client is unsubscribed. SSE has heartbeat, no Nagle delay, bounded connections, slow-client cleanup and clean server shutdown.

Canvas allocation is now changed only when dimensions change, instead of resetting the bitmap on every tick.

Measured **Gold only**, 15 real ticks:

- Median/minimum provider timestamp interval: **1000 ms**.
- Median local SSE delivery: **2 ms**, maximum **3 ms**.
- This is a local HTTP stream measurement, **not** guaranteed broker-to-browser paint latency.
- Do not fabricate price changes every 50 ms. Different symbols may have different source cadence; unchanged prices can repeat.

## Important files

| File | Responsibility |
| --- | --- |
| `guru-backend.mjs` | App/master catalogue, normalization, durations, quotes, collectors/subscribers, order validation/journal |
| `guru-stream.mjs` | WebSocket authentication, historical pagination, live frames and heartbeat |
| `server.mjs` | Loopback HTTP APIs, SSE, broker login, static files, legacy local simulation APIs |
| `public/app.js` | Broker-only UI, selected-symbol EventSource, price/candle rendering, polling fallback |
| `public/chart-data.mjs` | Timestamp window selection and `applyLiveTicks` |
| `public/index.html` | Terminal layout, category filters including Commodities, duration controls |
| `guru-mcp.mjs` | Optional stdio MCP tools; argument validation and shared backend |
| `market-data.mjs` | Strict, separate NIFTY/BANKNIFTY CSV endpoint |
| `scripts/check-live-feed.mjs` | Read-only cadence/local-delivery measurement |
| `scripts/restart-local.ps1` | Verified workspace-only restart with real orders disabled |

## Verification and evidence

Last test run: **59 tests passed, zero failures**. No additional tests were run solely for this documentation handoff.

Relevant tests:

- `tests/guru-app-catalogue.test.mjs`: APK v3 join, categories, variant preservation, master-only availability, timed payloads/routes.
- `tests/guru-live-feed.test.mjs`: immediate tick subscriptions, fresh quote reuse, SSE security/shutdown, subsecond ticks, forming candle rollover and sparse fallback handling.
- `tests/guru-stream.test.mjs`: raw-query authentication, backfill, live updates, login failure fallback.
- `tests/guru-order-regressions.test.mjs`: real gate, limits, stale quote rejection, duplicate/uncertain requests, session expiry.
- Existing server, chart and CSV tests also pass.

Evidence files:

- `analysis/native-catalogue/evidence-index.json`: actual REA/JADX evidence IDs.
- `analysis/app-catalogue-acceptance.json`: 140 instruments / 373 variants / nine commodities, short durations and Gold history. Its embedded test count predates the latency repair; latest count is 59.
- `analysis/app-v3-catalogue.json`, `analysis/app-master-catalogue.json`: retained public catalogue responses.
- `analysis/app-account-catalogue-results.json`: read-only useType 0/1 checks.
- `analysis/live-feed-verification.json`: latest Gold cadence/delivery measurement.
- `analysis/repair-verification.json`: latest overall verification pointers.
- `analysis/rea-history-summary.json`, `analysis/rea-history-evidence.json.gz`: retained earlier static JavaScript REA evidence.

REA CLI and JADX already worked in this session. The source APK was statically inspected, not executed on Android. Runtime evidence comes from authorized broker data/account reads.

- JADX jar: `C:\Users\thiru\Downloads\jadx-headless-mcp-0.7.1-all.jar`.
- Java: `C:\Program Files\Java\jdk-26`.
- REA CLI launcher: `C:\Users\thiru\AppData\Roaming\npm\rea.ps1`.
- Focused reproducible inspection helper: `analysis/rea-catalogue.py`.
- REA MCP tools were not connected in this agent session; actual analysis used the working CLI fallback. Do not confuse that with failure to use REA.

## Other limits and preservation rules

- `GET /v1/data` still requires a real `bars.csv` containing completed one-minute NIFTY/BANKNIFTY OHLCV. The file was absent at last check, so that endpoint returns 503. Do not rename GuruTrade OTC products to those indices or substitute invented prices/volume.
- Broker settlement history, deposits, withdrawals, KYC and OTP/OAuth are not fully integrated; the UI links to the official service. The local journal is submission history, not settled broker results.
- Legacy local paper APIs/data remain for existing tests and prior data; their login/wallet forms are not part of the current terminal UI.
- Preserve `.cred`, user-owned data, existing provider sessions and unrelated servers. Never log credentials, tokens or cookies in handover/evidence.
- The workspace was not a Git repository during implementation. No commits were made; inspect current Git state before assuming otherwise.
- Ponytail was explicitly turned **off** by the user. Do not reactivate it automatically.

## 2026-10-25 later session

- **Cold-feed delay fixed in code, server NOT restarted (user declined the restart).** Cause: `subscribeTicks` waited for the full `QUOTATION_HIS` hour backfill (hits the 18 s `timeoutMs`) before attaching the SSE listener, so a newly selected symbol showed no live ticks for ~22 s. `guru-backend.mjs` now attaches the listener first (`ensureCollector(symbol, false)`); a snapshot is sent only if no live tick arrived. New regression test in `tests/guru-live-feed.test.mjs` (fails on old code); 60/60 pass. Measured before fix: Gold and Tesla first tick at 22.5 s, then 1 tick/s.
- Model accuracy work lives in `C:\Users\thiru\Documents\minimax-distill`: `candle_bridge.py`, `run_candle_accuracy.py`, `test_candle_bridge.py`, `build_candle_notebook.py` → `serve_candle_model.ipynb` (llama.cpp + GGUF Q8_0 + Cloudflare, `POST /predict_candles` with `X-API-Key`, returns BUY/SELL/WAIT).
- Offline strategy baseline (the `decide_trade` policy the model copies), 431 walk-forward samples on 25 stocks, next-1m-candle outcome: 258 signals, 48.5% win (95% CI 42–55%), break-even 55% at 82% payout. No individual vote above 53%. Model run pending the user's public URL + key.
- Python on this machine has a Windows system proxy (192.168.49.1:8282) that does not bypass loopback; use a no-proxy opener for 127.0.0.1.
- **Model run done (Q8_0 via Colab + Cloudflare):** 402 samples / 25 stocks, all `ok`, model matched `decide_trade` 402/402, median 1.2 s. 228 BUY/SELL signals, 49.6% win (95% CI 43–56%), break-even 55%, −22.3 units per ₹1 stake. First 100: 49 signals, 27 wins (55%). Results: `minimax-distill/candle_accuracy_stocks_q8.json`. Conclusion: training is sufficient for tool-following; the strategy has no edge.
