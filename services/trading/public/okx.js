(()=>{
const view=document.querySelector('#view');if(!view)return;
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(path,data){
  const response=await fetch('/api'+path,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{'Content-Type':'application/json','X-Trading-Request':'1'},body:data===undefined?undefined:JSON.stringify(data)});
  const result=await response.json();if(!response.ok)throw Error(result.error||'请求失败');return result;
}
const labels={prepared:'待提交',sending:'发送中',unknown:'结果待确认',live:'已受理 / 等待成交',partially_filled:'部分成交',filled:'已成交',canceled:'已撤销',mmp_canceled:'已撤销',rejected:'被拒绝',cancel_sending:'撤单发送中',cancel_pending:'撤单待确认',cancel_unknown:'撤单结果待确认'};
const fields=['API_KEY','SECRET_KEY','PASSPHRASE'];
function mount(){
  if(!view.querySelector('.connection-grid')||view.querySelector('#okx-panel'))return;
  const panel=document.createElement('section');panel.id='okx-panel';panel.className='panel lower';
  panel.innerHTML=`<div class="section-head"><div><span class="mini-title">OKX / SPOT EXECUTION</span><h2>OKX 账户与现货交易</h2></div><span class="tag">模拟盘 / 实盘分开配置</span></div>
  <p class="quiet">支持 USDT 现货限价委托，单笔最多1000 USDT。模拟盘使用专用模拟 API Key。密钥加密保存在服务器，留空保留原值。</p>
  <form id="okx-config" class="form-grid"><label class="full">账号所属区域<select name="OKX_REGION"><option value="global">全球站</option><option value="us">美国站</option><option value="eea">欧洲站</option></select></label>
  ${['DEMO','LIVE'].map(mode=>`<details class="full"><summary>${mode==='DEMO'?'模拟盘':'实盘'}密钥</summary>${fields.map((field,i)=>`<label>${['API Key','Secret Key','Passphrase（创建 API 时设置）'][i]}<input type="password" name="OKX_${mode}_${field}" autocomplete="off" maxlength="4096" placeholder="读取配置中…"></label>`).join('')}</details>`).join('')}
  <button class="button primary full">保存 OKX 配置</button></form>
  <p id="okx-message" class="notice" role="status">读取配置状态…</p>
  <div class="actions"><label>当前操作环境<select id="okx-mode"><option value="demo">模拟盘 · 虚拟资金</option><option value="live">实盘 · 真实资金</option></select></label><button type="button" class="button" id="okx-check">验证连接并读取余额</button></div>
  <pre id="okx-account" class="quiet" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre>
  <form id="okx-order" class="form-grid lower"><label class="full">USDT 现货交易对<input name="instId" value="BTC-USDT" maxlength="25" required pattern="[A-Z0-9]{2,20}-USDT"></label><label>方向<select name="side"><option value="buy">买入</option><option value="sell">卖出</option></select></label><label>限价 USDT<input name="px" inputmode="decimal" required placeholder="例如 60000.1"></label><label class="full">数量（基础币，例如 BTC）<input name="sz" inputmode="decimal" required placeholder="例如 0.001"></label><button class="button full">校验并生成订单预览</button></form>
  <pre id="okx-preview" class="quiet" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre><button type="button" class="button danger" id="okx-submit" disabled>确认提交对应环境订单</button>
  <p class="quiet">预览60秒有效，提交前再次验证账户、余额、精度与当前报价。每个环境账户同一时刻处理一笔未结束操作，完成或撤销后再提交新订单。结果待确认时先查询，系统不会重发下单请求。</p>
  <div class="actions"><button type="button" class="button" id="okx-refresh">读取数据库记录</button><button type="button" class="button" id="okx-exchange-orders">查询当前交易对的交易所订单</button></div>
  <div id="okx-history" class="lower"></div><pre id="okx-exchange-result" class="quiet" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre>
  <h3 class="lower">OKX 模拟盘策略</h3><p class="quiet">在「策略回测」配置周期和参数后，点击「启动 OKX 模拟盘策略」。后台每5分钟检查，单个策略预算取初始资金与1000 USDT的较小值，支持最多3个策略，同一标的仅运行1个。策略仅管理自身成交累计的数量，账本在委托结束后更新；部分成交以订单记录为准。超过两个周期未结束的模拟委托会申请撤单。</p>
  <p class="quiet">触及回撤阈值会暂停新委托，持仓需核对处理。停止策略仅停止新信号，已有委托需单独撤单。页面数据来自数据库；连接、预览及订单查询由你主动触发。</p><div id="okx-strategies"></div>`;
  view.prepend(panel);
  let ticket=null,epoch=0,busy=false;
  const message=text=>{if(panel.isConnected)panel.querySelector('#okx-message').textContent=text;};
  const mode=()=>panel.querySelector('#okx-mode').value;
  const invalidate=()=>{epoch++;ticket=null;panel.querySelector('#okx-submit').disabled=true;};
  const action=fn=>async event=>{
    event?.preventDefault();if(busy)return;busy=true;
    const button=event?.submitter??event?.currentTarget;if(button?.tagName==='BUTTON')button.disabled=true;
    try{await fn(event);}catch(error){message(error.message);}finally{busy=false;if(button?.tagName==='BUTTON'&&button.id!=='okx-submit')button.disabled=false;}
  };
  function showSettings(settings){
    panel.querySelector('[name="OKX_REGION"]').value=settings.okxRegion||'global';
    for(const env of ['DEMO','LIVE'])for(const field of fields){const name='OKX_'+env+'_'+field;panel.querySelector('[name="'+name+'"]').placeholder=settings.configured[name]?'已配置 · 留空保留':'尚未配置';}
    const complete=env=>fields.every(field=>settings.configured['OKX_'+env+'_'+field]);
    message(`模拟盘${complete('DEMO')?'密钥已齐备，待验证':'密钥待补齐'} · 实盘${complete('LIVE')?'密钥已齐备，待验证':'密钥待补齐'} · 实盘提交${settings.okxLiveEnabled?'已启用':'服务器开关关闭'}`);
  }
  function history(data){
    const list=panel.querySelector('#okx-history');
    list.innerHTML=data.operations.length?`<div class="table-wrap"><table><thead><tr><th>环境 / 交易对</th><th>委托</th><th>状态 / 成交</th><th>编号</th><th>操作</th></tr></thead><tbody>${data.operations.map(record=>`<tr><td>${record.mode==='demo'?'模拟盘':'实盘'}<br>${escape(record.payload?.instId)}</td><td>${record.kind==='cancel'?'撤单':record.payload?.side==='buy'?'买入':'卖出'}<br>${escape(record.payload?.sz)} @ ${escape(record.payload?.px)}</td><td>${escape(labels[record.status]||record.status)}<br>成交 ${escape(record.accFillSz??'0')} · 均价 ${escape(record.avgPx??'—')}</td><td style="overflow-wrap:anywhere"><small>${escape(record.id)}<br>${escape(record.ordId||record.payload?.clOrdId)}</small></td><td>${record.status!=='prepared'?`<button class="link" data-okx-reconcile="${escape(record.id)}">查询状态</button>`:''}${record.kind==='submit'&&['live','partially_filled','unknown'].includes(record.status)?`<button class="link" data-okx-cancel="${escape(record.id)}" data-mode="${record.mode}">撤单</button>`:''}</td></tr>`).join('')}</tbody></table></div>`:'<p class="quiet">尚无 OKX 操作记录。</p>';
    list.querySelectorAll('[data-okx-reconcile]').forEach(button=>button.onclick=action(async()=>{await api('/okx/reconcile',{id:button.dataset.okxReconcile});await records();message('交易所状态已核对。');}));
    list.querySelectorAll('[data-okx-cancel]').forEach(button=>button.onclick=action(async()=>{if(!confirm(`确认撤销${button.dataset.mode==='live'?'实盘真实资金':'模拟盘'}委托？撤单期间仍可能成交。`))return;const result=await api('/okx/cancel',{id:button.dataset.okxCancel,confirm:button.dataset.mode==='live'?'CANCEL_OKX_LIVE_ORDER':'CANCEL_OKX_DEMO_ORDER'});await records();message(result.note||result.status);}));
  }
  function strategies(data){
    const box=panel.querySelector('#okx-strategies');box.innerHTML=data.strategies.length?data.strategies.map(r=>`<div class="notice"><b>${escape(r.instId)} · ${r.config.timeframe==='15m'?'15分钟':'日线'} · ${escape(r.status)}</b><p>预算 ${escape(r.budget)} USDT · 策略现金 ${escape(r.cash)} · 累计持有 ${escape(r.owned)} ${escape(r.base)}</p><p>${escape(r.message)}</p>${['running','paused'].includes(r.status)?`<button class="button" data-okx-stop="${escape(r.id)}">停止新信号</button>`:''}</div>`).join(''):'<p class="quiet">尚未启动 OKX 模拟盘策略。</p>';
    box.querySelectorAll('[data-okx-stop]').forEach(button=>button.onclick=action(async()=>{const result=await api('/okx/strategy/stop',{id:button.dataset.okxStop});await records();message(result.note);}));
  }
  async function records(){const [orders,runners]=await Promise.all([api('/okx/activity'),api('/okx/strategies')]);if(!panel.isConnected)return;history(orders);strategies(runners);}
  panel.querySelector('#okx-mode').onchange=()=>{invalidate();panel.querySelector('#okx-account').textContent='';panel.querySelector('#okx-preview').textContent='';message(mode()==='live'?'当前选择实盘，订单将使用真实资金，提交需服务器开关与明确确认。':'当前选择模拟盘，使用模拟 API Key 和虚拟资金。');};
  panel.querySelector('#okx-order').addEventListener('input',invalidate);panel.querySelector('#okx-order').addEventListener('change',invalidate);
  panel.querySelector('#okx-config').onsubmit=action(async()=>{const values=Object.fromEntries([...new FormData(panel.querySelector('#okx-config'))].filter(([,value])=>value.trim()));const settings=await api('/settings',{values});invalidate();panel.querySelector('#okx-config').reset();showSettings(settings);window.dispatchEvent(new Event('trading:settings-invalidated'));message('OKX 配置已加密保存，请验证对应环境的账户连接。');});
  panel.querySelector('#okx-check').onclick=action(async()=>{const account=await api('/okx/check',{mode:mode()});panel.querySelector('#okx-account').textContent=JSON.stringify(account,null,2);message('已验证 '+(account.mode==='demo'?'模拟盘':'实盘')+'账户，余额读取成功。');});
  panel.querySelector('#okx-order').onsubmit=action(async()=>{invalidate();const ticketEpoch=epoch,selected=mode();const result=await api('/okx/preview',{mode:selected,...Object.fromEntries(new FormData(panel.querySelector('#okx-order')))});if(epoch!==ticketEpoch||mode()!==selected)return;ticket={...result,validUntil:Date.now()+result.expiresIn*1000};panel.querySelector('#okx-preview').textContent=JSON.stringify(result,null,2);panel.querySelector('#okx-submit').disabled=selected==='live'&&!result.liveEnabled;message(selected==='live'&&!result.liveEnabled?'实盘预览完成，服务器实盘提交开关尚未启用。':'预览完成，请核对环境、交易对、价格与数量。');await records();});
  panel.querySelector('#okx-submit').onclick=action(async()=>{const selected=ticket;if(!selected||Date.now()>=selected.validUntil)throw Error('请重新生成订单预览。');if(!confirm(`确认向 OKX ${selected.mode==='live'?'实盘（真实资金）':'模拟盘'}提交 ${selected.payload.side} ${selected.payload.sz} ${selected.payload.instId}，限价 ${selected.payload.px} USDT？`))return;invalidate();try{const result=await api('/okx/submit',{id:selected.id,confirm:selected.mode==='live'?'SUBMIT_OKX_LIVE_ORDER':'SUBMIT_OKX_DEMO_ORDER'});panel.querySelector('#okx-preview').textContent=JSON.stringify(result,null,2);message(result.note);}finally{await records();}});
  panel.querySelector('#okx-refresh').onclick=action(records);
  panel.querySelector('#okx-exchange-orders').onclick=action(async()=>{const result=await api('/okx/orders',{mode:mode(),instId:panel.querySelector('#okx-order [name="instId"]').value});panel.querySelector('#okx-exchange-result').textContent=JSON.stringify(result,null,2);});
  Promise.all([api('/okx/status').then(showSettings),records()]).catch(error=>message(error.message));
}
view.addEventListener('click',event=>{if(event.target.closest('[data-okx-open]')){mount();view.querySelector('#okx-panel')?.scrollIntoView({behavior:'smooth',block:'start'});}});
new MutationObserver(mutations=>{if(mutations.some(m=>m.target===view))mount();}).observe(view,{childList:true});mount();
})();
