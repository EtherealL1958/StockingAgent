import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentMessage, AgentToolCall } from "./runtime.js";

export interface SessionToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

/** 发送给模型的静态前缀；它不会随对话消息重复写入历史。 */
export interface SessionStaticContext {
  readonly systemPrompt: string;
  readonly toolDefinitions: readonly SessionToolDefinition[];
}

export interface AgentSession {
  readonly id: string;
  readonly filePath: string;
  readonly createdAt: string;
  readonly staticContext: SessionStaticContext;
  readonly history: readonly AgentMessage[];
  append(message: AgentMessage): Promise<void>;
}

export interface OpenSessionOptions {
  readonly cwd: string;
  readonly directory?: string;
  readonly filePath?: string;
  readonly staticContext: SessionStaticContext;
}

const sessionHeaderSchema = z.object({
  type: z.literal("session"),
  version: z.literal(1),
  id: z.string().min(1),
  createdAt: z.string().datetime(),
  cwd: z.string().min(1),
  staticContext: z.object({
    systemPrompt: z.string(),
    toolDefinitions: z.array(z.object({
      name: z.string().min(1),
      description: z.string(),
      parameters: z.record(z.unknown()),
    })),
  }),
});

const messageEntrySchema = z.object({
  type: z.literal("message"),
  timestamp: z.string().datetime(),
  message: z.object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.string(),
    toolCalls: z.array(z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      input: z.unknown(),
    })).optional(),
    toolName: z.string().optional(),
    toolInput: z.unknown().optional(),
    toolCallId: z.string().optional(),
    contextMetadata: z.object({
      archivePath: z.string().optional(),
      preview: z.string().optional(),
      importance: z.enum(["high", "normal", "low"]).optional(),
    }).optional(),
  }),
});

const contextEntrySchema = z.object({
  type: z.literal("context"),
  timestamp: z.string().datetime(),
  staticContext: sessionHeaderSchema.shape.staticContext,
});

type SessionEntry = z.infer<typeof messageEntrySchema> | z.infer<typeof contextEntrySchema>;

/**
 * 线性 JSONL 会话存储。
 *
 * 原始消息只追加、不覆盖，启动时重放文件即可恢复历史。后续如需
 * `/fork` 或树状分支，可以在此格式上增加 parentId，而不会改变 Agent 接口。
 */
export class JsonlSessionStore implements AgentSession {
  private readonly messages: AgentMessage[];

  private constructor(
    public readonly id: string,
    public readonly filePath: string,
    public readonly createdAt: string,
    staticContext: SessionStaticContext,
    messages: readonly AgentMessage[],
  ) {
    this.currentStaticContext = staticContext;
    this.messages = [...messages];
  }

  private currentStaticContext: SessionStaticContext;

  public get staticContext(): SessionStaticContext {
    return this.currentStaticContext;
  }

  public get history(): readonly AgentMessage[] {
    return this.messages;
  }

  public static async open(options: OpenSessionOptions): Promise<JsonlSessionStore> {
    const filePath = await resolveSessionPath(options);
    try {
      const text = await fs.readFile(filePath, "utf8");
      const store = JsonlSessionStore.fromText(filePath, text);
      if (JSON.stringify(store.staticContext) !== JSON.stringify(options.staticContext)) {
        await store.updateStaticContext(options.staticContext);
      }
      return store;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      const store = new JsonlSessionStore(id, filePath, createdAt, options.staticContext, []);
      await store.createFile(options.cwd);
      return store;
    }
  }

