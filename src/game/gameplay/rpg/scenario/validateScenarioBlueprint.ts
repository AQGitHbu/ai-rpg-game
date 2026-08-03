import {
  type BudgetPolicy,
  type ItemCategory,
  type ItemRarity,
  type ScenarioBlueprintCandidate,
  type StatBlock
} from "@/game/domain";
import type { GameTypeProfile } from "./gameTypeProfiles";
import {
  validateQuestGraph,
  type QuestGraphIssueCode,
  type QuestGraphKnownEntityIds
} from "./questGraph";

// ---------------------------------------------------------------------------
// 候选蓝图整体校验（Task 5）。
//
// 纯函数：候选与 profile 全部由调用方注入，内部不读配置/时间/随机/环境。
// collect-all：一次返回全部结构化问题，供上游决定修复或 fallback。
// 任务图部分完全复用 questGraph 的校验，其问题原样并入（路径本就以
// quests/endings 开头，与蓝图字段对齐，无需改写）。
// ---------------------------------------------------------------------------

export type NumericRange = { readonly min: number; readonly max: number };

/** Phase 1 数值目录：校验、测试与 Task 6 fallback 生成器共同引用，禁止另写字面量。 */
export const PHASE1_NUMERIC_RANGES = Object.freeze({
  playerHp: Object.freeze({ min: 1, max: 99 }),
  playerAttack: Object.freeze({ min: 1, max: 99 }),
  playerDefense: Object.freeze({ min: 1, max: 99 }),
  enemyHp: Object.freeze({ min: 1, max: 999 }),
  enemyAttack: Object.freeze({ min: 0, max: 99 }),
  enemyDefense: Object.freeze({ min: 0, max: 99 })
} as const) satisfies Readonly<Record<string, NumericRange>>;

// 背包界面重构：物品展示元数据的封闭枚举与边界（可选字段，提供时必须合法）。
const ITEM_CATEGORIES: ReadonlySet<ItemCategory> = new Set([
  "equipment", "consumable", "material", "quest"
]);
const ITEM_RARITIES: ReadonlySet<ItemRarity> = new Set(["common", "fine", "rare", "epic"]);
export const ITEM_LEVEL_RANGE: NumericRange = Object.freeze({ min: 1, max: 99 });
export const ITEM_STAT_LINES_MAX = 6;

// Town 层：地点层级封闭枚举（town 配额由 policy.opening.townLocationsMax 驱动）。
const LOCATION_SCALES: ReadonlySet<string> = new Set(["scene", "town"]);

export type ScenarioBlueprintIssueCode =
  | QuestGraphIssueCode
  | "INVALID_SCHEMA_VERSION"
  | "REQUIRED"
  | "GAME_TYPE_MISMATCH"
  | "BUDGET_POLICY_MISMATCH"
  | "MAIN_LOCATION_COUNT_OUT_OF_RANGE"
  | "HIDDEN_LOCATION_OVERBUDGET"
  | "CORE_NPC_COUNT_OUT_OF_RANGE"
  | "COMPANION_OVERBUDGET"
  | "DUPLICATE_GLOBAL_ID"
  | "DANGLING_REFERENCE"
  | "DUPLICATE_AVAILABLE_ITEM"
  | "STARTING_ITEM_AVAILABLE_AT_LOCATION"
  | "INVALID_ENDING_REQUIREMENT"
  | "OPENING_SCENE_HIDDEN_LOCATION"
  | "OPENING_NPC_NOT_AT_LOCATION"
  | "OPENING_SCENE_NO_INVESTIGABLE_FACTS"
  | "DUPLICATE_INVESTIGABLE_FACT"
  | "FORBIDDEN_TAG"
  | "INVALID_ITEM_PRESENTATION"
  | "INVALID_LOCATION_SCALE"
  | "TOWN_LOCATION_OVERBUDGET"
  | "REPEATED_MAIN_QUEST_DESCRIPTION"
  | "REPEATED_MAIN_QUEST_DESCRIPTION_FRAGMENT"
  | "UNANCHORED_GENERATED_FACT"
  | "MAINLINE_GENERATED_FACT_MISSING"
  | "OUT_OF_RANGE";

export type ScenarioBlueprintIssue = {
  path: string;
  code: ScenarioBlueprintIssueCode;
  params: Record<string, string | number>;
};

