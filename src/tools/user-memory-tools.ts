import { z } from "zod";
import { JsonUserProfileStore, profileEvidenceSchema, profilePatchSchema } from "../memory/user-profile.js";
import { defineTool } from "./tool.js";

const EMPTY_PARAMETERS = { type: "object", properties: {}, additionalProperties: false } as const;
const PROFILE_UPDATE_PARAMETERS = {
  type: "object",
  properties: {
    changes: {
      type: "object",
      minProperties: 1,
      additionalProperties: false,
      properties: {
        investableCash: { type: ["number", "null"], minimum: 0, description: "可投资资金，例如 10000 元" },
        monthlyContribution: { type: ["number", "null"], minimum: 0, description: "每月可投入金额，例如 500 元" },
        horizonYears: { type: ["number", "null"], exclusiveMinimum: 0, description: "投资期限，例如 3 年" },
        riskLevel: { type: ["string", "null"], enum: ["low", "medium", "high", null], description: "风险承受能力" },
        maxDrawdown: { type: ["number", "null"], minimum: 0, maximum: 1, description: "最大可接受回撤，例如 0.1 表示 10%" },
        emergencyCashRequired: { type: ["number", "null"], minimum: 0, description: "需要保留的应急现金，例如 20000 元" },
        investmentGoal: { type: ["string", "null"], enum: ["capital_preservation", "steady_growth", "long_term_growth", null], description: "投资目标" },
        experienceLevel: { type: ["string", "null"], enum: ["beginner", "intermediate", "advanced", null], description: "投资经验" },
        preferredAssets: { type: ["array", "null"], items: { type: "string", enum: ["broad_etf", "industry_etf", "stock", "bond", "cash"] }, description: "偏好资产类型" },
        avoidedSectors: { type: ["array", "null"], items: { type: "string" }, description: "希望回避的行业" },
        notes: { type: ["array", "null"], items: { type: "string" }, description: "长期约束或备注" },
      },
    },
    evidence: {
      type: "object",
      description: "逐字段用户原话，例如 {monthlyContribution:'每月200元'}；不能引用模型或工具内容",
      additionalProperties: { type: "string", minLength: 1, maxLength: 2000 },
    },
  },
  required: ["changes", "evidence"],
  additionalProperties: false,
} as const;

export function buildUserMemoryTools(store: JsonUserProfileStore) {
  return [
    defineTool({
      name: "get_user_profile",
      description: "制定个性化投资计划前读取用户画像。只返回有逐字段用户确认记录的事实；missingFields 是待询问项，unverifiedFields 是旧记录中无证据的字段。不是持仓、行情或推测。",
      input: z.object({}).strict(),
      modelParameters: EMPTY_PARAMETERS,
      execute: async () => ({
        available: true,
        profile: store.snapshot,
        missingFields: store.missingFields,
        unverifiedFields: store.unverifiedFields,
        planningProfile: store.toInvestorProfile() ?? null,
        pendingConfirmation: store.pendingPrompt ?? null,
      }),
    }),
    defineTool({
      name: "update_user_profile",
      description: "用户提供画像信息时提出待确认变更，例如 changes={monthlyContribution:200}, evidence={monthlyContribution:'每月200元'}。每个字段必须引用用户原话；不接受 confirmed 或模型自证。闲钱不等于应急金为0，推荐ETF不等于用户偏好。null 表示候选清除；数组整体替换。仅创建候选，系统展示明细并等待用户选择确认后才用于规划。",
      input: z.object({ changes: profilePatchSchema, evidence: profileEvidenceSchema }).strict(),
      modelParameters: PROFILE_UPDATE_PARAMETERS,
      execute: async ({ changes, evidence }, context) => ({
        available: true,
        updated: false,
        requiresConfirmation: true,
        message: await store.propose(changes, evidence, context?.userMessages ?? []),
      }),
      // Stop this model turn so the exact proposed values, rather than a paraphrase, are shown.
      userResponse: result => result.message,
    }),
  ] as const;
}
