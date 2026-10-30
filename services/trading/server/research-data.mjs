import {loadMarket} from './providers.mjs';
import {readRecord,putRecord} from './research.mjs';
// Dedicated adjusted research history never replaces raw execution/quote data.
// Rebuild once a day so new splits cannot create mixed adjustment factors.
export async function refreshResearchData(env,assetId=null,fetcher=fetch){
  if(!env.ALPACA_API_KEY||!env.ALPACA_SECRET_KEY)return [];
  const assets=(await env.DB.prepare("SELECT * FROM assets WHERE source='alpaca'"+(assetId?' AND id=?':'')).bind(...(assetId?[assetId]:[])).all()).results,report=[];
  if(!assets.some(a=>a.id==='us:SPY'))assets.push({id:'us:SPY',symbol:'SPY',market:'us',source:'alpaca'});
  const lease=crypto.randomUUID();const lock=await env.DB.prepare("INSERT INTO service_state(key,value) VALUES('research_data_lock',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(json_extract(service_state.value,'$.until') AS INTEGER)<?").bind(JSON.stringify({lease,until:Date.now()+300000}),Date.now()).run();
  if(lock.meta.changes!==1)return [{status:'busy'}];
  try{for(const asset of assets){const key='research_market:'+asset.id,old=await readRecord(env.DB,key);if(old&&Date.now()-Date.parse(old.updated)<86400000){report.push({symbol:asset.symbol,status:'cached',bars:old.bars.length});continue;}
    try{const bars=await loadMarket({...asset,research:true,since:null},env,fetcher);await putRecord(env.DB,key,{source:'alpaca',feed:'iex',adjustment:'split',updated:new Date().toISOString(),bars});report.push({symbol:asset.symbol,status:'ready',bars:bars.length});}
    catch(e){report.push({symbol:asset.symbol,status:'error',message:e.status?e.message:'研究历史更新失败，保留旧数据'});}
  }}finally{await env.DB.prepare("DELETE FROM service_state WHERE key='research_data_lock' AND json_extract(value,'$.lease')=?").bind(lease).run();}return report;
}
