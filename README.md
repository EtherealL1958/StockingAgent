# StockingAgent

严格 TypeScript 的 A 股金融研究 Agent。它通过同花顺获取真实数据，使用确定性金融计算和风险规则，结合可解释的 Agent 编排帮助用户选股、复盘和完善策略；它是投资研究工具，不是自动实盘交易系统。

## 架构

- `src/agent`：事件驱动 Agent runtime、可替换 model、JSONL 会话存储和上下文窗口管理；工具调用输入先做 Zod 校验。
- `src/agent/resources.ts`：扫描 Skill 的 frontmatter，只把名称、用途和路径放入上下文；完整 Skill 由 Agent 通过 `read` 按需加载。
- `skills/a-share-research/SKILL.md`：研究、复盘和风险优先的专业分析规范。
- `src/cli.ts`：终端交互入口，支持行情、历史、指标分析和研究摘要。
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

```bash
npm install
npm run typecheck
npm test
npm start       # 进入交互终端
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

配置真实 LLM 后，终端会使用 Chat Completions 的 SSE 流式响应：模型文本会边生成边显示，工具调用会显示工具名和经过校验的参数，例如 `[tool:start] get_quote {"ticker":"600519"}`，工具完成后显示 `[tool:end] ... ok` 或明确的错误。若模型供应商公开发送 `reasoning_content` 或 `reasoning` 字段，终端会以 `[model-thinking]` 增量显示这些供应商提供的进度信息；供应商没有公开该字段时不会伪造“思考过程”。

## 会话与上下文

终端会自动恢复当前项目最近的 JSONL 会话。默认保存到 `.stocking/sessions/`，也可以通过 `STOCKING_SESSION_DIR` 指定目录，或通过 `STOCKING_SESSION_FILE` 指定一个会话文件。每次交互会追加用户消息、模型回复、工具调用和工具结果；重新启动后，下一次模型请求会收到此前的历史。

会话文件把静态前缀和动态历史分开记录：静态前缀包含系统提示词和工具定义，动态历史按消息顺序追加。原始历史不会因为上下文裁剪而删除；默认模型上下文预算约为 120000 个字符，超过后只在发送给模型的投影中保留最近消息，并写入明确的“历史已省略”标记。可通过 `STOCKING_CONTEXT_MAX_CHARS` 调整预算。当前实现采用线性 JSONL；后续可在同一格式上增加 Pi 风格的 `/new`、分支和 LLM 摘要压缩。

LLM 启动时只看到 Skill 的名称、用途和文件路径。模型需要完整研究规范时，会先调用 `read` 读取 `skills/a-share-research/SKILL.md`，这与 pi agent 的渐进式 Skill 加载方式一致。工具结果由代码计算，模型只负责编排和解释。未配置 `LLM_KEY` 时，终端会明确使用规则模型，不能完成开放式自然语言研究。

## Agent 工具

通用工具遵循 pi agent 的最小工具思路：

| 工具 | 用途 |
| --- | --- |
| `read` | 按需分页读取项目内 UTF-8 文本、财报和 Skill 文件；不读取 PDF、图片或 `.env` |
| `write` | 按 UTF-8 原样写入研究总结、复盘记录和策略草稿；默认不覆盖已有文件 |
| `web_search` | 搜索公告、新闻和行业资料；默认使用 Tavily，可通过 `WEB_SEARCH_PROVIDER=brave` 切换，返回请求和来源元数据 |
| `code_exec` | 在 30 秒和约 32KB 输出限制内执行 JavaScript/Python 辅助计算，不执行 shell |

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

终端不提供斜杠指令。输入 `exit` 或 `quit` 结束会话；每次研究输出包含数据源、时间窗口和“非投资建议”说明。

默认规则模型不猜测缺失数据。接入 LLM 时实现 `AgentModel` 即可，LLM 只负责决定需要哪些工具和解释结果，不能替代财务计算或绕过风险规则。
