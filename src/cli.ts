import "dotenv/config";

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { ChatCompletionsResearchModel, buildSessionToolDefinitions } from "./agent/chat-completions-model.js";
import { SlidingWindowContextManager } from "./agent/context.js";
import { discoverSkills, formatSkillCatalog } from "./agent/resources.js";
import { RuleBasedResearchModel } from "./agent/rule-model.js";
import { ResearchAgent } from "./agent/runtime.js";
import { JsonlSessionStore, type SessionStaticContext } from "./agent/session.js";
import type { MarketDataProvider } from "./providers/market-data.js";
import { createMarketDataProvider } from "./app/provider.js";
import { buildMarketTools } from "./tools/market-tools.js";
import { buildGeneralTools } from "./tools/general-tools.js";

async function createResearchAgent(provider: MarketDataProvider): Promise<{ readonly agent: ResearchAgent; readonly session: JsonlSessionStore }> {
  const tools = [...buildGeneralTools(process.cwd()), ...buildMarketTools(provider)];
  const skillCatalog = formatSkillCatalog(discoverSkills(process.cwd()));
  const systemPrompt = buildSystemPrompt(skillCatalog);
  const staticContext: SessionStaticContext = {
    systemPrompt,
    toolDefinitions: buildSessionToolDefinitions(tools),
  };
  const session = await JsonlSessionStore.open({
    cwd: process.cwd(),
    ...(process.env.STOCKING_SESSION_DIR ? { directory: process.env.STOCKING_SESSION_DIR } : {}),
    ...(process.env.STOCKING_SESSION_FILE ? { filePath: process.env.STOCKING_SESSION_FILE } : {}),
    staticContext,
  });
  const maxContextCharacters = readPositiveInteger(process.env.STOCKING_CONTEXT_MAX_CHARS) ?? 120_000;
  const contextManager = new SlidingWindowContextManager({ maxCharacters: maxContextCharacters, keepRecentMessages: 40 });
  const apiKey = process.env.LLM_KEY;
  if (apiKey) {
    console.log(`使用真实 LLM：${process.env.LLM_MODEL ?? "deepseek-chat"}`);
    return { session, agent: new ResearchAgent(
      tools,
      new ChatCompletionsResearchModel({
        apiKey,
        model: process.env.LLM_MODEL ?? "deepseek-chat",
        baseUrl: process.env.LLM_API || "https://api.deepseek.com",
        systemPrompt,
      }, tools),
      { session, contextManager },
    ) };
  }
  console.log("未配置 LLM_KEY，使用规则模型；自然语言分析能力受限");
  return { session, agent: new ResearchAgent(tools, new RuleBasedResearchModel(), { session, contextManager }) };
}

export async function runTerminal(provider: MarketDataProvider = createMarketDataProvider()): Promise<void> {
  const { agent, session } = await createResearchAgent(provider);
  let streamedText = false;
  let activeOutput: "thinking" | "answer" | undefined;

  const finishOutputBlock = (): void => {
    if (activeOutput) {
      output.write("\n");
      activeOutput = undefined;
    }
  };

  agent.on(event => {
    if (event.type === "thinking_delta" && event.delta) {
      if (activeOutput !== "thinking") {
        finishOutputBlock();
        output.write("[model-thinking] ");
        activeOutput = "thinking";
      }
      output.write(event.delta);
      return;
    }

    if (event.type === "text_delta" && event.delta) {
      streamedText = true;
      if (activeOutput !== "answer") {
        finishOutputBlock();
        activeOutput = "answer";
      }
      output.write(event.delta);
      return;
    }

    if (event.type === "tool_start") {
      finishOutputBlock();
      output.write(`[tool:start] ${event.toolName} ${JSON.stringify(event.input)}\n`);
      return;
    }

    if (event.type === "tool_end") {
      finishOutputBlock();
      if (isUnavailableToolResult(event.result)) {
        output.write(`[tool:end] ${event.toolName} unavailable: ${event.result.error.message}\n`);
      } else {
        output.write(`[tool:end] ${event.toolName} ok\n`);
      }
    }
  });
  const terminal = createInterface({ input, output });
  console.log("StockingAgent A 股金融研究终端");
  console.log("请输入自然语言问题；输入 exit 或 quit 结束会话。");
  console.log(`当前会话：${session.id}（${session.filePath}，已恢复 ${session.history.length} 条消息）`);
  terminal.setPrompt("stocking> ");
  let closed = false;
  terminal.once("close", () => {
    closed = true;
  });
  terminal.prompt();
  try {
    for await (const line of terminal) {
      try {
        if (["exit", "quit"].includes(line.trim().toLowerCase())) break;
        if (!line.trim()) {
          if (!closed) terminal.prompt();
          continue;
        }
        streamedText = false;
        activeOutput = undefined;
        const result = await agent.run(line);
        finishOutputBlock();
        if (!streamedText) {
          output.write(`${result.answer}\n`);
        } else {
          output.write("\n");
        }
      } catch (error) {
        finishOutputBlock();
        console.error(`执行失败: ${error instanceof Error ? error.message : "未知错误"}`);
      }
      if (!closed) {
        terminal.prompt();
      }
    }
  } finally {
    terminal.close();
  }
}

function buildSystemPrompt(skillCatalog: string): string {
  return `你是风险优先的 A 股金融研究 Agent。你必须先调用工具获取真实数据，再进行分析；不得编造价格、指标、新闻或预测。任何工具返回 available=false、error 或数据缺失时，必须明确标为“数据不可用/分析不完整”，禁止用模型记忆、搜索摘要或推测补齐财务数字；网页搜索内容只能按来源和日期单独标注，不能冒充同花顺财务数据。工具参数必须严格遵循 JSON Schema：不要把 Markdown/XML 代码围栏、标签或代码文本放进其他字段；如果工具返回参数错误，阅读错误字段后修正原参数再重试。\n\n采用渐进式披露：以下只列出可用 Skill 的名称、用途和路径。需要某个 Skill 的完整规范时，先调用 read 读取对应 SKILL.md，再继续研究。\n\n可用 Skill：\n${skillCatalog}\n\n工具分工：read/write/web_search/code_exec 是通用工具；get_quote、get_market_history、get_fundamentals、screen_stocks 是金融工具。金融计算必须使用金融工具或代码完成，不能凭语言模型心算。`;
}

function readPositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isUnavailableToolResult(value: unknown): value is { readonly available: false; readonly error: { readonly message: string } } {
  if (typeof value !== "object" || value === null) return false;
  const result = value as { readonly available?: unknown; readonly error?: unknown };
  if (result.available !== false || typeof result.error !== "object" || result.error === null) return false;
  return typeof (result.error as { readonly message?: unknown }).message === "string";
}

if (process.argv[1]?.endsWith("/cli.js")) {
  await runTerminal();
}
