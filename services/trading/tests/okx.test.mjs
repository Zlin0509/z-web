import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {decimal,formatDecimal,checkOKX,previewOKX,submitOKX,reconcileOKX,cancelOKX,historyOKX,readOKX,writeOKX,refreshOKXOrders} from '../server/okx.mjs';
import {startOKXStrategy,refreshOKX,stopOKXStrategy,listOKXStrategies} from '../server/okx-runner.mjs';
import {saveSettings,configured,settings} from '../server/connections.mjs';
import {handleRequest} from '../server/controller.mjs';
import {init,removeAsset,removeAssets} from '../server/service.mjs';
const interval=900000,end=Math.floor((Date.now()-30000)/interval)*interval;
const bars=Array.from({length:300},(_,i)=>({time:end-(300-i)*interval,open:90+i*.03,close:90+i*.03,high:100+i*.03,low:80+i*.03,volume:1000}));
const instrument={instId:'BTC-USDT',instType:'SPOT',baseCcy:'BTC',quoteCcy:'USDT',state:'live',tickSz:'0.1',lotSz:'0.00001',minSz:'0.0001'};
const input={mode:'demo',instId:'BTC-USDT',side:'buy',px:'100',sz:'1'};
async function fixture(t){
  const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());sqlite.exec(readFileSync(new URL('../drizzle/0000_thick_randall_flagg.sql',import.meta.url),'utf8'));
  const DB={prepare(sql){let args=[];return {bind(...values){args=values;return this;},first(){return sqlite.prepare(sql).get(...args);},all(){return {results:sqlite.prepare(sql).all(...args)};},run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}};}};},batch(statements){sqlite.exec('BEGIN');try{const results=statements.map(s=>s.run());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
  await init(DB);
  const env={DB,CONFIG_ENCRYPTION_KEY:Buffer.alloc(32,6).toString('base64'),TRADING_OWNER_EMAIL:'owner@test.com',OKX_DEMO_API_KEY:'demo-key',OKX_DEMO_SECRET_KEY:'demo-secret',OKX_DEMO_PASSPHRASE:'demo-pass',OKX_LIVE_API_KEY:'live-key',OKX_LIVE_SECRET_KEY:'live-secret',OKX_LIVE_PASSPHRASE:'live-pass',OKX_REGION:'global'};
  const state={posts:0,cancels:0,gets:0,balances:[{ccy:'USDT',availBal:'10000',eq:'10000',frozenBal:'0'},{ccy:'BTC',availBal:'10',eq:'10',frozenBal:'0'}],orders:new Map(),post:null,metadata:{...instrument},uid:'account-1'};
  env.OKX_FETCH=async(url,options)=>{
    const u=new URL(url);assert.equal(u.origin,'https://openapi.okx.com');
    if(u.pathname==='/api/v5/public/time')return Response.json({code:'0',data:[{ts:String(Date.now())}]});
    if(u.pathname==='/api/v5/public/instruments')return Response.json({code:'0',data:[state.metadata]});
    if(u.pathname==='/api/v5/market/ticker')return Response.json({code:'0',data:[{instId:'BTC-USDT',bidPx:'100',askPx:'100',ts:String(Date.now())}]});
    const mode=options.headers['x-simulated-trading']==='1'?'demo':'live';
    assert.equal(options.headers['OK-ACCESS-KEY'],mode+'-key');assert.equal(options.headers['OK-ACCESS-PASSPHRASE'],mode+'-pass');
    const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(mode+'-secret'),{name:'HMAC',hash:'SHA-256'},false,['sign']);
    const signature=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(options.headers['OK-ACCESS-TIMESTAMP']+options.method+u.pathname+u.search+(options.body||'')));
    assert.equal(options.headers['OK-ACCESS-SIGN'],Buffer.from(signature).toString('base64'));
    if(u.pathname==='/api/v5/account/config')return Response.json({code:'0',data:[{uid:state.uid,acctLv:'1',perm:'read_only,trade'}]});
    if(u.pathname==='/api/v5/account/balance')return Response.json({code:'0',data:[{details:state.balances}]});
    if(u.pathname==='/api/v5/trade/order'&&options.method==='POST'){
      state.posts++;assert.ok(Number(options.headers.expTime)>Date.now());
      const payload=JSON.parse(options.body),ordId=String(1000+state.posts);
      state.orders.set(payload.clOrdId,{...payload,ordId,state:'live',accFillSz:'0',avgPx:'0',fee:'0',feeCcy:'USDT'});
      if(state.post)return state.post(payload,ordId);
      return Response.json({code:'0',data:[{clOrdId:payload.clOrdId,ordId,sCode:'0'}]});
    }
    if(u.pathname==='/api/v5/trade/order'){
      state.gets++;const item=[...state.orders.values()].find(x=>u.searchParams.get('ordId')===x.ordId||u.searchParams.get('clOrdId')===x.clOrdId);
      return item?Response.json({code:'0',data:[item]}):Response.json({code:'51603',msg:'does not exist',data:[]});
    }
    if(u.pathname==='/api/v5/trade/cancel-order'){
      state.cancels++;const payload=JSON.parse(options.body),item=[...state.orders.values()].find(x=>x.ordId===payload.ordId);
      if(state.cancel)return state.cancel(item);
      item.state='canceled';return Response.json({code:'0',data:[{ordId:item.ordId,clOrdId:item.clOrdId,sCode:'0'}]});
    }
    if(u.pathname==='/api/v5/trade/orders-pending'||u.pathname==='/api/v5/trade/orders-history')return Response.json({code:'0',data:[...state.orders.values()]});
    throw Error('Unexpected endpoint '+u.pathname);
  };
  return {env,state};
}
const submit=(env,p,mode='demo')=>submitOKX(env,{id:p.id,confirm:mode==='demo'?'SUBMIT_OKX_DEMO_ORDER':'SUBMIT_OKX_LIVE_ORDER'});
async function minuteSeries(env){
  await writeOKX(env.DB,'market_series:15m:crypto:BTC-USDT',{assetId:'crypto:BTC-USDT',timeframe:'15m',generation:'test',revision:1,source:'okx',bars,status:'ready'});
}
const strategyInput={assetId:'crypto:BTC-USDT',mode:'demo',confirm:'START_OKX_DEMO_STRATEGY',config:{timeframe:'15m',fast:5,slow:20,initial:1000,allocation:.25}};

