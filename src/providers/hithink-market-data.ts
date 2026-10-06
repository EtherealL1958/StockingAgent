import { z } from "zod";
import type {
  DailyBar,
  FinancialMetrics,
  Quote,
  Security,
} from "../domain/types.js";
import type { MarketDataProvider } from "./market-data.js";

const DEFAULT_BASE_URL = "https://fuyao.aicubes.cn";
const DEFAULT_TIMEOUT_MS = 15_000;

type FetchFunction = typeof fetch;

type ApiEnvelope = {
  readonly code: number;
  readonly message: string;
  readonly requestId: string;
  readonly data: unknown;
};

const envelopeSchema = z.object({
  code: z.number(),
  message: z.string(),
  request_id: z.string(),
  data: z.unknown(),
});

const snapshotDataSchema = z.object({
  timestamp: z.number().nullable(),
  total: z.number().int().nonnegative(),
  item: z.array(z.object({
    thscode: z.string(),
    ticker: z.string(),
    last_price: z.number(),
    open_price: z.number(),
    high_price: z.number(),
    low_price: z.number(),
    prev_price: z.number(),
    volume: z.number(),
    turnover: z.number(),
  })),
});

const fundSnapshotDataSchema = z.object({
  timestamp: z.number().nullable(),
  item: z.array(z.object({
    thscode: z.string(),
    ticker: z.string(),
    last_price: z.number(),
    open_price: z.number(),
    high_price: z.number(),
    low_price: z.number(),
    prev_price: z.number(),
    volume: z.number(),
    turnover: z.number(),
  })),
});

const historicalDataSchema = z.object({
  timestamp: z.number(),
  item: z.array(z.object({
    date_ms: z.number(),
    open_price: z.number(),
    high_price: z.number(),
    low_price: z.number(),
    close_price: z.number(),
    volume: z.number(),
    turnover: z.number(),
  })),
});

const tickerDataSchema = z.object({
  timestamp: z.number(),
  item: z.array(z.object({
    thscode: z.string(),
    ticker: z.string(),
    name: z.string(),
    exchange: z.string().nullable(),
    asset_type: z.string(),
  })),
});

const financialDataSchema = z.object({
  thscode: z.string(),
  report: z.string(),
  abilities: z.array(z.object({
    ability: z.string(),
    indicators: z.array(z.object({
      index_id: z.string(),
      value: z.string().nullable(),
    })),
  })),
});

export class HiThinkApiError extends Error {
  public constructor(
    message: string,
    public readonly code: number,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = "HiThinkApiError";
  }
}

export interface HiThinkMarketDataOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly fetchFn?: FetchFunction;
}

/**
 * 同花顺 REST Provider。
 *
 * 供应商响应只在本文件内解析，domain 和 Agent 只看到统一的数据类型。
 * API 文档：Financial-API/docs/api/a-share 与 docs/api/meta。
 */
export class HiThinkMarketDataProvider implements MarketDataProvider {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: FetchFunction;

