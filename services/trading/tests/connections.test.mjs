import {test} from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {putSecret,getSecret,saveSettings,settings,configured,orderPayload,previewOrder,submitOrder,beginOAuth,finishOAuth,deepseekModels} from '../server/connections.mjs';
function setup(t){const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE service_state(key TEXT PRIMARY KEY,value TEXT NOT NULL)');t.after(()=>db.close());const DB={prepare(q){let args=[];return {bind(...a){args=a;return this;},first(){return db.prepare(q).get(...args)},all(){return {results:db.prepare(q).all(...args)}},run(){return {meta:{changes:Number(db.prepare(q).run(...args).changes)}}}}}};return {DB,CONFIG_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64')};}
test('DeepSeek model discovery uses the saved key and only returns models supplied by the API',async()=>{
  await assert.rejects(()=>deepseekModels({}),e=>e.status===424);
  const result=await deepseekModels({DEEPSEEK_API_KEY:'test-key'},async(url,options)=>{
    assert.equal(url,'https://api.deepseek.com/models');assert.equal(options.headers.Authorization,'Bearer test-key');
    return Response.json({data:[{id:'new-model',name:'New Model',private:'not-returned'},{id:'new-model'},{id:''},{id:123}]});
  });
  assert.deepEqual(result,{models:[{id:'new-model',name:'new-model'}]});
  await assert.rejects(()=>deepseekModels({DEEPSEEK_API_KEY:'bad-key'},async()=>new Response('',{status:401})),/HTTP 401/);
  await assert.rejects(()=>deepseekModels({DEEPSEEK_API_KEY:'test-key'},async()=>Response.json({unexpected:true})),/列表格式无效/);
});
test('encrypted configuration is persisted without plaintext and only exposes presence',async t=>{const env=setup(t);await saveSettings(env,{values:{DEEPSEEK_API_KEY:'private-secret',DEEPSEEK_MODEL:'model'}});const raw=await env.DB.prepare('SELECT value FROM service_state WHERE key=?').bind('secret:DEEPSEEK_API_KEY').first();assert.ok(!raw.value.includes('private-secret'));assert.equal(await getSecret(env,'DEEPSEEK_API_KEY'),'private-secret');assert.equal((await configured(env)).DEEPSEEK_API_KEY,'private-secret');assert.ok(!JSON.stringify(await settings(env)).includes('private-secret'));await assert.rejects(()=>saveSettings(env,{values:{SCHWAB_LIVE_TRADING_ENABLED:'true'}}));await assert.rejects(()=>getSecret({...env,CONFIG_ENCRYPTION_KEY:Buffer.alloc(32,9).toString('base64')},'DEEPSEEK_API_KEY'));});
test('configuration status reads presence without decrypting API keys or account tokens',async t=>{
  const env=setup(t);await putSecret(env,'DEEPSEEK_API_KEY','private-secret');await putSecret(env,'schwab_tokens',{access_token:'private-token'});
  const status=await settings({...env,CONFIG_ENCRYPTION_KEY:undefined});
  assert.equal(status.configured.DEEPSEEK_API_KEY,true);assert.equal(status.schwabConnected,true);
  assert.equal(status.model,'');assert.ok(!JSON.stringify(status).includes('private'));
});
test('order validation and live gate prevent accidental submission',async()=>{const p=orderPayload({symbol:'AAPL',quantity:2,price:100,side:'BUY'});assert.equal(p.orderType,'LIMIT');assert.equal(p.orderLegCollection[0].quantity,2);for(const bad of [{price:.001},{quantity:11},{side:'SHORT'},{symbol:'<x>'},{quantity:1.5}])assert.throws(()=>orderPayload({symbol:'AAPL',quantity:2,price:100,side:'BUY',...bad}));await assert.rejects(()=>submitOrder({},{}),/尚未启用/);});
test('OAuth states bind identity and expire before any token request',async t=>{const env={...setup(t),SCHWAB_APP_KEY:'key',SCHWAB_APP_SECRET:'secret'},user={userId:'owner'};const {url}=await beginOAuth(env,user,'https://site.test');const u=new URL(url);assert.equal(u.searchParams.get('redirect_uri'),'https://site.test/schwab/callback');const callback=new URL('https://site.test/schwab/callback?code=test&state='+u.searchParams.get('state'));await assert.rejects(()=>finishOAuth(env,{userId:'other'},callback),/账号不匹配/);await assert.rejects(()=>finishOAuth(env,user,new URL('https://site.test/schwab/callback?code=test&state=unknown')),/无效/);});
test('Schwab submission claims a preview once and never retries uncertain orders',async t=>{
  const env={...setup(t),SCHWAB_LIVE_TRADING_ENABLED:'true'};
  await putSecret(env,'schwab_tokens',{access_token:'fake-test-token',expires:Date.now()+3600000});
  let posts=0,fail=false;
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    assert.equal(options.headers.Authorization,'Bearer fake-test-token');
    if(url.endsWith('/accounts/accountNumbers'))return Response.json([{hashValue:'testaccount'}]);
    assert.equal(url,'https://api.schwabapi.com/trader/v1/accounts/testaccount/orders');
    assert.equal(options.method,'POST');posts++;
    assert.equal(JSON.parse(options.body).orderType,'LIMIT');
    if(fail)throw Error('network failed after send');
    return new Response(null,{status:201,headers:{Location:'/orders/123'}});
  });
  const input={account:'testaccount',symbol:'AAPL',quantity:1,price:100,side:'BUY'};
  const first=await previewOrder(env,input);
  assert.equal((await submitOrder(env,{id:first.id,confirm:'SUBMIT_LIVE_ORDER'})).status,'accepted');
  await assert.rejects(()=>submitOrder(env,{id:first.id,confirm:'SUBMIT_LIVE_ORDER'}),/已提交/);
  fail=true;const second=await previewOrder(env,input);
  await assert.rejects(()=>submitOrder(env,{id:second.id,confirm:'SUBMIT_LIVE_ORDER'}),/禁止自动重试/);
  await assert.rejects(()=>submitOrder(env,{id:second.id,confirm:'SUBMIT_LIVE_ORDER'}),/已提交/);
  assert.equal(posts,2);
});
