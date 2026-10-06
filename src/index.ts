import "dotenv/config";

import { ResearchAgent } from "./agent/runtime.js";
import { RuleBasedResearchModel } from "./agent/rule-model.js";
import { createMarketDataProvider } from "./app/provider.js";
import { buildMarketTools } from "./tools/market-tools.js";

const agent = new ResearchAgent(
  buildMarketTools(createMarketDataProvider()),
  new RuleBasedResearchModel(),
);
agent.on(event => {
  if (event.type === "tool_start" || event.type === "tool_end") {
    console.log(`[${event.type}] ${event.toolName}`);
  }
});

const result = await agent.run("请研究 510300 的最新报价");
console.log(result.answer);