  public constructor(private readonly options: HiThinkMarketDataOptions) {
    if (!options.apiKey.trim()) {
      throw new Error("HITHINK_FINANCE_API_KEY 不能为空");
    }
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  public async getQuote(ticker: string): Promise<Quote> {
    const thscode = this.toThscode(ticker);
    const isEtf = await this.isEtf(ticker);
    const response = await this.request(
      isEtf ? "/api/fund/market/snapshot" : "/api/a-share/prices/snapshot",
      isEtf ? { thscode } : { thscodes: thscode },
    );
    const data = isEtf
      ? fundSnapshotDataSchema.parse(response.data)
      : snapshotDataSchema.parse(response.data);
    const item = data.item.find(snapshot => snapshot.thscode === thscode);
    if (!item) {
      throw new HiThinkApiError(`未找到行情: ${thscode}`, 404, response.requestId);
    }

    if (data.timestamp === null) {
      throw new HiThinkApiError(`行情缺少数据时间: ${thscode}`, 5004, response.requestId);
    }
    return {
      ticker: item.ticker,
      price: item.last_price,
      asOf: this.timestampToIso(data.timestamp),
      source: "hithink-finance",
      isSuspended: item.volume === 0 && item.last_price === 0,
    };
  }

  public async getQuotes(tickers: readonly string[]): Promise<readonly Quote[]> {
    if (tickers.length === 0) return [];
    const response = await this.request("/api/a-share/prices/snapshot", {
      thscodes: tickers.map(ticker => this.toThscode(ticker)).join(","),
    });
    const data = snapshotDataSchema.parse(response.data);
    const timestamp = data.timestamp;
    if (timestamp === null) {
      throw new HiThinkApiError("批量行情缺少数据时间", 5004, response.requestId);
    }
    return data.item.map(item => ({
      ticker: item.ticker,
      price: item.last_price,
      asOf: this.timestampToIso(timestamp),
      source: "hithink-finance",
      isSuspended: item.volume === 0 && item.last_price === 0,
    }));
  }

  public async getDailyBars(
    ticker: string,
    from?: string,
    to?: string,
  ): Promise<readonly DailyBar[]> {
    const end = to ? this.parseDate(to) : new Date();
    const start = from
      ? this.parseDate(from)
      : new Date(end.getTime() - 365 * 24 * 60 * 60 * 1000);
    const isEtf = await this.isEtf(ticker);
    const response = await this.request(
      isEtf ? "/api/fund/market/historical" : "/api/a-share/prices/historical",
      {
        thscode: this.toThscode(ticker),
        interval: "1d",
      start: String(start.getTime()),
      end: String(end.getTime()),
        adjust: "forward",
      },
    );
    const data = historicalDataSchema.parse(response.data);
    return data.item.map(bar => ({
      ticker,
      date: this.timestampToDate(bar.date_ms),
      open: bar.open_price,
      high: bar.high_price,
      low: bar.low_price,
      close: bar.close_price,
      volume: bar.volume,
    }));
  }

  public async getIndexDailyBars(
    thscode: string,
    from?: string,
    to?: string,
  ): Promise<readonly DailyBar[]> {
    const end = to ? this.parseDate(to) : new Date();
    const start = from
      ? this.parseDate(from)
      : new Date(end.getTime() - 365 * 24 * 60 * 60 * 1000);
    const response = await this.request("/api/a-share-index/prices/historical", {
      thscode: this.normalizeIndexCode(thscode),
      interval: "1d",
      start: String(start.getTime()),
      end: String(end.getTime()),
    });
    const data = historicalDataSchema.parse(response.data);
    return data.item.map(bar => ({
      ticker: thscode,
      date: this.timestampToDate(bar.date_ms),
      open: bar.open_price,
      high: bar.high_price,
      low: bar.low_price,
      close: bar.close_price,
      volume: bar.volume,
    }));
  }

  public async getFinancials(ticker: string, report: string): Promise<FinancialMetrics> {
    const response = await this.request("/api/a-share/financials/indicators", {
      thscode: this.toThscode(ticker),
      report,
    });
    const data = financialDataSchema.parse(response.data);
    const values = new Map<string, number>();
    for (const ability of data.abilities) {
      for (const indicator of ability.indicators) {
        const value = indicator.value === null ? undefined : Number(indicator.value);
        if (value !== undefined && Number.isFinite(value)) {
          values.set(indicator.index_id, value);
        }
      }
    }

    // 缺失指标保持缺失，不能把供应商缺失值当作零。
    const metrics: Partial<Record<"roe" | "revenueGrowth" | "netProfitGrowth" | "grossMargin" | "debtRatio", number>> = {};
    this.setMetric(metrics, "roe", values.get("index_weighted_avg_roe"));
    this.setMetric(metrics, "revenueGrowth", values.get("operating_income_yoy_growth_ratio"));
    this.setMetric(metrics, "netProfitGrowth", values.get("net_profit_yoy_growth_ratio"));
    this.setMetric(metrics, "grossMargin", values.get("sale_gross_margin"));
    this.setMetric(metrics, "debtRatio", values.get("assets_debt_ratio"));
    return metrics;
  }

  public async getStockBasic(ticker?: string): Promise<readonly Security[]> {
    if (ticker) {
      const response = await this.request("/api/meta/tickers/search", {
        q: ticker,
        asset_type: "a-share,fund-etf",
        limit: "50",
      });
      const data = tickerDataSchema.parse(response.data);
      return data.item
        .filter(item => item.ticker === ticker || item.thscode === ticker)
        .map(item => this.toSecurity(item));
    }

    const securities: Security[] = [];
    const pageSize = 1000;
    for (let offset = 0; ; offset += pageSize) {
      const response = await this.request("/api/meta/tickers/list", {
        asset_type: "a-share,fund-etf",
        limit: String(pageSize),
        offset: String(offset),
      });
      const data = tickerDataSchema.parse(response.data);
      securities.push(...data.item.map(item => this.toSecurity(item)));
      if (data.item.length < pageSize) {
        return securities;
      }
    }
  }

  private async isEtf(ticker: string): Promise<boolean> {
    const securities = await this.getStockBasic(ticker);
    if (securities.length === 0) {
      throw new HiThinkApiError(`未找到证券: ${ticker}`, 404);
    }
    return securities[0]!.securityType === "etf";
  }

  private async request(
    path: string,
    params: Readonly<Record<string, string>>,
  ): Promise<ApiEnvelope> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        headers: { "X-api-key": this.options.apiKey },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown network error";
      throw new HiThinkApiError(`同花顺请求失败: ${reason}`, 5000);
    }
    if (!response.ok) {
      throw new HiThinkApiError(`同花顺 HTTP 错误: ${response.status}`, response.status);
    }

