import {test,expect} from '@playwright/test';

test('OKX configuration, environments, preview invalidation, execution and status queries',async({page})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const configured={OKX_LIVE_API_KEY:true,OKX_LIVE_SECRET_KEY:true};let saved,previewInput,submission,queries=0,order=null;
  const settings=()=>({configured,okxRegion:'global',okxLiveEnabled:false,model:'',schwabConnected:false,liveTrading:false});
  await page.route('**/api/settings',async route=>{
    if(route.request().method()==='POST'){saved=route.request().postDataJSON().values;Object.keys(saved).forEach(key=>configured[key]=true);}
    await route.fulfill({json:settings()});
  });
  await page.route('**/api/deepseek/models',route=>route.fulfill({json:{models:[]}}));
  await page.route('**/api/okx/status',route=>route.fulfill({json:settings()}));
  await page.route('**/api/okx/strategies',route=>route.fulfill({json:{strategies:[]}}));
  await page.route('**/api/okx/activity',route=>route.fulfill({json:{operations:order?[order]:[]}}));
  await page.route('**/api/okx/check',route=>route.fulfill({json:{mode:route.request().postDataJSON().mode,connected:true,balances:[{currency:'USDT',available:'1000'}]}}));
  await page.route('**/api/okx/preview',route=>{
    previewInput=route.request().postDataJSON();order={id:'operation1',kind:'submit',mode:previewInput.mode,payload:{...previewInput,clOrdId:'unique-client-order'},status:'prepared'};
    return route.fulfill({json:{id:order.id,mode:order.mode,payload:order.payload,expiresIn:60,liveEnabled:false}});
  });
  await page.route('**/api/okx/submit',route=>{submission=route.request().postDataJSON();order.status='live';order.ordId='123';return route.fulfill({json:{id:order.id,status:'live',note:'委托已受理'}});});
  await page.route('**/api/okx/reconcile',route=>{queries++;order.status=queries===1?'partially_filled':'canceled';order.accFillSz='0.0005';order.avgPx='60000';return route.fulfill({json:order});});
  await page.route('**/api/okx/cancel',route=>route.fulfill({json:{id:'c-operation1',status:'cancel_pending',note:'撤单请求已受理'}}));
  await page.goto('/');await page.getByRole('link',{name:'使用 ChatGPT 登录'}).click();await page.locator('[data-tab="integrations"]').click();
  await expect(page.locator('#okx-message')).toContainText('实盘密钥待补齐');
  const live=page.locator('#okx-config details').filter({hasText:'实盘密钥'});await live.locator('summary').click();
  await live.locator('[name="OKX_LIVE_PASSPHRASE"]').fill('test-only-passphrase');await page.locator('#okx-config').getByRole('button').click();
  await expect(page.locator('#okx-message')).toContainText('已加密保存');expect(saved.OKX_LIVE_PASSPHRASE).toBe('test-only-passphrase');await expect(live.locator('input').last()).toHaveValue('');
  await page.locator('#okx-mode').selectOption('live');await page.locator('#okx-check').click();await expect(page.locator('#okx-account')).toContainText('1000');
  const form=page.locator('#okx-order');await form.locator('[name="px"]').fill('60000');await form.locator('[name="sz"]').fill('0.001');await form.getByRole('button').click();
  await expect(page.locator('#okx-preview')).toContainText('unique-client-order');await expect(page.locator('#okx-submit')).toBeDisabled();expect(previewInput.mode).toBe('live');
  await page.locator('#okx-mode').selectOption('demo');await expect(page.locator('#okx-submit')).toBeDisabled();await form.getByRole('button').click();await expect(page.locator('#okx-submit')).toBeEnabled();
  await form.locator('[name="sz"]').fill('0.002');await expect(page.locator('#okx-submit')).toBeDisabled();
  await form.getByRole('button').click();await expect(page.locator('#okx-submit')).toBeEnabled();page.once('dialog',dialog=>dialog.accept());await page.locator('#okx-submit').click();
  await expect(page.locator('#okx-message')).toContainText('委托已受理');expect(submission.confirm).toBe('SUBMIT_OKX_DEMO_ORDER');
  await page.locator('[data-okx-reconcile]').click();await expect(page.locator('#okx-history')).toContainText('部分成交');
  page.once('dialog',dialog=>dialog.accept());await page.locator('[data-okx-cancel]').click();await expect(page.locator('#okx-message')).toContainText('撤单请求已受理');
  await page.locator('[data-okx-reconcile]').click();await expect(page.locator('#okx-history')).toContainText('已撤销');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);expect(errors).toEqual([]);
});

test('strategy workbench explicitly starts OKX demo execution with the selected asset and period',async({page})=>{
  let request;
  await page.route('**/api/okx/strategy/start',route=>{request=route.request().postDataJSON();return route.fulfill({status:201,json:{id:'demo-runner',mode:'demo',budget:'1000'}});});
  await page.goto('/');await page.getByRole('link',{name:'使用 ChatGPT 登录'}).click();await page.locator('[data-tab="backtest"]').click();
  await expect(page.locator('#draft-state')).not.toHaveText('正在恢复…');await page.locator('#new-draft').click();
  await page.locator('[name="assetId"]').selectOption('crypto:BTC-USDT');await page.locator('[name="timeframe"]').selectOption('15m');
  page.once('dialog',dialog=>dialog.accept());await page.locator('#start-okx-demo').click();await expect(page.locator('#notice')).toContainText('OKX 模拟盘策略已启动');
  expect(request.mode).toBe('demo');expect(request.config.timeframe).toBe('15m');expect(request.assetId).toBe('crypto:BTC-USDT');expect(request.confirm).toBe('START_OKX_DEMO_STRATEGY');
});
