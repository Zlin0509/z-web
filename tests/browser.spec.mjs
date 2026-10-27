import { test, expect } from '@playwright/test';

test('search finds article text and navigates to the result', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '搜索文章', exact: true }).click();
  await page.getByRole('searchbox', { name: '搜索文章与题解' }).fill('幂等键');
  await expect(page.locator('.search-result')).toHaveCount(2);
  await page.locator('.search-result').first().click();
  await expect(page.locator('.prose')).toContainText('幂等键');
});
test('filters compose, show empty state, and reset', async ({ page }) => {
  await page.goto('/work/?tag=Agent');
  await expect(page.locator('.filter-item:visible')).toHaveCount(1);
  await page.locator('#list-search').fill('does-not-exist');
  await expect(page.locator('.empty-state')).toBeVisible();
  await page.getByRole('button', { name: '重置筛选' }).click();
  await expect(page.locator('.filter-item:visible')).toHaveCount(3);
  await page.getByRole('button', { name: '开发实践' }).click();
  await expect(page.locator('.filter-item:visible')).toHaveCount(1);
});
test('bookmarks persist and can be removed in saved view', async ({ page }) => {
  await page.goto('/algorithms/');
  await page.locator('[data-bookmark="dijkstra"]').click();
  await page.reload();
  await page.getByRole('button', { name: '我的收藏' }).click();
  await expect(page.locator('.filter-item:visible')).toHaveCount(1);
  await page.locator('[data-bookmark="dijkstra"]').click();
  await expect(page.locator('.empty-state')).toBeVisible();
});
test('theme persists, mobile menu works, and page fits viewport', async ({ page }) => {
  await page.goto('/');
  const before = await page.locator('html').getAttribute('data-theme');
  await page.locator('.theme-toggle').click();
  await page.reload();
  expect(await page.locator('html').getAttribute('data-theme')).not.toBe(before);
  if (page.viewportSize().width < 601) {
    await page.getByRole('button', { name: '展开导航' }).click();
    await page.locator('#mobile-nav').getByRole('link', { name: '算法题库' }).click();
    await expect(page).toHaveURL(/algorithms/);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('article code and URL can be copied; page has no JavaScript errors', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/algorithms/dijkstra/');
  await page.getByRole('button', { name: '复制代码' }).first().click();
  await expect(page.locator('.copy-code').first()).toHaveText('已复制');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('priority_queue');
  await page.getByRole('button', { name: '复制文章链接' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('/algorithms/dijkstra/');
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('unknown paths return a useful 404', async ({ page }) => {
  const response = await page.goto('/missing-path/'); expect(response.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('没有答案');
});
