import {test,expect} from '@playwright/test';
test('opening and navigating only read stored data; no timers or websocket quote requests',async({page})=>{
  let stateReads=0,quoteReads=0,refreshes=0,sockets=0;const assetReads=new Map();
  page.on('request',r=>{const p=new URL(r.url()).pathname;if(p==='/api/state')stateReads++;if(p==='/api/quotes')quoteReads++;if(p==='/api/refresh')refreshes++;if(p.startsWith('/api/assets/'))assetReads.set(p,(assetReads.get(p)||0)+1);});page.on('websocket',()=>sockets++);
  await page.goto('/');await page.getByRole('link',{name:'使用 ChatGPT 登录'}).click();await expect(page.locator('.watch')).toHaveCount(4);await expect(page.locator('#live-quotes')).toContainText('数据库');
  await page.locator('[data-asset="us:AAPL"]').click();await page.locator('[data-asset="us:SPY"]').click();await page.locator('[data-asset="us:AAPL"]').click();
  expect(assetReads.get('/api/assets/us%3AAAPL')).toBe(1);expect(quoteReads).toBe(1);expect(stateReads).toBe(1);
  await page.clock.install();await page.clock.fastForward(120000);expect(stateReads).toBe(1);expect(quoteReads).toBe(1);expect(refreshes).toBe(0);expect(sockets).toBe(0);
  await page.locator('#read-database').click();await expect.poll(()=>stateReads).toBe(2);expect(refreshes).toBe(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});
