import type {
  Candidate,
  InvestorProfile,
  Allocation,
  PortfolioPlan,
  RiskLevel,
} from "./types.js";
import { scoreSecurity } from "./scoring.js";
import { assessTrade } from "./risk.js";
import { calculateTransactionCost, DEFAULT_A_SHARE_COSTS } from "./risk-controls.js";

const DEFAULT_RESERVE_RATIOS: Record<RiskLevel, number> = {

  low: 0.30,

  medium: 0.20,

  high: 0.10,

};
const MAX_STOCK_WEIGHTS: Record<RiskLevel, number> = {

  low: 0.15,

  medium: 0.20,

  high: 0.25,

};
const MAX_INDUSTRY_WEIGHT = 0.30;
const MIN_STOCK_STABILITY_SCORE = 35;

export function reserveRatio(profile: InvestorProfile): number {
  return profile.cashReserveRatio ?? DEFAULT_RESERVE_RATIOS[profile.riskLevel];
}

/** 按评分顺序构建整手仓位；保留现有贪心分配策略，不代表全局最优解。 */
export function optimizePortfolio(

  profile: InvestorProfile,

  candidates: readonly Candidate[],

  transactionRate = 0.0003,

  minimumFee = 5,

): PortfolioPlan {
  // 应急资金先剔除，现金储备再从组合预算中单独预留。
  const budget = Math.max(0, profile.investableCash - profile.emergencyCashRequired);
  const reserve = budget * reserveRatio(profile);
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

  const maxStockWeight = MAX_STOCK_WEIGHTS[profile.riskLevel];
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
    const maxAssetWeight = isStock ? maxStockWeight : Math.min(0.5, maxStockWeight * 2);
    const assetCap = investable * maxAssetWeight;
    const currentIndustryAmount = industrySpent.get(security.sector) ?? 0;
    const sectorCap = investable * MAX_INDUSTRY_WEIGHT - currentIndustryAmount;
    const positionBudget = Math.max(0, Math.min(assetCap, sectorCap));
    const costPerLot = quote.price * security.lotSize;
    const affordableLots = Math.floor(positionBudget / costPerLot);
    const quantity = affordableLots * security.lotSize;

    if (quantity <= 0) {
      continue;
    }

    const amount = quantity * quote.price;
    const fee = calculateTransactionCost(amount, "buy", {
      ...DEFAULT_A_SHARE_COSTS,
      commissionRate: transactionRate,
      minimumCommission: minimumFee,
    }).total;
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
