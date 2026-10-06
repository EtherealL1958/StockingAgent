import { ZodError } from "zod";
import { randomUUID } from "node:crypto";
import type { AgentTool } from "../tools/tool.js";
import type { ContextManager } from "./context.js";
import type { AgentSession } from "./session.js";

export type AgentMessage = {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolCalls?: readonly AgentToolCall[];
  readonly toolName?: string;
  readonly toolInput?: unknown;
  readonly toolCallId?: string;
  readonly contextMetadata?: {
    readonly archivePath?: string;
    readonly preview?: string;
    readonly importance?: "high" | "normal" | "low";
  };
};

export interface AgentToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

export interface ModelToolCall {
  readonly id?: string;
  readonly name: string;
  readonly input: unknown;
}

export interface ModelResponse {
  readonly content?: string;
  /** Legacy singular form remains accepted by custom models. */
  readonly toolCall?: ModelToolCall;
  /** Models may request independent tools in one response. */
  readonly toolCalls?: readonly ModelToolCall[];
  readonly done: boolean;
}

export interface AgentModel {
  /** 模型可接受的最大上下文窗口，单位为 token。 */
  readonly contextWindow?: number;
  respond(messages: readonly AgentMessage[], callbacks?: AgentResponseCallbacks): Promise<ModelResponse>;
  /** 可选的最后手段：将较早上下文压缩为可审查的结构化摘要。 */
  summarizeContext?(messages: readonly AgentMessage[]): Promise<string>;
}

/** 模型可公开的增量内容；不要求模型暴露隐藏思维链。 */
export interface AgentResponseCallbacks {
  readonly onTextDelta?: (delta: string) => void;
  readonly onThinkingDelta?: (delta: string) => void;
}

export interface ResearchAgentOptions {
  readonly maxTurns?: number;
  /** Handle explicit user replies outside model-controlled tool arguments. */
  readonly handleUserReply?: (input: string) => Promise<string | undefined>;
  readonly session?: AgentSession;
  readonly contextManager?: ContextManager;
  /** 每次模型回合前重新读取的持久化用户/组合上下文。 */
  readonly dynamicContextProvider?: () => Promise<string | undefined> | string | undefined;
}

export type AgentEvent = {
  readonly type: "agent_start" | "turn_start" | "response_end" | "thinking_delta" | "text_delta" | "tool_start" | "tool_end" | "agent_end";
  readonly final?: boolean;
  readonly message?: AgentMessage;
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly input?: unknown;
  readonly delta?: string;
  readonly result?: unknown;
};

/**
 * 研究 Agent 的最小运行时。
 *
 * 它采用经典的 model -> tool -> result 循环，但不包含任何投资策略。
 * 数据计算和风险约束仍由 domain 层负责。
 */
export class ResearchAgent {
  private readonly tools: ReadonlyMap<string, AgentTool<unknown, unknown>>;
  private readonly listeners = new Set<(event: AgentEvent) => void>();

  public constructor(
    tools: readonly AgentTool<unknown, unknown>[],
    private readonly model: AgentModel,
    options: ResearchAgentOptions = {},
  ) {
    this.tools = new Map(tools.map(tool => [tool.name, tool]));
    this.maxTurns = options.maxTurns ?? 12;
    this.handleUserReply = options.handleUserReply;
    this.session = options.session;
    this.contextManager = options.contextManager;
    this.dynamicContextProvider = options.dynamicContextProvider;
    this.history = [...(options.session?.history ?? [])];
  }

  private readonly maxTurns: number;
  private readonly handleUserReply: ResearchAgentOptions["handleUserReply"];
  private readonly session: AgentSession | undefined;
  private readonly contextManager: ContextManager | undefined;
  private readonly dynamicContextProvider: ResearchAgentOptions["dynamicContextProvider"];
  private readonly history: AgentMessage[];