  public async append(message: AgentMessage): Promise<void> {
    const normalized = normalizeMessage(message);
    const entry = {
      type: "message" as const,
      timestamp: new Date().toISOString(),
      message: normalized,
    };
    await fs.appendFile(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
    this.messages.push(normalized);
  }

  private async updateStaticContext(staticContext: SessionStaticContext): Promise<void> {
    const entry = {
      type: "context" as const,
      timestamp: new Date().toISOString(),
      staticContext,
    };
    await fs.appendFile(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
    this.currentStaticContext = staticContext;
  }

  private async createFile(cwd: string): Promise<void> {
    await fs.mkdir(dirname(this.filePath), { recursive: true });
    const header = {
      type: "session" as const,
      version: 1 as const,
      id: this.id,
      createdAt: this.createdAt,
      cwd,
      staticContext: this.staticContext,
    };
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(header)}\n`, "utf8");
    await fs.rename(temporaryPath, this.filePath);
  }

  private static fromText(filePath: string, text: string): JsonlSessionStore {
    const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
    const firstLine = lines[0];
    if (!firstLine) throw new Error(`会话文件为空: ${filePath}`);
    const header = sessionHeaderSchema.parse(JSON.parse(firstLine));
    const messages: AgentMessage[] = [];
    let staticContext: SessionStaticContext = header.staticContext;
    for (const line of lines.slice(1)) {
      const raw: unknown = JSON.parse(line);
      const entry = parseEntry(raw, filePath);
      if (entry.type === "message") messages.push(normalizePersistedMessage(entry.message));
      if (entry.type === "context") staticContext = entry.staticContext;
    }

    return new JsonlSessionStore(header.id, filePath, header.createdAt, staticContext, messages);
  }
}

function parseEntry(raw: unknown, filePath: string): SessionEntry {
  if (!isRecord(raw) || !("type" in raw)) {
    throw new Error(`会话记录缺少 type: ${filePath}`);
  }
  const type = raw.type;
  if (type === "message") return messageEntrySchema.parse(raw);
  if (type === "context") return contextEntrySchema.parse(raw);
  throw new Error(`不支持的会话记录类型: ${String(type)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeMessage(message: AgentMessage): AgentMessage {
  return {
    role: message.role,
    content: message.content,
    ...(message.toolCalls ? { toolCalls: message.toolCalls.map(normalizeToolCall) } : {}),
    ...(message.toolName ? { toolName: message.toolName } : {}),
    ...(message.toolInput !== undefined ? { toolInput: message.toolInput } : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.contextMetadata ? { contextMetadata: message.contextMetadata } : {}),
  };
}

function normalizePersistedMessage(message: z.infer<typeof messageEntrySchema>["message"]): AgentMessage {
  return {
    role: message.role,
    content: message.content,
    ...(message.toolCalls ? { toolCalls: message.toolCalls.map(normalizeToolCall) } : {}),
    ...(message.toolName !== undefined ? { toolName: message.toolName } : {}),
    ...(message.toolInput !== undefined ? { toolInput: message.toolInput } : {}),
    ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
    ...(message.contextMetadata !== undefined ? { contextMetadata: normalizeContextMetadata(message.contextMetadata) } : {}),
  };
}

function normalizeToolCall(call: { readonly id: string; readonly name: string; readonly input?: unknown }): AgentToolCall {
  return { id: call.id, name: call.name, input: call.input };
}

function normalizeContextMetadata(metadata: NonNullable<z.infer<typeof messageEntrySchema>["message"]["contextMetadata"]>): NonNullable<AgentMessage["contextMetadata"]> {
  return {
    ...(metadata.archivePath !== undefined ? { archivePath: metadata.archivePath } : {}),
    ...(metadata.preview !== undefined ? { preview: metadata.preview } : {}),
    ...(metadata.importance !== undefined ? { importance: metadata.importance } : {}),
  };
}

async function resolveSessionPath(options: OpenSessionOptions): Promise<string> {
  if (options.filePath) return isAbsolute(options.filePath) ? options.filePath : resolve(options.cwd, options.filePath);
  const directory = options.directory
    ? (isAbsolute(options.directory) ? options.directory : resolve(options.cwd, options.directory))
    : resolve(options.cwd, ".stocking", "sessions");
  await fs.mkdir(directory, { recursive: true });
  const entries = (await fs.readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith(".jsonl"))
    .sort((left, right) => right.name.localeCompare(left.name));
  return join(directory, entries[0]?.name ?? `${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID()}.jsonl`);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
