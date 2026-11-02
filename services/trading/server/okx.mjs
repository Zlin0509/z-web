import {Problem} from './engine.mjs';
import {remote} from './connections.mjs';

export const SCALE=10n**24n;
export function decimal(value){
  const text=String(value??'');
  if(!/^-?\d{1,18}(\.\d{1,24})?$/.test(text))throw new Problem(400,'金额和数量需使用普通小数，最多24位小数。');
  const negative=text.startsWith('-'),[whole,fraction='']=(negative?text.slice(1):text).split('.');
  return (BigInt(whole)*SCALE+BigInt(fraction.padEnd(24,'0')))*(negative?-1n:1n);
}
export function formatDecimal(value){
  const negative=value<0n,absolute=negative?-value:value;
  const fraction=String(absolute%SCALE).padStart(24,'0').replace(/0+$/,'');
  return (negative?'-':'')+String(absolute/SCALE)+(fraction?'.'+fraction:'');
}
export const floorStep=(value,step)=>value/step*step;
const hosts={global:'https://openapi.okx.com',us:'https://us.okx.com',eea:'https://eea.okx.com'};
const enc=new TextEncoder();
const active=['sending','unknown','live','partially_filled','cancel_sending','cancel_unknown','cancel_pending'];
const terminal=['filled','canceled','mmp_canceled','rejected'];
export const finished=record=>terminal.includes(record.status);
export async function readOKX(db,key){const row=await db.prepare('SELECT value FROM service_state WHERE key=?').bind(key).first();return row?JSON.parse(row.value):null;}
export async function writeOKX(db,key,value){await db.prepare('INSERT INTO service_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key,JSON.stringify(value)).run();}
export function credentials(env,mode){
  if(!['demo','live'].includes(mode))throw new Problem(400,'请选择 OKX 模拟盘或实盘。');
  const prefix=mode==='demo'?'OKX_DEMO_':'OKX_LIVE_',legacy=env.OKX_ACCOUNT_MODE===mode;
  const key=env[prefix+'API_KEY']||(legacy?env.OKX_API_KEY:null),secret=env[prefix+'SECRET_KEY']||(legacy?env.OKX_SECRET_KEY:null),passphrase=env[prefix+'PASSPHRASE']||(legacy?env.OKX_PASSPHRASE:null);
  if(!key||!secret||!passphrase)throw new Problem(424,'请先保存 OKX '+(mode==='demo'?'模拟盘':'实盘')+'的 API Key、Secret Key 和 Passphrase。');
  const region=env.OKX_REGION||'global';if(!hosts[region])throw new Problem(400,'OKX 区域无效。');
  return {key,secret,passphrase,host:hosts[region],mode};
}
async function fingerprint(env,mode){
  const c=credentials(env,mode);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(JSON.stringify(c))))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
export async function okxGeneration(env){return (await env.DB.prepare("SELECT value FROM service_state WHERE key='okx:generation'").first())?.value??'legacy';}
export async function okxFingerprint(env,mode){return fingerprint(env,mode);}
async function request(env,mode,path,method='GET',body,authenticated=true,expectedGeneration,runnerId){
  const c=credentials(env,mode),fetcher=env.OKX_FETCH??fetch;
  const serialized=body===undefined?'':JSON.stringify(body),headers={'Content-Type':'application/json'};
  if(authenticated){
    const clockKey='okx:clock:'+c.host;let clock=await readOKX(env.DB,clockKey);
    if(!clock||Date.now()-clock.checked>60000){
      const before=Date.now(),response=await remote(c.host+'/api/v5/public/time',{},fetcher),data=await response.json();
      const server=Number(data.data?.[0]?.ts);
      if(data.code!=='0'||!Number.isFinite(server)||server<=0)throw new Problem(502,'无法校准 OKX 服务器时间。');
      clock={offset:server-(before+Date.now())/2,checked:Date.now()};await writeOKX(env.DB,clockKey,clock);
    }
    const now=Date.now()+clock.offset,timestamp=new Date(now).toISOString();
    const key=await crypto.subtle.importKey('raw',enc.encode(c.secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
    const signed=await crypto.subtle.sign('HMAC',key,enc.encode(timestamp+method+path+serialized));
    Object.assign(headers,{'OK-ACCESS-KEY':c.key,'OK-ACCESS-PASSPHRASE':c.passphrase,'OK-ACCESS-TIMESTAMP':timestamp,'OK-ACCESS-SIGN':btoa(String.fromCharCode(...new Uint8Array(signed)))});
    if(method==='POST'&&path==='/api/v5/trade/order')headers.expTime=String(Math.floor(now+15000));
  }
  if(mode==='demo')headers['x-simulated-trading']='1';
  if(expectedGeneration!==undefined&&expectedGeneration!==await okxGeneration(env)){const error=new Problem(409,'OKX 配置已变化，操作未发送。');error.definitive=true;throw error;}
  if(runnerId){const runner=await readOKX(env.DB,'okx:strategy:'+runnerId);if(runner?.status!=='running'){const error=new Problem(409,'策略已停止或暂停，委托未发送。');error.definitive=true;throw error;}}
  let response;
  try{response=await remote(c.host+path,{method,headers,body:serialized||undefined},fetcher);}
  catch(error){error.definitive=!!error.upstreamStatus&&error.upstreamStatus>=400&&error.upstreamStatus<500&&error.upstreamStatus!==408;throw error;}
  let result;try{result=await response.json();}catch{throw new Problem(502,'OKX 响应无法解析，请核对订单状态。');}
  const item=result.data?.[0],code=result.code==='0'?(item?.sCode??'0'):(item?.sCode&&item.sCode!=='0'?item.sCode:result.code);
  if(code!=='0'){
    const safeCode=/^\d{1,8}$/.test(String(code))?String(code):'unknown';
    const error=new Problem(502,'OKX 返回错误 '+safeCode+'，请核对环境、权限、余额及订单参数。');
    error.okxCode=safeCode;error.definitive=!['unknown','50004','50013','50026'].includes(safeCode);throw error;
  }
  if(!Array.isArray(result.data))throw new Problem(502,'OKX 响应格式无效。');
  return result.data;
}
export async function checkOKX(env,mode){
  const config=(await request(env,mode,'/api/v5/account/config'))[0];
  if(!config||typeof config.uid!=='string'||!config.uid)throw new Problem(502,'OKX 账户标识无效。');
  const balance=(await request(env,mode,'/api/v5/account/balance'))[0];
  if(!balance||!Array.isArray(balance.details))throw new Problem(502,'OKX 余额响应无效。');
  const result={connected:true,mode,uid:config.uid,accountMode:config.acctLv,permissions:config.perm??null,currencies:balance.details.length,balances:balance.details.map(x=>({currency:x.ccy,available:x.availBal,equity:x.eq,frozen:x.frozenBal})),checkedAt:new Date().toISOString(),liveEnabled:env.OKX_LIVE_TRADING_ENABLED==='true'};
  await writeOKX(env.DB,'okx:account:'+mode,{...result,credentialFingerprint:await fingerprint(env,mode)});
  return result;
}
function instrumentId(id){if(typeof id!=='string'||!/^[A-Z0-9]{2,20}-USDT$/.test(id))throw new Problem(400,'当前支持 USDT 现货交易对，例如 BTC-USDT。');return id;}
export async function instrument(env,mode,id){
  instrumentId(id);
  const data=await request(env,mode,'/api/v5/public/instruments?'+new URLSearchParams({instType:'SPOT',instId:id}),'GET',undefined,false),item=data.find(x=>x.instId===id);
  if(!item||item.instType!=='SPOT'||item.quoteCcy!=='USDT'||item.state!=='live')throw new Problem(409,'该现货交易对当前不可交易。');
  for(const field of ['tickSz','lotSz','minSz'])if(decimal(item[field])<=0n)throw new Problem(502,'交易对精度规则无效。');
  return item;
}
export async function ticker(env,mode,id){
  const item=(await request(env,mode,'/api/v5/market/ticker?'+new URLSearchParams({instId:instrumentId(id)}),'GET',undefined,false))[0];
  if(!item||item.instId!==id||!/^\d+$/.test(String(item.ts))||Math.abs(Date.now()-Number(item.ts))>60000||decimal(item.bidPx)<=0n||decimal(item.askPx)<=0n)throw new Problem(409,'OKX 当前报价过旧或不可用。');
  return item;
}
function validatePayload(input,info){
  const px=decimal(input.px),sz=decimal(input.sz);
  if(!['buy','sell'].includes(input.side)||px<=0n||sz<decimal(info.minSz)||px%decimal(info.tickSz)!==0n||sz%decimal(info.lotSz)!==0n||px*sz>1000n*SCALE*SCALE)throw new Problem(400,'价格或数量未满足交易对精度、最小数量或单笔1000 USDT上限。');
  return {instId:info.instId,tdMode:'cash',side:input.side,ordType:'limit',px:formatDecimal(px),sz:formatDecimal(sz)};
}
async function pending(env,mode,uid){return env.DB.prepare(`SELECT key FROM service_state WHERE key GLOB 'okx:operation:*' AND json_extract(value,'$.mode')=? AND json_extract(value,'$.uid')=? AND json_extract(value,'$.status') IN (${active.map(()=>'?').join(',')}) LIMIT 1`).bind(mode,uid,...active).first();}
export async function isOKXBusy(env,mode,uid){return !!await pending(env,mode,uid);}
async function preflight(env,mode,input){
  const account=await checkOKX(env,mode);
  if(!['1','2'].includes(String(account.accountMode)))throw new Problem(409,'当前现金现货执行需 OKX 现货模式或合约模式账户，请在 OKX 核对账户模式。');
  if(account.permissions&&!account.permissions.split(',').includes('trade'))throw new Problem(403,'此 OKX API Key 没有交易权限。');
  if(await pending(env,mode,account.uid))throw new Problem(409,'该环境账户存在未结束或待确认操作，请先查询或撤单。');
  const info=await instrument(env,mode,input.instId),payload=validatePayload(input,info),quote=await ticker(env,mode,payload.instId);
  const price=decimal(payload.px),market=decimal(payload.side==='buy'?quote.askPx:quote.bidPx);
  if((price>market?price-market:market-price)*100n>market*5n)throw new Problem(409,'限价偏离当前报价超过5%，请重新核对。');
  const available=decimal(account.balances.find(x=>x.currency===(payload.side==='buy'?'USDT':info.baseCcy))?.available??'0');
  const needed=payload.side==='buy'?price*decimal(payload.sz)/SCALE*1005n/1000n:decimal(payload.sz);
  if(available<needed)throw new Problem(409,'可用余额不足，买入预留0.5%成本缓冲。');
  return {account,info,payload};
}
export async function previewOKX(env,input){
  const mode=input.mode,{account,payload}=await preflight(env,mode,input),id=crypto.randomUUID();
  const record={id,kind:'submit',mode,uid:account.uid,fingerprint:await fingerprint(env,mode),generation:await okxGeneration(env),payload:{...payload,clOrdId:'z'+id.replaceAll('-','').slice(0,31)},created:Date.now(),expires:Date.now()+60000,status:'prepared',runnerId:input.runnerId??null};
  await writeOKX(env.DB,'okx:operation:'+id,record);
  return {id,mode,payload:record.payload,expiresIn:60,liveEnabled:env.OKX_LIVE_TRADING_ENABLED==='true'};
}
async function operation(env,id){
  if(typeof id!=='string'||id.length>120||!/^[a-zA-Z0-9-]+$/.test(id))throw new Problem(400,'OKX 操作编号无效。');
  const row=await env.DB.prepare('SELECT value FROM service_state WHERE key=?').bind('okx:operation:'+id).first();
  if(!row)throw new Problem(404,'OKX 操作记录不存在。');return {row,record:JSON.parse(row.value)};
}
async function update(env,record,next){return env.DB.prepare('UPDATE service_state SET value=? WHERE key=? AND value=?').bind(JSON.stringify(next),'okx:operation:'+record.id,JSON.stringify(record)).run();}
async function claim(env,record,sending){
  const result=await env.DB.prepare(`UPDATE service_state SET value=? WHERE key=? AND value=?
    AND COALESCE((SELECT value FROM service_state WHERE key='okx:generation'),'legacy')=?
    AND (?!='submit' OR json_extract(value,'$.expires')>?)
    AND NOT EXISTS(SELECT 1 FROM service_state s WHERE s.key GLOB 'okx:operation:*' AND s.key!=?
      AND json_extract(s.value,'$.mode')=? AND json_extract(s.value,'$.uid')=? AND json_extract(s.value,'$.status') IN (${active.map(()=>'?').join(',')}))`)
    .bind(JSON.stringify(sending),'okx:operation:'+record.id,JSON.stringify(record),record.generation,record.kind,Date.now(),'okx:operation:'+record.id,record.mode,record.uid,...active).run();
  if(result.meta.changes!==1)throw new Problem(409,'操作已更新、预览已过期或账户有未结束委托。');
}
export async function submitOKX(env,input){
  const {record}=await operation(env,input.id);
  if(input.confirm!==(record.mode==='demo'?'SUBMIT_OKX_DEMO_ORDER':'SUBMIT_OKX_LIVE_ORDER'))throw new Problem(400,'请明确确认所选环境的订单。');
  if(record.mode==='live'&&env.OKX_LIVE_TRADING_ENABLED!=='true')throw new Problem(403,'OKX 实盘提交开关尚未启用。');
  if(record.kind!=='submit'||record.status!=='prepared'||record.expires<Date.now())throw new Problem(409,'预览已过期或已提交，请查询操作记录。');
  if(record.fingerprint!==await fingerprint(env,record.mode))throw new Problem(409,'OKX 配置已变化，请重新预览。');
  if(record.runnerId){const runner=await readOKX(env.DB,'okx:strategy:'+record.runnerId);if(runner?.status!=='running'||runner.pendingId!==record.id)throw new Problem(409,'策略已停止或委托意图已变化。');}
  const checked=await preflight(env,record.mode,record.payload);
  if(checked.account.uid!==record.uid)throw new Problem(409,'账户已变化，请重新预览。');
  const sending={...record,status:'sending',sentAt:Date.now()};await claim(env,record,sending);
  // Resolve transport timeouts by clOrdId. Never replay this POST.
  try{
    const item=(await request(env,record.mode,'/api/v5/trade/order','POST',record.payload,true,record.generation,record.runnerId))[0];
    if(!item||!/^\d+$/.test(item.ordId)||item.clOrdId!==record.payload.clOrdId)throw new Problem(502,'OKX 提交响应无法核实，结果待确认。');
    const next={...sending,status:'live',ordId:item.ordId,updated:Date.now()};await update(env,sending,next);
    return {id:record.id,mode:record.mode,status:'live',ordId:item.ordId,clOrdId:record.payload.clOrdId,note:'请求已受理，请继续查询成交状态。'};
  }catch(error){
    const status=error.definitive?'rejected':'unknown';await update(env,sending,{...sending,status,updated:Date.now(),errorCode:error.okxCode??error.upstreamStatus??null});
    throw new Problem(status==='rejected'?400:502,status==='rejected'?error.message:'OKX 订单结果待确认，请查询操作记录，禁止重复发送。');
  }
}
export async function historyOKX(env){
  const rows=(await env.DB.prepare("SELECT value FROM service_state WHERE key GLOB 'okx:operation:*' ORDER BY json_extract(value,'$.created') DESC LIMIT 30").all()).results;
  return {operations:rows.map(r=>{const {fingerprint,...record}=JSON.parse(r.value);return record;})};
}
async function verifyAccount(env,record){
  const config=(await request(env,record.mode,'/api/v5/account/config'))[0];
  if(config?.uid!==record.uid)throw new Problem(403,'此配置对应的 OKX 账户与操作记录不匹配。');
}
export async function reconcileOKX(env,input){
  const {record}=await operation(env,input.id);
  if(record.status==='prepared')throw new Problem(400,'该预览尚未发送。');
  if(['sending','cancel_sending'].includes(record.status)&&Date.now()-record.sentAt<60000)throw new Problem(409,'操作正在发送，请稍后查询。');
  await verifyAccount(env,record);
  const query=new URLSearchParams({instId:record.payload.instId,...(record.ordId?{ordId:record.ordId}:{clOrdId:record.payload.clOrdId})});
  const order=(await request(env,record.mode,'/api/v5/trade/order?'+query))[0];
  if(!order||order.instId!==record.payload.instId||order.clOrdId!==record.payload.clOrdId||!/^\d+$/.test(order.ordId)||!['live','partially_filled','filled','canceled','mmp_canceled'].includes(order.state))throw new Problem(502,'OKX 订单状态无法核实，已保留原记录。');
  if(order.side!==record.payload.side||order.ordType!=='limit'||decimal(order.px)!==decimal(record.payload.px)||decimal(order.sz)!==decimal(record.payload.sz))throw new Problem(409,'OKX 订单与本地请求不匹配。');
  const filled=decimal(order.accFillSz);
  if(filled<decimal(record.accFillSz??'0')||filled<0n||filled>decimal(order.sz))throw new Problem(502,'OKX 累计成交数量异常。');
  const next={...record,status:record.kind==='cancel'&&!['filled','canceled','mmp_canceled'].includes(order.state)?'cancel_pending':order.state,ordId:order.ordId,accFillSz:formatDecimal(filled),avgPx:order.avgPx||'0',fee:order.fee??null,feeCcy:order.feeCcy??null,checkedAt:Date.now()};
  const result=await update(env,record,next);if(result.meta.changes!==1)throw new Problem(409,'操作已更新，请重新查询。');
  if(next.kind==='cancel'&&next.parentId){
    const parent=await readOKX(env.DB,'okx:operation:'+next.parentId);
    if(parent&&parent.ordId===next.ordId&&decimal(parent.accFillSz??'0')<=filled)await update(env,parent,{...parent,status:order.state,accFillSz:next.accFillSz,avgPx:next.avgPx,fee:next.fee,feeCcy:next.feeCcy,checkedAt:next.checkedAt});
  }
  return next;
}
export async function ordersOKX(env,input){
  const mode=input.mode,id=instrumentId(input.instId);
  const [pending,recent]=await Promise.all([request(env,mode,'/api/v5/trade/orders-pending?'+new URLSearchParams({instType:'SPOT',instId:id,limit:'20'})),request(env,mode,'/api/v5/trade/orders-history?'+new URLSearchParams({instType:'SPOT',instId:id,limit:'20'}))]);
  return {mode,instId:id,pending,recent};
}
export async function cancelOKX(env,input){
  const {record}=await operation(env,input.id);
  if(input.confirm!==(record.mode==='demo'?'CANCEL_OKX_DEMO_ORDER':'CANCEL_OKX_LIVE_ORDER'))throw new Problem(400,'请确认撤销对应环境的订单。');
  if(record.mode==='live'&&env.OKX_LIVE_TRADING_ENABLED!=='true')throw new Problem(403,'OKX 实盘撤单开关尚未启用。');
  if(record.kind!=='submit'||record.status==='prepared')throw new Problem(409,'此记录不支持撤单。');
  const latest=await reconcileOKX(env,{id:record.id});if(finished(latest))return {id:latest.id,status:latest.status,note:'订单已结束。'};
  const id='c'+record.id,old=await readOKX(env.DB,'okx:operation:'+id);
  if(old&&old.status!=='rejected')return {id:old.id,status:old.status,note:'撤单已有记录，请查询最终状态。'};
  const cancellation={...latest,id,kind:'cancel',parentId:record.id,created:Date.now(),status:'cancel_sending',sentAt:Date.now()};
  const inserted=old?await env.DB.prepare('UPDATE service_state SET value=? WHERE key=? AND value=?').bind(JSON.stringify(cancellation),'okx:operation:'+id,JSON.stringify(old)).run():await env.DB.prepare('INSERT OR IGNORE INTO service_state(key,value) VALUES(?,?)').bind('okx:operation:'+id,JSON.stringify(cancellation)).run();
  if(inserted.meta.changes!==1)throw new Problem(409,'撤单已在处理，请查询。');
  try{
    const item=(await request(env,record.mode,'/api/v5/trade/cancel-order','POST',{instId:record.payload.instId,ordId:latest.ordId},true,await okxGeneration(env)))[0];
    if(item?.ordId!==latest.ordId)throw new Problem(502,'撤单响应无法核实。');
    await update(env,cancellation,{...cancellation,status:'cancel_pending'});
    return {id,status:'cancel_pending',note:'撤单请求已受理，仍需查询最终状态。'};
  }catch(error){await update(env,cancellation,{...cancellation,status:error.definitive?'rejected':'cancel_unknown'});throw new Problem(502,'撤单未完成，请查询交易所最终状态。');}
}
export async function refreshOKXOrders(env){
  const rows=(await env.DB.prepare(`SELECT value FROM service_state WHERE key GLOB 'okx:operation:*' AND json_extract(value,'$.status') IN (${active.map(()=>'?').join(',')}) ORDER BY json_extract(value,'$.created') LIMIT 20`).bind(...active).all()).results;
  const report=[];
  for(const row of rows){const record=JSON.parse(row.value);try{const next=await reconcileOKX(env,{id:record.id});report.push({id:record.id,status:next.status});}catch(error){report.push({id:record.id,status:record.status,message:error.message});}}
  return report;
}
