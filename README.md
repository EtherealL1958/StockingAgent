# StockingAgent

严格 TypeScript 的 A 股金融研究 Agent。它通过同花顺获取真实数据，使用确定性金融计算和风险规则，结合可解释的 Agent 编排帮助用户选股、复盘和完善策略；它是投资研究工具，不是自动实盘交易系统。

## 架构

- `src/agent`：事件驱动 Agent runtime、可替换 model、JSONL 会话存储和上下文窗口管理；工具调用输入先做 Zod 校验。
- `src/memory/user-profile.ts`：独立于会话历史的持久化用户画像，保存已确认的资金、期限、风险和投资偏好。
- `src/agent/resources.ts`：扫描 Skill 的 frontmatter，只把名称、用途和路径放入上下文；完整 Skill 由 Agent 通过 `read` 按需加载。
- `skills/`：面向个人投资者的渐进式专业 Skill。`a-share-research` 负责总路由；`a-share-market-data`、`a-share-technical-analysis`、`a-share-earnings-analysis`、`a-share-comparables`、`a-share-sector-overview`、`a-share-thesis-tracker` 和 `a-share-catalyst-calendar` 分别负责数据质量、行情指标、财报、同行比较、行业、投资逻辑和事件日历。
- `src/cli.ts`：终端交互入口，支持行情、历史、指标分析和研究摘要。
- `src/ui`：独立 TUI 展示层，只订阅 Agent 事件，负责会话卡片、多行输入与状态栏，不参与工具执行和金融计算。
- `src/tools`：通用工具（`read`、`write`、`web_search`、`code_exec`）和四个金融工具（`get_quote`、`get_market_history`、`get_fundamentals`、`screen_stocks`）。
- `src/providers`：`MarketDataProvider` 统一数据边界。
  - `MockMarketDataProvider`：固定 fixture，只用于测试和无密钥演示。
  - `HiThinkMarketDataProvider`：同花顺 REST API 适配器，负责认证、响应校验、字段归一化和业务错误转换。
- `src/domain`：区间收益、MA20/60/120、年化波动率、最大回撤、RSI14、成交量、评分、组合整数手优化、交易成本、现金储备、个股/行业集中度、停牌、整手和涨跌停硬约束，全部由 TypeScript 确定性计算。

### 命名约定

- 文件和目录使用 `kebab-case`，例如 `chat-completions-model.ts`、`risk-controls.ts`。
- 类、接口、类型和枚举使用 `PascalCase`，例如 `ChatCompletionsResearchModel`、`MarketDataProvider`。
- 函数、方法和局部变量使用 `camelCase`；返回集合的构造函数使用 `build...` 或 `create...`，例如 `buildChatCompletionsToolDefinitions`、`createMarketDataProvider`。
- 常量使用 `SCREAMING_SNAKE_CASE`；JSON/HTTP 字段和 Agent 对外工具名保留协议约定，例如 `tool_calls`、`get_market_history`。

同花顺适配依据 `HiThink-Tech/Financial-API` 的 REST 契约：使用 `X-api-key`，接口统一返回 `code/message/request_id/data`。行情、历史 K 线、财务指标和标的检索均在 Provider 边界内解析。

## 运行

需要 Node.js **22.19.0 或更高版本**。

```bash
npm install
npm run typecheck
npm test
npm start       # 进入交互终端
npm start -- --plain # 使用纯文本终端；管道和非 TTY 环境自动使用此模式
npm run demo    # 执行一次 Agent 工具调用演示
```

配置真实同花顺数据时，把 [`.env.example`](./.env.example) 复制为 `.env` 并填写 API Key。程序启动时会自动读取项目根目录的 `.env` 文件；已有 shell 环境变量优先于 `.env` 中的同名变量。

```bash
cp .env.example .env
# 编辑 .env，填写 HITHINK_FINANCE_API_KEY
npm start
```

