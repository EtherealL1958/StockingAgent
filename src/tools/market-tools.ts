import { z } from "zod";
import type { MarketDataProvider } from "../providers/market-data.js";
import { analyzeDailyBars } from "../domain/analytics.js";
import { defineTool } from "./tool.js";

const ticker = z.string().regex(/^\d{6}$/, "请输入六位证券代码");
const indexCode = z.string().regex(/^\d{6}\.(SH|SZ|TI)$/i, "指数代码必须带交易所后缀");

const TICKER_PROPERTY = { type: "string", pattern: "^[0-9]{6}$", description: "六位数字证券代码，例如 600519 或 510300" } as const;
const GET_QUOTE_PARAMETERS = {
  type: "object",
  properties: { ticker: { ...TICKER_PROPERTY, description: "六位数字代码，例如 600519（贵州茅台）或 510300（沪深300ETF）；不要传 600519.SH" } },
  required: ["ticker"],
  additionalProperties: false,
} as const;
const GET_MARKET_HISTORY_PARAMETERS = {
  type: "object",
  properties: {
    ticker: { ...TICKER_PROPERTY, description: "六位股票/ETF代码，例如 600519；与 thscode 二选一" },
    thscode: { type: "string", pattern: "^[0-9]{6}[.]([Ss][Hh]|[Ss][Zz]|[Tt][Ii])$", description: "指数代码，例如 000300.SH；与 ticker 二选一" },
    from: { type: "string", description: "包含起始日，例如 2025-01-01" },
    to: { type: "string", description: "包含结束日，例如 2026-10-05" },
    includeBars: { type: "boolean", default: false, description: "是否返回最后最多 300 根日线；默认 false" },
  },
  oneOf: [{ required: ["ticker"] }, { required: ["thscode"] }],
  additionalProperties: false,
} as const;
const SCREEN_STOCKS_PARAMETERS = {
  type: "object",
  properties: {
    maxPrice: { type: "number", exclusiveMinimum: 0, description: "人民币价格上限，例如 100 表示 price <= 100" },
    limit: { type: "integer", minimum: 1, maximum: 50, default: 20, description: "最多候选数，例如 10；最大 50" },
  },
  required: ["maxPrice"],
  additionalProperties: false,
} as const;
const GET_FUNDAMENTALS_PARAMETERS = {
  type: "object",
  properties: {
    ticker: { ...TICKER_PROPERTY, description: "六位股票代码，例如 600519；不接受指数或 ETF" },
    report: { type: "string", pattern: "^[0-9]{4}-[1-4]$", description: "报告期，例如 2025-4，格式 YYYY-1 到 YYYY-4" },
  },
  required: ["ticker", "report"],
  additionalProperties: false,
} as const;

