import {test,expect} from '@playwright/test';
async function enter(page){await page.goto('/');await page.getByRole('link',{name:'使用 ChatGPT 登录'}).click();await page.locator('[data-tab="backtest"]').click();await expect(page.locator('#draft-name')).toBeEnabled();}
test('acknowledged saves and navigation reuse summaries; stale refresh cannot overwrite saved names',async({page},info)=>{
  await enter(page);await page.locator('#new-draft').click();
  const name='性能回归 '+info.project.name+' '+Date.now();await page.locator('#draft-name').fill(name);
  await expect(page.locator('#draft-state')).toContainText('已保存到数据库');await page.locator('#library-search').fill(name);
  const card=page.locator('.strategy-card').filter({has:page.getByText(name,{exact:true})});await expect(card).toBeVisible();await expect(page.locator('.strategy-card')).toHaveCount(1);
  let reads=0,release,started;const held=new Promise(r=>release=r),ready=new Promise(r=>started=r);
  await page.route('**/api/strategy-library?*',async route=>{reads++;const response=await route.fetch();started();await held;await route.fulfill({response});});
  // Hold an old list response while the draft is changed and acknowledged.
  try{await page.locator('#library-refresh').click();await ready;
  await page.locator('#draft-name').fill(name+' 已更新');await expect(page.locator('#draft-state')).toContainText('已保存到数据库');
  await expect(page.locator('.strategy-card b').filter({hasText:name+' 已更新'})).toBeVisible();
  await page.locator('[data-tab="overview"]').click();await expect(page.locator('#live-quotes')).toBeVisible();
  await page.locator('[data-tab="backtest"]').click();await expect(page.locator('#draft-name')).toHaveValue(name+' 已更新');
  expect(reads).toBe(1);}finally{release();await page.unrouteAll({behavior:'wait'});}
  await expect(page.locator('.strategy-card b').filter({hasText:name+' 已更新'})).toBeVisible();
  let fresh=0;await page.route('**/api/strategy-library?*',async route=>{fresh++;await route.continue();});
  await page.locator('#library-refresh').click();await expect.poll(()=>fresh).toBe(1);
});
test('repeated category clicks share one pending request and editor does not fetch historical run bodies',async({page})=>{
  let runReads=0;page.on('request',r=>{if(/\/api\/runs\//.test(r.url()))runReads++;});await enter(page);
  let reads=0,release,started;const held=new Promise(r=>release=r),ready=new Promise(r=>started=r);
  await page.route('**/api/strategy-library?*',async route=>{if(new URL(route.request().url()).searchParams.get('kind')!=='version')return route.continue();reads++;started();await held;await route.continue();});
  await page.locator('[data-library-kind="version"]').click();await ready;await page.locator('[data-library-kind="version"]').click();
  // A later local render lets both click handlers run without a clock-dependent network assertion.
  await page.locator('[data-library-kind="draft"]').click();await expect(page.locator('[data-library-kind="draft"]')).toHaveAttribute('aria-selected','true');
  expect(reads).toBe(1);expect(runReads).toBe(0);release();await page.unrouteAll({behavior:'wait'});
  await expect(page.locator('[data-library-kind="draft"]')).toHaveAttribute('aria-selected','true');
});

test('editing a draft on a large library first page updates locally and preserves pagination',async({page},info)=>{
  await enter(page);await page.locator('#new-draft').click();const name='分页性能 '+info.project.name+' '+Date.now();
  await page.locator('#draft-name').fill(name);await expect(page.locator('#draft-state')).toContainText('已保存到数据库');
  let reads=0;await page.route('**/api/strategy-library?*',async route=>{
    reads++;const response=await route.fetch(),data=await response.json();
    while(data.items.length<40)data.items.push({kind:'draft',id:'placeholder-'+data.items.length,name:'分页摘要',assetId:'us:AAPL',strategy:'ma',metaRevision:0});
    data.counts.draft=80;data.total=80;data.nextOffset=40;await route.fulfill({json:data});
  });
  await page.locator('#library-refresh').click();await expect(page.locator('.strategy-card')).toHaveCount(40);await expect(page.locator('#library-more')).toBeVisible();
  await page.locator('#draft-name').fill(name+' 修改');await expect(page.locator('#draft-state')).toContainText('已保存到数据库');
  await expect(page.locator('.strategy-card b').filter({hasText:name+' 修改'})).toBeVisible();
  await page.locator('[data-tab="overview"]').click();await page.locator('[data-tab="backtest"]').click();
  await expect(page.locator('.strategy-card')).toHaveCount(40);await expect(page.locator('#library-more')).toBeVisible();expect(reads).toBe(1);
});
