import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleRequest } from '../server/controller.mjs';

class LocalD1 {
  constructor(){this.sql=new DatabaseSync(':memory:');this.sql.exec(readFileSync(new URL('../drizzle/0000_fixed_white_tiger.sql',import.meta.url),'utf8'));}
  prepare(query){const db=this.sql;let args=[];return {bind(...values){args=values;return this;},first(){return db.prepare(query).get(...args)||null;},all(){return {results:db.prepare(query).all(...args)};},run(){const result=db.prepare(query).run(...args);return {meta:{changes:Number(result.changes)}};}};}
  async batch(statements){this.sql.exec('BEGIN');try{const results=statements.map(s=>s.run());this.sql.exec('COMMIT');return results;}catch(e){this.sql.exec('ROLLBACK');throw e;}}
  close(){this.sql.close();}
}
const owner={userId:'site-owner',email:'owner@example.com',displayName:'Owner'};
const stranger={userId:'other-user',email:'other@example.com',displayName:'Other'};
function setup(t){const DB=new LocalD1();t.after(()=>DB.close());return {DB,NOTEBOOK_OWNER_EMAIL:owner.email};}
function doc(slug='private-note'){return {title:'PRIVATE TITLE',description:'Private summary',date:'2026-10-27',section:'work',category:'Agent 工程',slug,tags:['私有'],body:'## Private\nSECRET DRAFT CONTENT'};}
async function call(env,path,{user=owner,method='GET',body,origin='https://notebook.test',extra={}}={}){
  return handleRequest(new Request('https://notebook.test'+path,{method,headers:body?{'Content-Type':'application/json','X-Notebook-Request':'1',Origin:origin,...extra}:extra,body:body?JSON.stringify(body):undefined}),env,user);
}
async function create(env,document=doc()){const response=await call(env,'/api/admin/notes',{method:'POST',body:{document}});assert.equal(response.status,201);return (await response.json()).note;}
async function update(env,note,action,document=note.document){const response=await call(env,'/api/admin/notes/'+note.id,{method:'PUT',body:{revision:note.revision,action,document}});assert.equal(response.status,200,await response.clone().text());return (await response.json()).note;}

test('anonymous and other authenticated visitors cannot read, write, preview, or export private notes',async t=>{
  const env=setup(t);
  for(const path of ['/api/admin/notes','/api/admin/session','/api/admin/export','/api/admin/notes/unknown/versions','/api/admin/notes/unknown/markdown']){
    assert.equal((await call(env,path,{user:null})).status,401);
    assert.equal((await call(env,path,{user:stranger})).status,403);
  }
  assert.equal((await call(env,'/api/admin/notes',{user:null,method:'POST',body:{document:doc()}})).status,401);
  assert.equal((await call(env,'/api/admin/preview',{user:stranger,method:'POST',body:{body:'secret'}})).status,403);
  assert.equal((await call(env,'/api/admin/notes',{user:null,extra:{'oai-authenticated-user-id':owner.userId,'oai-authenticated-user-email':owner.email}})).status,401);
  const login=await call(env,'/admin/',{user:null});assert.equal(login.status,200);assert.match(await login.text(),/signin-with-chatgpt/);
  assert.equal(env.DB.prepare("SELECT value FROM notebook_state WHERE key='owner_user_id'").first(),null);
  assert.equal((await call(env,'/api/admin/notes')).status,200);
  assert.equal(env.DB.prepare("SELECT value FROM notebook_state WHERE key='owner_user_id'").first().value,owner.userId);
  // Once bound, email reuse by a different stable identity grants no access.
  assert.equal((await call(env,'/api/admin/notes',{user:{...owner,userId:'different-id'}})).status,403);
});
test('cross-site writes are rejected and raw HTML is never executable in preview',async t=>{
  const env=setup(t);
  assert.equal((await call(env,'/api/admin/notes',{method:'POST',body:{document:doc()},origin:'https://attacker.test'})).status,403);
  assert.equal((await call(env,'/api/admin/notes',{method:'POST',body:{document:doc()},extra:{'X-Notebook-Request':''}})).status,403);
  const preview=await call(env,'/api/admin/preview',{method:'POST',body:{body:'<script>alert(1)</script>\n\n[x](javascript:alert(1))'}});
  const {html}=await preview.json();assert.ok(!html.includes('<script>'));assert.ok(!html.includes('href="javascript:'));
});
test('drafts never leak to pages, search, RSS, or sitemap; updates publish explicitly',async t=>{
  const env=setup(t);let note=await create(env);
  for(const path of ['/','/work/','/search.json','/feed.xml','/sitemap.xml']){const response=await call(env,path,{user:null});const text=await response.text();assert.equal(response.status,200);assert.ok(!text.includes('PRIVATE TITLE'));assert.ok(!text.includes('SECRET DRAFT CONTENT'));assert.equal(response.headers.get('Cache-Control'),'no-store');}
  assert.equal((await call(env,note.url,{user:null})).status,404);
  note=await update(env,note,'publish');
  assert.match(await (await call(env,note.url,{user:null})).text(),/SECRET DRAFT CONTENT/);
  note=await update(env,note,'save',{...note.document,body:'NEW PRIVATE REVISION'});
  assert.equal(note.hasChanges,true);
  assert.ok(!(await (await call(env,note.url,{user:null})).text()).includes('NEW PRIVATE REVISION'));
  assert.ok(!(await (await call(env,'/search.json',{user:null})).text()).includes('NEW PRIVATE REVISION'));
  note=await update(env,note,'publish');assert.match(await (await call(env,note.url,{user:null})).text(),/NEW PRIVATE REVISION/);
  note=await update(env,note,'unpublish');assert.equal((await call(env,note.url,{user:null})).status,404);
});
test('revision checks prevent lost updates, history survives, and recycle bin restoration stays private',async t=>{
  const env=setup(t);let note=await create(env);const old=note;
  note=await update(env,note,'save',{...note.document,title:'New title'});
  const stale=await call(env,'/api/admin/notes/'+note.id,{method:'PUT',body:{revision:old.revision,action:'save',document:{...old.document,title:'Stale overwrite'}}});assert.equal(stale.status,409);
  const history=await (await call(env,'/api/admin/notes/'+note.id+'/versions')).json();assert.equal(history.versions.length,2);assert.equal(history.versions[0].document.title,'New title');
  note=await update(env,note,'publish');note=await update(env,note,'trash');assert.ok(note.deletedAt);assert.equal((await call(env,note.url,{user:null})).status,404);
  // Re-reading public content must not resurrect deleted seed or authored notes.
  await call(env,'/',{user:null});
  note=await update(env,note,'restore');assert.equal(note.published,false);assert.equal(note.deletedAt,null);assert.equal((await call(env,note.url,{user:null})).status,404);
  const duplicate=await call(env,'/api/admin/notes',{method:'POST',body:{document:doc()}});assert.equal(duplicate.status,409);
});
test('Markdown import/export round-trips fields without publishing',async t=>{
  const env=setup(t);const note=await create(env);
  const markdown=await (await call(env,'/api/admin/notes/'+note.id+'/markdown')).text();
  const imported=await (await call(env,'/api/admin/import',{method:'POST',body:{markdown,filename:'private-note.md'}})).json();
  assert.equal(imported.document.title,note.document.title);assert.equal(imported.document.body.trim(),note.document.body.trim());assert.equal(imported.document.section,'work');
  assert.equal((await call(env,note.url,{user:null})).status,404);
});
