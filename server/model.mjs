import { groups } from '../website/markdown.mjs';

export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
export function validateDocument(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, '笔记内容格式不正确。');
  const text = (key, limit, required = false) => {
    const value = input[key] ?? '';
    if (typeof value !== 'string' || value.length > limit || required && !value.trim()) throw new HttpError(400, `${key} 为空或超过长度限制。`);
    return key === 'body' ? value : value.trim();
  };
  const section = text('section', 20, true);
  if (!groups[section]) throw new HttpError(400, '请选择工作手记或算法题库。');
  const slug = text('slug', 100, true);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new HttpError(400, '网址标识只能包含小写英文字母、数字和连字符。');
  const category = text('category', 30, true);
  if (!groups[section].includes(category)) throw new HttpError(400, '分类不属于所选栏目。');
  const date = text('date', 10, true);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date) throw new HttpError(400, '日期格式应为 YYYY-MM-DD。');
  if (!Array.isArray(input.tags) || input.tags.length > 15 || input.tags.some(t => typeof t !== 'string' || !t.trim() || t.length > 30)) throw new HttpError(400, '最多填写 15 个标签，每个不超过 30 字。');
  const source = text('source', 1000);
  if (source) { try { const url = new URL(source); if (url.protocol !== 'https:' || url.username || url.password) throw new Error(); } catch { throw new HttpError(400, '原题链接需要使用有效的 HTTPS 网址。'); } }
  const difficulty = text('difficulty', 10);
  if (difficulty && !['入门','基础','进阶','挑战'].includes(difficulty)) throw new HttpError(400, '请选择有效的难度。');
  return { title: text('title', 150, true), description: text('description', 400), date, category,
    tags: [...new Set(input.tags.map(t=>t.trim()))], section, slug, body: text('body', 200000),
    source, sourceLabel: text('sourceLabel', 150), difficulty,
    sample: input.sample === true, featured: input.featured === true };
}
export function checkMutation(request) {
  const origin = request.headers.get('origin');
  if (origin !== new URL(request.url).origin || request.headers.get('x-notebook-request') !== '1' || request.headers.get('sec-fetch-site') === 'cross-site') throw new HttpError(403, '请求来源验证失败，请在本站重新操作。');
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new HttpError(415, '请使用 JSON 请求。');
}
export async function readJson(request) {
  if (Number(request.headers.get('content-length')) > 1200000) throw new HttpError(413, '内容过大，请缩短笔记。');
  const reader = request.body?.getReader(); if (!reader) throw new HttpError(400, '请求内容为空。');
  const chunks = []; let total = 0;
  while (true) { const {value,done} = await reader.read(); if (done) break; total += value.byteLength; if (total > 1200000) { await reader.cancel(); throw new HttpError(413, '内容过大，请缩短笔记。'); } chunks.push(value); }
  const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.byteLength; }
  try { const value = JSON.parse(new TextDecoder().decode(bytes)); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; } catch { throw new HttpError(400, '请求内容必须是有效的 JSON 对象。'); }
}
