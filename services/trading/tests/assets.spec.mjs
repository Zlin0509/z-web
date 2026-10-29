import {test,expect} from '@playwright/test';
test('watchlist supports deleting an added symbol and preserves navigation',async({page},info)=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/');await page.getByRole('link',{name:'使用 ChatGPT 登录'}).click();
  await expect(page.locator('.watch')).toHaveCount(4);
  await page.locator('#add-asset').click();const symbol=info.project.name==='desktop'?'IBM':'MSFT';
  await page.locator('#asset-form [name="symbol"]').fill(symbol);await page.getByRole('button',{name:'添加到观察列表'}).click();
  await expect(page.locator('.watch')).toHaveCount(5);await expect(page.locator('.chart-title h2')).toHaveText(symbol);
  page.once('dialog',dialog=>dialog.dismiss());await page.locator('#remove-asset').click();await expect(page.locator('.watch')).toHaveCount(5);
  page.once('dialog',dialog=>dialog.accept());await page.locator('#remove-asset').click();
  await expect(page.locator('#notice')).toContainText('标的已删除');await expect(page.locator('.watch')).toHaveCount(4);
  await expect(page.locator(`[data-asset="us:${symbol}"]`)).toHaveCount(0);
  await page.locator('[data-tab="backtest"]').click();await expect(page.locator('#strategy-form')).toBeVisible();expect(errors).toEqual([]);
});
