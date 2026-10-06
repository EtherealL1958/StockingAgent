import { promises as fs } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { InvestorProfile } from "../domain/types.js";

const riskLevelSchema = z.enum(["low", "medium", "high"]);
const investmentGoalSchema = z.enum(["capital_preservation", "steady_growth", "long_term_growth"]);
const experienceLevelSchema = z.enum(["beginner", "intermediate", "advanced"]);
const assetSchema = z.enum(["broad_etf", "industry_etf", "stock", "bond", "cash"]);

export const userProfileSchema = z.object({
  version: z.literal(1),
  userId: z.string().min(1),
  updatedAt: z.string().datetime(),
  investableCash: z.number().nonnegative().optional(),
  monthlyContribution: z.number().nonnegative().optional(),
  horizonYears: z.number().positive().optional(),
  riskLevel: riskLevelSchema.optional(),
  maxDrawdown: z.number().min(0).max(1).optional(),
  emergencyCashRequired: z.number().nonnegative().optional(),
  investmentGoal: investmentGoalSchema.optional(),
  experienceLevel: experienceLevelSchema.optional(),
  preferredAssets: z.array(assetSchema).max(10).optional(),
  avoidedSectors: z.array(z.string().min(1).max(80)).max(30).optional(),
  notes: z.array(z.string().min(1).max(500)).max(30).optional(),
});

export type UserProfile = z.infer<typeof userProfileSchema>;

export type UserProfilePatch = {
  readonly investableCash?: number | null | undefined;
  readonly monthlyContribution?: number | null | undefined;
  readonly horizonYears?: number | null | undefined;
  readonly riskLevel?: UserProfile["riskLevel"] | null | undefined;
  readonly maxDrawdown?: number | null | undefined;
  readonly emergencyCashRequired?: number | null | undefined;
  readonly investmentGoal?: UserProfile["investmentGoal"] | null | undefined;
  readonly experienceLevel?: UserProfile["experienceLevel"] | null | undefined;
  readonly preferredAssets?: UserProfile["preferredAssets"] | null | undefined;
  readonly avoidedSectors?: UserProfile["avoidedSectors"] | null | undefined;
  readonly notes?: UserProfile["notes"] | null | undefined;
};

export interface OpenUserProfileOptions {
  readonly cwd: string;
  readonly filePath?: string;
  readonly userId?: string;
}

export class JsonUserProfileStore {
  private constructor(private profile: UserProfile, public readonly filePath: string) {}

  public static async open(options: OpenUserProfileOptions): Promise<JsonUserProfileStore> {
    const filePath = options.filePath
      ? (isAbsolute(options.filePath) ? options.filePath : resolve(options.cwd, options.filePath))
      : resolve(options.cwd, ".stocking", "user-profile.json");
    try {
      const profile = userProfileSchema.parse(JSON.parse(await fs.readFile(filePath, "utf8")) as unknown);
      return new JsonUserProfileStore(profile, filePath);
    } catch (error) {
      if (!isMissingFile(error)) throw new Error(`用户画像文件无效: ${filePath}`);
      const store = new JsonUserProfileStore(emptyProfile(options.userId ?? "default"), filePath);
      await store.persist();
      return store;
    }
  }

  public get snapshot(): UserProfile {
    return this.profile;
  }

  public get missingFields(): readonly string[] {
    const labels: Array<[keyof UserProfile, string]> = [
      ["investableCash", "可投资资金"],
      ["monthlyContribution", "每月可投入金额"],
      ["horizonYears", "投资期限"],
      ["riskLevel", "风险承受能力"],
      ["maxDrawdown", "最大可接受回撤"],
      ["emergencyCashRequired", "应急现金需求"],
    ];
    return labels.filter(([key]) => this.profile[key] === undefined).map(([, label]) => label);
  }

  public async update(patch: UserProfilePatch): Promise<UserProfile> {
    const next: Record<string, unknown> = { ...this.profile, updatedAt: new Date().toISOString() };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete next[key];
      else if (value !== undefined) next[key] = value;
    }
    if (patch.preferredAssets) next.preferredAssets = [...new Set(patch.preferredAssets)];
    if (patch.avoidedSectors) next.avoidedSectors = [...new Set(patch.avoidedSectors)];
    if (patch.notes) next.notes = [...new Set(patch.notes)];
    const profile = userProfileSchema.parse(next);
    this.profile = profile;
    await this.persist();
    return profile;
  }

  public toInvestorProfile(): InvestorProfile | undefined {
    const profile = this.profile;
    if (
      profile.investableCash === undefined || profile.monthlyContribution === undefined ||
      profile.horizonYears === undefined || profile.riskLevel === undefined ||
      profile.maxDrawdown === undefined || profile.emergencyCashRequired === undefined
    ) return undefined;
    return {
      investableCash: profile.investableCash,
      monthlyContribution: profile.monthlyContribution,
      horizonYears: profile.horizonYears,
      riskLevel: profile.riskLevel,
      maxDrawdown: profile.maxDrawdown,
      emergencyCashRequired: profile.emergencyCashRequired,
    };
  }

  public toPromptContext(): string {
    const known = Object.fromEntries(Object.entries(this.profile).filter(([key, value]) => key !== "version" && key !== "userId" && key !== "updatedAt" && value !== undefined));
    return `用户画像（持久化，更新时间 ${this.profile.updatedAt}）：\n已确认字段：${JSON.stringify(known)}\n尚未确认：${this.missingFields.length > 0 ? this.missingFields.join("、") : "无"}\n使用规则：只能使用用户明确提供或确认的字段；缺少关键画像时先询问用户，不得猜测资金、期限或风险承受能力。`;
  }

  private async persist(): Promise<void> {
    await fs.mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(this.profile, null, 2)}\n`, "utf8");
    await fs.rename(temporaryPath, this.filePath);
  }
}

function emptyProfile(userId: string): UserProfile {
  return { version: 1, userId, updatedAt: new Date().toISOString() };
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { readonly code?: unknown }).code === "ENOENT";
}
