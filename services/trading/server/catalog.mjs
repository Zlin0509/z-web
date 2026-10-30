import {Problem} from './engine.mjs';
import {remote} from './connections.mjs';
const META='stock_catalog',PREFIX='stock_catalog_chunk:';
export async function catalogRows(db){const rows=(await db.prepare("SELECT value FROM service_state WHERE key LIKE 'stock_catalog_chunk:%' ORDER BY key").all()).results;return rows.flatMap(r=>JSON.parse(r.value));}
export async function refreshCatalog(env,fetcher=fetch){
  const cached=await env.DB.prepare('SELECT value FROM service_state WHERE key=?').bind(META).first();const meta=cached?JSON.parse(cached.value):null;
  if(meta&&Date.now()-Date.parse(meta.updated)<86400000)return meta;
  if(!env.ALPACA_API_KEY||!env.ALPACA_SECRET_KEY)return {...meta,error:'请先配置 Alpaca 密钥以同步美股目录。'};
  const lease=crypto.randomUUID(),lock=await env.DB.prepare("INSERT INTO service_state(key,value) VALUES('catalog_lock',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(json_extract(service_state.value,'$.until') AS INTEGER)<?").bind(JSON.stringify({lease,until:Date.now()+300000}),Date.now()).run();
  if(lock.meta.changes!==1)return {...meta,error:'目录正在更新，请稍后再试。'};
  try{
    const r=await remote('https://paper-api.alpaca.markets/v2/assets?status=active&asset_class=us_equity',{headers:{'APCA-API-KEY-ID':env.ALPACA_API_KEY,'APCA-API-SECRET-KEY':env.ALPACA_SECRET_KEY}},fetcher),data=await r.json();
    if(!Array.isArray(data))throw new Problem(502,'美股目录返回格式无效。');
    const assets=[...new Map(data.filter(a=>a.status==='active'&&a.class==='us_equity'&&typeof a.symbol==='string'&&typeof a.name==='string'&&a.name.trim()).map(a=>[a.symbol,{symbol:a.symbol,name:a.name,exchange:String(a.exchange||''),tradable:a.tradable===true}])).values()].sort((a,b)=>a.symbol.localeCompare(b.symbol));
    if(!assets.length)throw new Problem(502,'美股目录为空，已保留旧目录。');
    const next={updated:new Date().toISOString(),count:assets.length,source:'Alpaca · 活跃美股目录'};
    const commands=[env.DB.prepare("DELETE FROM service_state WHERE key LIKE 'stock_catalog_chunk:%'")];
    for(let i=0;i<assets.length;i+=500)commands.push(env.DB.prepare('INSERT INTO service_state(key,value) VALUES(?,?)').bind(PREFIX+String(i/500).padStart(4,'0'),JSON.stringify(assets.slice(i,i+500))));
    commands.push(env.DB.prepare('INSERT INTO service_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(META,JSON.stringify(next)));
    const watched=(await env.DB.prepare("SELECT id,symbol FROM assets WHERE market='us'").all()).results;
    for(const a of watched){const found=assets.find(s=>s.symbol===a.symbol);if(found)commands.push(env.DB.prepare('INSERT INTO service_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind('asset_meta:'+a.id,JSON.stringify(found)));}
    await env.DB.batch(commands);return next;
  }catch(e){return {...meta,error:e instanceof Problem?e.message:'目录更新失败，保留旧目录。'};}
  finally{await env.DB.prepare("UPDATE service_state SET value=? WHERE key='catalog_lock' AND json_extract(value,'$.lease')=?").bind(JSON.stringify({lease,until:Date.now()+300000}),lease).run();}
}
export async function searchStocks(db,query,offset=0){
  const q=String(query||'').trim().toLocaleLowerCase();if(q.length>80||!Number.isInteger(offset)||offset<0)throw new Problem(400,'搜索参数无效。');
  const saved=await db.prepare('SELECT value FROM service_state WHERE key=?').bind(META).first();if(!saved)throw new Problem(424,'美股目录尚未入库，请点击「更新行情入库」或等待后台同步。');
  const meta=JSON.parse(saved.value),tokens=q.split(/\s+/).filter(Boolean),rank=a=>a.symbol.toLowerCase()===q?0:a.symbol.toLowerCase().startsWith(q)?1:2;
  const all=(await catalogRows(db)).filter(a=>tokens.every(t=>(a.symbol+' '+a.name).toLowerCase().includes(t))).sort((a,b)=>rank(a)-rank(b)||a.symbol.localeCompare(b.symbol));
  const watched=new Set((await db.prepare("SELECT symbol FROM assets WHERE market='us'").all()).results.map(a=>a.symbol));
  return {items:all.slice(offset,offset+50).map(a=>({...a,added:watched.has(a.symbol)})),total:all.length,offset,nextOffset:offset+50<all.length?offset+50:null,...meta};
}
export async function rememberStock(db,symbol){const found=(await catalogRows(db)).find(a=>a.symbol===symbol);if(found)await db.prepare('INSERT INTO service_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind('asset_meta:us:'+symbol,JSON.stringify(found));}
