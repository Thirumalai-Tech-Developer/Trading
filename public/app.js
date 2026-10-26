import { chartView, applyLiveTicks } from './chart-data.mjs';
const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const date = value => new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const clock = value => new Date(value).toISOString().slice(11, 19) + ' UTC';
const state = { source: 'guru', accountType: 'demo', flash: true, guruBalance: null, guruBalances: null, guruCurrency: null, guruDeals: [], guruAccount: null, sessionOrders: [], balanceError: '', markets: [], symbol: '', candles: [], points: [], interval: 60, filter: 'all', query: '', liveFavorites: [], tabs: [], epoch: 0, busy: false, poll: false, lastFeed: 0, lastCandles: 0, offset: 0, chartType: 'candles', zoom: 100, page: 'terminal', positionTab: 'open', chartError: '', marketError: '', pointer: null };
Object.assign(state, { guruError: '', quoteAt: 0, quoteError: '', unresolvedOrder: null });
try { state.unresolvedOrder = JSON.parse(sessionStorage.getItem('unconfirmed-order') || 'null'); } catch {}
try { state.liveFavorites = JSON.parse(localStorage.getItem('guru-favorites') || '[]'); if (!Array.isArray(state.liveFavorites)) state.liveFavorites = []; } catch { /* Corrupt optional preferences do not prevent startup. */ }
let toastTimer, marketSignature = '';
let liveFeed = null, liveSymbol = '', liveEpoch = -1, liveFrame = 0, pendingTicks = [];
Object.assign(state, { lastPushAt: 0, lastCatalogue: 0, liveTransport: '' });

function stopLiveFeed() {
  liveFeed?.close(); liveFeed = null; liveSymbol = ''; liveEpoch = -1;
  cancelAnimationFrame(liveFrame); liveFrame = 0; pendingTicks = []; state.lastPushAt = 0;
}
function startLiveFeed() {
  if (!state.symbol || document.hidden || (liveFeed && liveFeed.readyState !== EventSource.CLOSED && liveSymbol === state.symbol && liveEpoch === state.epoch)) return;
  stopLiveFeed();
  const symbol = state.symbol, epoch = state.epoch;
  const feed = new EventSource(`/api/guru/stream?symbol=${encodeURIComponent(symbol)}`);
  liveFeed = feed; liveSymbol = symbol; liveEpoch = epoch;
  feed.onopen = () => {
    if (liveFeed === feed && state.symbol === symbol && epoch === state.epoch && state.lastCandles) loadCandles(epoch);
  };
  feed.onmessage = event => {
    if (liveFeed !== feed || state.symbol !== symbol || epoch !== state.epoch) return;
    try {
      const update = JSON.parse(event.data);
      if (update.symbol !== symbol || !Array.isArray(update.ticks) || !Number.isFinite(update.serverTime)) throw new Error('Invalid live feed');
      pendingTicks.push(...update.ticks);
      state.liveTransport = update.transport;
      if (liveFrame) return;
      liveFrame = requestAnimationFrame(() => {
        liveFrame = 0;
        if (liveFeed !== feed || state.symbol !== symbol || epoch !== state.epoch) return;
        const ticks = pendingTicks; pendingTicks = [];
        try {
          const chart = applyLiveTicks(state, ticks, state.interval, Date.now() + state.offset, state.historyComplete);
          state.points = chart.points; state.candles = chart.candles;
          const latest = ticks.reduce((a, b) => !a || b.time >= a.time ? b : a, null);
          if (latest && latest.time >= state.quoteAt) {
            const market = selectedMarket(); if (market) market.price = latest.price;
            state.quoteAt = latest.time; state.quoteError = '';
          }
          state.lastPushAt = Date.now(); state.lastFeed = Date.now(); state.chartError = '';
          $('chart-source').lastChild.textContent = state.liveTransport === 'websocket' ? 'Live ticks' : 'REST fallback';
          $('last-price').dataset.quotedAt = String(state.quoteAt);
          renderQuote(); drawChart();
        } catch (error) { stopLiveFeed(); state.quoteError = error.message; updateTrading(); }
      });
    } catch { stopLiveFeed(); state.quoteError = 'Live feed unavailable. Using polling fallback.'; updateTrading(); }
  };
  feed.onerror = () => {
    if (liveFeed !== feed) return;
    state.lastPushAt = 0;
    $('chart-source').lastChild.textContent = 'Reconnecting';
  };
  feed.addEventListener('feed-error', () => { if (liveFeed === feed) state.lastPushAt = 0; });
}

