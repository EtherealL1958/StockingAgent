import type { FinancialMetrics, ScoreBreakdown } from "./types.js";

type WeightedValue = readonly [number | undefined, number];

function scoreHigherIsBetter(value: number | undefined, low: number, high: number): number | undefined {
  if (value === undefined) return undefined;
  const normalizedScore = ((value - low) / (high - low)) * 100;
  return Math.max(0, Math.min(100, normalizedScore));
}

function scoreLowerIsBetter(value: number | undefined, low: number, high: number): number | undefined {
  const score = scoreHigherIsBetter(value, low, high);
  return score === undefined ? undefined : 100 - score;
}

/** 缺失指标不参与平均，避免把未知数据伪装成中性分数。 */
function weightedAverage(values: readonly WeightedValue[]): number | undefined {
  const available = values.filter((entry): entry is [number, number] => entry[0] !== undefined);
  if (available.length === 0) return undefined;
  const totalWeight = available.reduce((sum, [, weight]) => sum + weight, 0);
  return available.reduce((sum, [value, weight]) => sum + value * weight, 0) / totalWeight;
}

function roundScore(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.round(value * 100) / 100;
}

export function scoreSecurity(metrics: FinancialMetrics): ScoreBreakdown {
  const quality = weightedAverage([
    [scoreHigherIsBetter(metrics.roe, 0, 25), 0.30],
    [scoreHigherIsBetter(metrics.grossMargin, 0, 60), 0.20],
    [scoreLowerIsBetter(metrics.debtRatio, 0, 100), 0.25],
    [scoreHigherIsBetter(metrics.freeCashFlow, -1e8, 1e8), 0.25],
  ]);
  const valuation = weightedAverage([
    [scoreLowerIsBetter(metrics.pe, 5, 80), 0.40],
    [scoreLowerIsBetter(metrics.pb, 0.5, 10), 0.30],
    [scoreHigherIsBetter(metrics.dividendYield, 0, 8), 0.30],
  ]);
  const stability = weightedAverage([
    [scoreLowerIsBetter(metrics.volatility, 0.05, 0.8), 0.45],
    [scoreLowerIsBetter(metrics.maxDrawdown, 0.05, 0.8), 0.40],
    [scoreLowerIsBetter(metrics.beta, 0.5, 2), 0.15],
  ]);
  const growth = weightedAverage([
    [scoreHigherIsBetter(metrics.revenueGrowth, -0.2, 0.4), 0.55],
    [scoreHigherIsBetter(metrics.netProfitGrowth, -0.5, 0.8), 0.45],
  ]);
  const momentum = scoreHigherIsBetter(metrics.momentum, -0.5, 0.5);
  const total = weightedAverage([
    [quality, 0.30],
    [valuation, 0.20],
    [stability, 0.25],
    [growth, 0.15],
    [momentum, 0.10],
  ]);
  const availableDimensions = [quality, valuation, stability, growth, momentum].filter(value => value !== undefined).length;

  return {
    quality: roundScore(quality),
    valuation: roundScore(valuation),
    stability: roundScore(stability),
    growth: roundScore(growth),
    momentum: roundScore(momentum),
    total: roundScore(total),
    completeness: availableDimensions / 5,
  };
}
