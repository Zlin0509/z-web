import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {config,targets,backtest,validateRules} from '../server/engine.mjs';
import {saveStrategy,listStrategies,proposeStrategy,compareStrategies} from '../server/strategies.mjs';
import {init} from '../server/service.mjs';
import {handleRequest} from '../server/controller.mjs';
const day=86400000;
const bars=Array.from({length:240},(_,i)=>{const c=100+i*.1+8*Math.sin(i/8);return {time:Date.UTC(2025,0,1)+i*day,open:c-.4,close:c,high:c+2,low:c-2,volume:1000+i};});
const group=(left,op,right)=>({match:'all',conditions:[{left,op,right}]});
const rules={entry:group('sma_fast','gt','sma_slow'),exit:group('sma_fast','lt','sma_slow')};
const candidate=config({strategy:'custom',fast:5,slow:20,rules});
async function setup(t){const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec(readFileSync(new URL('../drizzle/0000_thick_randall_flagg.sql',import.meta.url),'utf8'));const DB={prepare(q){let args=[];return {bind(...a){args=a;return this;},first(){return db.prepare(q).get(...args)},all(){return {results:db.prepare(q).all(...args)}},run(){return {meta:{changes:Number(db.prepare(q).run(...args).changes)}}}}},batch(a){db.exec('BEGIN');try{const result=a.map(x=>x.run());db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}};await init(DB);await DB.prepare("UPDATE assets SET data=?,status='ready' WHERE id='us:AAPL'").bind(JSON.stringify(bars)).run();return {DB,DEEPSEEK_API_KEY:'test-secret',DEEPSEEK_MODEL:'selected-model',TRADING_OWNER_EMAIL:'owner@test.com'};}
const input={rounds:1,assetId:'us:AAPL',prompt:'减少震荡交易，控制回撤',mode:'optimize',config:config({fast:5,slow:30})};
const answer={name:'动量过滤',rationale:'使用快慢均线确认趋势',risks:['震荡期可能连续亏损'],config:candidate};
const reply=body=>Response.json({choices:[{message:{content:JSON.stringify(body)}}]});
test('custom rules reject executable input, unsupported fields and malformed groups',()=>{
  assert.deepEqual(validateRules(JSON.stringify(rules)),rules);
  for(const invalid of ['not json',{}, {...rules,entry:group('eval(1)','gt',0)},{...rules,entry:group('close','exec',0)},{...rules,entry:group('close','gt',Infinity)},{...rules,entry:{match:'all',conditions:[]}}])assert.throws(()=>validateRules(invalid));
});
test('custom crossover handles warmup, preserves held state and prioritizes exit',()=>{
  const sample=[1,3,4,1,3].map((close,i)=>({...bars[i],close}));
  const cross=config({...candidate,rules:{entry:group('close','crossAbove',2),exit:group('close','crossBelow',2)}});
  assert.deepEqual(targets(sample,cross),[false,true,true,false,true]);
  assert.deepEqual(targets(sample,config({...candidate,rules:{entry:group('close','gt',0),exit:group('close','gt',0)}})),Array(5).fill(false));
  assert.deepEqual(targets(bars.slice(0,10),candidate),Array(10).fill(false));
});
test('custom strategies trade at next open and future data cannot change past results',()=>{
  const full=backtest(bars,candidate),prefix=backtest(bars.slice(0,150),candidate);
  assert.deepEqual(full.curve.slice(0,prefix.curve.length),prefix.curve);assert.ok(full.trades.length>2);
  const signals=targets(bars,candidate);for(const trade of full.trades.filter(t=>t.side==='buy')){const index=bars.findIndex(b=>b.time===trade.time);assert.equal(signals[index-1],true);assert.equal(trade.price,bars[index].open*1.0005);}
});
test('training and validation use identical start dates for both candidates and reset capital',()=>{
  const base=config({slow:60}),comparison=compareStrategies(bars,base,candidate,'us');
  assert.equal(comparison.training.start,bars[60].time);assert.equal(comparison.training.end,bars[167].time);assert.equal(comparison.validation.start,bars[168].time);
  assert.deepEqual(comparison.validation.baseline,backtest(bars,base,'us',bars[168].time).metrics);
  assert.deepEqual(comparison.validation.candidate,backtest(bars,candidate,'us',bars[168].time).metrics);
  assert.equal(backtest(bars,candidate,'us',bars[168].time).curve[0].equity,candidate.initial);
});
test('strategy versions persist immutably and cannot attach a parent from another asset',async t=>{
  const env=await setup(t),first=await saveStrategy(env,{assetId:input.assetId,name:'v1',config:candidate});
  const second=await saveStrategy(env,{assetId:input.assetId,name:'v2',config:{...candidate,fast:6},parentId:first.id});
  const versions=(await listStrategies(env)).strategies;assert.equal(versions.length,2);assert.equal(versions.find(v=>v.id===first.id).config.fast,5);assert.equal(second.parentId,first.id);
  await assert.rejects(()=>saveStrategy(env,{assetId:'us:SPY',name:'wrong parent',config:candidate,parentId:first.id}),/其他标的/);
});
test('AI sees training only, uses selected model, enforces user risk/costs, and creates no orders',async t=>{
  const env=await setup(t);let calls=0;
  const result=await proposeStrategy(env,input,async(url,options)=>{calls++;assert.equal(url,'https://api.deepseek.com/chat/completions');const request=JSON.parse(options.body),context=JSON.parse(request.messages[1].content);assert.equal(request.model,'selected-model');assert.equal(context.trainingEnd,bars[95].time);assert.equal(context.trainingBars,96);assert.ok(context.recentTrainingBars.every(b=>b.time<=bars[95].time));assert.equal(context.validation,undefined);return reply({...answer,config:{...candidate,initial:1e9,feeBps:0,allocation:1,maxDrawdown:.9}});});
  assert.equal(result.config.initial,input.config.initial);assert.equal(result.config.feeBps,input.config.feeBps);assert.equal(result.config.allocation,input.config.allocation);assert.equal(result.config.maxDrawdown,input.config.maxDrawdown);assert.equal(result.execution,'research_only');assert.equal(result.comparison.validation.bars,96);
  assert.equal(env.DB.prepare('SELECT count(*) n FROM paper_sessions').first().n,0);assert.equal((await listStrategies(env)).strategies.length,0);
  await assert.rejects(()=>proposeStrategy(env,input,()=>{calls++;throw 0}),e=>e.status===429);assert.equal(calls,1);
});
test('invalid AI output is not saved and insufficient data avoids external calls',async t=>{
  const env=await setup(t);
  await assert.rejects(()=>proposeStrategy(env,input,async()=>reply({...answer,config:{...candidate,rules:{}}})),/入场/);
  assert.equal(env.DB.prepare("SELECT count(*) n FROM service_state WHERE key LIKE 'strategy_experiment:%'").first().n,0);
  await env.DB.prepare("DELETE FROM service_state WHERE key='strategy_ai_lock'").run();
  const fresh=await setup(t);await fresh.DB.prepare("UPDATE assets SET data=? WHERE id='us:AAPL'").bind(JSON.stringify(bars.slice(0,100))).run();
  await assert.rejects(()=>proposeStrategy(fresh,input,()=>{throw Error('must not call')}),/240/);
});
test('strategy and internal endpoints require owner identity; mutations require CSRF protection',async t=>{
  const env=await setup(t),owner={userId:'owner',email:'owner@test.com'};
  for(const path of ['/api/strategies','/api/strategies/propose','/api/strategies/research?asset=us:AAPL','/api/strategies/finalize','/internal/status','/internal/refresh']){const request=new Request('https://test.site'+path);assert.equal((await handleRequest(request,env,null)).status,401);assert.equal((await handleRequest(request,env,{userId:'other',email:'other@test.com'})).status,path.startsWith('/internal/')?401:403);}
  const request=new Request('https://test.site/api/strategies',{method:'POST',headers:{'content-type':'application/json',origin:'https://evil.test'},body:JSON.stringify({...input,name:'evil'})});assert.equal((await handleRequest(request,env,owner)).status,403);
});
