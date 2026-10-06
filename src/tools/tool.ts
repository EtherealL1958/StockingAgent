import { z } from "zod";
export interface ToolExecutionContext {
  readonly userMessages: readonly string[];
}

export type ToolModelParameters = Readonly<Record<string, unknown>>;

export interface AgentTool<I, O> {
  readonly name: string;
  readonly description: string;
  readonly input: z.ZodType<I>;
  /** JSON Schema sent to the model; runtime validation still uses input. */
  readonly modelParameters?: ToolModelParameters;
  execute(input: I, context?: ToolExecutionContext): Promise<O>;
  /** Render a deterministic reply and end the model turn when user input is needed. */
  userResponse?(result: O): string;
}
export function defineTool<I, O>(tool: AgentTool<I, O>): AgentTool<I, O> {
  return tool;
}
