export class Problem extends Error { constructor(status,message){super(message);this.status=status;} }
export const finite = x => typeof x==='number' && Number.isFinite(x);
export function normalizeBars(input) {
  if(!Array.isArray(input)||input.length<2||input.length>3000)throw new Problem(400,'需要 2–3000 条日线数据。');
  const seen=new Set();const bars=input.map(row=>{
    const b={time:Number(row.time),open:Number(row.open),high:Number(row.high),low:Number(row.low),close:Number(row.close),volume:Number(row.volume)};
    if(!Object.values(b).every(finite)||b.time<0||b.time>Date.now()||!Number.isInteger(b.time)||Math.min(b.open,b.high,b.low,b.close)<=0||b.volume<0||b.high<Math.max(b.open,b.close,b.low)||b.low>Math.min(b.open,b.close,b.high)||seen.has(b.time))throw new Problem(400,'K 线包含重复时间、未来时间、非数值或不合法的 OHLCV。');
    seen.add(b.time);return b;
  }).sort((a,b)=>a.time-b.time);return bars;
}
export function parseCSV(csv) {
  if(typeof csv!=='string'||csv.length>1000000)throw new Problem(400,'CSV 最大为 1 MB。');
  const lines=csv.trim().replace(/^\uFEFF/,'').split(/\r?\n/);const keys=lines.shift().toLowerCase().split(',').map(x=>x.trim());
  if(!['date','open','high','low','close','volume'].every(k=>keys.includes(k)))throw new Problem(400,'CSV 表头需要 date,open,high,low,close,volume。');
  return normalizeBars(lines.filter(x=>x.trim()).map(line=>{const cols=line.split(',').map(x=>x.trim());const get=k=>cols[keys.indexOf(k)];const date=get('date');if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)throw new Problem(400,'日期必须使用 YYYY-MM-DD。');if(['open','high','low','close','volume'].some(k=>get(k)===''))throw new Problem(400,'CSV 不能包含空价格或成交量。');return {time:Date.parse(date),open:get('open'),high:get('high'),low:get('low'),close:get('close'),volume:get('volume')};}));
}
export function sma(a,n){let s=0;return a.map((v,i)=>{s+=v;if(i>=n)s-=a[i-n];return i>=n-1?s/n:null;});}
export function ema(a,n){let prev=null,sum=0;return a.map((v,i)=>{sum+=v;if(i<n-1)return null;prev=prev===null?sum/n:prev+(v-prev)*2/(n+1);return prev;});}
export function rsi(a,n=14){let gain=0,loss=0;return a.map((v,i)=>{if(!i)return null;const d=v-a[i-1];if(i<=n){gain+=Math.max(d,0)/n;loss+=Math.max(-d,0)/n;}else{gain=(gain*(n-1)+Math.max(d,0))/n;loss=(loss*(n-1)+Math.max(-d,0))/n;}return i<n?null:loss===0?(gain===0?50:100):100-100/(1+gain/loss);});}
export function indicators(bars,market='crypto') {
  const c=bars.map(b=>b.close),last=a=>a.at(-1)??null;const e12=ema(c,12),e26=ema(c,26),macd=c.map((_,i)=>e26[i]===null?null:e12[i]-e26[i]);const valid=macd.filter(x=>x!==null),signal=last(ema(valid,9));
  const mid=last(sma(c,20));const std=c.length<20?null:Math.sqrt(c.slice(-20).reduce((s,v)=>s+(v-mid)**2,0)/20);
  const tr=bars.map((b,i)=>i?Math.max(b.high-b.low,Math.abs(b.high-bars[i-1].close),Math.abs(b.low-bars[i-1].close)):b.high-b.low);let atr=null;for(let i=0;i<tr.length;i++){if(i===13)atr=tr.slice(0,14).reduce((a,b)=>a+b)/14;else if(i>13)atr=(atr*13+tr[i])/14;}
  const ret=c.slice(-21).slice(1).map((v,i)=>Math.log(v/c.slice(-21)[i]));const avg=ret.reduce((a,b)=>a+b,0)/ret.length;const volatility=ret.length===20?Math.sqrt(ret.reduce((s,v)=>s+(v-avg)**2,0)/19)*Math.sqrt(market==='crypto'?365:252):null;
  return {close:last(c),sma20:mid,ema20:last(ema(c,20)),rsi14:last(rsi(c)),macd:last(macd),macdSignal:signal,macdHistogram:signal===null?null:last(macd)-signal,bollingerUpper:std===null?null:mid+2*std,bollingerLower:std===null?null:mid-2*std,atr14:atr,volatility20:volatility,volume:last(bars)?.volume??null};
}
export const ruleFields=['close','open','high','low','volume','sma_fast','sma_slow','ema_fast','ema_slow','rsi14','volume_sma','prior_high','prior_low'];
export function validateRules(input){
  let rules=input;if(typeof rules==='string'){try{rules=JSON.parse(rules);}catch{throw new Problem(400,'策略规则必须是有效 JSON。');}}
  const validOperand=x=>typeof x==='number'?finite(x)&&Math.abs(x)<=1e12:ruleFields.includes(x);
  const result={};for(const name of ['entry','exit']){
    const group=rules?.[name];if(!group||!['all','any'].includes(group.match)||!Array.isArray(group.conditions)||group.conditions.length<1||group.conditions.length>8)throw new Problem(400,'入场和离场各需1–8条规则，match 为 all 或 any。');
    result[name]={match:group.match,conditions:group.conditions.map(c=>{
      if(!c||!validOperand(c.left)||!validOperand(c.right)||!['gt','lt','gte','lte','crossAbove','crossBelow'].includes(c.op))throw new Problem(400,'规则含不支持的指标、比较符或阈值。');
      return {left:c.left,op:c.op,right:c.right};
    })};
  }return result;
}
export function config(input={}) {
  const p={strategy:input.strategy??'ma',fast:Number(input.fast??10),slow:Number(input.slow??30),initial:Number(input.initial??10000),allocation:Number(input.allocation??0.25),feeBps:Number(input.feeBps??10),slippageBps:Number(input.slippageBps??5),maxDrawdown:Number(input.maxDrawdown??0.2)};
    if(!['ma','rsi','breakout','custom'].includes(p.strategy)||!Number.isInteger(p.fast)||!Number.isInteger(p.slow)||p.fast<2||p.slow<=p.fast||p.slow>200||![p.initial,p.allocation,p.feeBps,p.slippageBps,p.maxDrawdown].every(finite)||p.initial<100||p.initial>1e9||p.allocation<=0||p.allocation>1||p.feeBps<0||p.feeBps>100||p.slippageBps<0||p.slippageBps>200||p.maxDrawdown<=0||p.maxDrawdown>0.9)throw new Problem(400,'策略参数不合法：短周期应小于长周期；仓位 0–100%，回撤阈值 0–90%。');if(p.strategy==='custom')p.rules=validateRules(input.rules);return p;
}
export function targets(bars,p) {
  const close=bars.map(b=>b.close),fast=sma(close,p.fast),slow=sma(close,p.slow),rs=rsi(close);let held=false;
    if(p.strategy==='custom'){
      const rules=validateRules(p.rules),fields={sma_fast:fast,sma_slow:slow,ema_fast:ema(close,p.fast),ema_slow:ema(close,p.slow),rsi14:rs,volume_sma:sma(bars.map(b=>b.volume),p.slow),prior_high:bars.map((_,i)=>i>=p.slow?Math.max(...bars.slice(i-p.slow,i).map(b=>b.high)):null),prior_low:bars.map((_,i)=>i>=p.fast?Math.min(...bars.slice(i-p.fast,i).map(b=>b.low)):null)};
      for(const field of ['close','open','high','low','volume'])fields[field]=bars.map(b=>b[field]);
      const value=(operand,i)=>typeof operand==='number'?operand:fields[operand]?.[i];
      const condition=(c,i)=>{const a=value(c.left,i),b=value(c.right,i);if(!finite(a)||!finite(b))return false;
        if(c.op==='gt')return a>b;if(c.op==='lt')return a<b;if(c.op==='gte')return a>=b;if(c.op==='lte')return a<=b;
        const prevA=value(c.left,i-1),prevB=value(c.right,i-1);return finite(prevA)&&finite(prevB)&&(c.op==='crossAbove'?prevA<=prevB&&a>b:prevA>=prevB&&a<b);
      };
      const matches=(group,i)=>group.match==='all'?group.conditions.every(c=>condition(c,i)):group.conditions.some(c=>condition(c,i));
      return bars.map((_,i)=>{if(matches(rules.exit,i))held=false;else if(matches(rules.entry,i))held=true;return held;});
    }
  return bars.map((b,i)=>{if(p.strategy==='ma')return slow[i]===null?false:fast[i]>slow[i];if(p.strategy==='rsi'){if(rs[i]!==null&&rs[i]<30)held=true;if(rs[i]!==null&&rs[i]>70)held=false;return held;}if(i>=p.slow){const prior=bars.slice(i-p.slow,i);if(b.close>Math.max(...prior.map(b=>b.high)))held=true;else if(b.close<Math.min(...bars.slice(i-p.fast,i).map(b=>b.low)))held=false;}return held;});
}
export const startPortfolio=p=>({cash:p.initial,units:0,cost:0,peak:p.initial,halted:false,fees:0,trades:[],curve:[],lastTime:0});
export function step(state,bar,want,p,copy=true) {
  const s=copy?structuredClone(state):state;if(bar.time<=s.lastTime)return s;
  const fee=p.feeBps/10000,slip=p.slippageBps/10000;const mark=s.cash+s.units*bar.open;s.peak=Math.max(s.peak,mark);
  if(1-mark/s.peak>=p.maxDrawdown)s.halted=true;
  if(s.halted)want=false;
  if(want&&!s.units){const budget=s.cash*p.allocation,price=bar.open*(1+slip),units=budget/(price*(1+fee)),fees=units*price*fee;s.cash-=budget;s.units=units;s.cost=budget;s.fees+=fees;s.trades.push({time:bar.time,side:'buy',price,units,fee:fees,pnl:null});}
  else if(!want&&s.units){const price=bar.open*(1-slip),gross=s.units*price,fees=gross*fee,pnl=gross-fees-s.cost;s.cash+=gross-fees;s.fees+=fees;s.trades.push({time:bar.time,side:'sell',price,units:s.units,fee:fees,pnl});s.units=0;s.cost=0;}
  const equity=s.cash+s.units*bar.close;s.peak=Math.max(s.peak,equity);if(1-equity/s.peak>=p.maxDrawdown)s.halted=true;
  s.curve.push({time:bar.time,equity});s.lastTime=bar.time;return s;
}
export function backtest(input,options={},market='crypto',evaluationStart=null) {
    const bars=normalizeBars(input),p=config(options),startIndex=evaluationStart===null?0:bars.findIndex(b=>b.time>=evaluationStart),warmup=Math.max(p.slow,35,startIndex<0?bars.length:startIndex);
  if(bars.length<warmup+5)throw new Problem(400,`至少需要 ${warmup+5} 根日线，请增加数据或缩短长周期。`);
  const signals=targets(bars,p);let state=startPortfolio(p);const curve=[{time:bars[warmup].time-1,equity:p.initial}];
  for(let i=warmup;i<bars.length;i++)state=step(state,bars[i],signals[i-1],p,false);
  state.curve=curve.concat(state.curve);const eq=state.curve.map(x=>x.equity);let peak=p.initial,maxDD=0;for(const v of eq){peak=Math.max(peak,v);maxDD=Math.max(maxDD,1-v/peak);}
  const returns=eq.slice(1).map((v,i)=>v/eq[i]-1),mean=returns.reduce((a,b)=>a+b,0)/returns.length,sd=Math.sqrt(returns.reduce((s,v)=>s+(v-mean)**2,0)/Math.max(1,returns.length-1)),closed=state.trades.filter(x=>x.side==='sell');
  const benchmarkStart=bars[warmup].open*(1+p.slippageBps/10000)*(1+p.feeBps/10000);const benchmark=state.curve.map((x,i)=>({time:x.time,equity:i?p.initial*bars[warmup+i-1].close/benchmarkStart:p.initial}));
  return {config:p,market,start:bars[warmup].time,end:bars.at(-1).time,bars:bars.length,metrics:{totalReturn:eq.at(-1)/p.initial-1,benchmarkReturn:benchmark.at(-1).equity/p.initial-1,maxDrawdown:maxDD,sharpe:sd>0?mean/sd*Math.sqrt(market==='crypto'?365:252):null,winRate:closed.length?closed.filter(x=>x.pnl>0).length/closed.length:null,closedTrades:closed.length,orders:state.trades.length,fees:state.fees,finalEquity:eq.at(-1),openUnits:state.units,halted:state.halted},curve:state.curve,benchmark,trades:state.trades,assumptions:'仅日线、多头、无杠杆；前一日收盘信号，次日开盘按滑点和手续费模拟成交；不计股息、税费和停牌流动性；期末持仓按收盘估值。'};
}
