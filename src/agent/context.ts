import type { AgentMessage } from "./runtime.js";

export interface ContextManager {
  build(history: readonly AgentMessage[]): readonly AgentMessage[];
}

export interface ContextManagerOptions {
  /** 模型上下文窗口大小，单位为 token。 */
  readonly contextWindow: number;
  /** 为模型输出和后续调用预留的 token 数量。 */
  readonly reserveTokens: number;
  /** 裁剪时优先保留最近消息的 token 数量。 */
  readonly keepRecentTokens: number;
}

/** 只裁剪发送给模型的历史投影，永远不删除会话中的原始消息。 */
export class SlidingWindowContextManager implements ContextManager {
  private readonly contextWindow: number;
  private readonly reserveTokens: number;
  private readonly keepRecentTokens: number;

  public constructor(options: ContextManagerOptions) {
    if (!Number.isFinite(options.contextWindow) && options.contextWindow !== Number.POSITIVE_INFINITY) {
      throw new Error("contextWindow 必须是正数或 Infinity");
    }
    if (options.contextWindow <= 0) throw new Error("contextWindow 必须大于 0");
    if (!Number.isFinite(options.reserveTokens) || options.reserveTokens < 0) {
      throw new Error("reserveTokens 必须是非负数");
    }
    if (Number.isFinite(options.contextWindow) && options.reserveTokens >= options.contextWindow) {
      throw new Error("reserveTokens 必须小于 contextWindow");
    }
    if (!Number.isFinite(options.keepRecentTokens) || options.keepRecentTokens <= 0) {
      throw new Error("keepRecentTokens 必须大于 0");
    }
    this.contextWindow = options.contextWindow;
    this.reserveTokens = options.reserveTokens;
    this.keepRecentTokens = options.keepRecentTokens;
  }

  public build(history: readonly AgentMessage[]): readonly AgentMessage[] {
    const availableTokens = this.contextWindow - this.reserveTokens;
    if (availableTokens <= 0 || estimateTokens(history) <= availableTokens) return history;

    const recentBudget = Math.min(this.keepRecentTokens, availableTokens);
    let start = history.length;
    let recentTokens = 0;
    while (start > 0) {
      const messageTokens = estimateTokens([history[start - 1]!]);
      if (start < history.length && recentTokens + messageTokens > recentBudget) break;
      start -= 1;
      recentTokens += messageTokens;
    }

    // 不从 assistant/tool 消息中间切断一次工具交互，向前扩展到 user 边界。
    while (start > 0 && history[start]?.role !== "user") start -= 1;
    const omitted = start;
    if (omitted === 0) return history;
    return [
      {
        role: "system",
        content: `[上下文管理] 已省略较早的 ${omitted} 条消息。完整历史仍保存在会话文件中；不要猜测被省略的事实，如需恢复请让用户重新查询。`,
      },
      ...history.slice(start),
    ];
  }
}

/** 估算消息 token 数；实际请求仍由具体模型的 tokenizer 决定。 */
export function estimateTokens(messages: readonly AgentMessage[]): number {
  const characters = messages.reduce(
    (total, message) => total + message.content.length + JSON.stringify(message.toolInput ?? "").length + 32,
    0,
  );
  return Math.max(1, Math.ceil(characters / 4));
}
