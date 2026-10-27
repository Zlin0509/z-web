# Zlin · 开发与算法手记

个人博客，分为 **工作手记** 与 **算法题库**。使用 Markdown 管理内容，以 Node.js 生成静态 HTML，浏览器只加载必要的原生 JavaScript。

- 网站：https://zlin-dev-notes.zlin20050509.chatgpt.site
- 仓库：https://github.com/Zlin0509/z-web
- 支持全文搜索、分类与标签筛选、题目收藏、深色模式、文章目录、代码高亮与复制、RSS 和站点地图。
- 收藏和主题保存在访客自己的浏览器，不上传服务器，也不跨设备同步。

## 本地运行

需要 Node.js 18 或更新版本（CI 使用 Node.js 22）。

```bash
npm ci
npm run dev
```

打开终端打印的 `http://127.0.0.1:4321`。修改 `website/` 下的文件后自动重新构建，刷新页面即可查看。可通过环境变量 `PORT` 修改端口。

```bash
npm run build       # 生成 dist/
npm run preview     # 构建并预览，不监听文件
npm test            # 内容规则与安全渲染测试
npm run check       # 检查已构建页面的站内链接与锚点
npx playwright install chromium
npm run test:browser # 桌面与手机交互测试；Linux 需要浏览器系统依赖
```

## 写一篇文章

```bash
npm run new -- work my-agent-note "我的 Agent 开发笔记"
npm run new -- algorithms my-problem "一道值得回顾的题"
```

新文件默认是草稿，完成后把 `draft` 改为 `false`。可直接在 `website/content/work/` 或 `website/content/algorithms/` 中添加 `.md` 文件：

```yaml
---
title: "文章标题"
description: "用于列表、搜索和分享的一句话摘要"
date: "2026-10-27"
category: "Agent 工程"
tags: [Agent, 工具调用]
draft: false
---
```

正文写在第二个 `---` 之后。文件名使用小写英文、数字与连字符，例如 `agent-memory.md`，它会成为文章网址的一部分。日期用引号包裹。草稿不会出现在页面、搜索索引、RSS 或站点地图中。

| 主栏目 | 可选分类 |
| --- | --- |
| 工作手记 `work` | Agent 工程、开发实践、思考随笔 |
| 算法题库 `algorithms` | 题目解析、算法专题、比赛复盘 |

题目可额外填写：

```yaml
difficulty: "基础"  # 入门 / 基础 / 进阶 / 挑战，表示自定义学习难度
source: "https://www.luogu.com.cn/problem/P4779"
sourceLabel: "洛谷 P4779 · 原题"
```

`featured: true` 可让同一天的文章优先展示。首页与栏目统计均从内容生成。

初始 6 篇文章均标有 `sample: true`，是展示结构的示例，不代表真实项目或比赛经历。可直接删除或改写；写成自己的正式文章后移除 `sample`。比赛复盘草稿位于 `website/content/algorithms/contest-review-template.md`。

## 修改设计与个人信息

- `website/site.json`：名字、站点标题、网址、GitHub 地址、介绍。
- `website/templates.mjs`：页面结构、首页与关于页文案。
- `website/assets/style.css`：颜色、布局、深色模式与响应式样式。
- `website/assets/app.js`：搜索、筛选、收藏和复制等交互。
- `website/content.mjs`：Markdown 解析和内容校验。
- `website/build.mjs`：静态页面、搜索索引、RSS、站点地图生成。

字体优先使用 Google Fonts；无法连接时使用本机中文字体与系统字体，不影响功能。网站没有登录后台，发布内容通过修改 Markdown 完成。

## 同步与发布

```bash
git pull --ff-only
# 编辑内容后执行检查
npm test && npm run build && npm run check
git add .
git commit -m "Add a new note"
git push origin main
```

GitHub Actions 会检查内容、构建和站内链接。**推送到 GitHub 不会自动更新 Sites 上的线上网站**。需要在 Codex 中要求「发布当前网站更新」，使用仓库内 `.openai/hosting.json` 记录的同一 Site 完成构建、源码同步与部署。

站点已选择公开访问。`.openai/hosting.json` 只存站点 ID 与构建目录，不包含密钥；发布凭证不得提交到 Git。

也可将 `dist/` 部署到任何支持目录索引的静态托管平台。迁移时修改 `website/site.json` 中的 `url` 并重新构建。若使用 GitHub Pages 项目路径 `/z-web/`，需额外配置路径前缀或使用独立域名，本项目当前按独立域名根路径生成链接。