const paths = {
  markets: '<path d="M3 20h18M5 16l4-6 4 3 6-9"/><path d="M15 4h4v4"/>',
  history: '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2M3 5v5h5"/>',
  wallet: '<path d="M3 7h17v13H3zM3 7V4h14v3M16 12h5v5h-5z"/>',
  profile: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4M12 17h.01"/>',
  support: '<path d="M4 13v-2a8 8 0 0 1 16 0v2M4 12H2v7h5v-7zm16 0h2v7h-5v-7zM20 19c0 3-5 3-7 3"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
  expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5"/>',
  shield: '<path d="m12 2 8 3v6c0 5-5 9-8 11-3-2-8-6-8-11V5zM8 12l3 3 5-6"/>',
  'trend-up': '<path d="m3 17 6-6 4 3 8-10M15 4h6v6"/>',
  'trend-down': '<path d="m3 7 6 6 4-3 8 10M15 20h6v-6"/>',
  bell: '<path d="M4 17h16l-2-3V9a6 6 0 0 0-12 0v5zM10 21h4"/>',
};
function icon(name) { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.markets}</svg>`; }
function icons(root = document) { root.querySelectorAll('[data-icon]').forEach(node => { node.innerHTML = icon(node.dataset.icon); }); }
function toast(message, error = false) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').className = 'toast' + (error ? ' error' : ''); toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 6000); }
async function api(route, body, method = body === undefined ? 'GET' : 'POST') {
  let response;
  try { response = await fetch(route, { method, credentials: 'same-origin', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), 'X-Guru-Request': '1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(route.endsWith('/trade') ? 60000 : 45000) }); }
  catch { throw Object.assign(new Error('Cannot confirm the server response. Check the connection.'), { code: 'NETWORK_ERROR' }); }
  let data;
  try { data = await response.json(); } catch { throw Object.assign(new Error(`The server returned an invalid response (${response.status}).`), { code: 'NETWORK_ERROR' }); }
  if (!response.ok) {
    throw Object.assign(new Error(typeof data.error === 'string' ? data.error : `Request failed (${response.status})`), { code: data.code, status: response.status });
  }
  return data;
}
function category(market) {
  const value = String(market.category || '').toLowerCase();
  return /currenc|forex/.test(value) ? 'forex' : /stock|share|equity/.test(value) ? 'stocks' : /indic|index/.test(value) ? 'indices' : /crypto/.test(value) ? 'crypto' : /commod/.test(value) ? 'commodities' : value;
}
function favoriteSymbols() { return state.liveFavorites; }
function selectedMarket() { return state.markets.find(market => market.symbol === state.symbol); }
function price(value, market = selectedMarket()) { return Number.isFinite(value) ? value.toFixed(Math.max(0, Math.min(8, Number.isInteger(market?.precision) ? market.precision : 5))) : '—'; }
function coin(market) {
  const symbol = String(market?.symbol || '').toUpperCase();
  if (category(market || {}) === 'commodities') return /XAU|GOLD/.test(symbol) ? 'Au' : /XAG|SILVER/.test(symbol) ? 'Ag' : /PALLADIUM/.test(symbol) ? 'Pd' : /PLATINUM/.test(symbol) ? 'Pt' : /URANIUM/.test(symbol) ? 'U' : String(market.name || market.symbol).slice(0, 2);
  return /BTC/.test(symbol) ? '₿' : /ETH/.test(symbol) ? 'Ξ' : category(market || {}) === 'stocks' ? String(market.name || market.symbol).slice(0, 2).toUpperCase() : /GBP/.test(symbol) ? '£' : /JPY/.test(symbol) ? '¥' : category(market || {}) === 'indices' ? '↗' : '€';
}
function empty(title, message = '') { return `<div class="empty-state">${icon('markets')}<h3>${escape(title)}</h3><p>${escape(message)}</p></div>`; }

function renderMarkets(force = false) {
  const signature = JSON.stringify([state.markets.map(m => [m.symbol, m.name, m.category, m.payout, m.tradable]), state.symbol, state.filter, state.query, favoriteSymbols(), state.marketError]);
  if (!force && signature === marketSignature) return;
  marketSignature = signature;
  $('market-count').textContent = state.markets.length;
  const filtered = state.markets.filter(market => (state.filter === 'all' || (state.filter === 'favorites' ? favoriteSymbols().includes(market.symbol) : category(market) === state.filter)) && `${market.name} ${market.symbol}`.toLowerCase().includes(state.query.toLowerCase()));
  $('markets').innerHTML = filtered.length ? filtered.map(market => `<div class="market-row${market.symbol === state.symbol ? ' active' : ''}" role="button" tabindex="0" data-symbol="${escape(market.symbol)}" aria-label="Select ${escape(market.name)}" aria-pressed="${market.symbol === state.symbol}"><span class="asset-coin">${escape(coin(market))}</span><span class="market-info"><strong title="${escape(market.name)}">${escape(market.name || market.symbol)}</strong><small>${escape(market.category || 'Asset')}${market.tradable === false ? market.marketStatus === 'unavailable' ? ' · Unavailable' : ' · Closed' : ''}</small></span><span class="market-return"><strong>${Number.isFinite(market.payout) ? escape(market.payout) + '%' : '—'}</strong><button class="favorite-button${favoriteSymbols().includes(market.symbol) ? ' favorited' : ''}" data-favorite="${escape(market.symbol)}" aria-label="${favoriteSymbols().includes(market.symbol) ? 'Remove' : 'Add'} ${escape(market.name)} ${favoriteSymbols().includes(market.symbol) ? 'from' : 'to'} favorites">${favoriteSymbols().includes(market.symbol) ? '★' : '☆'}</button></span></div>`).join('') : empty(state.marketError ? 'Backend unavailable' : 'No matching assets', state.marketError || 'Try another search or category.');
  document.querySelectorAll('#market-filters button').forEach(button => button.classList.toggle('active', button.dataset.filter === state.filter));
  const tabs = state.tabs.map(symbol => state.markets.find(m => m.symbol === symbol)).filter(Boolean);
  $('asset-tabs').innerHTML = tabs.map(market => `<button class="asset-tab${market.symbol === state.symbol ? ' active' : ''}" data-symbol="${escape(market.symbol)}">${escape(market.name || market.symbol)}${Number.isFinite(market.payout) ? `<small>${market.payout}%</small>` : ''}</button>`).join('') + '<button class="tab-add" data-action="assets" aria-label="Browse all assets">+</button>';
}
function renderQuote() {
  const market = selectedMarket();
  $('asset-name').innerHTML = `${escape(market?.name || 'Select an asset')} <span>Backend</span>`;
  $('asset-subtitle').textContent = market ? `${market.symbol} · ${market.category || 'Market'}` : 'Choose from the market catalogue';
  $('selected-coin').textContent = coin(market);
  const last = Number.isFinite(market?.price) ? market.price : state.points.at(-1)?.value ?? state.candles.at(-1)?.close;
  $('last-price').textContent = price(last, market);
  $('price-change').textContent = Number.isFinite(market?.change) ? `${market.change >= 0 ? '+' : ''}${market.change.toFixed(3)}%` : 'Backend market data';
  $('price-change').className = Number(market?.change) < 0 ? 'negative' : 'positive';
  $('chart').setAttribute('aria-label', `${market?.name || 'Market'} backend price chart. Use plus and minus to zoom.`);
  const minimum = state.accountType === 'real' ? market?.minimumAmount : market?.demoMinimumAmount ?? market?.minimumAmount;
  const maximum = state.accountType === 'real' ? market?.maximumAmount : market?.demoMaximumAmount ?? market?.maximumAmount;
  $('amount').min = Number.isFinite(minimum) ? minimum : 1;
  $('amount').max = Number.isFinite(maximum) ? maximum : 100000;
  const supported = market?.supportedDurations || [];
  const duration = $('duration');
  const choices = [...new Set([5, 10, 15, 30, 60, 120, 300, ...supported])].sort((a, b) => a - b);
  const signature = JSON.stringify([market?.symbol, supported]);
  if (duration.dataset.signature !== signature) {
    const previous = Number(duration.value);
    duration.innerHTML = choices.map(seconds => `<option value="${seconds}"${supported.includes(seconds) ? '' : ' disabled'}>${seconds < 60 ? seconds + ' seconds' : seconds / 60 + ' minute' + (seconds > 60 ? 's' : '')}${supported.includes(seconds) ? '' : ' · unavailable'}</option>`).join('');
    duration.value = String(supported.includes(previous) ? previous : supported.includes(60) ? 60 : supported[0] ?? '');
    duration.dataset.signature = signature;
  }
  duration.disabled = state.busy || supported.length === 0;
  const expiry = market?.durationOptions?.find(option => option.seconds === Number(duration.value));
  const payout = Number.isFinite(expiry?.payout) ? expiry.payout : Number.isFinite(market?.payout) ? market.payout : null;
  $('payout').textContent = payout === null ? '—' : `${payout}%`;
  const amount = Number($('amount').value);
  $('expected-profit').textContent = payout === null || !Number.isFinite(amount) ? '—' : `+${guruMoney(amount * payout / 100)}`;
  updateTrading();
}
function updateTrading() {
  const market = selectedMarket();
  const stale = Date.now() - state.lastFeed > 15000 || !state.quoteAt || Date.now() + state.offset - state.quoteAt > 30000;
  const real = state.accountType === 'real';
  const loggedIn = Boolean(state.guruAccount?.loggedIn);
  const blocked = state.busy || stale || Boolean(state.marketError) || !market || market.tradable === false || Boolean(state.quoteError) || (real && (!loggedIn || !state.guruAccount?.realOrdersEnabled)) || Boolean(state.unresolvedOrder);
  $('trade-up').disabled = blocked; $('trade-down').disabled = blocked;
  $('trade-feedback').textContent = state.busy ? 'Placing your order…'
    : state.unresolvedOrder ? 'An order is unconfirmed. Check your broker trades before placing another.'
    : state.marketError || state.quoteError ? state.marketError || state.quoteError
    : stale ? 'Waiting for a fresh backend quote…'
    : market && market.tradable === false ? 'This instrument is closed for trading right now.'
    : real && !loggedIn ? 'Connect your GuruTrade account to use real mode.'
    : real && !state.guruAccount?.realOrdersEnabled ? 'Real orders are disabled on this server.'
    : real ? 'Real account · real money. Orders are final once placed.'
    : 'GuruTrade demo · virtual funds.';
  document.querySelector('.trade-ticket .tiny-tag').textContent = real ? 'Real' : 'Demo';
  $('source-select').disabled = state.busy;
  $('duration').disabled = state.busy || !(market?.supportedDurations?.length);
  $('duration-note').textContent = market?.durationSource === 'tradeTimeRespList' ? 'Choose an expiry from the app’s supported trade-time options.' : market?.supportedDurations?.length ? 'The broker provides only its default expiry for this product.' : 'Duration metadata is unavailable; the broker assigns expiry.';
  $('review-order').hidden = !state.unresolvedOrder;
  const note = document.querySelector('.ticket-note p');
  note.innerHTML = real
    ? 'Real money<small>Orders place real GuruTrade trades and can lose real funds.</small>'
    : 'Demo funds<small>Practice orders on your GuruTrade demo balance.</small>';
}
function guruMoney(value) { return Number.isFinite(value) ? `${state.guruCurrency && state.guruCurrency !== 'rupee' ? state.guruCurrency + ' ' : '₹'}${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—'; }
function renderAccount() {
  $('balance').textContent = guruMoney(state.guruBalance);
  $('account-label').textContent = state.accountType === 'real' ? 'Real account' : 'Demo account';
  $('broker-login-button').textContent = state.guruAccount?.loggedIn ? 'GuruTrade connected' : 'Connect GuruTrade';
  $('stat-trades').textContent = state.guruDeals.length;
  $('stat-winrate').textContent = state.guruAccount?.loggedIn ? 'Connected' : 'Visitor';
  $('stat-profit').textContent = guruMoney(state.guruBalance);
  document.querySelectorAll('[data-wallet-balance]').forEach(node => { node.textContent = guruMoney(state.guruBalances?.[node.dataset.walletBalance]); });
  if ($('balance-feed-error')) $('balance-feed-error').textContent = state.balanceError || 'Balances refresh from GuruTrade. Deposits and withdrawals are handled on the official broker website.';
  document.querySelector('.market-summary h3').textContent = 'GuruTrade account';
  const labels = document.querySelectorAll('.market-summary > div > span');
  labels[0].textContent = 'Open trades'; labels[1].textContent = 'Session'; labels[2].textContent = 'Balance';
  renderPositions(); updateTrading();
}
function guruDealsTable(deals) {
  if (!deals.length) return empty('No open trades', 'Place a Higher or Lower order to open a position.');
  const market = sym => state.markets.find(m => m.symbol === sym);
  return `<div class="table-scroll"><table><thead><tr><th>Asset</th><th>Stake</th><th>Open price</th><th>Opened</th></tr></thead><tbody>${deals.map(d => `<tr><td class="trade-symbol">${escape(market(d.symbol)?.name || d.symbol || '—')}<span class="trade-direction ${d.buySell === 1 ? 'positive' : 'negative'}">${d.buySell === 1 ? '↑' : '↓'}</span></td><td>${guruMoney(d.amount)}</td><td>${escape(d.openPrice ?? '—')}</td><td>${d.openPositionTimestamp ? escape(date(d.openPositionTimestamp)) : '—'}</td></tr>`).join('')}</tbody></table></div>`;
}
function sessionOrdersTable() {
  const orders = state.sessionOrders || [];
  if (!orders.length) return empty('No recorded orders', 'Orders submitted through this app appear here. Settlement history is not provided by this connection.');
  return `<div class="table-scroll"><table><thead><tr><th>Order ID</th><th>Asset</th><th>Direction</th><th>Stake</th><th>Confirmation</th></tr></thead><tbody>${orders.map(o => `<tr><td>${escape(o.positionId || o.requestId)}</td><td>${escape(o.symbol)}</td><td>${o.buySell === 1 ? 'Higher' : 'Lower'}</td><td>${guruMoney(o.amount)}</td><td>${escape(o.state)}</td></tr>`).join('')}</tbody></table></div>`;
}
function renderPositions() {
  $('open-count').textContent = state.guruDeals.length;
  $('positions-content').innerHTML = state.positionTab !== 'open' ? sessionOrdersTable() : state.guruError ? empty('Cannot load broker trades', state.guruError) : guruDealsTable(state.guruDeals);
  $('open-trades-tab').classList.toggle('active', state.positionTab === 'open');
  $('recent-trades-tab').classList.toggle('active', state.positionTab !== 'open');
}
async function refreshFeed() {
  if (state.poll) return;
  state.poll = true;
  const epoch = state.epoch, source = state.source;
  try {
    const result = await api('/api/guru/markets');
    if (epoch !== state.epoch) return;
    if (!Array.isArray(result.markets)) throw new Error('The backend did not return a market catalogue.');
    const current = selectedMarket();
    state.markets = result.markets; state.marketError = ''; state.lastFeed = Date.now(); state.lastCatalogue = Date.now();
    if (current && Date.now() - state.lastPushAt < 5000) { const market = selectedMarket(); if (market) market.price = current.price; }
    $('watchlist-source').textContent = result.catalogueWarning || `App catalogue · ${result.markets.length} instruments · ${result.productVariantCount ?? result.markets.length} product variants`;
    if (Number.isFinite(result.serverTime)) state.offset = result.serverTime - Date.now();
    if (!state.markets.some(market => market.symbol === state.symbol)) { state.symbol = state.markets[0]?.symbol || ''; state.candles = []; state.points = []; state.tabs = state.symbol ? [state.symbol] : []; }
    if (!state.tabs.includes(state.symbol) && state.symbol) state.tabs.push(state.symbol);
    renderMarkets(); renderQuote();
    $('connection-state').textContent = 'Backend connected';
    if (state.symbol) {
      startLiveFeed();
      if (Date.now() - state.lastPushAt > 5000 || !state.lastCandles) await Promise.all([loadCandles(epoch), loadQuote(epoch)]);
    }
    else { state.chartError = 'No instruments were returned by the selected backend.'; drawChart(); }
  } catch (error) {
    if (epoch !== state.epoch) return;
    state.marketError = error.message; state.chartError = error.message;
    $('connection-state').textContent = 'Backend unavailable';
    renderMarkets(); drawChart(); updateTrading();
  } finally { state.poll = false; }
}
async function loadCandles(epoch = state.epoch) {
  const symbol = state.symbol, interval = state.interval;
  if (!symbol) return;
  try {
    const result = await api(`/api/guru/candles?symbol=${encodeURIComponent(symbol)}&interval=${interval}`);
    if (epoch !== state.epoch || symbol !== state.symbol || interval !== state.interval) return;
    if (!Array.isArray(result.candles) && !Array.isArray(result.points)) throw new Error('The backend did not return price history.');
    const rawCandles = result.candles || [], rawPoints = result.points || [];
    const candles = rawCandles.filter(c => [c.time, c.open, c.high, c.low, c.close].every(Number.isFinite));
    const points = rawPoints.filter(point => [point.time, point.value].every(Number.isFinite));
    if (candles.length !== rawCandles.length || points.length !== rawPoints.length) throw new Error('The backend returned invalid price history.');
    const lastSnapshotTime = points.at(-1)?.time ?? 0;
    const newer = state.points.filter(p => p.time > lastSnapshotTime).map(p => ({ time: Math.round(p.time * 1000), price: p.value }));
    if (points.length) newer.unshift({ time: Math.round(points.at(-1).time * 1000), price: points.at(-1).value });
    const chart = applyLiveTicks({ points, candles }, newer, interval, Date.now() + state.offset, result.historyComplete === true);
    state.candles = chart.candles; state.points = chart.points; state.chartError = chart.candles.length || chart.points.length ? '' : 'No price history is available in the last hour.'; state.lastCandles = Date.now();
    state.historyComplete = result.historyComplete === true;
    [...$('chart-type').options].forEach(option => { option.disabled = ['bars', 'candles'].includes(option.value) && !state.candles.length; });
    if (!state.candles.length && ['bars', 'candles'].includes(state.chartType)) { state.chartType = 'line'; $('chart-type').value = 'line'; }
    renderQuote(); drawChart();
  } catch (error) {
    if (epoch !== state.epoch || symbol !== state.symbol || interval !== state.interval) return;
    state.chartError = error.message; state.candles = []; state.points = []; drawChart(); updateTrading();
    $('history-range').textContent = 'History unavailable';
  }
}
async function selectSymbol(symbol) {
  if (!state.markets.some(market => market.symbol === symbol)) return;
  stopLiveFeed();
  state.symbol = symbol; state.candles = []; state.points = []; state.lastCandles = 0; state.quoteAt = 0; state.quoteError = ''; state.chartError = ''; state.historyComplete = false;
  if (!state.tabs.includes(symbol)) { state.tabs.push(symbol); if (state.tabs.length > 6) state.tabs.shift(); }
  renderMarkets(); renderQuote(); drawChart();
  if ($('modal').open) $('modal').close();
  startLiveFeed();
  await Promise.all([loadCandles(), loadQuote()]);
}
async function loadQuote(epoch = state.epoch) {
  if (!state.symbol) return;
  const symbol = state.symbol;
  try {
    const quote = await api(`/api/guru/quote?symbol=${encodeURIComponent(symbol)}`);
    if (epoch !== state.epoch || symbol !== state.symbol) return;
    if (quote.quotedAt < state.quoteAt) return;
    state.quoteAt = quote.quotedAt; state.quoteError = quote.stale ? 'The broker quote is stale.' : '';
    const market = selectedMarket(); if (market) market.price = quote.price;
    renderQuote();
  } catch (error) {
    if (epoch !== state.epoch || symbol !== state.symbol) return;
    if (Date.now() - state.lastPushAt > 5000) { state.quoteAt = 0; state.quoteError = error.message; updateTrading(); }
  }
}
async function switchSource(type) {
  if (state.busy || !['demo', 'real'].includes(type)) return;
  state.epoch++; state.accountType = type;
  startLiveFeed();
  state.guruBalance = null; state.guruDeals = []; state.sessionOrders = []; state.guruError = ''; state.positionTab = 'open';
  $('source-select').value = type;
  $('header-source').textContent = type === 'real' ? 'GuruTrade · Real' : 'GuruTrade · Demo';
  renderAccount(); renderQuote();
  await Promise.all([loadGuruAccount(), loadQuote()]);
}
function drawChart() {
  const canvas = $('chart'), rect = canvas.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return;
  const ratio = window.devicePixelRatio || 1;
  const pixelWidth = Math.round(rect.width * ratio), pixelHeight = Math.round(rect.height * ratio);
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  const ctx = canvas.getContext('2d'); ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, rect.width, rect.height); ctx.setLineDash([]);
  const colors = getComputedStyle(document.body), green = colors.getPropertyValue('--green').trim(), red = colors.getPropertyValue('--red').trim(), muted = colors.getPropertyValue('--muted').trim(), grid = colors.getPropertyValue('--grid').trim();
  const width = rect.width, height = rect.height, left = 18, right = 78, top = 18, bottom = 30, plotW = Math.max(1, width - left - right), plotH = Math.max(1, height - top - bottom);
  ctx.font = '10px Segoe UI'; ctx.lineWidth = 1; ctx.strokeStyle = grid; ctx.fillStyle = muted;
  const view = chartView({ candles: state.candles, points: state.points, serverTime: Date.now() + state.offset, zoom: state.zoom, type: state.chartType });
  const linePoints = view.points.length > 0;
  const candles = linePoints ? view.points : view.candles;
  $('chart-caption').textContent = linePoints ? state.historyComplete ? 'Full broker tick history · volume unavailable' : 'Broker samples · tick history incomplete' : 'OHLC from broker ticks · volume unavailable';
  const partialCount = candles.filter(c => c.partial && !c.forming).length;
  const candleLabel = `${candles.filter(c => !c.forming && !c.partial).length} completed + ${candles.filter(c => c.forming).length} live candles${partialCount ? ' + ' + partialCount + ' partial' : ''}`;
  $('history-range').textContent = candles.length ? `Last 1h · available ${clock(candles[0].time * 1000).slice(0, 8)}–${clock(candles.at(-1).time * 1000)} · ${linePoints ? candles.length + (state.historyComplete ? ' price ticks' : ' price samples') : candleLabel}` : state.chartError ? 'History unavailable' : 'Loading historical ticks…';
  const overlay = $('chart-loading'); overlay.classList.toggle('hidden', candles.length > 0 && !state.chartError);
  overlay.textContent = state.chartError || (state.symbol ? 'Loading backend candles…' : 'Select an asset to view its candles');
  if (!candles.length) { for (let i = 0; i < 6; i++) { const y = top + plotH * i / 5; ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(width - right, y); ctx.stroke(); } return; }
  let min = Math.min(...candles.map(c => linePoints ? c.value : c.low)), max = Math.max(...candles.map(c => linePoints ? c.value : c.high));
  const padding = (max - min || Math.abs(max) * 0.001 || 1) * 0.12; min -= padding; max += padding;
  const step = plotW * state.interval / (view.end - view.start), x = i => left + (candles[i].time - view.start) / (view.end - view.start) * plotW, y = value => top + (max - value) / (max - min) * plotH;
  for (let i = 0; i < 6; i++) { const py = top + plotH * i / 5; ctx.strokeStyle = grid; ctx.beginPath(); ctx.moveTo(left, py); ctx.lineTo(width - right, py); ctx.stroke(); ctx.fillStyle = muted; ctx.fillText(price(max - (max - min) * i / 5), width - right + 8, py + 3); }
  for (let i = 0; i <= 5; i++) { const px = left + plotW * i / 5, time = view.start + (view.end - view.start) * i / 5; ctx.strokeStyle = grid; ctx.beginPath(); ctx.moveTo(px, top); ctx.lineTo(px, height - bottom); ctx.stroke(); ctx.fillStyle = muted; ctx.fillText(new Date(time * 1000).toISOString().slice(11, 16), Math.max(left, px - 14), height - 9); }
  if (linePoints || state.chartType === 'line' || state.chartType === 'area') {
    ctx.beginPath(); candles.forEach((c, i) => i ? ctx.lineTo(x(i), y(linePoints ? c.value : c.close)) : ctx.moveTo(x(i), y(linePoints ? c.value : c.close)));
    ctx.strokeStyle = colors.getPropertyValue('--accent').trim(); ctx.lineWidth = 1.7; ctx.stroke();
    if (state.chartType === 'area') { ctx.lineTo(x(candles.length - 1), height - bottom); ctx.lineTo(x(0), height - bottom); ctx.closePath(); const gradient = ctx.createLinearGradient(0, top, 0, height); gradient.addColorStop(0, '#8a85ff35'); gradient.addColorStop(1, '#8a85ff00'); ctx.fillStyle = gradient; ctx.fill(); }
  } else {
    candles.forEach((candle, i) => { const px = x(i), up = candle.close >= candle.open; ctx.strokeStyle = ctx.fillStyle = up ? green : red; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(px, y(candle.high)); ctx.lineTo(px, y(candle.low)); ctx.stroke(); if (state.chartType === 'bars') { ctx.beginPath(); ctx.moveTo(px - step * 0.28, y(candle.open)); ctx.lineTo(px, y(candle.open)); ctx.moveTo(px, y(candle.close)); ctx.lineTo(px + step * 0.28, y(candle.close)); ctx.stroke(); } else { const candleWidth = Math.max(1, step * 0.58); ctx.fillRect(px - candleWidth / 2, Math.min(y(candle.open), y(candle.close)), candleWidth, Math.max(1, Math.abs(y(candle.open) - y(candle.close)))); } });
  }

  const last = candles.at(-1), lastValue = linePoints ? last.value : last.close, lastY = y(lastValue); ctx.strokeStyle = linePoints || last.close >= last.open ? green : red; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(left, lastY); ctx.lineTo(width - right, lastY); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = ctx.strokeStyle; ctx.fillRect(width - right + 2, lastY - 9, right - 5, 18); ctx.fillStyle = '#111724'; ctx.fillText(price(lastValue), width - right + 7, lastY + 3);
  if (state.pointer && state.pointer.x >= left && state.pointer.x <= width - right) {
    const pointerTime = view.start + (state.pointer.x - left) / plotW * (view.end - view.start);
    let i = 0;
    for (let j = 1; j < candles.length; j++) if (Math.abs(candles[j].time - pointerTime) < Math.abs(candles[i].time - pointerTime)) i = j;
    const candle = candles[i];
    ctx.strokeStyle = muted; ctx.setLineDash([2, 4]); ctx.beginPath(); ctx.moveTo(x(i), top); ctx.lineTo(x(i), height - bottom); ctx.moveTo(left, state.pointer.y); ctx.lineTo(width - right, state.pointer.y); ctx.stroke(); ctx.setLineDash([]);
    const tip = $('chart-tooltip'); tip.classList.remove('hidden'); tip.innerHTML = `${escape(new Date(candle.time * 1000).toISOString())}<br>${linePoints ? 'Price ' + price(candle.value) + '<br>OHLC not supplied by backend' : 'O ' + price(candle.open) + ' &nbsp; H ' + price(candle.high) + '<br>L ' + price(candle.low) + ' &nbsp; C ' + price(candle.close)}${Number.isFinite(candle.volume) ? '<br>Volume unavailable' : ''}`; tip.style.left = Math.max(4, Math.min(width - 235, state.pointer.x + 15)) + 'px'; tip.style.top = Math.max(4, Math.min(height - 120, state.pointer.y - 50)) + 'px';
  } else $('chart-tooltip').classList.add('hidden');
}

