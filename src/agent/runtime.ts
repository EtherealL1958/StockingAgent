import type { AgentTool } from "../tools/tool.js";

export type AgentMessage = {
  readonly role: "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolName?: string;
  readonly toolInput?: unknown;
};

export interface ModelResponse {
  readonly content?: string;
  readonly toolCall?: {
    readonly name: string;
    readonly input: unknown;
  };
  readonly done: boolean;
}

export interface AgentModel {
  respond(messages: readonly AgentMessage[]): Promise<ModelResponse>;
}

export type AgentEvent = {
  readonly type: "agent_start" | "turn_start" | "tool_start" | "tool_end" | "agent_end";
  readonly message?: AgentMessage;
  readonly toolName?: string;
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
    private readonly maxTurns = 8,
  ) {
    this.tools = new Map(tools.map(tool => [tool.name, tool]));
  }

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
    const messages: AgentMessage[] = [{ role: "user", content: userInput }];
    this.emit({ type: "agent_start" });

    for (let turn = 0; turn < this.maxTurns; turn += 1) {
      this.emit({ type: "turn_start" });
      const response = await this.model.respond(messages);

      if (response.content) {
        messages.push({ role: "assistant", content: response.content });
      }
      if (response.done || !response.toolCall) {
        this.emit({ type: "agent_end" });
        return { answer: response.content ?? "未生成结论", messages };
      }

      const tool = this.tools.get(response.toolCall.name);
      if (!tool) {
        throw new Error(`unknown tool: ${response.toolCall.name}`);
      }

      const input = tool.input.parse(response.toolCall.input);
      this.emit({ type: "tool_start", toolName: tool.name });
      const result = await tool.execute(input);
      messages.push({
        role: "tool",
        content: JSON.stringify(result),
        toolName: tool.name,
        toolInput: input,
      });
      this.emit({ type: "tool_end", toolName: tool.name, result });
    }

    throw new Error("agent turn limit exceeded");
  }
}
