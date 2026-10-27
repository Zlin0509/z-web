import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../.sites-runtime/static-check');
async function walk(dir) { const files = []; for (const entry of await readdir(dir, { withFileTypes: true })) { const path = resolve(dir, entry.name); files.push(...(entry.isDirectory() ? await walk(path) : [path])); } return files; }
const files = await walk(dist);
const htmlFiles = files.filter(path => path.endsWith('.html'));
let links = 0;
for (const file of htmlFiles) {
  const html = await readFile(file, 'utf8');
  assert.equal((html.match(/<h1(?:\s|>)/g) || []).length, 1, `${file}: 需要且仅需要一个 h1`);
  assert.match(html, /<html lang="zh-CN">/);
  assert.match(html, /<meta name="description" content="[^"]+">/);
  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const href = match[1].replaceAll('&amp;', '&');
    if (!href.startsWith('/') && !href.startsWith('#')) continue;
    const url = new URL(href, 'https://local.test/' + file.slice(dist.length + 1).replace(/index\.html$/, ''));
    if (['/signin-with-chatgpt', '/signout-with-chatgpt', '/callback'].includes(url.pathname)) continue;
    let target = resolve(dist, '.' + decodeURIComponent(url.pathname));
    const info = await stat(target).catch(() => { throw new Error(`断链：${file} → ${href}`); });
    if (info.isDirectory()) target = resolve(target, 'index.html');
    const targetBody = await readFile(target, 'utf8');
    if (url.hash) assert.ok(targetBody.includes(`id="${decodeURIComponent(url.hash.slice(1))}"`), `缺少锚点：${file} → ${href}`);
    links++;
  }
}
const index = JSON.parse(await readFile(resolve(dist, 'search.json'), 'utf8'));
assert.ok(Array.isArray(index));
assert.ok(!index.some(post => post.draft));
assert.ok((await readFile(resolve(dist, 'feed.xml'), 'utf8')).startsWith('<?xml'));
console.log(`Checked ${htmlFiles.length} pages, ${links} internal links, RSS, and ${index.length} search entries.`);
