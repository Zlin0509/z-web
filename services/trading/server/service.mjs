import {Problem,indicators,config,backtest,targets,startPortfolio,step} from './engine.mjs';
import {loadMarket,marketSource} from './providers.mjs';
const now=()=>new Date().toISOString();
export async function log(db,kind,detail){await db.prepare('INSERT INTO events (id,created,kind,detail) VALUES (?,?,?,?)').bind(crypto.randomUUID(),now(),kind,JSON.stringify(detail)).run();}
export async function init(db) {
  if(await db.prepare("SELECT value FROM service_state WHERE key='initialized'").first())return;
  const defaults=[['crypto:BTC-USDT','BTC-USDT','crypto','okx'],['crypto:ETH-USDT','ETH-USDT','crypto','okx'],['us:AAPL','AAPL','us','alpha'],['us:SPY','SPY','us','alpha']];
  await db.batch([...defaults.map(x=>db.prepare('INSERT OR IGNORE INTO assets (id,symbol,market,source) VALUES (?,?,?,?)').bind(...x)),db.prepare("INSERT OR IGNORE INTO service_state (key,value) VALUES ('initialized','1')")]);
}
export async function authorize(db,user,email){
  if(!user)throw new Problem(401,'请使用站点所有者账号登录。');
  const owner=await db.prepare("SELECT value FROM service_state WHERE key='owner'").first();
  if(owner){if(owner.value!==user.userId)throw new Problem(403,'此账号没有交易研究室权限。');return;}
  if(!email||user.email.toLowerCase()!==email.toLowerCase())throw new Problem(403,'此账号没有交易研究室权限。');
  await db.prepare("INSERT OR IGNORE INTO service_state (key,value) VALUES ('owner',?)").bind(user.userId).run();
  if((await db.prepare("SELECT value FROM service_state WHERE key='owner'").first()).value!==user.userId)throw new Problem(403,'管理员身份不匹配。');
}
export async function assetById(db,id){const a=await db.prepare('SELECT * FROM assets WHERE id=?').bind(id).first();if(!a)throw new Problem(404,'没有找到这个标的。');return a;}
export function describe(a){const bars=JSON.parse(a.data);return {...a,data:undefined,bars:bars.length,asOf:bars.at(-1)?.time??null,indicators:bars.length?indicators(bars,a.market):null};}
export async function state(db,env){
  const [assets,runs,sessions,events,analyses]=await Promise.all([
    db.prepare('SELECT * FROM assets ORDER BY market,symbol').all(),
    db.prepare('SELECT id,asset_id,created,result FROM backtests ORDER BY created DESC LIMIT 30').all(),
    db.prepare('SELECT * FROM paper_sessions ORDER BY created DESC LIMIT 30').all(),
    db.prepare('SELECT * FROM events ORDER BY created DESC LIMIT 40').all(),
    db.prepare('SELECT * FROM analyses ORDER BY created DESC LIMIT 20').all()
  ]);
  return {assets:assets.results.map(describe),runs:runs.results.map(r=>({...r,result:JSON.parse(r.result)})),sessions:sessions.results.map(r=>({...r,data:JSON.parse(r.data)})),events:events.results.map(x=>({...x,detail:JSON.parse(x.detail)})),analyses:analyses.results.map(x=>({...x,data:JSON.parse(x.data)})),connections:{okxMarket:true,usData:!!(env.ALPHA_VANTAGE_API_KEY||(env.ALPACA_API_KEY&&env.ALPACA_SECRET_KEY)),okxAccount:!!(env.OKX_API_KEY&&env.OKX_SECRET_KEY&&env.OKX_PASSPHRASE),deepseek:!!(env.DEEPSEEK_API_KEY&&env.DEEPSEEK_MODEL),liveTrading:false},updated:now()};
}
export async function addAsset(db,input){
  const {market}=input,symbol=String(input.symbol??'').trim().toUpperCase();const source=input.source??(market==='crypto'?'okx':'alpha');
  if(!['us','crypto'].includes(market)||!(market==='crypto'?/^[A-Z0-9]{2,15}-USDT$/:/^[A-Z][A-Z0-9.-]{0,9}$/).test(symbol)||!['csv',market==='crypto'?'okx':'alpha'].includes(source))throw new Problem(400,'请输入美股代码（如 AAPL）或 USDT 现货交易对（如 BTC-USDT）。');
  const count=await db.prepare('SELECT count(*) AS n FROM assets').first();if(count.n>=12)throw new Problem(400,'第一版最多跟踪 12 个标的。');
  try{await db.prepare('INSERT INTO assets (id,symbol,market,source) VALUES (?,?,?,?)').bind(market+':'+symbol,symbol,market,source).run();}catch(e){if(/UNIQUE/.test(String(e)))throw new Problem(409,'这个标的已在列表中。');throw e;}
}
export async function importBars(db,id,bars,revision){const a=await assetById(db,id);if(!Number.isInteger(revision))throw new Problem(400,'缺少版本号。');const r=await db.prepare("UPDATE assets SET data=?,source='csv',status='ready',message=NULL,updated=?,revision=revision+1 WHERE id=? AND revision=?").bind(JSON.stringify(bars),now(),id,revision).run();if(r.meta.changes!==1)throw new Problem(409,'数据已更新，请刷新后再导入。');await db.prepare("UPDATE paper_sessions SET status='paused',revision=revision+1 WHERE asset_id=? AND status='running'").bind(id).run();await log(db,'import',{symbol:a.symbol,bars:bars.length,activePaper:'paused'});}
export async function removeAsset(db,id,revision){
  const asset=await assetById(db,id);if(!Number.isInteger(revision))throw new Problem(400,'缺少标的版本号，请刷新后再试。');
  const result=await db.batch([
    db.prepare('DELETE FROM assets WHERE id=? AND revision=?').bind(id,revision),
    db.prepare("UPDATE paper_sessions SET status='stopped',revision=revision+1 WHERE asset_id=? AND status IN ('running','paused') AND NOT EXISTS(SELECT 1 FROM assets WHERE id=?)").bind(id,id),
    db.prepare("DELETE FROM service_state WHERE key='quotes_cache'")
  ]);
  if(result[0].meta.changes!==1)throw new Problem(409,'标的数据已更新，请刷新后再删除。');
  await log(db,'asset_removed',{symbol:asset.symbol,stopped:result[1].meta.changes,history:'retained'});
  return {ok:true,symbol:asset.symbol,stopped:result[1].meta.changes};
}
export async function runBacktest(db,id,options){const a=await assetById(db,id);const result=backtest(JSON.parse(a.data),options,a.market);result.source={provider:a.source,updated:a.updated,symbol:a.symbol,priceBasis:a.market==='us'?'未保证复权；跨拆股区间需自行导入一致复权 OHLC':'现货日线'};const run={id:crypto.randomUUID(),created:now(),asset_id:id,result};await db.prepare('INSERT INTO backtests (id,asset_id,created,result) VALUES (?,?,?,?)').bind(run.id,id,run.created,JSON.stringify(result)).run();await log(db,'backtest',{symbol:a.symbol,id:run.id,return:result.metrics.totalReturn});return run;}
export async function startPaper(db,id,options){const a=await assetById(db,id),bars=JSON.parse(a.data),p=config(options);if(a.source==='csv')throw new Problem(400,'模拟运行需要联网行情；CSV 用于离线回测。');if(bars.length<Math.max(p.slow,35)+5)throw new Problem(400,'请先同步足够日线数据。');if(Date.now()-bars.at(-1).time>(a.market==='crypto'?3:7)*86400000)throw new Problem(409,'行情过旧，请先刷新数据。');
  const active=await db.prepare("SELECT count(*) AS n FROM paper_sessions WHERE status='running'").first();if(active.n>=6)throw new Problem(409,'最多同时运行 6 个模拟策略。');
  const idNew=crypto.randomUUID(),portfolio=startPortfolio(p);portfolio.lastTime=bars.at(-1).time;
  const data={config:p,portfolio,started:now()};const created=await db.prepare("INSERT INTO paper_sessions (id,asset_id,created,status,data) SELECT ?,?,?,'running',? WHERE EXISTS(SELECT 1 FROM assets WHERE id=? AND revision=?)").bind(idNew,id,now(),JSON.stringify(data),id,a.revision).run();if(created.meta.changes!==1)throw new Problem(409,'标的已删除或数据已变化，请刷新后再启动。');await log(db,'paper_started',{id:idNew,symbol:a.symbol});return idNew;
}
async function advancePaper(db,asset,bars){
  const sessions=(await db.prepare("SELECT * FROM paper_sessions WHERE asset_id=? AND status='running'").bind(asset.id).all()).results;
  for(const session of sessions){const data=JSON.parse(session.data),signal=targets(bars,data.config);let portfolio=data.portfolio;let missing=portfolio.lastTime<bars[0].time;
    if(missing){await db.prepare("UPDATE paper_sessions SET status='paused',revision=revision+1 WHERE id=? AND revision=?").bind(session.id,session.revision).run();await log(db,'paper_gap',{id:session.id,message:'缺失历史 K 线，已暂停，未推测成交。'});continue;}
    for(let i=1;i<bars.length;i++)if(bars[i].time>portfolio.lastTime)portfolio=step(portfolio,bars[i],signal[i-1],data.config);
    if(portfolio.lastTime===data.portfolio.lastTime)continue;
    data.portfolio=portfolio;const newOrders=portfolio.trades.filter(t=>t.time>JSON.parse(session.data).portfolio.lastTime);
    const r=await db.prepare('UPDATE paper_sessions SET data=?,status=?,revision=revision+1 WHERE id=? AND revision=?').bind(JSON.stringify(data),portfolio.halted?'halted':'running',session.id,session.revision).run();if(r.meta.changes===1)await log(db,'paper_advanced',{id:session.id,orders:newOrders,mode:'paper',halted:portfolio.halted});
  }
}
export async function refresh(db,env,id=null,fetcher=fetch){
  const lease=crypto.randomUUID(),expires=Date.now()+300000;
  const locked=await db.prepare("INSERT INTO service_state(key,value) VALUES('refresh_lock',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(json_extract(service_state.value,'$.expires') AS INTEGER)<?").bind(JSON.stringify({lease,expires}),Date.now()).run();
  if(locked.meta.changes!==1)throw new Problem(409,'行情同步正在进行，请稍后查看。');
  const report=[];
  try{const assets=id?[await assetById(db,id)]:(await db.prepare("SELECT * FROM assets WHERE source!='csv' ORDER BY market,symbol").all()).results;
    for(const asset of assets){try{
      const old=JSON.parse(asset.data),latest=old.at(-1)?.time,source=marketSource(asset,env),changed=source!==asset.source;
      const currentDay=Math.floor(Date.now()/86400000)*86400000;
      const cached=!changed&&asset.source!=='csv'&&old.length>0&&(asset.market==='crypto'?latest>=currentDay-86400000:Date.now()-Date.parse(asset.updated)<900000);
      if(cached){
        await advancePaper(db,asset,old);
        await db.prepare("UPDATE assets SET status='ready',message=NULL WHERE id=? AND revision=?").bind(asset.id,asset.revision).run();
        report.push({symbol:asset.symbol,status:'cached',bars:old.length,message:'已复用最新完整日线，无需重复请求。'});continue;
      }
      const incoming=await loadMarket(asset,{...env,DB:db},fetcher),merged=[...new Map([...(changed?[]:old),...incoming].map(b=>[b.time,b])).values()].sort((a,b)=>a.time-b.time).slice(-2000);
      const update=db.prepare("UPDATE assets SET data=?,source=?,status='ready',message=NULL,updated=?,revision=revision+1 WHERE id=? AND revision=?").bind(JSON.stringify(merged),source,now(),asset.id,asset.revision);
      const r=changed?(await db.batch([update,db.prepare("UPDATE paper_sessions SET status='paused',revision=revision+1 WHERE asset_id=? AND status='running' AND EXISTS(SELECT 1 FROM assets WHERE id=? AND source=? AND revision=?)").bind(asset.id,asset.id,source,asset.revision+1)]))[0]:await update.run();
      if(r.meta.changes!==1){report.push({symbol:asset.symbol,status:'conflict'});continue;}
      if(changed){await log(db,'source_changed',{symbol:asset.symbol,from:asset.source,to:source,activePaper:'paused'});}
      else await advancePaper(db,asset,merged);
      report.push({symbol:asset.symbol,status:'ready',bars:merged.length,source});
    }catch(error){
      const message=error instanceof Problem?error.message:'更新失败，已保留之前的数据。';
      const status=error.status===424?'needs_key':error.status===429?'rate_limited':'error';
      await db.prepare('UPDATE assets SET status=?,message=? WHERE id=? AND revision=?').bind(status,message,asset.id,asset.revision).run();
      report.push({symbol:asset.symbol,status,message,...(error.retryAt?{retryAt:new Date(error.retryAt).toISOString()}:{})});
    }}
    await log(db,'refresh',{report});return {report,completedAt:now()};
  }finally{await db.prepare("DELETE FROM service_state WHERE key='refresh_lock' AND json_extract(value,'$.lease')=?").bind(lease).run();}
}
