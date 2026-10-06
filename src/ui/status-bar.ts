import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { safeTerminalText, theme } from "./theme.js";

export interface TerminalMetadata {
  readonly modelName: string;
  readonly reasoningEffort: string;
  readonly sessionId: string;
  readonly sessionFile: string;
}

export class StatusBar implements Component {
  public phase = "就绪";
  public turns = 0;
  public tools = 0;
  private startedAt: number | undefined;
  private elapsedMs = 0;

  public constructor(private readonly metadata: TerminalMetadata, private readonly now = () => performance.now()) {}
  public start(): void {
    this.startedAt = this.now();
    this.elapsedMs = 0;
    this.turns = 0;
    this.tools = 0;
    this.phase = "请求模型";
  }
  public finish(phase = "完成"): void {
    if (this.startedAt !== undefined) this.elapsedMs = this.now() - this.startedAt;
    this.startedAt = undefined;
    this.phase = phase;
  }
  public invalidate(): void {}
  public render(width: number): string[] {
    const elapsed = this.startedAt === undefined ? this.elapsedMs : this.now() - this.startedAt;
    const lines = [
      `${this.metadata.modelName}  │  思考强度: ${this.metadata.reasoningEffort}`,
      `${this.phase}  ·  ${(elapsed / 1000).toFixed(1)}s  ·  回合 ${this.turns}  ·  工具 ${this.tools}  ·  会话 ${this.metadata.sessionId.slice(0, 8)}`,
    ];
    return lines.map(line => theme.dim(truncateToWidth(safeTerminalText(line), width)));
  }
}
