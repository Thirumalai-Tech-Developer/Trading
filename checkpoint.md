# Current checkpoint — live UI latency repair, 2026-10-25

Continuation entry point: **handover.md**, updated at the user's request for Claude Code. Pending user instruction: **“all stocks”** after the latency discussion. Stock-wide verification / simultaneous watchlist updates are not completed; read the handover's first section before continuing.

This section supersedes earlier UI polling and test-count notes. The APK catalogue correction below remains current (140 instruments, 373 variants, 9 commodities, short expiries).

- User reported slow updates and asked whether prices change every 50 ms. Actual Gold tick cadence measured around 1000 ms; it is provider driven, not a fixed 50 ms contract.
- Removed the 2.5-second polling dependency from live price/chart updates. guru-stream.mjs identifies live QUOTATION frames; guru-backend.mjs publishes subscriptions and uses the same current WebSocket tick in getQuote.
- server.mjs exposes same-origin GET /api/guru/stream?symbol=... as SSE, with no Nagle delay, heartbeat, slow-client/backpressure cleanup, subscriber limits, and clean server shutdown. Only public market ticks are sent; no account tokens are exposed.
- public/app.js uses EventSource, queues real ticks, renders once per animation frame, maintains subsecond points, and updates the forming candle. Older REST replies cannot roll the current quote backward. Catalogue polling is 30 seconds, account polling 5 seconds, fallback market polling 2.5 seconds only when push is stale. Hidden tabs stop the feed and reload history on return/reconnect.
- public/chart-data.mjs applyLiveTicks preserves actual point history, updates only observed candle buckets, labels forming/partial bars, and never manufactures old OHLC from sparse fallback prices. The completed-candle API contract is unchanged.
- Canvas resizing is now limited to real size changes instead of resetting the canvas bitmap on every tick.
- 59 tests pass, including pushed subscriptions, SSE security and shutdown, live candle rollover, subsecond tick retention and sparse-history validation. Browser verified Live ticks, changing quote timestamps/prices, and 59 completed + 1 live Gold candles.
- Live measurement: analysis/live-feed-verification.json, 15 Gold ticks, median broker interval 1000 ms, local SSE delivery median 2 ms / maximum 3 ms. This measures a local HTTP stream client, not guaranteed end-to-end broker-to-display latency. Reproduce with node scripts/check-live-feed.mjs.
- Running terminal remains http://127.0.0.1:8765/. Real orders remain disabled. No orders were submitted. Refresh existing browser tabs to load the EventSource controller.

---

# Current checkpoint — APK catalogue correction, 2026-10-25

This section supersedes ALL earlier catalogue counts and the earlier 1MIN-only expiry conclusion below.

- User explicitly requested using reverse-engineer-anything on C:\Users\thiru\Downloads\gurutrade7-3-5-3-2.apk to get all instruments. Verified SHA-256: 746ec3dea42ef7c75f9dff03eeea3cc2e3487f05d7320face36249408238f2c1.
- Actual REA/JADX calls and immutable evidence are in analysis/native-catalogue/. RequestProductAll uses interfaceVersion 3.0. ProductListPresent.reqProductAll calls requestBProductAll, which uses /ou/product/list/v3. BaseRequest appSource is GP.
- Fixed getMarkets to join /ou/product/list/v3 (productData groups referencing productInfoAll) with /ou/product/list master metadata. Catalogue is now 140 symbols, 373 preserved product-ID variants, 9 commodities. The previous /ou/product/all 2.0 web catalogue was incomplete.
- Commodities: Gold, Gold/Silver, Cocoa, Coffee, Cotton, Palladium, Platinum, Sugar, Uranium (all OTC in the checked response). Master-only entries are shown as unavailable and cannot trade. No instrument or quote was fabricated.
- Correct duration source is tradeTimeRespList. unit: 1MIN was NOT an expiry limit. 5/10/15 seconds and 1/3/5 minutes are offered on the checked commodities; some other instruments offer 30/45 seconds. UI options, backend validation, and selected-duration payout metadata use these records.
- REA decompiled DealMorePresent.reqRealTradeSubmit and reqTradeSubmit: they send productId, symbol, amount, buySell, oneClick, timeUnit and timeUnitType. Timed demo path is /ou/simulation/trade/submit3/auth (SocializeApi.g0); real remains /ou/trade/submit2/auth (F). Payloads are tested with mocks; no broker orders were submitted.
- 55 tests pass. Live running API verified full catalogue and short-duration metadata. Browser verified all nine commodity rows, Gold's full-hour chart, and selectable 5-second expiry. Core history continues to backfill WebSocket QUOTATION_HIS ticks; bars/candles/line/area work.
- Current app: http://127.0.0.1:8765/. Separate local paper login is removed. Broker sign-in/balances work. Real orders remain OFF by default. scripts/restart-local.ps1 restarts only the verified workspace listener and keeps real orders off.
- Acceptance evidence: analysis/app-catalogue-acceptance.json. Raw public responses: analysis/app-v3-catalogue.json and analysis/app-master-catalogue.json. Read-only probes confirm useType 0/1 both expose the checked 138-entry v3 list, plus two additional symbols from master metadata.
- Remaining limits: live order acceptance/settlement is untested; no profit claim. Variant metadata is retained per symbol, while current app product IDs determine the available trading contract. Market data is broker OTC ticks and derived OHLC; volume is unavailable. /v1/data still requires a real NIFTY/BANKNIFTY bars.csv, which is absent. No Git repository is present.

---

# Current checkpoint — 2026-10-25 repair

This section supersedes earlier deferred/disabled UI notes below.

## User requirements
- GuruTrade account login only in the UI; no separate local paper login.
- Show the provider's available hour of data, including full ticks, bars and candles.
- Show explicit duration choices such as 5/10/15 seconds; enforce broker-supported values.
- No indicators. Keep the separate NIFTY/BANKNIFTY CSV endpoint truthful.

## Running state and evidence
- Terminal is running at http://127.0.0.1:8765/ in a hidden Node process. Browser tab was left open on Candles, Demo account. Real orders are disabled by default.
- 50 automated tests pass. Live login, real/demo balances and open positions, current quotes, and 62 normalized instruments were checked. No orders were submitted by verification.
- Full historical ticks were recovered from WebSocket QUOTATION_HIS, following the shipped web client. The broker requires raw query values, including accountNumber and the Base64 RSA signature; URLSearchParams authentication failed. Runtime probe: analysis/history-probe-results.json. Static REA evidence: analysis/rea-history-summary.json and compressed evidence.
- Production backend/GUI verified 5,000+ ticks over the last hour and 59 completed 1-minute OHLC candles. Line preserves subsecond points; Bars and Candles work across the historical hour. Actual timestamps, visible range, and counts are shown.
- Live catalogue metadata on 2026-10-25 lists only unit 1MIN across 124 raw entries / 62 unique instruments. The duration dropdown shows 5/10/15/30 seconds, 1/2/5 minutes; unsupported choices are disabled. Backend rejects unsupported durations. Chart intervals 5s/10s/15s are separate from order expiry.