/** 校验上下文：profile 与 policy 由调用方（application 层）注入。 */
export type ScenarioValidationContext = {
  profile: GameTypeProfile;
  policy: BudgetPolicy;
};

declare const validatedScenarioBlueprintCandidateBrand: unique symbol;

/** 只有 validateScenarioBlueprintCandidate 成功才能产生；compile 只接受这个类型。 */
export type ValidatedScenarioBlueprintCandidate = ScenarioBlueprintCandidate & {
  readonly [validatedScenarioBlueprintCandidateBrand]: true;
};

export type ValidateScenarioBlueprintResult =
  | { ok: true; validated: ValidatedScenarioBlueprintCandidate }
  | { ok: false; issues: readonly ScenarioBlueprintIssue[] };

export function validateScenarioBlueprintCandidate(
  candidate: ScenarioBlueprintCandidate,
  context: ScenarioValidationContext
): ValidateScenarioBlueprintResult {
  const issues: ScenarioBlueprintIssue[] = [];

  validateSchemaBasics(issues, candidate, context.profile, context.policy);
  validateBudgetCounts(issues, candidate, context.policy);
  validateGlobalIdUniqueness(issues, candidate);
  validateReferences(issues, candidate);
  validateGeneratedFactAnchors(issues, candidate, context.policy);
  validateAvailableItems(issues, candidate);
  validateOpeningScene(issues, candidate);
  // 任务 objective/outcome 引用、主线阶段、支线/结局预算与可达性全部委托任务图校验。
  issues.push(
    ...validateQuestGraph({
      quests: candidate.quests,
      endings: candidate.endings,
      knownEntityIds: collectKnownEntityIds(candidate),
      budget: { mainActs: context.policy.mainActs, sideQuestsMax: context.policy.opening.sideQuestsMax, endings: context.policy.opening.endings }
    })
  );
  validateNumericRanges(issues, candidate);
  validateForbiddenTags(issues, candidate, context.profile);
  validateItemPresentationMetadata(issues, candidate);
  validateLocationScales(issues, candidate, context.policy);
  validateMainQuestDescriptionDensity(issues, candidate);

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, validated: candidate as ValidatedScenarioBlueprintCandidate };
}

/**
 * Generated facts are only useful when the rules or a known NPC can surface
 * them. Keep player-input facts permissive, but reject generated orphan facts
 * and require medium/long mainlines to carry at least one generated fact
 * discovery objective.
 */
function validateGeneratedFactAnchors(
  issues: ScenarioBlueprintIssue[],
  candidate: ScenarioBlueprintCandidate,
  policy: BudgetPolicy,
): void {
  const anchored = new Set<string>(candidate.openingScene.investigableFactIds ?? []);
  for (const npc of candidate.npcs) {
    for (const factId of npc.knownFactIds ?? []) anchored.add(factId);
  }
  for (const quest of candidate.quests) {
    for (const objective of quest.objectives ?? []) {
      if (objective.kind === "discover_fact") anchored.add(objective.factId);
    }
  }
  for (const ending of candidate.endings) {
    for (const requirement of ending.requirements ?? []) {
      if (requirement.kind === "fact_discovered") anchored.add(requirement.factId);
    }
  }

  for (const [index, fact] of candidate.world.facts.entries()) {
    if (fact.source === "generated" && !anchored.has(fact.id)) {
      issues.push({
        path: `world.facts[${index}]`,
        code: "UNANCHORED_GENERATED_FACT",
        params: { factId: fact.id },
      });
    }
  }

  const hasMainlineGeneratedFact = candidate.quests.some((quest) =>
    quest.kind === "main" && (quest.objectives ?? []).some((objective) =>
      objective.kind === "discover_fact" &&
      candidate.world.facts.some((fact) => fact.id === objective.factId && fact.source === "generated")
    )
  );
  if (policy.mainActs >= 5 && !hasMainlineGeneratedFact) {
    issues.push({ path: "quests", code: "MAINLINE_GENERATED_FACT_MISSING", params: {} });
  }
}

/**
 * 主线阶段是玩家理解推进的最小语义单位。完全复用同一段非空描述会让
 * 不同 objective 看起来像同一幕，尤其会掩盖 AI 候选把阶段目标复制粘贴的
 * 情况。只比较规范化后的完整描述，保留空描述的旧候选兼容性。
 */
