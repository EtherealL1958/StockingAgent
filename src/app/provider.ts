import type { Quote, Security } from "../domain/types.js";
import { HiThinkMarketDataProvider } from "../providers/hithink-market-data.js";
import { MockMarketDataProvider } from "../providers/market-data.js";

/** 根据环境配置选择真实 Provider 或明确的本地演示 Provider。 */
export function createMarketDataProvider() {
  const apiKey = process.env.HITHINK_FINANCE_API_KEY;
  if (apiKey) {
    console.log("使用同花顺真实数据 Provider");
    return new HiThinkMarketDataProvider({
      apiKey,
      ...(process.env.HITHINK_FINANCE_BASE_URL
        ? { baseUrl: process.env.HITHINK_FINANCE_BASE_URL }
        : {}),
    });
  }

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
