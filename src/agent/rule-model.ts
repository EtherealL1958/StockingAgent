import type { AgentMessage, AgentModel, ModelResponse } from "./runtime.js";

export class RuleBasedResearchModel implements AgentModel {
  public async respond(messages: readonly AgentMessage[]): Promise<ModelResponse> {
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage) {
      return { done: true, content: "没有输入" };
    }

    if (lastMessage.role === "user") {
      const ticker = lastMessage.content.match(/\b(\d{6})\b/)?.[1];
      if (!ticker) {
        return {
          done: true,
          content: "请提供六位 A 股证券代码；我不会在缺少数据时猜测结论。",
        };
      }
      return {
        done: false,
        toolCall: { name: "get_quote", input: { ticker } },
      };
    }

    if (lastMessage.role === "tool" && lastMessage.toolName === "get_quote") {
      return {
        done: true,
        content: `已取得 ${JSON.stringify(lastMessage.toolInput)} 的报价数据。请结合数据日期、风险约束和其他基本面工具继续研究；报价本身不是买入建议。`,
      };
    }

    return {
      done: true,
      content: "数据已取得，但当前规则模型不会在数据不足时补全投资结论。",
    };
  }
}
