# Zlin · 开发与算法手记

网站：https://zlin-dev-notes.zlin20050509.chatgpt.site
笔记管理：https://zlin-dev-notes.zlin20050509.chatgpt.site/admin/

## 在线写作

点击网站页尾的 **笔记管理**，使用创建本站时的 ChatGPT 账号登录。公开页面无需登录；其他账号即使已登录，也不能读取草稿或操作管理接口。

- 新建笔记，选择工作手记 / 算法题库、分类、标签和日期。
- 使用 Markdown 编辑器与分栏预览，支持标题、列表、表格、链接、引用、代码高亮和复制。
- **保存草稿**：仅管理员可见。编辑已发布文章时，线上正文保持原样。
- **发布文章 / 更新发布**：将当前草稿公开，首页、栏目、全文搜索、RSS 与站点地图立即使用新内容，无需重新部署。
- **撤回发布**：移出公开页面，保留草稿。
- **回收站**：移入后不再公开，恢复时回到私有草稿，避免误公开。
- 支持 Markdown 文件导入、当前编辑内容下载、最近 30 个历史保存版本载入，以及全部云端笔记 JSON 备份（包含草稿与回收站）。
- 编辑过程中有未保存提示，离开前会提醒；Ctrl / ⌘ S 保存。没有静默自动保存，离线或报错时请下载当前 Markdown 留存。
- 多标签页通过版本号校验避免覆盖。遇到冲突时保留当前文字，先导出，再重新选中笔记加载最新版本。

已发布笔记的栏目和网址标识不可直接更改；如需更改，先撤回发布。这样可以减少无意造成的旧链接失效。

## 内容存储与代码仓库

正式内容持久化到 Sites 托管的 Cloudflare D1 数据库。在线管理笔记不依赖本地电脑，也不需要 GitHub 写入权限。

**在线笔记不会自动提交到 GitHub。** GitHub 保存网站代码和初始示例，D1 保存在线内容；需要离线副本时，请从后台下载 Markdown 或 JSON 备份。JSON 备份当前用于留档，后台支持的直接导入格式是 Markdown。

`website/content/` 中原有的 7 个 Markdown 文件（含 1 个比赛复盘草稿）只用于第一次初始化数据库。初始化有持久标记，此后重新部署不会覆盖线上编辑、撤回或回收站状态。

管理权限首次通过平台验证的所有者邮箱绑定本站稳定用户 ID；绑定后按用户 ID 授权，不会把编辑权限开放给任意登录用户。平台负责登录与会话；应用逐次校验接口权限、请求来源、字段与版本号。Markdown 禁止执行内嵌 HTML。

## 本地开发

需要 Node.js **22.13.0 或更新版本**；建议使用 Node.js 22 LTS。

```bash
npm ci
# 创建不提交的 .dev.vars，填入下面的本地模拟账号
# NOTEBOOK_OWNER_EMAIL="seedy@sites.test"
npm run build
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_fixed_white_tiger.sql
npm run dev
```

本地预览默认使用 http://localhost:5173；端口可通过 `npm run dev -- --port 4321` 设置。第一次启动前应用一次本地 SQL 迁移，不要重复执行已应用迁移。新增结构后使用 `npm run db:generate`，按顺序应用新迁移；已经应用的迁移文件不可修改。

便携预览中的「使用 ChatGPT 登录」仅在回环地址模拟 `local_seedy / seedy@sites.test`，这一模拟逻辑不会进入生产构建。生产环境没有本地测试账号或测试密码。

```bash
npm test              # SQLite 上验证身份授权、草稿隔离、发布、回收站、冲突与 Markdown 导入导出
npm run build         # Vinext / Cloudflare Worker 和静态资产
npm run check         # 初始内容生成与站内链接检查
npx playwright install chromium
npm run test:browser  # 桌面 / 手机公开页面与登录编辑流程
```

## 项目结构

- `website/assets/`：原有设计、公开页面交互、Markdown 编辑器样式与脚本。
- `website/templates.mjs`：公开页面模板；`website/admin-templates.mjs`：登录页与管理台。
- `website/markdown.mjs`：共享 Markdown 渲染与目录生成。
- `server/controller.mjs`：动态页面、搜索 / RSS / 站点地图和管理 API。
- `server/model.mjs`：请求校验；`server/store.mjs`：权限绑定、笔记状态与持久化。
- `db/schema.ts`、`drizzle/`：数据库结构及不可变的迁移记录。
- `app/chatgpt-auth.ts`：平台登录辅助函数；`app/route.ts`：服务端入口。
- `scripts/vite/`、`worker/`：Sites 官方构建与运行集成，需保留。
- `website/site.json`：站点名称、介绍、GitHub 地址与正式网址。

## 部署代码更新

`.openai/hosting.json` 保留原 Site ID，声明 `d1: "DB"`，站点继续公开访问。`NOTEBOOK_OWNER_EMAIL` 是 Sites 的服务端环境配置，不得写进源码或前端。生产邮箱配置变更不会自动重新绑定已经授权的用户 ID。

```bash
npm test && npm run build && npm run check
git add .
git commit -m "Update notebook website"
git push origin main
```

GitHub Actions 负责代码检查；代码更新需要通过 Codex / Sites 发布。**只编辑笔记不需要重新部署**。发布工具会先应用新增数据库迁移，再上传 Worker。数据库与本地预览完全分离，任何真实账号、令牌和 .dev.vars 都不得提交。
