import {Problem} from './engine.mjs';
import {log} from './service.mjs';
import {readRecord,sessionInfo} from './research.mjs';
const prefixes={draft:'strategy_draft:',experiment:'strategy_experiment:',version:'strategy:'};
const kinds=Object.keys(prefixes);
const keyFor=(kind,id)=>{if(!kinds.includes(kind)||typeof id!=='string'||!/^[\w-]{1,80}$/.test(id))throw new Problem(400,'策略标识无效。');return prefixes[kind]+id;};
const joins=" FROM service_state s LEFT JOIN service_state m ON m.key='strategy_item_meta:'||s.key ";
const family="(s.key GLOB 'strategy_draft:*' OR s.key GLOB 'strategy_experiment:*' OR s.key GLOB 'strategy:*')";
const title="CASE WHEN s.key GLOB 'strategy_draft:*' THEN json_extract(s.value,'$.name') ELSE COALESCE(json_extract(m.value,'$.name'),json_extract(s.value,'$.name'),'未命名策略') END";
export async function libraryList(env,query){
  const kind=query.get('kind')||'draft',offset=Number(query.get('offset')||0),q=String(query.get('q')||'').trim().slice(0,100),asset=query.get('asset')||'';
  if(![...kinds,'trash'].includes(kind)||!Number.isInteger(offset)||offset<0||offset>100000)throw new Problem(400,'列表参数无效。');
  const common=family+" AND (?='' OR json_extract(s.value,'$.assetId')=?) AND (?='' OR instr(lower("+title+"||' '||COALESCE(json_extract(s.value,'$.assetId'),'')),lower(?))>0)",args=[asset,asset,q,q];
  const rowsQuery=env.DB.prepare("SELECT CASE WHEN COALESCE(json_extract(m.value,'$.archived'),0)=1 THEN 'trash' WHEN s.key GLOB 'strategy_draft:*' THEN 'draft' WHEN s.key GLOB 'strategy_experiment:*' THEN 'experiment' ELSE 'version' END AS kind,count(*) AS n"+joins+' WHERE '+common+' GROUP BY kind').bind(...args).all();
  const filter=kind==='trash'?"COALESCE(json_extract(m.value,'$.archived'),0)=1":"COALESCE(json_extract(m.value,'$.archived'),0)=0 AND s.key GLOB ?",filterArgs=kind==='trash'?[]:[prefixes[kind]+'*'];
  const dataQuery=env.DB.prepare("SELECT s.key,json_extract(s.value,'$.id') AS id,"+title+" AS name,json_extract(s.value,'$.assetId') AS assetId,COALESCE(json_extract(s.value,'$.updated'),json_extract(s.value,'$.created')) AS updated,COALESCE(json_extract(m.value,'$.revision'),0) AS metaRevision,json_extract(s.value,'$.revision') AS revision,COALESCE(json_extract(s.value,'$.editor.strategy'),json_extract(s.value,'$.config.strategy')) AS strategy,json_extract(s.value,'$.evaluation.decision') AS decision,json_extract(s.value,'$.comparison.validation.candidate.totalReturn') AS validationReturn,json_extract(s.value,'$.experimentId') AS frozenFrom"+joins+' WHERE '+common+' AND '+filter+" ORDER BY COALESCE(json_extract(s.value,'$.updated'),json_extract(s.value,'$.created')) DESC,s.key LIMIT 40 OFFSET ?").bind(...args,...filterArgs,offset).all();
  const [rows,data]=await Promise.all([rowsQuery,dataQuery]);
  const counts={draft:0,experiment:0,version:0,trash:0};for(const r of rows.results)counts[r.kind]=r.n;
  return {counts,total:counts[kind],nextOffset:offset+data.results.length<counts[kind]?offset+data.results.length:null,items:data.results.map(({key,...r})=>({...r,kind:kinds.find(k=>key.startsWith(prefixes[k]))}))};
}
export async function libraryItem(env,kind,id){
  const key=keyFor(kind,id),item=await readRecord(env.DB,key);if(!item)throw new Problem(404,'策略不存在。');
  const meta=await readRecord(env.DB,'strategy_item_meta:'+key);
  if(kind==='experiment'){const attempt=await readRecord(env.DB,'research_attempt:'+id);item.goal=attempt?.context?.goal||'';}
  if(kind==='experiment'&&item.sessionId){const session=await readRecord(env.DB,'research_session:'+item.sessionId);if(session)item.session=sessionInfo(session);}
  return {kind,item:{...item,name:kind==='draft'?item.name:meta?.name??item.name},metaRevision:meta?.revision??0,archived:!!meta?.archived};
}
export async function saveDraft(env,input){
  const id=input.id||crypto.randomUUID(),key=keyFor('draft',id),revision=input.revision??0;
  if(!Number.isInteger(revision)||revision<0)throw new Problem(400,'缺少草稿版本。');
  const name=String(input.name??'').trim();if(!name||name.length>80)throw new Problem(400,'草稿名称需要1–80个字符。');
  if(typeof input.assetId!=='string'||input.assetId.length>80)throw new Problem(400,'请选择研究标的。');
  const editor={};for(const k of ['strategy','rules','fast','slow','initial','allocation','maxDrawdown','feeBps','slippageBps']){const v=input.editor?.[k]??'';if(typeof v!=='string'||v.length>(k==='rules'?12000:100))throw new Problem(400,'草稿字段过长或格式无效。');editor[k]=v;}
  if(!['ma','rsi','breakout','custom'].includes(editor.strategy))throw new Problem(400,'请选择策略模板。');
  const goal=String(input.goal??'');if(goal.length>2000)throw new Problem(400,'目标最多2000字。');
  const rounds=Number(input.rounds??2);if(![1,2,3].includes(rounds))throw new Problem(400,'候选预算为1–3。');
  const record={id,name,assetId:input.assetId,editor,goal,rounds,parentId:typeof input.parentId==='string'?input.parentId.slice(0,80):null,originExperimentId:typeof input.originExperimentId==='string'?input.originExperimentId.slice(0,80):null,updated:new Date().toISOString(),revision:revision+1};
  const guard=await env.DB.prepare("SELECT EXISTS(SELECT 1 FROM assets WHERE id=?) AS assetExists,COALESCE((SELECT json_extract(value,'$.archived') FROM service_state WHERE key=?),0) AS archived").bind(input.assetId,'strategy_item_meta:'+key).first();
  if(!guard.assetExists)throw new Problem(404,'标的不存在。');
  if(guard.archived)throw new Problem(409,'草稿已移入回收站，请先恢复或另存副本。');
  let r;if(revision===0){record.created=record.updated;r=await env.DB.prepare('INSERT OR IGNORE INTO service_state(key,value) VALUES(?,?) RETURNING value').bind(key,JSON.stringify(record)).first();}
  else {r=await env.DB.prepare("UPDATE service_state SET value=json_set(?, '$.created', json_extract(value,'$.created')) WHERE key=? AND json_extract(value,'$.revision')=? AND NOT EXISTS(SELECT 1 FROM service_state m WHERE m.key=? AND json_extract(m.value,'$.archived')=1) RETURNING value").bind(JSON.stringify(record),key,revision,'strategy_item_meta:'+key).first();}
  if(!r){const old=await readRecord(env.DB,key);if(old&&old.revision===revision+1&&['name','assetId','editor','goal','rounds','parentId','originExperimentId'].every(k=>JSON.stringify(old[k])===JSON.stringify(record[k])))return old;throw new Problem(409,'草稿已在其他页面更新。当前编辑仍保留，请另存副本或重新载入。');}
  return JSON.parse(r.value);
}
export async function manageLibrary(env,input){
  if(!['archive','restore','rename'].includes(input.action)||!Array.isArray(input.items)||!input.items.length||input.items.length>200)throw new Problem(400,'请选择1–200个策略。');
  const records=input.items.map(x=>({key:keyFor(x.kind,x.id),revision:x.metaRevision}));if(new Set(records.map(x=>x.key)).size!==records.length||records.some(x=>!Number.isInteger(x.revision)||x.revision<0))throw new Problem(400,'策略版本无效。');
  if(input.action==='rename'&&input.items.some(x=>x.kind==='draft'))throw new Problem(400,'草稿名称请在编辑器修改并保存。');
  const name=String(input.name??'').trim();if(input.action==='rename'&&(records.length!==1||!name||name.length>80))throw new Problem(400,'重命名需要1–80字，且一次选择一个策略。');
  const packed=JSON.stringify(records);
  // Fixed parameter count keeps large selections within D1's binding limits.
  // The uncorrelated guard checks all revisions before the single atomic write.
  const guard="(SELECT count(*)"+joins+" JOIN json_each(?) x ON s.key=json_extract(x.value,'$.key') WHERE COALESCE(json_extract(m.value,'$.revision'),0)=json_extract(x.value,'$.revision'))=?";
  const sql="INSERT INTO service_state(key,value) SELECT 'strategy_item_meta:'||s.key,json_object('name',CASE WHEN ?='rename' THEN ? ELSE "+title+" END,'archived',CASE WHEN ?='archive' THEN 1 WHEN ?='restore' THEN 0 ELSE COALESCE(json_extract(m.value,'$.archived'),0) END,'revision',COALESCE(json_extract(m.value,'$.revision'),0)+1,'updated',?)"+joins+" WHERE s.key IN (SELECT json_extract(value,'$.key') FROM json_each(?)) AND "+guard+" ON CONFLICT(key) DO UPDATE SET value=excluded.value";
  const r=await env.DB.prepare(sql).bind(input.action,name,input.action,input.action,new Date().toISOString(),packed,packed,records.length).run();
  if(r.meta.changes!==records.length)throw new Problem(409,'列表已变化，本次未修改；请重新读取后再试。');
  await log(env.DB,'strategy_library',{action:input.action,count:records.length});return {ok:true,count:records.length};
}
