import { ResearchAgent } from "./agent/runtime.js";
import { RuleBasedResearchModel } from "./agent/rule-model.js";
import type { Quote, Security } from "./domain/types.js";
import { HiThinkMarketDataProvider } from "./providers/hithink-market-data.js";
import { MockMarketDataProvider } from "./providers/market-data.js";
import { marketTools } from "./tools/market-tools.js";

function createProvider() {
  const apiKey = process.env.HITHINK_FINANCE_API_KEY;
  if (apiKey) {
    console.log("使用同花顺真实数据 Provider");
    const options = {
      apiKey,
      ...(process.env.HITHINK_FINANCE_BASE_URL
        ? { baseUrl: process.env.HITHINK_FINANCE_BASE_URL }
        : {}),
      ...(process.env.HITHINK_FINANCE_REPORT
        ? { financialReport: process.env.HITHINK_FINANCE_REPORT }
        : {}),
    };
    return new HiThinkMarketDataProvider(options);
  }

  // 没有 API Key 时明确进入演示模式，不把固定数据伪装成真实行情。
  console.log("未配置 HITHINK_FINANCE_API_KEY，使用固定演示数据");
  const demoSecurity: Security = {
    ticker: "510300",
    name: "沪深300ETF",
    securityType: "etf",
    board: "etf",
    sector: "broad",
    lotSize: 100,
    isIndex: true,
  };
  const demoQuote: Quote = {
    ticker: "510300",
    price: 4.2,
    asOf: "2026-10-03",
    source: "demo-fixture",
    isSuspended: false,
  };
  return new MockMarketDataProvider(
    [demoSecurity],
    new Map([[demoSecurity.ticker, demoQuote]]),
    new Map(),
  );
}

const agent = new ResearchAgent(
  marketTools(createProvider()),
  new RuleBasedResearchModel(),
);
agent.on(event => {
  if (event.type === "tool_start" || event.type === "tool_end") {
    console.log(`[${event.type}] ${event.toolName}`);
  }
});

const result = await agent.run("请研究 510300 的最新报价");
console.log(result.answer);