function validateMainQuestDescriptionDensity(
  issues: ScenarioBlueprintIssue[],
  candidate: ScenarioBlueprintCandidate,
): void {
  const firstByDescription = new Map<string, number>();
  candidate.quests
    .filter((quest) => quest.kind === "main")
    .forEach((quest) => {
      const description = quest.description.trim();
      if (description === "") return;
      const firstStage = firstByDescription.get(description);
      if (firstStage !== undefined) {
        const index = candidate.quests.findIndex((entry) => entry.id === quest.id);
        issues.push({
          path: `quests[${index}].description`,
          code: "REPEATED_MAIN_QUEST_DESCRIPTION",
          params: { firstStage, stage: quest.stage },
        });
        return;
      }
      firstByDescription.set(description, quest.stage);
    });

  const firstByFragment = new Map<string, number>();
  candidate.quests
    .filter((quest) => quest.kind === "main")
    .forEach((quest) => {
      for (const fragment of meaningfulDescriptionFragments(quest.description)) {
        const firstStage = firstByFragment.get(fragment);
        if (firstStage !== undefined && firstStage !== quest.stage) {
          const index = candidate.quests.findIndex((entry) => entry.id === quest.id);
          issues.push({
            path: `quests[${index}].description`,
            code: "REPEATED_MAIN_QUEST_DESCRIPTION_FRAGMENT",
            params: { firstStage, stage: quest.stage, fragment },
          });
        } else if (firstStage === undefined) {
          firstByFragment.set(fragment, quest.stage);
        }
      }
    });
}

function meaningfulDescriptionFragments(value: string): readonly string[] {
  return [...new Set(value
    .replace(/^第\s*\d+\s*幕[：:]?/, "")
    .split(/[。！？!?；;]/)
    .map((part) => part.replace(/\s+/g, "").trim())
    .filter((part) => Array.from(part).length >= 8))];
}

// ---------------------------------------------------------------------------
// 1. schema 基础
// ---------------------------------------------------------------------------

const REQUIRED_TEXT_FIELDS = ["generationId", "seed", "templateVersion", "inputDigest"] as const;

function validateSchemaBasics(
  issues: ScenarioBlueprintIssue[],
  candidate: ScenarioBlueprintCandidate,
  profile: GameTypeProfile,
  policy: BudgetPolicy
): void {
  if (candidate.schemaVersion !== 1) {
    issues.push({
      path: "schemaVersion",
      code: "INVALID_SCHEMA_VERSION",
      params: { expected: 1, actual: String(candidate.schemaVersion) }
    });
  }
  for (const field of REQUIRED_TEXT_FIELDS) {
    const value = candidate[field];
    if (typeof value !== "string" || value.trim() === "") {
      issues.push({ path: field, code: "REQUIRED", params: {} });
    }
  }
  if (candidate.gameType !== profile.id) {
    issues.push({
      path: "gameType",
      code: "GAME_TYPE_MISMATCH",
      params: { expected: profile.id, actual: String(candidate.gameType) }
    });
  }
  // 候选必须原样复述派生的 budgetPolicy（JSON round-trip 深比较，防 AI 私改预算）。
  const declared = candidate.budgetPolicy;
  if (JSON.stringify(declared ?? null) !== JSON.stringify(policy)) {
    issues.push({ path: "budgetPolicy", code: "BUDGET_POLICY_MISMATCH", params: {} });
  }
}

// ---------------------------------------------------------------------------
// 2. 内容预算数量（主线阶段数、支线数、结局数由 questGraph 检查）
// ---------------------------------------------------------------------------

