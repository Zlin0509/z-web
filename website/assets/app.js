const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
let toastTimer;
function toast(message) { const box = $('.toast'); box.textContent = message; box.classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => box.classList.remove('visible'), 2600); }
const themeToggle = $('.theme-toggle');
const updateThemeLabel = () => themeToggle?.setAttribute('aria-label', `切换${document.documentElement.dataset.theme === 'dark' ? '浅色' : '深色'}模式`);
updateThemeLabel();
themeToggle?.addEventListener('click', () => { const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = theme; try { localStorage.setItem('zlin-theme', theme); } catch {} updateThemeLabel(); });
$('.mobile-menu')?.addEventListener('click', () => { const menu = $('#mobile-nav'); menu.hidden = !menu.hidden; $('.mobile-menu').setAttribute('aria-expanded', String(!menu.hidden)); $('.mobile-menu').setAttribute('aria-label', menu.hidden ? '展开导航' : '收起导航'); });

let saved = new Set();
try { const value = JSON.parse(localStorage.getItem('zlin-bookmarks') || '[]'); if (Array.isArray(value)) saved = new Set(value.filter(v => typeof v === 'string')); } catch {}
function updateBookmarks() { $$('[data-bookmark]').forEach(button => { const active = saved.has(button.dataset.bookmark); button.setAttribute('aria-pressed', String(active)); const span = button.querySelector('span'); if (span) span.textContent = active ? '已收藏' : '收藏题目'; }); }
updateBookmarks();
$$('[data-bookmark]').forEach(button => button.addEventListener('click', () => { const slug = button.dataset.bookmark; const had = saved.has(slug); had ? saved.delete(slug) : saved.add(slug); try { localStorage.setItem('zlin-bookmarks', JSON.stringify([...saved])); toast(had ? '已取消收藏' : '已收藏，稍后再来回顾'); } catch { toast('当前浏览器无法保存，收藏仅在本页有效'); } updateBookmarks(); applyFilters(); }));

const params = new URLSearchParams(location.search);
let category = params.get('category') || 'all';
let tag = params.get('tag') || 'all';
let query = params.get('q') || '';
if ($('#list-search')) $('#list-search').value = query;
if (!$$('[data-category]').some(b => b.tagName === 'BUTTON' && b.dataset.category === category)) category = 'all';
if (!$$('[data-tag]').some(b => b.dataset.tag === tag)) tag = 'all';
function applyFilters() {
  const items = $$('.filter-item'); if (!items.length) return;
  let count = 0;
  for (const item of items) {
    const tags = JSON.parse(item.dataset.tags);
    const show = (category === 'all' || category === 'saved' && saved.has(item.dataset.slug) || item.dataset.category === category) && (tag === 'all' || tags.includes(tag)) && query.toLowerCase().trim().split(/\s+/).every(q => item.dataset.search.includes(q));
    item.hidden = !show; if (show) count++;
  }
  $$('.filter-tabs button').forEach(button => { const active = button.dataset.category === category; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
  $$('.filter-tag').forEach(button => { const active = button.dataset.tag === tag; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
  $('#result-count').textContent = `共 ${count} 篇记录`;
  $('.empty-state').hidden = count > 0;
  const url = new URL(location.href); url.search = ''; if (category !== 'all') url.searchParams.set('category', category); if (tag !== 'all') url.searchParams.set('tag', tag); if (query) url.searchParams.set('q', query);
  history.replaceState(null, '', url);
}
$$('.filter-tabs button').forEach(button => button.addEventListener('click', () => { category = button.dataset.category; applyFilters(); }));
$$('.filter-tag').forEach(button => button.addEventListener('click', () => { tag = button.dataset.tag; applyFilters(); }));
$('#list-search')?.addEventListener('input', event => { query = event.target.value; applyFilters(); });
$('#reset-filters')?.addEventListener('click', () => { category = tag = 'all'; query = ''; $('#list-search').value = ''; applyFilters(); });
applyFilters();

const dialog = $('.search-dialog');
const search = $('#global-search');
const results = $('.search-results');
let index;
let loading;
let renderSequence = 0;
async function getIndex() {
  if (index) return index;
  if (!loading) loading = fetch('/search.json').then(response => { if (!response.ok) throw new Error('Search unavailable'); return response.json(); }).then(data => { index = data; return data; }).catch(error => { loading = null; throw error; });
  return loading;
}
async function renderSearch() {
  const sequence = ++renderSequence;
  const value = search.value.trim().toLowerCase();
  if (!value) { results.replaceChildren(); const hint = document.createElement('p'); hint.className = 'search-hint'; hint.textContent = '输入关键词，找到曾经的思考。'; results.append(hint); return; }
  try {
    const data = await getIndex(); if (sequence !== renderSequence) return;
    const words = value.split(/\s+/);
    const matches = data.filter(item => words.every(word => `${item.title} ${item.description} ${item.tags.join(' ')} ${item.body}`.toLowerCase().includes(word))).slice(0, 20);
    results.replaceChildren();
    for (const item of matches) {
      const a = document.createElement('a'); a.href = item.url; a.className = 'search-result';
      const label = document.createElement('span'); label.textContent = `${item.category}${item.sample ? ' · 示例' : ''}`;
      const title = document.createElement('h3'); title.textContent = item.title;
      const description = document.createElement('p'); description.textContent = item.description;
      a.append(label, title, description); results.append(a);
    }
    if (!matches.length) { const hint = document.createElement('p'); hint.className = 'search-hint'; hint.textContent = '没有找到相关记录，试试「Agent」「图论」或「动态规划」。'; results.append(hint); }
  } catch { if (sequence !== renderSequence) return; results.replaceChildren(); const hint = document.createElement('p'); hint.className = 'search-hint'; hint.textContent = '搜索暂时无法加载，请检查网络后重新输入。'; results.append(hint); }
}
function openSearch() { if (!dialog.open) dialog.showModal(); search.focus(); renderSearch(); }
$$('[data-search-open]').forEach(button => button.addEventListener('click', openSearch));
$('.close-search')?.addEventListener('click', () => dialog.close());
dialog?.addEventListener('click', event => { const rect = dialog.getBoundingClientRect(); if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close(); });
search?.addEventListener('input', renderSearch);
document.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); dialog.open ? dialog.close() : openSearch(); } });
dialog?.addEventListener('keydown', event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { const links = $$('.search-result'); if (!links.length) return; event.preventDefault(); const current = links.indexOf(document.activeElement); const next = event.key === 'ArrowDown' ? Math.min(current + 1, links.length - 1) : Math.max(current - 1, 0); links[next].focus(); } });

async function copy(text) { try { await navigator.clipboard.writeText(text); return true; } catch { toast('浏览器未允许复制，请手动选择内容复制'); return false; } }
$$('.copy-code').forEach(button => button.addEventListener('click', async () => { if (await copy(button.parentElement.querySelector('code').textContent)) { button.textContent = '已复制'; setTimeout(() => button.textContent = '复制', 1800); } }));
$('#share-article')?.addEventListener('click', async () => { if (await copy(location.origin + location.pathname)) toast('文章链接已复制'); });
const headingLinks = $$('.toc nav a');
if (headingLinks.length && 'IntersectionObserver' in window) {
  const observer = new IntersectionObserver(entries => { const visible = entries.filter(entry => entry.isIntersecting); if (!visible.length) return; const id = visible[0].target.id; headingLinks.forEach(link => link.classList.toggle('active', link.hash === '#' + id)); }, { rootMargin: '-10% 0px -65% 0px' });
  $$('.prose h2,.prose h3').forEach(heading => observer.observe(heading));
}