test('decimal validation uses exact steps and limits without floating point rounding',async t=>{
  assert.equal(formatDecimal(decimal('0.000000000000000001')),'0.000000000000000001');assert.throws(()=>decimal('1e-8'));
  const {env}=await fixture(t);
  for(const bad of [{px:'100.01'},{sz:'0.000001'},{sz:'11'},{instId:'BTC-USDT-SWAP'},{side:'short'},{px:'200'}])await assert.rejects(()=>previewOKX(env,{...input,...bad}));
});
test('configuration is encrypted, distinguishes environments, and needs all three credential fields',async t=>{
  const {env}=await fixture(t);
  await saveSettings(env,{values:{OKX_DEMO_API_KEY:'demo-key',OKX_DEMO_PASSPHRASE:'persisted-pass',OKX_REGION:'global'}});
  const raw=await env.DB.prepare("SELECT value FROM service_state WHERE key='secret:OKX_DEMO_PASSPHRASE'").first();assert.ok(!raw.value.includes('persisted-pass'));
  const status=await settings(env);assert.equal(status.configured.OKX_DEMO_API_KEY,true);assert.equal(status.okxRegion,'global');assert.ok(!JSON.stringify(status).includes('demo-pass'));
  await assert.rejects(()=>checkOKX({...env,OKX_LIVE_PASSPHRASE:undefined},'live'),/Passphrase/);
  await assert.rejects(()=>saveSettings(env,{values:{OKX_REGION:'http://internal'}}));
});
test('demo uses its own signed headers and live submissions require the separate live switch',async t=>{
  const {env,state}=await fixture(t);assert.equal((await checkOKX(env,'demo')).mode,'demo');assert.equal((await checkOKX(env,'live')).mode,'live');
  const live=await previewOKX(env,{...input,mode:'live'});
  await assert.rejects(()=>submit(env,live,'live'),/实盘提交开关/);assert.equal(state.posts,0);
  env.OKX_LIVE_TRADING_ENABLED='true';await assert.rejects(()=>submit(env,live),/明确确认/);
  await submit(env,live,'live');assert.equal(state.posts,1);
});
test('concurrent submissions claim one intent and unresolved orders block new previews',async t=>{
  const {env,state}=await fixture(t),a=await previewOKX(env,input),b=await previewOKX(env,input);
  const result=await Promise.allSettled([submit(env,a),submit(env,b)]);assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.equal(state.posts,1);
  await assert.rejects(()=>previewOKX(env,input),/未结束/);
  const id=result.find(r=>r.status==='fulfilled').value.id;
  await assert.rejects(()=>submit(env,{id}),/已提交/);
});
test('transport timeout is reconciled by the original clOrdId and never replayed',async t=>{
  const {env,state}=await fixture(t),p=await previewOKX(env,input);
  state.post=()=>{throw Error('timeout after acceptance');};
  await assert.rejects(()=>submit(env,p),/结果待确认/);assert.equal((await readOKX(env.DB,'okx:operation:'+p.id)).status,'unknown');
  await assert.rejects(()=>previewOKX(env,input),/未结束/);
  const order=state.orders.get(p.payload.clOrdId);order.state='filled';order.accFillSz='1';order.avgPx='100';
  const reconciled=await reconcileOKX(env,{id:p.id});assert.equal(reconciled.status,'filled');assert.equal(reconciled.accFillSz,'1');assert.equal(state.posts,1);
  await previewOKX(env,input);
});
test('HTTP 200 with per-order rejection fails and malformed acceptance remains unknown',async t=>{
  const {env,state}=await fixture(t),p=await previewOKX(env,input);
  state.post=()=>Response.json({code:'1',data:[{sCode:'51008',sMsg:'insufficient funds'}]});
  await assert.rejects(()=>submit(env,p),/51008/);assert.equal((await readOKX(env.DB,'okx:operation:'+p.id)).status,'rejected');
  const another=await previewOKX(env,input);state.post=()=>Response.json({code:'0',data:[{sCode:'0',ordId:'1',clOrdId:'wrong'}]});
  await assert.rejects(()=>submit(env,another),/待确认/);assert.equal((await readOKX(env.DB,'okx:operation:'+another.id)).status,'unknown');
});
test('preflight rechecks balances and credentials and rejects expired previews',async t=>{
  const {env,state}=await fixture(t),p=await previewOKX(env,input);state.balances[0].availBal='0';
  await assert.rejects(()=>submit(env,p),/余额不足/);assert.equal(state.posts,0);state.balances[0].availBal='10000';
  await saveSettings(env,{values:{OKX_REGION:'us'}});
  await assert.rejects(()=>submit(env,p),/操作已更新/);assert.equal(state.posts,0);
});
test('cancel requests are persistent and querying cancellation updates both records with partial fills',async t=>{
  const {env,state}=await fixture(t),p=await previewOKX(env,input);await submit(env,p);
  const order=state.orders.get(p.payload.clOrdId);order.state='partially_filled';order.accFillSz='0.5';order.avgPx='100';
  const canceled=await cancelOKX(env,{id:p.id,confirm:'CANCEL_OKX_DEMO_ORDER'});assert.equal(canceled.status,'cancel_pending');
  await reconcileOKX(env,{id:canceled.id});
  const parent=await readOKX(env.DB,'okx:operation:'+p.id);assert.equal(parent.status,'canceled');assert.equal(parent.accFillSz,'0.5');assert.equal(state.cancels,1);
  await cancelOKX(env,{id:p.id,confirm:'CANCEL_OKX_DEMO_ORDER'});assert.equal(state.cancels,1);
  await previewOKX(env,input);
});
test('cancel timeout retains an unknown record and background queries find the final result',async t=>{
  const {env,state}=await fixture(t),p=await previewOKX(env,input);await submit(env,p);
  state.cancel=order=>{order.state='filled';order.accFillSz='1';order.avgPx='100';throw Error('timeout');};
  await assert.rejects(()=>cancelOKX(env,{id:p.id,confirm:'CANCEL_OKX_DEMO_ORDER'}));
  await refreshOKXOrders(env);assert.equal((await readOKX(env.DB,'okx:operation:'+p.id)).status,'filled');
  assert.equal((await historyOKX(env)).operations.find(x=>x.kind==='cancel').status,'filled');assert.equal(state.cancels,1);
});
test('reconciliation validates account identity, order parameters and monotonic fill quantities',async t=>{
  const {env,state}=await fixture(t),p=await previewOKX(env,input);await submit(env,p);state.uid='wrong';
  await assert.rejects(()=>reconcileOKX(env,{id:p.id}),/不匹配/);state.uid='account-1';
  const order=state.orders.get(p.payload.clOrdId);order.px='99';await assert.rejects(()=>reconcileOKX(env,{id:p.id}),/不匹配/);order.px='100';
  order.state='partially_filled';order.accFillSz='0.5';await reconcileOKX(env,{id:p.id});order.accFillSz='0.4';await assert.rejects(()=>reconcileOKX(env,{id:p.id}),/累计成交/);
});
test('demo strategy starts at the watermark, submits once for a new bar and books exchange fills including base fees',async t=>{
  const {env,state}=await fixture(t);await minuteSeries(env);
  const started=await startOKXStrategy(env,strategyInput);assert.equal(started.mode,'demo');await refreshOKX(env);assert.equal(state.posts,0);
  const series=await readOKX(env.DB,'market_series:15m:crypto:BTC-USDT');series.bars.push({...bars.at(-1),time:end,close:100});
  // Freeze time past this bar's close to exercise the completed-bar path.
  const now=Date.now;t.mock.method(Date,'now',()=>Math.max(now(),end+interval+1000));
  await writeOKX(env.DB,'market_series:15m:crypto:BTC-USDT',series);await refreshOKX(env);assert.equal(state.posts,1);
  await refreshOKX(env);assert.equal(state.posts,1);
  const order=[...state.orders.values()][0];order.state='filled';order.accFillSz=order.sz;order.avgPx=order.px;order.fee='-0.00001';order.feeCcy='BTC';
  await refreshOKX(env);
  const runner=(await listOKXStrategies(env)).strategies[0];assert.equal(decimal(runner.owned),decimal(order.sz)-decimal('0.00001'));assert.equal(runner.pendingId,null);
  await stopOKXStrategy(env,{id:started.id});assert.equal((await listOKXStrategies(env)).strategies[0].status,'stopped');
});
test('strategies reject live mode, duplicate instruments, stale data and stop before an order can send',async t=>{
  const {env,state}=await fixture(t);await minuteSeries(env);
  await assert.rejects(()=>startOKXStrategy(env,{...strategyInput,mode:'live'}));
  const started=await startOKXStrategy(env,strategyInput);await assert.rejects(()=>startOKXStrategy(env,strategyInput),/已有运行策略/);
  const preview=await previewOKX(env,{...input,runnerId:started.id});
  const runner=await readOKX(env.DB,'okx:strategy:'+started.id);await writeOKX(env.DB,'okx:strategy:'+started.id,{...runner,pendingId:preview.id});await stopOKXStrategy(env,{id:started.id});
  await assert.rejects(()=>submit(env,preview),/策略已停止/);assert.equal(state.posts,0);
});
test('OKX endpoints enforce owner identity and CSRF, while status reads never call exchange APIs',async t=>{
  const {env}=await fixture(t),user={userId:'owner',email:'owner@test.com'};
  for(const path of ['/api/okx/status','/api/okx/activity','/api/okx/strategies'])assert.equal((await handleRequest(new Request('https://test'+path),env,null)).status,401);
  const response=await handleRequest(new Request('https://test/api/okx/status'),env,user);assert.equal(response.status,200);assert.ok(!JSON.stringify(await response.json()).includes('demo-secret'));
  const check=await handleRequest(new Request('https://test/api/okx/check',{method:'POST',headers:{'Content-Type':'application/json',origin:'https://test','X-Trading-Request':'1'},body:JSON.stringify({mode:'demo'})}),env,user);assert.equal(check.status,200);assert.equal((await check.json()).mode,'demo');
  const denied=await handleRequest(new Request('https://test/api/okx/submit',{method:'POST',headers:{'Content-Type':'application/json',origin:'https://evil'},body:'{}'}),env,user);assert.equal(denied.status,403);
});

