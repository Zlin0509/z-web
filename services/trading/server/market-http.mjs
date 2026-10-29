import {Problem} from './engine.mjs';

function provider(url) {
  const u=new URL(url);
  if(u.hostname==='www.okx.com'&&u.pathname.startsWith('/api/v5/market/'))return 'OKX';
  if(u.hostname==='www.alphavantage.co')return 'Alpha Vantage';
  if(u.hostname==='data.alpaca.markets')return 'Alpaca';
  return null;
}
function limited(name,until) {
  const e=new Problem(429,`${name} 行情请求已限流；已保留上次成功数据。${new Date(until).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}（北京时间）后可重试，冷却期间重复点击不会再请求数据源。`);
  e.retryAt=until;return e;
}
// Shared across worker instances and tabs; never retry orders or analysis here.
export async function marketFetch(url,options={},env={},fetcher=fetch) {
  const name=provider(url),db=env.DB,key='market_limit:'+name;
  const row=name&&db?await db.prepare('SELECT value FROM service_state WHERE key=?').bind(key).first():null;
  const previous=row?JSON.parse(row.value):{};
  if(previous.until>Date.now())throw limited(name,previous.until);
  const response=await fetcher.call(globalThis,String(url),options);
  if(!name)return response;
  let data;try{data=await response.clone().json();}catch{}
  const bodyLimited=(name==='OKX'&&String(data?.code)==='50011')||(name==='Alpha Vantage'&&!!(data?.Note||data?.Information)&&/limit|frequency|rate/i.test(data.Note||data.Information));
  if(response.status===429||bodyLimited) {
    const failures=Math.min((previous.failures||0)+1,5),retry=response.headers.get('retry-after');
    const delay=retry===null?0:/^\d+(\.\d+)?$/.test(retry)?Number(retry)*1000:Math.max(0,Date.parse(retry)-Date.now())||0;
    const until=Date.now()+Math.max(delay,Math.min(900000,60000*2**(failures-1)));
    if(db)await db.prepare('INSERT INTO service_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key,JSON.stringify({until,failures})).run();
    console.warn('Market rate limited',name,'retryAt',new Date(until).toISOString());
    throw limited(name,until);
  }
  if(response.ok&&row&&db)await db.prepare('DELETE FROM service_state WHERE key=? AND value=?').bind(key,row.value).run();
  return response;
}
