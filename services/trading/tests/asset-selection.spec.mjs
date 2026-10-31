import {test,expect} from '@playwright/test';
const bars=Array.from({length:2000},(_,i)=>({time:Date.UTC(2020,0,1)+i*86400000,open:100+i*.01,high:102+i*.01,low:98+i*.01,close:101+i*.01,volume:1000}));
const assets=['BTC-USDT','ETH-USDT','AAPL','MSFT','NVDA','TSLA','AMD','AMZN','META','GOOG','SPY','QQQ'].map((symbol,i)=>({id:(i<2?'crypto:':'us:')+symbol,symbol,name:symbol+' Company',market:i<2?'crypto':'us',source:'csv',revision:1,bars:2000,asOf:bars.at(-1).time,updated:'2026-10-31',indicators:{close:120,sma20:118,ema20:118,rsi14:70,macd:2,macdSignal:1,bollingerUpper:122,bollingerLower:114,atr14:4,volatility20:.1}}));
async function enter(page){
  await page.route('**/api/state?*',route=>{const id=new URL(route.request().url()).searchParams.get('asset'),a=assets.find(a=>a.id===id)||assets[0];return route.fulfill({json:{assets,selectedAsset:{...a,data:bars},runs:[],sessions:[],events:[],analyses:[],connections:{deepseek:false},updated:'2026-10-31'}});});
  await page.route('**/api/quotes',r=>r.fulfill({json:{fetchedAt:'2026-10-31',quotes:assets.map(a=>({symbol:a.symbol,last:120,time:'2026-10-31',source:'test'}))}}));
  await page.goto('/');await page.getByRole('link',{name:'使用 ChatGPT 登录'}).click();await expect(page.locator('#live-quotes table')).toBeVisible();
}
const details=page=>page.locator('.chart-title h2');
function dataFor(route){const id=decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1));return {...assets.find(a=>a.id===id),data:bars};}
test('slow and superseded asset reads keep controls interactive and preserve watchlist, quotes and checkbox state',async({page})=>{
  // Simulate a transport that still delivers a response after cancellation.
  await page.addInitScript(()=>{const original=window.fetch;window.fetch=(input,options)=>original(input,typeof input==='string'&&input.includes('/api/assets/')?{...options,signal:undefined}:options);});
  await enter(page);let release,started;const held=new Promise(r=>release=r),ready=new Promise(r=>started=r);let oldReturned=false;
  const oldResponse=page.waitForResponse(r=>decodeURIComponent(r.url()).includes('/api/assets/us:AAPL'));
  await page.route('**/api/assets/*',async route=>{if(dataFor(route).symbol==='AAPL'){started();await held;try{await route.fulfill({json:dataFor(route)});}finally{oldReturned=true;}}else await route.fulfill({json:dataFor(route)});});
  await page.locator('[data-watch-check="us:NVDA"]').check();
  await page.evaluate(()=>{window.stableList=document.querySelector('.watchlist');window.stableQuotes=document.querySelector('#live-quotes');window.stableCheck=document.querySelector('[data-watch-check="us:NVDA"]');});
  try{
    await page.locator('[data-asset="us:AAPL"]').click();await ready;
    await expect(page.locator('[data-asset="us:AAPL"]')).toHaveAttribute('aria-pressed','true');
    await expect(page.locator('#asset-detail')).toHaveAttribute('aria-busy','true');await expect(page.locator('#import-open')).toBeDisabled();await expect(page.locator('#asset-detail [data-go="backtest"]')).toBeDisabled();
    await expect(page.locator('[data-tab="backtest"]')).toBeEnabled();await expect(page.locator('[data-asset="us:MSFT"]')).toHaveCSS('cursor','pointer');
    await page.locator('[data-asset="us:MSFT"]').click();await expect(details(page)).toHaveText('MSFT');
    await expect(page.locator('[data-asset="us:MSFT"]')).toBeFocused();
    expect(await page.evaluate(()=>stableList===document.querySelector('.watchlist')&&stableQuotes===document.querySelector('#live-quotes')&&stableCheck===document.querySelector('[data-watch-check="us:NVDA"]'))).toBe(true);
    await expect(page.locator('[data-watch-check="us:NVDA"]')).toBeChecked();
  }finally{release();await page.unrouteAll({behavior:'wait'});}
  await (await oldResponse).finished();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  expect(oldReturned).toBe(true);await expect(details(page)).toHaveText('MSFT');await expect(page.locator('#asset-detail')).toHaveAttribute('aria-busy','false');
});
test('navigation cancels pending selection; failed reads retain coherent details and are retryable',async({page})=>{
  await enter(page);let release,started;const held=new Promise(r=>release=r),ready=new Promise(r=>started=r);
  await page.route('**/api/assets/*',async route=>{started();await held;await route.fulfill({json:dataFor(route)});});
  try{await page.locator('[data-asset="us:AAPL"]').click();await ready;await page.locator('[data-tab="backtest"]').click();await expect(page.locator('#draft-name')).toBeEnabled();}
  finally{release();await page.unrouteAll({behavior:'wait'});}
  await expect(page.locator('#strategy-lab')).toBeVisible();await page.locator('[data-tab="overview"]').click();await expect(details(page)).toHaveText('BTC-USDT');
  let fail=true;await page.route('**/api/assets/*',r=>fail?r.fulfill({status:503,json:{error:'测试读取失败'}}):r.fulfill({json:dataFor(r)}));
  await page.locator('[data-asset="us:AAPL"]').click();await expect(page.locator('#asset-load-status')).toContainText('测试读取失败');await expect(details(page)).toHaveText('BTC-USDT');await expect(page.locator('[data-asset="crypto:BTC-USDT"]')).toHaveAttribute('aria-pressed','true');
  fail=false;await page.locator('[data-asset="us:AAPL"]').click();await expect(details(page)).toHaveText('AAPL');await expect(page.locator('#import-open')).toBeEnabled();
});
test('cached selection avoids repeat requests and database revision changes invalidate its chart',async({page})=>{
  await enter(page);let reads=0;await page.route('**/api/assets/*',r=>{reads++;return r.fulfill({json:dataFor(r)});});
  await page.locator('[data-asset="us:AAPL"]').click();await expect(details(page)).toHaveText('AAPL');
  const initialPath=await page.locator('.chart-line').getAttribute('d');
  await page.locator('[data-asset="crypto:BTC-USDT"]').click();await expect(details(page)).toHaveText('BTC-USDT');
  await page.locator('[data-asset="us:AAPL"]').click();await expect(details(page)).toHaveText('AAPL');expect(reads).toBe(1);
  await page.locator('[data-asset="crypto:BTC-USDT"]').click();await expect(details(page)).toHaveText('BTC-USDT');
  await page.route('**/api/state?*',r=>r.fulfill({json:{assets:assets.map(a=>a.symbol==='AAPL'?{...a,revision:2}:a),selectedAsset:{...assets[0],data:bars},runs:[],sessions:[],events:[],analyses:[],connections:{deepseek:false}}}));
  await page.route('**/api/assets/*',r=>{reads++;return r.fulfill({json:{...dataFor(r),revision:2,data:bars.map((b,i)=>({...b,close:100+Math.sin(i/10)*5}))}});});
  await page.locator('#read-database').click();await expect(page.locator('#read-database')).toBeEnabled();await page.locator('[data-asset="us:AAPL"]').click();await expect(details(page)).toHaveText('AAPL');expect(reads).toBe(2);
  expect(await page.locator('.chart-line').getAttribute('d')).not.toBe(initialPath);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});
