import { ZodError } from "zod";
import type { AgentTool } from "../tools/tool.js";
import type { ContextManager } from "./context.js";
import type { AgentSession } from "./session.js";

export type AgentMessage = {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolName?: string;
  readonly toolInput?: unknown;
  readonly toolCallId?: string;
};

export interface ModelResponse {
  readonly content?: string;
  readonly toolCall?: {
    readonly id?: string;
    readonly name: string;
    readonly input: unknown;
  };
  readonly done: boolean;
}

export interface AgentModel {
  respond(messages: readonly AgentMessage[], callbacks?: AgentResponseCallbacks): Promise<ModelResponse>;
}

/** 模型可公开的增量内容；不要求模型暴露隐藏思维链。 */
export interface AgentResponseCallbacks {
  readonly onTextDelta?: (delta: string) => void;
  readonly onThinkingDelta?: (delta: string) => void;
}

export interface ResearchAgentOptions {
  readonly maxTurns?: number;
  readonly session?: AgentSession;
  readonly contextManager?: ContextManager;
}

export type AgentEvent = {
  readonly type: "agent_start" | "turn_start" | "thinking_delta" | "text_delta" | "tool_start" | "tool_end" | "agent_end";
  readonly message?: AgentMessage;
  readonly toolName?: string;
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
    this.session = options.session;
    this.contextManager = options.contextManager;
    this.history = [...(options.session?.history ?? [])];
  }

  private readonly maxTurns: number;
  private readonly session: AgentSession | undefined;
  private readonly contextManager: ContextManager | undefined;
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

    for (let turn = 0; turn < this.maxTurns; turn += 1) {
      this.emit({ type: "turn_start" });
      const context = this.contextManager?.build(this.history) ?? this.history;
      const response = await this.model.respond(context, {
        onThinkingDelta: delta => this.emit({ type: "thinking_delta", delta }),
        onTextDelta: delta => this.emit({ type: "text_delta", delta }),
      });

      if (response.done || !response.toolCall) {
        if (response.content) {
          await this.appendMessage({ role: "assistant", content: response.content });
        }
        this.emit({ type: "agent_end" });
        return { answer: response.content ?? "未生成结论", messages: this.history };
      }

      await this.appendMessage({
        role: "assistant",
        content: response.content ?? "",
        toolName: response.toolCall.name,
        toolInput: response.toolCall.input,
        ...(response.toolCall.id ? { toolCallId: response.toolCall.id } : {}),
      });
      const tool = this.tools.get(response.toolCall.name);
      if (!tool) {
        throw new Error(`unknown tool: ${response.toolCall.name}`);
      }

      let input: unknown;
      try {
        input = tool.input.parse(response.toolCall.input);
      } catch (error) {
        const result = toolError("invalid_tool_input", error);
        this.emit({ type: "tool_end", toolName: tool.name, result });
        await this.appendMessage({
          role: "tool",
          content: JSON.stringify(result),
          toolName: tool.name,
          toolInput: response.toolCall.input,
          ...(response.toolCall.id ? { toolCallId: response.toolCall.id } : {}),
        });
        continue;
      }
      this.emit({ type: "tool_start", toolName: tool.name, input });
      let result: unknown;
      try {
        result = await tool.execute(input);
      } catch (error) {
        // Provider 错误是证据缺失，不是金融结论；将其交回模型让它明确报告不完整性。
        result = toolError("tool_execution_error", error);
      }
      this.emit({ type: "tool_end", toolName: tool.name, result });
      await this.appendMessage({
        role: "tool",
        content: JSON.stringify(result),
        toolName: tool.name,
        toolInput: input,
        ...(response.toolCall.id ? { toolCallId: response.toolCall.id } : {}),
      });
    }

    throw new Error(`研究步骤超过上限（${this.maxTurns} 个模型回合）`);
  }

  private async appendMessage(message: AgentMessage): Promise<void> {
    if (this.session) await this.session.append(message);
    this.history.push(message);
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
