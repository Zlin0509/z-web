import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {init} from '../server/service.mjs';
import {saveStrategy} from '../server/strategies.mjs';
import {libraryList,libraryItem,saveDraft,manageLibrary} from '../server/strategy-library.mjs';
import {handleRequest} from '../server/controller.mjs';
async function setup(t){const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec(readFileSync(new URL('../drizzle/0000_thick_randall_flagg.sql',import.meta.url),'utf8'));const DB={prepare(q){let args=[];return {bind(...a){args=a;return this;},first(){return db.prepare(q).get(...args)},all(){return {results:db.prepare(q).all(...args)}},run(){return {meta:{changes:Number(db.prepare(q).run(...args).changes)}}}}},batch(a){db.exec('BEGIN');try{const r=a.map(x=>x.run());db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}};await init(DB);return {DB,TRADING_OWNER_EMAIL:'owner@test.com'};}
const draft={id:'draft-a',revision:0,name:'AAPL 趋势草稿',assetId:'us:AAPL',goal:'减少换手',rounds:2,editor:{strategy:'custom',rules:'{unfinished',fast:'',slow:'30',initial:'10000',allocation:'25',maxDrawdown:'20',feeBps:'10',slippageBps:'5'}};
const list=(env,kind='draft',extra={})=>libraryList(env,new URLSearchParams({kind,...extra}));
test('drafts persist incomplete editing, idempotent saves and optimistic concurrency without overwriting',async t=>{
  const env=await setup(t),first=await saveDraft(env,draft);assert.equal(first.revision,1);assert.equal(first.editor.rules,'{unfinished');assert.equal(first.editor.fast,'');assert.equal((await saveDraft(env,draft)).revision,1);
  const second=await saveDraft(env,{...first,name:'改名',editor:{...first.editor,fast:'12'}});assert.equal(second.revision,2);assert.equal(second.created,first.created);
  await assert.rejects(()=>saveDraft(env,{...first,name:'另一个页面的旧修改'}),e=>e.status===409);assert.equal((await libraryItem(env,'draft',first.id)).item.name,'改名');
  await assert.rejects(()=>saveDraft(env,{...second,editor:{...second.editor,rules:'x'.repeat(12001)}}),e=>e.status===400);
});
test('bulk trash changes are atomic, reversible, and reject stale autosaves',async t=>{
  const env=await setup(t),a=await saveDraft(env,draft),b=await saveDraft(env,{...draft,id:'draft-b',name:'second'});
  await manageLibrary(env,{action:'archive',items:[{kind:'draft',id:b.id,metaRevision:0}]});
  await assert.rejects(()=>manageLibrary(env,{action:'archive',items:[{kind:'draft',id:a.id,metaRevision:0},{kind:'draft',id:b.id,metaRevision:0}]}),e=>e.status===409);
  assert.equal((await list(env)).total,1);assert.equal((await list(env,'trash')).total,1);
  await manageLibrary(env,{action:'archive',items:[{kind:'draft',id:a.id,metaRevision:0}]});await assert.rejects(()=>saveDraft(env,{...a,name:'stale autosave'}),e=>e.status===409);
  const trash=(await list(env,'trash')).items;await manageLibrary(env,{action:'restore',items:trash});assert.equal((await list(env)).total,2);
  const saved=await saveDraft(env,{...a,name:'restored rename'});assert.equal((await libraryItem(env,'draft',a.id)).item.name,saved.name);assert.ok((await list(env)).items.some(x=>x.name==='restored rename'));
});
test('version and candidate aliases/archives never alter immutable parameters or delete audit records',async t=>{
  const env=await setup(t),v=await saveStrategy(env,{assetId:'us:AAPL',name:'version one',config:{},goal:'原目标'});
  await manageLibrary(env,{action:'rename',name:'renamed',items:[{kind:'version',id:v.id,metaRevision:0}]});assert.equal((await libraryItem(env,'version',v.id)).item.name,'renamed');const stored=JSON.parse(env.DB.prepare('SELECT value FROM service_state WHERE key=?').bind('strategy:'+v.id).first().value);assert.equal(stored.name,'version one');assert.deepEqual(stored.config,v.config);
  const exp={id:'experiment-a',name:'candidate',assetId:'us:AAPL',created:'2026-01-01',config:v.config};await env.DB.prepare('INSERT INTO service_state(key,value) VALUES(?,?)').bind('strategy_experiment:'+exp.id,JSON.stringify(exp)).run();
  await manageLibrary(env,{action:'archive',items:[{kind:'experiment',id:exp.id,metaRevision:0}]});assert.equal((await list(env,'experiment')).total,0);assert.deepEqual(JSON.parse(env.DB.prepare('SELECT value FROM service_state WHERE key=?').bind('strategy_experiment:'+exp.id).first().value),exp);
});
test('library searches every matching code/name and paginates stable summaries without editor bodies',async t=>{
  const env=await setup(t);for(let i=0;i<85;i++)await saveDraft(env,{...draft,id:'draft-'+i,name:'研究 '+i});
  const page=await list(env,'draft',{q:'AAPL'});assert.equal(page.total,85);assert.equal(page.items.length,40);assert.equal(page.nextOffset,40);assert.equal(page.items[0].editor,undefined);
  const next=await list(env,'draft',{q:'AAPL',offset:'40'});assert.equal(next.items.length,40);assert.equal(new Set([...page.items,...next.items].map(x=>x.id)).size,80);assert.equal((await list(env,'draft',{q:'研究 84'})).total,1);assert.equal((await list(env,'draft',{asset:'crypto:BTC-USDT'})).total,0);
  await manageLibrary(env,{action:'archive',items:[...page.items,...next.items]});assert.equal((await list(env,'trash')).total,80);
});
test('library reads and edits remain owner-only and writes require same-origin CSRF headers',async t=>{
  const env=await setup(t);for(const path of ['/api/strategy-library','/api/strategy-library/item?kind=draft&id=a','/api/strategy-drafts','/api/strategy-library/manage']){assert.equal((await handleRequest(new Request('https://test.site'+path),env,null)).status,401);assert.equal((await handleRequest(new Request('https://test.site'+path),env,{userId:'other',email:'other@test.com'})).status,403);}
  const request=new Request('https://test.site/api/strategy-drafts',{method:'POST',headers:{'content-type':'application/json',origin:'https://evil.test'},body:JSON.stringify(draft)});assert.equal((await handleRequest(request,env,{userId:'owner',email:'owner@test.com'})).status,403);
});

test('draft save uses two database queries and an indexed summary list excludes similarly named records',async t=>{
  const env=await setup(t),original=env.DB.prepare.bind(env.DB),queries=[];
  env.DB.prepare=q=>{queries.push(q);return original(q);};
  const saved=await saveDraft(env,draft);assert.equal(queries.length,2);assert.match(queries[1],/RETURNING value/);
  queries.length=0;await saveDraft(env,{...saved,name:'Changed'});assert.equal(queries.length,2);
  // LIKE treats underscores as wildcards; these unrelated keys must never enter the library.
  await original('INSERT INTO service_state(key,value) VALUES(?,?)').bind('strategyXdraft:wrong',JSON.stringify({...saved,id:'wrong'})).run();
  const result=await list(env);assert.equal(result.total,1);assert.equal(result.items[0].id,saved.id);
  const plans=await original("EXPLAIN QUERY PLAN SELECT key FROM service_state WHERE key GLOB 'strategy_draft:*'").all();assert.ok(plans.results.some(p=>p.detail.includes('SEARCH')));
});
