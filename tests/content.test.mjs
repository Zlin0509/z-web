import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readPosts, md } from '../website/content.mjs';

test('drafts are excluded and every article has unique anchors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zlin-content-'));
  try {
    await mkdir(join(dir, 'work')); await mkdir(join(dir, 'algorithms'));
    const source = '---\ntitle: Test\ndescription: Test\ndate: "2026-10-26"\ncategory: Agent 工程\ntags: [Agent]\ndraft: DRAFT\n---\n## 重复标题\n\nTest\n\n## 重复标题';
    await writeFile(join(dir, 'work', 'published.md'), source.replace('DRAFT', 'false'));
    await writeFile(join(dir, 'work', 'draft.md'), source.replace('DRAFT', 'true'));
    const posts = await readPosts(pathToFileURL(dir + '/'));
    assert.equal(posts.length, 1);
    assert.equal(posts[0].slug, 'published');
    for (const post of posts) { assert.equal(new Set(post.toc.map(t => t.id)).size, post.toc.length); for (const heading of post.toc) assert.ok(post.html.includes(`id="${heading.id}"`)); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('raw HTML and JavaScript links cannot execute in markdown', () => {
  const html = md.render('<script>alert(1)</script>\n\n[x](javascript:alert(1))');
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('href="javascript:'));
});
test('invalid metadata fails publication instead of silently disappearing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zlin-content-'));
  try {
    await mkdir(join(dir, 'work')); await mkdir(join(dir, 'algorithms'));
    await writeFile(join(dir, 'work', 'invalid.md'), '---\ntitle: Test\ndescription: Test\ndate: "2026-02-30"\ncategory: Agent 工程\ntags: [Agent]\n---\nTest');
    await assert.rejects(readPosts(pathToFileURL(dir + '/')), /日期无效/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
