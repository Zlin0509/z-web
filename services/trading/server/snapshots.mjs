import {Problem} from './engine.mjs';
import {quotes,configured} from './connections.mjs';
import {refresh} from './service.mjs';
const enc=new TextEncoder();
export async function authorizeSync(request,env){
  const ts=request.headers.get('x-sync-time'),signature=request.headers.get('x-sync-signature');
  if(request.headers.has('origin')||!env.TRADING_SYNC_SECRET||!/^\d{13}$/.test(ts||'')||Math.abs(Date.now()-Number(ts))>300000||!/^([a-f0-9]{2}){32}$/.test(signature||''))throw new Problem(401,'定时同步签名无效或已过期。');
  const key=await crypto.subtle.importKey('raw',enc.encode(env.TRADING_SYNC_SECRET),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  const bytes=Uint8Array.from(signature.match(/../g),x=>parseInt(x,16));
  if(!await crypto.subtle.verify('HMAC',key,bytes,enc.encode(`${ts}\n${request.method}\n${new URL(request.url).pathname}`)))throw new Problem(401,'定时同步签名无效或已过期。');
}
export async function readQuotes(env){
  const row=await env.DB.prepare("SELECT value FROM service_state WHERE key='quotes_cache'").first();
  const snapshot=row?JSON.parse(row.value):null;
  const assets=(await env.DB.prepare('SELECT symbol,market FROM assets ORDER BY market,symbol').all()).results;
  return {quotes:assets.map(a=>snapshot?.data.quotes.find(q=>q.symbol===a.symbol)||{symbol:a.symbol,error:'等待后台首次同步',source:a.market==='crypto'?'OKX':'Alpaca IEX'}),fetchedAt:snapshot?.data.fetchedAt||null,mode:'数据库快照 · 后台每5分钟更新'};
}
export async function refreshQuotes(env){
  const previous=await readQuotes(env);
  if(previous.fetchedAt&&Date.now()-Date.parse(previous.fetchedAt)<290000)return previous;
  const lease=crypto.randomUUID();const lock=await env.DB.prepare("INSERT INTO service_state(key,value) VALUES('quote_sync_lock',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(json_extract(service_state.value,'$.until') AS INTEGER)<?").bind(JSON.stringify({lease,until:Date.now()+60000}),Date.now()).run();
  if(lock.meta.changes!==1)return previous;
  try{
    const next=await quotes(env,true);
    next.quotes=next.quotes.map(q=>q.error?{...previous.quotes.find(p=>p.symbol===q.symbol),...q}:q);
    await env.DB.prepare("INSERT INTO service_state(key,value) VALUES('quotes_cache',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify({time:Date.now(),data:next})).run();return next;
  }finally{await env.DB.prepare("DELETE FROM service_state WHERE key='quote_sync_lock' AND json_extract(value,'$.lease')=?").bind(lease).run();}
}
export async function syncMarket(env,id=null){
  const settings=await configured(env);
  const report=await refresh(env.DB,settings,id);
  const snapshot=await refreshQuotes(settings);
  const result={...report,quotesUpdated:snapshot.fetchedAt,quoteErrors:snapshot.quotes.filter(q=>q.error).map(q=>({symbol:q.symbol,error:q.error}))};
  await env.DB.prepare("INSERT INTO service_state(key,value) VALUES('sync_status',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify(result)).run();return result;
}