## Changed implementation
- Follow-up: added the missing Commodities filter. Live catalogue has one commodity, Gold/Silver (OTC), symbol cmd_oxauxag. Browser verified its 59 completed one-minute candles across the available hour. All 62 unique provider instruments are in the catalogue.
- guru-stream.mjs: authenticated market WebSocket, bounded historical pagination, live quotes and heartbeat, REST fallback.
- guru-backend.mjs: full-hour tick data; amount/market/session/freshness checks; persistent order request IDs in data/guru-orders.sqlite; unknown confirmations cannot replay upstream; real-order gate shared by HTTP/MCP; product duration metadata and validation.
- server.mjs: broker routes, journal route, strict order mode, sign-in rate limit, safe document navigation, sanitized errors, optional .cred sign-in without credential logs.
- public/app.js / chart-data.mjs / index.html: broker-only sign-in, balances/journal, working account picker, full-hour timestamp axis, all four chart styles, explicit supported duration UI, no ignored duration control.
- guru-mcp.mjs: strict argument validation, required order requestId, duration validation, logout and journal tools, deterministic no-network tests via GURU_AUTO_LOGIN=0.
- README.md / GURU-MCP.md / scripts/check-connection.mjs describe current behavior. analysis/repair-verification.json records acceptance checks.

## Remaining limits / next work
- Live real/demo order execution and settlement were not exercised; tests use mocked order responses. Never claim profitability or live execution verified from these tests.
- 5/10/15-second order expiry is not advertised by the checked product catalogue. Do not enable it or invent timeUnit/timeUnitType semantics without a verified broker contract.
- Candles are derived from broker OTC ticks; volume is unavailable and native exchange OHLC is not supplied.
- Broker settlement history and deposits/withdrawals/KYC/OTP remain on the official broker site. Local journal records submissions, not settlement outcomes.
- bars.csv is absent, so GET /v1/data still returns 503 until actual NIFTY/BANKNIFTY data is supplied. GuruTrade OTC symbols are not relabelled as these indices.
- Tick collectors are bounded and in memory. App is a single-user loopback service; broker session is shared by local tabs. Preserve .cred and user data. No Git repository exists in this folder.
- Restart: .\start.ps1. Explicit manual real-order enablement: .\start.ps1 -AllowRealOrders. Both HTTP and MCP enforce GURU_ALLOW_REAL.

---

# Checkpoint - stopped at user request, 2026-10-24

> **LATEST HANDOFF FOR CLAUDE CODE:** Read the final section, "Claude Code handoff after resumed reverse engineering", first. Earlier stop/resume descriptions are historical. The user stopped work again and requested this checkpoint for Claude Code. All three agents were interrupted; do not automatically resume work in this Codex session.

All three investigation/UI agents were interrupted. No new backend probes, trades, or implementation should run until the user resumes work. A previously launched REA JavaScript analysis had already completed successfully when its process was checked.

## Current request and scope

User wants data collected from the GuruTrade app backend and a visible interface showing available instruments and buy/sell controls. Earlier requested `/v1/data` for completed one-minute NIFTY/BANKNIFTY candles is implemented separately. User explicitly excluded indicators. The most recent instruction is to stop and explain/install missing tools, not continue development.

## Verified completed work

- Node 24, installed REA CLI 6.7.0, and Java JDK 26 are present. Default Java on PATH is Java 8. `REA_JADX_MCP_JAR` is not configured.
- REA MCP tools were not exposed in the active session, but REA was used via its installed `rea.cmd` CLI.
- APK inventory completed with REA Evidence `ev_1dae5058401910fd03943108b030a6661d70b2e26dc0b16f52120ff2cb5d248f`; compact inventory is `analysis/rea-summary.json`.
- APK SHA-256: `746ec3dea42ef7c75f9dff03eeea3cc2e3487f05d7320face36249408238f2c1`.
- REA JavaScript analysis completed with Evidence `ev_975edd9cc690e8917e29644cbaa7f74c4972cccf4b8489458dfd0a5ce717cb9f`, saved in `analysis/rea-web-evidence.json`. Only `index.e0d9dda8.js` was selected: 9 other inventoried files remain outside semantic analysis. Graph coverage is explicitly incomplete; no bundle code was executed.
- Native Android inspection failed before decompilation: REA Windows process-ownership self-test returned Win32 5 Access denied on `C:\Users\thiru`. Both `analysis/rea-android.json` and `analysis/rea-android-resume.json` preserve this diagnostic. This failure is not fixed by reinstalling Java/Ghidra.
- Direct Python DEX/resource decoding recovered feature labels, method-local API constants, transport fields, and request DTOs. These are shell-derived observations, not REA decompilation results. See `analysis/findings.md`, `api-literals.json`, `request-fields.json`, `transport-disassembly.json`, and `transport-methods.json`.
- Official web JavaScript was downloaded into `analysis/web/` using parent execution, without user credentials.
- Parent read-only live request **succeeded**: POST `https://api.guruserv.com/ou/product/all` with JSON `{appSource:'WEB',deviceId:<anonymous UUID>,gaid:<same UUID>}`. HTTP 200, upstream status `0`, message `success`. Response preserved in `analysis/guru-catalog-probe.json`.
- Catalogue returned 62 unique instruments: 29 currencies, 1 commodity, 14 crypto, 8 indices, and 10 stocks. `Popular` duplicates the same 62 entries. Returned listings are OTC instruments; do not represent them as exchange stock ownership.
- Example stock symbols: `stk_ojpm`, `stk_oms`, `stk_osnap`, `stk_onike`, `stk_obaidu`, `stk_ohbbd`, `stk_omcd`, `stk_ococacola`, `stk_omsft`, `stk_ogs`.
- NIFTY/BANKNIFTY were not in that observed catalogue. Do not relabel unrelated indices or OTC products as these underlying indices.
- Last completed automated run before current unfinished UI changes: **15/15 tests passed**, including data API fixtures, local accounts, security checks, wallet/trade atomicity, and restart settlement. `/v1/data` returns 503 without actual `bars.csv`; no fake source file was installed.

## Unfinished work and exact boundaries

