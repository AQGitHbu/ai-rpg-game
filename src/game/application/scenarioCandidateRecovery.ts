import { type BudgetPolicy, type ScenarioBlueprintCandidate } from "@/game/domain";
import {
  loadScenarioProfiles,
  validateScenarioBlueprintCandidate,
  type ScenarioProfiles
} from "@/game/gameplay/rpg/scenario";

// ---------------------------------------------------------------------------
// Phase 4A 机械修复（spec §4）：住在编排层、source 之外，fixture 与未来 live
// source 共享。只做三类无内容创造的修复：
//   1. 删除根级未知字段；
//   2. trim 全部字符串；
//   3. 裁剪超预算列表尾部（locations / npcs / side quests）。
// 绝不新增或改写剧情内容、ID、引用、tag 或数值；修复后必须重新通过完整
// validateScenarioBlueprintCandidate，仍有 issue 一律返回 null（由编排重试/fallback）。
// ---------------------------------------------------------------------------

/** 候选根字段白名单（plan Task 3 固定集合）。 */
const ROOT_FIELD_WHITELIST = [
  "schemaVersion",
  "generationId",
  "seed",
  "templateVersion",
  "gameType",
  "inputDigest",
  "world",
  "player",
  "locations",
  "npcs",
  "quests",
  "enemies",
  "items",
  "endings",
  "openingScene",
  "budgetPolicy"
] as const;

export type RepairScenarioCandidateOptions = {
  /** 可注入 profiles 以便测试；默认加载内置 data/base 配置。 */
  readonly profiles?: ScenarioProfiles;
  readonly policy: BudgetPolicy;
};

export function repairScenarioCandidate(
  candidate: ScenarioBlueprintCandidate,
  options: RepairScenarioCandidateOptions
): ScenarioBlueprintCandidate | null {
  let repaired: ScenarioBlueprintCandidate;
  try {
    repaired = mechanicalRepair(candidate, options.policy);
  } catch {
    // 结构烂到无法机械处理（缺数组等）：不可修复。
    return null;
  }

  const profiles = options.profiles ?? loadScenarioProfiles();
  const profile = profiles.gameTypeProfiles[repaired.gameType];
  if (profile === undefined) return null;

  const result = validateScenarioBlueprintCandidate(repaired, { profile, policy: options.policy });
  return result.ok ? repaired : null;
}

// ---------------------------------------------------------------------------
// 内部实现：先 clone，绝不原地修改传入候选（可能是被冻结的 fixture）。
// ---------------------------------------------------------------------------

function mechanicalRepair(candidate: ScenarioBlueprintCandidate, policy: BudgetPolicy): ScenarioBlueprintCandidate {
  const source = candidate as unknown as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const field of ROOT_FIELD_WHITELIST) {
    if (field in source) picked[field] = source[field];
  }
  const cloned = deepTrimClone(picked) as Record<string, unknown>;

  // 裁剪超预算列表尾部：数量不足或其余违规交给完整 validator 判死。
  const maxLocations = policy.opening.mainLocationsMax + policy.opening.hiddenLocationsMax;
  cloned.locations = (cloned.locations as unknown[]).slice(0, maxLocations);
  cloned.npcs = (cloned.npcs as unknown[]).slice(0, policy.opening.coreNpcsMax);

  // side quests 只裁剪 side 类目的尾部，主线相对顺序保持不变。
  let sideKept = 0;
  cloned.quests = (cloned.quests as { kind?: unknown }[]).filter((quest) => {
    if (quest.kind !== "side") return true;
    sideKept += 1;
    return sideKept <= policy.opening.sideQuestsMax;
  });

  return cloned as unknown as ScenarioBlueprintCandidate;
}

/** 深拷贝 + 全量字符串 trim；不改变数字/布尔/null，数组顺序保持。 */
function deepTrimClone(value: unknown): unknown {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map((item) => deepTrimClone(item));
  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = deepTrimClone(entry);
    }
    return result;
  }
  return value;
}