function validateBudgetCounts(
  issues: ScenarioBlueprintIssue[],
  candidate: ScenarioBlueprintCandidate,
  policy: BudgetPolicy
): void {
  const mainCount = candidate.locations.filter((entry) => entry.kind === "main").length;
  if (mainCount < policy.opening.mainLocationsMin || mainCount > policy.opening.mainLocationsMax) {
    issues.push({
      path: "locations",
      code: "MAIN_LOCATION_COUNT_OUT_OF_RANGE",
      params: { min: policy.opening.mainLocationsMin, max: policy.opening.mainLocationsMax, actual: mainCount }
    });
  }
  const hiddenCount = candidate.locations.filter((entry) => entry.kind === "hidden").length;
  if (hiddenCount > policy.opening.hiddenLocationsMax) {
    issues.push({
      path: "locations",
      code: "HIDDEN_LOCATION_OVERBUDGET",
      params: { max: policy.opening.hiddenLocationsMax, actual: hiddenCount }
    });
  }
  const npcCount = candidate.npcs.length;
  if (npcCount < policy.opening.coreNpcsMin || npcCount > policy.opening.coreNpcsMax) {
    issues.push({
      path: "npcs",
      code: "CORE_NPC_COUNT_OUT_OF_RANGE",
      params: { min: policy.opening.coreNpcsMin, max: policy.opening.coreNpcsMax, actual: npcCount }
    });
  }
  const companionCount = candidate.npcs.filter((entry) => entry.isCompanion === true).length;
  if (companionCount > policy.opening.companionsMax) {
    issues.push({
      path: "npcs",
      code: "COMPANION_OVERBUDGET",
      params: { max: policy.opening.companionsMax, actual: companionCount }
    });
  }
}

// ---------------------------------------------------------------------------
// 3. 全局 ID 唯一（跨全部实体种类；同种类重复同样在此检出）
// ---------------------------------------------------------------------------

function validateGlobalIdUniqueness(
  issues: ScenarioBlueprintIssue[],
  candidate: ScenarioBlueprintCandidate
): void {
  const seen = new Map<string, string>(); // id → 首次出现的实体种类
  const record = (id: string, kind: string, path: string): void => {
    const firstKind = seen.get(id);
    if (firstKind !== undefined) {
      issues.push({ path, code: "DUPLICATE_GLOBAL_ID", params: { id, kind, firstKind } });
      return;
    }
    seen.set(id, kind);
  };

  candidate.locations.forEach((entry, index) => record(entry.id, "location", `locations[${index}].id`));
  candidate.npcs.forEach((entry, index) => record(entry.id, "npc", `npcs[${index}].id`));
  candidate.quests.forEach((entry, index) => record(entry.id, "quest", `quests[${index}].id`));
  candidate.items.forEach((entry, index) => record(entry.id, "item", `items[${index}].id`));
  candidate.enemies.forEach((entry, index) => record(entry.id, "enemy", `enemies[${index}].id`));
  candidate.endings.forEach((entry, index) => record(entry.id, "ending", `endings[${index}].id`));
  candidate.world.facts.forEach((entry, index) => record(entry.id, "fact", `world.facts[${index}].id`));
  record(candidate.openingScene.id, "scene", "openingScene.id");
}

// ---------------------------------------------------------------------------
// 4. 引用完整（任务 objective/outcome 由 questGraph 覆盖）
// ---------------------------------------------------------------------------