function openModal(content) { $('modal-content').innerHTML = content; if (!$('modal').open) $('modal').showModal(); icons($('modal-content')); }
function field(label, name, type = 'text', value = '', extra = '') { return `<label class="form-field">${label}<input name="${name}" type="${type}" value="${escape(value)}" ${extra}></label>`; }

function brokerAuth() {
  if (state.busy) return;
  if (state.guruAccount?.loggedIn) {
    openModal(`<h1>GuruTrade account</h1><p>${escape(state.guruAccount.accountNumber)}</p><p>Real orders: ${state.guruAccount.realOrdersEnabled ? 'enabled on this server' : 'disabled on this server'}.</p><button class="button" data-action="broker-logout">Disconnect GuruTrade</button>`);
    return;
  }
  openModal(`<h1>Connect GuruTrade</h1><p>Sign in to view your broker balances and open trades. Credentials are sent to GuruTrade and held only for this server session.</p><form id="broker-auth-form">${field('Email / account', 'accountNumber', 'text', '', 'required minlength="3" maxlength="254" autocomplete="username"')}${field('Password', 'passWord', 'password', '', 'required maxlength="256" autocomplete="current-password"')}<p class="form-error" role="alert"></p><button class="button primary full" type="submit">Connect account</button></form>`);
}

