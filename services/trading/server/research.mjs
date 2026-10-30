import {Problem,config,backtest,featureSeries,FEATURE_VERSION,finite,normalizeBars} from './engine.mjs';
export const ENGINE_VERSION='daily-next-open-v2';
export const PROMPT_VERSION='research-memory-v2';
export const POLICY={folds:3,minBars:240,minClosedTrades:12,minHoldoutTrades:5,maxTrials:12,maxRounds:3,stressMultiplier:2};
export const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
export const score=m=>m.totalReturn-1.5*m.maxDrawdown;
export async function digest(value){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))].map(x=>x.toString(16).padStart(2,'0')).join('');}
export async function readRecord(db,key){const r=await db.prepare('SELECT value FROM service_state WHERE key=?').bind(key).first();return r?JSON.parse(r.value):null;}
export async function putRecord(db,key,value){await db.prepare('INSERT INTO service_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key,JSON.stringify(value)).run();}
export function splitPlan(bars){
  if(bars.length<POLICY.minBars)throw new Problem(400,`AI 研究至少需要 ${POLICY.minBars} 根日线，以保留滚动验证和最终验收区间。`);
  const developmentEnd=Math.floor(bars.length*.8),trainEnd=Math.floor(developmentEnd*.5),folds=[];
  for(let k=0;k<POLICY.folds;k++)folds.push({start:trainEnd+Math.floor((developmentEnd-trainEnd)*k/POLICY.folds),end:trainEnd+Math.floor((developmentEnd-trainEnd)*(k+1)/POLICY.folds)});
  return {developmentEnd,trainEnd,folds,maxSlow:Math.min(200,trainEnd-10)};
}
export function featureContext(bars,p,market){
  const f=featureSeries(bars,p,market),latest=Object.fromEntries(Object.entries(f).map(([k,a])=>[k,a.at(-1)??null]));
  const window=['rsi14','macd_histogram','atr_pct','volatility20','rvol','return20','bollinger_width','sma_slope'];
  const summary=Object.fromEntries(window.map(k=>{const a=f[k].slice(-60).filter(finite);return [k,a.length?{min:Math.min(...a),max:Math.max(...a),mean:mean(a),observations:a.length}:null];}));
  const regime=(Math.abs(latest.sma_slope??0)>.01?'trend':'range')+((latest.volatility20??0)>0&&(latest.vol_percentile??0)>.8?':high_vol':':normal_vol');
  return {version:FEATURE_VERSION,asOf:bars.at(-1).time,regime,latest,summary60:summary,recent:bars.slice(-10).map((b,j)=>({time:b.time,...Object.fromEntries(window.map(k=>[k,f[k][bars.length-10+j]??null]))})),units:'收益、波动、斜率和百分位使用小数；RSI 为0–100；trend_distance为ATR倍数；rvol为20日均量倍数。'};
}
export function auditData(bars,market,basis){
  const warnings=[];let gaps=0,jumps=0;for(let i=1;i<bars.length;i++){if(bars[i].time-bars[i-1].time>(market==='crypto'?1.5:5)*86400000)gaps++;if(Math.abs(bars[i].open/bars[i-1].close-1)>.35)jumps++;}
  if(gaps)warnings.push(`发现 ${gaps} 处较长日期缺口，未填造行情。`);
  if(jumps)warnings.push(`发现 ${jumps} 处超过35%的隔夜跳变，需要检查拆股或异常数据。`);
  if(market==='us'&&basis!=='split')warnings.push('美股复权口径未核实，最终验收不会标为通过。');
  if(market==='us')warnings.push('回测不计现金分红；如采用 IEX，成交量仅覆盖该交易所。');
  if(bars.length<750)warnings.push('历史不足750根，行情覆盖有限；不代表具备跨周期稳定性。');
  return {basis,gaps,jumps,eligible:gaps===0&&jumps===0&&(market!=='us'||basis==='split'),warnings};
}
function metrics(bars,p,market,start,end){return backtest(bars.slice(0,end),p,market,bars[start].time).metrics;}
export function evaluateCandidate(bars,baseline,candidate,market,plan){
  if(Math.max(baseline.slow,candidate.slow)>plan.maxSlow)throw new Problem(400,`当前研究窗口长周期最多 ${plan.maxSlow}。请缩短周期或补充历史。`);
  const folds=plan.folds.map(({start,end})=>({start:bars[start].time,end:bars[end-1].time,bars:end-start,baseline:metrics(bars,baseline,market,start,end),candidate:metrics(bars,candidate,market,start,end)}));
  const aggregate=key=>({score:mean(folds.map(f=>score(f[key]))),meanReturn:mean(folds.map(f=>f[key].totalReturn)),maxDrawdown:Math.max(...folds.map(f=>f[key].maxDrawdown)),closedTrades:folds.reduce((s,f)=>s+f[key].closedTrades,0),fees:folds.reduce((s,f)=>s+f[key].fees,0)});
  const base=aggregate('baseline'),next=aggregate('candidate');
  const stressed=config({...candidate,feeBps:Math.min(100,candidate.feeBps*2),slippageBps:Math.min(200,candidate.slippageBps*2)});
  const stress=plan.folds.map(({start,end})=>metrics(bars,stressed,market,start,end));
  const perturbations=[{fast:candidate.fast-1},{fast:candidate.fast+1},{slow:candidate.slow-2},{slow:candidate.slow+2}].filter(x=>(x.fast??candidate.fast)>=2&&(x.fast??candidate.fast)<(x.slow??candidate.slow)&&(x.slow??candidate.slow)<=plan.maxSlow).map(x=>{const p=config({...candidate,...x});return {fast:p.fast,slow:p.slow,score:mean(plan.folds.map(({start,end})=>score(metrics(bars,p,market,start,end))))};});
  const reasons=[];
  if(candidate.feeBps>50||candidate.slippageBps>100)reasons.push('成本参数已接近上限，无法完成完整双倍成本检验');
  if(next.closedTrades<POLICY.minClosedTrades||folds.some(f=>f.candidate.closedTrades<2))reasons.push('成交样本不足（需累计12次平仓且每折至少2次）');
  if(next.score<=base.score+.001)reasons.push('扣费收益与回撤综合评分未改善');
  const wins=folds.filter(f=>score(f.candidate)>score(f.baseline)).length;if(wins<2)reasons.push('未在至少2个滚动区间改善');
  if(next.maxDrawdown>candidate.maxDrawdown||folds.some(f=>f.candidate.halted))reasons.push('触及回撤限制');
  if(mean(stress.map(m=>m.totalReturn))<=0)reasons.push('双倍成本情景平均收益不为正');
  if(perturbations.some(p=>p.score<next.score-.02))reasons.push('相邻参数表现下降超过2个百分点');
  const warmup=Math.max(baseline.slow,candidate.slow,60);
  return {policy:POLICY,objective:'各折平均（扣费收益 - 1.5 × 最大回撤）；开发评分，不是未来胜率',folds,aggregate:{baseline:base,candidate:next,improvedFolds:wins},stress:{feeBps:stressed.feeBps,slippageBps:stressed.slippageBps,meanReturn:mean(stress.map(m=>m.totalReturn)),worstDrawdown:Math.max(...stress.map(m=>m.maxDrawdown))},perturbations,decision:reasons.length?'rejected':'eligible',reasons,
    comparison:{training:{start:bars[warmup].time,end:bars[plan.trainEnd-1].time,bars:plan.trainEnd-warmup,baseline:metrics(bars,baseline,market,warmup,plan.trainEnd),candidate:metrics(bars,candidate,market,warmup,plan.trainEnd)},validation:{start:bars[plan.trainEnd].time,end:bars[plan.developmentEnd-1].time,bars:plan.developmentEnd-plan.trainEnd,baseline:metrics(bars,baseline,market,plan.trainEnd,plan.developmentEnd),candidate:metrics(bars,candidate,market,plan.trainEnd,plan.developmentEnd)}}};
}
// Memory is an explicit whitelist. Never serialize stored holdout results or model prose into prompts.
export function memoryProjection(e,session,regime){
  if(e.schemaVersion!==2||e.assetId!==session.assetId||e.source.provider!==session.source.provider||e.source.priceBasis!==session.source.priceBasis||e.outcomeEnd>session.bars[session.plan.developmentEnd-1].time||e.engineVersion!==ENGINE_VERSION||!e.evaluation)return null;
  return {id:e.id,name:e.name,config:e.config,regime:e.regime,sameRegime:e.regime===regime,outcomeEnd:e.outcomeEnd,development:e.evaluation.aggregate,decision:e.evaluation.decision,reasons:e.evaluation.reasons,stress:e.evaluation.stress,observations:e.evaluation.aggregate.candidate.closedTrades};
}
export async function retrieveMemory(db,session,regime){
  const rows=(await db.prepare("SELECT value FROM service_state WHERE key LIKE 'strategy_experiment:%' AND json_extract(value,'$.assetId')=? AND json_extract(value,'$.schemaVersion')=2 ORDER BY json_extract(value,'$.created') DESC LIMIT 60").bind(session.assetId).all()).results;
  const seen=new Set(),mem=rows.map(r=>memoryProjection(JSON.parse(r.value),session,regime)).filter(Boolean).sort((a,b)=>Number(b.sameRegime)-Number(a.sameRegime)||b.outcomeEnd-a.outcomeEnd);
  const diverse=mem.filter(m=>{const k=JSON.stringify(m.config);if(seen.has(k))return false;seen.add(k);return true;});
  const chosen=[];for(const decision of ['rejected','eligible']){const x=diverse.find(m=>m.decision===decision);if(x)chosen.push(x);}for(const x of diverse)if(chosen.length<5&&!chosen.includes(x))chosen.push(x);return chosen;
}
export async function researchSession(db,asset){
  // One fixed holdout per instrument, independent of changed prompts, costs or source switches.
  const key='research_active:'+asset.id,current=await readRecord(db,key);let old=current?await readRecord(db,'research_session:'+current.id):null;
  const cached=await readRecord(db,'research_market:'+asset.id);
  const useAdjusted=asset.source==='alpaca'&&cached?.source==='alpaca'&&cached.bars?.length>=240;
  const input=useAdjusted?cached.bars:JSON.parse(asset.data);
  if(old&&!old.finalized&&!old.closed){
    if(old.trialCount<POLICY.maxTrials||input.filter(b=>b.time>old.bars.at(-1).time).length<60)return old;
    old.closed={created:new Date().toISOString(),reason:'预算用尽且已有60根新日线；旧窗口未执行最终验收'};await putRecord(db,'research_session:'+old.id,old);
  }
  const bars=normalizeBars(input);
  if(old&&bars.filter(b=>b.time>old.bars.at(-1).time).length<60)throw new Problem(409,'本研究已完成最终验收；至少积累60根新的日线后才开启下一研究窗口，避免重复使用验收数据。');
  const plan=splitPlan(bars);if(old){const next=Math.max(plan.developmentEnd,bars.findIndex(b=>b.time>old.bars.at(-1).time));plan.developmentEnd=next;plan.trainEnd=Math.floor(next*.5);plan.maxSlow=Math.min(200,plan.trainEnd-10);plan.folds=Array.from({length:3},(_,k)=>({start:plan.trainEnd+Math.floor((next-plan.trainEnd)*k/3),end:plan.trainEnd+Math.floor((next-plan.trainEnd)*(k+1)/3)}));}
  const priceBasis=useAdjusted?'split':asset.market==='crypto'?'spot':'unverified';
  const source={provider:asset.source,symbol:asset.symbol,updated:useAdjusted?cached.updated:asset.updated,priceBasis};
  const session={id:crypto.randomUUID(),assetId:asset.id,market:asset.market,created:new Date().toISOString(),source,bars,plan,datasetHash:await digest({bars,source:source.provider,priceBasis}),audit:auditData(bars,asset.market,priceBasis),trialCount:0,finalized:null};
  await db.batch([db.prepare('INSERT INTO service_state(key,value) VALUES(?,?)').bind('research_session:'+session.id,JSON.stringify(session)),db.prepare('INSERT INTO service_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key,JSON.stringify({id:session.id}))]);return session;
}
export function sessionInfo(s){return {id:s.id,datasetHash:s.datasetHash,source:s.source,created:s.created,bars:s.bars.length,developmentEnd:s.bars[s.plan.developmentEnd-1].time,holdoutStart:s.bars[s.plan.developmentEnd].time,holdoutEnd:s.bars.at(-1).time,holdoutBars:s.bars.length-s.plan.developmentEnd,trialCount:s.trialCount,maxTrials:POLICY.maxTrials,audit:s.audit,closed:s.closed??null,finalized:s.finalized};}
export async function marketContext(db,asset,bars){
  const reference=asset.market==='us'?'us:SPY':'crypto:BTC-USDT';
  const cached=asset.market==='us'?await readRecord(db,'research_market:'+reference):null;
  const raw=!cached&&asset.market==='crypto'?await db.prepare('SELECT data FROM assets WHERE id=?').bind(reference).first():null;
  const benchmark=cached?.bars||(raw?JSON.parse(raw.data):[]),byTime=new Map(benchmark.map(b=>[b.time,b.close]));
  const aligned=bars.filter(b=>byTime.has(b.time)).slice(-61);
  if(reference===asset.id||aligned.length<21)return {reference,available:false,reason:'同标的或本地对齐基准不足21根，不推测缺失值'};
  const first=aligned[0],last=aligned.at(-1),a=[],b=[];for(let i=1;i<aligned.length;i++){a.push(aligned[i].close/aligned[i-1].close-1);b.push(byTime.get(aligned[i].time)/byTime.get(aligned[i-1].time)-1);}
  const ma=mean(a),mb=mean(b),cov=mean(a.map((v,i)=>(v-ma)*(b[i]-mb))),va=mean(a.map(v=>(v-ma)**2)),vb=mean(b.map(v=>(v-mb)**2));
  return {reference,available:true,asOf:last.time,observations:a.length,relativeReturn:(last.close/first.close-1)-(byTime.get(last.time)/byTime.get(first.time)-1),beta:vb>0?cov/vb:null,correlation:va>0&&vb>0?cov/Math.sqrt(va*vb):null,source:cached?'alpaca IEX split':'local daily'};
}
export async function executionMemory(db,session){
  const end=session.bars[session.plan.developmentEnd-1].time;
  const rows=(await db.prepare('SELECT id,data FROM paper_sessions WHERE asset_id=? ORDER BY created DESC LIMIT 10').bind(session.assetId).all()).results;
  return rows.map(row=>{const d=JSON.parse(row.data),trades=(d.portfolio?.trades||[]).filter(t=>t.time<=end),closed=trades.filter(t=>t.side==='sell');return {id:row.id,kind:'local_simulation_not_broker_fills',asOf:trades.at(-1)?.time,orders:trades.length,closedTrades:closed.length,realizedPnl:closed.reduce((s,t)=>s+t.pnl,0),fees:trades.reduce((s,t)=>s+t.fee,0),config:d.config};}).filter(x=>x.orders).slice(0,3);
}
