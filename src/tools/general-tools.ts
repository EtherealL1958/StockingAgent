import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { createWebSearchProvider, type WebSearchInput, type WebSearchProvider } from "../providers/web-search.js";
import { defineTool } from "./tool.js";

const MAX_READ_LINES = 400;
const MAX_OUTPUT_BYTES = 32_000;
const MAX_EXECUTION_MS = 30_000;

const READ_PARAMETERS = {
  type: "object",
  properties: {
    path: { type: "string", description: "项目相对路径，例如 knowledge/topics/etf-research.md、skills/a-share-research/SKILL.md 或 reports/2025-q4.txt；不要传绝对路径、链接锚点或 .env" },
    offset: { type: "integer", minimum: 1, description: "1-based 起始行，例如 401" },
    limit: { type: "integer", minimum: 1, maximum: MAX_READ_LINES, description: "读取行数，例如 20；默认 400，最大 400" },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

const WRITE_PARAMETERS = {
  type: "object",
  properties: {
    path: { type: "string", description: "项目相对输出路径，例如 reports/600519-review.md" },
    content: { type: "string", description: "原样写入的 Markdown，例如 '# 600519 复盘\n...'" },
    overwrite: { type: "boolean", default: false, description: "是否覆盖已有文件；默认 false，已有文件会报错" },
  },
  required: ["path", "content"],
  additionalProperties: false,
} as const;

const WEB_SEARCH_PARAMETERS = {
  type: "object",
  properties: {
    query: { type: "string", minLength: 2, maxLength: 500, description: "原样搜索词，例如 贵州茅台 2025 年年报" },
    count: { type: "integer", minimum: 1, maximum: 10, default: 5, description: "结果条数，例如 5，最大 10" },
    freshness: { type: "string", enum: ["pd", "pw", "pm", "py"], description: "pd=过去一天、pw=过去一周、pm=过去一月、py=过去一年；省略不限定" },
    searchLang: { type: "string", enum: ["zh-hans", "en"], default: "zh-hans", description: "搜索语言，例如 zh-hans；实际请求会保留该输入" },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

const CODE_EXEC_PARAMETERS = {
  type: "object",
  properties: {
    language: { type: "string", enum: ["javascript", "python"], description: "例如 javascript 或 python；不接受 shell/bash" },
    code: { type: "string", minLength: 1, maxLength: 100_000, description: "原样执行的短代码，例如 console.log(2 + 3)" },
    timeoutMs: { type: "integer", minimum: 1, maximum: MAX_EXECUTION_MS, default: 10_000, description: "超时毫秒数，默认 10000，最大 30000" },
  },
  required: ["language", "code"],
  additionalProperties: false,
} as const;

async function resolveProjectPath(cwd: string, requestedPath: string): Promise<string> {
  if (requestedPath.includes("\0")) throw new Error("路径包含非法字符");
  if (isAbsolute(requestedPath)) throw new Error("只接受项目相对路径");
  const absolute = resolve(cwd, requestedPath);
  const projectRoot = await fs.realpath(cwd);
  const resolvedTarget = await realpathWithMissingAncestors(absolute);
  const relativeTarget = relative(projectRoot, resolvedTarget);
  const outsideProject = relativeTarget === ".." || relativeTarget.startsWith("../") || isAbsolute(relativeTarget);
  const isSecretPath = (path: string): boolean => path.split("/").some(segment => segment === ".env" || segment.startsWith(".env."));
  if (outsideProject || isSecretPath(absolute) || isSecretPath(resolvedTarget)) {
    throw new Error("只能访问项目目录内的非秘密文件");
  }
  return absolute;
}

function truncate(value: string, maxBytes = MAX_OUTPUT_BYTES): { readonly text: string; readonly truncated: boolean } {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) return { text: value, truncated: false };
  return { text: `${buffer.subarray(0, maxBytes).toString("utf8")}\n[输出已截断]`, truncated: true };
}

export function buildGeneralTools(cwd = process.cwd(), webSearchProvider: WebSearchProvider = createWebSearchProvider()) {
  return [
    defineTool({
      name: "read",
      description: "当投资规划、ETF、策略、回测或风险分析需要知识依据时，按系统目录读取相关专题（例如 knowledge/topics/etf-research.md）；不知道选哪个时读取 knowledge/README.md，核查出处时读取 knowledge/sources.md。也用于查看完整 Skill、文本格式财报或研究笔记。只接受项目目录内的 UTF-8 文本，不解析 PDF、图片、目录或 .env；path 不接受网页 URL 或链接锚点。默认从第 1 行读取最多 400 行，不改写正文；返回示例字段为 {path:'knowledge/topics/etf-research.md', startLine:1, endLine:60, truncated:false, content:'...'}。truncated=true 时按 endLine+1 继续读取所需内容；只读取目录不等于已阅读专题。",
      input: z.object({
        path: z.string().min(1).describe("项目相对路径，例如 knowledge/topics/etf-research.md 或 skills/a-share-research/SKILL.md；不要传 .env、绝对路径或链接锚点"),
        offset: z.number().int().positive().optional().describe("1-based 起始行，例如上一页返回 endLine=400 时传 401"),
        limit: z.number().int().positive().max(MAX_READ_LINES).optional().describe("读取行数，默认 400，最大 400；例如只看文件开头可传 20"),
      }).strict(),
      modelParameters: READ_PARAMETERS,
      execute: async ({ path, offset, limit }) => {
        const absolutePath = await resolveProjectPath(cwd, path);
        if ([".pdf", ".png", ".jpg", ".jpeg", ".gif"].includes(extname(absolutePath).toLowerCase())) {
          throw new Error("read 只支持 UTF-8 文本文件；PDF 和图片请先转换为文本");
        }
        const content = await fs.readFile(absolutePath, "utf8");
        const lines = content.split("\n");
        const start = (offset ?? 1) - 1;
        if (start >= lines.length) throw new Error(`读取位置超出文件范围，共 ${lines.length} 行`);
        const count = limit ?? MAX_READ_LINES;
        const end = Math.min(start + count, lines.length);
        const text = lines.slice(start, end).join("\n");
        const continuation = end < lines.length ? `\n\n[还有 ${lines.length - end} 行，请使用 offset=${end + 1} 继续读取]` : "";
        return { path: relative(cwd, absolutePath), encoding: "utf-8", startLine: start + 1, endLine: end, totalLines: lines.length, truncated: end < lines.length, content: `${text}${continuation}` };
      },
    }),
    defineTool({
      name: "write",
      description: "当用户明确要求保存研究总结、复盘记录、策略草稿或独立执行清单时使用，例如写入 reports/600519-review.md。一个研究任务默认只有一个主报告；后续补充内容应更新已有报告，只有用户明确要求另存为、单独清单或交付物确实独立时才创建新文件。无法判断时先询问用户，不要直接写两个重叠文件。path 必须是项目相对路径；工具会按 UTF-8 原样写入并自动创建父目录，不接受绝对路径、项目外路径或 .env 文件，也不会发布到外部服务。成功返回示例字段为 {path:'reports/600519-review.md', bytes:1234, written:true}。",
      input: z.object({
        path: z.string().min(1).describe("项目相对输出路径，例如 reports/600519-review.md"),
        content: z.string().describe("要原样保存的 Markdown 或纯文本内容；例如 '# 600519 复盘\\n...'"),
        overwrite: z.boolean().default(false).describe("是否覆盖已有文件；默认 false，已有文件时工具会报错"),
      }).strict(),
      modelParameters: WRITE_PARAMETERS,
      execute: async ({ path, content, overwrite }) => {
        const absolutePath = await resolveProjectPath(cwd, path);
        const parent = dirname(absolutePath);
        let parentExisted = true;
        try {
          await fs.access(parent);
        } catch {
          parentExisted = false;
        }
        await fs.mkdir(parent, { recursive: true });
        try {
          await fs.writeFile(absolutePath, content, { encoding: "utf8", flag: overwrite ? "w" : "wx" });
        } catch (error) {
          if (!overwrite && isFileExists(error)) {
            throw new Error(`文件已存在：${path}；如需覆盖请设置 overwrite=true`);
          }
          throw error;
        }
        return { path: relative(cwd, absolutePath), encoding: "utf-8", bytes: Buffer.byteLength(content, "utf8"), overwrite, parentCreated: !parentExisted, written: true };
      },
    }),
    defineTool({
      name: "web_search",
      description: "当需要补充公告、新闻或行业资料时使用，例如查询“贵州茅台 2025 年年报”；不要用它获取精确行情、财务指标或替代同花顺数据。默认使用 Tavily，也可通过 WEB_SEARCH_PROVIDER 切换 Brave；成功返回 provider、request、diagnostics 和 results，未配置对应 API key 时返回 available=false，不会伪造结果。",
      input: z.object({
        query: z.string().min(2).max(500).describe("搜索原文，例如 贵州茅台 2025 年年报；不会被工具改写"),
        count: z.number().int().positive().max(10).default(5).describe("返回条数，例如 5；最大 10"),
        freshness: z.enum(["pd", "pw", "pm", "py"]).optional().describe("时间过滤：pd=过去一天、pw=过去一周、pm=过去一月、py=过去一年；省略表示不限定"),
        searchLang: z.enum(["zh-hans", "en"]).default("zh-hans").describe("搜索语言，例如 zh-hans；会原样写入请求元数据"),
      }).strict(),
      modelParameters: WEB_SEARCH_PARAMETERS,
      execute: async ({ query, count, freshness, searchLang }) => {
        const request: WebSearchInput = {
          query,
          count: count ?? 5,
          searchLang: searchLang ?? "zh-hans",
          ...(freshness ? { freshness } : {}),
        };
        return webSearchProvider.search(request);
      },
    }),
    defineTool({
      name: "code_exec",
      description: "当需要可复现的辅助计算或整理时使用，例如用 JavaScript 计算一组收益率；不要用它替代 get_market_history 的金融指标，也不能执行 shell 命令或依赖未传入的秘密环境变量。仅支持 JavaScript/Python，最长 30 秒，stdout/stderr 各最多约 32KB；代码仍可使用语言运行时 API，因此只执行可信的短代码。参数必须是严格 JSON 对象：language 只能是字符串 javascript 或 python，code 才放代码文本；不要把 Markdown/XML 代码围栏或代码文本放进 language 字段。返回示例字段为 {stdout:'5\\n', exitCode:0, timedOut:false, stdoutTruncated:false}。",
      input: z.object({
        language: z.enum(["javascript", "python"]).describe("执行语言，例如 javascript 或 python；不接受 shell/bash"),
        code: z.string().min(1).max(100_000).describe("要原样执行的短代码，例如 console.log(2 + 3)"),
        timeoutMs: z.number().int().positive().max(MAX_EXECUTION_MS).default(10_000).describe("超时毫秒数，默认 10000，最大 30000"),
      }).strict(),
      modelParameters: CODE_EXEC_PARAMETERS,
      execute: async ({ language, code, timeoutMs }) => executeCode(cwd, language, code, timeoutMs ?? 10_000),
    }),
  ] as const;
}

async function realpathWithMissingAncestors(path: string): Promise<string> {
  const suffix: string[] = [];
  let current = path;
  while (true) {
    try {
      const resolved = await fs.realpath(current);
      return suffix.reduce((parent, segment) => join(parent, segment), resolved);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      suffix.unshift(basename(current));
      current = parent;
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isFileExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

async function executeCode(cwd: string, language: "javascript" | "python", code: string, timeoutMs: number) {
  const command = language === "javascript" ? "node" : "python3";
  const args = language === "javascript" ? ["--input-type=module", "-e", code] : ["-c", code];
  return new Promise<{ language: string; stdout: string; stderr: string; stdoutTruncated: boolean; stderrTruncated: boolean; exitCode: number | null; timedOut: boolean; timeoutMs: number; shell: false; environment: string }>((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      env: { PATH: process.env.PATH ?? "", LANG: "C.UTF-8" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", exitCode => {
      clearTimeout(timer);
      const stdoutResult = truncate(stdout);
      const stderrResult = truncate(stderr);
      resolveResult({ language, stdout: stdoutResult.text, stderr: stderrResult.text, stdoutTruncated: stdoutResult.truncated, stderrTruncated: stderrResult.truncated, exitCode, timedOut, timeoutMs, shell: false, environment: "仅注入 PATH 和 LANG" });
    });
  });
}