function validateReferences(
  issues: ScenarioBlueprintIssue[],
  candidate: ScenarioBlueprintCandidate
): void {
  const locationIds = new Set(candidate.locations.map((entry) => entry.id));
  const npcIds = new Set(candidate.npcs.map((entry) => entry.id));
  const questIds = new Set(candidate.quests.map((entry) => entry.id));
  const itemIds = new Set(candidate.items.map((entry) => entry.id));
  const factIds = new Set(candidate.world.facts.map((entry) => entry.id));

  const check = (path: string, refKind: string, id: string, known: ReadonlySet<string>): void => {
    if (!known.has(id)) {
      issues.push({ path, code: "DANGLING_REFERENCE", params: { refKind, id } });
    }
  };

  candidate.locations.forEach((location, index) => {
    (location.connectedLocationIds ?? []).forEach((id, refIndex) =>
      check(`locations[${index}].connectedLocationIds[${refIndex}]`, "location", id, locationIds)
    );
    (location.npcIds ?? []).forEach((id, refIndex) =>
      check(`locations[${index}].npcIds[${refIndex}]`, "npc", id, npcIds)
    );
  });
  candidate.npcs.forEach((npc, index) => {
    check(`npcs[${index}].locationId`, "location", npc.locationId, locationIds);
    (npc.knownFactIds ?? []).forEach((id, refIndex) =>
      check(`npcs[${index}].knownFactIds[${refIndex}]`, "fact", id, factIds)
    );
  });
  // Phase 6：敌人预置地点必须引用已存在的 location。
  candidate.enemies.forEach((enemy, index) => {
    check(`enemies[${index}].locationId`, "location", enemy.locationId, locationIds);
  });
  candidate.endings.forEach((ending, index) => {
    (ending.requirements ?? []).forEach((requirement, reqIndex) => {
      const path = `endings[${index}].requirements[${reqIndex}]`;
      if (requirement.kind === "quest_completed") {
        // 载荷 id 缺失/非字符串时在此拒绝，不落入悬空引用检查（params 契约只允许 string|number）。
        if (typeof requirement.questId !== "string" || requirement.questId.trim() === "") {
          issues.push({
            path,
            code: "INVALID_ENDING_REQUIREMENT",
            params: { kind: requirement.kind, reason: "missing_quest_id" }
          });
          return;
        }
        check(`${path}.questId`, "quest", requirement.questId, questIds);
      } else if (requirement.kind === "quest_failed") {
        // Phase 6：quest_failed 与 quest_completed 同样引用 quest ID。
        if (typeof requirement.questId !== "string" || requirement.questId.trim() === "") {
          issues.push({
            path,
            code: "INVALID_ENDING_REQUIREMENT",
            params: { kind: requirement.kind, reason: "missing_quest_id" }
          });
          return;
        }
        check(`${path}.questId`, "quest", requirement.questId, questIds);
      } else if (requirement.kind === "fact_discovered") {
        if (typeof requirement.factId !== "string" || requirement.factId.trim() === "") {
          issues.push({
            path,
            code: "INVALID_ENDING_REQUIREMENT",
            params: { kind: requirement.kind, reason: "missing_fact_id" }
          });
          return;
        }
        check(`${path}.factId`, "fact", requirement.factId, factIds);
      } else {
        // 未知 kind：候选来自 JSON，闭合联合之外的值必须显式拒绝，防止带病编译冻结。
        issues.push({
          path,
          code: "INVALID_ENDING_REQUIREMENT",
          params: { kind: String((requirement as { kind?: unknown }).kind ?? "") }
        });
      }
    });
  });
  check("player.startingLocationId", "location", candidate.player.startingLocationId, locationIds);
  (candidate.player.startingItemIds ?? []).forEach((id, refIndex) =>
    check(`player.startingItemIds[${refIndex}]`, "item", id, itemIds)
  );
}

// ---------------------------------------------------------------------------
// 4a. 地点可取得物品（Phase 5）：引用存在、全局至多出现一次、不与初始物品重复
// ---------------------------------------------------------------------------

