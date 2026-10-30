(()=>{
const form=document.querySelector('#asset-form');if(!form)return;
const input=document.querySelector('#stock-search'),results=document.querySelector('#stock-search-results'),status=document.querySelector('#stock-search-status'),more=document.querySelector('#stock-search-more'),submit=document.querySelector('#add-asset-submit'),selection=document.querySelector('#asset-selection');
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let timer,epoch=0,controller,next=null,shown=0;
async function search(offset=0){
  const version=epoch,q=input.value.trim();if(form.elements.market.value!=='us')return;
  controller?.abort();controller=new AbortController();more.disabled=true;status.textContent='正在搜索数据库目录…';
  try{const response=await fetch('/api/stocks/search?q='+encodeURIComponent(q)+'&offset='+offset,{signal:controller.signal}),data=await response.json();if(version!==epoch)return;if(!response.ok)throw Error(data.error||'搜索失败');
    if(offset===0){results.innerHTML='';shown=0;}shown+=data.items.length;next=data.nextOffset;more.hidden=next===null;
    const list=document.createElement('ul');list.innerHTML=data.items.map(a=>`<li><button type="button" class="stock-result" data-symbol="${escape(a.symbol)}" ${a.added?'disabled':''}><span><b>${escape(a.symbol)}</b><small>${escape(a.exchange)}${a.added?' · 已添加':''}</small></span><span class="stock-company">${escape(a.name)}</span></button></li>`).join('');
    list.querySelectorAll('button').forEach((button,i)=>button.onclick=()=>{form.elements.symbol.value=data.items[i].symbol;selection.textContent=data.items[i].symbol+' · '+data.items[i].name;submit.disabled=false;results.querySelectorAll('button').forEach(b=>b.classList.remove('chosen'));button.classList.add('chosen');});results.append(list);
    status.textContent=data.total?`共 ${data.total} 个匹配，已展示 ${shown} 个 · ${data.source}${Date.now()-Date.parse(data.updated)>86400000?' · 目录待更新':''}`:'没有匹配结果，请尝试其他代码或英文公司名。';
  }catch(e){if(version===epoch&&e.name!=='AbortError'){status.textContent=e.message;more.hidden=true;}}finally{if(version===epoch)more.disabled=false;}
}
function reset(){clearTimeout(timer);epoch++;controller?.abort();next=null;shown=0;input.value='';results.innerHTML='';more.hidden=true;form.elements.symbol.value='';selection.textContent='尚未选择股票。';const stocks=form.elements.market.value==='us';document.querySelector('#stock-search-fields').hidden=!stocks;form.elements.symbol.readOnly=stocks;form.elements.symbol.placeholder=stocks?'从搜索结果选择':'BTC-USDT';submit.disabled=stocks;selection.textContent=stocks?'尚未选择股票。':'输入 USDT 现货交易对，如 BTC-USDT。';if(stocks){void search();input.focus();}}
input.addEventListener('input',()=>{clearTimeout(timer);epoch++;controller?.abort();form.elements.symbol.value='';selection.textContent='请从匹配结果选择股票。';submit.disabled=true;results.innerHTML='';more.hidden=true;status.textContent='准备搜索…';timer=setTimeout(()=>search(),250);});
more.onclick=()=>{if(next!==null)void search(next);};form.elements.market.addEventListener('change',reset);window.addEventListener('trading:add-open',reset);
document.querySelector('#asset-dialog').addEventListener('close',()=>{epoch++;clearTimeout(timer);controller?.abort();});
})();
