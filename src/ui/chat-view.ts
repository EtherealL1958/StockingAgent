import { Container, Markdown, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { AgentEvent, AgentMessage } from "../agent/runtime.js";
import { markdownTheme, safeTerminalText, theme } from "./theme.js";

type BlockKind = "user" | "thinking" | "progress" | "answer" | "tool" | "error" | "notice";
interface DisplayOptions { thinkingVisible: boolean; toolsExpanded: boolean }
const LABELS: Record<BlockKind, string> = {
  user: "你", thinking: "思考 · 模型公开推理", progress: "过程说明",
  answer: "回答", tool: "工具", error: "错误", notice: "提示",
};

/** One retained component per message; only its streaming body is invalidated. */
class ChatBlock implements Component {
  private body: Markdown | Text;
  private content = "";
  private renderedText = "";
  public toolName: string | undefined;
  public startedAt: number | undefined;
  public detail = "";
  public state = "";

  public constructor(public kind: BlockKind, private readonly options: DisplayOptions, content = "") {
    this.body = this.createBody();
    this.setContent(content);
  }

  private createBody(): Markdown | Text {
    return this.kind === "tool" || this.kind === "thinking"
      ? new Text("", 1, 0)
      : new Markdown("", 1, 0, markdownTheme);
  }

  public setContent(content: string): void {
    this.content = content;
    this.updateBody(content);
  }

  private updateBody(text: string): void {
    if (text === this.renderedText) return;
    this.renderedText = text;
    this.body.setText(safeTerminalText(text));
  }

  public append(delta: string): void { this.setContent(this.content + delta); }
  public get text(): string { return this.content; }
  public invalidate(): void { this.body.invalidate(); }

  public render(width: number): string[] {
    const paint = this.kind === "thinking" ? theme.thinking : this.kind === "tool" ? theme.tool
      : this.kind === "error" ? theme.error : this.kind === "answer" ? theme.answer : theme.accent;
    const collapsed = this.kind === "thinking" && !this.options.thinkingVisible;
    const title = `${LABELS[this.kind]}${this.toolName ? ` · ${this.toolName}` : ""}${this.state ? ` · ${this.state}` : ""}${collapsed ? "（已折叠 · Ctrl+T）" : ""}`;
    const lines = [paint(truncateToWidth(`── ${safeTerminalText(title)} `, width))];
    if (!collapsed) {
      if (this.kind === "tool") {
        const text = this.options.toolsExpanded ? `${this.content}\n${this.detail}` : this.content;
        this.updateBody(text);
        const rendered = this.body.render(Math.max(1, width));
        const limit = this.options.toolsExpanded ? 160 : 4;
        lines.push(...rendered.slice(0, limit));
        if (rendered.length > limit || (!this.options.toolsExpanded && this.detail)) {
          lines.push(theme.dim(truncateToWidth(this.options.toolsExpanded
            ? "  …显示前 160 行；完整结果见会话文件" : "  …Ctrl+O 展开参数与结果", width)));
        }
      } else {
        lines.push(...this.body.render(Math.max(1, width)));
      }
    }
    return [...lines.map(line => truncateToWidth(line, width)), ""];
  }
}

function jsonText(value: unknown): string { return JSON.stringify(value, null, 2) ?? "无返回值"; }

export function toolResultState(value: unknown): string {
  if (typeof value !== "object" || value === null) return "完成";
  if ("error" in value && value.error) return "失败";
  if ("available" in value && value.available === false) return "不可用";
  if ("incomplete" in value && value.incomplete === true) return "数据不完整";
  if ("exitCode" in value && value.exitCode !== 0) return "失败";
  if ("timedOut" in value && value.timedOut === true) return "超时";
  return "完成";
}

export class ChatView extends Container {
  private readonly options: DisplayOptions = { thinkingVisible: true, toolsExpanded: false };
  private readonly toolBlocks = new Map<string, ChatBlock>();
  private thinkingBlock: ChatBlock | undefined;
  private answerBlock: ChatBlock | undefined;
  private finalAnswer: ChatBlock | undefined;

  public constructor(history: readonly AgentMessage[] = []) {
    super();
    // Reuse persisted facts; public reasoning deltas were never stored in JSONL.
    for (const message of history) {
      if (message.role === "user") this.addBlock("user", message.content);
      if (message.role === "assistant") {
        if (message.content) this.addBlock(message.toolCalls || message.toolName ? "progress" : "answer", message.content);
        for (const call of message.toolCalls ?? (message.toolName ? [{ id: message.toolCallId ?? "", name: message.toolName, input: message.toolInput }] : [])) {
          const block = this.startTool(call.id, call.name, call.input);
          block.state = "历史调用 · 未见结果";
        }
      }
      if (message.role === "tool") {
        let result: unknown = message.content;
        try { result = JSON.parse(message.content); } catch { /* Legacy text results are displayed verbatim. */ }
        this.endTool(message.toolCallId ?? "", message.toolName ?? "unknown", message.toolInput, result);
      }
    }
  }

  private addBlock(kind: BlockKind, content: string): ChatBlock {
    const block = new ChatBlock(kind, this.options, content);
    this.addChild(block);
    return block;
  }

  public begin(input: string): void {
    this.answerBlock = undefined;
    this.thinkingBlock = undefined;
    this.finalAnswer = undefined;
    this.addBlock("user", input);
  }

  public notice(message: string): void { this.addBlock("notice", message); }
  public fail(message: string): void { this.addBlock("error", message); }
  public toggleThinking(): void { this.options.thinkingVisible = !this.options.thinkingVisible; }
  public toggleTools(): void { this.options.toolsExpanded = !this.options.toolsExpanded; }

  public handleEvent(event: AgentEvent): void {
    if (event.type === "turn_start") {
      this.thinkingBlock = undefined;
      this.answerBlock = undefined;
    } else if (event.type === "thinking_delta" && event.delta) {
      this.thinkingBlock ??= this.addBlock("thinking", "");
      this.thinkingBlock.append(event.delta);
    } else if (event.type === "text_delta" && event.delta) {
      this.answerBlock ??= this.addBlock("progress", "");
      this.answerBlock.append(event.delta);
    } else if (event.type === "response_end") {
      const content = event.message?.content ?? "";
      if (content || this.answerBlock) {
        this.answerBlock ??= this.addBlock("progress", "");
        this.answerBlock.setContent(content);
        this.answerBlock.kind = event.final ? "answer" : "progress";
        if (event.final) this.finalAnswer = this.answerBlock;
      }
    } else if (event.type === "tool_start") {
      this.startTool(event.toolCallId ?? "", event.toolName ?? "unknown", event.input, performance.now());
    } else if (event.type === "tool_end") {
      this.endTool(event.toolCallId ?? "", event.toolName ?? "unknown", event.input, event.result);
    }
  }

  public finish(answer: string): void {
    // Direct profile confirmations and non-streaming models also produce exactly one answer.
    if (!this.finalAnswer) {
      if (this.answerBlock?.text === answer) {
        this.answerBlock.kind = "answer";
      } else {
        this.addBlock("answer", answer);
      }
    }
  }

  private startTool(id: string, name: string, input: unknown, now?: number): ChatBlock {
    const block = this.addBlock("tool", `参数：${jsonText(input)}`);
    block.toolName = name;
    block.startedAt = now;
    block.state = "执行中";
    this.toolBlocks.set(id, block);
    return block;
  }

  private endTool(id: string, name: string, input: unknown, result: unknown): void {
    const block = this.toolBlocks.get(id) ?? this.startTool(id, name, input);
    const duration = block.startedAt === undefined ? "" : ` · ${((performance.now() - block.startedAt) / 1000).toFixed(1)}s`;
    block.state = toolResultState(result) + duration;
    block.detail = `结果：${jsonText(result)}`;
    // Errors remain visible even when successful tool output is collapsed.
    if (toolResultState(result) !== "完成") block.setContent(`${block.text}\n${block.detail}`);
  }
}
