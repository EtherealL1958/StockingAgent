import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { stripTerminalSequences, visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import { z } from "zod";
import { ResearchAgent } from "../src/agent/runtime.js";
import { ChatCompletionsResearchModel } from "../src/agent/chat-completions-model.js";
import { RuleBasedResearchModel } from "../src/agent/rule-model.js";
import { defineTool } from "../src/tools/tool.js";
import { ChatView, toolResultState } from "../src/ui/chat-view.js";
import { StatusBar } from "../src/ui/status-bar.js";
import { safeTerminalText } from "../src/ui/theme.js";
import { runTerminalUi } from "../src/ui/terminal-ui.js";

const metadata = { modelName: "fixture-model", reasoningEffort: "供应商默认", sessionId: "session-fixture", sessionFile: "/tmp/session-fixture.jsonl" };
const display = (view: ChatView, width = 80) => stripTerminalSequences(view.render(width).join("\n"));

test("TUI separates public reasoning, tool progress and a single final answer", async () => {
  const view = new ChatView();
  let turn = 0;
  const agent = new ResearchAgent([defineTool({
    name: "quote", description: "fixture", input: z.object({}), execute: async () => ({ available: true, price: 10 }),
  })], {
    respond: async (_messages, callbacks) => {
      if (turn++ === 0) {
        callbacks?.onThinkingDelta?.("检查证据。");
        callbacks?.onTextDelta?.("先查询报价。");
        return { done: false, content: "先查询报价。", toolCall: { id: "call-1", name: "quote", input: {} } };
      }
      callbacks?.onTextDelta?.("最终");
      callbacks?.onTextDelta?.("答复。");
      return { done: true, content: "最终答复。" };
    },
  });
  view.begin("测试");
  agent.on(event => view.handleEvent(event));
  const result = await agent.run("测试");
  view.finish(result.answer);
  const text = display(view);
  assert.match(text, /思考 · 模型公开推理/);
  assert.match(text, /过程说明/);
  assert.match(text, /工具 · quote · 完成/);
  assert.match(text, /── 回答/);
  assert.equal(text.split("最终答复。").length - 1, 1);
  view.toggleThinking();
  assert.doesNotMatch(display(view), /检查证据/);
  view.toggleTools();
  assert.match(display(view), /"price": 10/);
});

test("restored tools stay associated by ID, including validation failures without start", () => {
  const view = new ChatView([
    { role: "assistant", content: "", toolCalls: [{ id: "a", name: "quote", input: { ticker: "1" } }, { id: "b", name: "quote", input: { ticker: "2" } }] },
    { role: "tool", toolCallId: "a", toolName: "quote", content: '{"available":true}' },
    { role: "tool", toolCallId: "b", toolName: "quote", content: '{"available":false,"error":{"message":"失败样本"}}' },
  ]);
  view.handleEvent({ type: "tool_end", toolCallId: "c", toolName: "unknown", result: { error: { message: "未知工具" } } });
  const text = display(view);
  assert.match(text, /quote · 完成/);
  assert.match(text, /quote · 失败/);
  assert.match(text, /unknown · 失败/);
  assert.equal(toolResultState({ available: false }), "不可用");
  assert.equal(toolResultState({ incomplete: true }), "数据不完整");
});

test("status time freezes at completion and Chinese markdown fits narrow terminals", () => {
  let now = 0;
  const status = new StatusBar(metadata, () => now);
  status.start(); now = 2500;
  assert.match(stripTerminalSequences(status.render(100).join("\n")), /2.5s/);
  status.finish(); now = 5000;
  assert.match(stripTerminalSequences(status.render(100).join("\n")), /2.5s/);
  const view = new ChatView([{ role: "assistant", content: "# 风险分析\n\n| 标的 | 风险 |\n| --- | --- |\n| 沪深300 🧑‍💻 | 波动风险 |\n\n```ts\nconst x = 1;\n```" }]);
  for (const width of [12, 30, 80]) {
    for (const line of [...view.render(width), ...status.render(width)]) assert.ok(visibleWidth(line) <= width);
  }
  assert.equal(safeTerminalText("报价\x1b[2J\x1b]52;c;secret\x07\n下一行"), "报价\n下一行");
});

test("direct user confirmation and non-streaming replies render only once", () => {
  const view = new ChatView();
  view.begin("确认画像");
  view.handleEvent({ type: "text_delta", delta: "已确认" });
  view.finish("已确认");
  assert.equal(display(view).split("已确认").length - 1, 1);
  assert.match(display(view), /── 回答/);
});

test("configured reasoning effort is sent unchanged; defaults are omitted", async () => {
  for (const effort of [undefined, "high"] as const) {
    const model = new ChatCompletionsResearchModel({
      apiKey: "fixture", model: "fixture", systemPrompt: "fixture",
      ...(effort ? { reasoningEffort: effort } : {}),
      fetchFn: async (_url, init) => {
        const body: unknown = JSON.parse(String(init?.body));
        assert.ok(typeof body === "object" && body !== null);
        assert.equal("reasoning_effort" in body ? body.reasoning_effort : undefined, effort);
        return new Response(JSON.stringify({ choices: [{ message: { content: "完成" } }] }));
      },
    }, []);
    await model.respond([]);
  }
});

class TestTerminal implements Terminal {
  columns = 80;
  rows = 24;
  kittyProtocolActive = false;
  output = "";
  stopped = false;
  input: (data: string) => void = () => {};
  resize: () => void = () => {};
  start(input: (data: string) => void, resize: () => void): void { this.input = input; this.resize = resize; }
  stop(): void { this.stopped = true; }
  async drainInput(): Promise<void> {}
  write(data: string): void { this.output += data; }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail("TUI condition did not complete");
}

test("TUI recovers after failure, accepts the next turn, resizes and restores terminal", async () => {
  const terminal = new TestTerminal();
  let calls = 0;
  const agent = new ResearchAgent([], {
    respond: async () => { if (calls++ === 0) throw new Error("fixture outage"); return { done: true, content: "恢复成功" }; },
  });
  const ui = runTerminalUi(agent, metadata, [], terminal);
  try {
    terminal.input("问题1"); terminal.input("\r");
    await until(() => terminal.output.includes("fixture outage"));
    terminal.columns = 32; terminal.resize();
    terminal.input("问题2"); terminal.input("\r");
    await until(() => terminal.output.includes("恢复成功"));
    terminal.input("\x14"); terminal.input("\x0f");
    terminal.input("/exit"); terminal.input("\r");
    await ui;
    assert.equal(terminal.stopped, true);
    assert.match(terminal.output, /\x1b\[\?1049l/);
  } finally { terminal.input("\x03"); await ui; }
});

test("rule model ignores dynamic system status at the end of the trajectory", async () => {
  const response = await new RuleBasedResearchModel().respond([
    { role: "user", content: "查询 510300" }, { role: "system", content: "用户画像" },
  ]);
  assert.equal(response.toolCall?.name, "get_quote");
});

test("busy TUI retains drafts and waits for an in-flight request before exit", async () => {
  const terminal = new TestTerminal();
  let resolveModel: () => void = () => {};
  const modelReady = new Promise<void>(resolve => { resolveModel = resolve; });
  let calls = 0;
  const agent = new ResearchAgent([], {
    respond: async () => {
      calls += 1;
      await modelReady;
      return { done: true, content: "等待完成" };
    },
  });
  const ui = runTerminalUi(agent, metadata, [], terminal);
  try {
    terminal.input("查询"); terminal.input("\r");
    await until(() => calls === 1);
    terminal.input("下一条草稿"); terminal.input("\r");
    assert.equal(calls, 1);
    terminal.input("\x03");
    assert.equal(terminal.stopped, false);
    resolveModel();
    await ui;
    assert.equal(calls, 1);
    assert.equal(terminal.stopped, true);
    assert.match(terminal.output, /等待完成/);
  } finally { resolveModel(); terminal.input("\x03"); await ui; }
});
