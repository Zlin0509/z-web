import {marketFetch} from './market-http.mjs';
import {Problem} from './engine.mjs';
const allowed=['DEEPSEEK_API_KEY','DEEPSEEK_MODEL','ALPACA_API_KEY','ALPACA_SECRET_KEY','SCHWAB_APP_KEY','SCHWAB_APP_SECRET','ALPHA_VANTAGE_API_KEY'];
const enc=new TextEncoder(),dec=new TextDecoder();
const b64=b=>btoa(String.fromCharCode(...b));const un64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
async function key(env){if(!env.CONFIG_ENCRYPTION_KEY)throw new Problem(503,'密钥存储尚未初始化。');return crypto.subtle.importKey('raw',un64(env.CONFIG_ENCRYPTION_KEY),'AES-GCM',false,['encrypt','decrypt']);}
async function encryptedValue(env,name,value){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const data=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:enc.encode(name)},await key(env),enc.encode(JSON.stringify(value)));
  return JSON.stringify({iv:b64(iv),data:b64(new Uint8Array(data))});
}
export async function putSecret(env,name,value){
  await env.DB.prepare('INSERT INTO service_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .bind('secret:'+name,await encryptedValue(env,name,value)).run();
}
async function decrypt(env,name,value,master){const v=JSON.parse(value);return JSON.parse(dec.decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:un64(v.iv),additionalData:enc.encode(name)},master||await key(env),un64(v.data))));}
export async function getSecret(env,name){const row=await env.DB.prepare('SELECT value FROM service_state WHERE key=?').bind('secret:'+name).first();return row?decrypt(env,name,row.value):null;}
export async function configured(env){
  const rows=(await env.DB.prepare(`SELECT key,value FROM service_state WHERE key IN (${allowed.map(()=>'?').join(',')})`).bind(...allowed.map(n=>'secret:'+n)).all()).results;
  const result={...env},master=rows.length?await key(env):null;
  await Promise.all(rows.map(async row=>{const name=row.key.slice(7);result[name]=await decrypt(env,name,row.value,master);}));return result;
}
export async function settings(env){
  const rows=(await env.DB.prepare("SELECT key,CASE WHEN key IN ('secret:DEEPSEEK_MODEL','schwab_auth_status') THEN value ELSE NULL END AS value FROM service_state WHERE key LIKE 'secret:%' OR key='schwab_auth_status'").all()).results;
  const present=new Set(rows.filter(row=>row.key.startsWith('secret:')).map(row=>row.key.slice(7))),model=rows.find(row=>row.key==='secret:DEEPSEEK_MODEL');
  const authRow=rows.find(row=>row.key==='schwab_auth_status'),auth=authRow?JSON.parse(authRow.value):null;
  return {configured:Object.fromEntries(allowed.map(n=>[n,present.has(n)||!!env[n]])),model:model?await decrypt(env,'DEEPSEEK_MODEL',model.value):env.DEEPSEEK_MODEL||'',schwabConnected:present.has('schwab_tokens')&&auth?.state!=='reauth_required',schwabAuth:auth??{state:present.has('schwab_tokens')?'unverified':'disconnected'},liveTrading:env.SCHWAB_LIVE_TRADING_ENABLED==='true'};
}
export async function saveSettings(env,input){
  if(!input.values||typeof input.values!=='object'||Array.isArray(input.values))throw new Problem(400,'配置格式无效。');
  const entries=Object.entries(input.values);
  for(const [name,value] of entries){
    if(!allowed.includes(name)||typeof value!=='string'||value.length>4096||!value.trim())throw new Problem(400,'配置项或值无效；空白保留原值。');
  }
  const changes=[];
  for(const [name,value] of entries){
    const old=await getSecret(env,name)??env[name];
    if(old!==value.trim())changes.push([name,value.trim()]);
  }
  const statements=[];
  for(const [name,value] of changes)statements.push(env.DB.prepare('INSERT INTO service_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind('secret:'+name,await encryptedValue(env,name,value)));
  if(changes.some(([name])=>name.startsWith('SCHWAB_'))){
    statements.push(env.DB.prepare("INSERT INTO service_state(key,value) VALUES('schwab_generation',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(crypto.randomUUID()));
    statements.push(env.DB.prepare("DELETE FROM service_state WHERE key='secret:schwab_tokens' OR key GLOB 'oauth:*'"));
    statements.push(env.DB.prepare("INSERT INTO service_state(key,value) VALUES('schwab_auth_status',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify({state:'disconnected'})));
  }
  if(statements.length)await env.DB.batch(statements);
  return settings(env);
}
export async function remote(url,options={},fetcher=fetch){let r;try{r=await fetcher(String(url),{...options,redirect:'manual',signal:options.signal??AbortSignal.timeout(12000)});}catch(error){if(error instanceof Problem)throw error;throw new Problem(502,'外部服务连接失败，请稍后重试。');}if(!r.ok){const error=new Problem(r.status===429?429:502,`外部接口返回 HTTP ${r.status}，请检查授权、额度或稍后重试。`);error.upstreamStatus=r.status;throw error;}return r;}
export async function quotes(env,includeCrypto=false){const assets=(await env.DB.prepare('SELECT symbol,market FROM assets ORDER BY market,symbol').all()).results;const result=[];const stocks=assets.filter(a=>a.market==='us');if(stocks.length){try{if(!env.ALPACA_API_KEY||!env.ALPACA_SECRET_KEY)throw new Problem(424,'请在服务接入填写 Alpaca Key ID 和 Secret。');const url=new URL('https://data.alpaca.markets/v2/stocks/quotes/latest');url.search=new URLSearchParams({symbols:stocks.map(x=>x.symbol).join(','),feed:'iex'});const j=await(await remote(url,{headers:{'APCA-API-KEY-ID':env.ALPACA_API_KEY,'APCA-API-SECRET-KEY':env.ALPACA_SECRET_KEY}},(url,options)=>marketFetch(url,options,env))).json();for(const a of stocks){const q=j.quotes?.[a.symbol];result.push({symbol:a.symbol,source:'Alpaca IEX · 单一交易所',bid:q?.bp??null,ask:q?.ap??null,time:q?.t??null,error:q?null:'尚无报价'});}}catch(e){for(const a of stocks)result.push({symbol:a.symbol,error:e.message});}}
const cryptoAssets=assets.filter(a=>a.market==='crypto');
if(includeCrypto&&cryptoAssets.length){try{
  const data=await(await remote('https://www.okx.com/api/v5/market/tickers?instType=SPOT',{},(url,opt)=>marketFetch(url,opt,env))).json();
  if(data.code!=='0'||!Array.isArray(data.data))throw new Problem(502,'OKX 报价格式异常。');
  for(const a of cryptoAssets){const q=data.data.find(q=>q.instId===a.symbol);if(!q||!Number.isFinite(Number(q.last))||!Number.isFinite(Number(q.ts))){result.push({symbol:a.symbol,error:'暂无有效报价'});continue;}result.push({symbol:a.symbol,last:Number(q.last),bid:Number(q.bidPx)||null,ask:Number(q.askPx)||null,time:new Date(Number(q.ts)).toISOString(),source:'OKX · 定时快照',error:null});}
}catch(e){for(const a of cryptoAssets)result.push({symbol:a.symbol,error:e.message});}}
else for(const a of cryptoAssets)result.push({symbol:a.symbol,source:'OKX WebSocket',error:'等待后台报价同步'});
return {quotes:result,fetchedAt:new Date().toISOString(),mode:'数据库快照 · 后台每5分钟更新'};}
const callback=origin=>origin+'/schwab/callback';
export async function deepseekModels(env,fetcher=fetch) {
  if(!env.DEEPSEEK_API_KEY)throw new Problem(424,'请先保存 DeepSeek API Key，再获取可用模型。');
  const response=await remote('https://api.deepseek.com/models',{headers:{Authorization:'Bearer '+env.DEEPSEEK_API_KEY}},fetcher);
  const data=await response.json();
  if(!Array.isArray(data.data))throw new Problem(502,'DeepSeek 返回的模型列表格式无效。');
  const models=[...new Map(data.data.filter(m=>typeof m.id==='string'&&m.id.length>0&&m.id.length<=200).map(m=>[m.id,{id:m.id,name:typeof m.name==='string'?m.name.slice(0,200):m.id}])).values()];
  return {models};
}
const traderOrigin='https://api.schwabapi.com';
const pendingStatuses=['sending','unknown','accepted','cancel_sending','cancel_unknown','cancel_pending'];
async function readState(db,name){const row=await db.prepare('SELECT value FROM service_state WHERE key=?').bind(name).first();return row?JSON.parse(row.value):null;}
async function generation(db){return (await db.prepare("SELECT value FROM service_state WHERE key='schwab_generation'").first())?.value??'legacy';}
async function appHash(env){return b64(new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(JSON.stringify([env.SCHWAB_APP_KEY,env.SCHWAB_APP_SECRET])))));}
async function authLease(env,fn){
  const value=JSON.stringify({owner:crypto.randomUUID(),until:Date.now()+45000});
  const locked=await env.DB.prepare(`INSERT INTO service_state(key,value) VALUES('schwab_refresh_lock',?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
    WHERE COALESCE(json_extract(service_state.value,'$.until'),CAST(service_state.value AS INTEGER))<?`).bind(value,Date.now()).run();
  if(locked.meta.changes!==1)throw new Problem(409,'授权正在更新，请稍后重试。');
  try{return await fn(value);}finally{await env.DB.prepare("DELETE FROM service_state WHERE key='schwab_refresh_lock' AND value=?").bind(value).run();}
}
async function saveTokens(env,tokens,epoch,lease,previous){
  const value=await encryptedValue(env,'schwab_tokens',tokens);
  const status=JSON.stringify({state:'connected',connectionId:tokens.connectionId,authorizedAt:tokens.authorizedAt??null,accessExpiresAt:tokens.expires,reauthorizeAround:tokens.authorizedAt?tokens.authorizedAt+7*86400000:null});
  const result=await env.DB.batch([
    env.DB.prepare(`INSERT INTO service_state(key,value) SELECT 'secret:schwab_tokens',?
      WHERE COALESCE((SELECT value FROM service_state WHERE key='schwab_generation'),'legacy')=?
      AND COALESCE((SELECT value FROM service_state WHERE key='secret:schwab_tokens'),'')=?
      AND EXISTS(SELECT 1 FROM service_state WHERE key='schwab_refresh_lock' AND value=? AND json_extract(value,'$.until')>?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(value,epoch,previous??'',lease,Date.now()),
    env.DB.prepare(`INSERT INTO service_state(key,value) SELECT 'schwab_auth_status',?
      WHERE EXISTS(SELECT 1 FROM service_state WHERE key='secret:schwab_tokens' AND value=?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(status,value)
  ]);
  if(result[0].meta.changes!==1)throw new Problem(409,'授权或应用配置已变化，请重新连接。');
}
function tokenExpiry(tokens,refresh=false){
  if(typeof tokens.access_token!=='string'||!tokens.access_token||!Number.isInteger(tokens.expires_in)||tokens.expires_in<=0||tokens.expires_in>86400||(!refresh&&(typeof tokens.refresh_token!=='string'||!tokens.refresh_token)))throw new Problem(502,'Schwab 授权响应无效，请重新连接。');
  if(tokens.token_type&&String(tokens.token_type).toLowerCase()!=='bearer')throw new Problem(502,'Schwab 令牌类型无效。');
  return Date.now()+tokens.expires_in*1000;
}
async function exchange(env,params){
  if(!env.SCHWAB_APP_KEY||!env.SCHWAB_APP_SECRET)throw new Problem(424,'请先配置 Schwab App Key 和 Secret。');
  const response=await remote(traderOrigin+'/v1/oauth/token',{method:'POST',headers:{Authorization:'Basic '+btoa(env.SCHWAB_APP_KEY+':'+env.SCHWAB_APP_SECRET),'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(params).toString()});
  return response.json();
}
export async function beginOAuth(env,user,origin){
  if(!env.SCHWAB_APP_KEY||!env.SCHWAB_APP_SECRET)throw new Problem(424,'请先保存 Schwab 应用配置。');
  const state=crypto.randomUUID(),redirectUri=callback(origin);
  await env.DB.prepare('INSERT INTO service_state(key,value) VALUES(?,?)').bind('oauth:'+state,JSON.stringify({user:user.userId,expires:Date.now()+600000,redirectUri,generation:await generation(env.DB),appHash:await appHash(env)})).run();
  const url=new URL(traderOrigin+'/v1/oauth/authorize');
  url.search=new URLSearchParams({client_id:env.SCHWAB_APP_KEY,redirect_uri:redirectUri,response_type:'code',state});
  return {url:url.toString()};
}
export async function finishOAuth(env,user,url){
  const state=url.searchParams.get('state'),code=url.searchParams.get('code');
  if(!state||!code||state.length>100||code.length>4096)throw new Problem(400,'授权失败或已取消。');
  const row=await env.DB.prepare('SELECT value FROM service_state WHERE key=?').bind('oauth:'+state).first();
  if(!row)throw new Problem(403,'授权状态无效。');
  const saved=JSON.parse(row.value);
  if(saved.user!==user.userId||saved.expires<Date.now())throw new Problem(403,'授权已过期或账号不匹配。');
  if(saved.redirectUri!==callback(url.origin)||saved.generation!==await generation(env.DB)||saved.appHash!==await appHash(env))throw new Problem(403,'应用配置或回调地址已变化，请重新发起授权。');
  return authLease(env,async lease=>{
    const used=await env.DB.prepare('DELETE FROM service_state WHERE key=? AND value=?').bind('oauth:'+state,row.value).run();
    if(used.meta.changes!==1)throw new Problem(409,'授权已使用。');
    const previous=await env.DB.prepare("SELECT value FROM service_state WHERE key='secret:schwab_tokens'").first();
    const tokens=await exchange(env,{grant_type:'authorization_code',code,redirect_uri:saved.redirectUri});
    const expires=tokenExpiry(tokens);
    await saveTokens(env,{...tokens,expires,authorizedAt:Date.now(),connectionId:crypto.randomUUID(),appHash:saved.appHash},saved.generation,lease,previous?.value);
  });
}
async function requireReauth(env,previous){
  await env.DB.prepare(`INSERT INTO service_state(key,value) SELECT 'schwab_auth_status','{"state":"reauth_required"}'
    WHERE EXISTS(SELECT 1 FROM service_state WHERE key='secret:schwab_tokens' AND value=?)
    ON CONFLICT(key) DO UPDATE SET value=json_set(service_state.value,'$.state','reauth_required')`).bind(previous).run();
  const error=new Problem(401,'Schwab 授权已失效，请重新授权连接。');error.upstreamStatus=401;throw error;
}
async function access(env){
  let tokens=await getSecret(env,'schwab_tokens');
  if(!tokens)throw new Problem(401,'请先连接 Schwab 账户。');
  if(tokens.appHash&&tokens.appHash!==await appHash(env))throw new Problem(401,'Schwab 应用配置已变化，请重新授权。');
  if(tokens.expires>Date.now()+60000&&tokens.access_token)return tokens.access_token;
  return authLease(env,async lease=>{
    const row=await env.DB.prepare("SELECT value FROM service_state WHERE key='secret:schwab_tokens'").first();
    if(!row)throw new Problem(401,'请重新授权 Schwab。');
    tokens=await decrypt(env,'schwab_tokens',row.value);
    if(tokens.expires>Date.now()+60000&&tokens.access_token)return tokens.access_token;
    const epoch=await generation(env.DB);
    if(!tokens.refresh_token)return requireReauth(env,row.value);
    let next;
    try{next=await exchange(env,{grant_type:'refresh_token',refresh_token:tokens.refresh_token});}
    catch(error){if([400,401].includes(error.upstreamStatus))return requireReauth(env,row.value);throw error;}
    const expires=tokenExpiry(next,true);
    if(next.refresh_token!==undefined&&(typeof next.refresh_token!=='string'||!next.refresh_token))throw new Problem(502,'Schwab 刷新令牌响应无效，请重新连接。');
    await saveTokens(env,{...tokens,...next,expires,connectionId:tokens.connectionId??'legacy',appHash:await appHash(env)},epoch,lease,row.value);
    return next.access_token;
  });
}
async function schwab(env,path,method='GET',data,operation){
  let token;
  try{
    token=await access(env);
    if(operation&&(operation.connectionId!==await connectionId(env)||operation.generation!==await generation(env.DB)))throw new Problem(409,'授权已变化，请重新预览。');
  }catch(error){error.beforeSend=true;throw error;}
  try{return await remote(traderOrigin+'/trader/v1'+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});}
  catch(error){
    if(error.upstreamStatus===401){
      const row=await env.DB.prepare("SELECT value FROM service_state WHERE key='secret:schwab_tokens'").first();
      if(row&&(await decrypt(env,'schwab_tokens',row.value)).access_token===token)await requireReauth(env,row.value);
    }
    throw error;
  }
}
export async function accounts(env){return (await schwab(env,'/accounts?fields=positions')).json();}
export async function accountNumbers(env){
  const data=await(await schwab(env,'/accounts/accountNumbers')).json();
  if(!Array.isArray(data)||data.some(a=>typeof a.hashValue!=='string'))throw new Problem(502,'Schwab 账户列表格式无效。');
  return data;
}
async function validateAccount(env,hash){
  if(typeof hash!=='string'||hash.length>128||!/^[a-zA-Z0-9]+$/.test(hash))throw new Problem(400,'账户标识无效。');
  if(!(await accountNumbers(env)).some(a=>a.hashValue===hash))throw new Problem(403,'账户未授权。');
}
export async function orders(env,hash){
  await validateAccount(env,hash);return accountOrders(env,hash);
}
async function accountOrders(env,hash,days=7,maxResults=100){
  const query=new URLSearchParams({fromEnteredTime:new Date(Date.now()-days*86400000).toISOString(),toEnteredTime:new Date().toISOString(),maxResults:String(maxResults)});
  const data=await(await schwab(env,'/accounts/'+hash+'/orders?'+query)).json();
  if(!Array.isArray(data))throw new Problem(502,'Schwab 订单列表格式无效。');
  return data;
}
export function orderPayload(input){
  const symbol=String(input.symbol||'').trim().toUpperCase(),quantity=Number(input.quantity),price=Number(input.price);
  if(!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)||!['BUY','SELL'].includes(input.side)||!Number.isSafeInteger(quantity)||quantity<=0||!Number.isFinite(price)||price<0.01||Math.abs(price*100-Math.round(price*100))>0.000001||quantity*price>1000)throw new Problem(400,'仅支持股票整股限价单，单笔名义金额上限 1000 USD。');
  return {orderType:'LIMIT',session:'NORMAL',duration:'DAY',orderStrategyType:'SINGLE',price:price.toFixed(2),orderLegCollection:[{instruction:input.side,quantity,instrument:{symbol,assetType:'EQUITY'}}]};
}
async function connectionId(env){return (await getSecret(env,'schwab_tokens'))?.connectionId??'legacy';}
async function unresolved(env,account){
  return env.DB.prepare(`SELECT key FROM service_state WHERE key GLOB 'order:*'
    AND json_extract(value,'$.account')=? AND json_extract(value,'$.status') IN (${pendingStatuses.map(()=>'?').join(',')}) LIMIT 1`).bind(account,...pendingStatuses).first();
}
async function preflight(env,account,payload){
  await validateAccount(env,account);
  if(await unresolved(env,account))throw new Problem(409,'该账户存在发送中或结果待确认的操作，请先查询并核对，禁止重新下单。');
  const data=await(await schwab(env,'/accounts/'+account+'?fields=positions')).json();
  const a=data.securitiesAccount,leg=payload.orderLegCollection[0];
  if(!a||!Array.isArray(a.positions??[]))throw new Problem(502,'账户持仓或余额响应无效。');
  if(leg.instruction==='SELL'){
    const held=(a.positions??[]).filter(p=>p.instrument?.symbol===leg.instrument.symbol&&p.instrument.assetType==='EQUITY').reduce((sum,p)=>sum+Number(p.longQuantity||0),0);
    const open=await accountOrders(env,account,365,3000);
    if(open.length>=3000)throw new Problem(409,'账户订单过多，无法核实全部待卖数量。');
    const reserved=reservedSells(open,leg.instrument.symbol);
    if(!Number.isFinite(held)||held-reserved<leg.quantity)throw new Problem(409,'可用多头持仓不足，已扣除未结束订单的待卖数量。');
  }else{
    const cash=Number(a.currentBalances?.cashAvailableForTrading);
    if(!Number.isFinite(cash)||cash<leg.quantity*Number(payload.price))throw new Problem(409,'可交易现金不足或无法核实，请检查账户余额。');
  }
}
function reservedSells(orders,symbol){
  let total=0;
  for(const order of orders){
    if(['FILLED','CANCELED','REJECTED','EXPIRED','REPLACED'].includes(order.status))continue;
    for(const leg of order.orderLegCollection??[]){
      if(leg.instrument?.symbol===symbol&&leg.instruction==='SELL'){
        const remaining=order.orderLegCollection.length===1?Number(order.remainingQuantity??Number(leg.quantity)-Number(order.filledQuantity??0)):Number(leg.quantity);
        if(!Number.isFinite(remaining)||remaining<0)throw new Problem(409,'无法核实待卖订单数量，请检查账户订单。');
        total+=remaining;
      }
    }
    total+=reservedSells(order.childOrderStrategies??[],symbol);
  }
  return total;
}
export async function previewOrder(env,input){
  const payload=orderPayload(input);
  await preflight(env,input.account,payload);
  const id=crypto.randomUUID(),connection=await connectionId(env);
  const record={id,kind:'submit',created:Date.now(),account:input.account,payload,connectionId:connection,generation:await generation(env.DB),expires:Date.now()+60000,status:'prepared'};
  await env.DB.prepare('INSERT INTO service_state(key,value) VALUES(?,?)').bind('order:'+id,JSON.stringify(record)).run();
  return {id,payload,account:input.account,expiresIn:60,liveEnabled:env.SCHWAB_LIVE_TRADING_ENABLED==='true',note:'本地参数、余额及持仓预检；提交后还需查询券商受理与成交状态。'};
}
function operationId(id){if(typeof id!=='string'||id.length>300||!/^[a-zA-Z0-9-]+$/.test(id))throw new Problem(400,'操作编号无效。');return id;}
async function claimOperation(env,id,record,previous){
  const result=await env.DB.prepare(`UPDATE service_state SET value=? WHERE key=? AND value=?
    AND NOT EXISTS(SELECT 1 FROM service_state s WHERE s.key GLOB 'order:*' AND s.key!=?
      AND json_extract(s.value,'$.account')=? AND json_extract(s.value,'$.status') IN (${pendingStatuses.map(()=>'?').join(',')}))
    AND (?!='submit' OR json_extract(value,'$.expires')>?)
    AND COALESCE((SELECT value FROM service_state WHERE key='schwab_generation'),'legacy')=?
    AND COALESCE((SELECT json_extract(value,'$.connectionId') FROM service_state WHERE key='schwab_auth_status'),'legacy')=?`)
    .bind(JSON.stringify(record),'order:'+id,previous,'order:'+id,record.account,...pendingStatuses,record.kind,Date.now(),record.generation,record.connectionId).run();
  if(result.meta.changes!==1)throw new Problem(409,'账户有待确认操作、授权已变化或当前操作已提交，请查询操作记录。');
}
async function updateOperation(env,id,previous,next){
  return env.DB.prepare('UPDATE service_state SET value=? WHERE key=? AND value=?').bind(JSON.stringify(next),'order:'+id,JSON.stringify(previous)).run();
}
function responseOrderId(response,account){
  const location=response.headers.get('location');if(!location)return null;
  const url=new URL(location,traderOrigin);
  const match=url.pathname.match(/^\/trader\/v1\/accounts\/([a-zA-Z0-9]+)\/orders\/(\d+)\/?$/);
  return url.origin===traderOrigin&&match?.[1]===account?match[2]:null;
}
function definiteRejection(error){return error.beforeSend||(error.upstreamStatus>=400&&error.upstreamStatus<500&&error.upstreamStatus!==408);}
export async function submitOrder(env,input){
  if(env.SCHWAB_LIVE_TRADING_ENABLED!=='true')throw new Problem(403,'实盘开关尚未启用；可完成授权和订单预览。');
  if(input.confirm!=='SUBMIT_LIVE_ORDER')throw new Problem(400,'需要明确确认实盘订单。');
  const id=operationId(input.id),row=await env.DB.prepare('SELECT value FROM service_state WHERE key=?').bind('order:'+id).first();
  if(!row)throw new Problem(404,'订单预览不存在。');
  const record=JSON.parse(row.value);
  if(record.status!=='prepared'||record.kind!=='submit'||record.expires<Date.now())throw new Problem(409,'预览已过期或已提交，请查询订单记录。');
  if(record.connectionId!==await connectionId(env))throw new Problem(409,'授权账户已变化，请重新预览。');
  const payload=orderPayload({symbol:record.payload.orderLegCollection[0].instrument.symbol,side:record.payload.orderLegCollection[0].instruction,quantity:record.payload.orderLegCollection[0].quantity,price:record.payload.price});
  await preflight(env,record.account,payload);
  const sending={...record,status:'sending',sentAt:Date.now()};
  await claimOperation(env,id,sending,row.value);
  let response;
  try{response=await schwab(env,'/accounts/'+record.account+'/orders','POST',payload,sending);}
  catch(error){
    const status=definiteRejection(error)?'rejected':'unknown';
    await updateOperation(env,id,sending,{...sending,status,updated:Date.now(),httpStatus:error.upstreamStatus??null});
    throw new Problem(status==='rejected'?400:502,status==='rejected'?'Schwab 拒绝提交，请查询操作记录及账户状态。':'订单结果未确认，禁止自动重试或新建预览重发。请查询券商订单并关联操作记录。');
  }
  let orderId;try{orderId=responseOrderId(response,record.account);}catch{orderId=null;}
  const result={...sending,status:orderId?'accepted':'unknown',orderId,updated:Date.now()};
  await updateOperation(env,id,sending,result);
  if(!orderId)throw new Problem(502,'提交响应缺少可核实的订单编号，结果待确认，禁止自动重试。');
  return {id,status:'accepted',orderId,note:'券商已受理，成交状态需要继续查询。'};
}
export async function operationHistory(env){
  const rows=(await env.DB.prepare("SELECT key,value FROM service_state WHERE key GLOB 'order:*' ORDER BY COALESCE(json_extract(value,'$.created'),0) DESC LIMIT 30").all()).results;
  return {operations:rows.map(row=>({id:row.key.slice(6),...JSON.parse(row.value)}))};
}
function brokerSummary(order){
  return {brokerStatus:order.status,filledQuantity:order.filledQuantity??0,remainingQuantity:order.remainingQuantity??null,checkedAt:Date.now()};
}
export async function reconcileOrder(env,input){
  const id=operationId(input.id),row=await env.DB.prepare('SELECT value FROM service_state WHERE key=?').bind('order:'+id).first();
  if(!row)throw new Problem(404,'操作记录不存在。');
  const record=JSON.parse(row.value);record.kind??='submit';
  let legacyOrderId=null;
  if(record.location)try{legacyOrderId=responseOrderId(new Response(null,{headers:{Location:record.location}}),record.account);}catch{}
  const orderId=String(record.orderId??legacyOrderId??input.orderId??'');
  if(record.status==='prepared'||!/^\d{1,30}$/.test(orderId))throw new Problem(400,'请填写券商订单编号，或先提交预览。');
  if(['sending','cancel_sending'].includes(record.status)&&record.sentAt&&Date.now()-record.sentAt<60000)throw new Problem(409,'操作正在发送，请稍后查询。');
  await validateAccount(env,record.account);
  const order=await(await schwab(env,'/accounts/'+record.account+'/orders/'+orderId)).json();
  if(String(order.orderId)!==orderId||typeof order.status!=='string')throw new Problem(502,'券商订单响应无法核实。');
  if(!record.orderId&&!legacyOrderId){
    if(!Number.isFinite(record.sentAt))throw new Problem(409,'旧操作缺少发送时间，请在券商端人工核对，已保留待确认状态。');
    const leg=order.orderLegCollection?.[0],expected=record.payload?.orderLegCollection?.[0],entered=Date.parse(order.enteredTime);
    if(order.orderLegCollection?.length!==1||leg?.instrument?.symbol!==expected?.instrument.symbol||leg?.instruction!==expected?.instruction||Number(leg?.quantity)!==expected?.quantity||Number(order.price)!==Number(record.payload.price)||order.orderType!=='LIMIT'||order.session!=='NORMAL'||order.duration!=='DAY'||order.orderStrategyType!=='SINGLE'||leg.instrument?.assetType!=='EQUITY'||!Number.isFinite(entered)||Math.abs(entered-record.sentAt)>120000)throw new Problem(409,'券商订单与待确认操作不匹配，已保留待确认状态。');
    const existing=await env.DB.prepare("SELECT key FROM service_state WHERE key GLOB 'order:*' AND key!=? AND json_extract(value,'$.kind')='submit' AND json_extract(value,'$.account')=? AND json_extract(value,'$.orderId')=? LIMIT 1").bind('order:'+id,record.account,orderId).first();
    if(existing)throw new Problem(409,'该券商订单已关联其他操作，请继续核对。');
  }
  const finalStatuses={FILLED:'filled',CANCELED:'canceled',REJECTED:'rejected',EXPIRED:'expired',REPLACED:'replaced'};
  const status=finalStatuses[order.status]??(record.kind==='cancel'?'cancel_pending':'working');
  const next={...record,orderId,status,...brokerSummary(order)};
  const updated=await env.DB.prepare(`UPDATE service_state SET value=? WHERE key=? AND value=?
    AND NOT EXISTS(SELECT 1 FROM service_state other WHERE other.key GLOB 'order:*' AND other.key!=?
      AND json_extract(other.value,'$.kind')='submit' AND json_extract(other.value,'$.account')=?
      AND json_extract(other.value,'$.orderId')=? AND ?='submit')`)
    .bind(JSON.stringify(next),'order:'+id,row.value,'order:'+id,record.account,orderId,record.kind).run();
  if(updated.meta.changes!==1)throw new Problem(409,'操作状态已更新，请重新查询。');
  return {id,...next};
}
export async function cancelOrder(env,input){
  if(env.SCHWAB_LIVE_TRADING_ENABLED!=='true'||input.confirm!=='CANCEL_LIVE_ORDER')throw new Problem(403,'尚未启用实盘或未确认撤单。');
  await validateAccount(env,input.account);
  const orderId=String(input.orderId);if(!/^\d{1,30}$/.test(orderId))throw new Problem(400,'订单编号无效。');
  const id='cancel-'+input.account+'-'+orderId,oldRow=await env.DB.prepare('SELECT value FROM service_state WHERE key=?').bind('order:'+id).first(),old=oldRow?JSON.parse(oldRow.value):null;
  if(old&&!['prepared','cancel_rejected'].includes(old.status))return {id,...old,note:'撤单请求已有记录，请查询券商最终状态。'};
  if(await unresolved(env,input.account))throw new Problem(409,'账户存在待确认操作，请先核对。');
  const order=await(await schwab(env,'/accounts/'+input.account+'/orders/'+orderId)).json();
  if(String(order.orderId)!==orderId||typeof order.status!=='string')throw new Problem(502,'无法核实要撤销的订单。');
  if(['FILLED','CANCELED','REJECTED','EXPIRED','REPLACED'].includes(order.status))throw new Problem(409,'该订单已结束，请刷新成交和持仓。');
  const record={id,kind:'cancel',attempt:(old?.attempt??0)+1,account:input.account,orderId,created:Date.now(),connectionId:await connectionId(env),generation:await generation(env.DB),status:'prepared'};
  const prepared=oldRow?await env.DB.prepare('UPDATE service_state SET value=? WHERE key=? AND value=?').bind(JSON.stringify(record),'order:'+id,oldRow.value).run():await env.DB.prepare('INSERT OR IGNORE INTO service_state(key,value) VALUES(?,?)').bind('order:'+id,JSON.stringify(record)).run();
  if(prepared.meta.changes!==1)throw new Problem(409,'撤单操作已在其他请求中更新，请查询记录。');
  const sending={...record,status:'cancel_sending',sentAt:Date.now()};
  await claimOperation(env,id,sending,JSON.stringify(record));
  try{await schwab(env,'/accounts/'+input.account+'/orders/'+orderId,'DELETE',undefined,sending);}
  catch(error){
    const rejected=definiteRejection(error);
    await updateOperation(env,id,sending,{...sending,status:rejected?'cancel_rejected':'cancel_unknown',updated:Date.now()});
    throw new Problem(rejected?400:502,rejected?'Schwab 拒绝撤单，请查询订单后决定是否重新申请。':'撤单结果未确认，请查询券商最终状态。');
  }
  await updateOperation(env,id,sending,{...sending,status:'cancel_pending',updated:Date.now()});
  return {id,orderId,status:'cancel_pending',note:'撤单请求已受理，仍可能成交，请查询最终状态。'};
}
