# StockingAgent

严格 TypeScript 的 A 股研究 Agent，采用类似 Pi 的最小 agent loop：`user -> model -> narrow tool -> tool result -> model`。它是投资研究工具，不是自动实盘交易系统。

## 架构

- `src/agent`：事件驱动 Agent runtime、可替换 model；工具调用输入先做 Zod 校验。
- `src/tools`：窄工具（报价、日线、财务、证券基础信息、确定性指标计算）。
- `src/providers`：`MarketDataProvider` 统一数据边界。
  - `MockMarketDataProvider`：固定 fixture，只用于测试和无密钥演示。
  - `HiThinkMarketDataProvider`：同花顺 REST API 适配器，负责认证、响应校验、字段归一化和业务错误转换。
- `src/domain`：区间收益、MA20/60/120、年化波动率、最大回撤、RSI14、成交量、评分、组合整数手优化、交易成本、现金储备、个股/行业集中度、停牌、整手和涨跌停硬约束，全部由 TypeScript 确定性计算。

同花顺适配依据 `HiThink-Tech/Financial-API` 的 REST 契约：使用 `X-api-key`，接口统一返回 `code/message/request_id/data`。行情、历史 K 线、财务指标和标的检索均在 Provider 边界内解析。

## 运行

```bash
npm install
npm run typecheck
npm test
npm start
```

配置真实同花顺数据时，把 [`.env.example`](./.env.example) 复制为 `.env`，然后在运行进程中导出变量。项目不自动读取 `.env` 文件，因此不会引入额外 dotenv 依赖：

```bash
export HITHINK_FINANCE_API_KEY="your-api-key"
export HITHINK_FINANCE_BASE_URL="https://fuyao.aicubes.cn"
export HITHINK_FINANCE_REPORT="2025-4"
npm start
```

设置 `HITHINK_FINANCE_API_KEY` 后，程序会明确打印“使用同花顺真实数据 Provider”；未设置时会明确进入固定演示模式。两种模式不会静默互相降级。

`HITHINK_FINANCE_REPORT` 用于财务指标查询，格式为 `yyyy-1`、`yyyy-2`、`yyyy-3` 或 `yyyy-4`。报价和历史 K 线不依赖该变量。

默认规则模型不猜测缺失数据。接入 LLM 时实现 `AgentModel` 即可，LLM 只负责决定需要哪些工具和解释结果，不能替代财务计算或绕过风险规则。
