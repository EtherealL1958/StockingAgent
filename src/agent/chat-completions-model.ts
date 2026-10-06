import { z } from "zod";
import type { AgentMessage, AgentModel, AgentResponseCallbacks, ModelResponse } from "./runtime.js";
import type { SessionToolDefinition } from "./session.js";
import type { AgentTool } from "../tools/tool.js";

const chatCompletionResponseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({
      content: z.string().nullable().optional(),
      tool_calls: z.array(z.object({
        id: z.string(),
        function: z.object({ name: z.string(), arguments: z.string() }),
      })).optional(),
    }),
  })).min(1),
});

const chatCompletionStreamChunkSchema = z.object({
  choices: z.array(z.object({
    delta: z.object({
      content: z.string().nullable().optional(),
      reasoning_content: z.string().nullable().optional(),
      reasoning: z.string().nullable().optional(),
      tool_calls: z.array(z.object({
        index: z.number().int().nonnegative().optional(),
        id: z.string().optional(),
        function: z.object({ name: z.string().optional(), arguments: z.string().optional() }).optional(),
      })).optional(),
    }).optional(),
  })),
});

type ChatMessage =
  | { readonly role: "system" | "user"; readonly content: string }
  | { readonly role: "assistant"; readonly content: string | null; readonly tool_calls?: readonly ChatToolCall[] }
  | { readonly role: "tool"; readonly content: string; readonly tool_call_id: string };
interface ChatToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
}
interface ChatToolDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Readonly<Record<string, unknown>>;
  };
}

const tickerPropertyDefinition = { type: "string", pattern: "^[0-9]{6}$", description: "六位 A 股、ETF 代码" };
const dateRangePropertyDefinitions = {
  from: { type: "string", description: "包含起始日，例如 2025-01-01；省略使用 Provider 默认起始日期" },
  to: { type: "string", description: "包含结束日，例如 2026-10-05；省略使用 Provider 默认结束日期" },
};

