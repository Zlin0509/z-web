import {Problem} from './engine.mjs';
import {loadIntraday} from './providers.mjs';
import {seriesKey, readSeries} from './series.mjs';
import {MINUTE15} from './timeframes.mjs';
import {advancePaper, archiveBars} from './service.mjs';

export async function prepareIntraday(env, id, fetcher = fetch) {
  if (typeof id !== 'string' || id.length > 80) throw new Problem(400, '请选择标的。');
  const asset = await env.DB.prepare('SELECT * FROM assets WHERE id=?').bind(id).first();
  if (!asset) throw new Problem(404, '标的不存在。');
  if (asset.market === 'us' && (!env.ALPACA_API_KEY || !env.ALPACA_SECRET_KEY)) {
    throw new Problem(424, '美股15分钟行情需要 Alpaca Key/Secret。');
  }
  const initial = {
    assetId: id, timeframe: '15m', generation: crypto.randomUUID(), revision: 0,
    source: asset.market === 'crypto' ? 'okx' : 'alpaca', bars: [], status: 'empty'
  };
  await env.DB.prepare('INSERT OR IGNORE INTO service_state(key,value) SELECT ?,? WHERE EXISTS(SELECT 1 FROM assets WHERE id=?)')
    .bind(seriesKey(id), JSON.stringify(initial), id).run();
  return {...await syncOne(env, asset, fetcher), timeframe: '15m'};
}

async function syncOne(env, asset, fetcher) {
  const db = env.DB, key = seriesKey(asset.id);
  const lockKey = 'intraday_lock:' + asset.id, lease = crypto.randomUUID();
  const locked = await db.prepare(`INSERT INTO service_state(key,value) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
    WHERE json_extract(service_state.value,'$.until')<?`)
    .bind(lockKey, JSON.stringify({lease, until: Date.now() + 180000}), Date.now()).run();
  if (locked.meta.changes !== 1) return {assetId: asset.id, status: 'busy'};
  try {
    const old = await readSeries(db, asset.id);
    if (!old) return {assetId: asset.id, status: 'removed'};
    // Allow providers 30 seconds to finalize a bar.
    const slot = Math.floor((Date.now() - 30000) / MINUTE15) * MINUTE15;
    if (old.checkedSlot === slot) {
      await advancePaper(db, {...asset, timeframe: '15m'}, old.bars);
      return {assetId: asset.id, status: 'cached', bars: old.bars.length, asOf: old.bars.at(-1)?.time};
    }
    try {
      const incoming = await loadIntraday({...asset, cutoff: slot, since: old.bars.at(-1)?.time}, env, fetcher);
      const bars = [...new Map([...old.bars, ...incoming].map(bar => [bar.time, bar])).values()]
        .sort((a, b) => a.time - b.time).slice(-2000);
      if (!bars.length) throw new Problem(404, '数据源尚无已完成的15分钟K线。');
      const next = {
        ...old, bars, revision: old.revision + 1, checkedSlot: slot,
        updated: new Date().toISOString(), status: 'ready', message: null
      };
      // Archive first so a partial failure retries before marking the slot complete.
      await archiveBars(db, asset.id, old.source, incoming, '15m');
      const result = await db.prepare(`UPDATE service_state SET value=? WHERE key=?
        AND json_extract(value,'$.generation')=? AND EXISTS(SELECT 1 FROM assets WHERE id=?)`)
        .bind(JSON.stringify(next), key, old.generation, asset.id).run();
      if (result.meta.changes !== 1) return {assetId: asset.id, status: 'conflict'};
      await advancePaper(db, {...asset, timeframe: '15m'}, bars);
      return {assetId: asset.id, status: 'ready', bars: bars.length, asOf: bars.at(-1).time};
    } catch (error) {
      const message = error instanceof Problem ? error.message : '15分钟数据更新失败，已保留旧数据。';
      // Retry next scheduler tick, subject to provider-wide rate limiting.
      await db.prepare(`UPDATE service_state SET value=json_set(value,'$.status','error','$.message',?)
        WHERE key=? AND json_extract(value,'$.generation')=?`)
        .bind(message, key, old.generation).run();
      return {assetId: asset.id, status: 'error', message};
    }
  } finally {
    await db.prepare("DELETE FROM service_state WHERE key=? AND json_extract(value,'$.lease')=?")
      .bind(lockKey, lease).run();
  }
}

export async function refreshIntraday(env, id = null, fetcher = fetch) {
  const rows = (await env.DB.prepare(`SELECT a.* FROM assets a
    JOIN service_state s ON s.key='market_series:15m:'||a.id
    WHERE (? IS NULL OR a.id=?) ORDER BY a.id`).bind(id, id).all()).results;
  const report = [];
  for (const asset of rows) report.push(await syncOne(env, asset, fetcher));
  return report;
}