  public on(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  public async run(userInput: string): Promise<{
    readonly answer: string;
    readonly messages: readonly AgentMessage[];
  }> {
    const userMessage: AgentMessage = { role: "user", content: userInput };
    await this.appendMessage(userMessage);
    this.emit({ type: "agent_start" });
    const directReply = await this.handleUserReply?.(userInput);
    if (directReply) {
      await this.appendMessage({ role: "assistant", content: directReply });
      this.emit({ type: "text_delta", delta: directReply });
      this.emit({ type: "agent_end" });
      return { answer: directReply, messages: this.history };
    }

    for (let turn = 0; turn < this.maxTurns; turn += 1) {
      this.emit({ type: "turn_start" });
      const historyContext = this.contextManager?.buildAsync
        ? await this.contextManager.buildAsync(this.history, this.model.summarizeContext?.bind(this.model))
        : this.contextManager?.build(this.history) ?? this.history;
      const dynamicContext = await this.dynamicContextProvider?.();
      const context = dynamicContext
        // Dynamic state is a status-bar message at the end of the trajectory.
        // Keeping it out of the static prefix preserves prompt-cache reuse.
        ? [...historyContext, { role: "system" as const, content: dynamicContext }]
        : historyContext;
      const response = await this.model.respond(context, {
        onThinkingDelta: delta => this.emit({ type: "thinking_delta", delta }),
        onTextDelta: delta => this.emit({ type: "text_delta", delta }),
      });

      const requestedToolCalls = response.toolCalls ?? (response.toolCall ? [response.toolCall] : []);
      this.emit({
        type: "response_end",
        message: { role: "assistant", content: response.content ?? "" },
        final: response.done || requestedToolCalls.length === 0,
      });
      if (response.done || requestedToolCalls.length === 0) {
        if (response.content) {
          await this.appendMessage({ role: "assistant", content: response.content });
        }
        this.emit({ type: "agent_end" });
        return { answer: response.content ?? "未生成结论", messages: this.history };
      }

      const toolCalls: readonly AgentToolCall[] = requestedToolCalls.map(call => ({
        id: call.id ?? randomUUID(),
        name: call.name,
        input: call.input,
      }));
      await this.appendMessage({
        role: "assistant",
        content: response.content ?? "",
        toolCalls,
        ...(toolCalls.length === 1 ? {
          toolName: toolCalls[0]!.name,
          toolInput: toolCalls[0]!.input,
          toolCallId: toolCalls[0]!.id,
        } : {}),
      });
      const directResponses: string[] = [];
      for (const toolCall of toolCalls) {
        const tool = this.tools.get(toolCall.name);
        if (!tool) {
          const result = toolError("unknown_tool", new Error(`未知工具: ${toolCall.name}`));
          this.emit({ type: "tool_end", toolName: toolCall.name, toolCallId: toolCall.id, input: toolCall.input, result });
          await this.appendToolResult(toolCall, result);
          continue;
        }

        let input: unknown;
        try {
          input = tool.input.parse(toolCall.input);
        } catch (error) {
          const result = toolError("invalid_tool_input", error);
          this.emit({ type: "tool_end", toolName: tool.name, toolCallId: toolCall.id, input: toolCall.input, result });
          await this.appendToolResult({ ...toolCall, input: toolCall.input }, result);
          continue;
        }
        this.emit({ type: "tool_start", toolName: tool.name, toolCallId: toolCall.id, input });
        let result: unknown;
        try {
          result = await tool.execute(input, {
            userMessages: this.history.filter(message => message.role === "user").map(message => message.content),
          });
        } catch (error) {
          // Provider 错误是证据缺失，不是金融结论；将其交回模型让它明确报告不完整性。
          result = toolError("tool_execution_error", error);
        }
        this.emit({ type: "tool_end", toolName: tool.name, toolCallId: toolCall.id, input, result });
        await this.appendToolResult({ ...toolCall, input }, result);
        const userResponse = tool.userResponse?.(result);
        if (userResponse) directResponses.push(userResponse);
      }
      if (directResponses.length > 0) {
        const directResponse = directResponses.join("\n");
        await this.appendMessage({ role: "assistant", content: directResponse });
        this.emit({ type: "text_delta", delta: directResponse });
        this.emit({ type: "agent_end" });
        return { answer: directResponse, messages: this.history };
      }
    }

    throw new Error(`研究步骤超过上限（${this.maxTurns} 个模型回合）`);
  }

  private async appendMessage(message: AgentMessage): Promise<void> {
    if (this.session) await this.session.append(message);
    this.history.push(message);
  }

  private async appendToolResult(toolCall: AgentToolCall, result: unknown): Promise<void> {
    const toolMessage: AgentMessage = {
      role: "tool",
      content: JSON.stringify(result),
      toolName: toolCall.name,
      toolInput: toolCall.input,
      toolCallId: toolCall.id,
    };
    const preparedToolMessage = this.contextManager?.prepareMessage
      ? await this.contextManager.prepareMessage(toolMessage)
      : toolMessage;
    await this.appendMessage(preparedToolMessage);
  }
}

function toolError(code: string, error: unknown): {
  readonly available: false;
  readonly error: { readonly code: string; readonly message: string };
} {
  return {
    available: false,
    error: {
      code,
      message: formatToolError(error),
    },
  };
}

function formatToolError(error: unknown): string {
  if (error instanceof ZodError) {
    return error.issues
      .map(issue => `${issue.path.length > 0 ? issue.path.join(".") : "input"}: ${issue.message}`)
      .join("; ");
  }
  return error instanceof Error ? error.message : "工具执行失败";
}