export function buildChatCompletionsToolDefinitions(): readonly ChatToolDefinition[] {
  return [
    {
      type: "function",
      function: {
        name: "read",
        description: "需要查看完整 Skill、文本财报或研究笔记时使用，例如 path='skills/a-share-research/SKILL.md'。只接受项目相对路径和 UTF-8 文本，不解析 PDF/图片/目录，不接受 .env；默认最多 400 行。返回字段示例：{path:'reports/2025-q4.txt',startLine:1,endLine:20,truncated:false,content:'...'}。",
        parameters: { type: "object", properties: { path: { type: "string", description: "项目相对路径，例如 reports/2025-q4.txt；不要传绝对路径或 .env" }, offset: { type: "integer", minimum: 1, description: "1-based 起始行，例如 401" }, limit: { type: "integer", minimum: 1, maximum: 400, description: "读取行数，例如 20；默认 400，最大 400" } }, required: ["path"], additionalProperties: false },
      },
    },
    {
      type: "function",
      function: {
        name: "write",
        description: "用户要求保存研究总结或复盘时使用，例如 path='reports/600519-review.md'。path 必须是项目相对路径；工具按 UTF-8 原样写入、自动创建父目录，不接受项目外路径或 .env，也不会发布外部服务。成功字段示例：{path:'reports/600519-review.md',bytes:1234,written:true}。",
        parameters: { type: "object", properties: { path: { type: "string", description: "项目相对输出路径，例如 reports/600519-review.md" }, content: { type: "string", description: "原样写入的 Markdown，例如 '# 600519 复盘\\n...'" }, overwrite: { type: "boolean", default: false, description: "是否覆盖已有文件；默认 false，已有文件会报错" } }, required: ["path", "content"], additionalProperties: false },
      },
    },
    {
      type: "function",
      function: {
        name: "web_search",
        description: "需要补充新闻、公告或行业资料时使用，例如 query='贵州茅台 2025 年年报'；不要用来获取精确行情或财务指标。默认 provider 是 Tavily，可由 WEB_SEARCH_PROVIDER 切换为 Brave。返回字段包含 provider、request、diagnostics.providerRequest 和 results；未配置对应 API key 时 available=false，不伪造结果。",
        parameters: { type: "object", properties: { query: { type: "string", minLength: 2, maxLength: 500, description: "原样搜索词，例如 贵州茅台 2025 年年报" }, count: { type: "integer", minimum: 1, maximum: 10, default: 5, description: "结果条数，例如 5，最大 10" }, freshness: { type: "string", enum: ["pd", "pw", "pm", "py"], description: "pd=过去一天、pw=过去一周、pm=过去一月、py=过去一年；省略不限定" }, searchLang: { type: "string", enum: ["zh-hans", "en"], default: "zh-hans", description: "搜索语言，例如 zh-hans；Tavily 会映射为 zh-cn，Brave 使用 zh-hans；实际参数见 diagnostics.providerRequest" } }, required: ["query"], additionalProperties: false },
      },
    },
    {
      type: "function",
      function: {
        name: "code_exec",
        description: "需要可复现辅助计算时使用，例如执行 JavaScript `console.log(2 + 3)`；不执行 shell/bash，不替代金融指标工具，不注入秘密环境变量。代码仍可使用语言运行时 API，只执行可信短代码。最长 30 秒，stdout/stderr 各约 32KB。参数必须是严格 JSON 对象：language 只能是字符串 javascript 或 python，code 才放代码文本；不要把 Markdown/XML 代码围栏或代码文本放进 language 字段。返回字段示例：{stdout:'5\\n',exitCode:0,timedOut:false,stdoutTruncated:false}。",
        parameters: { type: "object", properties: { language: { type: "string", enum: ["javascript", "python"], description: "例如 javascript 或 python；不接受 shell" }, code: { type: "string", minLength: 1, maxLength: 100000, description: "原样执行的短代码，例如 console.log(2 + 3)" }, timeoutMs: { type: "integer", minimum: 1, maximum: 30000, default: 10000, description: "超时毫秒数，默认 10000，最大 30000" } }, required: ["language", "code"], additionalProperties: false },
      },
    },
    {
      type: "function",
      function: {
        name: "get_quote",
        description: "需要一只 A 股或 ETF 的最新价格、数据时间和板块确认时使用，例如 ticker=600519 或 510300。只接受六位数字代码，不接受 600519.SH；返回字段包含 requestedTicker、quote(price/asOf/source) 和 security，不是历史序列或买入建议。",
        parameters: { type: "object", properties: { ticker: { ...tickerPropertyDefinition, description: "六位数字代码，例如 600519（贵州茅台）或 510300（沪深300ETF）；不要传 600519.SH" } }, required: ["ticker"], additionalProperties: false },
      },
    },
    {
      type: "function",
      function: {
        name: "get_market_history",
        description: "需要股票/ETF/指数历史趋势和风险时使用，例如 ticker=600519 或 thscode=000300.SH，from=2025-01-01、to=2026-10-05。ticker 与 thscode 必须二选一；默认只返回全窗口摘要，includeBars=true 时最多返回最后 300 根，但会明确返回 returnedBarCount。",
        parameters: { type: "object", properties: { ticker: { ...tickerPropertyDefinition, description: "六位股票/ETF 代码，例如 600519；与 thscode 二选一" }, thscode: { type: "string", pattern: "^[0-9]{6}\\.(SH|SZ|TI)$", description: "指数代码，例如 000001.SH、399001.SZ、000300.SH；与 ticker 二选一" }, ...dateRangePropertyDefinitions, includeBars: { type: "boolean", default: false, description: "是否返回逐根日线；默认 false，true 时最多最后 300 根" } }, oneOf: [{ required: ["ticker"] }, { required: ["thscode"] }], additionalProperties: false },
      },
    },
    {
      type: "function",
      function: {
        name: "screen_stocks",
        description: "用户提出价格上限初筛时使用，例如 maxPrice=100、limit=10。只扫描股票、不含 ETF；停牌、缺报价和超过价格上限的标的会排除。返回字段包含 candidates、count、stockPoolCount、scannedCount 和 excluded 统计，不是全市场排名或买入建议。",
        parameters: {
          type: "object",
          properties: {
            maxPrice: { type: "number", exclusiveMinimum: 0, description: "人民币价格上限，例如 100 表示 price <= 100" },
            limit: { type: "integer", minimum: 1, maximum: 50, default: 20, description: "最多候选数，例如 10；最大 50" },
          },
          required: ["maxPrice"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_fundamentals",
        description: "需要基本面指标时使用，例如 ticker=600519、report=2025-4。report 必须显式提供，避免隐式采用环境变量；缺失指标保持缺失，不代表零。返回字段包含 requestedTicker、requestedReport、security 和 financials，不是完整财报或历史估值序列。",
        parameters: { type: "object", properties: { ticker: { ...tickerPropertyDefinition, description: "六位股票代码，例如 600519；不接受指数代码" }, report: { type: "string", pattern: "^[0-9]{4}-[1-4]$", description: "报告期，例如 2025-4，格式 YYYY-1 到 YYYY-4" } }, required: ["ticker", "report"], additionalProperties: false },
      },
    },
  ];
}

export function buildSessionToolDefinitions(tools: readonly AgentTool<unknown, unknown>[]): readonly SessionToolDefinition[] {
  return buildChatCompletionsToolDefinitions()
    .filter(definition => tools.some(tool => tool.name === definition.function.name))
    .map(definition => ({
      name: definition.function.name,
      description: definition.function.description,
      parameters: definition.function.parameters,
    }));
}

export interface ChatCompletionsModelOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly systemPrompt: string;
  readonly timeoutMs?: number;
  /** 仅用于注入测试或自定义运行时；生产环境默认使用全局 fetch。 */
  readonly fetchFn?: typeof fetch;
}

/** 使用 OpenAI-compatible Chat Completions 的真实工具调用 Model；不承担金融计算。 */
export class ChatCompletionsResearchModel implements AgentModel {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly tools: readonly ChatToolDefinition[];
  private readonly fetchFn: typeof fetch;

  public constructor(
    private readonly modelOptions: ChatCompletionsModelOptions,
    tools: readonly AgentTool<unknown, unknown>[],
  ) {
    this.baseUrl = (modelOptions.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.timeoutMs = modelOptions.timeoutMs ?? 60_000;
    this.fetchFn = modelOptions.fetchFn ?? fetch;
    this.tools = buildChatCompletionsToolDefinitions().filter(definition => tools.some(tool => tool.name === definition.function.name));
  }

  public async respond(messages: readonly AgentMessage[], callbacks?: AgentResponseCallbacks): Promise<ModelResponse> {
    const response = await this.fetchFn(this.baseUrl.endsWith("/chat/completions") ? this.baseUrl : `${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.modelOptions.apiKey}`,
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify(this.requestBody(messages, Boolean(callbacks))),
    });
    if (!response.ok) {
      throw new Error(`LLM 请求失败: HTTP ${response.status}`);
    }
    if (callbacks) return this.readStreamingResponse(response, callbacks);
    const payload = chatCompletionResponseSchema.parse(await response.json());
    const message = payload.choices[0]!.message;
    const call = message.tool_calls?.[0];
    if (!call) {
      return { done: true, content: message.content ?? "模型未返回文本" };
    }
    let input: unknown;
    try {
      input = JSON.parse(call.function.arguments) as unknown;
    } catch {
      throw new Error(`LLM 工具参数不是合法 JSON: ${call.function.name}`);
    }
    return {
      done: false,
      ...(message.content ? { content: message.content } : {}),
      toolCall: { id: call.id, name: call.function.name, input },
    };
  }

  private requestBody(messages: readonly AgentMessage[], stream: boolean): Record<string, unknown> {
    return {
      model: this.modelOptions.model,
      temperature: 0.1,
      messages: [
        { role: "system", content: this.modelOptions.systemPrompt },
        ...messages.map(message => this.toChatMessage(message)),
      ],
      tools: this.tools,
      tool_choice: "auto",
      ...(stream ? { stream: true } : {}),
    };
  }

  private async readStreamingResponse(response: Response, callbacks: AgentResponseCallbacks): Promise<ModelResponse> {
    if (!response.body) throw new Error("LLM 流式响应缺少响应体");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();

    const consumeLine = (line: string): void => {
      if (!line.startsWith("data:")) return;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") return;
      const chunk = chatCompletionStreamChunkSchema.parse(JSON.parse(data));
      for (const choice of chunk.choices) {
        const delta = choice.delta;
        if (!delta) continue;
        const thinking = delta.reasoning_content ?? delta.reasoning;
        if (thinking) callbacks.onThinkingDelta?.(thinking);
        if (delta.content) {
          content += delta.content;
          callbacks.onTextDelta?.(delta.content);
        }
        for (const call of delta.tool_calls ?? []) {
          const index = call.index ?? 0;
          const existing = toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
          if (call.id) existing.id = call.id;
          if (call.function?.name) existing.name += call.function.name;
          if (call.function?.arguments) existing.arguments += call.function.arguments;
          toolCalls.set(index, existing);
        }
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) consumeLine(line);
      if (done) break;
    }
    if (buffer) consumeLine(buffer);

    const call = [...toolCalls.values()][0];
    if (!call) return { done: true, content: content || "模型未返回文本" };
    let input: unknown;
    try {
      input = JSON.parse(call.arguments) as unknown;
    } catch {
      throw new Error(`LLM 流式工具参数不是合法 JSON: ${call.name}`);
    }
    return {
      done: false,
      ...(content ? { content } : {}),
      toolCall: { id: call.id, name: call.name, input },
    };
  }

  private toChatMessage(message: AgentMessage): ChatMessage {
    if (message.role === "system") return { role: "system", content: message.content };
    if (message.role === "user") return { role: "user", content: message.content };
    if (message.role === "tool") {
      return {
        role: "tool",
        content: message.content,
        tool_call_id: message.toolCallId ?? "unknown-tool-call",
      };
    }
    const toolCalls = message.toolName && message.toolCallId
      ? [{ id: message.toolCallId, type: "function" as const, function: { name: message.toolName, arguments: JSON.stringify(message.toolInput ?? {}) } }]
      : undefined;
    return toolCalls
      ? { role: "assistant", content: message.content || null, tool_calls: toolCalls }
      : { role: "assistant", content: message.content };
  }
}
