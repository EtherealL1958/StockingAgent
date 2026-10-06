import {
  Editor, ProcessTerminal, ScrollView, Text, TuiAltScreen, VStack, matchesKey,
  type Terminal,
} from "@earendil-works/pi-tui";
import type { ResearchAgent, AgentMessage } from "../agent/runtime.js";
import { ChatView } from "./chat-view.js";
import { StatusBar, type TerminalMetadata } from "./status-bar.js";
import { editorTheme, safeTerminalText, theme } from "./theme.js";

const HELP = [
  "Enter 发送；Shift+Enter / Ctrl+J 换行；↑↓ 输入历史。",
  "Ctrl+T 折叠/展开公开推理；Ctrl+O 展开/收起工具详情。",
  "PageUp / PageDown 或鼠标滚轮浏览会话；Ctrl+End 回到最新消息。",
  "/help 帮助；/status 模型与会话信息；/exit 退出。",
  "执行中可以编辑下一条草稿，当前请求结束后才能发送。Ctrl+C 在执行中请求本轮结束后退出，空闲时立即退出。",
].join("\n");

/** UI subscribes to runtime events; it never executes tools or changes model context. */
export async function runTerminalUi(
  agent: ResearchAgent,
  metadata: TerminalMetadata,
  history: readonly AgentMessage[],
  terminal: Terminal = new ProcessTerminal(),
): Promise<void> {
  const tui = new TuiAltScreen(terminal, true);
  const chat = new ChatView(history);
  const status = new StatusBar(metadata);
  const editor = new Editor(tui, editorTheme, { paddingX: 1 });
  for (const message of history) if (message.role === "user") editor.addToHistory(message.content);
  const scroll = new ScrollView(chat, { follow: "end", primary: true, scrollbar: "auto" });
  tui.setLayoutRoot(new VStack([
    { component: new Text(theme.bold("StockingAgent  /  A 股研究"), 1, 0), basis: "auto", shrink: 0 },
    { component: scroll, basis: 0, grow: 1, minSize: 1 },
    // Editor manages its own cursor-aware viewport (about 30% of terminal height).
    { component: editor, basis: "auto", shrink: 0 },
    { component: status, basis: "auto", shrink: 0 },
    { component: new Text(theme.dim("Enter 发送 · Ctrl+J 换行 · Ctrl+T 思考 · Ctrl+O 工具 · /help"), 0, 0), basis: "auto", maxSize: 1, shrink: 1 },
  ]));
  tui.setFocus(editor);
  chat.notice(`已恢复 ${history.length} 条消息。思考区仅显示供应商公开返回的推理内容；未保存的历史推理不会重建。输入 /help 查看快捷键。`);

  let busy = false;
  let closing = false;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    resolveClosed();
  };
  const requestExit = (): void => {
    if (!busy) { stop(); return; }
    if (!closing) chat.notice("将在当前请求结束后退出，确保工具结果和会话完成保存。");
    closing = true;
    tui.requestRender();
  };

  const unsubscribe = agent.on(event => {
    chat.handleEvent(event);
    if (event.type === "turn_start") { status.turns += 1; status.phase = "请求模型"; }
    if (event.type === "thinking_delta") status.phase = "模型思考";
    if (event.type === "text_delta") status.phase = "生成回答";
    if (event.type === "tool_start") status.phase = `执行 ${event.toolName ?? "工具"}`;
    if (event.type === "tool_end") { status.tools += 1; status.phase = "处理工具结果"; }
    tui.requestRender();
  });

  const submit = async (input: string): Promise<void> => {
    if (!input.trim() || busy || stopped) return;
    const command = input.trim().toLowerCase();
    if (["/exit", "exit", "quit"].includes(command)) { requestExit(); return; }
    if (command === "/help") { chat.notice(HELP); tui.requestRender(); return; }
    if (command === "/status") {
      chat.notice(`模型：${metadata.modelName}\n思考强度：${metadata.reasoningEffort}\n会话：${metadata.sessionId}\n文件：${metadata.sessionFile}`);
      tui.requestRender();
      return;
    }
    if (command.startsWith("/")) { chat.notice("未知指令。输入 /help 查看指令；研究问题请直接输入自然语言。"); tui.requestRender(); return; }

    busy = true;
    editor.disableSubmit = true;
    editor.addToHistory(input);
    chat.begin(input);
    status.start();
    scroll.scrollToEnd();
    timer = setInterval(() => tui.requestRender(), 100);
    tui.requestRender();
    try {
      const result = await agent.run(input);
      chat.finish(result.answer);
      status.finish();
    } catch (error) {
      chat.fail(error instanceof Error ? error.message : "执行失败");
      status.finish("失败");
    } finally {
      clearInterval(timer);
      timer = undefined;
      busy = false;
      editor.disableSubmit = false;
      tui.requestRender();
      if (closing) stop();
    }
  };
  editor.onSubmit = input => { void submit(input); };
  const removeInputListener = tui.addInputListener(data => {
    if (matchesKey(data, "ctrl+c") || (matchesKey(data, "ctrl+d") && !editor.getText())) {
      requestExit(); return { consume: true };
    }
    if (matchesKey(data, "ctrl+t")) { chat.toggleThinking(); tui.requestRender(); return { consume: true }; }
    if (matchesKey(data, "ctrl+o")) { chat.toggleTools(); tui.requestRender(); return { consume: true }; }
    // Page navigation belongs to the transcript, not the multiline editor.
    if (matchesKey(data, "pageUp")) { scroll.scrollBy(-Math.max(1, terminal.rows - 10)); tui.requestRender(); return { consume: true }; }
    if (matchesKey(data, "pageDown")) { scroll.scrollBy(Math.max(1, terminal.rows - 10)); tui.requestRender(); return { consume: true }; }
    if (matchesKey(data, "ctrl+end")) { scroll.scrollToEnd(); tui.requestRender(); return { consume: true }; }
    return undefined;
  });
  // SIGTERM/SIGINT can also originate outside raw keyboard input.
  process.on("SIGTERM", requestExit);
  process.on("SIGINT", requestExit);
  try {
    tui.start();
    await closed;
  } finally {
    clearInterval(timer);
    unsubscribe();
    removeInputListener();
    process.off("SIGTERM", requestExit);
    process.off("SIGINT", requestExit);
    // Leave the transcript in normal terminal scrollback, without a clipped editor/footer.
    tui.setLayoutRoot(chat);
    tui.stop();
    await terminal.drainInput(200, 30);
    terminal.write(`${safeTerminalText(`会话已保存：${metadata.sessionFile}`)}\n`);
  }
}
