export type RiskLevel = "low" | "medium" | "high";
export type SecurityType = "stock" | "etf";
export type Board = "sh_main" | "sz_main" | "chinext" | "star" | "etf";

export interface InvestorProfile {
  readonly investableCash: number;
  readonly monthlyContribution: number;
  readonly horizonYears: number;
  readonly riskLevel: RiskLevel;
  readonly maxDrawdown: number;
  readonly emergencyCashRequired: number;
  readonly cashReserveRatio?: number;
}

export interface Security {
  readonly ticker: string;
  readonly name: string;
  readonly securityType: SecurityType;
  readonly board: Board;
  readonly sector: string;
  readonly lotSize: number;
  readonly isIndex: boolean;
}

export interface Quote {
  readonly ticker: string;
  readonly price: number;
  readonly asOf: string;
  readonly source: string;
  readonly isSuspended: boolean;
}

export interface DailyBar {
  readonly ticker: string;
  readonly date: string;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

export interface FinancialMetrics {
  readonly roe?: number;
  readonly revenueGrowth?: number;
  readonly netProfitGrowth?: number;
  readonly operatingCashFlow?: number;
  readonly freeCashFlow?: number;
  readonly debtRatio?: number;
  readonly grossMargin?: number;
  readonly pe?: number;
  readonly pb?: number;
  readonly ps?: number;
  readonly dividendYield?: number;
  readonly volatility?: number;
  readonly maxDrawdown?: number;
  readonly beta?: number;
  readonly momentum?: number;
}

export interface Candidate {
  readonly security: Security;
  readonly quote: Quote;
  readonly metrics: FinancialMetrics;
}

export interface ScoreBreakdown {
  readonly quality: number | undefined;
  readonly valuation: number | undefined;
  readonly stability: number | undefined;
  readonly growth: number | undefined;
  readonly momentum: number | undefined;
  readonly total: number | undefined;
  /** 实际参与评分的指标占比，0 表示完全没有可用指标。 */
  readonly completeness: number;
}

export interface Allocation {
  readonly ticker: string;
  readonly name: string;
  readonly quantity: number;
  readonly amount: number;
  readonly weight: number;
  readonly score: number;
}

export interface PortfolioPlan {
  readonly status: "INVEST" | "NO_TRADE";
  readonly budget: number;
  readonly reserve: number;
  readonly allocations: readonly Allocation[];
  readonly cashRemaining: number;
  readonly warnings: readonly string[];
}
