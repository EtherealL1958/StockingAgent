import { z } from "zod";
import type { MarketDataProvider } from "../providers/market-data.js";
import { analyzeDailyBars } from "../domain/analytics.js";
import { defineTool } from "./tool.js";

const tickerInput = z.object({ ticker: z.string().regex(/^\d{6}$/) });

export function marketTools(provider: MarketDataProvider) {
  return [
    defineTool({
      name: "get_quote",
      description: "读取单个证券最新报价及数据日期",
      input: tickerInput,
      execute: ({ ticker }) => provider.getQuote(ticker),
    }),
    defineTool({
      name: "get_daily_bars",
      description: "读取单个证券日线历史",
      input: tickerInput.extend({
        from: z.string().optional(),
        to: z.string().optional(),
      }),
      execute: ({ ticker, from, to }) => provider.getDailyBars(ticker, from, to),
    }),
    defineTool({
      name: "calculate_indicators",
      description: "从日线数据确定性计算收益、均线、波动率、回撤、成交量和 RSI",
      input: tickerInput.extend({
        from: z.string().optional(),
        to: z.string().optional(),
      }),
      execute: async ({ ticker, from, to }) => {
        const bars = await provider.getDailyBars(ticker, from, to);
        return analyzeDailyBars(bars);
      },
    }),
    defineTool({
      name: "get_financials",
      description: "读取已标准化的财务指标，缺失值保持缺失",
      input: tickerInput.extend({ report: z.string().regex(/^\d{4}-[1-4]$/).optional() }),
      execute: ({ ticker, report }) => provider.getFinancials(ticker, report),
    }),
    defineTool({
      name: "get_stock_basic",
      description: "读取证券基础信息",
      input: z.object({ ticker: z.string().regex(/^\d{6}$/).optional() }),
      execute: ({ ticker }) => provider.getStockBasic(ticker),
    }),
  ];
}