设置 `HITHINK_FINANCE_API_KEY` 后，程序会明确打印“使用同花顺真实数据 Provider”；未设置时会明确进入固定演示模式。两种模式不会静默互相降级。

财务指标工具要求在调用时显式提供报告期，例如 `report=2025-4`；报价和历史 K 线不需要报告期。

配置 `LLM_KEY` 后，终端会启用真实 LLM 工具调用：

```env
LLM_KEY=your-key
LLM_MODEL=deepseek-chat
LLM_API=https://api.deepseek.com
```

网页搜索默认使用 Tavily：

```env
WEB_SEARCH_PROVIDER=tavily
TAVILY_API_KEY=tvly-your-key
TAVILY_API=https://api.tavily.com/search
```

如需切换到 Brave-compatible 服务：

```env
WEB_SEARCH_PROVIDER=brave
BRAVE_SEARCH_API_KEY=your-key
BRAVE_SEARCH_API=https://api.search.brave.com/res/v1/web/search
```

进入终端后可以直接输入自然语言，例如：

```text
帮我分析截至 2026 年 10 月的总体股票走势
比较上证指数、深证成指和沪深 300 最近一年的趋势与风险
复盘 600519 最近一年的表现，并说明原有投资逻辑可能在哪些情况下失效
```

交互终端默认使用 TUI：顶部为应用标题，中间为可滚动会话区，底部固定多行输入框和状态栏。用户消息、模型公开推理、调用工具前的过程说明、工具执行与最终回答分别渲染；回答支持 Markdown 表格和代码块。工具卡片显示参数、完成/失败状态与执行耗时，可展开结果。状态栏显示模型名、思考强度配置、当前阶段、本次请求的执行时间、模型回合数、工具次数与会话编号。

`LLM_REASONING_EFFORT` 可选 `low`、`medium`、`high`，设置后原样发送为 Chat Completions 的 `reasoning_effort`；仅适用于支持该参数的 API。状态栏将其标为“请求值”，未配置时显示“供应商默认”，规则模型显示“不适用”。不会从模型名或公开推理文本猜测强度，也不会静默降级不受支持的参数。

模型通过 SSE 流式更新各卡片。思考区只展示供应商公开返回的 `reasoning_content` 或 `reasoning`；没有该字段时不伪造推理。当前 JSONL 不保存这些增量推理，恢复会话时仅还原已持久化的用户消息、模型文本和工具调用/结果。显示折叠和工具结果预览不修改会话或模型上下文。纯文本模式保留 `[model-thinking]`、`[tool:start]` 与 `[tool:end]` 日志。