- `public/index.html` and `public/styles.css` were restored from `deferred/terminal/` and partially updated for explicit GuruTrade-vs-paper mode and no indicators. The working data API instructions were preserved as `public/data.html`.
- `public/app.js` did not exist at stop-time inspection. The restored terminal is therefore **not functional yet**. Do not claim the interface is complete or tested.
- No `guru-backend.mjs` or `tests/guru-backend.test.mjs` existed at stop-time inspection. Parent has not integrated `/api/guru/*` routes into `server.mjs`.
- Local `/api/*` backend already supports independent local accounts and **synthetic** paper trades. Those endpoints are not original GuruTrade accounts/orders. `/v1/data` remains CSV-only and independent.
- Backend quote/candle transport, user sign-in, authenticated history/balances, original order submission, real money movement, and full feature parity are unverified.
- No original account credentials were used; no real orders/payments were placed; no broker guest-login flow was executed.
- Child agents retained earlier network restrictions (EACCES/WinError10013); the parent's current execution reached the official backend successfully. Do not interpret child socket failures as upstream downtime.
- Port 8765 was observed listening on process 34736 (`node server.mjs`, the earlier local server). It has **not** been restarted for the new UI changes and its liveness was not reverified after stopping work. Preserve unrelated servers, especially port 3000.

## Findings to resume from, only after authorization

1. Read this checkpoint and existing source before editing. Finish `public/app.js`, then integrate a verified backend adapter without silently substituting synthetic quotes.
2. Backend agent prepared `analysis/probe-guru.mjs` for four read-only requests: product catalogue, `/pc/asset/detail` with `{symbol:'fx_ojpythb',interval:'1H'}`, product detail, and `/ou/user/getData/web`. The latest version has **not** been executed by parent. Review its source before running; keep any secrets out of files/output.
3. Official web bundle indicates `/pc/asset/detail` can return `data[0].quotationList` points `ct` (seconds) and `cp` (price). This is static inference, not a verified live candle response.
4. Official web quote stream uses WebSocket and an RSA public-key auth scheme with server-issued token/account number. Anonymous visitor flow appears to POST `/ou/user/webLogin` with `source:'simulation'` and generated UUID credentials. This was **not** exercised. Do not create an email account or place trades just to collect catalogue data.
5. Native login wire recovered statically: POST JSON `/ou/user/userLogin`; `accountNumber=email`, `password=trimmed password`, `source='email'`, plus BaseRequest/device/challenge fields. Successful response contains `access_token`. Treat wire/auth validity as unverified until the user signs in through a reviewed interface. No need to ask the user to disclose credentials in chat.
6. For full Android decompilation, the skill calls for the separate **headless JADX MCP JAR 0.7.1** selected by `REA_JADX_MCP_JAR`, with full JDK 17+. Java 26 already exists; default PATH is Java 8. Ordinary JADX GUI installation alone does not register the REA provider. Resolve the native access denial separately; do not install Ghidra/Hopper for this Java APK task.

Do not resume these steps automatically: user explicitly stopped activity and requested installation guidance.

## Tool configuration update - 2026-10-24

User supplied `C:\Users\thiru\Downloads\jadx-headless-mcp-0.8.0-all.jar`. It exists (42,644,877 bytes) and contains all five classes required by installed REA's bridge validation. Although REA 6.7.0's audited release constant names 0.7.1, its actual configuration validator accepted this 0.8.0 JAR; do not claim it was rejected based only on the audited release constant.

Ran installed REA CLI `doctor --provider jadx --format json` with this JAR and `JAVA_HOME=C:\Program Files\Java\jdk-26` in the diagnostic process. Exit 0, scoped `healthy:true`, JADX `configured:true`, `available:true`. Saved full diagnostic in `analysis/jadx-0.8.0-readiness.json`. Unrelated unconfigured native providers and stale client registrations are informational; global `environment_healthy:false` does not negate the successful explicit JADX scope.

Saved both `REA_JADX_MCP_JAR` and `JAVA_HOME` as Windows **user environment variables**, verified by reading them back. Restart Codex/new terminal to inherit them. No MCP client registration was changed. No APK decompilation was run during this setup check, and current-session REA MCP tools remain absent. The earlier native access failure did not recur during this provider readiness check; actual APK/provider execution remains unverified. App/backend/UI work remains paused. Ponytail mode is now lite.

## Post-restart runtime verification - 2026-10-24

The actual APK inspection with the supplied 0.8.0 JAR failed **after** the JVM/bridge started. Exact provider reason: `Expected engine 0.7.1; JAR reported 0.8.0.` See `analysis/android-restart-verification.json`. This supersedes any inference that the successful provider readiness check established runtime compatibility. The readiness check only validated Java and required JAR classes.

The Win32 access-denied failure did not recur in this attempt: REA launched its metadata bridge, identified Java 26 and JADX 0.8.0, and rejected the engine version. REA MCP tools are still absent in the active session; CLI remains usable. Dependency correction is restricted to side-by-side acquisition of the exact audited 0.7.1 release and runtime verification. Do not patch REA's version checks or remove the user's 0.8.0 JAR. Backend collection and interface development remain paused.

## Dependency correction completed - 2026-10-24

Downloaded the exact audited upstream `jadx-headless-mcp-0.7.1-all.jar` beside the user's unchanged 0.8.0 JAR. Verified SHA-256 `6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75`, size 42,619,858 bytes. Updated the Windows user `REA_JADX_MCP_JAR` variable to `C:\Users\thiru\Downloads\jadx-headless-mcp-0.7.1-all.jar` and read it back. JAVA_HOME remains JDK 26. Existing processes may retain older environment variables; set them explicitly from these verified paths for CLI invocations rather than assuming live app inheritance.

**Actual APK inspection now passes**, exit 0, using installed REA CLI 6.7.0, audited JADX 0.7.1, and Java 26. Evidence `ev_86517c8e6fc2c0af3b32730686a053bd5f6b3c7d294843696e76718198cb289b`; full output `analysis/android-jadx-0.7.1-verification.json`. This verifies manifest/package/class/resource inventory against the supplied APK, not a complete source recovery or native app execution. The previous Windows access failure did not recur in the parent executor.

No app-backend collection, trading, individual method decompilation, interface implementation or subagent work was resumed. REA MCP tools still were not exposed after the restart; use the verified CLI until client registration is separately repaired. The user's stop instruction for development remains active.

## Claude Code handoff after resumed reverse engineering

### User objective and current stop

The user subsequently said **"now do reverse engineering"**. Work resumed using real REA/JADX method decompilation plus narrowly scoped live read-only market requests. The latest instruction is **"now save this details and remaining in checkpoint; I will give this task to Claude Code"**. Work is stopped again. All three subagents (`apk_evidence`, `backend`, `terminal_ui`) were interrupted. The last parent native-auth runner had already exited successfully when checked; no background investigation remains intentionally running.

Original implementation objective to carry forward:

- Reverse engineer `C:\Users\thiru\Downloads\gurutrade7-3-5-3-2.apk` and build the web terminal **in this folder**.
- Collect the **actual app backend** catalogue/prices, display all its available instruments, provide login and buy/sell functionality as its verified contracts permit.
- **No indicators** requested. Do not attach indicator analytics to the data endpoint.
- `/v1/data` was requested earlier for underlying one-minute NIFTY/BANKNIFTY OHLCV AI testing, with timezone-aware completed candle timestamps and volume `0` if unavailable. That endpoint currently reads a supplied CSV; it is not connected to the broker feed. Do not rename unrelated OTC indices into NIFTY/BANKNIFTY.
- Do not confuse local synthetic paper trades, broker demo trades, and real-money trades. No real-money trade was placed during this work.

