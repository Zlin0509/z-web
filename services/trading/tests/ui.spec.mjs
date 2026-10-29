import {test,expect} from '@playwright/test';
const day=86400000;
const csv='date,open,high,low,close,volume\n'+Array.from({length:100},(_,i)=>[new Date(Math.floor(Date.now()/day)*day-(100-i)*day).toISOString().slice(0,10),100+i,102+i,98+i,101+i,1000].join(',')).join('\n');
test('private login, CSV import, backtest, persistence, export, tabs and responsive layout',async({page,request},info)=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  expect((await request.get('/api/state')).status()).toBe(401);
  expect((await request.get('/api/state',{headers:{'oai-authenticated-user-id':'fake','oai-authenticated-user-email':'seedy@sites.test'}})).status()).toBe(401);
  await page.goto('/');await page.getByRole('link',{name:'使用 ChatGPT 登录'}).click();await expect(page.locator('.watch')).toHaveCount(4);
  await page.locator('[data-asset="us:AAPL"]').click();await page.getByRole('button',{name:'导入 CSV',exact:true}).click();await page.locator('#csv-file').setInputFiles({name:'sample.csv',mimeType:'text/csv',buffer:Buffer.from(csv)});await page.getByRole('button',{name:'验证并导入'}).click();await expect(page.locator('#notice')).toContainText('数据已验证');
  await page.locator('[data-tab="backtest"]').click();await page.getByRole('button',{name:'运行回测',exact:false}).click();await expect(page.locator('#notice')).toContainText('回测已完成');await expect(page.locator('.stats')).toBeVisible();await expect(page.locator('svg[aria-label="策略权益和买入持有基准"]')).toBeVisible();
  const download=page.waitForEvent('download');await page.getByRole('link',{name:'导出结果'}).click();expect((await download).suggestedFilename()).toBe('backtest.json');
  await page.reload();await expect(page.locator('.stats')).toBeVisible();await page.screenshot({path:'/tmp/zlin-trading-backtest-'+info.project.name+'.png',fullPage:true});
  await page.locator('[data-tab="integrations"]').click();await expect(page.getByRole('button',{name:'检查账户连接'})).toBeDisabled();
  await page.locator('[data-tab="paper"]').click();await expect(page.locator('#view')).toContainText('尚未启动模拟策略');
  await page.locator('[data-tab="logs"]').click();await expect(page.locator('.event')).not.toHaveCount(0);
  await page.locator('[data-tab="overview"]').click();await expect(page.locator('[data-asset="us:AAPL"]')).toContainText('CSV');await page.screenshot({path:'/tmp/zlin-trading-overview-'+info.project.name+'.png',fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);expect(errors).toEqual([]);
});