test('a strategy transport timeout waits for reconciliation instead of replaying the order',async t=>{
  const {env,state}=await fixture(t);await minuteSeries(env);await startOKXStrategy(env,strategyInput);
  const series=await readOKX(env.DB,'market_series:15m:crypto:BTC-USDT');series.bars.push({...bars.at(-1),time:end,close:100});
  const now=Date.now;t.mock.method(Date,'now',()=>Math.max(now(),end+interval+1000));await writeOKX(env.DB,'market_series:15m:crypto:BTC-USDT',series);
  state.post=()=>{throw Error('response lost');};await refreshOKX(env);
  const waiting=(await listOKXStrategies(env)).strategies[0];assert.equal(waiting.status,'running');assert.ok(waiting.pendingId);assert.equal(state.posts,1);
  const order=[...state.orders.values()][0];order.state='filled';order.accFillSz=order.sz;order.avgPx=order.px;
  await refreshOKX(env);const updated=(await listOKXStrategies(env)).strategies[0];assert.equal(updated.pendingId,null);assert.equal(updated.status,'running');assert.equal(state.posts,1);
});

test('stale demo limit orders request cancellation once and reconcile before a new signal',async t=>{
  const {env,state}=await fixture(t);await minuteSeries(env);await startOKXStrategy(env,strategyInput);
  const series=await readOKX(env.DB,'market_series:15m:crypto:BTC-USDT');series.bars.push({...bars.at(-1),time:end,close:100});
  const now=Date.now;t.mock.method(Date,'now',()=>Math.max(now(),end+interval+1000));await writeOKX(env.DB,'market_series:15m:crypto:BTC-USDT',series);await refreshOKX(env);
  const runner=(await listOKXStrategies(env)).strategies[0],order=await readOKX(env.DB,'okx:operation:'+runner.pendingId);
  await writeOKX(env.DB,'okx:operation:'+order.id,{...order,sentAt:Date.now()-3*interval});await refreshOKX(env);assert.equal(state.cancels,1);
  await refreshOKX(env);assert.equal(state.cancels,1);assert.equal(state.posts,1);assert.equal((await listOKXStrategies(env)).strategies[0].pendingId,null);
});
test('drawdown and missing history pause new demo orders with a recorded reason',async t=>{
  const {env,state}=await fixture(t);await minuteSeries(env);const started=await startOKXStrategy(env,strategyInput);
  const series=await readOKX(env.DB,'market_series:15m:crypto:BTC-USDT');series.bars.push({...bars.at(-1),time:end,close:100});
  const now=Date.now;t.mock.method(Date,'now',()=>Math.max(now(),end+interval+1000));await writeOKX(env.DB,'market_series:15m:crypto:BTC-USDT',series);
  const runner=await readOKX(env.DB,'okx:strategy:'+started.id);await writeOKX(env.DB,'okx:strategy:'+runner.id,{...runner,cash:'500'});await refreshOKX(env);
  const halted=(await listOKXStrategies(env)).strategies[0];assert.equal(halted.status,'paused');assert.match(halted.message,/回撤阈值/);assert.equal(state.posts,0);
  await writeOKX(env.DB,'okx:strategy:'+runner.id,runner);series.bars=series.bars.filter(b=>b.time!==runner.lastTime);await writeOKX(env.DB,'market_series:15m:crypto:BTC-USDT',series);await refreshOKX(env);
  assert.match((await listOKXStrategies(env)).strategies[0].message,/历史存在缺口/);assert.equal(state.posts,0);
});


test('single and bulk watchlist removal stop OKX signals while preserving exchange operation history',async t=>{
  const {env}=await fixture(t);await minuteSeries(env);const started=await startOKXStrategy(env,strategyInput);
  const asset=await env.DB.prepare('SELECT revision FROM assets WHERE id=?').bind(strategyInput.assetId).first();
  await removeAsset(env.DB,strategyInput.assetId,asset.revision);assert.equal((await listOKXStrategies(env)).strategies[0].status,'stopped');
  await env.DB.prepare("INSERT INTO assets(id,symbol,market,source) VALUES('crypto:BTC-USDT','BTC-USDT','crypto','okx')").run();await minuteSeries(env);
  const second=await startOKXStrategy(env,strategyInput);await removeAssets(env.DB,[{assetId:strategyInput.assetId,revision:0}]);
  assert.equal((await readOKX(env.DB,'okx:strategy:'+second.id)).status,'stopped');assert.ok(await readOKX(env.DB,'okx:strategy:'+started.id));
});
