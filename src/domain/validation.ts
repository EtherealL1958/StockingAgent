import { z } from "zod";
import type { InvestorProfile, Security } from "./types.js";

const profileSchema = z.object({
  investableCash: z.number().finite().nonnegative(),
  monthlyContribution: z.number().finite().nonnegative(),
  horizonYears: z.number().finite().positive(),
  riskLevel: z.enum(["low", "medium", "high"]),
  maxDrawdown: z.number().finite().gte(0).lte(1),
  emergencyCashRequired: z.number().finite().nonnegative(),
  cashReserveRatio: z.number().finite().gte(0).lte(1).optional(),
});

export function parseInvestorProfile(value: unknown): InvestorProfile {
  const parsed = profileSchema.parse(value);
  if (typeof parsed.cashReserveRatio !== "number") {
    const { cashReserveRatio: _unused, ...profileWithoutReserve } = parsed;
    return profileWithoutReserve;
  }
  const { cashReserveRatio, ...baseProfile } = parsed;
  return { ...baseProfile, cashReserveRatio };
}

export function parseSecurity(value: unknown): Security {
  return z.object({
    ticker: z.string().min(1),
    name: z.string().min(1),
    securityType: z.enum(["stock", "etf"]),
    board: z.enum(["sh_main", "sz_main", "bj_main", "chinext", "star", "etf"]),
    sector: z.string().min(1),
    lotSize: z.number().int().positive(),
    isIndex: z.boolean(),
  }).parse(value);
}
