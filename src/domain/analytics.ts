import type { DailyBar } from "./types.js";

export interface PriceAnalytics {
  readonly observationCount: number;
  readonly firstDate: string;
  readonly lastDate: string;
  /** 区间简单收益，0.10 表示上涨 10%。 */
  readonly periodReturn: number;
  readonly movingAverages: Readonly<Record<20 | 60 | 120, number | undefined>>;
  /** 日收益标准差年化，使用 252 个交易日。 */
  readonly annualizedVolatility: number | undefined;
  /** 最大回撤幅度为正数，例如 0.25 表示从峰值回撤 25%。 */
  readonly maxDrawdown: number;
  readonly averageVolume20: number | undefined;
  readonly rsi14: number | undefined;
}

function assertPeriod(period: number): void {
  if (!Number.isInteger(period) || period <= 0) {
    throw new Error(`指标周期必须为正整数: ${period}`);
  }
}

function assertPrices(prices: readonly number[]): void {
  if (prices.some(price => !Number.isFinite(price) || price <= 0)) {
    throw new Error("价格序列必须只包含正数");
  }
}

export function simpleReturns(prices: readonly number[]): readonly number[] {
  if (prices.length < 2) return [];
  assertPrices(prices);
  return prices.slice(1).map((price, index) => price / prices[index]! - 1);
}

export function movingAverage(
  values: readonly number[],
  period: number,
): number | undefined {
  assertPeriod(period);
  if (values.length < period) return undefined;
  const window = values.slice(-period);
  return window.reduce((sum, value) => sum + value, 0) / period;
}

export function movingAverageSeries(
  values: readonly number[],
  period: number,
): readonly (number | undefined)[] {
  assertPeriod(period);
  return values.map((_, index) =>
    index + 1 < period ? undefined : movingAverage(values.slice(0, index + 1), period),
  );
}

export function annualizedVolatility(
  prices: readonly number[],
  tradingDaysPerYear = 252,
): number | undefined {
  const returns = simpleReturns(prices);
  if (returns.length < 2) return undefined;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(tradingDaysPerYear);
}

export function maximumDrawdown(prices: readonly number[]): number {
  if (prices.length === 0) return 0;
  assertPrices(prices);
  let peak = prices[0]!;
  let drawdown = 0;
  for (const price of prices) {
    peak = Math.max(peak, price);
    drawdown = Math.max(drawdown, (peak - price) / peak);
  }
  return drawdown;
}

/** Wilder RSI；不足 period+1 根时返回 undefined。 */
export function relativeStrengthIndex(
  prices: readonly number[],
  period = 14,
): number | undefined {
  assertPeriod(period);
  const returns = simpleReturns(prices);
  if (returns.length < period) return undefined;
  let gains = 0;
  let losses = 0;
  for (const change of returns.slice(0, period)) {
    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;
  for (const change of returns.slice(period)) {
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + averageGain / averageLoss);
}

export function analyzeDailyBars(bars: readonly DailyBar[]): PriceAnalytics {
  if (bars.length === 0) {
    throw new Error("没有可用于分析的日线数据");
  }
  const sortedBars = [...bars].sort((left, right) => left.date.localeCompare(right.date));
  const prices = sortedBars.map(bar => bar.close);
  const volumes = sortedBars.map(bar => bar.volume);
  const firstPrice = prices[0]!;
  const lastPrice = prices[prices.length - 1]!;
  return {
    observationCount: sortedBars.length,
    firstDate: sortedBars[0]!.date,
    lastDate: sortedBars[sortedBars.length - 1]!.date,
    periodReturn: lastPrice / firstPrice - 1,
    movingAverages: {
      20: movingAverage(prices, 20),
      60: movingAverage(prices, 60),
      120: movingAverage(prices, 120),
    },
    annualizedVolatility: annualizedVolatility(prices),
    maxDrawdown: maximumDrawdown(prices),
    averageVolume20: movingAverage(volumes, 20),
    rsi14: relativeStrengthIndex(prices),
  };
}
