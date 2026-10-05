import { z } from "zod";
export interface AgentTool<I, O> {
  readonly name: string;
  readonly description: string;
  readonly input: z.ZodType<I>;
  execute(input: I): Promise<O>;
}
export function defineTool<I, O>(tool: AgentTool<I, O>): AgentTool<I, O> {
  return tool;
}
