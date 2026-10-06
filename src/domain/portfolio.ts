import type {
  Candidate,
  InvestorProfile,
  Allocation,
  PortfolioPlan,
} from "./types.js";
import { scoreSecurity } from "./scoring.js";
import { assessTrade } from "./risk.js";
import { calculateAffordableQuantity, calculateTransactionCost, defaultRiskLimits, DEFAULT_A_SHARE_COSTS } from "./risk-controls.js";

const MIN_STOCK_STABILITY_SCORE = 35;

/** 按评分顺序构建整手仓位；保留现有贪心分配策略，不代表全局最优解。 */
export function optimizePortfolio(
  profile: InvestorProfile,
  candidates: readonly Candidate[],
  transactionRate = 0.0003,
  minimumFee = 5,
): PortfolioPlan {
  // 应急资金先剔除，现金储备再从组合预算中单独预留。
  const budget = Math.max(0, profile.investableCash - profile.emergencyCashRequired);
  const riskLimits = defaultRiskLimits(profile);
  const reserve = budget * riskLimits.minimumCashReserve;
  const investable = Math.max(0, budget - reserve);
  if (investable <= 0) {
    return {
      status: "NO_TRADE",
      budget,
      reserve,
      allocations: [],
      cashRemaining: budget,
      warnings: ["应急资金或现金储备已占用可投资资金"],
    };
  }
  const maxHistoricalDrawdown = Math.min(0.8, profile.maxDrawdown * 2);
  const rankedCandidates = candidates
    .map(candidate => ({
      candidate,
      score: scoreSecurity(candidate.metrics)
    }))
    .sort((left, right) => (right.score.total ?? -1) - (left.score.total ?? -1));
  const allocations: Allocation[] = [];
  const industrySpent = new Map<string, number>();
  let totalSpentIncludingFees = 0;
  const tradingCostRules = {
    ...DEFAULT_A_SHARE_COSTS,
    commissionRate: transactionRate,
    minimumCommission: minimumFee,
  };
  for (const { candidate, score } of rankedCandidates) {
    const { security, quote, metrics } = candidate;
    const isStock = security.securityType === "stock";
    if (quote.isSuspended) {
      continue;
    }
    if (score.total === undefined) {
      continue;
    }
    if (isStock && (score.stability === undefined || score.stability < MIN_STOCK_STABILITY_SCORE)) {
      continue;
    }
    if (
      isStock &&
      metrics.maxDrawdown !== undefined &&
      metrics.maxDrawdown > maxHistoricalDrawdown
    ) {
      continue;
    }
    // 保持现有口径：仓位上限按可建仓金额计算，输出权重按组合预算计算。
    const maxAssetWeight = isStock ? riskLimits.maxSingleStockWeight : Math.min(0.5, riskLimits.maxSingleStockWeight * 2);
    const assetCap = investable * maxAssetWeight;
    const currentIndustryAmount = industrySpent.get(security.sector) ?? 0;
    const sectorCap = investable * riskLimits.maxIndustryWeight - currentIndustryAmount;
    const positionBudget = Math.max(0, Math.min(assetCap, sectorCap));
    const availableCash = Math.max(0, investable - totalSpentIncludingFees);
    const quantity = calculateAffordableQuantity(
      Math.min(positionBudget, availableCash),
      quote.price,
      security.lotSize,
      tradingCostRules,
    );
    if (quantity <= 0) {
      continue;
    }
    const amount = quantity * quote.price;
    const fee = calculateTransactionCost(amount, "buy", tradingCostRules).total;
    if (totalSpentIncludingFees + amount + fee > investable) {
      continue;
    }
    const riskDecision = assessTrade(profile, metrics, amount, fee);
    if (!riskDecision.allowed) {
      continue;
    }
    allocations.push({
      ticker: security.ticker,
      name: security.name,
      quantity,
      amount: Math.round(amount * 100) / 100,
      weight: Math.round((amount / budget) * 10000) / 10000,
      score: score.total,
    });
    totalSpentIncludingFees += amount + fee;
    industrySpent.set(security.sector, currentIndustryAmount + amount);
  }
  const cashRemaining = Math.round((budget - totalSpentIncludingFees) * 100) / 100;
  if (allocations.length === 0) {
    return {
      status: "NO_TRADE",
      budget,
      reserve,
      allocations: [],
      cashRemaining,
      warnings: ["候选标的无法在资金、整手或风险约束下建仓"],
    };
  }
  return {
    status: "INVEST",
    budget,
    reserve,
    allocations,
    cashRemaining,
    warnings: cashRemaining / budget > 0.5 ? ["剩余现金较高，建议等待或继续定投"] : [],
  };
}
