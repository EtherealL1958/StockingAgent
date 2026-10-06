import type {
  DailyBar,
  FinancialMetrics,
  Quote,
  Security,
} from "../domain/types.js";

export interface MarketDataProvider {
  getQuote(ticker: string): Promise<Quote>;
  getQuotes(tickers: readonly string[]): Promise<readonly Quote[]>;
  getDailyBars(ticker: string, from?: string, to?: string): Promise<readonly DailyBar[]>;
  getIndexDailyBars(thscode: string, from?: string, to?: string): Promise<readonly DailyBar[]>;
  getFinancials(ticker: string, report: string): Promise<FinancialMetrics>;
  getStockBasic(ticker?: string): Promise<readonly Security[]>;
}

/** 固定数据 Provider，仅用于确定性测试和本地演示。 */
export class MockMarketDataProvider implements MarketDataProvider {
  public constructor(
    private readonly securities: readonly Security[],
    private readonly quotes: ReadonlyMap<string, Quote>,
    private readonly metrics: ReadonlyMap<string, FinancialMetrics>,
    private readonly bars: ReadonlyMap<string, readonly DailyBar[]> = new Map(),
  ) {}

  public async getQuote(ticker: string): Promise<Quote> {
    const quote = this.quotes.get(ticker);
    if (!quote) {
      throw new Error(`quote unavailable: ${ticker}`);
    }
    return quote;
  }

  public async getQuotes(tickers: readonly string[]): Promise<readonly Quote[]> {
    return tickers.flatMap(ticker => {
      const quote = this.quotes.get(ticker);
      return quote ? [quote] : [];
    });
  }

  public async getDailyBars(ticker: string): Promise<readonly DailyBar[]> {
    return this.bars.get(ticker) ?? [];
  }

  public async getIndexDailyBars(thscode: string): Promise<readonly DailyBar[]> {
    return this.bars.get(thscode) ?? [];
  }

  public async getFinancials(ticker: string, _report: string): Promise<FinancialMetrics> {
    const metrics = this.metrics.get(ticker);
    if (!metrics) {
      throw new Error(`financials unavailable: ${ticker}`);
    }
    return metrics;
  }

  public async getStockBasic(ticker?: string): Promise<readonly Security[]> {
    return ticker
      ? this.securities.filter(security => security.ticker === ticker)
      : this.securities;
  }
}
