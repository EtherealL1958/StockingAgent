import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { ResearchAgent } from "../src/agent/runtime.js";
import { SlidingWindowContextManager } from "../src/agent/context.js";
import { RuleBasedResearchModel } from "../src/agent/rule-model.js";
import { ChatCompletionsResearchModel } from "../src/agent/chat-completions-model.js";
import { JsonlSessionStore } from "../src/agent/session.js";
import { optimizePortfolio } from "../src/domain/portfolio.js";
import type { Quote, Security } from "../src/domain/types.js";
import { MockMarketDataProvider } from "../src/providers/market-data.js";
import { buildMarketTools } from "../src/tools/market-tools.js";
import { TavilyWebSearchProvider, type WebSearchInput } from "../src/providers/web-search.js";
import { defineTool } from "../src/tools/tool.js";
import { JsonUserProfileStore } from "../src/memory/user-profile.js";
import { buildUserMemoryTools } from "../src/tools/user-memory-tools.js";

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
    buildMarketTools(provider),
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

test("agent returns provider failures as explicit incomplete evidence", async () => {
  let sawError = false;
  const failingTool = defineTool({
    name: "failing_provider",
    description: "测试工具",
    input: z.object({}),
    execute: async () => {
      throw new Error("Data source unavailable");
    },
  });
  const agent = new ResearchAgent([failingTool], {
    respond: async messages => {
      const last = messages.at(-1);
      if (last?.role === "user") return { done: false, toolCall: { id: "call-1", name: "failing_provider", input: {} } };
      if (last?.role === "tool") {
        const result = JSON.parse(last.content) as { available?: boolean; error?: { message?: string } };
        sawError = result.available === false && result.error?.message === "Data source unavailable";
        return { done: true, content: sawError ? "财务数据不可用，分析不完整" : "错误未被保留" };
      }
      return { done: true, content: "未收到工具结果" };
    },
  });
  const result = await agent.run("查询财务数据");
  assert.equal(sawError, true);
  assert.match(result.answer, /数据不可用/);
});

test("agent leaves a final synthesis turn after repeated tool calls", async () => {
  const tool = defineTool({
    name: "step",
    description: "测试步骤工具",
    input: z.object({ step: z.number().int().positive() }),
    execute: async ({ step }) => ({ step, available: true }),
  });
  const agent = new ResearchAgent([tool], {
    respond: async messages => {
      const toolCalls = messages.filter(message => message.role === "tool").length;
      if (toolCalls < 8) {
        return { done: false, toolCall: { id: `call-${toolCalls + 1}`, name: "step", input: { step: toolCalls + 1 } } };
      }
      return { done: true, content: "已完成多步研究并生成总结" };
    },
  });

  const result = await agent.run("执行多步研究");
  assert.match(result.answer, /生成总结/);
});

test("agent preserves and executes multiple model tool calls", async () => {
  const calls: string[] = [];
  const firstTool = defineTool({
    name: "first",
    description: "测试第一个工具",
    input: z.object({ value: z.number() }),
    execute: async ({ value }) => {
      calls.push("first");
      return { value };
    },
  });
  const secondTool = defineTool({
    name: "second",
    description: "测试第二个工具",
    input: z.object({ value: z.number() }),
    execute: async ({ value }) => {
      calls.push("second");
      return { value: value * 2 };
    },
  });
  let sawBothResults = false;
  const agent = new ResearchAgent([firstTool, secondTool], {
    respond: async messages => {
      const assistant = messages.find(message => message.role === "assistant" && message.toolCalls);
      if (assistant?.toolCalls?.length === 2) {
        sawBothResults = messages.filter(message => message.role === "tool").length === 2;
        return { done: true, content: "两个工具均已执行" };
      }
      return {
        done: false,
        toolCalls: [
          { id: "call-first", name: "first", input: { value: 2 } },
          { id: "call-second", name: "second", input: { value: 3 } },
        ],
      };
    },
  });

  const result = await agent.run("同时执行两个计算");
  assert.match(result.answer, /两个工具/);
  assert.deepEqual(calls, ["first", "second"]);
  assert.equal(sawBothResults, true);
});