### What changed in the resumed pass

1. **Actual native method decompilation completed through REA CLI/JADX.** Fourteen successful Evidence records are indexed in `analysis/native-auth/evidence-index.json`: 3 class inventories, 8 methods, 3 explicitly selected constructors. Raw canonical JSON is present; several methods also have exact `.java` views exported beside it. The final 3 constructor queries also completed successfully, without rerunning the earlier successful queries.
2. **Live catalogue and current/history price endpoints were verified.** Captures are sanitized, contain no visitor tokens/password values, and preserve response digests/timestamps.
3. **An initial live backend adapter was saved as `guru-backend.mjs` (13,111 bytes at handoff).** It is unfinished integration work, not production acceptance: no adapter test file existed when stopped, no parent live adapter smoke test was run, and `server.mjs` does not import or route it yet.
4. **The frontend controller was saved as `public/app.js` (49,579 bytes at handoff).** Agent ran `node --check` successfully. This has not been browser tested or integrated end-to-end. `public/terminal-extra.css` was added, and parent linked it after `/styles.css` in `public/index.html`.
5. No full test suite was rerun after these latest files. The last full test result remains the earlier **15/15**, before the live adapter and frontend controller were written. Do not present that older result as validation of the latest work.

### Live app-backend protocol and evidence

**Host verified:** `https://api.guruserv.com`.

**Public web request envelope:** POST JSON with `appSource: "WEB"`, an anonymous generated UUID `deviceId`, and the same `gaid`. Headers use `Content-Type: application/json`; official Origin/Referer were used for some probes. Keep device/session values out of persisted evidence.

| Endpoint | Actual result | Evidence file |
| --- | --- | --- |
| `/ou/product/all` with `interfaceVersion: "2.0"` | HTTP 200, upstream string status `"0"`, success. Includes `currentPrice`, `changeRate`, `profit`, min/max/accuracy/currency and instrument identifiers. | `analysis/guru-live-probe.json` |
| `/ou/product/detail` with `productId: "10095"` | Success; instrument details, demoMin/demoMax, currencyType rupee, payout 0.82 for sampled JPY/THB OTC. | same |
| `/ou/user/getData/web` | Success; `data.timeDate` server timestamp string. It is not a login endpoint. | same |
| `/ou/user/webLogin` with `source: "simulation"`, `accountNumber: generatedUUID`, `passWord: sameUUID` | Anonymous visitor initialization succeeded. Returned `token`, `userId`, `accountNumber`, device values were held only in process memory. No email registration or real account sign-in occurred. | sanitized `analysis/guru-quotes-probe.json`, `guru-ohlc-probe.json`, `guru-ticks-probe.json` |
| `/ou/quotation/current` with symbol | Success after visitor initialization. Fields `currentUnixTime` seconds, `currentPrice`, `fullTime` milliseconds, `fullPrice`. | `analysis/guru-quotes-probe.json` |
| `/ou/quotation/getlist` with symbol/productId/interval | Success. Array of `{ct,cp}` samples. `ct` seconds, `cp` decimal string. Interval `60` gives 60 minute-spaced historical prices; interval `3` gives 60 three-second-spaced prices. **These are not OHLC records.** | `guru-quotes-probe.json`, `guru-ohlc-probe.json` |
| `/ou/quotation/getNewlist` with symbol/productId/interval `3` | Success. `data` is an encoded string. Official web decoding yielded 396 dense price observations over approximately 209.527 seconds with observed gaps at most one second. Timestamps are millisecond strings; values are price observations. Incremental `queryDate` epoch milliseconds yielded 4 new observations spanning approximately 1.473 seconds. | `analysis/guru-ohlc-probe.json` |
| `/ou/quotation/getNewlist` interval `60` | Success, but decoded to 60 minute-spaced samples, **not** 70 minutes of dense ticks and not native OHLC. | `analysis/guru-ticks-probe.json` |
| `/pc/asset/detail` | HTTP 200 but upstream status `"1"`, code `10100`, `Required parameter missing`, even with symbol/productId/interval. Do not claim this endpoint works. | above probes |
| `wss://api.guruserv.com/trade/webSocket?...` | Socket opened, then server sent `LOGIN_FAIL`. The attempted RSA-signature authentication is **not verified**. No successful quote frame or real-time socket subscription was captured. REST works, so do not block usable market integration on this unresolved socket. | `analysis/guru-quotes-probe.json` |

Observed catalogue snapshot: **62 unique instruments**: 29 currencies, 1 commodity, 14 crypto, 8 indices, 10 stocks. The Popular group duplicates those instruments. The observed listed instruments are **OTC**, not proof of exchange stock ownership. NIFTY and BANKNIFTY were not present. Rates/availability are live and may change; fetch dynamically rather than hardcoding the snapshot. `changeRate` units have not been conclusively established; do not casually format it as an exchange daily percentage.

**Encoded price data:** `guru-backend.mjs` contains `decodeGuruQuotation` implementing the recovered official web decoder: base64 outer string -> leading character determines rotation direction/shift -> remaining hex bytes -> reverse bit rotation -> inner base64 -> JSON. It has not yet been covered by unit tests; use the saved real responses as bounded fixtures. No engine patching or auth bypass was used.

**OHLC boundary:** Genuine dense observations from `getNewlist` interval `3` can be aggregated into explicitly labeled **derived broker-quote OHLC** over the observed approximately 3.5-minute window, with `nativeOhlc:false`, provenance `aggregated_broker_quotes`, `volume:0`, `volumeAvailable:false`. This does not establish native/exchange OHLC or actual volume. A continuous collector could incrementally retain more real observations, but is **not implemented**. Do not generate high/low/open from sparse minute-close samples or silently fill missing candles.

The initial adapter currently returns line history only (`kind:'line'`, `points`, `candles:[]`), even though helper functions for dense tick normalization and aggregation were written. This is deliberate until those helpers receive acceptance checks.

### Native REA/JADX proof and recovered auth/trade flow

All records below are actual REA `inspect_android_method` / class inspection outputs, not the earlier Python DEX approximations. Agent reported complete Java method bodies with no fallback for these focused queries. Full coverage is still limited to the selected methods; the APK has not been executed and complete source recovery was not attempted.

