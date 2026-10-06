import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentMessage } from "./runtime.js";

export type ContextCompressor = (messages: readonly AgentMessage[]) => Promise<string>;

export interface ContextManager {
  build(history: readonly AgentMessage[]): readonly AgentMessage[];
  /** 异步分层压缩入口；旧的自定义 ContextManager 仍可只实现 build。 */
  buildAsync?(history: readonly AgentMessage[], compressor?: ContextCompressor): Promise<readonly AgentMessage[]>;
  /** 在消息写入会话前归档过大的工具结果。 */
  prepareMessage?(message: AgentMessage): Promise<AgentMessage>;
}

export interface ContextManagerOptions {
  /** 模型上下文窗口大小，单位为 token。 */
  readonly contextWindow: number;
  /** 为模型输出、静态前缀和后续调用预留的 token 数量。 */
  readonly reserveTokens: number;
  /** 裁剪时优先保留最近消息的 token 数量。 */
  readonly keepRecentTokens: number;
  /** 单条工具结果超过该大小后写入磁盘，只把预览放进模型上下文。 */
  readonly maxToolResultTokens?: number;
  /** 归档工具结果在上下文中保留的预览大小。 */
  readonly toolPreviewTokens?: number;
  /** 工具结果和压缩快照的目录。 */
  readonly archiveDirectory?: string;
  /** 全量压缩连续失败多少次后停止尝试。 */
  readonly maxCompressionFailures?: number;
}

/**
 * 分层上下文管理：工具结果归档、重复噪声删除、轮次摘要、token 滑窗，
 * 最后才使用可选的 LLM 压缩。原始 JSONL 历史永远不被改写。
 */
export class SlidingWindowContextManager implements ContextManager {
  private readonly contextWindow: number;
  private readonly reserveTokens: number;
  private readonly keepRecentTokens: number;
  private readonly maxToolResultTokens: number;
  private readonly toolPreviewTokens: number;
  private readonly archiveDirectory: string | undefined;
  private readonly maxCompressionFailures: number;
  private compressionFailures = 0;

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
    this.maxToolResultTokens = options.maxToolResultTokens ?? 2_000;
    this.toolPreviewTokens = options.toolPreviewTokens ?? 320;
    this.archiveDirectory = options.archiveDirectory;
    this.maxCompressionFailures = Math.max(1, options.maxCompressionFailures ?? 3);
  }

  public async prepareMessage(message: AgentMessage): Promise<AgentMessage> {
    if (message.role !== "tool" || estimateTokens([message]) <= this.maxToolResultTokens || !this.archiveDirectory) {
      return message;
    }
    const archivePath = join(this.archiveDirectory, `tool-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.json`);
    await fs.mkdir(dirname(archivePath), { recursive: true });
    await fs.writeFile(archivePath, JSON.stringify({ version: 1, createdAt: new Date().toISOString(), message }), "utf8");
    return {
      ...message,
      contextMetadata: {
        archivePath,
        preview: previewText(message.content, this.toolPreviewTokens),
        importance: "normal",
      },
    };
  }

  public async buildAsync(history: readonly AgentMessage[], compressor?: ContextCompressor): Promise<readonly AgentMessage[]> {
    const projected = this.build(history);
    const availableTokens = this.contextWindow - this.reserveTokens;
    if (!compressor || this.compressionFailures >= this.maxCompressionFailures || estimateTokens(projected) <= availableTokens) {
      return projected;
    }
    const boundary = findRecentBoundary(history, this.keepRecentTokens);
    if (boundary <= 0) return projected;
    try {
      // 压缩请求本身也遵循归档和预览规则，避免把完整工具结果再次发送给模型。
      const compressibleHistory = projectMessages(history.slice(0, boundary), findDuplicateToolMessages(history.slice(0, boundary)));
      const compressedSummary = await compressor(compressibleHistory);
      if (!compressedSummary.trim()) throw new Error("压缩模型返回空摘要");
      const recentMessages = projectMessages(history.slice(boundary), new Set());
      const summaryBudget = Math.max(32, availableTokens - estimateTokens(recentMessages) - 32);
      const summary = previewText(compressedSummary, summaryBudget);
      this.compressionFailures = 0;
      return [
        { role: "system", content: `[全量压缩摘要]\n${summary}` },
        ...recentMessages,
      ];
    } catch {
      this.compressionFailures += 1;
      return projected;
    }
  }

  public build(history: readonly AgentMessage[]): readonly AgentMessage[] {
    const availableTokens = this.contextWindow - this.reserveTokens;
    if (availableTokens <= 0 || estimateTokens(history) <= availableTokens) return projectMessages(history, new Set());

    const boundary = findRecentBoundary(history, Math.min(this.keepRecentTokens, availableTokens));
    if (boundary <= 0) return projectMessages(history, new Set());
    const omitted = history.slice(0, boundary);
    const duplicateNoise = findDuplicateToolMessages(omitted);
    const summary = summarizeTurns(omitted, duplicateNoise);
    return [
      { role: "system", content: `[归档式上下文摘要：已省略较早的 ${boundary} 条消息]\n${summary}` },
      ...projectMessages(history.slice(boundary), new Set()),
    ];
  }
}

