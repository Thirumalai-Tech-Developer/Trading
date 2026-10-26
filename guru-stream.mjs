import { constants, publicEncrypt } from 'node:crypto';

const PUBLIC_KEY = 'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDAPiGuCkoS3OSTTaWHvMLmK7coaKVNW9nGcx8xwy1CBDEEkIGzGZSlEPpNJ8D2g7SA+FWkifcwRqqjIXVp4H8aJvLqlXo6HJZzyqE2ueX9qpr0v8zT24pQbVR0T7EoRUazK82qIg7FOq1dEqnvc9yqHN61eye0QTLxMFuXXlBKoQIDAQAB';
function signSession(session) {
  return publicEncrypt({ key: `-----BEGIN PUBLIC KEY-----\n${PUBLIC_KEY}\n-----END PUBLIC KEY-----`, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(`token=${session.token}&accountNumber=${session.accountNumber}`)).toString('base64');
}

export function guruSocketUrl(session, deviceId, signer = signSession) {
  const value = v => {
    if (!/^[A-Za-z0-9_.@+-]+$/.test(String(v))) throw new Error('Invalid broker socket identity');
    return String(v);
  };
  // Match the shipped web client: this endpoint expects raw query values, including Base64.
  return `wss://api.guruserv.com/trade/webSocket?isWeb=true&userId=${value(session.userId)}&deviceId=${value(session.deviceId || deviceId)}&accountNumber=${value(session.accountNumber)}&sign=${signer(session)}&appSource=WEB`;
}

export function connectGuruStream({ session, deviceId, symbol, productId, decode, onTicks, onError, now = Date.now, socketFactory = url => new WebSocket(url), timeoutMs = 18000 }) {
  const socket = socketFactory(guruSocketUrl(session, deviceId));
  const cutoff = now() - 3600000;
  let stopped = false, settled = false, complete = false, oldest = Infinity, pages = 0, lastTickAt = 0, lastHeartbeatAt = 0;
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const finish = error => {
    if (error) onError(error);
    if (!settled) { settled = true; clearTimeout(timer); resolveReady(); }
  };
  const timer = setTimeout(() => finish('Full tick history request timed out; only received observations are available.'), timeoutMs);
  timer.unref?.();
  const send = (businessType, data, mark) => {
    if (socket.readyState === 1) socket.send(JSON.stringify({ userId: session.userId, accountNumber: session.accountNumber, businessType, ...(data ? { data } : {}), mark }));
  };
  function heartbeat() {
    if (stopped || socket.readyState !== 1 || now() - lastHeartbeatAt < 10000) return;
    lastHeartbeatAt = now(); send('HEARTBEAT', null, '55555555');
  }
  socket.addEventListener('open', () => {
    if (stopped) return;
    heartbeat();
    send('PRODUCT_CHOOSE', { symbol, interval: 3 }, '1111111110');
    send('QUOTATION_LIST', { symbol }, '111111111');
  });
  socket.addEventListener('message', event => {
    if (stopped) return;
    try {
      if (typeof event.data !== 'string' || event.data.length > 4 * 1024 * 1024) throw new Error('Oversized tick response');
      const message = JSON.parse(event.data);
      if (message.businessType === 'LOGIN_FAIL') { finish('Broker rejected the tick stream login.'); close(); return; }
      if (!['QUOTATION', 'QUOTATION_LIST', 'QUOTATION_HIS'].includes(message.businessType)) return;
      const data = typeof message.data === 'string' ? decode(message.data) : message.data;
      if (data?.symbol && data.symbol !== symbol) return;
      const rows = Array.isArray(data?.quotationList) ? data.quotationList : message.businessType === 'QUOTATION' && data?.ct !== undefined ? [data] : [];
      const ticks = onTicks(rows, { live: message.businessType === 'QUOTATION', receivedAt: now() });
      if (ticks.length) lastTickAt = now();
      if (message.businessType === 'QUOTATION' || settled) return;
      const first = ticks[0]?.time;
      if (first !== undefined && first <= cutoff) { complete = true; finish(); return; }
      if (first === undefined || first >= oldest || pages >= 24) { finish(); return; }
      oldest = first; pages++;
      send('QUOTATION_HIS', { symbol, productId, interval: 3, startTime: oldest }, '-1');
    } catch { finish('Invalid broker tick stream response.'); close(); }
  });
  socket.addEventListener('error', () => { finish('Tick stream disconnected; REST fallback is active.'); close(); });
  socket.addEventListener('close', () => { if (!stopped) finish('Tick stream closed; REST fallback is active.'); });
  function close() {
    if (stopped) return;
    stopped = true; finish(); socket.close();
  }
  return { ready, heartbeat, close, healthy: () => !stopped && socket.readyState === 1 && now() - lastTickAt < 5000, historyComplete: () => complete };
}
