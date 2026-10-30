# Zlin Trading Service

独立部署的私人交易研究服务，美股与虚拟币共用日线研究引擎，拥有独立的 D1 数据库和 Sites 身份边界。博客只链接到本服务，不代理账户或策略数据。

## 已实现

- OKX USDT 现货公开日线（仅确认完成的 UTC K 线）、Alpaca IEX / Alpha Vantage 美股日线适配器、CSV 导入。
- SMA20、EMA20、Wilder RSI14、MACD12/26/9、布林带20、Wilder ATR14、20 日年化历史波动率。
- 双均线、RSI 回归、通道突破三种参数化策略；可保存回测结果、交易流水和权益曲线，导出 JSON。
- 持续模拟策略：新完成的日线触发推进；仓位上限、手续费、滑点、回撤停机、版本 CAS 和时间水位防重复；一键停止。
- DeepSeek JSON 分析适配器，服务端密钥，响应验证、调用间隔、分析留档；只产生研究建议。
- OKX 私有接口 HMAC 签名和只读账户连接检查；**不包含实盘下单执行器**。

## 运行与部署

Node >=22.13。在本目录执行 `npm ci`、`npm run dev -- --port 4322`。本服务有独立 package.json、Worker、数据库迁移和 `.openai/hosting.json`，可脱离博客目录部署。代码同时保存在主 GitHub 仓库的 services/trading。

本地模拟登录由官方 Sites 插件提供，`.dev.vars` 使用 `TRADING_OWNER_EMAIL="seedy@sites.test"`。生产保留 Sites 当前访问范围；应用内交易数据和操作始终要求所有者通过 ChatGPT 登录；首次以已验证的 owner email 绑定 Site-scoped user ID。配置项见 `.env.example`，不得把密钥写入 Git、浏览器或日志。

构建：`npm run build`。本地 D1 初始化：构建后执行 `node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_*.sql`，替换通配符为实际迁移名，且仅执行未应用迁移。生产由 Sites 在部署时应用迁移。

## 数据库展示与定时同步

页面行情读取只访问服务端 D1 数据库，不调用行情供应商，不开启 WebSocket、不进行15秒报价轮询或60秒页面重载。`/api/state?asset=...` 一次返回列表与选中标的日线；同一页面按 revision 复用标的日线。回测列表只返回摘要，完整曲线和交易通过 `/api/runs/:id` 按需加载。「读取数据库」仅重新读取持久数据，「更新行情入库」才触发写入同步。

报价每5分钟在后台采集一次：所有美股合并为一次 Alpaca IEX 请求，虚拟币合并为一次 OKX SPOT tickers 请求。接口故障保留上次成功值和原始行情时间，显示错误；重复任务用租约和290秒缓存阻止重复采集。报价是定时快照，并非逐笔实时数据。

完整日线单独更新：虚拟币已有昨天的完整 UTC 日线时不请求；美股成功检查后6小时内复用数据库，休市也避免每5分钟重复拉取。Alpaca 首次取550天，后续从最新日线向前重叠3天；OKX 根据缺口缩小请求条数。历史以标的、来源、年份归档到 service_state 的 `history:*` 记录，按时间去重和修订；图表/回测活跃窗口保留最近2000根，旧数据继续留在年度归档。来源切换保留原来源归档，避免混合复权口径。

站点保留公开入口，业务 API 仍要求所有者登录。后台 `/internal/refresh` 和 `/internal/status` 使用独立 HMAC-SHA256 同步凭证，签名绑定时间、方法与路径，5分钟过期；拒绝浏览器 Origin。平台 bypass token 本身无写入权限。同步凭证不能访问账户、策略编辑或订单 API。

运行器：`scripts/sync-market.py --config /home/zlin/.config/zlin-trading/sync.json`。配置文件0600，凭证通过 curl 标准输入传递，不进入 Git、命令行或日志；服务端秘密名 TRADING_SYNC_SECRET。部署后使用当前服务器的用户 crontab 每5分钟执行一次，flock 防止重叠。最近结果保存在同目录 last-status.json。此计划依赖服务器和 cron 在线，重启后继续；原 Sites 每日任务缺少新签名凭证，不作为同步路径，当前工具无法修改它。

## 回测口径