function projectMessages(messages: readonly AgentMessage[], noise: ReadonlySet<number>): readonly AgentMessage[] {
  return messages.filter((_, index) => !noise.has(index)).map(message => {
    if (message.role !== "tool" || !message.contextMetadata?.preview) return message;
    return {
      ...message,
      content: `[工具结果已归档：${message.contextMetadata.archivePath ?? "本地归档"}]\n${message.contextMetadata.preview}`,
    };
  });
}

function findRecentBoundary(history: readonly AgentMessage[], recentBudget: number): number {
  let start = history.length;
  let recentTokens = 0;
  while (start > 0) {
    const messageTokens = estimateTokens([history[start - 1]!]);
    if (start < history.length && recentTokens + messageTokens > recentBudget) break;
    start -= 1;
    recentTokens += messageTokens;
  }
  while (start > 0 && history[start]?.role !== "user") start -= 1;
  return start;
}

function findDuplicateToolMessages(messages: readonly AgentMessage[]): ReadonlySet<number> {
  const seen = new Set<string>();
  const duplicates = new Set<number>();
  messages.forEach((message, index) => {
    if (message.role !== "tool") return;
    const key = `${message.toolName ?? "tool"}:${message.content}`;
    if (seen.has(key)) duplicates.add(index);
    else seen.add(key);
  });
  return duplicates;
}

function summarizeTurns(messages: readonly AgentMessage[], noise: ReadonlySet<number>): string {
  const lines: string[] = [];
  let turn = 0;
  for (let index = 0; index < messages.length; index += 1) {
    if (noise.has(index)) continue;
    const message = messages[index]!;
    if (message.role === "user") {
      turn += 1;
      lines.push(`轮次 ${turn} 用户任务：${previewText(message.content, 180)}`);
    } else if (message.role === "assistant" && message.toolName) {
      lines.push(`轮次 ${turn} 调用工具：${message.toolName}(${previewText(JSON.stringify(message.toolInput ?? {}), 120)})`);
    } else if (message.role === "tool") {
      lines.push(`轮次 ${turn} 工具结果：${message.toolName ?? "unknown"}；${previewText(message.content, 180)}`);
    } else if (message.role === "assistant") {
      lines.push(`轮次 ${turn} 模型回复：${previewText(message.content, 220)}`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : "较早历史已归档，当前没有可提取的摘要。";
}

function previewText(value: string, tokenBudget: number): string {
  const maxCharacters = Math.max(32, tokenBudget * 4);
  return value.length <= maxCharacters ? value : `${value.slice(0, maxCharacters)}…[预览已截断]`;
}

/** 估算消息 token 数；实际请求仍由具体模型的 tokenizer 决定。 */
export function estimateTokens(messages: readonly AgentMessage[]): number {
  const characters = messages.reduce(
    (total, message) => total + message.content.length + JSON.stringify(message.toolInput ?? "").length + 32,
    0,
  );
  return Math.max(1, Math.ceil(characters / 4));
}