function validateAvailableItems(
  issues: ScenarioBlueprintIssue[],
  candidate: ScenarioBlueprintCandidate
): void {
  const itemIds = new Set(candidate.items.map((entry) => entry.id));
  const startingItemIds = new Set(candidate.player.startingItemIds ?? []);
  const seen = new Map<string, string>(); // itemId → 首次出现的地点 ID

  candidate.locations.forEach((location, index) => {
    (location.availableItemIds ?? []).forEach((itemId, refIndex) => {
      const path = `locations[${index}].availableItemIds[${refIndex}]`;
      if (!itemIds.has(itemId)) {
        issues.push({ path, code: "DANGLING_REFERENCE", params: { refKind: "item", id: itemId } });
      }
      const firstLocationId = seen.get(itemId);
      if (firstLocationId !== undefined) {
        issues.push({ path, code: "DUPLICATE_AVAILABLE_ITEM", params: { itemId, firstLocationId } });
      } else {
        seen.set(itemId, location.id);
      }
      if (startingItemIds.has(itemId)) {
        issues.push({ path, code: "STARTING_ITEM_AVAILABLE_AT_LOCATION", params: { itemId } });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// 5. 开场场景：地点必须存在且非隐藏；在场 NPC 必须存在且位于该地点
// ---------------------------------------------------------------------------

function validateOpeningScene(
  issues: ScenarioBlueprintIssue[],
  candidate: ScenarioBlueprintCandidate
): void {
  const scene = candidate.openingScene;
  const location = candidate.locations.find((entry) => entry.id === scene.locationId);
  if (location === undefined) {
    issues.push({
      path: "openingScene.locationId",
      code: "DANGLING_REFERENCE",
      params: { refKind: "location", id: scene.locationId }
    });
  } else if (location.kind === "hidden") {
    issues.push({
      path: "openingScene.locationId",
      code: "OPENING_SCENE_HIDDEN_LOCATION",
      params: { locationId: scene.locationId }
    });
  }
  (scene.presentNpcIds ?? []).forEach((npcId, index) => {
    const path = `openingScene.presentNpcIds[${index}]`;
    const npc = candidate.npcs.find((entry) => entry.id === npcId);
    if (npc === undefined) {
      issues.push({ path, code: "DANGLING_REFERENCE", params: { refKind: "npc", id: npcId } });
      return;
    }
    if (npc.locationId !== scene.locationId) {
      issues.push({
        path,
        code: "OPENING_NPC_NOT_AT_LOCATION",
        params: { npcId, npcLocationId: npc.locationId, sceneLocationId: scene.locationId }
      });
    }
  });

  // Phase 3: 开场可调查事实校验
  const factIds = new Set(candidate.world.facts.map((entry) => entry.id));
  const investigableIds = scene.investigableFactIds ?? [];
  if (investigableIds.length === 0) {
    issues.push({
      path: "openingScene.investigableFactIds",
      code: "OPENING_SCENE_NO_INVESTIGABLE_FACTS",
      params: {}
    });
  }
  const seenInvestigable = new Map<string, number>();
  investigableIds.forEach((factId, index) => {
    const path = `openingScene.investigableFactIds[${index}]`;
    if (!factIds.has(factId)) {
      issues.push({ path, code: "DANGLING_REFERENCE", params: { refKind: "fact", id: factId } });
    }
    const firstIndex = seenInvestigable.get(factId);
    if (firstIndex !== undefined) {
      issues.push({
        path,
        code: "DUPLICATE_INVESTIGABLE_FACT",
        params: { factId, firstIndex }
      });
    } else {
      seenInvestigable.set(factId, index);
    }
  });
}

// ---------------------------------------------------------------------------
// 8. 数值范围
// ---------------------------------------------------------------------------

const STAT_FIELDS = ["hp", "attack", "defense"] as const;

function validateNumericRanges(
  issues: ScenarioBlueprintIssue[],
  candidate: ScenarioBlueprintCandidate
): void {
  checkStatBlock(issues, "player.baseStats", candidate.player.baseStats, {
    hp: PHASE1_NUMERIC_RANGES.playerHp,
    attack: PHASE1_NUMERIC_RANGES.playerAttack,
    defense: PHASE1_NUMERIC_RANGES.playerDefense
  });
  candidate.enemies.forEach((enemy, index) => {
    checkStatBlock(issues, `enemies[${index}].stats`, enemy.stats, {
      hp: PHASE1_NUMERIC_RANGES.enemyHp,
      attack: PHASE1_NUMERIC_RANGES.enemyAttack,
      defense: PHASE1_NUMERIC_RANGES.enemyDefense
    });
  });
}

function checkStatBlock(
  issues: ScenarioBlueprintIssue[],
  basePath: string,
  stats: StatBlock | undefined,
  ranges: Record<(typeof STAT_FIELDS)[number], NumericRange>
): void {
  for (const field of STAT_FIELDS) {
    const range = ranges[field];
    const value = stats?.[field];
    // 只允许整数：候选来自 JSON，小数/NaN/缺失一律拒绝。
    if (typeof value !== "number" || !Number.isInteger(value) || value < range.min || value > range.max) {
      issues.push({
        path: `${basePath}.${field}`,
        code: "OUT_OF_RANGE",
        params: {
          min: range.min,
          max: range.max,
          value: typeof value === "number" ? value : String(value)
        }
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 9. profile 禁止标签（大小写敏感的精确匹配）
// ---------------------------------------------------------------------------

function validateForbiddenTags(
  issues: ScenarioBlueprintIssue[],
  candidate: ScenarioBlueprintCandidate,
  profile: GameTypeProfile
): void {
  const forbidden = new Set(profile.forbiddenTags);
  const checkTags = (basePath: string, tags: readonly string[] | undefined): void => {
    (tags ?? []).forEach((tag, index) => {
      if (forbidden.has(tag)) {
        issues.push({ path: `${basePath}[${index}]`, code: "FORBIDDEN_TAG", params: { tag } });
      }
    });
  };

  checkTags("world.tags", candidate.world.tags);
  candidate.locations.forEach((entry, index) => checkTags(`locations[${index}].tags`, entry.tags));
  candidate.npcs.forEach((entry, index) => checkTags(`npcs[${index}].tags`, entry.tags));
  candidate.quests.forEach((entry, index) => checkTags(`quests[${index}].tags`, entry.tags));
  candidate.enemies.forEach((entry, index) => checkTags(`enemies[${index}].tags`, entry.tags));
  candidate.items.forEach((entry, index) => checkTags(`items[${index}].tags`, entry.tags));
}

// ---------------------------------------------------------------------------
// 10. 物品展示元数据（背包界面重构）：可选字段，提供时必须合法
// ---------------------------------------------------------------------------

function validateItemPresentationMetadata(
  issues: ScenarioBlueprintIssue[],
  candidate: ScenarioBlueprintCandidate
): void {
  candidate.items.forEach((item, index) => {
    const path = `items[${index}]`;
    if (item.category !== undefined && !ITEM_CATEGORIES.has(item.category)) {
      issues.push({
        path: `${path}.category`,
        code: "INVALID_ITEM_PRESENTATION",
        params: { reason: "unknown_category", value: String(item.category) }
      });
    }
    if (item.rarity !== undefined && !ITEM_RARITIES.has(item.rarity)) {
      issues.push({
        path: `${path}.rarity`,
        code: "INVALID_ITEM_PRESENTATION",
        params: { reason: "unknown_rarity", value: String(item.rarity) }
      });
    }
    if (
      item.level !== undefined &&
      (!Number.isInteger(item.level) ||
        item.level < ITEM_LEVEL_RANGE.min ||
        item.level > ITEM_LEVEL_RANGE.max)
    ) {
      issues.push({
        path: `${path}.level`,
        code: "INVALID_ITEM_PRESENTATION",
        params: { reason: "level_out_of_range", value: String(item.level) }
      });
    }
    if (item.statLines !== undefined) {
      if (item.statLines.length > ITEM_STAT_LINES_MAX) {
        issues.push({
          path: `${path}.statLines`,
          code: "INVALID_ITEM_PRESENTATION",
          params: {
            reason: "too_many_stat_lines",
            max: ITEM_STAT_LINES_MAX,
            actual: item.statLines.length
          }
        });
      }
      item.statLines.forEach((line, lineIndex) => {
        const label = typeof line.label === "string" ? line.label.trim() : "";
        const value = typeof line.value === "string" ? line.value.trim() : "";
        if (label === "" || value === "") {
          issues.push({
            path: `${path}.statLines[${lineIndex}]`,
            code: "INVALID_ITEM_PRESENTATION",
            params: { reason: "empty_stat_line" }
          });
        }
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Town 层：地点层级
// ---------------------------------------------------------------------------

/** scale 为可选字段：提供时必须合法；town 地点总数 ≤ 配额（懒生成成本约束）。 */
function validateLocationScales(
  issues: ScenarioBlueprintIssue[],
  candidate: ScenarioBlueprintCandidate,
  policy: BudgetPolicy
): void {
  let townCount = 0;
  candidate.locations.forEach((location, index) => {
    if (location.scale === undefined) return;
    if (!LOCATION_SCALES.has(location.scale)) {
      issues.push({
        path: `locations[${index}].scale`,
        code: "INVALID_LOCATION_SCALE",
        params: { value: String(location.scale) }
      });
      return;
    }
    if (location.scale === "town") townCount += 1;
  });
  if (townCount > policy.opening.townLocationsMax) {
    issues.push({
      path: "locations",
      code: "TOWN_LOCATION_OVERBUDGET",
      params: { max: policy.opening.townLocationsMax, actual: townCount }
    });
  }
}

// ---------------------------------------------------------------------------
// 任务图已知实体集合
// ---------------------------------------------------------------------------

function collectKnownEntityIds(candidate: ScenarioBlueprintCandidate): QuestGraphKnownEntityIds {
  return {
    locationIds: candidate.locations.map((entry) => entry.id),
    npcIds: candidate.npcs.map((entry) => entry.id),
    itemIds: candidate.items.map((entry) => entry.id),
    factIds: candidate.world.facts.map((entry) => entry.id),
    enemyIds: candidate.enemies.map((entry) => entry.id)
  };
}