test("invalid tool input is returned as concise actionable validation feedback", async () => {
  let validationMessage = "";
  const tool = defineTool({
    name: "strict_tool",
    description: "测试严格参数",
    input: z.object({ language: z.enum(["javascript", "python"]), code: z.string().min(1) }),
    execute: async () => ({ available: true }),
  });
  const agent = new ResearchAgent([tool], {
    respond: async messages => {
      const last = messages.at(-1);
      if (last?.role === "user") {
        return { done: false, toolCall: { id: "call-invalid", name: "strict_tool", input: { language: "javascript>\\nconsole.log(1)" } } };
      }
      if (last?.role === "tool") {
        const payload = JSON.parse(last.content) as { error?: { message?: string } };
        validationMessage = payload.error?.message ?? "";
      }
      return { done: true, content: "已收到参数错误" };
    },
  });

  const result = await agent.run("测试错误参数");
  assert.match(result.answer, /参数错误/);
  assert.match(validationMessage, /language:/);
  assert.match(validationMessage, /code:/);
  assert.doesNotMatch(validationMessage, /received\":/);
});

test("JSONL session restores static context and dynamic message history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stocking-session-"));
  const staticContext = {
    systemPrompt: "风险优先研究 Agent",
    toolDefinitions: [{ name: "get_quote", description: "获取报价", parameters: { type: "object" } }],
  };
  try {
    const first = await JsonlSessionStore.open({ cwd: directory, directory, staticContext });
    await first.append({ role: "user", content: "分析 600519" });
    await first.append({ role: "assistant", content: "我会先读取行情。", toolName: "get_quote", toolInput: { ticker: "600519" }, toolCallId: "call-1" });
    await first.append({ role: "tool", content: JSON.stringify({ quote: { price: 1200 } }), toolName: "get_quote", toolInput: { ticker: "600519" }, toolCallId: "call-1" });

    const resumed = await JsonlSessionStore.open({ cwd: directory, directory, staticContext });
    assert.equal(resumed.id, first.id);
    assert.deepEqual(resumed.staticContext, staticContext);
    assert.equal(resumed.history.length, 3);
    assert.equal(resumed.history[2]?.toolCallId, "call-1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("agent sends restored history while keeping the full session persisted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stocking-agent-session-"));
  const staticContext = { systemPrompt: "测试", toolDefinitions: [] };
  try {
    const session = await JsonlSessionStore.open({ cwd: directory, directory, staticContext });
    await session.append({ role: "user", content: "之前的问题" });
    await session.append({ role: "assistant", content: "之前的结论" });
    let seenMessages = 0;
    const agent = new ResearchAgent([], {
      respond: async messages => {
        seenMessages = messages.length;
        return { done: true, content: "已结合历史回答" };
      },
    }, { session });

    const result = await agent.run("继续分析");
    assert.match(result.answer, /结合历史/);
    assert.equal(seenMessages, 3);
    assert.equal(session.history.length, 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("user profile memory requires confirmation, persists, and is injected into later model turns", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stocking-user-profile-"));
  try {
    const store = await JsonUserProfileStore.open({ cwd: directory, filePath: join(directory, "profile.json"), userId: "user-1" });
    const tools = buildUserMemoryTools(store);
    assert.deepEqual(tools.map(tool => tool.name), ["get_user_profile", "update_user_profile"]);
    assert.equal(store.toInvestorProfile(), undefined);
    assert.ok(store.missingFields.length >= 6);

    const beforeConfirmation = store.snapshot;
    assert.equal(beforeConfirmation.investableCash, undefined);

    const patch = {
      investableCash: 10_000,
      monthlyContribution: 500,
      horizonYears: 5,
      riskLevel: "low",
      maxDrawdown: 0.1,
      emergencyCashRequired: 20_000,
      investmentGoal: "steady_growth",
    };
    const source = "可投资10000元，每月500元，5年，低风险，回撤10%，应急现金20000元，目标稳健增长。";
    const evidence = Object.fromEntries(Object.keys(patch).map(key => [key, source]));
    await store.propose(patch, evidence, [source]);
    assert.equal(store.snapshot.investableCash, undefined);
    const pending = JSON.parse(await readFile(store.filePath, "utf8")).pending;
    await store.handleUserReply(`确认画像 ${pending.id} 全部`);
    assert.equal(store.snapshot.investableCash, 10_000);
    assert.equal(store.toInvestorProfile()?.investableCash, 10_000);

    const reopened = await JsonUserProfileStore.open({ cwd: directory, filePath: join(directory, "profile.json"), userId: "user-1" });
    assert.equal(reopened.snapshot.monthlyContribution, 500);
    let seenContext: readonly { role: string; content: string }[] = [];
    const agent = new ResearchAgent([], {
      respond: async messages => {
        seenContext = messages;
        return { done: true, content: "已读取用户画像" };
      },
    }, { dynamicContextProvider: () => reopened.toPromptContext() });
    await agent.run("制定我的长期计划");
    const profileContext = seenContext.find(message => message.role === "system");
    assert.equal(profileContext?.role, "system");
    assert.equal(seenContext.at(-1)?.role, "system");
    assert.match(profileContext?.content ?? "", /investableCash/);
    assert.match(profileContext?.content ?? "", /10000/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("context manager trims only the model projection, not persisted history", () => {
  const history = [
    { role: "user" as const, content: "旧问题" },
    { role: "assistant" as const, content: "旧回答" },
    { role: "user" as const, content: "新问题" },
    { role: "assistant" as const, content: "新回答" },
  ];
  const manager = new SlidingWindowContextManager({ contextWindow: 30, reserveTokens: 4, keepRecentTokens: 12 });
  const projected = manager.build(history);
  assert.equal(projected[0]?.role, "system");
  assert.match(projected[0]?.content ?? "", /已省略较早/);
  assert.deepEqual(projected.slice(-2), history.slice(-2));
  assert.equal(history.length, 4);
});

test("context manager archives oversized tool results and exposes only a preview", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stocking-context-archive-"));
  try {
    const manager = new SlidingWindowContextManager({
      contextWindow: 10_000,
      reserveTokens: 100,
      keepRecentTokens: 1_000,
      maxToolResultTokens: 5,
      toolPreviewTokens: 8,
      archiveDirectory: directory,
    });
    const prepared = await manager.prepareMessage?.({
      role: "tool",
      content: JSON.stringify({ results: "a".repeat(200) }),
      toolName: "web_search",
      toolCallId: "call-archive",
    });
    assert.ok(prepared?.contextMetadata?.archivePath);
    assert.match(prepared?.contextMetadata?.preview ?? "", /预览已截断/);
    const archived = JSON.parse(await readFile(prepared!.contextMetadata!.archivePath!, "utf8")) as { message?: { content?: string } };
    assert.equal(archived.message?.content, prepared?.content);
    const projected = manager.build([{ role: "user", content: "查询" }, prepared!]);
    assert.match(projected[1]?.content ?? "", /工具结果已归档/);
    assert.doesNotMatch(projected[1]?.content ?? "", /a{100}/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("context manager uses LLM compression as a last resort and opens a circuit after failures", async () => {
  const history = [
    { role: "user" as const, content: "旧任务" },
    { role: "assistant" as const, content: "旧结论" },
    { role: "user" as const, content: "新任务" },
    { role: "assistant" as const, content: "x".repeat(300) },
  ];
  const manager = new SlidingWindowContextManager({ contextWindow: 30, reserveTokens: 4, keepRecentTokens: 1, maxCompressionFailures: 3 });
  let attempts = 0;
  const failingCompressor = async () => {
    attempts += 1;
    throw new Error("compression unavailable");
  };
  for (let index = 0; index < 4; index += 1) await manager.buildAsync?.(history, failingCompressor);
  assert.equal(attempts, 3);
});

test("context manager keeps a structured LLM summary when recent history overflows", async () => {
  const history = [
    { role: "user" as const, content: "旧任务" },
    { role: "assistant" as const, content: "旧结论" },
    { role: "user" as const, content: "新任务" },
    { role: "assistant" as const, content: "x".repeat(300) },
  ];
  const manager = new SlidingWindowContextManager({ contextWindow: 80, reserveTokens: 4, keepRecentTokens: 1 });
  const projected = await manager.buildAsync?.(history, async () => "保留 600519、报告期 2025-4、数据源同花顺和 NO_TRADE 约束");
  assert.match(projected?.[0]?.content ?? "", /全量压缩摘要/);
  assert.match(projected?.[0]?.content ?? "", /600519/);
});

test("Chat Completions model streams public reasoning and text deltas", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const stream = [
    'data: {"choices":[{"delta":{"reasoning_content":"先检查数据。"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"结论"}}]}\n\n',
    "data: [DONE]\n\n",
  ].join("");
  const model = new ChatCompletionsResearchModel({
    apiKey: "test-key",
    model: "test-model",
    baseUrl: "https://example.test/v1",
    systemPrompt: "测试",
    fetchFn: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  }, []);
  const thinking: string[] = [];
  const text: string[] = [];
  const response = await model.respond([{ role: "user", content: "测试" }], {
    onThinkingDelta: delta => thinking.push(delta),
    onTextDelta: delta => text.push(delta),
  });

  assert.equal(requestBody?.stream, true);
  assert.deepEqual(thinking, ["先检查数据。"]);
  assert.deepEqual(text, ["结论"]);
  assert.deepEqual(response, { done: true, content: "结论" });
});

test("Chat Completions model reconstructs streamed tool call arguments", async () => {
  const stream = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"get_quote","arguments":"{\\"ticker\\":\\"600519\\""}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]}}]}\n\n',
    "data: [DONE]\n\n",
  ].join("");
  const model = new ChatCompletionsResearchModel({
    apiKey: "test-key",
    model: "test-model",
    systemPrompt: "测试",
    fetchFn: async () => new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
  }, []);
  const response = await model.respond([{ role: "user", content: "报价" }], {});

  assert.equal(response.done, false);
  assert.deepEqual(response.toolCall, { id: "call-1", name: "get_quote", input: { ticker: "600519" } });
});

test("Chat Completions model preserves multiple tool calls", async () => {
  const payload = {
    choices: [{
      message: {
        content: null,
        tool_calls: [
          { id: "call-1", function: { name: "get_quote", arguments: '{"ticker":"600519"}' } },
          { id: "call-2", function: { name: "get_quote", arguments: '{"ticker":"510300"}' } },
        ],
      },
    }],
  };
  const model = new ChatCompletionsResearchModel({
    apiKey: "test-key",
    model: "test-model",
    systemPrompt: "测试",
    fetchFn: async () => new Response(JSON.stringify(payload), { status: 200 }),
  }, []);
  const response = await model.respond([{ role: "user", content: "同时查询两只证券" }]);

  assert.equal(response.done, false);
  assert.equal(response.toolCalls?.length, 2);
  assert.deepEqual(response.toolCalls?.map(call => call.name), ["get_quote", "get_quote"]);
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
    fetchFn: async input => {
      const url = String(input);
      const body = url.includes("/meta/tickers/search")
        ? {
            code: 0,
            message: "success",
            request_id: "request-symbol",
            data: {
              timestamp: 1735689600000,
              item: [{
                thscode: "600519.SH",
                ticker: "600519",
                name: "贵州茅台",
                exchange: "SH",
                asset_type: "a-share",
              }],
            },
          }
        : {
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
          };
      return new Response(JSON.stringify(body), { status: 200 });
    },
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

test("HiThink provider distinguishes STAR and ChiNext board trading lots", async () => {
  const { HiThinkMarketDataProvider } = await import("../src/providers/hithink-market-data.js");
  const provider = new HiThinkMarketDataProvider({
    apiKey: "test-key",
    fetchFn: async () => new Response(JSON.stringify({
      code: 0,
      message: "success",
      request_id: "request-board",
      data: {
        timestamp: 1735689600000,
        item: [{ thscode: "688836.SH", ticker: "688836", name: "宇树科技-W", exchange: "SH", asset_type: "a-share" }],
      },
    }), { status: 200 }),
  });
  const security = (await provider.getStockBasic("688836"))[0];
  assert.equal(security?.board, "star");
  assert.equal(security?.lotSize, 200);
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

test("Tavily provider preserves the unified search contract and reports provider mappings", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const provider = new TavilyWebSearchProvider({
    apiKey: "test-key",
    fetchFn: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        results: [{ title: "公告", url: "https://example.com", content: "摘要", published_date: "2026-10-01", score: 0.9 }],
      }), { status: 200 });
    },
  });
  const input: WebSearchInput = { query: "贵州茅台 年报", count: 3, freshness: "pw", searchLang: "zh-hans" };
  const result = await provider.search(input);
  assert.equal(result.provider, "tavily");
  assert.equal(result.available, true);
  assert.deepEqual(result.request, input);
  assert.deepEqual(result.diagnostics.unsupportedInput, []);
  assert.equal(result.diagnostics.providerRequest.time_range, "week");
  assert.equal(result.diagnostics.providerRequest.language, "zh-cn");
  assert.equal(requestBody?.max_results, 3);
  assert.equal(requestBody?.language, "zh-cn");
  assert.equal(requestBody?.api_key, undefined);
  assert.equal(result.results[0]?.publishedAt, "2026-10-01");
});

test("profile regression: model confirmation cannot turn idle cash or ETF suggestions into facts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stocking-profile-quality-"));
  try {
    const store = await JsonUserProfileStore.open({ cwd: directory });
    const [getProfile, updateProfile] = buildUserMemoryTools(store);
    assert.throws(() => updateProfile.input.parse({ confirmed: true, emergencyCashRequired: 0 }));
    const userText = "这笔5000元是闲钱，我打算放1年左右";
    const candidate = updateProfile.input.parse({
      changes: { investableCash: 5000, emergencyCashRequired: 0, preferredAssets: ["broad_etf", "cash"] },
      evidence: { investableCash: userText, emergencyCashRequired: userText, preferredAssets: userText },
    });
    const result = await updateProfile.execute(candidate, { userMessages: [userText] });
    assert.equal(result.updated, false);
    assert.equal(store.snapshot.emergencyCashRequired, undefined);
    assert.equal(store.snapshot.preferredAssets, undefined);
    assert.equal((await getProfile.execute({})).planningProfile, null);
    assert.match(result.message, /尚未用于规划/);
    // Accept only the amount actually provided, never the inferred fields beside it.
    const persisted = JSON.parse(await readFile(store.filePath, "utf8"));
    const reopened = await JsonUserProfileStore.open({ cwd: directory });
    await reopened.handleUserReply(`确认画像 ${persisted.pending.id} 1`);
    assert.equal(reopened.snapshot.investableCash, 5000);
    assert.equal(reopened.snapshot.emergencyCashRequired, undefined);
    assert.equal(reopened.snapshot.preferredAssets, undefined);
    const audited = JSON.parse(await readFile(store.filePath, "utf8"));
    assert.equal(audited.confirmations.investableCash.quote, userText);
    assert.equal(audited.pending, undefined);
    assert.match(await reopened.handleUserReply(`确认画像 ${persisted.pending.id} 全部`) ?? "", /过期/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("profile rejects fabricated evidence and legacy fields remain outside planning context", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stocking-profile-legacy-"));
  try {
    const { writeFile } = await import("node:fs/promises");
    const filePath = join(directory, "profile.json");
    await writeFile(filePath, JSON.stringify({
      version: 1, userId: "default", updatedAt: new Date().toISOString(), investableCash: 5000,
      emergencyCashRequired: 0, experienceLevel: "beginner", investmentGoal: "steady_growth", preferredAssets: ["broad_etf"],
    }));
    const store = await JsonUserProfileStore.open({ cwd: directory, filePath });
    assert.equal(store.snapshot.emergencyCashRequired, undefined);
    assert.ok(store.unverifiedFields.includes("preferredAssets"));
    assert.equal(store.toInvestorProfile(), undefined);
    const original = await readFile(filePath, "utf8");
    await assert.rejects(store.propose({ preferredAssets: ["broad_etf"] }, { preferredAssets: "我喜欢ETF" }, ["这笔钱是闲钱"]), /实际用户消息/);
    await assert.rejects(store.propose({ investableCash: 5000 }, {}, ["5000"]), /完全相同/);
    assert.equal(await readFile(filePath, "utf8"), original);
    // Old values remain on disk for audit, but are never labelled as confirmed.
    assert.equal(JSON.parse(original).emergencyCashRequired, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("runtime pauses on a profile proposal and only trusted user replies commit it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stocking-profile-runtime-"));
  try {
    const store = await JsonUserProfileStore.open({ cwd: directory });
    let calls = 0;
    const source = "每月200元";
    const agent = new ResearchAgent(buildUserMemoryTools(store), {
      respond: async messages => {
        calls += 1;
        if (calls === 1) return { done: false, toolCall: { id: "profile-call", name: "update_user_profile", input: {
          changes: { monthlyContribution: 200 }, evidence: { monthlyContribution: source },
        } } };
        assert.match(messages.find(message => message.role === "system")?.content ?? "", /"monthlyContribution":200/);
        return { done: true, content: "按已确认的月投入规划" };
      },
    }, { handleUserReply: input => store.handleUserReply(input), dynamicContextProvider: () => store.toPromptContext() });
    const result = await agent.run(source);
    assert.equal(calls, 1);
    assert.match(result.answer, /每月投入/);
    assert.equal(store.snapshot.monthlyContribution, undefined);
    assert.equal(result.messages.filter(m => m.role === "tool").length, 1);
    const pending = JSON.parse(await readFile(store.filePath, "utf8")).pending;
    await agent.run(`确认画像 ${pending.id} 全部`);
    assert.equal(calls, 1); // The model is not asked whether the user's confirmation is valid.
    assert.equal(store.snapshot.monthlyContribution, 200);
    await agent.run("继续规划");
    assert.equal(calls, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("profile correction, clearing, invalid selections and cancellation preserve confirmed state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stocking-profile-correction-"));
  try {
    const store = await JsonUserProfileStore.open({ cwd: directory });
    const id = async () => JSON.parse(await readFile(store.filePath, "utf8")).pending.id;
    await store.propose({ monthlyContribution: 200 }, { monthlyContribution: "每月200" }, ["每月200"]);
    await store.handleUserReply(`确认画像 ${await id()} 全部`);
    await store.propose({ monthlyContribution: 300 }, { monthlyContribution: "改成300" }, ["改成300"]);
    assert.equal(store.snapshot.monthlyContribution, 200);
    await store.handleUserReply(`确认画像 ${await id()} 99`);
    assert.equal(store.snapshot.monthlyContribution, 200);
    await store.handleUserReply(`确认画像 ${await id()} 全部`);
    assert.equal(store.snapshot.monthlyContribution, 300);
    await store.propose({ monthlyContribution: null }, { monthlyContribution: "清除月投入" }, ["清除月投入"]);
    await store.handleUserReply(`取消画像 ${await id()}`);
    assert.equal(store.snapshot.monthlyContribution, 300);
    await store.propose({ monthlyContribution: null }, { monthlyContribution: "清除月投入" }, ["清除月投入"]);
    await store.handleUserReply(`确认画像 ${await id()} 全部`);
    assert.equal(store.snapshot.monthlyContribution, undefined);
    assert.equal((await JsonUserProfileStore.open({ cwd: directory })).snapshot.monthlyContribution, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