| File under `analysis/native-auth/` | Evidence ID |
| --- | --- |
| `BaseRequest.inventory.json` | `ev_5836daeff1c806ec540af8d6c9ae5133b5423e8afec8d55218fd94dd6e59e699` |
| `RequestLogin.inventory.json` | `ev_3c03676c6e9a7a63de6c574b12f61f5eb6bb509d68ce45dcd5382500b8d84d5d` |
| `RequestTradeSubmit.inventory.json` | `ev_7b102d59ef1390a3bfd0eb85115bc2237e9bfab1a3db7cad8f81c63466f41871` |
| `LoginNewActivity.doLogin.json` | `ev_29eadfc791e496e369c47a4fc07fdf3829a75456abdd83f273f063f4d3a5046b` |
| `LoginNewActivity.submitReqest.json` | `ev_5bc3aa097f8a1d7a5c6d927090a2a77d1ffa212b58ed4e9146ef794ef46b2f20` |
| `NetDataRequest.getBody.json` | `ev_d0365c3aa7597b787bf71c2907b035656f820434bb82f15c2bf3e5725652689f` |
| `NetDataRequest.getHeaders.json` | `ev_574261ea574065cb8f2ef7b322de7c214772ca606df52c27af6f55920c27a16a` |
| `NetDataRequest.f.json` | `ev_856de1f2d88416aa2a40679fe806cd55982ea87caa3cc5682d180dacee12145b` |
| `RequestLogin.setPassword.json` | `ev_72c5c48361fcc61ee3aa4840f72fcaa679003c0df7525e0dccdfd6c420edb71a` |
| `DealPresent.reqTradeSubmit.json` | `ev_c2cdfb7f6166d657f529b8c7736f1464729c2d0b96b208952abc9d082ae503a2` |
| `DealPresent.reqRealTradeSubmit.json` | `ev_5efb1f1960b1f493b9e2755253d6a3f15b600d3924f700103d243b4b89b237ee` |
| `BaseRequest.constructor.1.json` | `ev_10265a156f4fe2c482fe291429f433fe17af0ad82fb9a6bd82fc51b74a5f5d97` |
| `RequestLogin.constructor.0.json` | `ev_2368bb4a4b7b52bb92e9fa5660257fa5d5490a34c4cbcb5a52aa8c13c1028b44` |
| `RequestTradeSubmit.constructor.0.json` | `ev_bb2046cdbfbd8a3ead431f295123ee9a767cf78753a17c3c4c526487f296eefc` |

Recovered facts:

- `LoginNewActivity.doLogin` trims email/password UI values and calls `submitReqest(email,password,"")`.
- `submitReqest` sets `accountNumber=email` and `password` directly; third argument only sets `googleSecretToken` when nonempty. RequestLogin constructor defaults `source` to email and reads the device AID preference. No password hash was observed between those methods and default Gson JSON serialization.
- `BaseRequest` selected 3-string constructor sets reqId/reqUrl/reqType; takes userId, stored Java token, account number/mobile, country/language from UserEntity; sets appSource GP, device/GAID/AID/package/version fields. Exact constructor Java/JSON is the source of truth.
- `NetDataRequest` methods establish body serialization and request headers. Earlier static endpoint mapping associates native login with POST `/ou/user/userLogin`. Original user login/challenges/session expiry are **not live-tested**; do not claim an arbitrary email/password-only request is guaranteed to work.
- Demo `DealPresent.reqTradeSubmit` constructs `RequestTradeSubmit(SocializeApi.g0,g0)`, then sets `buySell`, `symbol`, `amount`, `oneClick`, `guide`, and optional positive `profit`/`quotationTime`.
- Real `reqRealTradeSubmit` uses `SocializeApi.F` and sets `buySell`, **productId rather than symbol in that method**, `amount`, `oneClick`, and optional positive `quotationTime`/`profit`.
- JADX may display renamed aliases such as `SocializeApi.f13623c`; preserve alias/raw-DEX distinction when mapping endpoint constants.
- **Critical unresolved duration:** Actual DTO inventory has `timeUnit:int` and `timeUnitType:String`, but neither inspected submit method nor the RequestTradeSubmit constructor sets them. The constructor only calls super. No valid one-minute/default duration wire value was recovered. Do not guess values or place real orders to discover them.
- `buySell` numeric meaning/up-vs-down mapping, all inherited/default serialization effects, version-specific submit2 vs submit3 behavior, and server validation/settlement rules need further targeted tracing before authentic broker order integration.

### Source files and integration status at handoff

**Existing verified earlier implementation:**

- `server.mjs`: dependency-free Node 24 HTTP/SQLite server; `/v1/data` CSV reader route, local `/api/*` authentication/profile/preferences/wallet/notifications/support, **synthetic** local paper trading. No upstream GuruTrade routes currently.
- `market-data.mjs`: strict CSV parser and completed-minute OHLCV validation, filters/limits/CSV export, no synthetic fallback. Default `bars.csv` is still absent.
- `tests/server.test.mjs`, `tests/market-data.test.mjs`, `tests/indicators.test.mjs`: previous full run 15/15 passed. The indicator helpers are archived under `deferred/terminal/`; not attached to the new live terminal UI.

**New, not accepted end-to-end:**

- `guru-backend.mjs`: exports `GuruBackendError`, `normalizeGuruCatalog`, `normalizeGuruPoints`, `decodeGuruQuotation`, `normalizeGuruTicks`, `aggregateGuruTicks`, `createGuruBackend`.
- `createGuruBackend({fetchImpl,now,timeoutMs})` returns `{getMarkets,getQuote,getCandles,status,close}`. Uses hardcoded verified host, generated anonymous device ID, in-memory visitor token, request timeouts, bounded response parsing, cache/in-flight deduplication. Review its actual implementation before extending.
- `getMarkets()` fetches interfaceVersion2.0 catalogue, normalizes/deduplicates instruments and caches 5 seconds. `getQuote({symbol})` uses current-price endpoint and checks timestamps, caches 1 second. `getCandles({symbol,interval})` currently accepts only interval60 and returns genuine line points with no OHLC. `status().orderExecution` is false. No actual buy/sell method exists in adapter.
- `public/app.js`: core terminal, live catalogue search/categories/favorites/tabs, Canvas charts, genuine line-point support, explicit GuruTrade-vs-local-paper source selector, local auth/recovery/wallet/profile/history/notifications/support, local-paper Buy/Higher and Sell/Lower only, async/stale guards. GuruTrade mode intentionally disables execution until authenticated order integration is verified. Agent syntax check passed; **browser functionality/accessibility/layout and API integration remain unchecked**.
- `public/index.html`: links `/styles.css`, `/terminal-extra.css`, `/app.js`; contains the explicit source selector and no indicator selector. Default source is GuruTrade. It calls API routes which are **not yet wired**, so the live terminal is not ready to use.
- `public/terminal-extra.css`: scrollable 62-instrument watchlist, truncation for long instrument names, mobile asset picker.
- `public/data.html`: previous standalone usage page for CSV-backed `/v1/data`.
- `README.md` is stale for the new terminal/adapter and should be updated after actual acceptance, not before claiming completion.
- At stop-time: `tests/guru-backend.test.mjs`, `analysis/native-auth-findings.md`, and `analysis/guru-network-summary.md` **did not exist**. Agent prose reports were interrupted; use this checkpoint plus canonical JSON/Java files instead.

