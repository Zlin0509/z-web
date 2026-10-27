import { readdir, readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { groups, renderPost } from './markdown.mjs';
export { groups, escape, md } from './markdown.mjs';

export async function readPosts(contentRoot = new URL('./content/', import.meta.url), { includeDrafts = false } = {}) {
  const posts = [];
  const used = new Set();
  for (const section of Object.keys(groups)) {
    const directory = new URL(`${section}/`, contentRoot);
    for (const file of (await readdir(directory)).filter(f => f.endsWith('.md')).sort()) {
      const source = await readFile(new URL(file, directory), 'utf8');
      const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
      if (!match) throw new Error(`${section}/${file}: 缺少 YAML frontmatter`);
      const meta = YAML.parse(match[1]);
      const slug = file.slice(0, -3);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error(`${file}: 文件名需使用小写字母、数字与连字符`);
      for (const field of ['title', 'description', 'date', 'category']) {
        if (typeof meta[field] !== 'string' || !meta[field].trim()) throw new Error(`${file}: ${field} 必须是非空字符串`);
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.date) || Number.isNaN(Date.parse(meta.date)) || new Date(meta.date).toISOString().slice(0, 10) !== meta.date) throw new Error(`${file}: 日期无效`);
      if (!groups[section].includes(meta.category)) throw new Error(`${file}: 分类不属于 ${section}`);
      if (!Array.isArray(meta.tags) || meta.tags.some(t => typeof t !== 'string' || !t.trim())) throw new Error(`${file}: tags 必须是字符串列表`);
      if (meta.source && !/^https:\/\//.test(meta.source)) throw new Error(`${file}: source 必须使用 HTTPS`);
      if (meta.difficulty && !['入门', '基础', '进阶', '挑战'].includes(meta.difficulty)) throw new Error(`${file}: 难度无效`);
      if (used.has(slug)) throw new Error(`重复文章 slug: ${slug}`);
      used.add(slug);
      if (meta.draft && !includeDrafts) continue;
      posts.push(renderPost({ ...meta, section, slug, body: match[2] }));
    }
  }
  return posts.sort((a,b) => b.date.localeCompare(a.date) || Number(Boolean(b.featured)) - Number(Boolean(a.featured)) || a.title.localeCompare(b.title, 'zh-CN'));
}
