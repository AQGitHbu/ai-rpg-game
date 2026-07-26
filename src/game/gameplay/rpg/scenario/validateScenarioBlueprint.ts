import {
  CONTENT_BUDGET,
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

export type ScenarioBlueprintIssueCode =
  | QuestGraphIssueCode
  | "INVALID_SCHEMA_VERSION"
  | "REQUIRED"
  | "GAME_TYPE_MISMATCH"
  | "CONTENT_BUDGET_MISMATCH"
  | "MAIN_LOCATION_COUNT_MISMATCH"
  | "HIDDEN_LOCATION_OVERBUDGET"
  | "CORE_NPC_COUNT_OUT_OF_RANGE"
  | "COMPANION_OVERBUDGET"
  | "DUPLICATE_GLOBAL_ID"
  | "DANGLING_REFERENCE"
  | "INVALID_ENDING_REQUIREMENT"
  | "OPENING_SCENE_HIDDEN_LOCATION"
  | "OPENING_NPC_NOT_AT_LOCATION"
  | "FORBIDDEN_TAG"
  | "OUT_OF_RANGE";

export type ScenarioBlueprintIssue = {
  path: string;
  code: ScenarioBlueprintIssueCode;
  params: Record<string, string | number>;
};

/** 校验上下文：profile 由调用方（application 层 / Task 6）注入。 */
export type ScenarioValidationContext = {
  profile: GameTypeProfile;
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

  validateSchemaBasics(issues, candidate, context.profile);
  validateBudgetCounts(issues, candidate);
  validateGlobalIdUniqueness(issues, candidate);
  validateReferences(issues, candidate);
  validateOpeningScene(issues, candidate);
  // 任务 objective/outcome 引用、主线阶段、支线/结局预算与可达性全部委托任务图校验。
  issues.push(
    ...validateQuestGraph({
      quests: candidate.quests,
      endings: candidate.endings,
      knownEntityIds: collectKnownEntityIds(candidate)
    })
  );
  validateNumericRanges(issues, candidate);
  validateForbiddenTags(issues, candidate, context.profile);

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, validated: candidate as ValidatedScenarioBlueprintCandidate };
}

// ---------------------------------------------------------------------------
// 1. schema 基础
// ---------------------------------------------------------------------------

const REQUIRED_TEXT_FIELDS = ["generationId", "seed", "templateVersion", "inputDigest"] as const;

function validateSchemaBasics(
  issues: ScenarioBlueprintIssue[],
  candidate: ScenarioBlueprintCandidate,
  profile: GameTypeProfile
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
  // 候选自带的 contentBudget 必须逐字段等于 Phase 1 常量（候选来自 JSON，运行时防御）。
  const declaredBudget = (candidate.contentBudget ?? {}) as Record<string, unknown>;
  for (const [key, expected] of Object.entries(CONTENT_BUDGET)) {
    if (declaredBudget[key] !== expected) {
      issues.push({
        path: `contentBudget.${key}`,
        code: "CONTENT_BUDGET_MISMATCH",
        params: { expected, actual: String(declaredBudget[key]) }
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 2. 内容预算数量（主线阶段数、支线数、结局数由 questGraph 检查）
// ---------------------------------------------------------------------------

function validateBudgetCounts(
  issues: ScenarioBlueprintIssue[],
  candidate: ScenarioBlueprintCandidate
): void {
  const mainCount = candidate.locations.filter((entry) => entry.kind === "main").length;
  if (mainCount !== CONTENT_BUDGET.mainLocations) {
    issues.push({
      path: "locations",
      code: "MAIN_LOCATION_COUNT_MISMATCH",
      params: { expected: CONTENT_BUDGET.mainLocations, actual: mainCount }
    });
  }
  const hiddenCount = candidate.locations.filter((entry) => entry.kind === "hidden").length;
  if (hiddenCount > CONTENT_BUDGET.hiddenLocationsMax) {
    issues.push({
      path: "locations",
      code: "HIDDEN_LOCATION_OVERBUDGET",
      params: { max: CONTENT_BUDGET.hiddenLocationsMax, actual: hiddenCount }
    });
  }
  const npcCount = candidate.npcs.length;
  if (npcCount < CONTENT_BUDGET.coreNpcsMin || npcCount > CONTENT_BUDGET.coreNpcsMax) {
    issues.push({
      path: "npcs",
      code: "CORE_NPC_COUNT_OUT_OF_RANGE",
      params: { min: CONTENT_BUDGET.coreNpcsMin, max: CONTENT_BUDGET.coreNpcsMax, actual: npcCount }
    });
  }
  const companionCount = candidate.npcs.filter((entry) => entry.isCompanion === true).length;
  if (companionCount > CONTENT_BUDGET.companionsMax) {
    issues.push({
      path: "npcs",
      code: "COMPANION_OVERBUDGET",
      params: { max: CONTENT_BUDGET.companionsMax, actual: companionCount }
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
