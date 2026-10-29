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

本地模拟登录由官方 Sites 插件提供，`.dev.vars` 使用 `TRADING_OWNER_EMAIL="seedy@sites.test"`。生产必须保持本站 **仅所有者可访问**，浏览器以 ChatGPT 登录；首次以已验证的 owner email 绑定 Site-scoped user ID。配置项见 `.env.example`，不得把密钥写入 Git、浏览器或日志。

构建：`npm run build`。本地 D1 初始化：构建后执行 `node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_*.sql`，替换通配符为实际迁移名，且仅执行未应用迁移。生产由 Sites 在部署时应用迁移。

## 自动更新协议

站点必须保持 owner-private。云任务每日北京时间 13:15使用 Sites `get_site` 返回的本站 service access，在服务端向本站发送 `OAI-Sites-Authorization: Bearer <token>`；凭证由平台验证和消费，不提供用户身份。

1. POST `/internal/refresh`，另带 `X-Trading-Service: 1`，不带 Origin。此端点依赖 owner-private 平台访问边界，仅同步行情、计算指标和推进已由用户启动的模拟策略；不会调用 DeepSeek 或真实下单。
2. GET `/internal/status`，使用同一平台凭证，确认更新时间、每个标的状态和最新运行记录。
3. 正常或仅缺少未配置密钥时保持静默；首次失败或持续故障才通知。409 表示已有同步正在运行，稍后读状态，勿并发重试。

数据库中有五分钟同步租约，数据写入使用版本比较；API 失败保留旧数据并显示错误，不伪造新数据。美股每次最多获取100条未复权日线，排除纽约当天（可能未完成）；CSV 资产不自动刷新。UI轮询只读取缓存，后台更新由关联云任务触发。

## 回测口径

仅日线，多头、无杠杆，可模拟碎股。完成预热后，t-1 收盘信号在 t 开盘按滑点和单边手续费成交；买入持有基准使用同一起点和买入成本。期末持仓按市价估值，胜率仅包含已平仓交易，0笔成交时胜率为空。波动率/夏普用365（虚拟币）或252（美股）年化。回撤触线后在下一可用日线开盘模拟退出，跳空可能超过阈值。

模拟启动时记录最新日线时间，不追溯生成历史订单。数据缺口导致时间水位不在已保留窗口时暂停。模拟只用于研究：它根据已完成日线重建假想开盘成交，不能验证真实流动性、滑点或订单延迟。

股票源为未复权 OHLCV，不计股息、拆股、税费或停牌流动性。跨公司行动比较请导入一致复权的 OHLC。导入会替换该标的样本并切换为 CSV 离线模式。勿将短样本回测理解为实盘表现。

## 后续接入

OKX 账户 Key / Secret / Passphrase 和 DeepSeek Key / Model 通过服务端秘密配置接入。实盘执行需要另行实现交易所订单幂等、成交对账、资产精度/最小下单额、价格与余额校验、限额和紧急停机，并先通过 OKX 模拟账户测试。不得将模型返回的信号直接当作订单参数。

官方参考：[OKX API](https://www.okx.com/docs-v5/en/) · [Alpha Vantage 日线](https://www.alphavantage.co/documentation/#daily) · [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)

## 网页连接配置与最新报价

登录后进入「服务接入」，下方「密钥配置与 Schwab 账户」可填写 DeepSeek API Key、Alpaca Key ID/Secret、Schwab App Key/Secret。密钥在服务端用 AES-256-GCM 加密存入 D1，主密钥 CONFIG_ENCRYPTION_KEY 保存在 Sites secrets；配置接口只返回已配置状态，输入空白保留旧值。切勿直接轮换主密钥，否则旧配置无法解密。

最新报价独立于回测日线：OKX 使用浏览器公共 WebSocket，不再重复轮询 OKX REST 快照；美股使用 Alpaca IEX 最新买卖报价，每15秒轮询，明确标注单交易所覆盖和时间。市场休市、缺少权限或限流不会显示为实时成功。日线指标与模拟任务仍按日线处理，不用实时价替代历史收盘价。

Schwab 回调地址为 `https://zlin-trading-lab.zlin20050509.chatgpt.site/schwab/callback`。注册应用需要 Accounts and Trading Production；Market Data Production 可按需申请，本版美股报价使用 Alpaca。网页通过顶层 OAuth 授权，服务端加密保存和刷新令牌；失效后需重新授权。支持账户/持仓/近7日订单读取、普通时段DAY股票整股限价单预览与提交、撤单。单笔最多1000 USD；预览60秒过期，提交一次性领取，超时结果未知时不自动重发。

本地预览不是 Schwab 券商预检。真实提交和撤单受服务端 SCHWAB_LIVE_TRADING_ENABLED=true 开关保护，网页无法启用该开关。当前无真实凭证，尚未完成券商联调，保持关闭。自动策略仍仅模拟，不会自动调用这些实盘接口。DeepSeek仍只生成研究建议。

免费美股报价说明：[Alpaca Market Data FAQ](https://docs.alpaca.markets/us/docs/market-data-faq)。IEX不是全美综合SIP。

限流处理：日线同步会复用已有最新完整 UTC 日线，美股成功快照缓存15分钟；遇到 HTTP 429、OKX 50011 或 Alpha Vantage 配额提示时，按数据源保存冷却状态，遵守 Retry-After 并指数退避（默认1至15分钟）。冷却期间不再请求该源，保留历史数据及原更新时间，并显示可重试时间。下一次同步在冷却到期后重试。

DeepSeek 模型选择：保存 API Key 后自动调用官方 GET /models 获取该账号可用模型，使用下拉列表由用户选择并保存，不写死模型或自动选择第一项。模型列表在当前页面内存中缓存5分钟；点击重新获取可立即请求，失败时显示原因并可手动重试；已有且仍可用的选择会保留。

页面性能：配置状态使用单次查询读取存在性，仅解密模型名称；与密钥无关的页面和数据读取路由不再读取密钥。页面内存缓存非敏感配置状态60秒，模型列表独立加载与合并并发请求，保存立即更新状态且不会等待模型接口。市场状态与选中标的并行读取，状态接口的独立数据库查询并行执行。缓存不写入浏览器持久存储。

美股日线：配置 Alpaca Key/Secret 后优先从 IEX 获取最近550天内已完成日线，处理分页并按纽约交易日期统一时间戳；价格未复权，成交量仅覆盖IEX。未配置Alpaca时使用Alpha Vantage。成功切换数据源时替换样本并暂停相关模拟策略，避免混用来源；失败保留原数据及来源。

观察列表：选择标的后可点击「删除标的」。删除与停止该标的运行/暂停中的模拟策略在一个事务内完成，版本冲突会拒绝删除。历史回测、模拟成交与运行日志保留，再次添加不会恢复旧策略。
