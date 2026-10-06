import type { InvestorProfile, RiskLevel } from "./types.js";

export type OrderSide = "buy" | "sell";

export interface TradingCostRules {
  readonly commissionRate: number;
  readonly minimumCommission: number;
  readonly stampDutyRate: number;
  readonly transferFeeRate: number;
}

export const DEFAULT_A_SHARE_COSTS: TradingCostRules = {
  commissionRate: 0.0003,
  minimumCommission: 5,
  stampDutyRate: 0.0005,
  transferFeeRate: 0.00001,
};

export interface TransactionCost {
  readonly commission: number;
  readonly stampDuty: number;
  readonly transferFee: number;
  readonly total: number;
}

export function calculateTransactionCost(
  amount: number,
  side: OrderSide,
  rules: TradingCostRules = DEFAULT_A_SHARE_COSTS,
): TransactionCost {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error("成交金额必须为非负有限数");
  }
  const commission = amount === 0 ? 0 : Math.max(rules.minimumCommission, amount * rules.commissionRate);
  const stampDuty = side === "sell" ? amount * rules.stampDutyRate : 0;
  const transferFee = amount * rules.transferFeeRate;
  return {
    commission,
    stampDuty,
    transferFee,
    total: commission + stampDuty + transferFee,
  };
}

/** 在现金、整手和买入费用都满足时，返回可执行数量。 */
export function calculateAffordableQuantity(
  cash: number,
  price: number,
  lotSize: number,
  rules: TradingCostRules = DEFAULT_A_SHARE_COSTS,
): number {
  if (cash < 0 || price <= 0 || lotSize <= 0) {
    throw new Error("现金、价格和最小交易单位必须有效");
  }
  let quantity = Math.floor(cash / price / lotSize) * lotSize;
  while (quantity > 0) {
    const amount = quantity * price;
    if (amount + calculateTransactionCost(amount, "buy", rules).total <= cash) {
      return quantity;
    }
    quantity -= lotSize;
  }
  return 0;
}

export interface PortfolioPosition {
  readonly ticker: string;
  readonly marketValue: number;
  readonly sector: string;
  readonly securityType: "stock" | "etf";
}

export interface PortfolioRiskLimits {
  readonly maxSingleStockWeight: number;
  readonly maxIndustryWeight: number;
  readonly minimumCashReserve: number;
}

export interface PortfolioRiskViolation {
  readonly rule: "cash_reserve" | "single_stock" | "industry";
  readonly subject: string;
  readonly actual: number;
  readonly limit: number;
  readonly message: string;
}

const DEFAULT_RESERVE_RATIOS: Record<RiskLevel, number> = {
  low: 0.30,
  medium: 0.20,
  high: 0.10,
};
const MAX_SINGLE_STOCK_WEIGHTS: Record<RiskLevel, number> = {
  low: 0.15,
  medium: 0.20,
  high: 0.25,
};

export function defaultRiskLimits(profile: InvestorProfile): PortfolioRiskLimits {
  return {
    maxSingleStockWeight: MAX_SINGLE_STOCK_WEIGHTS[profile.riskLevel],
    maxIndustryWeight: 0.30,
    minimumCashReserve: profile.cashReserveRatio ?? DEFAULT_RESERVE_RATIOS[profile.riskLevel],
  };
}

export function evaluatePortfolioRisk(
  cash: number,
  positions: readonly PortfolioPosition[],
  limits: PortfolioRiskLimits,
): readonly PortfolioRiskViolation[] {
  const investedValue = positions.reduce((sum, position) => sum + position.marketValue, 0);
  const totalValue = cash + investedValue;
  if (totalValue <= 0) return [];
  const violations: PortfolioRiskViolation[] = [];
  const cashWeight = cash / totalValue;
  if (cashWeight < limits.minimumCashReserve) {
    violations.push({ rule: "cash_reserve", subject: "portfolio", actual: cashWeight, limit: limits.minimumCashReserve, message: "现金储备低于最低要求" });
  }
  const industryValues = new Map<string, number>();
  for (const position of positions) {
    const weight = position.marketValue / totalValue;
    if (position.securityType === "stock" && weight > limits.maxSingleStockWeight) {
      violations.push({ rule: "single_stock", subject: position.ticker, actual: weight, limit: limits.maxSingleStockWeight, message: "个股仓位超过上限" });
    }
    industryValues.set(position.sector, (industryValues.get(position.sector) ?? 0) + position.marketValue);
  }
  for (const [sector, value] of industryValues) {
    const weight = value / totalValue;
    if (weight > limits.maxIndustryWeight) {
      violations.push({ rule: "industry", subject: sector, actual: weight, limit: limits.maxIndustryWeight, message: "行业集中度超过上限" });
    }
  }
  return violations;
}

export interface AShareOrderContext {
  readonly side: OrderSide;
  readonly board: "sh_main" | "sz_main" | "bj_main" | "chinext" | "star" | "etf";
  readonly isST: boolean;
  readonly referenceClose?: number;
  readonly orderPrice: number;
  readonly quantity: number;
  readonly lotSize: number;
  readonly isSuspended: boolean;
}

export interface OrderViolation {
  readonly rule: "suspension" | "lot_size" | "price_limit";
  readonly message: string;
}

/**
 * 校验 A 股常见订单硬约束。
 * 首发上市或无参考收盘价时无法判断涨跌停，调用方应保留该项为未检查状态。
 */
export function validateAShareOrder(context: AShareOrderContext): readonly OrderViolation[] {
  const violations: OrderViolation[] = [];
  if (context.isSuspended) {
    violations.push({ rule: "suspension", message: "证券停牌，不能执行订单" });
  }
  if (!Number.isInteger(context.quantity) || context.quantity <= 0 || context.quantity % context.lotSize !== 0) {
    violations.push({ rule: "lot_size", message: "订单数量必须为最小交易单位的整数倍" });
  }

  if (context.referenceClose !== undefined) {
    const limitRate = context.isST
      ? 0.05
      : context.board === "chinext" || context.board === "star"
        ? 0.20
        : context.board === "bj_main"
          ? 0.30
          : 0.10;
    const lowerBound = context.referenceClose * (1 - limitRate);
    const upperBound = context.referenceClose * (1 + limitRate);
    if (context.orderPrice < lowerBound || context.orderPrice > upperBound) {
      violations.push({ rule: "price_limit", message: `订单价格超出 ${limitRate * 100}% 涨跌停范围` });
    }
  }
  return violations;
}
