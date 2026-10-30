(()=>{
const view=document.querySelector('#view');if(!view)return;let active=false,quoteBusy=false,quoteSnapshot=null;
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function call(path,data){const r=await fetch('/api'+path,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{'Content-Type':'application/json','X-Trading-Request':'1'},body:data===undefined?undefined:JSON.stringify(data)});const j=await r.json();if(!r.ok)throw Error(j.error||'请求失败');return j;}
// Only non-sensitive presence flags and model IDs are kept in page memory.
let settingsCache=null,settingsPending=null,settingsEpoch=0,modelsCache=null,modelsPending=null,modelsEpoch=0;
function rememberSettings(value){settingsCache={value,at:Date.now()};window.dispatchEvent(new CustomEvent('trading:settings',{detail:value}));return value;}
function getSettings(){
  if(settingsCache&&Date.now()-settingsCache.at<60000)return Promise.resolve(settingsCache.value);
  if(settingsPending)return settingsPending;
  const epoch=settingsEpoch;
  const pending=call('/settings').then(s=>epoch===settingsEpoch?rememberSettings(s):settingsCache?.value||s).finally(()=>{if(settingsPending===pending)settingsPending=null;});
  settingsPending=pending;return pending;
}
function getModels(force=false){
  if(!force&&modelsCache&&Date.now()-modelsCache.at<300000)return Promise.resolve(modelsCache.value);
  if(modelsPending)return modelsPending;
  const epoch=modelsEpoch;
  const pending=call('/deepseek/models').then(r=>{if(epoch===modelsEpoch)modelsCache={value:r,at:Date.now()};return r;}).finally(()=>{if(modelsPending===pending)modelsPending=null;});
  modelsPending=pending;return pending;
}
function message(s){const n=document.querySelector('#connection-message');if(n)n.textContent=s;}
const fields=[['DEEPSEEK_API_KEY','DeepSeek API Key'],['DEEPSEEK_MODEL','DeepSeek 可用模型'],['ALPACA_API_KEY','Alpaca Key ID'],['ALPACA_SECRET_KEY','Alpaca Secret Key'],['SCHWAB_APP_KEY','Schwab App Key'],['SCHWAB_APP_SECRET','Schwab App Secret'],['ALPHA_VANTAGE_API_KEY','Alpha Vantage Key（可选：历史日线）']];
async function mount(){if(view.querySelector('.connection-grid')&&!document.querySelector('#connection-settings')){const box=document.createElement('section');box.id='connection-settings';box.className='panel lower';box.innerHTML=`<h2>密钥配置与 Schwab 账户</h2><p class="quiet">密钥加密保存在服务端，仅显示是否已配置；留空保留原值。实时行情与回测日线分别计算。</p><form id="connection-form" class="form-grid">${fields.map(([key,label])=>`<label>${label}${key==='DEEPSEEK_MODEL'?'<select name="DEEPSEEK_MODEL" disabled><option value="">读取配置中…</option></select>':`<input name="${key}" type="password" autocomplete="off" maxlength="4096" placeholder="读取配置中…">`}</label>`).join('')}<button class="button primary full">保存配置</button></form><p id="model-message" class="quiet" role="status">模型列表由 DeepSeek 返回，请自行选择后保存。</p><button type="button" id="refresh-models" class="button">重新获取模型列表</button><p id="connection-message" role="status" class="notice">正在读取配置状态…</p><p class="quiet">Schwab 回调地址：<code>${escape(location.origin)}/schwab/callback</code><br>申请 Accounts and Trading Production，并在应用设置中填写此地址。Market Data 可按需另行申请。</p><div class="actions"><button class="button" id="schwab-connect">授权连接 Schwab</button><button class="button" id="schwab-accounts">读取持仓与账户</button></div><pre id="account-result" class="quiet" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre><h3 class="lower">美股订单接口</h3><p class="quiet">仅普通时段 DAY 整股限价单，单笔上限 1000 USD。当前默认关闭真实提交；完成账户联调后才启用。订单超时不自动重发。</p><form id="schwab-order" class="form-grid"><label class="full">已授权账户<select name="account" required><option value="">先读取账户</option></select></label><label>股票代码<input name="symbol" required placeholder="AAPL"></label><label>方向<select name="side"><option>BUY</option><option>SELL</option></select></label><label>股数<input name="quantity" type="number" min="1" step="1" required></label><label>限价 USD<input name="price" type="number" min="0.01" step="0.01" required></label><button class="button full">生成订单预览</button></form><pre id="order-preview" class="quiet" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre><div class="actions"><button id="submit-live" class="button danger" disabled>确认提交真实订单</button><button id="query-orders" class="button">查询最近 7 天订单</button></div><pre id="orders-result" class="quiet" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre><form id="cancel-order" class="form-grid lower"><label>要撤销的真实订单编号<input name="orderId" inputmode="numeric" pattern="[0-9]+" required></label><button class="button danger">确认申请撤单</button></form><p class="quiet">免费美股报价来源为 Alpaca IEX，非全市场综合报价。需在 Alpaca 创建账户并生成数据访问密钥。OKX 公开报价无需交易密钥。</p>`;view.prepend(box);
let ticket=null,modelRequest=0;
const guarded=fn=>async ev=>{ev?.preventDefault();if(active)return;active=true;try{await fn();}catch(e){message(e.message);}finally{active=false;}};
async function models(selected='',force=false){
  const request=++modelRequest;
  const select=box.querySelector('[name="DEEPSEEK_MODEL"]'),hint=box.querySelector('#model-message');
  select.disabled=true;select.innerHTML='<option value="">正在获取模型列表…</option>';
  try{const r=await getModels(force);if(request!==modelRequest||!box.isConnected)return;select.innerHTML='<option value="">请选择模型（不自动选择）</option>'+r.models.map(m=>`<option value="${escape(m.id)}">${escape(m.name===m.id?m.id:m.name+' · '+m.id)}</option>`).join('');
    if(r.models.some(m=>m.id===selected))select.value=selected;
    select.disabled=!r.models.length;hint.textContent=r.models.length?(selected&&!select.value?'之前保存的模型不在当前列表中，请重新选择并保存。':'已从 DeepSeek 获取可用模型；选择后点击保存配置。'):'该账号未返回可用模型。';
  }catch(e){if(request!==modelRequest||!box.isConnected)return;select.innerHTML='<option value="">列表获取失败</option>';hint.textContent='模型列表获取失败：'+e.message;}
}
function applyStatus(s){
  if(!box.isConnected)return;
  fields.forEach(([key])=>{if(key!=='DEEPSEEK_MODEL')box.querySelector(`[name="${key}"]`).placeholder=s.configured[key]?'已配置 · 留空保留':'尚未配置';});
  box.querySelector('#connection-message').textContent=`Schwab ${s.schwabConnected?'已授权':'尚未授权'} · 实盘提交${s.liveTrading?'已启用':'关闭'}`;
  if(s.configured.DEEPSEEK_API_KEY)void models(s.model);
  else {box.querySelector('[name="DEEPSEEK_MODEL"]').innerHTML='<option value="">先保存 API Key</option>';box.querySelector('#model-message').textContent='保存 DeepSeek API Key 后自动获取可用模型。';}
}
async function status(){applyStatus(await getSettings());}
box.querySelector('#refresh-models').onclick=async()=>{
  const button=box.querySelector('#refresh-models');button.disabled=true;
  try{await models(box.querySelector('[name="DEEPSEEK_MODEL"]').value||settingsCache?.value.model||'',true);}finally{button.disabled=false;}
};
box.querySelector('#connection-form').onsubmit=guarded(async()=>{
  const values=Object.fromEntries([...new FormData(box.querySelector('#connection-form'))].filter(([,v])=>v.trim()));
  const result=await call('/settings',{values});settingsEpoch++;settingsPending=null;
  if(values.DEEPSEEK_API_KEY){modelsEpoch++;modelsCache=null;modelsPending=null;modelRequest++;}
  rememberSettings(result);box.querySelector('#connection-form').reset();applyStatus(result);
  box.querySelector('#connection-message').textContent='配置已加密保存，状态已更新；模型列表独立加载。';
});
box.querySelector('#schwab-connect').onclick=guarded(async()=>{const r=await call('/schwab/connect',{});location.assign(r.url);});
box.querySelector('#schwab-accounts').onclick=guarded(async()=>{const r=await call('/schwab/accounts');box.querySelector('#account-result').textContent=JSON.stringify(r.accounts,null,2);box.querySelector('[name="account"]').innerHTML=r.numbers.map(a=>`<option value="${escape(a.hashValue)}">账户尾号 ${escape(a.accountNumber.slice(-4))}</option>`).join('');message('账户与持仓已读取。');});
box.querySelector('#schwab-order').onsubmit=guarded(async()=>{ticket=await call('/schwab/preview',Object.fromEntries(new FormData(box.querySelector('#schwab-order'))));box.querySelector('#order-preview').textContent=JSON.stringify(ticket,null,2);box.querySelector('#submit-live').disabled=!ticket.liveEnabled;});
box.querySelector('#submit-live').onclick=guarded(async()=>{box.querySelector('#submit-live').disabled=true;const r=await call('/schwab/submit',{id:ticket.id,confirm:'SUBMIT_LIVE_ORDER'});box.querySelector('#order-preview').textContent=JSON.stringify(r,null,2);ticket=null;});
box.querySelector('#query-orders').onclick=guarded(async()=>{const r=await call('/schwab/orders',{account:box.querySelector('[name="account"]').value});box.querySelector('#orders-result').textContent=JSON.stringify(r,null,2);});
box.querySelector('#cancel-order').onsubmit=guarded(async()=>{const r=await call('/schwab/cancel',{account:box.querySelector('[name="account"]').value,orderId:box.querySelector('[name="orderId"]').value,confirm:'CANCEL_LIVE_ORDER'});message(JSON.stringify(r));});
status().catch(e=>message(e.message));
}
if(view.querySelector('.watchlist')&&!document.querySelector('#live-quotes')){const box=document.createElement('section');box.id='live-quotes';box.className='panel lower';box.innerHTML='<div class="section-head"><h2>数据库报价快照</h2><span class="tag">数据库快照</span></div><p class="quiet">正在获取…</p>';view.querySelector('.watchlist').after(box);updateQuotes();}}
async function updateQuotes(){const box=document.querySelector('#live-quotes');if(!box||document.hidden||quoteBusy)return;quoteBusy=true;try{const r=quoteSnapshot||(quoteSnapshot=await call('/quotes'));box.innerHTML=`<div class="section-head"><h2>数据库报价快照</h2><span class="tag">${escape(r.fetchedAt?'入库于 '+new Date(r.fetchedAt).toLocaleString('zh-CN'):'等待后台入库')}</span></div><div class="table-wrap"><table><thead><tr><th>标的</th><th>最新成交</th><th>买价</th><th>卖价</th><th>报价时间 / 状态</th><th>来源</th></tr></thead><tbody>${r.quotes.map(q=>{const age=q.time?Date.now()-Date.parse(q.time):Infinity;return `<tr data-symbol="${escape(q.symbol)}"><td>${escape(q.symbol)}</td><td>${escape(q.last??'—')}</td><td>${escape(q.bid??'—')}</td><td>${escape(q.ask??'—')}</td><td>${escape(q.error||(new Date(q.time).toLocaleString('zh-CN')+(age>60000?' · 旧报价/休市':' · 最新'))) }</td><td>${escape(q.source??'—')}</td></tr>`;}).join('')}</tbody></table></div><p class="quiet">美股使用免费 IEX 单一交易所报价；休市或无成交时可能保留旧报价。页面只读取数据库，不直连行情源；后台每5分钟采集报价，日线独立按需更新。</p>`;}catch(e){box.querySelector('.quiet').textContent=e.message;}finally{quoteBusy=false;if(document.querySelector('#live-quotes')&&document.querySelector('#live-quotes')!==box)void updateQuotes();}}
window.addEventListener('trading:database',()=>{quoteSnapshot=null;void updateQuotes();});
new MutationObserver(m=>{if(m.some(x=>x.target===view))mount();}).observe(view,{childList:true});mount();
})();