### Exact remaining work for Claude Code

1. Read `guru-backend.mjs`, `public/app.js`, current `server.mjs`, and saved response shapes. Add meaningful adapter tests using sanitized saved real responses: catalogue deduplication/limits/categories, encoded quote decoder, malformed/oversized/network-failed responses, timestamp units, symbol validation, cache failure/retry/close behavior, and no synthetic fallback. Test any dense-tick aggregation independently (ordering, boundaries, partial minutes, missing coverage, volume unknown).
2. Wire **public read-only** GET `/api/guru/markets`, `/api/guru/candles?symbol=...&interval=60`, `/api/guru/status`, and optionally `/api/guru/quote` to the adapter. Current server checks local auth for unrecognized `/api/*` routes, so place handling deliberately and preserve local-origin/host protection, JSON errors and response limits. Close the adapter on owned-server shutdown. Do not expose visitor tokens or a general-purpose arbitrary-URL proxy.
3. Smoke-test the adapter through the actual new routes with parent/full-network execution; establish current quote age and live data shape. Existing raw probes are request-level evidence, **not acceptance proof for the new adapter or server integration**.
4. Finish live chart behavior using verified line points first. Restrict unsupported intervals in GuruTrade mode rather than silently falling back to synthetic candles. If using dense observations for OHLC, label the output `aggregated_broker_quotes` and omit partial/unreliable completed bars. Do not claim native OHLC/volume.
5. Decide and implement an explicit data endpoint contract for broker symbols without breaking existing strict NIFTY/BANKNIFTY CSV `/v1/data`. Current endpoint has **no broker source support**. The app's observed instrument catalogue cannot satisfy actual underlying NIFTY/BANKNIFTY prices. Explain unavailable source truthfully.
6. Complete browser QA on the actual served terminal: source switching, all 62 catalogue entries, search/category/favorites, long names, chart/timeframe errors, empty/offline/stale states, mobile view, local-account sessions/recovery and paper order lifecycle. Verify that no local synthetic quote/trade appears as an upstream order or live market observation. Local wallet is USD; upstream snapshot currency is rupee; avoid displaying a local balance as a broker balance.
7. Recover original order duration and `buySell` mapping by following actual callers/setters and web payload construction. Read-only broker demo balance/history can be checked first. No authenticated original real-account sign-in, upstream demo order, real order, deposit, withdrawal, OTP delivery, or KYC was tested. Do not enable real-money order buttons solely from static endpoint names.
8. Update README and this checkpoint around actual final behavior/tests. Start/restart only an owned project server after checking its exact command line/PID; preserve unrelated running servers and port3000. The final stop-time socket check returned no 8765 listener. Recheck live state rather than assuming an older PID is still valid.

### Reuse commands and environment

- All shell calls in this workspace use the `rtk` prefix per `C:\Users\thiru\.codex\RTK.md`.
- Node24 built-in SQLite/WebSocket/crypto; no third-party runtime dependencies were added.
- Working REA public launcher: `C:\Users\thiru\AppData\Roaming\npm\node_modules\rea-agents\scripts\rea.mjs`, version6.7.0. Java `C:\Program Files\Java\jdk-26`; JADX JAR `C:\Users\thiru\Downloads\jadx-headless-mcp-0.7.1-all.jar`.
- `analysis/native-auth/run.py` sets exact process environment, verifies APK and JAR SHA-256, caches successful canonical Evidence, and uses **direct node + public REA launcher**. This avoids Windows `.cmd` treating constructor `<init>` as redirection. Existing 14 successful outputs should be reused; do not rerun full APK analysis to read those methods.
- Read-only probes are `analysis/probe-guru.mjs`, `analysis/probe-quotes.mjs`, `analysis/probe-ohlc.mjs`. **Do not run them blindly**: read source, reuse captures, then run only changed/needed requests. `--ticks` selects the interval60 capture saved as `guru-ticks-probe.json`.
- Full-network parent executor succeeded. Older child executors still encountered sandbox AccessDenied/EACCES; their failures do not establish upstream outage or broken parent REA readiness. No client MCP registration was changed; CLI is the proven path.

No task work should continue in this session after this checkpoint; the user is handing execution to Claude Code.

## Reverse engineering resolved - 2026-10-24 (Claude Code)

Source: downloaded official **web** bundle in `analysis/web/` (visitor/simulation build). Static inference from minified JS; not runtime-verified.

**Trade submit wire (web), authoritative payload from `6483.ba02ea4f.js` `placeAnOrder(accountType, buySell, oneClick)`:**
- Payload is EXACTLY `{ productId, amount, buySell, oneClick, quotationTime }`. No `timeUnit`/`timeUnitType`/duration field exists in the web submit — the Android DTO `timeUnit`/`timeUnitType` fields are UNUSED on this path. Expiry is server-side per product + quotationTime. **This resolves the checkpoint "critical unresolved duration" for the web terminal: there is no client duration field.**
- `buySell = 1` → Up/Higher (call); `buySell = -1` → Down/Lower (put). Confirmed by both button handlers `placeAnOrder(type,1,1)`/`placeAnOrder(type,-1,1)` and chart arrow rendering (`1==buySell` up, `-1==buySell` down).
- `oneClick` = flash/one-click flag (both button handlers pass `1`).
- `quotationTime = realTimePoint[0].value[0]` (current quotation timestamp from the live quote stream).
- Endpoints: demo `k=/ou/simulation/trade/submit2/auth`, real `E=/ou/trade/submit2/auth`. Both authenticated (`/auth`, need token). Versioned `submit2`.

**Login wire (web), from `index.e0d9dda8.js`:**
- `/ou/user/webLogin` for all logins. Captured visitor flow: `webLogin({ gaid:deviceId, source:"simulation", accountNumber:deviceId, passWord:deviceId })` → returns `{status:"0", data:{userId, token, deviceId, gaid, accountNumber, ...}}`, stored as `userInfo`.
- Real email login uses the same endpoint but its UI chunk was NOT in the downloaded bundle; `source` value for email login is UNVERIFIED (Android native default is `"email"` with accountNumber=email, passWord=password). Do not claim the real-account web login is verified.
- Authenticated request envelope adds `userId, token, deviceId, gaid, accountNumber` from stored userInfo.

**Other web endpoints seen:** `/ou/user/getBalance/auth`, `/ou/user/getRiskInfo/auth`, `/ou/simulation/trade/quotation/new`, `/ou/trade/unliquidated/list/auth`, `/ou/simulation/trade/list/auth`, `/ou/order/update/orderTimeStatus`, fund deposit/withdraw (NOT wanted by user). WebSocket quote stream: `wss://.../trade/webSocket?isWeb=true&userId=..&deviceId=..&accountNumber=..&sign=<getSign()>&appSource=WEB`.

