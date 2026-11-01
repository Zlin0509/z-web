import {Problem} from './engine.mjs';
export const seriesKey = id => 'market_series:15m:' + id;
export async function readSeries(db, id) {
  const row = await db.prepare('SELECT value FROM service_state WHERE key=?').bind(seriesKey(id)).first();
  return row ? JSON.parse(row.value) : null;
}
// Reads never contact providers. Daily and intraday histories have separate identities.
export async function strategyAsset(db, id, timeframe = '1d') {
  if (!['1d', '15m'].includes(timeframe)) throw new Problem(400, '仅支持日线或15分钟周期。');
  const asset = await db.prepare('SELECT * FROM assets WHERE id=?').bind(id).first();
  if (!asset) throw new Problem(404, '标的不存在。');
  if (timeframe === '1d') return {...asset, timeframe};
  const series = await readSeries(db, id);
  if (!series?.bars?.length) throw new Problem(409, '15分钟历史尚未入库，请先点击「准备周期数据」。');
  return {
    ...asset, timeframe, source: series.source, data: JSON.stringify(series.bars),
    updated: series.updated, seriesRevision: series.revision, seriesGeneration: series.generation
  };
}
