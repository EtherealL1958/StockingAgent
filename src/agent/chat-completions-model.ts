import { z } from "zod";
import type { AgentMessage, AgentModel, AgentResponseCallbacks, ModelResponse, ModelToolCall } from "./runtime.js";
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

export function buildChatCompletionsToolDefinitions(
  tools: readonly AgentTool<unknown, unknown>[],
): readonly ChatToolDefinition[] {
  return tools.map(tool => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.modelParameters ?? { type: "object", properties: {}, additionalProperties: false },
    },
  }));
}

export function buildSessionToolDefinitions(tools: readonly AgentTool<unknown, unknown>[]): readonly SessionToolDefinition[] {
  return buildChatCompletionsToolDefinitions(tools)
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
  /** 当前模型的上下文窗口，单位为 token；由模型配置提供。 */
  readonly contextWindow?: number;
  /** 仅用于注入测试或自定义运行时；生产环境默认使用全局 fetch。 */
  readonly fetchFn?: typeof fetch;
}

/** 使用 OpenAI-compatible Chat Completions 的真实工具调用 Model；不承担金融计算。 */
export class ChatCompletionsResearchModel implements AgentModel {
  public readonly contextWindow: number;
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
    // 未提供模型窗口时不擅自假设一个上限；由调用方在模型配置中提供。
    this.contextWindow = modelOptions.contextWindow ?? Number.POSITIVE_INFINITY;
    this.fetchFn = modelOptions.fetchFn ?? fetch;
    this.tools = buildChatCompletionsToolDefinitions(tools);
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
    const calls = message.tool_calls ?? [];
    if (calls.length === 0) {
      return { done: true, content: message.content ?? "模型未返回文本" };
    }
    const parsedCalls = calls.map(call => parseModelToolCall(call.id, call.function.name, call.function.arguments));
    return withToolCalls(message.content, parsedCalls);
  }

  public async summarizeContext(messages: readonly AgentMessage[]): Promise<string> {
    const response = await this.fetchFn(this.baseUrl.endsWith("/chat/completions") ? this.baseUrl : `${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.modelOptions.apiKey}`,
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        model: this.modelOptions.model,
        temperature: 0,
        messages: [
          {
            role: "system",
            content: "你是上下文归档器。把给定的 A 股研究对话压缩为结构化摘要，必须保留证券代码、报告期、数据源、日期、数字、用户约束、工具错误、关键决策、未解决问题和投资逻辑失效条件。不要创造原文没有的事实；缺失信息写‘未提供’。按‘用户任务、已验证事实、工具与结果、决策与理由、风险与约束、待办’输出。",
          },
          {
            role: "user",
            // Preserve tool names, inputs and call IDs as evidence, including calls with no prose.
            content: JSON.stringify(messages),
          },
        ],
      }),
    });
    if (!response.ok) throw new Error(`上下文压缩请求失败: HTTP ${response.status}`);
    const payload = chatCompletionResponseSchema.parse(await response.json());
    const content = payload.choices[0]?.message.content;
    if (!content) throw new Error("上下文压缩没有返回摘要");
    return content;
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

    const calls = [...toolCalls.values()];
    if (calls.length === 0) return { done: true, content: content || "模型未返回文本" };
    return withToolCalls(content, calls.map(call => parseModelToolCall(call.id, call.name, call.arguments)));
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
    const toolCalls = message.toolCalls?.map(call => ({
      id: call.id,
      type: "function" as const,
      function: { name: call.name, arguments: JSON.stringify(call.input) },
    })) ?? (message.toolName && message.toolCallId
      ? [{ id: message.toolCallId, type: "function" as const, function: { name: message.toolName, arguments: JSON.stringify(message.toolInput ?? {}) } }]
      : undefined);
    return toolCalls
      ? { role: "assistant", content: message.content || null, tool_calls: toolCalls }
      : { role: "assistant", content: message.content };
  }
}

function parseModelToolCall(id: string, name: string, argumentsText: string): ModelToolCall {
  try {
    return { id, name, input: JSON.parse(argumentsText) as unknown };
  } catch {
    throw new Error(`LLM 工具参数不是合法 JSON: ${name}`);
  }
}

function withToolCalls(content: string | null | undefined, toolCalls: readonly ModelToolCall[]): ModelResponse {
  if (toolCalls.length === 1) {
    return {
      done: false,
      ...(content ? { content } : {}),
      toolCall: toolCalls[0]!,
    };
  }
  return {
    done: false,
    ...(content ? { content } : {}),
    toolCalls,
  };
}
