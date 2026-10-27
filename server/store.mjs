import { HttpError, validateDocument } from './model.mjs';

export async function ensureSeed(db, seed) {
  const existing = await db.prepare("SELECT value FROM notebook_state WHERE key = 'seed_v1'").first();
  if (existing) return;
  const now = new Date().toISOString();
  const statements = seed.map(post => {
    const doc = validateDocument(post); const json = JSON.stringify(doc);
    return db.prepare('INSERT OR IGNORE INTO notes (id, slug, draft_json, published_json, revision, created_at, updated_at, published_at, last_mutation) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)').bind(`seed-${post.slug}`, post.slug, json, post.draft ? null : json, now, now, post.draft ? null : now, 'seed');
  });
  statements.push(db.prepare("INSERT OR IGNORE INTO notebook_state (key, value) VALUES ('seed_v1', 'complete')"));
  await db.batch(statements);
}
export async function requireOwner(db, user, ownerEmail) {
  if (!user) throw new HttpError(401, '请先使用 ChatGPT 账号登录。');
  const record = await db.prepare("SELECT value FROM notebook_state WHERE key = 'owner_user_id'").first();
  if (record) { if (record.value !== user.userId) throw new HttpError(403, '这个账号没有笔记管理权限。请使用站点所有者账号登录。'); return user; }
  if (!ownerEmail) throw new HttpError(503, '管理员身份尚未配置，请联系站点所有者。');
  if (user.email.toLowerCase() !== ownerEmail.toLowerCase()) throw new HttpError(403, '这个账号没有笔记管理权限。请使用站点所有者账号登录。');
  // Only the platform-verified owner email may bind the stable, Site-scoped ID.
  await db.prepare("INSERT OR IGNORE INTO notebook_state (key, value) VALUES ('owner_user_id', ?)").bind(user.userId).run();
  const bound = await db.prepare("SELECT value FROM notebook_state WHERE key = 'owner_user_id'").first();
  if (bound?.value !== user.userId) throw new HttpError(403, '管理账号不匹配。');
  return user;
}
export function noteFromRow(row) {
  if (!row) throw new HttpError(404, '没有找到这篇笔记。');
  const document = JSON.parse(row.draft_json);
  return { id:row.id, document, revision:row.revision, createdAt:row.created_at, updatedAt:row.updated_at,
    publishedAt:row.published_at, deletedAt:row.deleted_at, published:!!row.published_json,
    hasChanges:row.published_json !== null && row.published_json !== row.draft_json,
    url:`/${document.section}/${document.slug}/` };
}
export async function getNote(db,id) { return noteFromRow(await db.prepare('SELECT * FROM notes WHERE id = ?').bind(id).first()); }
export async function listNotes(db) { return (await db.prepare('SELECT * FROM notes ORDER BY updated_at DESC').all()).results.map(noteFromRow); }
export async function publishedDocuments(db) {
  return (await db.prepare('SELECT published_json FROM notes WHERE published_json IS NOT NULL AND deleted_at IS NULL').all()).results.map(row=>JSON.parse(row.published_json)).sort((a,b)=>b.date.localeCompare(a.date)||Number(b.featured)-Number(a.featured)||a.title.localeCompare(b.title,'zh-CN'));
}
export async function createNote(db,input) {
  const doc = validateDocument(input); const json=JSON.stringify(doc); const id=crypto.randomUUID(); const now=new Date().toISOString();
  try { await db.batch([
    db.prepare('INSERT INTO notes (id, slug, draft_json, revision, created_at, updated_at, last_mutation) VALUES (?, ?, ?, 1, ?, ?, ?)').bind(id,doc.slug,json,now,now,id),
    db.prepare('INSERT INTO note_versions (id,note_id,revision,document_json,action,created_at) VALUES (?,?,1,?,?,?)').bind(crypto.randomUUID(),id,json,'create',now),
  ]); } catch(error) { if (/UNIQUE constraint failed.*slug/i.test(String(error))) throw new HttpError(409,'这个网址标识已被使用（也可能在回收站中），请换一个。'); throw error; }
  return getNote(db,id);
}
export async function updateNote(db,id,input) {
  if (!Number.isInteger(input.revision) || input.revision<1) throw new HttpError(400,'缺少有效的笔记版本号。');
  const row=await db.prepare('SELECT * FROM notes WHERE id = ?').bind(id).first(); if(!row) throw new HttpError(404,'没有找到这篇笔记。');
  if(row.revision!==input.revision) throw new HttpError(409,'笔记已在其他页面更新。当前编辑内容已保留，请先导出，再重新加载最新版本。');
  const action=input.action;
  if(!['save','publish','unpublish','trash','restore'].includes(action)) throw new HttpError(400,'不支持的笔记操作。');
  if(row.deleted_at && action!=='restore') throw new HttpError(409,'请先从回收站恢复笔记。');
  if(!row.deleted_at && action==='restore') throw new HttpError(400,'笔记不在回收站。');
  const doc=['save','publish'].includes(action)?validateDocument(input.document):JSON.parse(row.draft_json);
  if(row.published_json) {const pub=JSON.parse(row.published_json);if(doc.slug!==pub.slug||doc.section!==pub.section)throw new HttpError(400,'已发布笔记的网址与栏目暂不可修改；先撤回发布后再修改。');}
  if(action==='publish' && (!doc.body.trim() || !doc.description.trim())) throw new HttpError(400,'发布前请填写正文和摘要。');
  const json=JSON.stringify(doc);const now=new Date().toISOString();const mutation=crypto.randomUUID();
  const published = action==='publish'?json:['unpublish','trash','restore'].includes(action)?null:row.published_json;
  const publishedAt = action==='publish'?now:published?row.published_at:null;
  const deletedAt = action==='trash'?now:null;
  let results;
  try { results=await db.batch([
    db.prepare('UPDATE notes SET slug=?, draft_json=?, published_json=?, revision=revision+1, updated_at=?, published_at=?, deleted_at=?, last_mutation=? WHERE id=? AND revision=?').bind(doc.slug,json,published,now,publishedAt,deletedAt,mutation,id,input.revision),
    db.prepare('INSERT INTO note_versions (id,note_id,revision,document_json,action,created_at) SELECT ?,id,revision,draft_json,?,? FROM notes WHERE id=? AND last_mutation=?').bind(crypto.randomUUID(),action,now,id,mutation),
  ]); } catch(error) { if(/UNIQUE constraint failed.*slug/i.test(String(error))) throw new HttpError(409,'这个网址标识已被其他笔记使用。'); throw error; }
  if(results[0].meta.changes!==1) throw new HttpError(409,'笔记已在其他页面更新。请保留当前编辑内容并重新加载。');
  return getNote(db,id);
}
export async function versions(db,id) { await getNote(db,id); return (await db.prepare('SELECT revision, document_json, action, created_at FROM note_versions WHERE note_id=? ORDER BY revision DESC LIMIT 30').bind(id).all()).results.map(row=>({revision:row.revision,document:JSON.parse(row.document_json),action:row.action,createdAt:row.created_at})); }
