import { writeFile } from 'node:fs/promises';
import { groups } from './content.mjs';
import YAML from 'yaml';

const [section, slug, ...words] = process.argv.slice(2);
if (!groups[section] || !slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || !words.length) {
  console.error('用法：npm run new -- work|algorithms english-slug "文章标题"');
  process.exit(1);
}
const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const meta = { title: words.join(' '), description: '请填写一句摘要', date, category: groups[section][0], tags: [section === 'work' ? 'Agent' : '算法'], draft: true };
const path = new URL(`./content/${section}/${slug}.md`, import.meta.url);
try {
  await writeFile(path, `---\n${YAML.stringify(meta)}---\n\n## 问题与背景\n\n从这里开始写作。完成后将 draft 改为 false。\n`, { flag: 'wx' });
  console.log(`已创建草稿：${path.pathname}`);
} catch (error) { console.error(error.code === 'EEXIST' ? '文章已存在，未覆盖原文件。' : error.message); process.exit(1); }
