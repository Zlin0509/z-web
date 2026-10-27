(() => {
  const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
  const groups={work:['Agent 工程','开发实践','思考随笔'],algorithms:['题目解析','算法专题','比赛复盘']};
  const fields={title:'title',description:'description',section:'section',category:'category',date:'date',slug:'slug',tags:'tags',source:'source',sourceLabel:'source-label',difficulty:'difficulty',body:'body',featured:'featured',sample:'sample'};
  let notes=[], current=null, dirty=false, busy=false, status='active', previewSequence=0, previewTimer;
  const form=$('#note-form');
  function notify(message,error=false){const alert=$('#admin-alert');alert.textContent=message;alert.classList.toggle('error',error);alert.hidden=false;}
  async function api(path,options={}){
    const response=await fetch('/api/admin'+path,{...options,cache:'no-store',headers:{...(options.body?{'Content-Type':'application/json','X-Notebook-Request':'1'}:{}),...options.headers}});
    const data=await response.json();
    if(!response.ok){if(response.status===401)notify('登录已过期。请先下载当前 Markdown，再重新打开笔记管理并登录。',true);throw new Error(data.error||'暂时无法完成操作，请重试。');}
    return data;
  }
  const date=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  function newDocument(){return {title:'',description:'',section:'work',category:groups.work[0],date:date(),slug:'note-'+Date.now().toString(36),tags:[],body:'',source:'',sourceLabel:'',difficulty:'',sample:false,featured:false};}
  function collect(){const result={};for(const [key,id] of Object.entries(fields)){const el=$('#note-'+id);result[key]=el.type==='checkbox'?el.checked:key==='tags'?el.value.split(/[,，]/).map(t=>t.trim()).filter(Boolean):el.value;}return result;}
  function setCategories(section,selected){const select=$('#note-category');select.replaceChildren(...groups[section].map(value=>{const option=document.createElement('option');option.textContent=value;option.value=value;return option;}));select.value=groups[section].includes(selected)?selected:groups[section][0];}
  function fill(doc){setCategories(doc.section,doc.category);for(const [key,id] of Object.entries(fields)){const el=$('#note-'+id);if(el.type==='checkbox')el.checked=!!doc[key];else el.value=key==='tags'?(doc.tags||[]).join(', '):doc[key]||'';}updateCount();queuePreview();}
  function canLeave(){return !dirty||confirm('当前内容尚未保存，确定放弃这些修改吗？');}
  function setBusy(value){busy=value;form.inert=value;$('.notes-panel').inert=value;paintState();}
  function paintState(){
    $('#save-state').textContent=busy?'正在保存到云端…':dirty?'有未保存的修改':current?'已保存 · '+new Date(current.updatedAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}):'尚未保存';
    $('#save-state').classList.toggle('unsaved',dirty);
    $('#note-state').textContent=current?.deletedAt?'回收站':current?.published?(current.hasChanges?'已发布 · 有草稿修改':'已发布'):'仅自己可见的草稿';
    $('#publish-note').innerHTML=current?.published?'更新发布 ↗':'发布文章 ↗';
    $('#save-note').hidden=!!current?.deletedAt;$('#publish-note').hidden=!!current?.deletedAt;
    $('#unpublish-note').hidden=!current?.published||!!current?.deletedAt;
    $('#trash-note').hidden=!current||!!current.deletedAt;$('#restore-note').hidden=!current?.deletedAt;
    $('#view-published').hidden=!current?.published||!!current?.deletedAt;
    if(current)$('#view-published').href=current.url;
    $('#note-history').hidden=!current;
    for(const id of ['slug','section'])$('#note-'+id).disabled=!!current?.published||!!current?.deletedAt;
    for(const [key,id] of Object.entries(fields)){if(['slug','section'].includes(key))continue;$('#note-'+id).disabled=!!current?.deletedAt;}
  }
  function openNote(note){current=note;dirty=false;$('#admin-alert').hidden=true;$('#history-panel').hidden=true;$('#editor-welcome').hidden=true;form.hidden=false;fill(note.document);paintState();renderList();}
  function startNew(doc){if(busy||!canLeave())return;current=null;dirty=true;$('#admin-alert').hidden=true;$('#history-panel').hidden=true;$('#editor-welcome').hidden=true;form.hidden=false;fill(doc||newDocument());paintState();renderList();$('#note-title').focus();}
  function label(note){return note.deletedAt?'回收站':note.published?(note.hasChanges?'已发布 · 草稿待更新':'已发布'):'草稿';}
  function renderList(){
    const query=$('#admin-search').value.trim().toLowerCase();const list=$('#note-list');list.replaceChildren();
    const filtered=notes.filter(n=>(status==='trash'?!!n.deletedAt:!n.deletedAt)&&(status==='draft'?(!n.published||n.hasChanges):status==='published'?n.published:true)&&[n.document.title,...n.document.tags,n.document.body].join(' ').toLowerCase().includes(query));
    for(const note of filtered){const button=document.createElement('button');button.type='button';button.className='note-list-item'+(current?.id===note.id?' selected':'');const meta=document.createElement('span');meta.className='note-list-meta';meta.textContent=(note.document.section==='work'?'工作手记':'算法题库')+' · '+label(note);const title=document.createElement('strong');title.textContent=note.document.title;const updated=document.createElement('span');updated.className='note-list-date';updated.textContent=new Date(note.updatedAt).toLocaleDateString('zh-CN');button.append(meta,title,updated);button.addEventListener('click',async()=>{if(busy||!canLeave())return;try{const {note:fresh}=await api('/notes/'+note.id);openNote(fresh);}catch(error){notify(error.message,true);}});list.append(button);}
    if(!filtered.length){const p=document.createElement('p');p.className='notes-empty';p.textContent=status==='trash'?'回收站是空的。':'没有找到笔记，写一篇新的吧。';list.append(p);}
    $('#workspace-status').textContent=`云端已连接 · ${notes.filter(n=>!n.deletedAt).length} 篇笔记 · ${notes.filter(n=>!n.deletedAt&&n.published).length} 篇已发布`;
  }
  async function refreshList(){notes=(await api('/notes')).notes;renderList();}
  function updateCount(){$('#word-count').textContent=$('#note-body').value.length.toLocaleString()+' 字符';}
  function changed(){dirty=true;paintState();updateCount();queuePreview();}
  form.addEventListener('input',changed);form.addEventListener('change',event=>{if(event.target.id==='note-section')setCategories(event.target.value);changed();});form.addEventListener('submit',event=>event.preventDefault());
  async function save(action='save'){
    if(busy)return;if(!form.reportValidity())return;
    const document=collect();setBusy(true);$('#admin-alert').hidden=true;
    try{
      if(!current){const {note}=await api('/notes',{method:'POST',body:JSON.stringify({document})});current=note;dirty=false;}
      const {note}=await api('/notes/'+current.id,{method:'PUT',body:JSON.stringify({revision:current.revision,action,document})});
      current=note;dirty=false;fill(note.document);await refreshList();
      notify(action==='publish'?'文章已发布，前台与搜索已更新。':'草稿已保存。已发布的正文保持原样，点击「更新发布」后才会更新。');
    }catch(error){notify(error.message,true);}finally{setBusy(false);}
  }
  async function transition(action,message){if(busy||!current||!canLeave()||!confirm(message))return;setBusy(true);try{const {note}=await api('/notes/'+current.id,{method:'PUT',body:JSON.stringify({revision:current.revision,action})});current=note;dirty=false;fill(note.document);await refreshList();notify(action==='restore'?'笔记已恢复为草稿，需要重新发布后才公开。':action==='trash'?'已移入回收站，公开页面不再显示。':'已撤回发布，正文与草稿仅你可见。');}catch(error){notify(error.message,true);}finally{setBusy(false);}}
  $('#save-note').addEventListener('click',()=>save());$('#publish-note').addEventListener('click',()=>save('publish'));
  $('#unpublish-note').addEventListener('click',()=>transition('unpublish','撤回后访客将无法阅读这篇文章。确定继续吗？'));
  $('#trash-note').addEventListener('click',()=>transition('trash','将这篇笔记移入回收站？之后可以恢复为草稿。'));
  $('#restore-note').addEventListener('click',()=>transition('restore','将这篇笔记恢复为私有草稿？'));
  $('#new-note').addEventListener('click',()=>startNew());$('#welcome-new').addEventListener('click',()=>startNew());
  $('#admin-search').addEventListener('input',renderList);
  $$('[data-status]').forEach(button=>button.addEventListener('click',()=>{status=button.dataset.status;$$('[data-status]').forEach(b=>b.classList.toggle('active',b===button));renderList();}));
  function queuePreview(){clearTimeout(previewTimer);const sequence=++previewSequence;$('#preview-status').textContent='更新中…';previewTimer=setTimeout(async()=>{try{const {html}=await api('/preview',{method:'POST',body:JSON.stringify({body:$('#note-body').value})});if(sequence!==previewSequence)return;$('#markdown-preview').innerHTML=html||'<p class="preview-empty">写下第一行 Markdown，预览会出现在这里。</p>';$('#preview-status').textContent='';}catch(error){if(sequence===previewSequence)$('#preview-status').textContent='预览失败，正文已保留';}},400);}
  function setView(view){$('.markdown-workspace').dataset.view=view;$$('[data-view]').filter(el=>el.tagName==='BUTTON').forEach(b=>b.classList.toggle('active',b.dataset.view===view));}
  $$('.editor-view-tabs button').forEach(button=>button.addEventListener('click',()=>setView(button.dataset.view)));if(innerWidth<850)setView('write');
  $$('[data-format]').forEach(button=>button.addEventListener('click',()=>{const input=$('#note-body'),start=input.selectionStart,end=input.selectionEnd,selected=input.value.slice(start,end);const formats={heading:['## ','标题'],bold:['**','文字','**'],italic:['*','文字','*'],link:['[','链接文字','](https://example.com)'],code:['\n```cpp\n','// code','\n```\n'],list:['- ','列表项'],quote:['> ','引用内容']};const [prefix,placeholder,suffix='']=formats[button.dataset.format];input.setRangeText(prefix+(selected||placeholder)+suffix,start,end,'select');input.focus();changed();}));
  $('#note-body').addEventListener('keydown',event=>{if(event.key==='Tab'){event.preventDefault();const input=event.target;input.setRangeText('  ',input.selectionStart,input.selectionEnd,'end');changed();}});
  document.addEventListener('keydown',event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='s'&&!form.hidden){event.preventDefault();if(!current?.deletedAt)save();}});
  window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
  function download(text,name,type){const url=URL.createObjectURL(new Blob([text],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  $('#export-note').addEventListener('click',()=>{const {body,...meta}=collect();const yaml=Object.entries({...meta,draft:true}).map(([key,value])=>key+': '+JSON.stringify(value)).join('\n');download('---\n'+yaml+'\n---\n\n'+body,(meta.slug||'note')+'.md','text/markdown;charset=utf-8');});
  $('#export-backup').addEventListener('click',async()=>{try{const data=await api('/export');download(JSON.stringify(data,null,2),'zlin-notes-'+date()+'.json','application/json');notify('已导出云端保存的笔记备份，包含草稿和回收站；未保存的编辑不在备份中。');}catch(error){notify(error.message,true);}});
  $('#import-note').addEventListener('click',()=>$('#import-file').click());
  $('#import-file').addEventListener('change',async event=>{const file=event.target.files?.[0];event.target.value='';if(!file||!canLeave())return;if(file.size>1000000){notify('文件超过 1 MB，请缩小后导入。',true);return;}try{const {document}=await api('/import',{method:'POST',body:JSON.stringify({markdown:await file.text(),filename:file.name})});dirty=false;startNew(document);notify('已载入 Markdown，保存前不会写入云端，也不会自动发布。');}catch(error){notify(error.message,true);}});
  $('#note-history').addEventListener('click',async()=>{if(!current)return;const panel=$('#history-panel');if(!panel.hidden){panel.hidden=true;return;}try{const {versions}=await api('/notes/'+current.id+'/versions');panel.replaceChildren();const title=document.createElement('h3');title.textContent='最近 30 个保存版本';panel.append(title);if(!versions.length){const p=document.createElement('p');p.textContent='保存一次修改后，这里会出现版本记录。';panel.append(p);}for(const version of versions){const button=document.createElement('button');button.type='button';button.textContent=`v${version.revision} · ${new Date(version.createdAt).toLocaleString('zh-CN')} · 载入编辑器`;button.addEventListener('click',()=>{if(!canLeave())return;fill(version.document);dirty=true;paintState();panel.hidden=true;notify('已载入历史版本。保存或发布后才会覆盖当前草稿。');});panel.append(button);}panel.hidden=false;}catch(error){notify(error.message,true);}});
  $('#markdown-preview').addEventListener('click',async event=>{const button=event.target.closest('.copy-code');if(!button)return;try{await navigator.clipboard.writeText(button.parentElement.querySelector('code').textContent);button.textContent='已复制';}catch{notify('浏览器未允许复制，请手动选择代码。',true);}});
  refreshList().catch(error=>{notify(error.message,true);$('#workspace-status').textContent='无法连接云端，请刷新重试。';});
})();
