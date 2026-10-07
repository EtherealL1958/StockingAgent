import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonUserProfileStore, userProfileSchema } from "../src/memory/user-profile.js";
import { buildUserMemoryTools } from "../src/tools/user-memory-tools.js";
import { ResearchAgent } from "../src/agent/runtime.js";
import { JsonlSessionStore } from "../src/agent/session.js";

const readProfile = async (store: JsonUserProfileStore) =>
  userProfileSchema.parse(JSON.parse(await readFile(store.filePath, "utf8")));

test("short replies bind to the displayed proposal and support partial confirmation and retry", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "stocking-confirmation-"));
  try {
    const store = await JsonUserProfileStore.open({ cwd });
    await store.propose({ investableCash: 5000, monthlyContribution: 200 },
      { investableCash: "本金5000", monthlyContribution: "每月200" }, ["本金5000，每月200"]);
    const oldPrompt = store.pendingPrompt;
    assert.equal(await store.handleUserReply("确认"), undefined);
    assert.equal(await store.handleUserReply("确认", "确认要分析这只股票吗？"), undefined);
    assert.equal(await store.handleUserReply("除第2点为300外，其他不变", oldPrompt), undefined);
    assert.equal(store.snapshot.investableCash, undefined);

    await store.propose({ monthlyContribution: 300 }, { monthlyContribution: "改成300" }, ["改成300"]);
    assert.equal(await store.handleUserReply("确认", oldPrompt), undefined);
    const invalid = await store.handleUserReply("确认 99", store.pendingPrompt);
    assert.equal(invalid?.continueTask, false);
    const accepted = await store.handleUserReply("确认 2", invalid?.message);
    assert.equal(accepted?.continueTask, true);
    assert.equal(store.snapshot.monthlyContribution, 300);
    assert.equal(store.snapshot.investableCash, undefined);
    assert.equal(store.pendingPrompt, undefined);
    assert.equal((await readProfile(store)).confirmations?.monthlyContribution?.userReply, "确认 2");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("unchanged values do not create proposals; pending corrections merge and repeated proposals retain IDs", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "stocking-profile-dedup-"));
  try {
    const store = await JsonUserProfileStore.open({ cwd });
    await store.propose({ investableCash: 5000 }, { investableCash: "本金5000" }, ["本金5000"]);
    await store.handleUserReply("确认", store.pendingPrompt);
    const before = await readFile(store.filePath, "utf8");
    const unchanged = await store.propose({ investableCash: 5000 }, { investableCash: "本金5000" }, ["本金5000"]);
    assert.equal(unchanged.requiresConfirmation, false);
    assert.deepEqual(unchanged.ignoredFields, ["investableCash"]);
    assert.equal(await readFile(store.filePath, "utf8"), before);

    const mixed = await store.propose({ investableCash: 5000, monthlyContribution: 200 },
      { investableCash: "本金5000", monthlyContribution: "每月200" }, ["本金5000，每月200"]);
    assert.deepEqual(mixed.ignoredFields, ["investableCash"]);
    const first = (await readProfile(store)).pending;
    assert.deepEqual(first?.patch, { monthlyContribution: 200 });
    await store.propose({ monthlyContribution: 200 }, { monthlyContribution: "200" }, ["200"]);
    assert.equal((await readProfile(store)).pending?.id, first?.id);
    await store.propose({ horizonYears: 1 }, { horizonYears: "放1年" }, ["放1年"]);
    const merged = (await readProfile(store)).pending;
    assert.deepEqual(merged?.patch, { monthlyContribution: 200, horizonYears: 1 });
    assert.equal(merged?.evidence.monthlyContribution, "每月200");
    assert.notEqual(merged?.id, first?.id);
    assert.equal((await store.handleUserReply(`确认画像 ${first?.id} 全部`))?.continueTask, false);
    await store.handleUserReply("取消画像", store.pendingPrompt);
    assert.equal(store.snapshot.investableCash, 5000);
    assert.equal(store.snapshot.monthlyContribution, undefined);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("legacy values still need one confirmation, then survive reopening without re-confirmation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "stocking-legacy-confirm-"));
  try {
    const filePath = join(cwd, "profile.json");
    await writeFile(filePath, JSON.stringify({ version: 1, userId: "default", updatedAt: "2026-10-06T10:18:04.193Z", investableCash: 5000 }));
    const store = await JsonUserProfileStore.open({ cwd, filePath });
    const result = await store.propose({ investableCash: 5000 }, { investableCash: "本金5000" }, ["本金5000"]);
    assert.equal(result.requiresConfirmation, true);
    assert.deepEqual(result.ignoredFields, []);
    assert.equal(store.snapshot.investableCash, undefined);
    await store.handleUserReply("确认", result.message);
    const reopened = await JsonUserProfileStore.open({ cwd, filePath });
    assert.equal(reopened.snapshot.investableCash, 5000);
    assert.deepEqual(reopened.unverifiedFields, []);
    assert.equal((await reopened.propose({ investableCash: 5000 }, { investableCash: "其他不变" }, ["其他不变"])).requiresConfirmation, false);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("restored session accepts a short confirmation and resumes research with committed data", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "stocking-resume-confirm-"));
  try {
    const store = await JsonUserProfileStore.open({ cwd });
    const staticContext = { systemPrompt: "fixture", toolDefinitions: [] };
    const session = await JsonlSessionStore.open({ cwd, staticContext });
    const source = "帮我设计ETF计划，每月200元";
    const agent = new ResearchAgent(buildUserMemoryTools(store), {
      respond: async () => ({ done: false, toolCall: { name: "update_user_profile", input: {
        changes: { monthlyContribution: 200 }, evidence: { monthlyContribution: "每月200元" },
      } } }),
    }, { session, handleUserReply: (input, prompt) => store.handleUserReply(input, prompt) });
    await agent.run(source);

    const reopenedStore = await JsonUserProfileStore.open({ cwd });
    const restored = await JsonlSessionStore.open({ cwd, filePath: session.filePath, staticContext });
    let calls = 0;
    const resumed = new ResearchAgent(buildUserMemoryTools(reopenedStore), {
      respond: async messages => {
        calls += 1;
        assert.equal(reopenedStore.snapshot.monthlyContribution, 200);
        assert.ok(messages.some(message => message.role === "user" && message.content === source));
        assert.match(messages.at(-1)?.content ?? "", /"monthlyContribution":200/);
        if (calls === 1) return { done: false, toolCall: { name: "update_user_profile", input: {
          changes: { monthlyContribution: 200 }, evidence: { monthlyContribution: "每月200元" },
        } } }; // Even an unnecessary repeated model update must not pause for confirmation again.
        return { done: true, content: "继续 ETF 研究，缺少本金信息时不编造仓位" };
      },
    }, { session: restored,
      handleUserReply: (input, prompt) => reopenedStore.handleUserReply(input, prompt),
      dynamicContextProvider: () => reopenedStore.toPromptContext(),
    });
    const response = await resumed.run("确认");
    assert.equal(calls, 2);
    assert.match(response.answer, /继续 ETF 研究/);
    assert.equal(reopenedStore.pendingPrompt, undefined);
    assert.ok(restored.history.some(message => message.role === "assistant" && message.content.includes("已保存确认的 1 个字段")));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("a model failure after confirmation does not erase the committed profile", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "stocking-confirm-failure-"));
  try {
    const store = await JsonUserProfileStore.open({ cwd });
    await store.propose({ monthlyContribution: 200 }, { monthlyContribution: "每月200" }, ["每月200"]);
    const pending = (await readProfile(store)).pending;
    const agent = new ResearchAgent([], { respond: async () => { throw new Error("fixture model unavailable"); } }, {
      handleUserReply: (input, prompt) => store.handleUserReply(input, prompt),
    });
    await assert.rejects(agent.run(`确认画像 ${pending?.id} 全部`), /fixture model unavailable/);
    assert.equal((await JsonUserProfileStore.open({ cwd })).snapshot.monthlyContribution, 200);
    assert.equal(store.pendingPrompt, undefined);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
