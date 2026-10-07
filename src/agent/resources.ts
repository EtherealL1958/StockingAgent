import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";

const knowledgeMetadataSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  scope: z.string().min(1).max(200),
  version: z.string().min(1).max(40),
  verified_at: z.string().date(),
  review_after: z.string().date(),
});

export interface KnowledgeTopicSummary {
  readonly id: string;
  readonly scope: string;
  readonly path: string;
  readonly version: string;
  readonly verifiedAt: string;
  readonly reviewAfter: string;
}

/** 目录仅收录专题元数据，不把知识正文或用户记忆放进静态前缀。 */
export function discoverKnowledgeTopics(cwd: string): readonly KnowledgeTopicSummary[] {
  const root = join(cwd, "knowledge", "topics");
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  return entries.filter(entry => entry.isFile() && entry.name.endsWith(".md"))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(entry => {
      const path = relative(cwd, join(root, entry.name));
      const parsed = knowledgeMetadataSchema.safeParse(readFrontmatterFields(join(root, entry.name)));
      if (!parsed.success) throw new Error(`知识专题元数据无效：${path}；${parsed.error.message}`);
      const fields = parsed.data;
      return {
        id: fields.id, scope: fields.scope, path, version: fields.version,
        verifiedAt: fields.verified_at, reviewAfter: fields.review_after,
      };
    });
}

export function formatKnowledgeCatalog(topics: readonly KnowledgeTopicSummary[]): string {
  if (topics.length === 0) return "暂无可用知识专题；不得声称已查阅本地知识库。";
  // JSON 明确区分导航数据与提示词规则；正文仍须通过 read 取得。
  return JSON.stringify(topics, null, 2);
}

export interface SkillSummary {
  readonly name: string;
  readonly description: string;
  readonly path: string;
}

/** 只读取 Skill 的 frontmatter；完整内容通过 read 工具按需加载。 */
export function discoverSkills(cwd: string): readonly SkillSummary[] {
  const roots = [join(cwd, "skills"), join(cwd, ".agents", "skills"), join(cwd, ".pi", "skills")];
  const skills: SkillSummary[] = [];
  for (const root of roots) scanSkillRoot(root, cwd, skills, 0);
  return skills;
}

function scanSkillRoot(root: string, cwd: string, output: SkillSummary[], depth: number): void {
  if (depth > 4) return;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  const skillFile = entries.find(entry => entry.isFile() && entry.name === "SKILL.md");
  if (skillFile) {
    const path = join(root, skillFile.name);
    const frontmatter = readFrontmatter(path);
    if (frontmatter.name && frontmatter.description) {
      output.push({ name: frontmatter.name, description: frontmatter.description, path: relative(cwd, path) });
    }
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) scanSkillRoot(join(root, entry.name), cwd, output, depth + 1);
  }
}

function readFrontmatter(path: string): { name?: string; description?: string } {
  try {
    const fields = readFrontmatterFields(path);
    const description = fields.description ?? fields.summary;
    return {
      ...(fields.name ? { name: fields.name } : {}),
      ...(description ? { description } : {}),
    };
  } catch {
    return {};
  }
}

/** 项目元数据使用单行 key: value；不实现通用 YAML。 */
function readFrontmatterFields(path: string): Record<string, string> {
  const firstLines = readFileSync(path, "utf8").split(/\r?\n/).slice(0, 30);
  if (firstLines[0]?.trim() !== "---") return {};
  const end = firstLines.indexOf("---", 1);
  if (end < 0) return {};
  const fields: Record<string, string> = {};
  for (const line of firstLines.slice(1, end)) {
    const match = line.match(/^([\w-]+):\s*(.+)$/);
    if (match) fields[match[1]!] = match[2]!.trim();
  }
  return fields;
}

export function formatSkillCatalog(skills: readonly SkillSummary[]): string {
  if (skills.length === 0) return "暂无可用 Skill。";
  return skills.map(skill => `- ${skill.name}: ${skill.description}（需要时用 read 读取 ${skill.path}）`).join("\n");
}