function assetsModal() {
  openModal(`<h1>All assets</h1><p>${state.markets.length} instruments from the GuruTrade backend.</p><label class="search-field">${icon('search')}<input id="asset-modal-search" type="search" placeholder="Search instruments" aria-label="Search instruments"></label><div id="asset-modal-list"></div>`);
  renderAssetModal('');
}
function renderAssetModal(query) {
  if (!$('asset-modal-list')) return;
  $('asset-modal-list').innerHTML = state.markets.filter(m => `${m.name} ${m.symbol}`.toLowerCase().includes(query.toLowerCase())).map(m => `<button class="asset-picker-row" data-symbol="${escape(m.symbol)}"><span><strong>${escape(m.name || m.symbol)}</strong><small>${escape(m.symbol)} · ${escape(m.category)}</small></span><span>${price(m.price, m)}</span></button>`).join('') || empty('No matching assets', state.marketError || 'Try a different search.');
}

const nav = [['terminal', 'markets', 'Trade'], ['history', 'history', 'History'], ['wallet', 'wallet', 'Wallet'], ['profile', 'profile', 'Account'], ['support', 'support', 'Support']];
$('navigation').innerHTML = nav.map(([page, image, label]) => `<button data-page="${page}" class="nav-item${page === 'terminal' ? ' active' : ''}">${icon(image)}<span>${label}</span></button>`).join('');
$('notifications-button').innerHTML = icon('bell');
icons();

