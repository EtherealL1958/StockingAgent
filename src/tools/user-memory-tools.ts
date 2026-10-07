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
      description: "制定个性化投资计划前读取用户画像。profile 只返回有逐字段用户确认记录的事实，已确认且未变化的值直接复用。missingFields 是待补充项，unverifiedFields 是旧记录中无有效确认记录的字段，不表示用户从未回答。pendingConfirmation 是已生成的核对清单；已有提案时不要重复创建。不是持仓、行情或推测。",
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
      description: "收集到用户明确提供的画像信息后，用本工具生成一次核对清单；不要先在自然语言中要求确认再调用。例如 changes={monthlyContribution:200}, evidence={monthlyContribution:'每月200元'}。每个字段必须逐字引用用户消息，不得省略或拼接；用户回复‘其余不变’时可引用该原话并结合明确的上文提出候选，但不能自动确认。不接受 confirmed 或模型自证。闲钱不等于应急金为0，推荐ETF不等于用户偏好。null 表示候选清除；数组整体替换。更正会合并到现有提案，仅提交变化字段即可；与已确认值相同的字段会移除，并在 ignoredFields 中明确返回；相同提案复用原编号。返回 updated:false、requiresConfirmation、ignoredFields、message。requiresConfirmation=true 时系统展示并暂停，用户可回复‘确认’、‘确认 1,2’或‘取消画像’；false 时没有新变更，直接继续研究，不再要求确认。",
      input: z.object({ changes: profilePatchSchema, evidence: profileEvidenceSchema }).strict(),
      modelParameters: PROFILE_UPDATE_PARAMETERS,
      execute: async ({ changes, evidence }, context) => ({
        available: true,
        updated: false,
        ...await store.propose(changes, evidence, context?.userMessages ?? []),
      }),
      // Stop this model turn so the exact proposed values, rather than a paraphrase, are shown.
      userResponse: result => result.requiresConfirmation ? result.message : "",
    }),
  ] as const;
}
