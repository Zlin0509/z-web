import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {MINUTE15,periodsPerYear,regularSession,intradayGap} from '../server/timeframes.mjs';
import {config,backtest,featureSeries} from '../server/engine.mjs';
import {loadIntraday} from '../server/providers.mjs';
import {prepareIntraday,refreshIntraday} from '../server/intraday.mjs';
import {strategyAsset,readSeries,seriesKey} from '../server/series.mjs';
import {init,startPaper,advancePaper,runBacktest,removeAsset,importBars} from '../server/service.mjs';
import {researchSession,memoryProjection,ENGINE_VERSION,executionMemory,putRecord} from '../server/research.mjs';
import {proposeStrategy} from '../server/strategies.mjs';
import {handleRequest} from '../server/controller.mjs';
const end=Math.floor((Date.now()-30000)/MINUTE15)*MINUTE15;
const bars=Array.from({length:300},(_,i)=>{const close=100+6*Math.sin(i/7)+i*.01;return {time:end-(301-i)*MINUTE15,open:close-.2,close,high:close+1,low:close-1,volume:1000+i};});
const daily=bars.map((b,i)=>({...b,time:Date.UTC(2025,0,1)+i*86400000}));
const okx=b=>[String(b.time),String(b.open),String(b.high),String(b.low),String(b.close),String(b.volume),'0','0','1'];
async function setup(t){const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec(readFileSync(new URL('../drizzle/0000_thick_randall_flagg.sql',import.meta.url),'utf8'));const DB={prepare(q){let args=[];return {bind(...a){args=a;return this;},first(){return db.prepare(q).get(...args)},all(){return {results:db.prepare(q).all(...args)}},run(){return {meta:{changes:Number(db.prepare(q).run(...args).changes)}}}}},batch(statements){db.exec('BEGIN');try{const r=statements.map(s=>s.run());db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}};await init(DB);await DB.prepare("UPDATE assets SET data=?,status='ready' WHERE id='crypto:BTC-USDT'").bind(JSON.stringify(daily)).run();return {DB,TRADING_OWNER_EMAIL:'owner@test.com'};}
function cryptoFetcher(sample=bars){return async url=>{const u=new URL(url);assert.equal(u.searchParams.get('bar'),'15m');assert.equal(u.pathname,'/api/v5/market/history-candles');const before=Number(u.searchParams.get('after')||Infinity);return Response.json({code:'0',data:sample.filter(b=>b.time<before).slice(-300).reverse().map(okx)});};}
const p=config({timeframe:'15m',fast:5,slow:20});
test('timeframes preserve daily defaults and use market-specific intraday annualization',()=>{
  assert.equal(config().timeframe,'1d');assert.throws(()=>config({timeframe:'1m'}));assert.equal(periodsPerYear('crypto','15m'),35040);assert.equal(periodsPerYear('us','15m'),6552);
  const a=featureSeries(bars,p,'crypto'),b=featureSeries(bars,{...p,timeframe:'1d'},'crypto');assert.ok(Math.abs(a.volatility20.at(-1)/b.volatility20.at(-1)-Math.sqrt(96))<1e-10);
  const x=backtest(bars,p),y=backtest(bars,{...p,timeframe:'1d'});assert.deepEqual(x.trades,y.trades);assert.ok(Math.abs(x.metrics.sharpe/y.metrics.sharpe-Math.sqrt(96))<1e-10);
  assert.throws(()=>backtest([...bars,{...bars.at(-1),time:Math.floor(Date.now()/MINUTE15)*MINUTE15}],p),/已完成/);
});
test('US regular-session boundaries handle DST and gaps within a session remain visible',()=>{
  for(const t of ['2026-01-02T14:30:00Z','2026-06-01T13:30:00Z','2026-06-01T19:45:00Z'])assert.equal(regularSession(Date.parse(t)),true);
  for(const t of ['2026-06-01T13:15:00Z','2026-06-01T20:00:00Z','2026-06-06T14:30:00Z'])assert.equal(regularSession(Date.parse(t)),false);
  assert.equal(intradayGap(Date.parse('2026-06-01T19:45Z'),Date.parse('2026-06-02T13:30Z'),'us'),false);assert.equal(intradayGap(bars[0].time,bars[2].time,'crypto'),true);
});
test('OKX 15m pagination excludes unconfirmed/current bars and validates alignment',async()=>{
  const sample=Array.from({length:900},(_,i)=>({...bars[0],time:end-(901-i)*MINUTE15}));let calls=0;
  const result=await loadIntraday({symbol:'BTC-USDT',market:'crypto'},{},async url=>{calls++;const data=await cryptoFetcher(sample)(url),json=await data.json();if(calls===1)json.data.unshift([String(end),'1','2','1','1','1','0','0','0']);return Response.json(json);});
  assert.equal(result.length,900);assert.equal(calls,3);assert.ok(result.every(b=>b.time+MINUTE15<=Date.now()));
  await assert.rejects(()=>loadIntraday({symbol:'BTC-USDT',market:'crypto',since:bars.at(-1).time},{},async()=>Response.json({code:'0',data:[okx({...bars[0],time:bars[0].time+1})]})),/对齐/);
});
test('Alpaca uses 15Min IEX, paginates, and excludes extended-hours bars',async()=>{
  let calls=0;const times=['2026-06-01T13:15:00Z','2026-06-01T13:30:00Z','2026-06-01T13:45:00Z','2026-06-01T20:00:00Z'];
  const result=await loadIntraday({symbol:'AAPL',market:'us'},{ALPACA_API_KEY:'test',ALPACA_SECRET_KEY:'test'},async(url,options)=>{const u=new URL(url);assert.equal(u.searchParams.get('timeframe'),'15Min');assert.equal(u.searchParams.get('feed'),'iex');assert.equal(u.searchParams.get('adjustment'),'raw');assert.ok(options.headers['APCA-API-KEY-ID']);return Response.json({bars:times.slice(calls*2,++calls*2).map(t=>({t,o:100,h:102,l:99,c:101,v:1000})),next_page_token:calls===1?'page2':null});});
  assert.equal(calls,2);assert.equal(result.length,2);await assert.rejects(()=>loadIntraday({symbol:'AAPL',market:'us'},{},()=>{throw Error('no call')}),e=>e.status===424);
});
test('intraday is a separate persistent subscription, deduplicates checks, retains history on failure, and unregisters on deletion',async t=>{
  const env=await setup(t);let calls=0;const fetcher=async(...args)=>{calls++;return cryptoFetcher()(...args);};
  assert.equal((await prepareIntraday(env,'crypto:BTC-USDT',fetcher)).status,'ready');const n=calls;await refreshIntraday(env,null,fetcher);assert.equal(calls,n);
  const a=await strategyAsset(env.DB,'crypto:BTC-USDT','15m');assert.equal(JSON.parse(a.data).length,300);assert.equal(JSON.parse((await strategyAsset(env.DB,a.id)).data).length,daily.length);assert.deepEqual(JSON.parse((await strategyAsset(env.DB,a.id)).data),daily);
  assert.ok((await env.DB.prepare("SELECT key FROM service_state WHERE key GLOB 'history:15m:*'").all()).results.length);
  const old=await readSeries(env.DB,a.id);old.checkedSlot=0;await putRecord(env.DB,seriesKey(a.id),old);const failed=await refreshIntraday(env,a.id,async()=>new Response('',{status:503}));assert.equal(failed[0].status,'error');assert.deepEqual((await readSeries(env.DB,a.id)).bars,old.bars);
  await removeAsset(env.DB,a.id,a.revision);assert.equal(await readSeries(env.DB,a.id),null);assert.deepEqual(await refreshIntraday(env,null,()=>{throw Error('removed')}),[]);
});
test('15m paper runs advance once per new bar and never consume daily bars or daily CSV imports',async t=>{
  const env=await setup(t);await prepareIntraday(env,'crypto:BTC-USDT',cryptoFetcher());const a=await strategyAsset(env.DB,'crypto:BTC-USDT','15m'),id=await startPaper(env.DB,a.id,p);
  const row=()=>env.DB.prepare('SELECT * FROM paper_sessions WHERE id=?').bind(id).first();const initial=row();
  await advancePaper(env.DB,{...a,timeframe:'1d'},daily);assert.equal(row().revision,initial.revision);
  const next={...bars.at(-1),time:bars.at(-1).time+MINUTE15};await advancePaper(env.DB,a,[...bars,next]);const once=row();assert.equal(once.revision,initial.revision+1);assert.equal(JSON.parse(once.data).portfolio.lastTime,next.time);
  await advancePaper(env.DB,a,[...bars,next]);assert.deepEqual(row(),once);
  await importBars(env.DB,a.id,daily,a.revision);assert.equal(row().status,'running');
  await advancePaper(env.DB,a,[...bars,next,{...next,time:next.time+2*MINUTE15}]);assert.equal(row().status,'paused');
});
test('backtests, research snapshots and memory are isolated by timeframe',async t=>{
  const env=await setup(t);await prepareIntraday(env,'crypto:BTC-USDT',cryptoFetcher());const a=await strategyAsset(env.DB,'crypto:BTC-USDT','15m');
  const run=await runBacktest(env.DB,a.id,p);assert.equal(run.result.config.timeframe,'15m');assert.equal(run.result.source.timeframe,'15m');
  const d=await researchSession(env.DB,await strategyAsset(env.DB,a.id)),s=await researchSession(env.DB,a);assert.notEqual(d.id,s.id);assert.equal(s.source.timeframe,'15m');assert.equal(d.source.timeframe,undefined);
  const exp={schemaVersion:2,id:'e',assetId:a.id,config:p,source:s.source,engineVersion:ENGINE_VERSION,outcomeEnd:bars[100].time,evaluation:{aggregate:{candidate:{closedTrades:12}},decision:'eligible'}};
  assert.ok(memoryProjection(exp,s,'range'));assert.equal(memoryProjection({...exp,config:{...p,timeframe:'1d'}},s,'range'),null);
  await env.DB.prepare("INSERT INTO paper_sessions(id,asset_id,created,status,data) VALUES('daily',?,'2026-01-01','stopped',?)").bind(a.id,JSON.stringify({config:{timeframe:'1d'},portfolio:{trades:[{time:bars[10].time,side:'sell',fee:1,pnl:1}]}})).run();assert.deepEqual(await executionMemory(env.DB,s),[]);
});
test('AI receives 15m training and cannot switch timeframe or read the daily research window',async t=>{
  const env=await setup(t);await prepareIntraday(env,'crypto:BTC-USDT',cryptoFetcher());env.DEEPSEEK_API_KEY='test';env.DEEPSEEK_MODEL='chosen';
  const result=await proposeStrategy(env,{assetId:'crypto:BTC-USDT',mode:'generate',prompt:'用15分钟趋势控制回撤',rounds:1,config:p},async(_,options)=>{const req=JSON.parse(options.body),c=JSON.parse(req.messages[1].content);assert.equal(c.baseline.timeframe,'15m');assert.equal(c.source.timeframe,'15m');assert.match(req.messages[0].content,/15分钟K线/);return Response.json({choices:[{message:{content:JSON.stringify({name:'分钟趋势',rationale:'测试',risks:['噪声'],config:{...p,timeframe:'1d',strategy:'custom',rules:{entry:{match:'all',conditions:[{left:'sma_fast',op:'gt',right:'sma_slow'}]},exit:{match:'any',conditions:[{left:'sma_fast',op:'lt',right:'sma_slow'}]}}}})}}]});});
  assert.equal(result.config.timeframe,'15m');assert.equal(result.source.timeframe,'15m');assert.equal((await env.DB.prepare('SELECT count(*) n FROM paper_sessions').first()).n,0);
});
test('period preparation is owner-only and requires CSRF validation',async t=>{
  const env=await setup(t);for(const method of ['GET','POST'])assert.equal((await handleRequest(new Request('https://test/api/market-series?asset=us:AAPL',{method}),env,null)).status,401);
  assert.equal((await handleRequest(new Request('https://test/api/market-series',{method:'POST',headers:{'Content-Type':'application/json',origin:'https://evil'},body:'{}'}),env,{userId:'owner',email:'owner@test.com'})).status,403);
});

test('an in-flight minute refresh cannot resurrect a deleted subscription',async t=>{
  const env=await setup(t);
  await prepareIntraday(env,'crypto:BTC-USDT',cryptoFetcher());
  const old=await readSeries(env.DB,'crypto:BTC-USDT');
  await putRecord(env.DB,seriesKey(old.assetId),{...old,checkedSlot:0});
  const result=await refreshIntraday(env,old.assetId,async(...args)=>{
    const a=await strategyAsset(env.DB,old.assetId);
    await removeAsset(env.DB,a.id,a.revision);
    return cryptoFetcher()(...args);
  });
  assert.equal(result[0].status,'conflict');
  assert.equal(await readSeries(env.DB,old.assetId),null);
});

test('an archive failure retries the same slot before committing the minute cache',async t=>{
  const env=await setup(t),prepare=env.DB.prepare.bind(env.DB);
  let failing=true;
  env.DB.prepare=query=>{
    const statement=prepare(query);
    if(query.startsWith('INSERT INTO service_state(key,value) VALUES(?,?) ON CONFLICT')){
      const bind=statement.bind;
      statement.bind=function(...args){
        bind.apply(this,args);
        if(failing&&String(args[0]).startsWith('history:15m:'))this.run=()=>{throw Error('archive temporarily unavailable');};
        return this;
      };
    }
    return statement;
  };
  assert.equal((await prepareIntraday(env,'crypto:BTC-USDT',cryptoFetcher())).status,'error');
  assert.equal((await readSeries(env.DB,'crypto:BTC-USDT')).bars.length,0);
  failing=false;
  assert.equal((await refreshIntraday(env,'crypto:BTC-USDT',cryptoFetcher()))[0].status,'ready');
  assert.equal((await readSeries(env.DB,'crypto:BTC-USDT')).bars.length,300);
});

test('owner API exposes cached minute preparation and sends the selected period into backtest and paper execution',async t=>{
  const env=await setup(t),user={userId:'owner',email:'owner@test.com'};
  await prepareIntraday(env,'crypto:BTC-USDT',cryptoFetcher());
  const request=(path,input)=>new Request('https://test/api/'+path,input?{
    method:'POST',headers:{'Content-Type':'application/json',origin:'https://test','x-trading-request':'1'},body:JSON.stringify(input)
  }:{});
  const summary=await handleRequest(request('market-series?asset=crypto%3ABTC-USDT'),env,user);
  assert.equal(summary.status,200);assert.equal((await summary.json()).bars,300);
  const prepared=await handleRequest(request('market-series',{assetId:'crypto:BTC-USDT',timeframe:'15m'}),env,user);
  assert.equal(prepared.status,200);assert.equal((await prepared.json()).status,'cached');
  const result=await handleRequest(request('backtest',{assetId:'crypto:BTC-USDT',config:p}),env,user);
  assert.equal(result.status,201);assert.equal((await result.json()).result.config.timeframe,'15m');
  const paper=await handleRequest(request('paper',{assetId:'crypto:BTC-USDT',config:p}),env,user);
  assert.equal(paper.status,201);
  const invalid=await handleRequest(request('market-series',{assetId:'crypto:BTC-USDT',timeframe:'1m'}),env,user);
  assert.equal(invalid.status,400);
});