    const parsed = envelopeSchema.parse(await response.json());
    const envelope: ApiEnvelope = {
      code: parsed.code,
      message: parsed.message,
      requestId: parsed.request_id,
      data: parsed.data,
    };
    if (envelope.code !== 0) {
      throw new HiThinkApiError(envelope.message, envelope.code, envelope.requestId);
    }
    return envelope;
  }

  private normalizeIndexCode(thscode: string): string {
    if (/^\d{6}\.(SH|SZ|TI)$/i.test(thscode)) {
      return thscode.toUpperCase();
    }
    throw new Error(`指数代码必须包含 SH、SZ 或 TI 后缀: ${thscode}`);
  }

  private toThscode(ticker: string): string {
    if (/^\d{6}\.(SH|SZ)$/i.test(ticker)) {
      return ticker.toUpperCase();
    }
    if (!/^\d{6}$/.test(ticker)) {
      throw new Error(`证券代码格式无效: ${ticker}`);
    }
    if (ticker.startsWith("6") || ticker.startsWith("5")) {
      return `${ticker}.SH`;
    }
    if (ticker.startsWith("0") || ticker.startsWith("1") || ticker.startsWith("2") || ticker.startsWith("3")) {
      return `${ticker}.SZ`;
    }
    if (ticker.startsWith("4") || ticker.startsWith("8") || ticker.startsWith("9")) {
      return `${ticker}.BJ`;
    }
    throw new Error(`暂不支持自动推断交易所的证券代码: ${ticker}`);
  }

  private parseDate(value: string): Date {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new Error(`日期格式无效: ${value}`);
    }
    return date;
  }

  private timestampToIso(timestamp: number): string {
    return new Date(timestamp).toISOString();
  }

  private timestampToDate(timestamp: number): string {
    return new Date(timestamp).toISOString().slice(0, 10);
  }

  private setMetric(
    metrics: Partial<Record<"roe" | "revenueGrowth" | "netProfitGrowth" | "grossMargin" | "debtRatio", number>>,
    key: "roe" | "revenueGrowth" | "netProfitGrowth" | "grossMargin" | "debtRatio",
    value: number | undefined,
  ): void {
    if (value === undefined) {
      return;
    }
    metrics[key] = value;
  }

  private toSecurity(item: z.infer<typeof tickerDataSchema>["item"][number]): Security {
    const isEtf = item.asset_type === "fund-etf";
    if (!isEtf && item.exchange !== "SH" && item.exchange !== "SZ" && item.exchange !== "BJ") {
      throw new Error(`无法识别证券交易所: ${item.thscode}`);
    }
    const board = isEtf ? "etf" : this.inferBoard(item.ticker, item.exchange);
    return {
      ticker: item.ticker,
      name: item.name,
      securityType: isEtf ? "etf" : "stock",
      board,
      sector: isEtf ? "etf" : "unknown",
      lotSize: board === "star" || board === "chinext" ? 200 : 100,
      isIndex: false,
    };
  }

  private inferBoard(ticker: string, exchange: string | null): "sh_main" | "sz_main" | "bj_main" | "chinext" | "star" {
    if (exchange === "BJ") return "bj_main";
    if (exchange === "SH" && ticker.startsWith("688")) return "star";
    if (exchange === "SZ" && ticker.startsWith("300")) return "chinext";
    if (exchange === "SH") return "sh_main";
    if (exchange === "SZ") return "sz_main";
    throw new Error(`无法识别证券交易所: ${ticker}.${exchange ?? "UNKNOWN"}`);
  }
}
