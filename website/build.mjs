import { mkdir, writeFile, cp, rm, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPosts, escape as e, groups } from './content.mjs';
import { layout, homePage, listingPage, articlePage, aboutPage, notFoundPage } from './templates.mjs';
import { loginPage } from './admin-templates.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, '.sites-runtime/static-check');
export async function build() {
  const site = JSON.parse(await readFile(new URL('./site.json', import.meta.url), 'utf8'));
  if (!/^https:\/\//.test(site.url)) throw new Error('site.url 必须是 HTTPS 网址');
  const posts = await readPosts();
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await cp(resolve(root, 'website/assets'), resolve(out, 'assets'), { recursive: true });
  const write = async (path, content) => { const destination = resolve(out, path); await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, content); };
  const page = async (path, title, body, options = {}) => write(path === '/404.html' ? '404.html' : `${path.slice(1)}index.html`, layout({ site, posts, title, body, path, ...options }));
  await page('/', '', homePage(posts, site));
  for (const section of Object.keys(groups)) {
    await page(`/${section}/`, section === 'work' ? '工作手记' : '算法题库', listingPage(posts, section), { section });
  }
  await page('/about/', '关于我', aboutPage(site), { section: 'about' });
  await page('/admin/', '笔记管理', loginPage(), { noindex: true });
  for (const post of posts) await page(post.url, post.title, articlePage(post, posts), { description: post.description, section: post.section, post });
  await page('/404.html', '页面走丢了', notFoundPage(), { noindex: true });
  await write('search.json', JSON.stringify(posts.map(({ title, description, date, category, tags, url, section, body, sample }) => ({title, description, date, category, tags, url, section, body, sample}))));
  const urls = ['/', '/work/', '/algorithms/', '/about/', ...posts.map(p => p.url)];
  await write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map(url => `<url><loc>${e(site.url + url)}</loc></url>`).join('')}</urlset>`);
  await write('robots.txt', `User-agent: *\nAllow: /\nSitemap: ${site.url}/sitemap.xml\n`);
  await write('feed.xml', `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${e(site.title)}</title><link>${e(site.url)}</link><description>${e(site.description)}</description><language>zh-CN</language>${posts.map(post => `<item><title>${e(post.title)}</title><link>${e(site.url + post.url)}</link><guid>${e(site.url + post.url)}</guid><description>${e(post.description)}</description><pubDate>${new Date(`${post.date}T00:00:00+08:00`).toUTCString()}</pubDate><category>${e(post.category)}</category></item>`).join('')}</channel></rss>`);
  console.log(`Checked source: ${posts.length} articles and ${urls.length + 2} pages → .sites-runtime/static-check/`);
  return posts;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await build();
