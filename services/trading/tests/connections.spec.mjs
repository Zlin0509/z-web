import {test,expect} from '@playwright/test';

test('owner can save secrets without reading them back and sees streamed quote timestamps',async({page},info)=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/quotes',r=>r.fulfill({json:{quotes:[{symbol:'BTC-USDT',error:'REST limited'},{symbol:'AAPL',error:'请配置 Alpaca'}]}}));
  await page.routeWebSocket('wss://ws.okx.com:8443/ws/v5/public',ws=>ws.onMessage(message=>{
    if(message==='ping')return ws.send('pong');
    ws.send(JSON.stringify({data:[{instId:'BTC-USDT',last:'65432',bidPx:'65431',askPx:'65433',ts:String(Date.now())}]}));
  }));
  await page.goto('/');await page.getByRole('link',{name:'使用 ChatGPT 登录'}).click();
  await expect(page.locator('#live-quotes')).toContainText('65432');
  await expect(page.locator('#live-quotes')).toContainText('OKX WebSocket');
  await page.locator('[data-tab="integrations"]').click();
  const secret='ui-test-only-secret';
  await page.locator('[name="DEEPSEEK_API_KEY"]').fill(secret);
  await page.getByRole('button',{name:'保存配置',exact:true}).click();
  await expect(page.locator('#connection-message')).toContainText('配置已加密保存');
  await expect(page.locator('[name="DEEPSEEK_API_KEY"]')).toHaveValue('');
  const state=await page.evaluate(async()=>await(await fetch('/api/settings')).text());
  expect(state).not.toContain(secret);expect(JSON.parse(state).configured.DEEPSEEK_API_KEY).toBe(true);
  await expect(page.locator('#submit-live')).toBeDisabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await page.screenshot({path:'/tmp/zlin-connections-'+info.project.name+'.png',fullPage:true});
  expect(errors).toEqual([]);
});
