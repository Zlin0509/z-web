import YAML from 'yaml';
import site from '../website/site.json' with { type: 'json' };
import seed from '../website/generated/seed.json' with { type: 'json' };
import { layout, homePage, listingPage, articlePage, aboutPage, notFoundPage } from '../website/templates.mjs';
import { adminPage, loginPage } from '../website/admin-templates.mjs';
import { escape as e, groups, md, renderPost } from '../website/markdown.mjs';
import { HttpError, checkMutation, readJson, validateDocument } from './model.mjs';
import { ensureSeed, requireOwner, listNotes, getNote, createNote, updateNote, publishedDocuments, versions } from './store.mjs';

const headers = { 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'strict-origin-when-cross-origin' };
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{...headers,'Content-Type':'application/json; charset=utf-8'}});
function html(body,path,title='',options={},status=200) { return new Response(layout({site,title,body,path,...options}),{status,headers:{...headers,'Content-Type':'text/html; charset=utf-8',...(path.startsWith('/admin')?{'X-Robots-Tag':'noindex, nofollow','Content-Security-Policy':"frame-ancestors 'self'"}:{})}}); }
export async function handleRequest(request,env,user) {
  const path=new URL(request.url).pathname.replace(/\/+$/,'')||'/'; const admin=path==='/admin'||path.startsWith('/api/admin/');
  try {
    if(path==='/trading' && (request.method==='GET'||request.method==='HEAD')) return new Response(null,{status:302,headers:{Location:'https://zlin-trading-lab.zlin20050509.chatgpt.site/', 'Cache-Control':'no-store'}});
    if(admin&&!user) { if(path==='/admin')return html(loginPage(),'/admin/','登录笔记管理',{noindex:true,section:'admin'});throw new HttpError(401,'请先登录再管理笔记。'); }
    if(!env.DB)throw new HttpError(503,'笔记存储暂时不可用，请稍后重试。');
    if(admin)await requireOwner(env.DB,user,env.NOTEBOOK_OWNER_EMAIL);
    await ensureSeed(env.DB,seed);
    if(path==='/admin'&&request.method==='GET')return html(adminPage(user),'/admin/','笔记管理',{noindex:true,section:'admin'});
    if(path.startsWith('/api/admin/'))return await adminApi(request,path,env.DB,user);
    if(request.method!=='GET'&&request.method!=='HEAD')throw new HttpError(405,'此页面不支持该请求方式。');
    const docs=await publishedDocuments(env.DB);
    if(path==='/search.json')return json(docs.map(doc=>({...doc,url:`/${doc.section}/${doc.slug}/`})));
    const posts=docs.map(renderPost);
    if(path==='/')return html(homePage(posts,site),'/');
    if(path==='/about')return html(aboutPage(site),'/about/','关于我',{section:'about'});
    const parts=path.split('/').filter(Boolean);
    if(parts.length===1&&groups[parts[0]])return html(listingPage(posts,parts[0]),`/${parts[0]}/`,parts[0]==='work'?'工作手记':'算法题库',{section:parts[0]});
    if(parts.length===2&&groups[parts[0]]) { const post=posts.find(p=>p.section===parts[0]&&p.slug===parts[1]);if(post)return html(articlePage(post,posts),post.url,post.title,{section:post.section,post,description:post.description}); }
    if(path==='/feed.xml')return new Response(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${e(site.title)}</title><link>${e(site.url)}</link><description>${e(site.description)}</description><language>zh-CN</language>${posts.map(p=>`<item><title>${e(p.title)}</title><link>${e(site.url+p.url)}</link><guid>${e(site.url+p.url)}</guid><description>${e(p.description)}</description><pubDate>${new Date(p.date+'T00:00:00+08:00').toUTCString()}</pubDate></item>`).join('')}</channel></rss>`,{headers:{...headers,'Content-Type':'application/xml; charset=utf-8'}});
    if(path==='/sitemap.xml')return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/','/work/','/algorithms/','/about/',...posts.map(p=>p.url)].map(p=>`<url><loc>${e(site.url+p)}</loc></url>`).join('')}</urlset>`,{headers:{...headers,'Content-Type':'application/xml; charset=utf-8'}});
    if(path==='/robots.txt')return new Response(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/admin/\nSitemap: ${site.url}/sitemap.xml\n`,{headers:{...headers,'Content-Type':'text/plain; charset=utf-8'}});
    return html(notFoundPage(),path,'页面走丢了',{noindex:true},404);
  } catch(error) {
    const status=error instanceof HttpError?error.status:500;
    const message=error instanceof HttpError?error.message:'操作暂时失败，编辑内容仍在页面中，请稍后重试。';
    if(status===500)console.error('Notebook request failed',path,error);
    if(path==='/admin')return html(loginPage({forbidden:status===403,unavailable:status!==403}),'/admin/','笔记管理',{noindex:true,section:'admin'},status);
    if(path.startsWith('/api/'))return json({error:message},status);
    return html(`<section class="container not-found"><h1>暂时无法读取笔记</h1><p>${e(message)}</p><a class="button" href="/">重新加载</a></section>`,path,'暂时无法读取',{noindex:true},status);
  }
}
async function adminApi(request,path,db,user) {
  const method=request.method;
  if(!['GET','HEAD'].includes(method))checkMutation(request);
  if(path==='/api/admin/session'&&method==='GET')return json({user:{displayName:user.displayName},groups});
  if(path==='/api/admin/notes') {
    if(method==='GET')return json({notes:await listNotes(db)});
    if(method==='POST')return json({note:await createNote(db,(await readJson(request)).document)},201);
  }
  if(path==='/api/admin/export'&&method==='GET')return json({format:'zlin-notebook-v1',exportedAt:new Date().toISOString(),notes:await listNotes(db)});
  if(path==='/api/admin/preview'&&method==='POST') { const {body}=await readJson(request);if(typeof body!=='string'||body.length>200000)throw new HttpError(400,'正文过长或格式不正确。');return json({html:md.render(body)}); }
  if(path==='/api/admin/import'&&method==='POST') {
    const {markdown,filename}=await readJson(request);if(typeof markdown!=='string'||markdown.length>250000)throw new HttpError(400,'Markdown 文件过大或内容不正确。');
    const match=markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);let meta={};let body=markdown;
    if(match){try{meta=YAML.parse(match[1])||{};if(typeof meta!=='object'||Array.isArray(meta))throw new Error();body=match[2];}catch{throw new HttpError(400,'Markdown 顶部的 YAML 格式不正确。');}}
    const section=groups[meta.section]?meta.section:groups.algorithms.includes(meta.category)?'algorithms':'work';
    const candidate=String(filename||'').replace(/\.(md|markdown)$/i,'');
    const doc=validateDocument({title:meta.title||body.match(/^#\s+(.+)$/m)?.[1]||'导入的笔记',description:meta.description||'',date:meta.date||new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date()),category:meta.category||groups[section][0],tags:meta.tags||[],...meta,section,slug:meta.slug||(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate)?candidate:`note-${Date.now().toString(36)}`),body});
    return json({document:doc});
  }
  const match=path.match(/^\/api\/admin\/notes\/([^/]+)(?:\/(versions|markdown))?$/);
  if(match){const id=decodeURIComponent(match[1]);if(method==='GET'&&match[2]==='versions')return json({versions:await versions(db,id)});
    if(method==='GET'&&match[2]==='markdown'){const note=await getNote(db,id);const {body,...meta}=note.document;return new Response(`---\n${YAML.stringify({...meta,draft:!note.published||note.hasChanges})}---\n\n${body}`,{headers:{...headers,'Content-Type':'text/markdown; charset=utf-8','Content-Disposition':`attachment; filename="${note.document.slug}.md"`}});}
    if(!match[2]&&method==='GET')return json({note:await getNote(db,id)});
    if(!match[2]&&method==='PUT')return json({note:await updateNote(db,id,await readJson(request))});
  }
  throw new HttpError(404,'没有找到这个管理接口。');
}