/** 面向模型的金融工具保持少量、稳定且可组合。 */
export function buildMarketTools(provider: MarketDataProvider) {
  return [
    defineTool({
      name: "get_quote",
      description: "当需要一只 A 股或 ETF 的最新价格、数据时间和板块确认时使用，例如 ticker=600519 或 ticker=510300。只接受六位数字代码，不接受带 .SH/.SZ 后缀的字符串；Provider 会按代码规则补交易所后缀并在返回的 security/quote 中给出结果；返回的是实时快照，不是历史收盘序列或买入建议。",
      input: z.object({ ticker: ticker.describe("六位数字证券代码，例如 600519（贵州茅台）或 510300（沪深300ETF）；不要传 600519.SH") }).strict(),
      modelParameters: GET_QUOTE_PARAMETERS,
      execute: async ({ ticker: code }) => ({
        requestedTicker: code,
        quote: await provider.getQuote(code),
        security: (await provider.getStockBasic(code))[0] ?? null,
      }),
    }),
    defineTool({
      name: "get_market_history",
      description: "当需要比较股票/ETF/指数的历史趋势和风险时使用，例如 ticker=600519 或 thscode=000300.SH，from=2025-01-01、to=2026-10-05。ticker 与 thscode 必须二选一；不接受模糊名称；thscode 会统一为大写并在 normalizedInstrument 返回。默认只返回全窗口的摘要指标，不返回逐根日线；includeBars=true 时最多返回最后 300 根日线，但指标仍按完整窗口计算。",
      input: z.object({
        ticker: ticker.describe("六位数字股票或 ETF 代码，例如 600519 或 510300；与 thscode 二选一").optional(),
        thscode: indexCode.describe("带交易所后缀的指数代码，例如 000001.SH、399001.SZ 或 000300.SH；与 ticker 二选一").optional(),
        from: z.string().optional().describe("包含起始日，ISO 日期，例如 2025-01-01；省略则使用 Provider 默认起始日期"),
        to: z.string().optional().describe("包含结束日，ISO 日期，例如 2026-10-05；省略则使用 Provider 默认结束日期"),
        includeBars: z.boolean().default(false).describe("是否返回逐根日线；默认 false，只返回摘要，传 true 时最多返回最后 300 根"),
      }).strict().refine(value => Boolean(value.ticker) !== Boolean(value.thscode), "ticker 与 thscode 必须二选一"),
      modelParameters: GET_MARKET_HISTORY_PARAMETERS,
      execute: async ({ ticker: code, thscode, from, to, includeBars }) => {
        const shouldIncludeBars = includeBars ?? false;
        const bars = thscode
          ? await provider.getIndexDailyBars(thscode, from, to)
          : await provider.getDailyBars(code!, from, to);
        const orderedBars = [...bars].sort((left, right) => left.date.localeCompare(right.date));
        return {
          requestedInstrument: thscode ?? code,
          normalizedInstrument: thscode ? thscode.toUpperCase() : code,
          barCount: orderedBars.length,
          ...(shouldIncludeBars ? { bars: orderedBars.slice(-300) } : {}),
          returnedBarCount: shouldIncludeBars ? Math.min(orderedBars.length, 300) : 0,
          barsIncluded: shouldIncludeBars,
          analytics: orderedBars.length > 0 ? analyzeDailyBars(orderedBars) : null,
          incomplete: orderedBars.length === 0,
        };
      },
    }),
    defineTool({
      name: "screen_stocks",
      description: "当用户提出“价格不高于某金额”的 A 股初筛时使用，例如 maxPrice=100、limit=10。只扫描 securityType=stock 的股票，不包含 ETF；停牌、缺少报价或价格高于上限的标的会被排除。返回顺序遵循 Provider 股票池顺序，最多返回 limit 只候选，不代表全市场完整排名或买入建议。",
      input: z.object({
        maxPrice: z.number().positive().describe("单股最新价上限，单位人民币，例如 100 表示 price <= 100"),
        limit: z.number().int().positive().max(50).default(20).describe("最多返回候选数，例如 10；最大 50"),
      }).strict(),
      modelParameters: SCREEN_STOCKS_PARAMETERS,
      execute: async ({ maxPrice, limit }) => {
        const requestedLimit = limit ?? 20;
        const securities = (await provider.getStockBasic()).filter(security => security.securityType === "stock");
        const matches = [];
        let scannedCount = 0;
        let suspendedExcluded = 0;
        let unavailableQuote = 0;
        let priceExcluded = 0;
        for (let offset = 0; offset < securities.length && matches.length < requestedLimit; offset += 50) {
          const page = securities.slice(offset, offset + 50);
          const quotes = await provider.getQuotes(page.map(security => security.ticker));
          const quoteByTicker = new Map(quotes.map(quote => [quote.ticker, quote]));
          for (const security of page) {
            scannedCount += 1;
            const quote = quoteByTicker.get(security.ticker);
            if (!quote) {
              unavailableQuote += 1;
            } else if (quote.isSuspended) {
              suspendedExcluded += 1;
            } else if (quote.price <= maxPrice) {
              matches.push({ security, quote });
            } else {
              priceExcluded += 1;
            }
            if (matches.length >= requestedLimit) break;
          }
        }
        return {
          maxPrice,
          requestedLimit,
          stockPoolCount: securities.length,
          scannedCount,
          hasMoreUnscanned: scannedCount < securities.length,
          excluded: { suspended: suspendedExcluded, unavailableQuote, aboveMaxPrice: priceExcluded },
          count: matches.length,
          candidates: matches,
        };
      },
    }),
    defineTool({
      name: "get_fundamentals",
      description: "当需要基本面指标时使用，例如 ticker=600519、report=2025-4。report 必须显式提供，避免从环境变量或 Provider 默认值隐式选择报告期；缺失指标保持缺失，不代表为零。它不返回完整利润表、现金流量表或估值历史。",
      input: z.object({
        ticker: ticker.describe("六位数字股票代码，例如 600519；不接受指数或 ETF"),
        report: z.string().regex(/^\d{4}-[1-4]$/).describe("报告期，例如 2025-4；格式为 YYYY-1 到 YYYY-4"),
      }).strict(),
      modelParameters: GET_FUNDAMENTALS_PARAMETERS,
      execute: async ({ ticker: code, report }) => {
        const security = (await provider.getStockBasic(code))[0] ?? null;
        if (!security) throw new Error(`未找到股票基础信息: ${code}`);
        if (security.securityType !== "stock") throw new Error(`get_fundamentals 只接受股票，${code} 的类型是 ${security.securityType}`);
        return {
          requestedTicker: code,
          requestedReport: report,
          security,
          financials: await provider.getFinancials(code, report),
        };
      },
    }),
  ];
}
