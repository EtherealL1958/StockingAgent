import type { FinancialMetrics, InvestorProfile } from "./types.js";

export interface TradeDecision {
  readonly allowed: boolean;
  readonly reason: string;
}

export function assessTrade(
  profile: InvestorProfile,
  metrics: FinancialMetrics,
  amount: number,
  fee: number,
): TradeDecision {
  if (amount <= 0) {
    return {
      allowed: false,
      reason: "交易金额无效",
    };
  }
  const historicalDrawdownLimit = Math.min(0.8, profile.maxDrawdown * 2);
  if (
    metrics.maxDrawdown !== undefined &&
    metrics.maxDrawdown > historicalDrawdownLimit
  ) {
    return {
      allowed: false,
      reason: "历史最大回撤超过用户风险预算的两倍",
    };
  }
  // 沿用现有启发式成本门控；并非预期收益或风险概率模型。
  const feeRatio = fee / amount;
  const riskCompensationBuffer = 0.01;
  const costThreshold = Math.max(profile.maxDrawdown, 0.01);
  if (feeRatio + riskCompensationBuffer >= costThreshold) {
    return {
      allowed: false,
      reason: "交易成本和风险补偿不匹配",
    };
  }
  return {
    allowed: true,
    reason: "通过风险门控",
  };
}