**Build decision:** demo/simulation path is fully RE-derived and places no real money. Real-money login + `/ou/trade/submit2/auth` remain inferred/unverified — gate behind explicit user confirmation; never auto-place a real order.

## Claude Code progress - 2026-10-24

Done and verified (offline, no network, no trades):
- Wired read-only GuruTrade routes into `server.mjs`: `GET /api/guru/markets|candles|quote|status`, added to the public-route whitelist, adapter instantiated in `createApp` and closed in `close()`. The frontend already calls these (and its 401 guard already skips `/api/guru/*`), so GuruTrade **market-data** mode is now functional server-side. GuruBackendError carries `.status`, handled by the existing catch.
- Added `tests/guru-backend.test.mjs` (8 tests): catalog dedupe/validation, points sort/dedupe, quotation decoder round-trip (confirms the recovered rotation: dir 8 = rotate-left, dir 7/9 = rotate-right), tick aggregation dropping partial leading bars and never inventing volume, and the adapter flow (visitor login -> markets cache, quote freshness, unknown/invalid symbol, upstream error status, unsupported interval, closed adapter).
- Full suite now **23/23** (`node --test tests/server.test.mjs tests/market-data.test.mjs tests/indicators.test.mjs tests/guru-backend.test.mjs`).

Not yet done (needs user go-ahead — touches the live broker and/or real money):
- Adapter trade/login/balance/active-deals functions. Web wire is RE'd: demo `/ou/simulation/trade/submit2/auth`, real `/ou/trade/submit2/auth`, payload `{productId, amount, buySell(1=up,-1=down), oneClick, quotationTime}`, login `/ou/user/webLogin`.
- Frontend GuruTrade trade UI (currently app.js intentionally disables execution in guru mode).
- Live smoke test (sends real requests to api.guruserv.com). No live request fired this session.

## Live smoke test - 2026-10-24 (Claude Code)

Ran `node server.mjs --port 8799` and hit the real backend. Verified WORKING end-to-end:
- `GET /api/guru/markets` → 62 live instruments (mode live), e.g. `fx_ojpythb` JPY/THB (OTC), productId 10095, price ~0.2207, payout 82%, tradable, min 20 / max 5000, currency rupee.
- `GET /api/guru/quote?symbol=fx_ojpythb` → fresh quote, ageMs ~1.5s, stale false.
- `GET /api/guru/deals` (no login) → correct 401 "Log in to your GuruTrade account first".

BLOCKED (not a wiring bug):
- Demo trade `POST /api/guru/trade {buySell:1, amount:"20", oneClick:1, real:false}` → upstream **reject code 10316**. Payload shape matches the RE'd web wire exactly. Root cause: the web app sources `quotationTime` from `realTimePoint[0].value[0]` — the live **WebSocket** tick stream — not from `/ou/quotation/current`. The adapter uses the REST current-quote timestamp, which the server does not accept as a valid quotation point for submission. The WebSocket quote stream auth was never verified (prior LOGIN_FAIL). **Trade placement (demo AND real) is blocked on the WebSocket/quotationTime contract, independent of account type.** Did not retry repeatedly to avoid anti-abuse. No real-money order was attempted.

Next to unblock trading: reverse-engineer and implement the `wss://api.guruserv.com/trade/webSocket` auth (`sign=getSign()`, RSA scheme) to obtain live `quotationTime` ticks, OR find a REST endpoint that returns a submittable quotation point. Until then the terminal can show live markets/quotes/charts but cannot place orders.

## Real login VERIFIED + auto-login - 2026-10-24 (Claude Code)

- Real-account login is now **verified live**: `/ou/user/webLogin` with `source:"email"`, accountNumber=email, passWord=password → returns a real session (token/userId/accountNumber). This supersedes the earlier "unverified" note for the web real-login wire.
- Credentials read from root `.cred` file (`mail="..."`, `pass="..."`); added `.cred` to `.gitignore`.
- `server.mjs`: `createApp()` now returns `guru`; startup calls `autoLoginFromCred(app.guru)` — best-effort, offline-safe (tests unaffected, still network-free). Server logs `GuruTrade: signed in as <email>` and `status.loggedIn=true, orderExecution=true`. shortcut: no mid-session re-login on token expiry — restart to refresh.
- `getBalance()` returned `balance:0, currency:null` for this account — either a genuinely empty balance or the balance-response field mapping (`balance/money/amount`, `currencyType`) needs the real shape confirmed. Not yet validated against a funded account.
- Trade placement still blocked upstream (code 10316, WebSocket quotationTime) — unchanged.

## TRADE EXECUTION UNBLOCKED - 2026-10-24 (Claude Code)

**Root cause of 10316 found and fixed: `quotationTime` must be MILLISECONDS, not seconds.** Verified live: demo orders with ms `quotationTime` return `status:0 success`; the same payload with seconds returns `10316 "Request network error"`. Ruled out (all irrelevant to 10316): auth, `requestTime`, `Origin`/`Referer`, account type.

Verified live end-to-end through `POST /api/guru/trade` (demo, virtual funds, on the logged-in real account): order placed, response `{positionId, openPrice, openPositionTimestamp(ms), closeTime(open+60s), settleTimestamp, grossProfit:0.82, currency:"rupee", timeUnit:1, interval:59}`. Default expiry is 60s (one-minute / flash). Several demo orders were placed during testing — virtual money only; **no real-money order was placed.**

Adapter fixes in `guru-backend.mjs`: submit payload now `{productId, symbol, amount, buySell, oneClick, quotationTime:<ms>, requestTime}`; all requests send `Origin`/`Referer: https://www.gurutrade7.com`; trade result enriched with positionId/openPrice/closeTime/settleTimestamp/grossProfit/currency. Real path is identical with endpoint `/ou/trade/submit2/auth` and `real:true` — code ready, not exercised with real money.

Account model (from web bundle): one login holds `currentAccountType` `"REAL"` or `"DEMO"`; `currentAccountIsReal = type==="REAL"`. `/ou/user/getBalance/auth` returned real balance 0 for this account; demo wallet has funds (demo orders succeed). Fetching BOTH balances cleanly still needs the account-amount endpoint (`getCurrentAccountAmount`/`d.OZ`) resolved — not yet done.

Suite: 26/26. The WebSocket is NOT required for order placement (REST quotationTime in ms works). Remaining: resolve both-balance fetch; build the GuruTrade trade UI in the frontend; user to remove/retire synthetic local paper mode per request.

## Frontend converted to real GuruTrade trading - 2026-10-24 (Claude Code)

