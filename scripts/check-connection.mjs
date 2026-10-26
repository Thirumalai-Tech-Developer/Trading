import { readFile } from 'node:fs/promises';
import { createGuruBackend } from '../guru-backend.mjs';
import { chartView } from '../public/chart-data.mjs';

const guru = createGuruBackend({ allowReal: false });
const report = {};
async function check(name, action) {
  try { report[name] = await action(); }
  catch (error) { report[name] = { error: error.code || 'CHECK_FAILED' }; process.exitCode = 1; }
}
try {
  let credentials = '';
  if (process.env.GURU_AUTO_LOGIN !== '0') {
    try { credentials = await readFile(new URL('../.cred', import.meta.url), 'utf8'); } catch {}
  }
  const field = key => credentials.match(new RegExp(`${key}="([^"]*)"`))?.[1];
  if (field('mail') && field('pass')) {
    await check('login', async () => { await guru.login({ accountNumber: field('mail'), passWord: field('pass') }); return { loggedIn: guru.status().loggedIn }; });
  }
  credentials = '';
  let symbol;
  await check('markets', async () => {
    const { markets } = await guru.getMarkets();
    symbol = markets.find(m => m.tradable)?.symbol;
    return { count: markets.length, tradable: markets.filter(m => m.tradable).length };
  });
  await check('balance', async () => {
    const b = await guru.getBalance({ demo: !guru.status().loggedIn });
    return { demoAvailable: Number.isFinite(b.demo), realAvailable: Number.isFinite(b.real) };
  });
  await check('positions', async () => ({ readable: Array.isArray((await guru.getActiveDeals({ demo: true })).deals) }));
  if (guru.status().loggedIn) await check('realPositions', async () => ({ readable: Array.isArray((await guru.getActiveDeals()).deals) }));
  if (symbol) {
    await check('quote', async () => ({ fresh: !(await guru.getQuote({ symbol })).stale }));
    await check('chart', async () => {
      const result = await guru.getCandles({ symbol, interval: 60 });
      const view = chartView(result), samples = view.points.length ? view.points : view.candles;
      report.historyError = result.collectorError;
      return { displayedSamples: samples.length, completedCandles: result.candles.length, historyComplete: result.historyComplete, windowMinutes: (view.end - view.start) / 60, observedSpanMinutes: samples.length ? Number(((samples.at(-1).time - samples[0].time) / 60).toFixed(2)) : 0, representation: view.points.length ? 'price_samples' : 'derived_candles', nativeOhlc: result.provenance.nativeOhlc, volumeAvailable: result.volumeAvailable };
    });
  }
  report.ordersSubmitted = 0;
  console.log(JSON.stringify(report, null, 2));
} finally { guru.close(); }
