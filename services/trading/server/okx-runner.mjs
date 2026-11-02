import {Problem,config,targets} from './engine.mjs';
import {strategyAsset} from './series.mjs';
import {MINUTE15,intradayGap} from './timeframes.mjs';
import {readOKX,writeOKX,okxFingerprint,checkOKX,isOKXBusy,instrument,ticker,previewOKX,submitOKX,cancelOKX,refreshOKXOrders,decimal,formatDecimal,floorStep,SCALE,finished} from './okx.mjs';
const key=id=>'okx:strategy:'+id;
async function save(env,old,next){return env.DB.prepare('UPDATE service_state SET value=? WHERE key=? AND value=?').bind(JSON.stringify(next),key(old.id),JSON.stringify(old)).run();}
function readyBars(asset,p){
  const bars=JSON.parse(asset.data),interval=p.timeframe==='15m'?MINUTE15:86400000;
  if(asset.market!=='crypto'||!/^crypto:[A-Z0-9]{2,20}-USDT$/.test(asset.id))throw new Problem(400,'OKX 策略执行请选择 USDT 现货标的。');
  if(bars.length<Math.max(p.slow,35)+5||Date.now()-bars.at(-1).time>3*interval||bars.at(-1).time+interval>Date.now())throw new Problem(409,'对应周期的完整K线不足或过旧，请先更新行情。');
  return bars;
}
export async function startOKXStrategy(env,input){
  if(input.mode!=='demo'||input.confirm!=='START_OKX_DEMO_STRATEGY')throw new Problem(400,'此自动执行入口需明确确认 OKX 模拟盘。');
  const p=config(input.config),asset=await strategyAsset(env.DB,input.assetId,p.timeframe),bars=readyBars(asset,p);
  const account=await checkOKX(env,'demo');
  const info=await instrument(env,'demo',asset.symbol);
  if(!['1','2'].includes(String(account.accountMode)))throw new Problem(409,'请先在 OKX 模拟盘选择支持现金现货的账户模式。');
  const runner={id:crypto.randomUUID(),assetId:asset.id,instId:info.instId,base:info.baseCcy,mode:'demo',uid:account.uid,fingerprint:await okxFingerprint(env,'demo'),config:p,budget:String(Math.min(1000,p.initial)),cash:String(Math.min(1000,p.initial)),owned:'0',peak:Math.min(1000,p.initial),lastTime:bars.at(-1).time,status:'running',created:Date.now(),pendingId:null,message:'等待下一根完整K线。'};
  const result=await env.DB.prepare(`INSERT INTO service_state(key,value) SELECT ?,? WHERE
    (SELECT count(*) FROM service_state WHERE key GLOB 'okx:strategy:*' AND json_extract(value,'$.status')='running')<3
    AND NOT EXISTS(SELECT 1 FROM service_state WHERE key GLOB 'okx:strategy:*' AND json_extract(value,'$.uid')=? AND json_extract(value,'$.instId')=? AND json_extract(value,'$.status')='running')
    AND EXISTS(SELECT 1 FROM assets WHERE id=? AND revision=?)`).bind(key(runner.id),JSON.stringify(runner),runner.uid,runner.instId,asset.id,asset.revision).run();
  if(result.meta.changes!==1)throw new Problem(409,'同一标的已有运行策略、已达到3个策略上限，或标的数据已变化。');
  return {id:runner.id,status:runner.status,budget:runner.budget,mode:'demo'};
}
export async function listOKXStrategies(env){
  const rows=(await env.DB.prepare("SELECT value FROM service_state WHERE key GLOB 'okx:strategy:*' ORDER BY json_extract(value,'$.created') DESC LIMIT 20").all()).results;
  return {strategies:rows.map(r=>{const {fingerprint,...runner}=JSON.parse(r.value);return runner;})};
}
export async function stopOKXStrategy(env,input){
  if(typeof input.id!=='string'||!/^[-a-f0-9]{36}$/.test(input.id))throw new Problem(400,'策略编号无效。');
  const result=await env.DB.prepare("UPDATE service_state SET value=json_set(value,'$.status','stopped','$.message','已停止新信号；未完成委托需单独撤单。') WHERE key=? AND json_extract(value,'$.status') IN ('running','paused')").bind(key(input.id)).run();
  if(result.meta.changes!==1)throw new Problem(409,'策略已停止或不存在。');
  return {status:'stopped',note:'已停止新信号；未完成委托需单独查询或撤单。'};
}
function applyFill(runner,order){
  const fill=decimal(order.accFillSz??'0');
  if(fill===0n)return runner;
  if(order.fee===null||order.fee===undefined||!order.feeCcy||!['USDT',runner.base].includes(order.feeCcy))throw new Problem(409,'成交手续费币种或金额尚无法核实，已暂停策略，请核对成交。');
  const price=decimal(order.avgPx),fee=decimal(order.fee);
  if(price<=0n)throw new Problem(409,'成交均价尚无法核实。');
  const quote=fill*price/SCALE,baseFee=order.feeCcy===runner.base?fee:0n,quoteFee=order.feeCcy==='USDT'?fee:0n;
  const buying=order.payload.side==='buy';
  const owned=decimal(runner.owned)+(buying?fill+baseFee:-fill+baseFee);
  const cash=decimal(runner.cash)+(buying?-quote+quoteFee:quote+quoteFee);
  if(owned<0n||cash<0n)throw new Problem(409,'策略账本与成交不一致，请核对账户。');
  return {...runner,owned:formatDecimal(owned),cash:formatDecimal(cash)};
}
async function advance(env,initial){
  let runner=initial;
  if(runner.fingerprint!==await okxFingerprint(env,'demo'))throw new Problem(409,'OKX 模拟盘密钥或区域已变化，请核对后重新创建策略。');
  if(runner.pendingId){
    const order=await readOKX(env.DB,'okx:operation:'+runner.pendingId);
    if(!order)throw new Problem(409,'策略委托记录缺失。');
    if(order.status==='prepared'){
      if(order.expires<Date.now()){
        await writeOKX(env.DB,'okx:operation:'+order.id,{...order,status:'rejected',note:'策略预览过期，未发送。'});
      }else{
        await submitOKX(env,{id:order.id,confirm:'SUBMIT_OKX_DEMO_ORDER'});return;
      }
    }else if(!finished(order)){
      const interval=runner.config.timeframe==='15m'?MINUTE15:86400000;
      if(['live','partially_filled'].includes(order.status)&&Date.now()-order.sentAt>2*interval)await cancelOKX(env,{id:order.id,confirm:'CANCEL_OKX_DEMO_ORDER'});
      return;
    }
    const next={...applyFill(runner,order),pendingId:null,message:'委托已核对。'};
    if((await save(env,runner,next)).meta.changes!==1)return;
    runner=next;
  }
  const asset=await strategyAsset(env.DB,runner.assetId,runner.config.timeframe),bars=readyBars(asset,runner.config),latest=bars.at(-1);
  if(latest.time<=runner.lastTime)return;
  if(!bars.some(b=>b.time===runner.lastTime)||bars.some((b,i)=>i&&b.time>runner.lastTime&&(runner.config.timeframe==='15m'?intradayGap(bars[i-1].time,b.time,'crypto'):b.time-bars[i-1].time>1.5*86400000)))throw new Problem(409,'策略历史存在缺口，请核对后重新启动。');
  // Signals use the most recent completed bar; executions use a fresh exchange quote.
  const want=targets(bars,runner.config,'crypto').at(-1),info=await instrument(env,'demo',runner.instId),quote=await ticker(env,'demo',runner.instId);
  const equity=Number(runner.cash)+Number(runner.owned)*Number(quote.bidPx),peak=Math.max(runner.peak,equity);
  if(1-equity/peak>=runner.config.maxDrawdown)throw new Problem(409,'触及回撤阈值，已暂停新委托；现有持仓需核对处理。');
  const step=decimal(info.lotSz),tick=decimal(info.tickSz),owned=decimal(runner.owned),side=want?'buy':'sell';
  const price=floorStep(decimal(want?quote.askPx:quote.bidPx),tick);
  const amount=want?Math.min(Number(runner.budget)*runner.config.allocation,Number(runner.cash)/1.005):0;
  const quantity=want?(owned===0n?floorStep(decimal(amount.toFixed(12))*SCALE/price,step):0n):floorStep(owned,step);
  const next={...runner,lastTime:latest.time,peak,equity,updated:Date.now(),message:quantity<decimal(info.minSz)?'未触发新委托，或数量低于最小值。':'准备提交模拟盘委托。'};
  if(quantity<decimal(info.minSz)){await save(env,runner,next);return;}
  if(await isOKXBusy(env,'demo',runner.uid)){await save(env,runner,{...runner,message:'账户有未结束委托，等待核对后继续。'});return;}
  const preview=await previewOKX(env,{mode:'demo',instId:runner.instId,side,px:formatDecimal(price),sz:formatDecimal(quantity),runnerId:runner.id});
  // Persist the intent before the POST; a crash resumes this exact operation, not a new order.
  const intended={...next,pendingId:preview.id};
  if((await save(env,runner,intended)).meta.changes!==1)return;
  await submitOKX(env,{id:preview.id,confirm:'SUBMIT_OKX_DEMO_ORDER'});
}
export async function refreshOKX(env){
  const operations=await refreshOKXOrders(env);
  const rows=(await env.DB.prepare("SELECT value FROM service_state WHERE key GLOB 'okx:strategy:*' AND json_extract(value,'$.status')='running' ORDER BY json_extract(value,'$.created') LIMIT 3").all()).results;
  if(!rows.length)return {operations,strategies:[]};
  const lease=crypto.randomUUID(),lock=JSON.stringify({lease,until:Date.now()+240000});
  const locked=await env.DB.prepare("INSERT INTO service_state(key,value) VALUES('okx:runner_lock',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE json_extract(service_state.value,'$.until')<?").bind(lock,Date.now()).run();
  if(locked.meta.changes!==1)return {operations,strategies:[{status:'busy'}]};
  const report=[];
  try{
    for(const row of rows){
      const old=JSON.parse(row.value);
      try{await advance(env,old);report.push({id:old.id,status:'checked'});}
      catch(error){
        const current=await readOKX(env.DB,key(old.id));
        const order=current?.pendingId?await readOKX(env.DB,'okx:operation:'+current.pendingId):null;
        const waiting=order&&['sending','unknown','live','partially_filled'].includes(order.status)||(error.status===409&&await isOKXBusy(env,'demo',old.uid));
        if(current?.status==='running')await save(env,current,{...current,status:waiting?'running':'paused',message:error.message,updated:Date.now()});
        report.push({id:old.id,status:waiting?'waiting':'paused',message:error.message});
      }
    }
  }finally{await env.DB.prepare("DELETE FROM service_state WHERE key='okx:runner_lock' AND value=?").bind(lock).run();}
  return {operations,strategies:report};
}
