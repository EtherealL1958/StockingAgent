import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

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
    const firstLines = readFileSync(path, "utf8").split("\n").slice(0, 30);
    if (firstLines[0]?.trim() !== "---") return {};
    const end = firstLines.indexOf("---", 1);
    if (end < 0) return {};
    const fields: Record<string, string> = {};
    for (const line of firstLines.slice(1, end)) {
      const match = line.match(/^([\w-]+):\s*(.+)$/);
      if (match) fields[match[1]!] = match[2]!.trim();
    }
    const description = fields.description ?? fields.summary;
    return {
      ...(fields.name ? { name: fields.name } : {}),
      ...(description ? { description } : {}),
    };
  } catch {
    return {};
  }
}

export function formatSkillCatalog(skills: readonly SkillSummary[]): string {
  if (skills.length === 0) return "暂无可用 Skill。";
  return skills.map(skill => `- ${skill.name}: ${skill.description}（需要时用 read 读取 ${skill.path}）`).join("\n");
}