仅日线，多头、无杠杆，可模拟碎股。完成预热后，t-1 收盘信号在 t 开盘按滑点和单边手续费成交；买入持有基准使用同一起点和买入成本。期末持仓按市价估值，胜率仅包含已平仓交易，0笔成交时胜率为空。波动率/夏普用365（虚拟币）或252（美股）年化。回撤触线后在下一可用日线开盘模拟退出，跳空可能超过阈值。

模拟启动时记录最新日线时间，不追溯生成历史订单。数据缺口导致时间水位不在已保留窗口时暂停。模拟只用于研究：它根据已完成日线重建假想开盘成交，不能验证真实流动性、滑点或订单延迟。

股票源为未复权 OHLCV，不计股息、拆股、税费或停牌流动性。跨公司行动比较请导入一致复权的 OHLC。导入会替换该标的样本并切换为 CSV 离线模式。勿将短样本回测理解为实盘表现。

## 后续接入

OKX 账户 Key / Secret / Passphrase 和 DeepSeek Key / Model 通过服务端秘密配置接入。实盘执行需要另行实现交易所订单幂等、成交对账、资产精度/最小下单额、价格与余额校验、限额和紧急停机，并先通过 OKX 模拟账户测试。不得将模型返回的信号直接当作订单参数。

官方参考：[OKX API](https://www.okx.com/docs-v5/en/) · [Alpha Vantage 日线](https://www.alphavantage.co/documentation/#daily) · [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)

## 网页连接配置与最新报价

登录后进入「服务接入」，下方「密钥配置与 Schwab 账户」可填写 DeepSeek API Key、Alpaca Key ID/Secret、Schwab App Key/Secret。密钥在服务端用 AES-256-GCM 加密存入 D1，主密钥 CONFIG_ENCRYPTION_KEY 保存在 Sites secrets；配置接口只返回已配置状态，输入空白保留旧值。切勿直接轮换主密钥，否则旧配置无法解密。

最新报价和回测日线分别保存于数据库；页面只读取快照，后台批量刷新，明确标注来源与行情时间。日线指标和模拟策略仍使用完整日线，不用报价替代历史收盘价。

Schwab 回调地址为 `https://zlin-trading-lab.zlin20050509.chatgpt.site/schwab/callback`。注册应用需要 Accounts and Trading Production；Market Data Production 可按需申请，本版美股报价使用 Alpaca。网页通过顶层 OAuth 授权，服务端加密保存和刷新令牌；失效后需重新授权。支持账户/持仓/近7日订单读取、普通时段DAY股票整股限价单预览与提交、撤单。单笔最多1000 USD；预览60秒过期，提交一次性领取，超时结果未知时不自动重发。

本地预览不是 Schwab 券商预检。真实提交和撤单受服务端 SCHWAB_LIVE_TRADING_ENABLED=true 开关保护，网页无法启用该开关。当前无真实凭证，尚未完成券商联调，保持关闭。自动策略仍仅模拟，不会自动调用这些实盘接口。DeepSeek仍只生成研究建议。

免费美股报价说明：[Alpaca Market Data FAQ](https://docs.alpaca.markets/us/docs/market-data-faq)。IEX不是全美综合SIP。

限流处理：日线同步会复用已有最新完整 UTC 日线，美股成功快照缓存15分钟；遇到 HTTP 429、OKX 50011 或 Alpha Vantage 配额提示时，按数据源保存冷却状态，遵守 Retry-After 并指数退避（默认1至15分钟）。冷却期间不再请求该源，保留历史数据及原更新时间，并显示可重试时间。下一次同步在冷却到期后重试。

DeepSeek 模型选择：保存 API Key 后自动调用官方 GET /models 获取该账号可用模型，使用下拉列表由用户选择并保存，不写死模型或自动选择第一项。模型列表在当前页面内存中缓存5分钟；点击重新获取可立即请求，失败时显示原因并可手动重试；已有且仍可用的选择会保留。

页面性能：配置状态使用单次查询读取存在性，仅解密模型名称；与密钥无关的页面和数据读取路由不再读取密钥。页面内存缓存非敏感配置状态60秒，模型列表独立加载与合并并发请求，保存立即更新状态且不会等待模型接口。市场状态与选中标的并行读取，状态接口的独立数据库查询并行执行。缓存不写入浏览器持久存储。

美股日线：配置 Alpaca Key/Secret 后优先从 IEX 获取最近550天内已完成日线，处理分页并按纽约交易日期统一时间戳；价格未复权，成交量仅覆盖IEX。未配置Alpaca时使用Alpha Vantage。成功切换数据源时替换样本并暂停相关模拟策略，避免混用来源；失败保留原数据及来源。

观察列表：选择标的后可点击「删除标的」。删除与停止该标的运行/暂停中的模拟策略在一个事务内完成，版本冲突会拒绝删除。历史回测、模拟成交与运行日志保留，再次添加不会恢复旧策略。

## 自定义与 AI 策略

「策略回测」支持选择「自定义规则」，编辑入场 entry / 离场 exit 的 JSON；每组1–8条条件，all/any 组合。支持 OHLCV、SMA/EMA 快慢均线、RSI14、成交量均线和此前区间高低点；比较符为 gt/lt/gte/lte/crossAbove/crossBelow。离场优先，信号只使用当日及以前数据，不执行任意程序代码。

在「服务接入」保存 DeepSeek Key 并从接口返回列表选择模型后，填写目标，点击「AI 生成策略」或「AI 优化当前策略」。使用 [DeepSeek JSON Output](https://api-docs.deepseek.com/guides/json_mode/) 返回结构化规则，服务端验证后进行两段对比。至少120根日线：前70%用于训练，后30%不发送给模型，用于验证；两个方案使用相同评估起点、费用与初始资金，验证时独立重置组合，指标可使用此前历史。反复参考验证结果仍可能过拟合。

AI 不能提高仓位和回撤停机上限，不能改掉手续费、滑点或初始资金。方案须点击「应用到下方编辑器」后才能修改、回测、保存或手动启动模拟；生成本身不下单。保存会创建不可变版本，可重新载入，并通过 parentId 记录同标的版本关系。生成记录也保存在 service_state；API 密钥不会写入策略记录。

新增接口（所有者登录；POST 另需同源 Origin 与 X-Trading-Request）：GET/POST `/api/strategies`、POST `/api/strategies/propose`。生成使用100秒租约和完成后15秒冷却；外部请求超时90秒，失败不会自动重试。仅支持日线、多头、无杠杆的回测与模拟。

## 自动交易接入方案

现状：规则引擎、策略版本、回测和本地模拟组合已具备；后台同步会推进用户已启动的模拟策略。Schwab 有人工预览/提交/撤单接口但实盘开关关闭；OKX 只有只读账户检查；Alpaca 目前仅用于行情。自动交易执行器尚未接入。

建议下一阶段先接 Alpaca Paper 和 OKX Demo：固定策略版本 → 完整行情/时钟检查 → 持仓与余额对账 → 确定目标仓位 → 风控限制 → 持久订单意图 → 提交 → 查单/成交回报 → 更新订单与持仓。信号键为策略版本、标的、K线时间与方向，数据库唯一约束保证同一信号只产生一个意图；请求超时转为 unknown 并查单，不能盲目重发。

- Alpaca 使用纸面账户独立域名和 client_order_id，配合账户/订单查询或 trade_updates；当前已保存的是 Paper Key，可在实现执行器后完成纸面联调。
- OKX 使用独立 Demo Key、Secret、Passphrase 和 x-simulated-trading: 1；根据产品精度、最小数量处理现货订单，clOrdId 在本数据库永久唯一。实盘 Key 还需后续提供和授权。
- 执行前检查行情新鲜度、余额、交易时段、价差、最小下单额、最大仓位与每日亏损；异常时停止新单并保留对账任务。
- AI 负责生成/优化候选策略，经过验证、保存并激活版本后才交给确定性执行器。不能用一次不受约束的模型回复直接拼订单。

定时5分钟行情快照适合当前研究界面；实际交易信号触发时仍须获取新鲜行情/账户状态，行情缓存与交易执行不能共用“永不请求”的规则。日线回测中的历史次日开盘成交只是模拟假设；自动交易须改为信号形成后在真实可交易时段提交，记录实际成交。

官方参考：[Alpaca Paper Trading](https://docs.alpaca.markets/docs/paper-trading) · [Alpaca Client Order ID](https://docs.alpaca.markets/us/v1.4.2/reference/getorderbyclientorderid) · [OKX API / Demo Trading](https://www.okx.com/docs-v5/en/)。
