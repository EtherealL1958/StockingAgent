import test from "node:test";
import assert from "node:assert/strict";
import { ResearchAgent } from "../src/agent/runtime.js";
import { RuleBasedResearchModel } from "../src/agent/rule-model.js";
import { optimizePortfolio } from "../src/domain/portfolio.js";
import type { Quote, Security } from "../src/domain/types.js";
import { MockMarketDataProvider } from "../src/providers/market-data.js";
import { marketTools } from "../src/tools/market-tools.js";

const security: Security = {
  ticker: "510300",
  name: "沪深300ETF",
  securityType: "etf",
  board: "etf",
  sector: "broad",
  lotSize: 100,
  isIndex: true,
};
const quote: Quote = {
  ticker: "510300",
  price: 4.2,
  asOf: "2026-10-03",
  source: "fixture",
  isSuspended: false,
};

test("agent executes a narrow tool and emits a usable answer", async () => {
  const provider = new MockMarketDataProvider(
    [security],
    new Map([[security.ticker, quote]]),
    new Map(),
  );
  const agent = new ResearchAgent(
    marketTools(provider),
    new RuleBasedResearchModel(),
  );
  const events: string[] = [];
  agent.on(event => events.push(event.type));

  const result = await agent.run("研究 510300");

  assert.match(result.answer, /报价/);
  assert.deepEqual(events, [
    "agent_start",
    "turn_start",
    "tool_start",
    "tool_end",
    "turn_start",
    "agent_end",
  ]);
});

test("optimizer rejects an unaffordable stock", () => {
  const plan = optimizePortfolio(
    {
      investableCash: 5000,
      monthlyContribution: 0,
      horizonYears: 3,
      riskLevel: "low",
      maxDrawdown: 0.1,
      emergencyCashRequired: 0,
    },
    [{
      security: {
        ...security,
        ticker: "600000",
        name: "高价股",
        securityType: "stock",
        board: "sh_main",
      },
      quote: { ...quote, ticker: "600000", price: 60 },
      metrics: {},
    }],
  );

  assert.equal(plan.status, "NO_TRADE");
});

test("HiThink provider validates and normalizes snapshot responses", async () => {
  const { HiThinkMarketDataProvider } = await import("../src/providers/hithink-market-data.js");
  const provider = new HiThinkMarketDataProvider({
    apiKey: "test-key",
    fetchFn: async () => new Response(JSON.stringify({
      code: 0,
      message: "success",
      request_id: "request-1",
      data: {
        timestamp: 1735689600000,
        total: 1,
        item: [{
          thscode: "600519.SH",
          ticker: "600519",
          last_price: 1200,
          open_price: 1190,
          high_price: 1210,
          low_price: 1180,
          prev_price: 1185,
          volume: 100,
          turnover: 120000,
        }],
      },
    }), { status: 200 }),
  });

  const quote = await provider.getQuote("600519");
  assert.equal(quote.ticker, "600519");
  assert.equal(quote.price, 1200);
  assert.equal(quote.source, "hithink-finance");
});

test("HiThink provider exposes business errors instead of treating them as data", async () => {
  const { HiThinkApiError, HiThinkMarketDataProvider } = await import("../src/providers/hithink-market-data.js");
  const provider = new HiThinkMarketDataProvider({
    apiKey: "test-key",
    fetchFn: async () => new Response(JSON.stringify({
      code: 1001,
      message: "missing parameter",
      request_id: "request-2",
      data: null,
    }), { status: 200 }),
  });

  await assert.rejects(
    () => provider.getQuote("600519"),
    (error: unknown) => error instanceof HiThinkApiError && error.code === 1001 && error.requestId === "request-2",
  );
});

test("price analytics calculate period return, moving averages and drawdown", async () => {
  const { analyzeDailyBars, maximumDrawdown, movingAverage } = await import("../src/domain/analytics.js");
  const bars = Array.from({ length: 120 }, (_, index) => ({
    ticker: "600519",
    date: `2025-${String(Math.floor(index / 30) + 1).padStart(2, "0")}-${String((index % 30) + 1).padStart(2, "0")}`,
    open: 100 + index,
    high: 100 + index,
    low: 100 + index,
    close: 100 + index,
    volume: 1000,
  }));
  const analytics = analyzeDailyBars(bars);
  assert.equal(analytics.observationCount, 120);
  assert.equal(analytics.movingAverages[20], movingAverage(bars.map(bar => bar.close), 20));
  assert.equal(analytics.maxDrawdown, 0);
  assert.equal(maximumDrawdown([100, 120, 90, 110]), 0.25);
});

test("A-share transaction costs distinguish buy and sell fees", async () => {
  const { calculateTransactionCost, calculateAffordableQuantity } = await import("../src/domain/risk-controls.js");
  const buy = calculateTransactionCost(10000, "buy");
  const sell = calculateTransactionCost(10000, "sell");
  assert.equal(buy.stampDuty, 0);
  assert.ok(sell.total > buy.total);
  assert.equal(calculateAffordableQuantity(5000, 60, 100), 0);
  assert.equal(calculateAffordableQuantity(5000, 4.2, 100), 1100);
});

test("portfolio risk reports hard concentration violations", async () => {
  const { evaluatePortfolioRisk } = await import("../src/domain/risk-controls.js");
  const violations = evaluatePortfolioRisk(500, [
    { ticker: "600000", marketValue: 8000, sector: "bank", securityType: "stock" },
    { ticker: "601000", marketValue: 1000, sector: "bank", securityType: "stock" },
  ], { maxSingleStockWeight: 0.15, maxIndustryWeight: 0.30, minimumCashReserve: 0.10 });
  assert.ok(violations.some(violation => violation.rule === "cash_reserve"));
  assert.ok(violations.some(violation => violation.rule === "single_stock"));
  assert.ok(violations.some(violation => violation.rule === "industry"));
});

test("A-share order rules reject suspension, odd lots and price-limit violations", async () => {
  const { validateAShareOrder } = await import("../src/domain/risk-controls.js");
  const violations = validateAShareOrder({
    side: "buy",
    board: "sh_main",
    isST: false,
    referenceClose: 10,
    orderPrice: 11.5,
    quantity: 101,
    lotSize: 100,
    isSuspended: true,
  });
  assert.deepEqual(violations.map(violation => violation.rule), ["suspension", "lot_size", "price_limit"]);
});

test("score keeps incomplete financial data incomplete", async () => {
  const { scoreSecurity } = await import("../src/domain/scoring.js");
  const score = scoreSecurity({});
  assert.equal(score.total, undefined);
  assert.equal(score.completeness, 0);
});