document.addEventListener('click', event => { handleClick(event).catch(error => toast(error.message, true)); });
async function handleClick(event) {
  const accountType = event.target.closest('[data-account-type]');
  if (accountType) { $('modal').close(); return switchSource(accountType.dataset.accountType); }
  const favorite = event.target.closest('[data-favorite]');
  if (favorite) {
    const symbol = favorite.dataset.favorite;
    state.liveFavorites = state.liveFavorites.includes(symbol) ? state.liveFavorites.filter(s => s !== symbol) : [...state.liveFavorites, symbol];
    try { localStorage.setItem('guru-favorites', JSON.stringify(state.liveFavorites)); } catch {}
    renderMarkets(); return;
  }
  const symbol = event.target.closest('[data-symbol]'); if (symbol && !state.busy) return selectSymbol(symbol.dataset.symbol);
  const page = event.target.closest('[data-page]'); if (page) return navigate(page.dataset.page);
  const filter = event.target.closest('[data-filter]'); if (filter) { state.filter = filter.dataset.filter; renderMarkets(); return; }
  const timeframe = event.target.closest('[data-interval]');
  if (timeframe) {
    state.interval = Number(timeframe.dataset.interval); state.candles = []; state.points = []; state.lastCandles = 0;
    document.querySelectorAll('[data-interval]').forEach(button => button.classList.toggle('active', button === timeframe));
    drawChart(); return loadCandles();
  }
  const amount = event.target.closest('[data-amount]'); if (amount && !state.busy) { $('amount').value = amount.dataset.amount; renderQuote(); return; }
  const mode = event.target.closest('[data-mode]'); if (mode && !state.busy) { state.flash = mode.dataset.mode === 'flash'; document.querySelectorAll('[data-mode]').forEach(button => button.classList.toggle('active', button === mode)); return; }
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'assets') return assetsModal();
  if (action === 'close-modal') return $('modal').close();
  if (action === 'broker-login') return brokerAuth();
  if (action === 'broker-logout') {
    if (state.busy) return;
    await api('/api/guru/logout', {}); state.epoch++; startLiveFeed(); state.guruAccount = null; state.guruBalance = null; state.guruDeals = []; state.sessionOrders = [];
    $('modal').close(); await loadGuruAccount(); return navigate(state.page);
  }
  if (action === 'retry-feed') return refreshFeed();
  const id = event.target.closest('button[id]')?.id;
  if (id === 'broker-login-button') return brokerAuth();
  if (id === 'review-order') {
    if (confirm('Have you checked GuruTrade trade history for the unconfirmed order? Clearing this notice does not cancel or repeat it.')) {
      state.unresolvedOrder = null; try { sessionStorage.removeItem('unconfirmed-order'); } catch {} updateTrading();
    }
    return;
  }
  if (id === 'modal-close') return $('modal').close();
  if (id === 'account-button') { if (!state.busy) openModal('<h1>Select account</h1><div class="auth-links"><button class="button" data-account-type="demo">GuruTrade demo</button><button class="button" data-account-type="real">GuruTrade real</button></div>'); return; }
  if (id === 'notifications-button') return navigate('history');
  if (id === 'all-history-button') return navigate('history');
  if (id === 'theme-button') { const theme = document.body.classList.contains('light') ? 'dark' : 'light'; document.body.classList.toggle('light', theme === 'light'); try { localStorage.setItem('terminal-theme', theme); } catch {} drawChart(); return; }
  if (id === 'chart-reset') { state.zoom = 100; drawChart(); return; }
  if (id === 'chart-zoom-in' || id === 'chart-zoom-out') { zoom(id === 'chart-zoom-in' ? -12 : 12); return; }
  if ((id === 'amount-minus' || id === 'amount-plus') && !state.busy) { const min = Number($('amount').min) || 1; $('amount').value = String(Math.max(min, Math.min(Number($('amount').max) || 100000, (Number($('amount').value) || min) + (id === 'amount-plus' ? 10 : -10)))); renderQuote(); return; }
  if (id === 'open-trades-tab' || id === 'recent-trades-tab') { state.positionTab = id === 'open-trades-tab' ? 'open' : 'recent'; renderPositions(); return; }
  if (id === 'trade-up' || id === 'trade-down') return placeTrade(id === 'trade-up' ? 'up' : 'down');
}
async function loadGuruAccount() {
  const epoch = state.epoch, type = state.accountType;
  try {
    const status = await api('/api/guru/status');
    if (epoch !== state.epoch) return;
    state.guruAccount = status;
    const demo = type !== 'real' ? 1 : 0;
    const [deals, balance, history] = await Promise.allSettled([api(`/api/guru/deals?demo=${demo}`), api(`/api/guru/balance?demo=${demo}`), api(`/api/guru/orders?demo=${demo}`)]);
    if (epoch !== state.epoch) return;
    state.guruError = deals.status === 'rejected' ? deals.reason.message : '';
    state.guruDeals = deals.status === 'fulfilled' ? deals.value.deals : [];
    state.guruBalance = balance.status === 'fulfilled' ? type === 'real' ? balance.value.real : balance.value.demo : null;
    state.guruCurrency = balance.status === 'fulfilled' ? balance.value.currency : null;
    state.guruBalances = balance.status === 'fulfilled' ? balance.value : null;
    state.balanceError = balance.status === 'rejected' ? balance.reason.message : '';
    state.sessionOrders = history.status === 'fulfilled' ? history.value.orders : [];
    if ([deals, balance].some(r => r.status === 'rejected' && r.reason.status === 401)) state.guruAccount = { ...status, loggedIn: false, orderExecution: false, accountNumber: null };
    renderAccount();
  } catch (error) {
    if (epoch !== state.epoch) return;
    state.guruAccount = null; state.guruBalance = null; state.guruBalances = null; state.guruDeals = []; state.sessionOrders = []; state.guruError = error.message; state.balanceError = error.message; renderAccount();
  }
}
async function placeTrade(direction) {
  updateTrading();
  if (state.busy || $(direction === 'up' ? 'trade-up' : 'trade-down').disabled) return;
  const market = selectedMarket();
  if (!market || !$('amount').reportValidity()) return;
  const real = state.accountType === 'real', buySell = direction === 'up' ? 1 : -1, amount = $('amount').value;
  if (real && !confirm(`Place a REAL ${direction === 'up' ? 'Higher' : 'Lower'} order on ${market.name || market.symbol} for ${guruMoney(Number(amount))}, expiry ${$('duration').selectedOptions[0]?.textContent || 'broker default'}?`)) return;
  const requestId = crypto.randomUUID();
  state.busy = true;
  state.unresolvedOrder = { requestId, symbol: state.symbol, real, amount, direction, at: Date.now() };
  try { sessionStorage.setItem('unconfirmed-order', JSON.stringify(state.unresolvedOrder)); } catch {}
  updateTrading();
  try {
    const duration = $('duration').value ? Number($('duration').value) : undefined;
    const result = await api('/api/guru/trade', { symbol: state.symbol, buySell, amount, oneClick: state.flash ? 1 : 0, real, requestId, duration });
    state.unresolvedOrder = null; try { sessionStorage.removeItem('unconfirmed-order'); } catch {}
    toast(`${real ? 'Real' : 'Demo'} ${direction === 'up' ? 'Higher ↑' : 'Lower ↓'} confirmed · #${result.positionId}.`);
  } catch (error) {
    if (!['NETWORK_ERROR', 'GURU_ORDER_UNKNOWN'].includes(error.code)) { state.unresolvedOrder = null; try { sessionStorage.removeItem('unconfirmed-order'); } catch {} }
    toast(['NETWORK_ERROR', 'GURU_ORDER_UNKNOWN'].includes(error.code) ? 'Order is unconfirmed. Check GuruTrade history before placing another.' : error.message, true);
  } finally { state.busy = false; updateTrading(); }
  await loadGuruAccount();
}
function zoom(delta) { state.zoom = Math.max(15, Math.min(100, state.zoom + delta)); drawChart(); }
$('source-select').addEventListener('change', event => { switchSource(event.target.value).catch(error => toast(error.message, true)); });
$('chart-type').addEventListener('change', event => { state.chartType = event.target.value; drawChart(); });
$('market-search').addEventListener('input', event => { state.query = event.target.value; renderMarkets(); });
$('amount').addEventListener('input', renderQuote);
$('duration').addEventListener('change', renderQuote);
document.addEventListener('input', event => { if (event.target.id === 'asset-modal-search') renderAssetModal(event.target.value); });
$('chart').addEventListener('mousemove', event => { const rect = $('chart').getBoundingClientRect(); state.pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top }; drawChart(); });
$('chart').addEventListener('mouseleave', () => { state.pointer = null; drawChart(); });
$('chart').addEventListener('wheel', event => { if (event.ctrlKey) return; event.preventDefault(); zoom(event.deltaY > 0 ? 8 : -8); }, { passive: false });
$('chart').addEventListener('keydown', event => { if (['+', '=', '-', '_'].includes(event.key)) { event.preventDefault(); zoom(['+', '='].includes(event.key) ? -8 : 8); } });
document.addEventListener('keydown', event => { const market = event.target.closest('.market-row'); if (market && event.target === market && ['Enter', ' '].includes(event.key)) { event.preventDefault(); selectSymbol(market.dataset.symbol).catch(error => toast(error.message, true)); } });
new ResizeObserver(drawChart).observe($('chart').parentElement);

