import MarkdownIt from "markdown-it";
import hljs from "highlight.js";

export const groups = {
  work: ['Agent 工程', '开发实践', '思考随笔'],
  algorithms: ['题目解析', '算法专题', '比赛复盘'],
};
export const escape = (value) => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
export const md = new MarkdownIt({ html: false, linkify: true, typographer: true, highlight(code, language) {
  const output = language && hljs.getLanguage(language) ? hljs.highlight(code, { language }).value : escape(code);
  return `<pre class="code-block"><span class="code-language">${escape(language || 'text')}</span><button class="copy-code" type="button" aria-label="复制代码">复制</button><code class="hljs">${output}</code></pre>`;
}});

export function renderPost(post) {
  const toc = [];
  const tokens = md.parse(post.body, {});
  tokens.forEach((token, index) => {
    if (token.type === 'heading_open') {
      const id = `section-${toc.length + 1}`;
      token.attrSet('id', id);
      toc.push({ title: tokens[index + 1].content, id, level: Number(token.tag.slice(1)) });
    }
  });
  return { ...post, html: md.renderer.render(tokens, md.options, {}), toc,
    url: `/${post.section}/${post.slug}/`, minutes: Math.max(1, Math.ceil(post.body.length / 650)) };
}
