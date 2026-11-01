import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {putSecret,getSecret,saveSettings,settings,configured,beginOAuth,finishOAuth,accounts,previewOrder,submitOrder,cancelOrder,operationHistory,reconcileOrder} from '../server/connections.mjs';

async function fixture(t){
  const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());
  sqlite.exec('CREATE TABLE service_state(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  const DB={prepare(sql){let args=[];return {
    bind(...values){args=values;return this;},first(){return sqlite.prepare(sql).get(...args);},
    all(){return {results:sqlite.prepare(sql).all(...args)};},run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}};}
  };},batch(statements){sqlite.exec('BEGIN');try{const results=statements.map(s=>s.run());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
  const env={DB,CONFIG_ENCRYPTION_KEY:Buffer.alloc(32,5).toString('base64'),SCHWAB_APP_KEY:'test-key',SCHWAB_APP_SECRET:'test-secret',SCHWAB_LIVE_TRADING_ENABLED:'true'};
  await putSecret(env,'schwab_tokens',{access_token:'test-token',refresh_token:'test-refresh',expires:Date.now()+3600000,connectionId:'grant-1'});
  await write(env,'schwab_auth_status',{state:'connected',connectionId:'grant-1'});
  const state={posts:0,deletes:0,cash:10000,held:10,orders:[],status:'FILLED',post:()=>new Response(null,{status:201,headers:{Location:'https://api.schwabapi.com/trader/v1/accounts/testaccount/orders/123'}}),cancel:()=>new Response(null,{status:200}),token:()=>Response.json({access_token:'new-token',refresh_token:'new-refresh',expires_in:1800,token_type:'Bearer'})};
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    if(url.endsWith('/v1/oauth/token'))return state.token(url,options);
    assert.match(options.headers.Authorization,/^Bearer /);
    if(url.endsWith('/accounts/accountNumbers'))return Response.json([{hashValue:'testaccount'}]);
    if(url.endsWith('/accounts/testaccount?fields=positions'))return Response.json({securitiesAccount:{currentBalances:{cashAvailableForTrading:state.cash},positions:[{instrument:{symbol:'AAPL',assetType:'EQUITY'},longQuantity:state.held}]}});
    if(url.includes('/accounts/testaccount/orders?'))return Response.json(state.orders);
    if(url.endsWith('/accounts/testaccount/orders')&&options.method==='POST'){state.posts++;return state.post(url,options);}
    if(url.endsWith('/accounts/testaccount/orders/123')){
      if(options.method==='DELETE'){state.deletes++;return state.cancel(url,options);}
      return Response.json(state.order??{orderId:123,status:state.status,filledQuantity:1,remainingQuantity:0});
    }
    if(url.endsWith('/accounts?fields=positions'))return Response.json([]);
    throw Error('Unexpected request '+url);
  });
  return {env,state};
}
async function write(env,key,value){await env.DB.prepare('INSERT INTO service_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key,JSON.stringify(value)).run();}
async function read(env,key){return JSON.parse((await env.DB.prepare('SELECT value FROM service_state WHERE key=?').bind(key).first()).value);}
const input={account:'testaccount',symbol:'AAPL',quantity:1,price:100,side:'BUY'};
const submit=(env,preview)=>submitOrder(env,{id:preview.id,confirm:'SUBMIT_LIVE_ORDER'});

test('settings validate the whole request before mutation and unchanged app keys retain authorization',async t=>{
  const {env}=await fixture(t);
  await assert.rejects(()=>saveSettings(env,{values:{DEEPSEEK_API_KEY:'would-save',invalid:'bad'}}));
  assert.equal(await getSecret(env,'DEEPSEEK_API_KEY'),null);
  await saveSettings(env,{values:{SCHWAB_APP_KEY:'test-key'}});
  assert.ok(await getSecret(env,'schwab_tokens'));
  await saveSettings(env,{values:{SCHWAB_APP_SECRET:'changed'}});
  assert.equal(await getSecret(env,'schwab_tokens'),null);
  assert.equal((await settings(env)).schwabConnected,false);
});
test('OAuth binds callback origin and app configuration and consumes states once',async t=>{
  const {env}=await fixture(t),user={userId:'owner'};
  const link=await beginOAuth(env,user,'https://site.test'),state=new URL(link.url).searchParams.get('state');
  await assert.rejects(()=>finishOAuth(env,user,new URL('https://other.test/schwab/callback?code=test&state='+state)),/回调地址/);
  const callback=new URL('https://site.test/schwab/callback?code=test&state='+state);
  await finishOAuth(env,user,callback);
  assert.equal((await getSecret(env,'schwab_tokens')).access_token,'new-token');
  await assert.rejects(()=>finishOAuth(env,user,callback),/无效/);
  const second=await beginOAuth(env,user,'https://site.test');
  await saveSettings(env,{values:{SCHWAB_APP_KEY:'changed'}});
  await assert.rejects(()=>finishOAuth(env,user,new URL('https://site.test/schwab/callback?code=test&state='+new URL(second.url).searchParams.get('state'))),/无效/);
});
test('refresh rejects malformed lifetimes, marks expired authorization and serializes concurrent refreshes',async t=>{
  const {env,state}=await fixture(t);
  await putSecret(env,'schwab_tokens',{access_token:'old',refresh_token:'old-refresh',expires:0,connectionId:'grant-1',authorizedAt:100});
  state.token=()=>Response.json({access_token:'bad',expires_in:'1800'});
  await assert.rejects(()=>accounts(env),/授权响应无效/);
  assert.equal((await getSecret(env,'schwab_tokens')).access_token,'old');
  state.token=()=>new Response('',{status:400});
  await assert.rejects(()=>accounts(env),/授权已失效/);
  assert.equal((await settings(env)).schwabConnected,false);
  let release;state.token=()=>new Promise(resolve=>{release=()=>resolve(Response.json({access_token:'new',expires_in:1800}));});
  const first=accounts(env);
  while(!release)await new Promise(resolve=>setTimeout(resolve,1));
  await assert.rejects(()=>accounts(env),/授权正在更新/);
  release();await first;
  const token=await getSecret(env,'schwab_tokens');
  assert.equal(token.refresh_token,'old-refresh');assert.equal(token.authorizedAt,100);
});
test('an old refresh cannot overwrite new app configuration or remove a successor lease',async t=>{
  const {env,state}=await fixture(t);
  await putSecret(env,'schwab_tokens',{access_token:'old',refresh_token:'refresh',expires:0});
  state.token=async()=>{
    await saveSettings(env,{values:{SCHWAB_APP_KEY:'new-app'}});
    await write(env,'schwab_refresh_lock',{owner:'successor',until:Date.now()+45000});
    return Response.json({access_token:'stale',expires_in:1800});
  };
  await assert.rejects(()=>accounts(env),/配置已变化/);
  assert.equal(await getSecret(env,'schwab_tokens'),null);
  assert.equal((await read(env,'schwab_refresh_lock')).owner,'successor');
});
test('preflight rechecks balances and deducts outstanding sell reservations before sending',async t=>{
  const {env,state}=await fixture(t),preview=await previewOrder(env,input);
  state.cash=0;await assert.rejects(()=>submit(env,preview),/现金不足/);assert.equal(state.posts,0);
  state.cash=10000;state.held=2;state.orders=[{status:'WORKING',remainingQuantity:2,orderLegCollection:[{instruction:'SELL',quantity:2,instrument:{symbol:'AAPL'}}]}];
  await assert.rejects(()=>previewOrder(env,{...input,side:'SELL'}),/持仓不足/);
  assert.equal(state.posts,0);
});
test('concurrent previews cannot both submit and accepted orders require a broker status query',async t=>{
  const {env,state}=await fixture(t),a=await previewOrder(env,input),b=await previewOrder(env,input);
  const results=await Promise.allSettled([submit(env,a),submit(env,b)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(state.posts,1);
  await assert.rejects(()=>previewOrder(env,input),/结果待确认|待确认/);
  const accepted=results.find(r=>r.status==='fulfilled').value;
  assert.equal(accepted.status,'accepted');assert.equal(accepted.orderId,'123');
  const checked=await reconcileOrder(env,{id:accepted.id});
  assert.equal(checked.status,'filled');assert.equal(checked.brokerStatus,'FILLED');
  await previewOrder(env,input);
});
test('timeouts and malformed Locations persist unknown state and block new previews',async t=>{
  const {env,state}=await fixture(t),preview=await previewOrder(env,input);
  state.post=()=>{throw Error('timeout after possible acceptance');};
  await assert.rejects(()=>submit(env,preview),/禁止自动重试/);
  assert.equal((await read(env,'order:'+preview.id)).status,'unknown');
  await assert.rejects(()=>previewOrder(env,input),/待确认/);
  assert.equal(state.posts,1);
  state.order={orderId:123,status:'WORKING',enteredTime:new Date().toISOString(),orderType:'LIMIT',session:'NORMAL',duration:'DAY',orderStrategyType:'SINGLE',price:100,orderLegCollection:[{instruction:'BUY',quantity:1,instrument:{symbol:'AAPL',assetType:'EQUITY'}}]};
  await reconcileOrder(env,{id:preview.id,orderId:'123'});
  const second=await previewOrder(env,input);
  state.post=()=>new Response(null,{status:201,headers:{Location:'https://evil.test/trader/v1/accounts/testaccount/orders/123'}});
  await assert.rejects(()=>submit(env,second),/订单编号/);
  assert.equal((await read(env,'order:'+second.id)).status,'unknown');
});
test('definitive HTTP refusal remains distinct from an ambiguous transport or server failure',async t=>{
  const {env,state}=await fixture(t);
  state.post=()=>new Response('',{status:400});const rejected=await previewOrder(env,input);
  await assert.rejects(()=>submit(env,rejected),/拒绝提交/);
  assert.equal((await read(env,'order:'+rejected.id)).status,'rejected');
  state.post=()=>new Response('',{status:503});const uncertain=await previewOrder(env,input);
  await assert.rejects(()=>submit(env,uncertain),/禁止自动重试/);
  assert.equal((await read(env,'order:'+uncertain.id)).status,'unknown');
});
test('a reauthorization invalidates saved previews and reconciliation rejects a mismatched broker order',async t=>{
  const {env,state}=await fixture(t),preview=await previewOrder(env,input);
  await putSecret(env,'schwab_tokens',{access_token:'another',expires:Date.now()+3600000,connectionId:'grant-2'});
  await write(env,'schwab_auth_status',{state:'connected',connectionId:'grant-2'});
  await assert.rejects(()=>submit(env,preview),/授权账户已变化/);assert.equal(state.posts,0);
  const fresh=await previewOrder(env,input);state.post=()=>new Response(null,{status:201});
  await assert.rejects(()=>submit(env,fresh),/订单编号/);
  state.order={orderId:123,status:'FILLED',enteredTime:new Date().toISOString(),orderType:'LIMIT',session:'NORMAL',duration:'DAY',orderStrategyType:'SINGLE',price:100,orderLegCollection:[{instruction:'BUY',quantity:1,instrument:{symbol:'MSFT'}}]};
  await assert.rejects(()=>reconcileOrder(env,{id:fresh.id,orderId:'123'}),/不匹配/);
  assert.equal((await read(env,'order:'+fresh.id)).status,'unknown');
});
test('cancellation is persistent and idempotent and remains pending until broker confirmation',async t=>{
  const {env,state}=await fixture(t);state.status='WORKING';
  const input={account:'testaccount',orderId:'123',confirm:'CANCEL_LIVE_ORDER'};
  const result=await cancelOrder(env,input);assert.equal(result.status,'cancel_pending');
  await cancelOrder(env,input);assert.equal(state.deletes,1);
  assert.equal((await reconcileOrder(env,{id:result.id})).status,'cancel_pending');
  state.status='FILLED';assert.equal((await reconcileOrder(env,{id:result.id})).status,'filled');
  assert.ok((await operationHistory(env)).operations.length);
});
test('cancellation timeout stays unknown and queries can discover a fill racing with cancellation',async t=>{
  const {env,state}=await fixture(t);state.status='WORKING';state.cancel=()=>{throw Error('timeout');};
  await assert.rejects(()=>cancelOrder(env,{account:'testaccount',orderId:'123',confirm:'CANCEL_LIVE_ORDER'}),/未确认/);
  const operation=(await operationHistory(env)).operations[0];assert.equal(operation.status,'cancel_unknown');
  await assert.rejects(()=>previewOrder(env,input),/待确认/);
  state.status='FILLED';const result=await reconcileOrder(env,{id:operation.id});assert.equal(result.status,'filled');
  assert.equal(state.deletes,1);
});

test('a definitively refused cancellation can be explicitly retried while ambiguous cancellations cannot',async t=>{
  const {env,state}=await fixture(t);state.status='WORKING';state.cancel=()=>new Response('',{status:429});
  const request={account:'testaccount',orderId:'123',confirm:'CANCEL_LIVE_ORDER'};
  await assert.rejects(()=>cancelOrder(env,request));
  assert.equal((await operationHistory(env)).operations[0].status,'cancel_rejected');
  state.cancel=()=>new Response(null,{status:200});
  const next=await cancelOrder(env,request);assert.equal(next.status,'cancel_pending');assert.equal(state.deletes,2);
  await cancelOrder(env,request);assert.equal(state.deletes,2);
});
test('legacy accepted orders can be queried using their stored verified Location',async t=>{
  const {env}=await fixture(t);
  await write(env,'order:legacy-id',{account:'testaccount',status:'accepted',location:'https://api.schwabapi.com/trader/v1/accounts/testaccount/orders/123'});
  const result=await reconcileOrder(env,{id:'legacy-id'});
  assert.equal(result.orderId,'123');assert.equal(result.status,'filled');
});

test('a partially filled broker order preserves both filled and outstanding quantities',async t=>{
  const {env,state}=await fixture(t),preview=await previewOrder(env,{...input,quantity:2});
  await submit(env,preview);
  state.order={orderId:123,status:'WORKING',filledQuantity:1,remainingQuantity:1};
  const partial=await reconcileOrder(env,{id:preview.id});
  assert.equal(partial.status,'working');assert.equal(partial.filledQuantity,1);assert.equal(partial.remainingQuantity,1);
  state.order={orderId:123,status:'CANCELED',filledQuantity:1,remainingQuantity:1};
  const final=await reconcileOrder(env,{id:preview.id});assert.equal(final.status,'canceled');assert.equal(final.filledQuantity,1);
});
