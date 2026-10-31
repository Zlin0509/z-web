import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {config,featureSeries,indicators,targets,backtest} from '../server/engine.mjs';
import {splitPlan,evaluateCandidate,memoryProjection,researchSession,readRecord,putRecord,digest,ENGINE_VERSION,marketContext,executionMemory} from '../server/research.mjs';
import {proposeStrategy,finalizeResearch,researchHistory} from '../server/strategies.mjs';
import {refreshResearchData} from '../server/research-data.mjs';
import {init} from '../server/service.mjs';
const day=86400000;
const bars=Array.from({length:360},(_,i)=>{const c=100+i*.03+9*Math.sin(i/5);return {time:Date.UTC(2024,0,1)+i*day,open:c-.3,high:c+2,low:c-2,close:c,volume:1000+i*2};});
const group=(left,op,right)=>({match:'all',conditions:[{left,op,right}]});
const base=config({fast:5,slow:20});
const candidate=config({...base,strategy:'custom',rules:{entry:group('macd_histogram','gt',0),exit:group('macd_histogram','lt',0)}});
async function setup(t){const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec(readFileSync(new URL('../drizzle/0000_thick_randall_flagg.sql',import.meta.url),'utf8'));const DB={prepare(q){let args=[];return {bind(...a){args=a;return this;},first(){return db.prepare(q).get(...args)},all(){return {results:db.prepare(q).all(...args)}},run(){return {meta:{changes:Number(db.prepare(q).run(...args).changes)}}}}},batch(statements){db.exec('BEGIN');try{const result=statements.map(s=>s.run());db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}};await init(DB);await DB.prepare("UPDATE assets SET data=?,status='ready' WHERE id='crypto:BTC-USDT'").bind(JSON.stringify(bars)).run();return {DB,DEEPSEEK_API_KEY:'fake-key',DEEPSEEK_MODEL:'chosen-model'};}
const input={assetId:'crypto:BTC-USDT',mode:'optimize',prompt:'控制回撤，减少换手，检验趋势过滤',config:base,rounds:1};
const response=p=>Response.json({model:'actual-model',choices:[{message:{content:JSON.stringify({name:'candidate',rationale:'hypothesis only',risks:['cost'],config:p})}}]});
const unlock=env=>env.DB.prepare("DELETE FROM service_state WHERE key='strategy_ai_lock'").run();
test('all feature series are causal, match displayed indicators, and execute at next open',()=>{
  const all=featureSeries(bars,base,'us'),prefix=featureSeries(bars.slice(0,180),base,'us');for(const key of Object.keys(all))assert.deepEqual(all[key].slice(0,180),prefix[key],key);
  const shown=indicators(bars,'us');assert.equal(shown.atr14,all.atr14.at(-1));assert.equal(shown.macdHistogram,all.macd_histogram.at(-1));assert.equal(shown.volatility20,all.volatility20.at(-1));
  assert.equal(all.macd_signal[32],null);assert.ok(Number.isFinite(all.macd_signal[33]));assert.equal(all.return60[60],bars[60].close/bars[0].close-1);
  assert.equal(all.prior_high[20],Math.max(...bars.slice(0,20).map(b=>b.high)));
  const signals=targets(bars,candidate,'us'),run=backtest(bars,candidate,'us');assert.ok(run.trades.length>4);for(const t of run.trades.filter(t=>t.side==='buy')){const i=bars.findIndex(b=>b.time===t.time);assert.ok(signals[i-1]);assert.equal(t.price,bars[i].open*1.0005);}
});
test('rolling evaluation never consumes holdout and poor/zero-trade candidates fail acceptance',()=>{
  const plan=splitPlan(bars),dev=bars.slice(0,plan.developmentEnd),a=evaluateCandidate(dev,base,candidate,'crypto',plan);
  const changed=bars.map((b,i)=>i>=plan.developmentEnd?{...b,close:b.close*100,high:b.high*100,low:b.low*100,open:b.open*100}:b);
  assert.deepEqual(evaluateCandidate(changed,base,candidate,'crypto',plan),a);assert.equal(a.folds.length,3);assert.equal(a.stress.feeBps,base.feeBps*2);assert.ok(a.perturbations.length>=3);
  const idle=config({...candidate,rules:{entry:group('close','lt',0),exit:group('close','gt',0)}}),q=evaluateCandidate(dev,base,idle,'crypto',plan);assert.equal(q.decision,'rejected');assert.ok(q.reasons.some(s=>s.includes('成交样本不足')));
});
test('memory filters market/source/time/version and excludes holdout, model prose and unknown fields',async t=>{
  const env=await setup(t),asset=await env.DB.prepare("SELECT * FROM assets WHERE id='crypto:BTC-USDT'").first(),s=await researchSession(env.DB,asset);
  const e={schemaVersion:2,id:'x',assetId:asset.id,source:s.source,engineVersion:ENGINE_VERSION,outcomeEnd:bars[200].time,regime:'range:normal_vol',config:candidate,evaluation:evaluateCandidate(bars,base,candidate,'crypto',s.plan),holdout:{secret:'do-not-leak'},rationale:'do-not-leak'};
  const m=memoryProjection(e,s,e.regime);assert.ok(m);assert.equal(JSON.stringify(m).includes('do-not-leak'),false);
  for(const patch of [{outcomeEnd:bars[300].time},{assetId:'us:AAPL'},{source:{...s.source,provider:'csv'}},{engineVersion:'old'},{schemaVersion:1}])assert.equal(memoryProjection({...e,...patch},s,e.regime),null);
});
test('AI loop is bounded, persists attempts, deduplicates candidates, retrieves failures, and hides holdout',async t=>{
  const env=await setup(t);let count=0;const first=await proposeStrategy(env,{...input,rounds:2},async(_,options)=>{const req=JSON.parse(options.body),c=JSON.parse(req.messages[1].content);assert.equal(req.model,'chosen-model');assert.equal(c.trainingEnd,bars[143].time);assert.ok(c.recentTrainingBars.every(b=>b.time<=bars[143].time));assert.equal(c.holdout,undefined);if(count)assert.equal(c.feedback.length,1);count++;return response(candidate);});
  assert.equal(count,2);assert.equal(first.trials.length,2);assert.ok(first.trials[1].error.includes('重复'));assert.equal(first.session.trialCount,2);assert.equal(first.actualModel,'actual-model');assert.equal(first.evaluation.decision,'rejected');
  const session=await readRecord(env.DB,'research_session:'+first.sessionId);assert.equal(session.bars.length,360);assert.equal(await digest({bars,source:'okx',priceBasis:'spot'}),first.datasetHash);
  const attempts=(await env.DB.prepare("SELECT value FROM service_state WHERE key LIKE 'research_attempt:%'").all()).results;assert.equal(attempts.length,2);assert.equal(JSON.stringify(attempts).includes('fake-key'),false);
  await unlock(env);const next=await proposeStrategy(env,input,async(_,o)=>{const c=JSON.parse(JSON.parse(o.body).messages[1].content);assert.equal(c.memory.length,1);assert.equal(c.memory[0].id,first.id);assert.ok(c.memory[0].reasons.length);assert.equal(JSON.stringify(c.memory).includes('holdout'),false);return response({...candidate,fast:6});});assert.equal(next.memoryUsed,1);
  assert.equal(env.DB.prepare('SELECT count(*) n FROM paper_sessions').first().n,0);
});
test('data snapshots stay fixed, finalization freezes one strategy, and the next holdout uses new dates',async t=>{
  const env=await setup(t),first=await proposeStrategy(env,input,async()=>response(candidate));await unlock(env);
  const modified=bars.map((b,i)=>i>300?{...b,volume:999}:b);await env.DB.prepare("UPDATE assets SET data=? WHERE id='crypto:BTC-USDT'").bind(JSON.stringify(modified)).run();
  const asset=env.DB.prepare("SELECT * FROM assets WHERE id='crypto:BTC-USDT'").first();assert.deepEqual((await researchSession(env.DB,asset)).bars,bars);
  const result=await finalizeResearch(env,{experimentId:first.id});assert.equal(result.decision,'rejected');assert.equal(result.start,bars[288].time);assert.ok(await readRecord(env.DB,'strategy:'+first.id));
  await unlock(env);assert.deepEqual(await finalizeResearch(env,{experimentId:first.id}),result);await unlock(env);
  await assert.rejects(()=>proposeStrategy(env,input,()=>{throw Error('must not call')}),/60根/);
  const extra=Array.from({length:60},(_,i)=>({...bars.at(-1),time:bars.at(-1).time+(i+1)*day}));asset.data=JSON.stringify([...bars,...extra]);const newer=await researchSession(env.DB,asset);assert.ok(newer.bars[newer.plan.developmentEnd].time>result.end);assert.equal(newer.trialCount,0);
  const history=await researchHistory(env,input.assetId);assert.equal(history.experiments.length,1);
});
test('failed responses and duplicate requests consume a persistent budget without orders',async t=>{
  const env=await setup(t);let count=0;await assert.rejects(()=>proposeStrategy(env,{...input,rounds:3},async()=>{count++;return Response.json({choices:[{message:{content:'invalid'}}]});}),/有效策略/);assert.equal(count,3);
  const active=await readRecord(env.DB,'research_active:'+input.assetId),s=await readRecord(env.DB,'research_session:'+active.id);assert.equal(s.trialCount,3);s.trialCount=12;await putRecord(env.DB,'research_session:'+s.id,s);await unlock(env);
  await assert.rejects(()=>proposeStrategy(env,input,()=>{throw Error('must not call')}),/预算/);
});
test('adjusted research cache uses a separate daily snapshot, retains failures, and never overwrites raw assets',async t=>{
  const env=await setup(t);env.ALPACA_API_KEY='test';env.ALPACA_SECRET_KEY='test';await env.DB.prepare("UPDATE assets SET source='alpaca',data=? WHERE id='us:AAPL'").bind(JSON.stringify(bars)).run();let calls=0;
  const fetcher=async url=>{calls++;const u=new URL(url);assert.equal(u.searchParams.get('adjustment'),'split');assert.equal(u.searchParams.get('feed'),'iex');assert.ok(Date.now()-Date.parse(u.searchParams.get('start'))>1800*day);return Response.json({bars:bars.map(b=>({t:new Date(b.time).toISOString(),o:b.open,h:b.high,l:b.low,c:b.close,v:b.volume}))});};
  await refreshResearchData(env,'us:AAPL',fetcher);assert.equal(calls,2);await refreshResearchData(env,'us:AAPL',fetcher);assert.equal(calls,2);
  const cache=await readRecord(env.DB,'research_market:us:AAPL');assert.equal(cache.adjustment,'split');assert.equal(cache.bars.length,360);assert.equal(env.DB.prepare("SELECT data FROM assets WHERE id='us:AAPL'").first().data,JSON.stringify(bars));
  cache.updated='2000-01-01';await putRecord(env.DB,'research_market:us:AAPL',cache);const report=await refreshResearchData(env,'us:AAPL',async()=>new Response('',{status:503}));assert.equal(report[0].status,'error');assert.deepEqual((await readRecord(env.DB,'research_market:us:AAPL')).bars,cache.bars);
});
test('benchmark alignment and execution memory exclude observations after development cutoff',async t=>{
  const env=await setup(t);await putRecord(env.DB,'research_market:us:SPY',{bars:bars.map(b=>({...b,close:b.close*2}))});
  const m=await marketContext(env.DB,{id:'us:AAPL',market:'us'},bars.slice(0,120));assert.equal(m.asOf,bars[119].time);assert.equal(m.relativeReturn,0);assert.ok(Math.abs(m.beta-1)<1e-10);
  const asset=env.DB.prepare("SELECT * FROM assets WHERE id='crypto:BTC-USDT'").first(),s=await researchSession(env.DB,asset);
  await env.DB.prepare("INSERT INTO paper_sessions(id,asset_id,created,status,data) VALUES('paper',?,'2025-01-01','stopped',?)").bind(asset.id,JSON.stringify({config:base,portfolio:{trades:[{time:bars[200].time,side:'sell',fee:1,pnl:10},{time:bars[300].time,side:'sell',fee:999,pnl:999}]}})).run();
  const memory=await executionMemory(env.DB,s);assert.equal(memory[0].fees,1);assert.equal(memory[0].realizedPnl,10);assert.equal(memory[0].kind,'local_simulation_not_broker_fills');
});
test('indicator units and warmup agree with hand-calculated constant and linear prices',()=>{
  const flat=bars.slice(0,100).map(b=>({...b,open:100,close:100,high:102,low:98,volume:1000})),f=featureSeries(flat,base,'us');
  assert.equal(f.atr14.at(-1),4);assert.equal(f.atr_pct.at(-1),.04);assert.equal(f.rvol.at(-1),1);assert.equal(f.rsi14.at(-1),50);assert.equal(f.volatility20.at(-1),0);assert.equal(f.bollinger_pct.at(-1),.5);assert.equal(f.macd_histogram.at(-1),0);
  const linear=flat.map((b,i)=>({...b,open:100+i,close:100+i,high:102+i,low:98+i})),g=featureSeries(linear,base,'us');assert.equal(g.return20[99],199/179-1);assert.equal(g.rsi14[99],100);assert.ok(Math.abs(g.macd[99]-7)<1e-8);
});
test('a second candidate cannot be finalized after a different one is frozen',async t=>{
  const env=await setup(t);let n=0;const r=await proposeStrategy(env,{...input,rounds:2},async()=>response({...candidate,fast:5+n++}));await unlock(env);
  const other=r.trials.find(x=>x.id!==r.id);await finalizeResearch(env,{experimentId:r.id});await unlock(env);await assert.rejects(()=>finalizeResearch(env,{experimentId:other.id}),/不能重复/);
});
test('exhausted windows can advance on new data even when no valid candidate was produced',async t=>{
  const env=await setup(t),asset=env.DB.prepare("SELECT * FROM assets WHERE id='crypto:BTC-USDT'").first(),old=await researchSession(env.DB,asset);old.trialCount=12;await putRecord(env.DB,'research_session:'+old.id,old);
  assert.equal((await researchSession(env.DB,asset)).id,old.id);
  asset.data=JSON.stringify([...bars,...Array.from({length:60},(_,i)=>({...bars.at(-1),time:bars.at(-1).time+(i+1)*day}))]);const next=await researchSession(env.DB,asset);assert.notEqual(next.id,old.id);assert.ok((await readRecord(env.DB,'research_session:'+old.id)).closed);assert.ok(next.bars[next.plan.developmentEnd].time>old.bars.at(-1).time);
});

test('latest indicator summaries exactly match full research series across warmups, markets and price paths',()=>{
  const names={close:'close',sma20:'sma20',ema20:'ema20',rsi14:'rsi14',macd:'macd',macdSignal:'macd_signal',macdHistogram:'macd_histogram',bollingerUpper:'bollinger_upper',bollingerLower:'bollinger_lower',atr14:'atr14',volatility20:'volatility20',volume:'volume'};
  for(const market of ['us','crypto'])for(const shape of ['flat','trend','gaps'])for(const n of [0,2,13,14,19,20,21,26,33,34,120,1254,2500]){
    const sample=Array.from({length:n},(_,i)=>{const close=shape==='flat'?100:shape==='trend'?100+i*.1:100+i*.01+20*Math.sin(i/7);return {time:i*day,open:close-.5,high:close+2,low:close-2,close,volume:i%11===0?0:1000+i};});
    const full=featureSeries(sample,undefined,market),shown=indicators(sample,market);
    for(const [key,series] of Object.entries(names))assert.equal(shown[key],full[series].at(-1)??null,`${market}/${shape}/${n}/${key}`);
  }
});