`public/app.js` + `public/index.html` reworked so the terminal trades on the real GuruTrade account (no more local-paper gate):
- Source dropdown repurposed to a **Demo / Real account** toggle (`state.accountType`); GuruTrade is the only source. Clicking the balance chip also toggles it.
- Higher/Lower buttons enabled in GuruTrade mode; `placeTrade` posts `/api/guru/trade` with `{symbol, buySell:(up?1:-1), amount, oneClick:(flash?1:0), real:(accountType==='real')}`. Real orders require a `confirm()`.
- Flash/Standard segmented control now sets `oneClick` (flash=1).
- Header shows account type + live balance (`/api/guru/balance`); open positions panel shows `/api/guru/deals?demo=…`; removed the paper Log in / Add funds / avatar buttons.
- Adapter `getActiveDeals({demo})` now hits the simulation vs real unliquidated-list endpoint; result `real` flag corrected.

Verified end-to-end on a running server: auto-login from `.cred`, demo Higher order placed via `/api/guru/trade` (positionId returned, 60s expiry), and `/api/guru/deals?demo=1` lists the open demo positions. Suite 26/26.

To use: restart the project server (loads new server.mjs/guru-backend.mjs + auto-login) and HARD-REFRESH the browser (Ctrl+Shift+R) to pick up new app.js/index.html.

Still open: real wallet balance reads 0 (field mapping vs genuinely empty — unconfirmed); demo balance has no clean endpoint yet (demo orders succeed, so funds exist); secondary nav pages (History/Wallet/Account/Support) still show the old local-paper content — not yet converted/removed; no real-money order has been placed; `duration` select in the ticket is inert (server fixes expiry at 60s).

## Demo balance + candle bars - 2026-10-24 (Claude Code)

RE from APK `DealPresent`: `reqSimulateBalance(productId)` builds `RequestBalance` with `source="simulation"`; `reqBalance(productId)` is the real one. Live probe showed `/ou/user/getBalance/auth` returns BOTH wallets in one call: `{balance:<real>, simulation:<demo>, bonus}`. Verified for this account: `balance:0, simulation:9802.32`.
- Adapter `getBalance()` now returns `{real, demo, bonus, currency:'rupee'}`. Frontend shows the wallet matching the Demo/Real toggle.

Candle bars: `/ou/quotation/getlist` with `interval:3` returns a plain array of dense 3-second `{ct(sec),cp}` points. Adapter `getCandles(interval)` now aggregates these into real OHLC candles via `aggregateGuruTicks` (provenance `aggregated_broker_quotes`, `nativeOhlc:false`, `volume:0`), with a line-points fallback when <2 bars. Supported intervals 5/10/15/30/60/180/300. Verified live: 15s→11 candles, 60s→2 candles (dense window is ~3 min, so smaller intervals give fuller charts). Frontend `loadCandles` already renders candles vs line; no UI change needed.

Suite 27/27. WebUI now: auto-login, Demo/Real toggle with correct balance, live candle chart, Higher/Lower/Flash order placement (demo verified end-to-end; real behind confirm, not exercised).

## High-frequency tick collector - 2026-10-24 (Claude Code)

RE: `/ou/quotation/getNewlist` {symbol,productId,interval:3} returns an ENCODED string → decodeGuruQuotation → `{quotationList:[{ct:<ms string>,cp}]}`, a dense sub-second feed (ms timestamps, ~0.25–1s spacing, ~384 obs over ~3 min). `queryDate=<ms>` returns only ticks newer than that (incremental).

Adapter now runs a continuous per-symbol collector: seeds from getNewlist, then polls every 1s with `queryDate=lastCt`, dedupes into a bounded Map (MAX_TICKS 100000 ≈ hours), idle-stops after 120s of no access, stops all on close(). Verified live: seed 384 ticks → +~2/s growth; candles 15s → 14 bars from the buffer.
- `getTicks({symbol, since, limit})` → raw ms ticks for AI (`since` for incremental pulls). Route `GET /api/guru/ticks?symbol=&since=&limit=`.
- `getCandles` now aggregates from the live buffer (history grows while the server runs), falling back to a one-shot getlist seed while warming up. `status().collectors` lists retained counts.

For AI: keep the server running so the collector accumulates; pull `/api/guru/ticks?symbol=…&since=<lastCt>` repeatedly for new sub-second ticks. Suite 28/28.

## Max history depth probed + seeded - 2026-10-25 (Claude Code)

Probed broker history ceiling: `/ou/quotation/getlist` returns only the **last ~1 hour** regardless of `interval` (interval 60 → 60 one-minute points/59m; interval 300 → 13 pts/1h; 3600 → 1 pt; `number`/`size`/`limit`/`count`/`pageSize` do NOT extend it). `getNewlist` = dense sub-second over ~3 min. **~1 hour is the broker's maximum exposed history; there is no deeper feed.** Anything older must be collected forward.

Collector now seeds BOTH on start: getlist interval 60 (full ~1h, 1-minute points) + getNewlist (dense sub-second, last ~3m), merged/deduped by ms. Verified live: candles 60s → 59 bars spanning 58 min; ticks → 453 over 59.4 min; keeps growing forward sub-second. Older ~57m is 1-minute resolution (flat single-price bars), last ~3m is sub-second; the dense region extends as the collector runs. Suite 28/28.

## 10316 transient handling + INR currency - 2026-10-25 (Claude Code)

- 10316 is the broker's transient "Request network error, please try again" — not fatal. `post()` now maps code 10316 to `GURU_TRANSIENT` (503, message "GuruTrade is busy right now — please try again in a moment.") and auto-retries idempotent READS up to twice (markets/quote/candles/ticks/balance/deals, getNewlist, getlist). Trades and login do NOT auto-retry (avoids double orders). Generic non-zero status reworded from "market-data request" to "request".
- WebUI currency switched USD→INR: trade-amount label INR, ₹ prefix, presets ₹20/₹100/₹500/₹1000, default 20; `renderQuote` shows potential profit via `guruMoney` (₹) and sets the amount input's min/max from the instrument's `minimumAmount`/`maximumAmount`. `guruMoney` defaults to ₹.
- Verified: suite 28/28, live markets read 200, demo trade placed.

## MCP server for agent trading - 2026-10-25 (Claude Code)

`guru-mcp.mjs`: dependency-free stdio JSON-RPC MCP server wrapping the adapter, so Codex/Claude Code/Claude Desktop can trade. Auto-logs in from `.cred`. Tools: guru_status, guru_login, guru_balance, guru_markets, guru_quote, guru_candles, guru_ticks, guru_open_trades, guru_place_order. Real-money orders refused unless env `GURU_ALLOW_REAL=1` (returns GURU_REAL_DISABLED otherwise); demo is default.
Test `tests/guru-mcp.test.mjs` spawns the server, checks initialize/tools-list/tools-call and the real-order gate. Verified live: MCP guru_balance + demo guru_place_order placed an order (positionId returned). Registration docs in `GURU-MCP.md`. Suite 30/30.
