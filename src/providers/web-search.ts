import { z } from "zod";

export type WebSearchFreshness = "pd" | "pw" | "pm" | "py";
export type WebSearchLanguage = "zh-hans" | "en";

/** 所有搜索服务都接收和返回这一组稳定的数据结构。 */
export interface WebSearchInput {
  readonly query: string;
  readonly count: number;
  readonly freshness?: WebSearchFreshness;
  readonly searchLang: WebSearchLanguage;
}

export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly description: string;
  readonly age?: string;
  readonly publishedAt?: string;
  readonly score?: number;
}

export interface WebSearchDiagnostics {
  /** 不含 API key 的实际供应商请求参数，便于解释映射和未支持选项。 */
  readonly providerRequest: Readonly<Record<string, unknown>>;
  readonly unsupportedInput: readonly string[];
}

export interface WebSearchOutput {
  readonly provider: string;
  readonly available: boolean;
  readonly request: WebSearchInput;
  readonly diagnostics: WebSearchDiagnostics;
  readonly results: readonly WebSearchResult[];
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

export interface WebSearchProvider {
  search(input: WebSearchInput): Promise<WebSearchOutput>;
}

interface FetchOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly fetchFn?: typeof fetch;
}

const tavilyResponseSchema = z.object({
  results: z.array(z.object({
    title: z.string(),
    url: z.string(),
    content: z.string().nullable().optional(),
    score: z.number().nullable().optional(),
    published_date: z.string().nullable().optional(),
  })).default([]),
});

const braveResponseSchema = z.object({
  web: z.object({
    results: z.array(z.object({
      title: z.string(),
      url: z.string(),
      description: z.string().optional(),
      age: z.string().optional(),
    })).default([]),
  }).optional(),
});

const FRESHNESS_TO_TAVILY: Readonly<Record<WebSearchFreshness, string>> = {
  pd: "day",
  pw: "week",
  pm: "month",
  py: "year",
};

const LANGUAGE_TO_TAVILY: Readonly<Record<WebSearchLanguage, string>> = {
  "zh-hans": "zh-cn",
  en: "en",
};

export class TavilyWebSearchProvider implements WebSearchProvider {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  public constructor(private readonly options: FetchOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://api.tavily.com/search").replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  public async search(input: WebSearchInput): Promise<WebSearchOutput> {
    const providerRequest: Record<string, unknown> = {
      query: input.query,
      topic: "general",
      search_depth: "basic",
      max_results: input.count,
      language: LANGUAGE_TO_TAVILY[input.searchLang],
      filter_by_language: false,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      include_published_date: true,
      filter_by_published_date: false,
    };
    if (input.freshness) providerRequest.time_range = FRESHNESS_TO_TAVILY[input.freshness];
    const diagnostics: WebSearchDiagnostics = {
      providerRequest,
      unsupportedInput: [],
    };
    if (!this.options.apiKey?.trim()) {
      return unavailable("tavily", input, diagnostics, "missing_api_key", "未配置 TAVILY_API_KEY，无法访问 Tavily");
    }

    try {
      const response = await this.fetchFn(this.baseUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(providerRequest),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) return unavailable("tavily", input, diagnostics, `http_${response.status}`, `Tavily 请求失败：HTTP ${response.status}`);
      const payload = tavilyResponseSchema.parse(await response.json());
      return {
        provider: "tavily",
        available: true,
        request: input,
        diagnostics,
        results: payload.results.map(result => ({
          title: result.title,
          url: result.url,
          description: result.content ?? "",
          ...(result.published_date ? { publishedAt: result.published_date } : {}),
          ...(result.score !== undefined && result.score !== null ? { score: result.score } : {}),
        })),
      };
    } catch (error) {
      return unavailable("tavily", input, diagnostics, "request_error", error instanceof Error ? error.message : "Tavily 请求失败");
    }
  }
}

/** 保留 Brave-compatible 适配器，便于不改变工具接口地切换服务商。 */
export class BraveWebSearchProvider implements WebSearchProvider {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  public constructor(private readonly options: FetchOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://api.search.brave.com/res/v1/web/search").replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  public async search(input: WebSearchInput): Promise<WebSearchOutput> {
    const url = new URL(this.baseUrl);
    url.searchParams.set("q", input.query);
    url.searchParams.set("count", String(input.count));
    url.searchParams.set("search_lang", input.searchLang);
    if (input.freshness) url.searchParams.set("freshness", input.freshness);
    const diagnostics: WebSearchDiagnostics = {
      providerRequest: { q: input.query, count: input.count, search_lang: input.searchLang, freshness: input.freshness ?? null },
      unsupportedInput: [],
    };
    if (!this.options.apiKey?.trim()) {
      return unavailable("brave", input, diagnostics, "missing_api_key", "未配置 BRAVE_SEARCH_API_KEY，无法访问 Brave Search");
    }
    try {
      const response = await this.fetchFn(url, { headers: { "X-Subscription-Token": this.options.apiKey, accept: "application/json" }, signal: AbortSignal.timeout(this.timeoutMs) });
      if (!response.ok) return unavailable("brave", input, diagnostics, `http_${response.status}`, `Brave Search 请求失败：HTTP ${response.status}`);
      const payload = braveResponseSchema.parse(await response.json());
      return {
        provider: "brave",
        available: true,
        request: input,
        diagnostics,
        results: (payload.web?.results ?? []).map(result => ({ title: result.title, url: result.url, description: result.description ?? "", ...(result.age ? { age: result.age } : {}) })),
      };
    } catch (error) {
      return unavailable("brave", input, diagnostics, "request_error", error instanceof Error ? error.message : "Brave Search 请求失败");
    }
  }
}

export function createWebSearchProvider(env: NodeJS.ProcessEnv = process.env): WebSearchProvider {
  const provider = (env.WEB_SEARCH_PROVIDER ?? "tavily").toLowerCase();
  if (provider === "tavily") {
    return new TavilyWebSearchProvider({
      ...(env.TAVILY_API_KEY ? { apiKey: env.TAVILY_API_KEY } : {}),
      ...(env.TAVILY_API ? { baseUrl: env.TAVILY_API } : {}),
    });
  }
  if (provider === "brave") {
    return new BraveWebSearchProvider({
      ...(env.BRAVE_SEARCH_API_KEY ? { apiKey: env.BRAVE_SEARCH_API_KEY } : {}),
      ...(env.BRAVE_SEARCH_API ? { baseUrl: env.BRAVE_SEARCH_API } : {}),
    });
  }
  throw new Error(`不支持的 WEB_SEARCH_PROVIDER: ${provider}；可选 tavily 或 brave`);
}

function unavailable(
  provider: string,
  request: WebSearchInput,
  diagnostics: WebSearchDiagnostics,
  code: string,
  message: string,
): WebSearchOutput {
  return { provider, available: false, request, diagnostics, results: [], error: { code, message } };
}
