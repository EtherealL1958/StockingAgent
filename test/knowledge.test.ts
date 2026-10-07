import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { discoverKnowledgeTopics, discoverSkills, formatKnowledgeCatalog, formatSkillCatalog } from "../src/agent/resources.js";
import { buildSystemPrompt } from "../src/cli.js";
import { ChatCompletionsResearchModel } from "../src/agent/chat-completions-model.js";
import { buildGeneralTools } from "../src/tools/general-tools.js";

test("knowledge catalog reaches the model request without loading topic bodies", async () => {
  const topics = discoverKnowledgeTopics(process.cwd());
  assert.equal(topics.length, 7);
  const tools = buildGeneralTools(process.cwd());
  const [read] = tools;
  assert.ok(read);
  const systemPrompt = buildSystemPrompt(
    formatSkillCatalog(discoverSkills(process.cwd())), formatKnowledgeCatalog(topics),
  );
  const requestSchema = z.object({ messages: z.array(z.object({ role: z.string(), content: z.string() })) });
  const model = new ChatCompletionsResearchModel({
    apiKey: "fixture", model: "fixture", systemPrompt,
    fetchFn: async (_url, init) => {
      const request = requestSchema.parse(JSON.parse(String(init?.body)));
      assert.equal(request.messages[0]?.role, "system");
      assert.equal(request.messages[0]?.content, systemPrompt);
      for (const topic of topics) {
        assert.ok(systemPrompt.includes(topic.path));
        assert.ok(systemPrompt.includes(topic.scope));
        assert.ok(systemPrompt.includes(topic.reviewAfter));
        const result = z.object({ path: z.string(), content: z.string(), truncated: z.boolean() })
          .parse(await read.execute(read.input.parse({ path: topic.path })));
        assert.equal(result.path, topic.path);
        assert.equal(result.truncated, false);
        assert.ok(result.content.includes("## 来源知识"));
        assert.ok(!systemPrompt.includes(result.content));
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "fixture" } }] }));
    },
  }, tools);
  await model.respond([{ role: "user", content: "帮我设计 ETF 投资计划" }]);
});

test("missing knowledge is explicit and malformed metadata cannot silently disappear", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "stocking-knowledge-"));
  try {
    assert.deepEqual(discoverKnowledgeTopics(cwd), []);
    assert.match(formatKnowledgeCatalog([]), /暂无可用知识专题/);
    const directory = join(cwd, "knowledge", "topics");
    await mkdir(directory, { recursive: true });
    const path = join(directory, "example.md");
    await writeFile(path, "# No metadata\n");
    assert.throws(() => discoverKnowledgeTopics(cwd), /知识专题元数据无效.*example.md/);
    await writeFile(path, "---\nid: example\nscope: 测试资料\nversion: 1\nverified_at: 2026-02-30\nreview_after: 2026-11-07\n---\n");
    assert.throws(() => discoverKnowledgeTopics(cwd), /verified_at/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("catalog is stable and excludes non-topics and private memory", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "stocking-knowledge-"));
  try {
    const directory = join(cwd, "knowledge", "topics");
    await mkdir(directory, { recursive: true });
    for (const id of ["z-topic", "a-topic"]) {
      await writeFile(join(directory, `${id}.md`), `---\r\nid: ${id}\r\nscope: 测试用途\r\nversion: 1\r\nverified_at: 2026-10-07\r\nreview_after: 2026-11-07\r\n---\r\n正文不进入目录`);
    }
    await writeFile(join(directory, "notes.txt"), "not a topic");
    await mkdir(join(cwd, ".stocking"));
    await writeFile(join(cwd, ".stocking", "user-profile.json"), "private-fixture");
    const topics = discoverKnowledgeTopics(cwd);
    assert.deepEqual(topics.map(topic => topic.id), ["a-topic", "z-topic"]);
    assert.equal(formatKnowledgeCatalog(topics), formatKnowledgeCatalog(discoverKnowledgeTopics(cwd)));
    assert.ok(!formatKnowledgeCatalog(topics).includes("正文"));
    assert.ok(!formatKnowledgeCatalog(topics).includes("private-fixture"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
