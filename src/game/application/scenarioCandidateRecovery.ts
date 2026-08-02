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
//   3. 删除非法的可选物品展示元数据（不改物品本体或规则字段）；
//   4. 裁剪超预算列表（locations / npcs / side quests）。NPC 裁剪优先移除
//      未被地点、开局场景或任务目标引用的安全冗余项，避免尾部恰好是主线 NPC
//      时制造悬空引用。
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

  cloned.items = sanitizeItemPresentationMetadata(
    cloned.items as ScenarioBlueprintCandidate["items"]
  );

  // 裁剪超预算列表；数量不足或其余违规交给完整 validator 判死。
  const maxLocations = policy.opening.mainLocationsMax + policy.opening.hiddenLocationsMax;
  cloned.locations = (cloned.locations as unknown[]).slice(0, maxLocations);
  cloned.npcs = pruneNpcBudget(
    cloned.npcs as ScenarioBlueprintCandidate["npcs"],
    cloned.locations as ScenarioBlueprintCandidate["locations"],
    cloned.quests as ScenarioBlueprintCandidate["quests"],
    cloned.openingScene as ScenarioBlueprintCandidate["openingScene"],
    policy.opening.coreNpcsMax
  );

  // side quests 只裁剪 side 类目的尾部，主线相对顺序保持不变。
  let sideKept = 0;
  cloned.quests = (cloned.quests as { kind?: unknown }[]).filter((quest) => {
    if (quest.kind !== "side") return true;
    sideKept += 1;
    return sideKept <= policy.opening.sideQuestsMax;
  });

  return cloned as unknown as ScenarioBlueprintCandidate;
}

const ITEM_CATEGORIES = new Set(["equipment", "consumable", "material", "quest"]);
const ITEM_RARITIES = new Set(["common", "fine", "rare", "epic"]);
const ITEM_STAT_LINES_MAX = 6;

function sanitizeItemPresentationMetadata(
  items: ScenarioBlueprintCandidate["items"]
): ScenarioBlueprintCandidate["items"] {
  return items.map((item) => {
    const sanitized = { ...(item as unknown as Record<string, unknown>) };

    if (sanitized.category !== undefined && !ITEM_CATEGORIES.has(String(sanitized.category))) {
      delete sanitized.category;
    }
    if (sanitized.rarity !== undefined && !ITEM_RARITIES.has(String(sanitized.rarity))) {
      delete sanitized.rarity;
    }
    if (
      sanitized.level !== undefined &&
      (!Number.isInteger(sanitized.level) ||
        Number(sanitized.level) < 1 ||
        Number(sanitized.level) > 99)
    ) {
      delete sanitized.level;
    }

    if (sanitized.statLines !== undefined && !isValidItemStatLines(sanitized.statLines)) {
      delete sanitized.statLines;
    }

    return sanitized as unknown as ScenarioBlueprintCandidate["items"][number];
  });
}

function isValidItemStatLines(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > ITEM_STAT_LINES_MAX) return false;
  return value.every((line) => {
    if (typeof line !== "object" || line === null) return false;
    const record = line as Record<string, unknown>;
    return (
      typeof record.label === "string" &&
      record.label.trim() !== "" &&
      typeof record.value === "string" &&
      record.value.trim() !== ""
    );
  });
}

function pruneNpcBudget(
  npcs: ScenarioBlueprintCandidate["npcs"],
  locations: ScenarioBlueprintCandidate["locations"],
  quests: ScenarioBlueprintCandidate["quests"],
  openingScene: ScenarioBlueprintCandidate["openingScene"],
  maxCount: number
): ScenarioBlueprintCandidate["npcs"] {
  const kept = [...npcs];
  while (kept.length > maxCount) {
    const referenced = new Set<string>([
      ...locations.flatMap((location) => location.npcIds.map(String)),
      ...openingScene.presentNpcIds.map(String),
      ...quests.flatMap((quest) =>
        quest.objectives.flatMap((objective) =>
          objective.kind === "talk_to_npc" ? [String(objective.npcId)] : []
        )
      )
    ]);
    const removableIndex = [...kept]
      .map((npc, index) => ({ npc, index }))
      .reverse()
      .sort((left, right) => Number(left.npc.isCompanion) - Number(right.npc.isCompanion))
      .find(({ npc }) => !referenced.has(String(npc.id)))?.index;
    if (removableIndex === undefined) return kept;
    kept.splice(removableIndex, 1);
  }
  return kept;
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
