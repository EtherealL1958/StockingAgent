import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ResearchAgent, type AgentMessage } from "../src/agent/runtime.js";
import { ChatCompletionsResearchModel } from "../src/agent/chat-completions-model.js";
import { buildGeneralTools } from "../src/tools/general-tools.js";
import { buildMarketTools } from "../src/tools/market-tools.js";
import { HiThinkMarketDataProvider } from "../src/providers/hithink-market-data.js";
import { optimizePortfolio } from "../src/domain/portfolio.js";
import type { Candidate, InvestorProfile } from "../src/domain/types.js";

test("runtime retains the model receiver when calling the context compressor", async () => {
  class Model {
    readonly summary = "保留约束";
    async summarizeContext() { return this.summary; }
    async respond(messages: readonly AgentMessage[]) {
      assert.equal(messages[0]?.content, this.summary);
      return { done: true, content: "完成" };
    }
  }
  const agent = new ResearchAgent([], new Model(), {
    contextManager: {
      build: history => history,
      buildAsync: async (history, compressor) => {
        assert.ok(compressor);
        return [{ role: "system", content: await compressor(history) }];
      },
    },
  });
  await agent.run("继续研究");
});

test("compression requests preserve tool inputs and call associations", async () => {
  const model = new ChatCompletionsResearchModel({
    apiKey: "fixture", model: "fixture", systemPrompt: "fixture",
    fetchFn: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const history = JSON.parse(body.messages[1].content);
      assert.deepEqual(history[0].toolCalls, [{ id: "call-1", name: "get_quote", input: { ticker: "600519" } }]);
      return new Response(JSON.stringify({ choices: [{ message: { content: "证券600519" } }] }));
    },
  }, []);
  await model.summarizeContext([{
    role: "assistant", content: "",
    toolCalls: [{ id: "call-1", name: "get_quote", input: { ticker: "600519" } }],
  }]);
});

test("file tools reject symlink escapes and secret aliases and preserve existing files", async () => {
  const root = await mkdtemp(join(tmpdir(), "stocking-files-"));
  const outside = await mkdtemp(join(tmpdir(), "stocking-outside-"));
  try {
    await writeFile(join(root, ".env"), "fixture-only");
    await symlink(join(root, ".env"), join(root, "alias.txt"));
    await symlink(outside, join(root, "external"));
    const [read, write] = buildGeneralTools(root);
    assert.ok(read && write);
    await assert.rejects(read.execute(read.input.parse({ path: "alias.txt" })), /非秘密文件/);
    await assert.rejects(write.execute(write.input.parse({ path: "external/new.txt", content: "blocked" })), /项目目录/);
    await write.execute(write.input.parse({ path: "report.md", content: "original" }));
    await assert.rejects(write.execute(write.input.parse({ path: "report.md", content: "replacement" })), /文件已存在/);
    assert.equal(read.input.safeParse({ path: "report.md", unsupported: true }).success, false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("HiThink keeps empty financial values missing and preserves a genuine zero", async () => {
  const provider = new HiThinkMarketDataProvider({
    apiKey: "fixture",
    fetchFn: async () => new Response(JSON.stringify({
      code: 0, message: "ok", request_id: "fixture",
      data: { thscode: "600519.SH", report: "2025-4", abilities: [{ ability: "fixture", indicators: [
        { index_id: "index_weighted_avg_roe", value: " " },
        { index_id: "operating_income_yoy_growth_ratio", value: "" },
        { index_id: "net_profit_yoy_growth_ratio", value: "0" },
      ] }] },
    })),
  });
  assert.deepEqual(await provider.getFinancials("600519", "2025-4"), { netProfitGrowth: 0 });
});

test("history end dates include that day and tool schemas reject unknown arguments", async () => {
  const provider = new HiThinkMarketDataProvider({
    apiKey: "fixture",
    fetchFn: async url => {
      const query = new URL(String(url)).searchParams;
      assert.equal(query.get("end"), String(Date.parse("2026-10-05T23:59:59.999Z")));
      return new Response(JSON.stringify({ code: 0, message: "ok", request_id: "fixture", data: { timestamp: 0, item: [] } }));
    },
  });
  await provider.getIndexDailyBars("000300.SH", "2026-10-01", "2026-10-05");
  const historyTool = buildMarketTools(provider).find(tool => tool.name === "get_market_history");
  assert.ok(historyTool);
  assert.equal(historyTool.input.safeParse({ thscode: "000300.sh" }).success, true);
  assert.equal(historyTool.input.safeParse({ ticker: "600519", thscode: "000300.SH" }).success, false);
  assert.equal(historyTool.input.safeParse({ ticker: "600519", unsupported: true }).success, false);
});

test("HiThink infers the exchange from thscode when metadata omits it", async () => {
  const provider = new HiThinkMarketDataProvider({
    apiKey: "fixture",
    fetchFn: async () => new Response(JSON.stringify({
      code: 0, message: "ok", request_id: "fixture",
      data: { timestamp: 0, item: [{ thscode: "920002.BJ", ticker: "920002", name: "北交所样本", exchange: null, asset_type: "a-share" }] },
    })),
  });
  const securities = await provider.getStockBasic("920002");
  assert.equal(securities[0]?.board, "bj_main");
});

test("portfolio sizing accounts for fees before rejecting a smaller executable lot", () => {
  const profile: InvestorProfile = {
    investableCash: 4_445,
    monthlyContribution: 0,
    horizonYears: 3,
    riskLevel: "high",
    maxDrawdown: 0.2,
    emergencyCashRequired: 0,
  };
  const candidate: Candidate = {
    security: { ticker: "600001", name: "样本股票", securityType: "stock", board: "sh_main", sector: "industry", lotSize: 100, isIndex: false },
    quote: { ticker: "600001", price: 4.95, asOf: "2026-10-05", source: "fixture", isSuspended: false },
    metrics: { roe: 20, revenueGrowth: 10, netProfitGrowth: 10, grossMargin: 30, debtRatio: 30, volatility: 0.1, maxDrawdown: 0.1, momentum: 60 },
  };
  const result = optimizePortfolio(profile, [candidate], 0.0003, 50);
  assert.equal(result.status, "INVEST");
  assert.equal(result.allocations[0]?.quantity, 100);
});
