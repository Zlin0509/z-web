import {Problem,config,backtest,indicators,ruleFields} from './engine.mjs';
import {assetById,log} from './service.mjs';
import {remote} from './connections.mjs';

export async function listStrategies(env){const rows=(await env.DB.prepare("SELECT value FROM service_state WHERE key LIKE 'strategy:%' ORDER BY json_extract(value,'$.created') DESC LIMIT 50").all()).results;return {strategies:rows.map(r=>JSON.parse(r.value))};}
export async function saveStrategy(env,input){
  const asset=await assetById(env.DB,input.assetId),name=String(input.name||'').trim();
  if(!name||name.length>80)throw new Problem(400,'策略名称需要1–80个字符。');
  const p=config(input.config),parentId=input.parentId||null;
  if(parentId){const parent=await env.DB.prepare('SELECT value FROM service_state WHERE key=?').bind('strategy:'+parentId).first();if(!parent||JSON.parse(parent.value).assetId!==asset.id)throw new Problem(400,'父策略版本不存在或属于其他标的。');}
  const version={id:crypto.randomUUID(),name,assetId:asset.id,created:new Date().toISOString(),config:p,parentId};
  await env.DB.prepare('INSERT INTO service_state(key,value) VALUES(?,?)').bind('strategy:'+version.id,JSON.stringify(version)).run();
  await log(env.DB,'strategy_saved',{id:version.id,name,parentId});return version;
}
export function compareStrategies(bars,baseline,candidate,market){
  const split=Math.floor(bars.length*.7),warmup=Math.max(baseline.slow,candidate.slow,35);
  if(split<warmup+10||bars.length-split<20)throw new Problem(400,'样本不足以比较训练和验证区间，请增加日线或缩短周期。');
  const training=bars.slice(0,split);
  const metrics=(sample,p,start)=>backtest(sample,p,market,start).metrics;
  return {training:{start:bars[warmup].time,end:training.at(-1).time,bars:split-warmup,baseline:metrics(training,baseline,bars[warmup].time),candidate:metrics(training,candidate,bars[warmup].time)},validation:{start:bars[split].time,end:bars.at(-1).time,bars:bars.length-split,baseline:metrics(bars,baseline,bars[split].time),candidate:metrics(bars,candidate,bars[split].time)}};
}
export async function proposeStrategy(env,input,fetcher=fetch){
  if(!env.DEEPSEEK_API_KEY||!env.DEEPSEEK_MODEL)throw new Problem(424,'请先在服务接入保存 DeepSeek Key 并选择模型。');
  const prompt=String(input.prompt||'').trim();if(prompt.length<5||prompt.length>2000)throw new Problem(400,'请用5–2000字描述策略目标、偏好和限制。');
  if(!['generate','optimize'].includes(input.mode))throw new Problem(400,'策略操作无效。');
  const asset=await assetById(env.DB,input.assetId),bars=JSON.parse(asset.data),baseline=config(input.config);
  if(bars.length<120)throw new Problem(400,'AI 策略对比至少需要120根日线，请先同步数据。');
  const split=Math.floor(bars.length*.7),training=bars.slice(0,split),baselineRun=backtest(training,baseline,asset.market);
  const lease=crypto.randomUUID();const lock=await env.DB.prepare("INSERT INTO service_state(key,value) VALUES('strategy_ai_lock',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(json_extract(service_state.value,'$.until') AS INTEGER)<?").bind(JSON.stringify({lease,until:Date.now()+100000}),Date.now()).run();
  if(lock.meta.changes!==1)throw new Problem(429,'策略生成正在进行或刚完成，请稍后重试。');
  try{
    const example={name:'趋势与动量规则',rationale:'说明规则、改动与适用条件',risks:['列出风险和局限'],config:{...baseline,strategy:'custom',rules:{entry:{match:'all',conditions:[{left:'sma_fast',op:'gt',right:'sma_slow'},{left:'rsi14',op:'lt',right:70}]},exit:{match:'any',conditions:[{left:'sma_fast',op:'lt',right:'sma_slow'},{left:'rsi14',op:'gt',right:80}]}}}};
    const system=`你是量化策略研究助手。根据用户目标和训练区间生成可执行的日线、多头、无杠杆规则策略，仅返回JSON。不得承诺收益或声称已测试。不得输出程序代码。结构示例：${JSON.stringify(example)}。config.strategy必须为custom。规则操作数仅可使用有限数字或${ruleFields.join(',')}。比较符仅gt,lt,gte,lte,crossAbove,crossBelow。entry/exit各1–8条，match为all或any；离场优先。fast为2–199整数，slow为fast+1至${Math.min(200,split-15)}整数。fast/slow决定均线周期；rsi14固定14期；prior_high为此前slow根最高价，prior_low为此前fast根最低价；volume_sma为slow期成交量均线。每个信号只看当天及过去数据，下一日开盘成交。初始资金、手续费、滑点、仓位上限和回撤停机值由用户设定，不得提高。你只看到训练区间，不可假设验证表现。优化时说明相对当前规则改了什么。`;
    const context={mode:input.mode,goal:prompt,symbol:asset.symbol,market:asset.market,source:asset.source,trainingEnd:training.at(-1).time,trainingBars:training.length,baseline,trainingMetrics:baselineRun.metrics,indicators:indicators(training,asset.market),recentTrainingBars:training.slice(-40)};
    const response=await remote('https://api.deepseek.com/chat/completions',{method:'POST',signal:AbortSignal.timeout(90000),headers:{'Content-Type':'application/json',Authorization:'Bearer '+env.DEEPSEEK_API_KEY},body:JSON.stringify({model:env.DEEPSEEK_MODEL,messages:[{role:'system',content:system},{role:'user',content:JSON.stringify(context)}],response_format:{type:'json_object'},max_tokens:8192,stream:false})},fetcher);
    const data=await response.json();if(data.choices?.[0]?.finish_reason==='length')throw new Problem(502,'模型输出达到长度限制，策略未应用；请简化目标后重试。');let proposal;try{proposal=JSON.parse(data.choices?.[0]?.message?.content);}catch{throw new Problem(502,'模型未返回有效策略 JSON，请重试或调整目标。');}
    if(typeof proposal.name!=='string'||!proposal.name.trim()||proposal.name.length>80||typeof proposal.rationale!=='string'||proposal.rationale.length>5000||!Array.isArray(proposal.risks)||proposal.risks.length>10||proposal.risks.some(x=>typeof x!=='string'||x.length>1000)||proposal.config?.strategy!=='custom')throw new Problem(502,'模型策略结构不符合要求，未应用任何更改。');
    const candidate=config({...proposal.config,initial:baseline.initial,feeBps:baseline.feeBps,slippageBps:baseline.slippageBps,allocation:Math.min(Number(proposal.config.allocation??baseline.allocation),baseline.allocation),maxDrawdown:Math.min(Number(proposal.config.maxDrawdown??baseline.maxDrawdown),baseline.maxDrawdown)});
    const result={id:crypto.randomUUID(),assetId:asset.id,created:new Date().toISOString(),model:env.DEEPSEEK_MODEL,mode:input.mode,name:proposal.name,rationale:proposal.rationale,risks:proposal.risks,config:candidate,baseline,comparison:compareStrategies(bars,baseline,candidate,asset.market),source:{provider:asset.source,symbol:asset.symbol,updated:asset.updated},execution:'research_only'};
    await env.DB.prepare('INSERT INTO service_state(key,value) VALUES(?,?)').bind('strategy_experiment:'+result.id,JSON.stringify(result)).run();
    await log(env.DB,'strategy_proposed',{id:result.id,name:result.name,model:result.model,mode:result.mode});return result;
  }finally{await env.DB.prepare("UPDATE service_state SET value=? WHERE key='strategy_ai_lock' AND json_extract(value,'$.lease')=?").bind(JSON.stringify({lease,until:Date.now()+15000}),lease).run();}
}
