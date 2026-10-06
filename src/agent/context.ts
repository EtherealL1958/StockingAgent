import type { AgentMessage } from "./runtime.js";

export interface ContextManager {
  build(history: readonly AgentMessage[]): readonly AgentMessage[];
}

export interface ContextManagerOptions {
  /** 近似字符预算；0 表示不裁剪。 */
  readonly maxCharacters?: number;
  /** 裁剪时至少保留最近多少条消息，并向前扩展到 user 消息边界。 */
  readonly keepRecentMessages?: number;
}

/**
 * 保留完整持久化历史，同时只在发给模型的投影上做滑动窗口。
 * 这避免了静默删除原始记录，也为后续接入 LLM compaction 留出接口。
 */
export class SlidingWindowContextManager implements ContextManager {
  private readonly maxCharacters: number;
  private readonly keepRecentMessages: number;

  public constructor(options: ContextManagerOptions = {}) {
    this.maxCharacters = options.maxCharacters ?? 0;
    this.keepRecentMessages = Math.max(1, options.keepRecentMessages ?? 40);
  }

  public build(history: readonly AgentMessage[]): readonly AgentMessage[] {
    if (this.maxCharacters <= 0 || estimateCharacters(history) <= this.maxCharacters) return history;
    const start = Math.max(0, history.length - this.keepRecentMessages);
    let boundary = start;
    while (boundary > 0 && history[boundary]?.role !== "user") boundary -= 1;
    const omitted = boundary;
    return [
      {
        role: "system",
        content: `[上下文管理] 已省略较早的 ${omitted} 条消息。完整历史仍保存在会话文件中；不要猜测被省略的事实，如需恢复请让用户重新查询。`,
      },
      ...history.slice(boundary),
    ];
  }
}

export function estimateCharacters(messages: readonly AgentMessage[]): number {
  return messages.reduce((total, message) => total + message.content.length + JSON.stringify(message.toolInput ?? "").length + 32, 0);
}
