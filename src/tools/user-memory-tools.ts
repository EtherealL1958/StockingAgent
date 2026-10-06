import { z } from "zod";
import { JsonUserProfileStore } from "../memory/user-profile.js";
import { defineTool } from "./tool.js";

const nullableNonNegative = z.number().nonnegative().nullable().optional();

export function buildUserMemoryTools(store: JsonUserProfileStore) {
  return [
    defineTool({
      name: "get_user_profile",
      description: "当需要制定个性化投资计划、组合配置、再平衡或解释风险时使用；也可在主动询问用户前使用。返回持久化且已确认的字段和缺失字段。不要把对话中的猜测写入画像，不返回行情或持仓数据。",
      input: z.object({}),
      execute: async () => ({
        available: true,
        profile: store.snapshot,
        missingFields: store.missingFields,
        planningProfile: store.toInvestorProfile(),
        nextQuestions: store.missingFields.length > 0
          ? `请依次询问：${store.missingFields.join("、")}。用户确认后再调用 update_user_profile。`
          : "用户画像字段已齐全，可结合当前组合和行情制定计划。",
      }),
    }),
    defineTool({
      name: "update_user_profile",
      description: "当用户明确提供或确认资金、投入计划、期限、风险承受能力或投资偏好时使用。必须把 confirmed=true；false 只返回需要确认，不会写入。字段传 null 表示用户明确要求清除该字段。工具只更新用户画像，不执行交易，不修改组合持仓。",
      input: z.object({
        confirmed: z.boolean().describe("用户是否明确说出或确认这些信息；只有 true 才会持久化"),
        investableCash: nullableNonNegative.describe("可投资资金，人民币，例如 10000；不是全部生活费"),
        monthlyContribution: nullableNonNegative.describe("每月可继续投入金额，例如 500"),
        horizonYears: z.number().positive().nullable().optional().describe("计划投资期限，例如 3 或 5"),
        riskLevel: z.enum(["low", "medium", "high"]).nullable().optional().describe("风险承受能力，例如 low"),
        maxDrawdown: z.number().min(0).max(1).nullable().optional().describe("最大可接受回撤比例，例如 0.1 表示 10%"),
        emergencyCashRequired: nullableNonNegative.describe("需要保留的应急现金，人民币，例如 20000"),
        investmentGoal: z.enum(["capital_preservation", "steady_growth", "long_term_growth"]).nullable().optional().describe("目标：保本优先、稳健增长或长期增长"),
        experienceLevel: z.enum(["beginner", "intermediate", "advanced"]).nullable().optional().describe("投资经验，例如 beginner"),
        preferredAssets: z.array(z.enum(["broad_etf", "industry_etf", "stock", "bond", "cash"])).max(10).nullable().optional().describe("用户明确偏好的资产类型，例如 [broad_etf, cash]"),
        avoidedSectors: z.array(z.string().min(1).max(80)).max(30).nullable().optional().describe("用户明确希望回避的行业，例如 [房地产]"),
        notes: z.array(z.string().min(1).max(500)).max(30).nullable().optional().describe("用户明确表达的长期投资约束或偏好"),
      }).refine(value => Object.keys(value).some(key => key !== "confirmed" && value[key as keyof typeof value] !== undefined), "至少提供一个画像字段"),
      execute: async input => {
        if (!input.confirmed) {
          return { available: false, updated: false, requiresConfirmation: true, message: "用户画像未更新；请先向用户复述这些字段并请求确认。" };
        }
        const { confirmed: _confirmed, ...patch } = input;
        const profile = await store.update(patch);
        return { available: true, updated: true, profile, missingFields: store.missingFields, planningProfile: store.toInvestorProfile() };
      },
    }),
  ];
}
