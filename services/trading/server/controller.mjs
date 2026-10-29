import * as connections from './connections.mjs';
import {Problem,parseCSV,indicators} from './engine.mjs';
import {init,authorize,state,assetById,addAsset,importBars,runBacktest,startPaper,refresh,log} from './service.mjs';
import {analyze,okxAccount,executeLiveOrder} from './providers.mjs';
import {page,login} from '../ui/page.mjs';
const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Robots-Tag':'noindex, nofollow','Referrer-Policy':'same-origin'};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{...headers,'Content-Type':'application/json; charset=utf-8'}});
const html=(text,status=200)=>new Response(text,{status,headers:{...headers,'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' wss://ws.okx.com:8443; frame-ancestors 'self'; base-uri 'none'; form-action 'self'"}});
async function body(request){if(!request.headers.get('content-type')?.startsWith('application/json'))throw new Problem(415,'需要 JSON 请求。');if(request.headers.get('origin')!==new URL(request.url).origin||request.headers.get('x-trading-request')!=='1'||request.headers.get('sec-fetch-site')==='cross-site')throw new Problem(403,'请求来源验证失败。');const reader=request.body?.getReader();if(!reader)throw new Problem(400,'请求内容为空。');let size=0,chunks=[];for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>1200000){await reader.cancel();throw new Problem(413,'请求过大。');}chunks.push(value);}const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}try{const value=JSON.parse(new TextDecoder().decode(bytes));if(!value||typeof value!=='object'||Array.isArray(value))throw 0;return value;}catch{throw new Problem(400,'请求格式不正确。');}}
export async function handleRequest(request,env,user){
  const path=new URL(request.url).pathname.replace(/\/+$/,'')||'/';
  try{
    if(path==='/health')return json({service:'zlin-trading',status:'ok',execution:'paper_only'});
    if(!env.DB)throw new Problem(503,'交易数据库暂不可用。');
    // This service is OWNER-PRIVATE at the Sites access boundary. Dispatch consumes
    // its service credential before these unattended routes; never make this Site public.
    if(path==='/internal/refresh'&&request.method==='POST'){if(request.headers.get('origin')||request.headers.get('x-trading-service')!=='1')throw new Problem(403,'仅支持服务端调度。');await init(env.DB);return json(await refresh(env.DB,await connections.configured(env)));}
    if(path==='/internal/status'&&request.method==='GET'){await init(env.DB);const s=await state(env.DB,env);return json({assets:s.assets,events:s.events.slice(0,2)});}
    if(!user){if(path==='/')return html(login());throw new Problem(401,'请先登录交易研究室。');}
    await authorize(env.DB,user,env.TRADING_OWNER_EMAIL);await init(env.DB);env=await connections.configured(env);
    if(path==='/schwab/callback'&&request.method==='GET'){await connections.finishOAuth(env,user,new URL(request.url));return new Response(null,{status:303,headers:{Location:'/#integrations','Cache-Control':'no-store'}});}
    if(path==='/api/settings'&&request.method==='GET')return json(await connections.settings(env));
    if(path==='/api/quotes'&&request.method==='GET'){const cached=await env.DB.prepare("SELECT value FROM service_state WHERE key='quotes_cache'").first();if(cached&&Date.now()-JSON.parse(cached.value).time<15000)return json(JSON.parse(cached.value).data);const data=await connections.quotes(env);await env.DB.prepare("INSERT INTO service_state(key,value) VALUES('quotes_cache',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify({time:Date.now(),data})).run();return json(data);}
    if(path==='/api/schwab/accounts'&&request.method==='GET')return json({accounts:await connections.accounts(env),numbers:await connections.accountNumbers(env)});
    if(path==='/'&&request.method==='GET')return html(page());
    if(path==='/api/state'&&request.method==='GET')return json(await state(env.DB,env));
    const assetMatch=path.match(/^\/api\/assets\/([^/]+)$/);
    if(assetMatch&&request.method==='GET'){const a=await assetById(env.DB,decodeURIComponent(assetMatch[1]));return json({...a,data:JSON.parse(a.data)});}
    const runMatch=path.match(/^\/api\/runs\/([^/]+)\/export$/);
    if(runMatch&&request.method==='GET'){const run=await env.DB.prepare('SELECT * FROM backtests WHERE id=?').bind(runMatch[1]).first();if(!run)throw new Problem(404,'回测不存在。');return new Response(run.result,{headers:{...headers,'Content-Type':'application/json','Content-Disposition':'attachment; filename="backtest.json"'}});}
    if(request.method!=='POST')throw new Problem(404,'接口不存在。');
    const input=await body(request);
    if(path==='/api/settings')return json(await connections.saveSettings(env,input));
    if(path==='/api/schwab/connect')return json(await connections.beginOAuth(env,user,new URL(request.url).origin));
    if(path==='/api/schwab/orders')return json(await connections.orders(env,input.account));
    if(path==='/api/schwab/preview')return json(await connections.previewOrder(env,input));
    if(path==='/api/schwab/submit')return json(await connections.submitOrder(env,input));
    if(path==='/api/schwab/cancel')return json(await connections.cancelOrder(env,input));
    if(path==='/api/assets'){await addAsset(env.DB,input);return json({ok:true},201);}
    if(path==='/api/import'){await importBars(env.DB,input.assetId,parseCSV(input.csv),input.revision);return json({ok:true});}
    if(path==='/api/refresh')return json(await refresh(env.DB,env,input.assetId??null));
    if(path==='/api/backtest')return json(await runBacktest(env.DB,input.assetId,input.config),201);
    if(path==='/api/paper')return json({id:await startPaper(env.DB,input.assetId,input.config)},201);
    if(path==='/api/paper/stop'){const r=await env.DB.prepare("UPDATE paper_sessions SET status='stopped',revision=revision+1 WHERE id=? AND status='running'").bind(String(input.id)).run();if(r.meta.changes!==1)throw new Problem(409,'策略已停止或不存在。');await log(env.DB,'paper_stopped',{id:input.id});return json({ok:true});}
    if(path==='/api/paper/stop-all'){await env.DB.prepare("UPDATE paper_sessions SET status='stopped',revision=revision+1 WHERE status='running'").run();await log(env.DB,'stop_all',{execution:'paper'});return json({ok:true});}
    if(path==='/api/analyze'){const a=await assetById(env.DB,input.assetId),bars=JSON.parse(a.data);if(bars.length<35)throw new Problem(400,'请先同步至少 35 根日线。');const asOf=bars.at(-1).time;if(Date.now()-asOf>(a.market==='crypto'?3:7)*86400000)throw new Problem(409,'数据过旧，请先刷新。');const recent=await env.DB.prepare('SELECT created FROM analyses WHERE asset_id=? ORDER BY created DESC LIMIT 1').bind(a.id).first();if(recent&&Date.now()-Date.parse(recent.created)<60000)throw new Problem(429,'请等待一分钟后再次分析。');const data=await analyze(a,{asOf,indicators:indicators(bars,a.market)},env);const id=crypto.randomUUID();await env.DB.prepare('INSERT INTO analyses(id,asset_id,created,data) VALUES (?,?,?,?)').bind(id,a.id,new Date().toISOString(),JSON.stringify({...data,asOf})).run();await log(env.DB,'analysis',{id,symbol:a.symbol,execution:'research_only'});return json(data);}
    if(path==='/api/okx/check')return json(await okxAccount(env));
    if(path==='/api/orders')return executeLiveOrder();
    throw new Problem(404,'接口不存在。');
  }catch(error){const status=error instanceof Problem?error.status:500;if(status===500)console.error('Trading service failure',path,error?.message);const message=error instanceof Problem?error.message:'服务暂时不可用，请稍后重试。';if(path==='/')return html(login(message),status);return json({error:message},status);}
}