let pageSequence = 0;
function pageHeader(title, description, action = '') { return `<div class="page-header"><div><h1>${title}</h1><p>${description}</p></div>${action}</div>`; }
async function navigate(page = 'terminal') {
  const sequence = ++pageSequence;
  state.page = page;
  $('terminal').classList.toggle('hidden', page !== 'terminal'); $('secondary').classList.toggle('hidden', page === 'terminal');
  document.querySelectorAll('[data-page]').forEach(button => button.classList.toggle('active', button.dataset.page === page));
  if (page === 'terminal') { requestAnimationFrame(drawChart); return; }
  $('secondary').innerHTML = empty('Loading account data…');
  if (['history', 'wallet', 'profile'].includes(page)) await loadGuruAccount();
  if (sequence !== pageSequence) return;
  if (page === 'history') {
    $('secondary').innerHTML = pageHeader('GuruTrade orders', 'Open positions come from the broker. Recorded submissions are this app’s order journal; settlement results are not supplied by this connection.') + `<div class="surface"><h2>Open positions · ${escape(state.accountType)}</h2>${state.guruError ? empty('Cannot load broker trades', state.guruError) : guruDealsTable(state.guruDeals)}</div><div class="surface"><h2>Recorded submissions</h2>${sessionOrdersTable()}</div>`;
  } else if (page === 'wallet') {
    const b = state.guruBalances;
    $('secondary').innerHTML = pageHeader('GuruTrade balances', 'Balances returned by the connected broker account.') + `<div class="stat-grid"><div class="stat-card"><span>Real balance</span><strong data-wallet-balance="real">${guruMoney(b?.real)}</strong></div><div class="stat-card"><span>Demo balance</span><strong data-wallet-balance="demo">${guruMoney(b?.demo)}</strong></div><div class="stat-card"><span>Bonus</span><strong data-wallet-balance="bonus">${guruMoney(b?.bonus)}</strong></div></div><div class="surface"><p id="balance-feed-error">${escape(state.balanceError || 'Balances refresh from GuruTrade. Deposits and withdrawals are handled on the official broker website.')}</p><a class="button" href="https://www.gurutrade7.com/" target="_blank" rel="noopener noreferrer">Open GuruTrade</a></div>`;
  } else if (page === 'profile') {
    $('secondary').innerHTML = pageHeader('GuruTrade account', 'This terminal uses your broker account directly.') + `<div class="surface"><h2>${state.guruAccount?.loggedIn ? escape(state.guruAccount.accountNumber) : 'Account not connected'}</h2><p>${state.guruAccount?.loggedIn ? 'Connected for this server session.' : 'Connect your GuruTrade account to view your real balance and positions.'}</p><p>Real order access: ${state.guruAccount?.realOrdersEnabled ? 'enabled' : 'disabled on this server'}.</p><button class="button primary" data-action="broker-login">${state.guruAccount?.loggedIn ? 'Manage connection' : 'Connect GuruTrade'}</button></div>`;
  } else if (page === 'support') {
    $('secondary').innerHTML = pageHeader('Support', 'Account recovery, payments and identity verification are managed by GuruTrade.') + '<div class="surface"><p>Use the official broker website for support and password recovery.</p><a class="button" href="https://www.gurutrade7.com/" target="_blank" rel="noopener noreferrer">Open GuruTrade</a></div>';
  } else {
    $('secondary').innerHTML = pageHeader('Terminal help', 'GuruTrade account access and market data.') + '<div class="surface"><h2>Orders</h2><p>Higher predicts a rise; Lower predicts a fall. These are fixed-time broker predictions. Demo uses the GuruTrade virtual balance. Real mode uses real funds when enabled on this server. The broker determines expiry. Confirmed submissions appear in the order journal; settlement history is unavailable through this connection.</p><h2>Market data</h2><p>Charts are derived from observed broker ticks. Older minute samples are shown as a line when dense data is unavailable. Volume is unavailable. Higher and Lower do not buy stock option contracts.</p><h2>AI data endpoint</h2><p><a href="/data.html">GET /v1/data</a> reads real NIFTY/BANKNIFTY bars.csv candles independently. GuruTrade OTC products are not renamed to these indices.</p></div>';
  }
  icons($('secondary'));
}
document.addEventListener('submit', event => {
  const form = event.target;
  if (form.id !== 'broker-auth-form') return;
  event.preventDefault();
  if (form.dataset.busy === 'true') return;
  const body = Object.fromEntries(new FormData(form));
  form.dataset.busy = 'true';
  const controls = [...form.elements]; controls.forEach(c => { c.disabled = true; });
  const errorNode = form.querySelector('.form-error'); errorNode.textContent = '';
  (async () => {
    await api('/api/guru/login', body);
    form.reset(); $('modal').close(); state.epoch++; startLiveFeed(); state.quoteAt = 0; state.guruBalance = null;
    await Promise.all([loadGuruAccount(), loadQuote()]);
    if (state.page !== 'terminal') await navigate(state.page);
    toast('GuruTrade account connected.');
  })().catch(error => { if (errorNode.isConnected) errorNode.textContent = error.message; else toast(error.message, true); }).finally(() => { form.dataset.busy = 'false'; controls.forEach(c => { c.disabled = false; }); });
});
async function boot() {
  try { document.body.classList.toggle('light', localStorage.getItem('terminal-theme') === 'light'); } catch {}
  $('header-source').textContent = 'GuruTrade · Demo';
  renderAccount(); renderMarkets(true); drawChart();
  loadGuruAccount();
  await refreshFeed();
}
setInterval(() => {
  const now = Date.now() + state.offset;
  $('server-clock').textContent = clock(now); $('footer-time').textContent = clock(now);
  updateTrading();
  renderPositions();
}, 1000);
let privateRefresh = false, fallbackRefresh = false;
setInterval(async () => {
  if (document.hidden) return;
  startLiveFeed();
  if (Date.now() - state.lastCatalogue >= 30000 || !state.markets.length) await refreshFeed();
  else if (Date.now() - state.lastPushAt > 5000 && !fallbackRefresh) {
    fallbackRefresh = true;
    try { await Promise.all([loadCandles(), loadQuote()]); } finally { fallbackRefresh = false; }
  }
}, 2500);
setInterval(async () => {
  if (document.hidden || privateRefresh) return;
  privateRefresh = true;
  try { await loadGuruAccount(); } finally { privateRefresh = false; }
}, 5000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopLiveFeed(); else { startLiveFeed(); refreshFeed(); }
});
window.addEventListener('pagehide', stopLiveFeed);
boot().catch(error => toast(error.message, true));