TUI 复用 pi 的独立组件库 [`@earendil-works/pi-tui`](https://github.com/earendil-works/pi/tree/main/packages/tui)，参考其 [`assistant-message.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/interactive/components/assistant-message.ts)、[`tool-execution.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/interactive/components/tool-execution.ts) 和 [`footer.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/interactive/components/footer.ts) 的职责划分；Claude Code 部分参考官方[状态栏](https://code.claude.com/docs/en/statusline)与[交互模式](https://code.claude.com/docs/en/interactive-mode)文档，其公开仓库不包含完整 TUI 渲染器源码。项目保留自己的 Agent runtime，不引入完整 Agent 框架。

## 会话与上下文

终端会自动恢复当前项目最近的 JSONL 会话。默认保存到 `.stocking/sessions/`，也可以通过 `STOCKING_SESSION_DIR` 指定目录，或通过 `STOCKING_SESSION_FILE` 指定一个会话文件。每次交互会追加用户消息、模型回复、工具调用和工具结果；重新启动后，下一次模型请求会收到此前的历史。

会话文件把静态前缀和动态历史分开记录：静态前缀包含系统提示词和工具定义，动态历史按消息顺序追加。原始历史不会因为上下文裁剪而删除；发送给模型的历史预算按 `contextWindow - reserveTokens` 计算，并优先保留 `keepRecentTokens` 个最近 token。`contextWindow` 由模型配置提供，终端可用 `LLM_CONTEXT_WINDOW`、`LLM_RESERVE_TOKENS` 和 `LLM_KEEP_RECENT_TOKENS` 配置；不再使用固定的字符上限。当前实现采用轻量 token 估算，后续可在同一接口接入供应商 tokenizer。

上下文管理采用分层策略：

1. 单条工具结果超过预算时，在写入会话前将完整 JSON 归档到会话目录的 `context-archives/`，消息中冻结归档路径和预览，后续请求只发送预览。
2. 历史裁剪时删除较早历史中的重复工具结果，并生成按轮次组织的结构化摘要，保留用户任务、工具调用、结果预览和模型回复。
3. 如果最近消息本身仍然超过 `contextWindow - reserveTokens`，且模型实现了 `summarizeContext`，才调用 LLM 做全量压缩；压缩失败连续三次后熔断，后续请求继续使用确定性的摘要和滑窗结果。

当前使用 OpenAI-compatible Chat Completions，未假设供应商支持 Claude Code 风格的远程上下文编辑；如果未来接入该能力，可以在本地历史不变的前提下增加远程前缀清理适配器。压缩摘要必须保留证券代码、报告期、数据源、日期、数字、用户约束、工具错误和投资逻辑失效条件，不以压缩结果替代可审计的会话原文。

用户画像单独保存到 `.stocking/user-profile.json`，可通过 `STOCKING_PROFILE_FILE` 指定路径。画像不是对话历史，也不是当前持仓；它只保存用户明确提供或确认的长期信息。制定个性化计划、组合配置或再平衡前，Agent 会先读取画像，缺少可投资资金、每月投入、投资期限、风险承受能力、最大回撤或应急现金时先向用户询问。运行时在每个模型回合前注入已确认画像（不完整时注入缺失项），完整后才提供规划所需的 `InvestorProfile`。

文件产物遵循单任务交付规则：一次研究请求默认生成一个主报告，后续补充内容更新原文件；只有用户明确要求另存为、单独清单，或交付物确实独立时才新建文件。Agent 无法判断更新还是新建时，会先询问用户。

LLM 启动时只看到 Skill 的名称、用途和文件路径。模型需要完整研究规范时，会先调用 `read` 读取 `skills/a-share-research/SKILL.md`，这与 pi agent 的渐进式 Skill 加载方式一致。工具结果由代码计算，模型只负责编排和解释。未配置 `LLM_KEY` 时，终端会明确使用规则模型，不能完成开放式自然语言研究。

总 Skill 会根据任务提示具体的专业 Skill 路径。例如，分析历史走势时读取 `a-share-technical-analysis`，查询年报时读取 `a-share-earnings-analysis`，比较行业候选时读取 `a-share-comparables` 和 `a-share-sector-overview`。这些文件只规定分析流程、证据和边界，不把计算逻辑移入提示词；实际指标、费用、仓位和风险约束仍由 TypeScript domain 与金融工具执行。

画像更新不再信任模型传入的 `confirmed=true`。模型调用 `update_user_profile` 时传入 `changes` 和 `evidence`，例如 `changes={monthlyContribution:200}`、`evidence={monthlyContribution:"每月200元"}`；引用必须来自实际用户消息。系统直接展示字段、值和原话，然后结束本轮等待用户输入。用户可回复 `确认画像 <编号> 全部`，或 `确认画像 <编号> 1,3` 仅确认指定字段；回复 `取消画像 <编号>` 放弃候选。更正或清除（`null`）也走同一路径。候选不参与规划，模型无法通过工具参数代用户确认。

旧版本画像没有逐字段确认记录，其原值保留在磁盘中，但列为待核实，不作为用户事实注入模型。重新确认后保存原话、确认回复、时间和候选编号。特别禁止把“闲钱”推断为应急现金为零，把推荐的 ETF 当作用户偏好，或把“大学生/尝试投资”推断为已确认的经验与投资目标。

## Agent 工具

通用工具遵循 pi agent 的最小工具思路：

| 工具 | 用途 |
| --- | --- |
| `read` | 按需分页读取项目内 UTF-8 文本、财报和 Skill 文件；不读取 PDF、图片或 `.env` |
| `write` | 按 UTF-8 原样写入研究总结、复盘记录和策略草稿；默认不覆盖已有文件 |
| `web_search` | 搜索公告、新闻和行业资料；默认使用 Tavily，可通过 `WEB_SEARCH_PROVIDER=brave` 切换，返回请求和来源元数据 |
| `code_exec` | 在 30 秒和约 32KB 输出限制内执行 JavaScript/Python 辅助计算，不执行 shell |

用户记忆工具：

| 工具 | 用途 |
| --- | --- |
| `get_user_profile` | 制定个性化投资计划、组合配置或风险解释前读取已确认画像和缺失字段 |
| `update_user_profile` | 提交含逐字段原话证据的候选变更，用户选择确认后才写入已确认画像；不接受 `confirmed` |

金融工具按研究任务聚合 API，避免把 Provider 细节暴露给模型：

| 工具 | 用途 |
| --- | --- |
| `get_quote` | 行情快照和证券基础信息 |
| `get_market_history` | 股票、ETF 或指数的摘要指标；需要逐根日线时显式设置 `includeBars` |
| `get_fundamentals` | 基础信息和标准化财务指标，必须显式提供报告期，例如 `2025-4` |
| `screen_stocks` | 按价格筛选真实股票候选集 |

`code_exec` 只用于辅助整理和验证；收益、波动率、回撤、均线、RSI 等金融计算优先使用 `get_market_history` 或 domain 代码。网页搜索结果必须保留来源和日期，不能直接替代行情数据。

工具描述会同时说明适用场景、输入示例和拒绝条件。所有默认值、分页、截断、代码归一化和筛选排除都会出现在工具返回的元数据中；例如 `get_market_history` 返回 `requestedInstrument`、`normalizedInstrument`、`barCount` 和 `returnedBarCount`，`screen_stocks` 返回扫描与排除统计。`web_search` 通过 `WebSearchProvider` 统一输入输出，Tavily 会把 `searchLang=zh-hans` 映射为官方接口的 `language=zh-cn`，实际映射记录在 `diagnostics.providerRequest` 中。

## 终端对话

启动 `npm start` 后直接输入自然语言，模型会自行决定是否调用工具：

```text
查询 600519 的最新行情
分析 600519 从 2025-01-01 到 2026-10-05 的趋势、波动率和最大回撤
读取 600519 的 2025-4 财务指标，并结合行情说明风险
筛选最新价格不高于 100 元的 A 股股票
```

TUI 快捷键与本地指令：

| 操作 | 按键/指令 |
| --- | --- |
| 发送 / 换行 | Enter / Shift+Enter 或 Ctrl+J |
| 输入历史 | ↑ / ↓ |
| 折叠公开推理 / 展开工具结果 | Ctrl+T / Ctrl+O |
| 浏览会话 / 回到最新 | PageUp、PageDown、鼠标滚轮 / Ctrl+End |
| 帮助 / 模型与会话状态 | `/help` / `/status` |
| 退出 | `/exit`、`exit`、`quit`、Ctrl+C，或空输入时 Ctrl+D |

执行中可以编辑下一条草稿，但不能并发提交；Ctrl+C 请求在本轮结束并保存会话后退出。模型或工具失败会单独显示，输入框恢复可用。上述斜杠指令仅影响 TUI，不发送给 LLM；纯文本模式仍支持 `exit` 和 `quit`。

默认规则模型不猜测缺失数据。接入 LLM 时实现 `AgentModel` 即可，LLM 只负责决定需要哪些工具和解释结果，不能替代财务计算或绕过风险规则。
