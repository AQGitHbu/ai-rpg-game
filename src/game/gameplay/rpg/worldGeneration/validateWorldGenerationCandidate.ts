import type {
  WorldGenerationCandidate,
} from "@/game/domain/worldGenerationCandidate";
import type { QuestDefinitionCandidate } from "@/game/domain/scenarioBlueprint";
import type { GameLength } from "@/game/domain/newGame";
import { TARGET_ACTS } from "@/game/domain/storyBudget";
import { analyzeLocationReachability } from "./reachability";

// ---------------------------------------------------------------------------
// Task 13：开局世界 validator——校验引用完整性、地点连通、任务图、结局可达性
// 与预算计数。纯函数、零 AI 修复、同一候选结果确定。
//
// 错误格式遵循 ScenarioBlueprint 范式：{ path, code, params }，params 只含
// string|number 最小定位 ID，绝不携带完整秘密正文。
// ---------------------------------------------------------------------------

export type WorldGenerationIssueCode =
  | "duplicate_id"
  | "missing_reference"
  | "starting_location_missing"
  | "unreachable_location"
  | "locked_location_without_unlock_path"
  | "main_act_gap"
  | "first_act_not_actionable"
  | "quest_predecessor_missing"
  | "quest_cycle"
  | "objective_unreachable"
  | "ending_requirement_empty"
  | "ending_unreachable"
  | "insufficient_distinct_endings"
  | "overlapping_ending_predicates"
  | "non_exhaustive_ending_predicates"
  | "npc_fact_reference_invalid"
  | "budget_exceeded"
  | "hard_limit_exceeded"
  | "invalid_starting_inventory"
  | "invalid_starting_location"
  | "invalid_starting_npc";

export type WorldGenerationIssue = {
  readonly path: string;
  readonly code: WorldGenerationIssueCode;
  readonly params: Record<string, string | number>;
};

export type ValidateWorldGenerationResult =
  | { readonly ok: true; readonly validated: WorldGenerationCandidate }
  | { readonly ok: false; readonly issues: readonly WorldGenerationIssue[] };

export type WorldGenerationValidationContext = {
  readonly gameLength: GameLength;
  readonly targetActs: number;
};

export function validateWorldGenerationCandidate(
  candidate: WorldGenerationCandidate,
  context: WorldGenerationValidationContext,
): ValidateWorldGenerationResult {
  const issues: WorldGenerationIssue[] = [];

  const locationIds = candidate.locations.map((l) => l.id);
  const locationIdSet = new Set(locationIds);
  const npcIds = candidate.npcs.map((n) => n.id);
  const npcIdSet = new Set(npcIds);
  const itemIds = candidate.items.map((i) => i.id);
  const itemIdSet = new Set(itemIds);
  const enemyIds = candidate.enemies.map((e) => e.id);
  const enemyIdSet = new Set(enemyIds);
  const questIds = candidate.quests.map((q) => q.id);
  const questIdSet = new Set(questIds);
  const publicFactIds = new Set(candidate.world.publicFacts.map((f) => f.id));
  const hiddenFactIds = new Set(candidate.world.hiddenFacts.map((f) => f.id));
  const allFactIds = new Set([...publicFactIds, ...hiddenFactIds]);

  // duplicate_id：全局 ID 唯一性（跨实体）。
  collectDuplicates(issues, candidate);

  // starting_location_missing / invalid_starting_location。
  if (!locationIdSet.has(candidate.startAnchor.locationId)) {
    issues.push({ path: "startAnchor.locationId", code: "starting_location_missing", params: { id: candidate.startAnchor.locationId } });
  }
  if (!locationIdSet.has(candidate.player.startingLocationId)) {
    issues.push({ path: "player.startingLocationId", code: "invalid_starting_location", params: { id: candidate.player.startingLocationId } });
  }

  // invalid_starting_npc：起始锚点 NPC 必须存在。
  if (!npcIdSet.has(candidate.startAnchor.npcId)) {
    issues.push({ path: "startAnchor.npcId", code: "invalid_starting_npc", params: { id: candidate.startAnchor.npcId } });
  }

  // invalid_starting_inventory：起始物品必须存在。
  for (const itemId of candidate.player.startingItemIds) {
    if (!itemIdSet.has(itemId)) {
      issues.push({ path: "player.startingItemIds", code: "invalid_starting_inventory", params: { id: itemId } });
    }
  }

  // missing_reference：locations / npcs 的实体引用。
  candidate.locations.forEach((loc, index) => {
    for (const conn of loc.connectedLocationIds) {
      if (!locationIdSet.has(conn)) issues.push({ path: `locations[${index}].connectedLocationIds`, code: "missing_reference", params: { id: conn } });
    }
    for (const npc of loc.npcIds) {
      if (!npcIdSet.has(npc)) issues.push({ path: `locations[${index}].npcIds`, code: "missing_reference", params: { id: npc } });
    }
    for (const item of loc.availableItemIds) {
      if (!itemIdSet.has(item)) issues.push({ path: `locations[${index}].availableItemIds`, code: "missing_reference", params: { id: item } });
    }
  });
  candidate.npcs.forEach((npc, index) => {
    if (!locationIdSet.has(npc.locationId)) {
      issues.push({ path: `npcs[${index}].locationId`, code: "missing_reference", params: { id: npc.locationId } });
    }
  });
  for (const enemy of candidate.enemies) {
    if (!locationIdSet.has(enemy.locationId)) {
      issues.push({ path: `enemies`, code: "missing_reference", params: { id: enemy.locationId } });
    }
  }

  // npc_fact_reference_invalid：NPC 的 known/hidden fact 必须存在于公开/隐藏事实。
  candidate.npcs.forEach((npc, index) => {
    for (const factId of npc.knownFactIds) {
      if (!allFactIds.has(factId)) issues.push({ path: `npcs[${index}].knownFactIds`, code: "npc_fact_reference_invalid", params: { id: factId } });
    }
    for (const factId of npc.hiddenFactIds) {
      if (!allFactIds.has(factId)) issues.push({ path: `npcs[${index}].hiddenFactIds`, code: "npc_fact_reference_invalid", params: { id: factId } });
    }
  });

  // 地点连通：不可达的 main 地点。
  const reachability = analyzeLocationReachability({ locations: candidate.locations, startingLocationId: candidate.startAnchor.locationId });
  for (const locId of reachability.unreachableLocationIds) {
    issues.push({ path: "locations", code: "unreachable_location", params: { id: locId } });
  }
  // hidden 地点若无任何 main 地点可经其解锁路径，报 locked_location_without_unlock_path。
  for (const loc of candidate.locations) {
    if (loc.kind === "hidden" && !reachability.reachableLocationIds.includes(loc.id)) {
      issues.push({ path: `locations`, code: "locked_location_without_unlock_path", params: { id: loc.id } });
    }
  }

  // 任务图：初始可接 + 解锁链；检测缺失 predecessor 与环。
  // 不复用 questGraph（其 BFS 只从单一切入点认 reach_ending），这里按
  // WorldGenerationCandidate 语义：stage 1 main quests 与独立 side quests 初始可接，
  // unlock_quests 解锁后续任务。
  const questAnalysis = analyzeQuestDependencies(candidate.quests);
  for (const q of questAnalysis.missingPredecessorIds) {
    issues.push({ path: "quests", code: "quest_predecessor_missing", params: { id: q } });
  }
  for (const cycle of questAnalysis.cycleIds) {
    issues.push({ path: "quests", code: "quest_cycle", params: { id: cycle } });
  }

  // 结局可达性：requirements 引用的 quest/fact 必须存在（missing_reference 已覆盖），
  // 且该任务必须可达（初始可接或经解锁链可达）。
  const reachableQuestIds = questAnalysis.reachableQuestIds;
  const satisfiableEndingIds = new Set<string>();
  candidate.endings.forEach((ending, index) => {
    for (const req of ending.requirements) {
      if (req.kind === "quest_completed" || req.kind === "quest_failed") {
        if (questIdSet.has(req.questId) && !reachableQuestIds.has(req.questId)) {
          issues.push({ path: `endings[${index}].requirements`, code: "ending_unreachable", params: { id: ending.id } });
        } else if (questIdSet.has(req.questId)) {
          satisfiableEndingIds.add(ending.id);
        }
      } else if (req.kind === "fact_discovered") {
        satisfiableEndingIds.add(ending.id);
      } else if (npcIdSet.has(req.npcId) && Number.isFinite(req.value) && req.value >= -100 && req.value <= 100) {
        satisfiableEndingIds.add(ending.id);
      }
    }
  });
  for (const ending of candidate.endings) {
    if (!satisfiableEndingIds.has(ending.id) && ending.requirements.length > 0) {
      // 若 requirement 引用全部不满足（任务不可达），已在上方报 ending_unreachable。
      // 这里只对"无任何可满足 requirement"的结局兜底。
      const hasUnreachableReq = ending.requirements.some((req) =>
        (req.kind === "quest_completed" || req.kind === "quest_failed")
        && questIdSet.has(req.questId) && !reachableQuestIds.has(req.questId));
      if (!hasUnreachableReq && !issues.some((i) => i.code === "ending_unreachable" && i.params.id === ending.id)) {
        issues.push({ path: `endings`, code: "ending_unreachable", params: { id: ending.id } });
      }
    }
  }

  // ending_requirement_empty：requirements 必须非空且引用存在。
  candidate.endings.forEach((ending, index) => {
    if (ending.requirements.length === 0) {
      issues.push({ path: `endings[${index}].requirements`, code: "ending_requirement_empty", params: { id: ending.id } });
    }
    for (const req of ending.requirements) {
      if (req.kind === "quest_completed" || req.kind === "quest_failed") {
        if (!questIdSet.has(req.questId)) issues.push({ path: `endings[${index}].requirements`, code: "missing_reference", params: { id: req.questId } });
      } else if (req.kind === "fact_discovered") {
        if (!allFactIds.has(req.factId)) issues.push({ path: `endings[${index}].requirements`, code: "missing_reference", params: { id: req.factId } });
      } else {
        if (!npcIdSet.has(req.npcId)) issues.push({ path: `endings[${index}].requirements`, code: "missing_reference", params: { id: req.npcId } });
        if (!Number.isFinite(req.value) || req.value < -100 || req.value > 100) {
          issues.push({ path: `endings[${index}].requirements`, code: "ending_unreachable", params: { id: ending.id } });
        }
      }
    }
  });

  // 任务 objective 引用完整性与可达性。
  candidate.quests.forEach((quest, qIndex) => {
    quest.objectives.forEach((objective, oIndex) => {
      const targetId = objectiveTargetId(objective);
      if (targetId === undefined) return;
      let exists = false;
      if (objective.kind === "visit_location") exists = locationIdSet.has(targetId);
      else if (objective.kind === "talk_to_npc") exists = npcIdSet.has(targetId);
      else if (objective.kind === "obtain_item") exists = itemIdSet.has(targetId);
      else if (objective.kind === "discover_fact") exists = allFactIds.has(targetId);
      else if (objective.kind === "defeat_enemy") exists = enemyIdSet.has(targetId);
      if (!exists) issues.push({ path: `quests[${qIndex}].objectives[${oIndex}]`, code: "missing_reference", params: { id: targetId } });
      // objective_unreachable：objective 目标实体存在但不可达（visit_location  目标地点
      // 不在可达集合内）。
      if (objective.kind === "visit_location" && locationIdSet.has(targetId) && !reachability.reachableLocationIds.includes(targetId)) {
        issues.push({ path: `quests[${qIndex}].objectives[${oIndex}]`, code: "objective_unreachable", params: { id: targetId } });
      }
      // obtain_item 目标物品必须已布点（某地点 availableItemIds 或起始背包），
      // 否则玩家永远无法取得，任务链卡死。
      if (objective.kind === "obtain_item" && itemIdSet.has(targetId)) {
        const placed = candidate.locations.some((location) => location.availableItemIds.includes(targetId))
          || candidate.player.startingItemIds.includes(targetId);
        if (!placed) {
          issues.push({ path: `quests[${qIndex}].objectives[${oIndex}]`, code: "objective_unreachable", params: { id: targetId } });
        }
      }
      // defeat_enemy / talk_to_npc 目标实体所在地点必须可达。
      if (objective.kind === "defeat_enemy" && enemyIdSet.has(targetId)) {
        const enemy = candidate.enemies.find((entry) => entry.id === targetId);
        if (enemy !== undefined && !reachability.reachableLocationIds.includes(enemy.locationId)) {
          issues.push({ path: `quests[${qIndex}].objectives[${oIndex}]`, code: "objective_unreachable", params: { id: targetId } });
        }
      }
      if (objective.kind === "talk_to_npc" && npcIdSet.has(targetId)) {
        const npc = candidate.npcs.find((entry) => entry.id === targetId);
        if (npc !== undefined && !reachability.reachableLocationIds.includes(npc.locationId)) {
          issues.push({ path: `quests[${qIndex}].objectives[${oIndex}]`, code: "objective_unreachable", params: { id: targetId } });
        }
      }
    });
  });
  
  // 可玩性底线：至少一件物品可被玩家获得（地点布点或起始背包），
  // 否则物品"获得"玩法在整局中不可触达。
  const anyObtainableItem = candidate.items.some((item) =>
    candidate.locations.some((location) => location.availableItemIds.includes(item.id))
    || candidate.player.startingItemIds.includes(item.id));
  if (candidate.items.length > 0 && !anyObtainableItem) {
    issues.push({ path: "items", code: "objective_unreachable", params: { id: "any" } });
  }

  // 任务骨架：main_act_gap / first_act_not_actionable。主线必须是一条
  // 从第 1 幕到 targetActs 的可达链；缺幕、重复幕、超出目标幕或
  // 声称的 gameLength/targetActs 不一致都不能进入正式状态。
  const mainQuests = candidate.quests.filter((q): q is Extract<QuestDefinitionCandidate, { kind: "main" }> => q.kind === "main");
  const expectedTargetActs = TARGET_ACTS[context.gameLength];
  const validTargetActs = Number.isSafeInteger(context.targetActs) && context.targetActs > 0;
  if (!validTargetActs || context.targetActs !== expectedTargetActs) {
    issues.push({
      path: "quests",
      code: "main_act_gap",
      params: { stage: expectedTargetActs },
    });
  }

  const targetActs = validTargetActs ? context.targetActs : expectedTargetActs;
  const reachableMainQuests = mainQuests.filter((quest) => reachableQuestIds.has(quest.id));
  const reachableByStage = new Map<number, number>();
  for (const quest of reachableMainQuests) {
    reachableByStage.set(quest.stage, (reachableByStage.get(quest.stage) ?? 0) + 1);
  }

  const firstActQuests = reachableMainQuests.filter((quest) => quest.stage === 1);
  if (firstActQuests.length !== 1 || firstActQuests[0]!.objectives.length === 0) {
    issues.push({ path: "quests", code: "first_act_not_actionable", params: { stage: 1 } });
  }
  for (let stage = 1; stage <= targetActs; stage++) {
    if ((reachableByStage.get(stage) ?? 0) !== 1) {
      issues.push({ path: "quests", code: "main_act_gap", params: { stage } });
    }
  }
  for (const quest of mainQuests) {
    if (!reachableQuestIds.has(quest.id) || quest.stage < 1 || quest.stage > targetActs) {
      issues.push({ path: "quests", code: "main_act_gap", params: { stage: quest.stage, id: quest.id } });
    }
  }

  // 可达并不等于按幕推进：例如 1 -> 3 -> 2 的图也会被 BFS 标为全部可达，
  // 但运行时会提前暴露终幕。正式候选只接受 onSuccess 从第 N 幕继续解锁
  // 第 N+1 幕，并拒绝任何跨幕、倒序的 main -> main 解锁边。支线也不得
  // 解锁主线，否则一个初始可接的 side quest 就能绕过幕级门槛。
  const mainQuestById = new Map(mainQuests.map((quest) => [quest.id, quest]));
  const mainQuestByStage = new Map<number, Extract<QuestDefinitionCandidate, { kind: "main" }>>();
  for (const quest of mainQuests) {
    if (!mainQuestByStage.has(quest.stage)) mainQuestByStage.set(quest.stage, quest);
  }
  for (let stage = 1; stage < targetActs; stage++) {
    const current = mainQuestByStage.get(stage);
    const next = mainQuestByStage.get(stage + 1);
    if (!current || !next) continue;
    if (current.onSuccess?.kind !== "unlock_quests" || !current.onSuccess.questIds.includes(next.id)) {
      issues.push({ path: "quests", code: "main_act_gap", params: { stage: stage + 1, id: next.id } });
    }
  }
  for (const quest of candidate.quests) {
    for (const outcome of [quest.onSuccess, quest.onFailure]) {
      if (outcome?.kind !== "unlock_quests") continue;
      for (const unlockedId of outcome.questIds) {
        const unlockedMainQuest = mainQuestById.get(unlockedId);
        if (unlockedMainQuest && (quest.kind !== "main" || unlockedMainQuest.stage !== quest.stage + 1)) {
          issues.push({
            path: "quests",
            code: "main_act_gap",
            params: { stage: unlockedMainQuest.stage, id: unlockedMainQuest.id },
          });
        }
      }
    }
  }

  // insufficient_distinct_endings：至少两条可满足、语义不同的结局路线。
  // 语义不同指 requirements 引用的目标（quest/fact）不完全相同。
  const endingFingerprints = new Set<string>();
  for (const ending of candidate.endings) {
    if (satisfiableEndingIds.has(ending.id)) {
      const fp = ending.requirements
        .map((r) => {
          if (r.kind === "fact_discovered") return `f:${r.factId}`;
          if (r.kind === "npc_affinity_at_least" || r.kind === "npc_affinity_at_most") {
            return `n:${r.kind}:${r.npcId}:${r.value}`;
          }
          return `q:${r.kind}:${r.questId}`;
        })
        .sort()
        .join("|");
      endingFingerprints.add(fp);
    }
  }
  if (endingFingerprints.size < 2) {
    issues.push({ path: "endings", code: "insufficient_distinct_endings", params: { count: endingFingerprints.size } });
  }

  // Live 候选的结局必须是一个可证明完整的二分：两条结局共享终幕任务
  // 完成条件，并且只用同一 NPC 的相邻 <= / >= 阈值作为唯一判别器。
  // quest-only 分支、不同 NPC、额外合取条件或单分支都无法证明对所有
  // 玩家状态既互斥又穷尽，因此统一拒绝并由上层走确定性 fallback。
  const finalMainQuest = mainQuestByStage.get(targetActs);
  if (!finalMainQuest || !hasCanonicalEndingPartition(candidate.endings, finalMainQuest.id)) {
    issues.push({ path: "endings", code: "non_exhaustive_ending_predicates", params: { count: candidate.endings.length } });
  }

  // Relationship-based endings must form disjoint intervals for each NPC.
  // Otherwise one affinity value can satisfy multiple endings and resolution
  // would depend on the source array order rather than player state.
  const relationshipIntervals = candidate.endings.map((ending) => {
    const byNpc = new Map<string, { minimum: number; maximum: number }>();
    for (const requirement of ending.requirements) {
      if (requirement.kind !== "npc_affinity_at_least" && requirement.kind !== "npc_affinity_at_most") continue;
      const interval = byNpc.get(requirement.npcId) ?? { minimum: -100, maximum: 100 };
      if (requirement.kind === "npc_affinity_at_least") {
        interval.minimum = Math.max(interval.minimum, requirement.value);
      } else {
        interval.maximum = Math.min(interval.maximum, requirement.value);
      }
      byNpc.set(requirement.npcId, interval);
    }
    return { ending, byNpc };
  });
  for (let leftIndex = 0; leftIndex < relationshipIntervals.length; leftIndex++) {
    const left = relationshipIntervals[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < relationshipIntervals.length; rightIndex++) {
      const right = relationshipIntervals[rightIndex]!;
      for (const [npcId, leftInterval] of left.byNpc) {
        const rightInterval = right.byNpc.get(npcId);
        if (!rightInterval) continue;
        const overlapMinimum = Math.max(leftInterval.minimum, rightInterval.minimum);
        const overlapMaximum = Math.min(leftInterval.maximum, rightInterval.maximum);
        if (overlapMinimum <= overlapMaximum) {
          issues.push({
            path: `endings[${rightIndex}].requirements`,
            code: "overlapping_ending_predicates",
            params: { leftEndingId: left.ending.id, rightEndingId: right.ending.id, npcId },
          });
        }
      }
    }
  }

  // 互斥还不足以保证可完成：同一 NPC 的关系分支还必须覆盖
  // 所有可能的 affinity（规则状态域为 -100..100 的整数）。例如
  // <=5 与 >=10 虽然不重叠，但 6..9 会让已完成主线的玩家无结局。
  const intervalsByNpc = new Map<string, Array<{ minimum: number; maximum: number; endingId: string }>>();
  for (const { ending, byNpc } of relationshipIntervals) {
    for (const [npcId, interval] of byNpc) {
      const intervals = intervalsByNpc.get(npcId) ?? [];
      intervals.push({ ...interval, endingId: ending.id });
      intervalsByNpc.set(npcId, intervals);
    }
  }
  for (const [npcId, intervals] of intervalsByNpc) {
    if (intervals.length < 2) continue;
    const normalized = intervals
      .map((interval) => ({
        ...interval,
        minimum: Math.max(-100, Math.ceil(interval.minimum)),
        maximum: Math.min(100, Math.floor(interval.maximum)),
      }))
      .sort((left, right) => left.minimum - right.minimum || left.maximum - right.maximum);
    let coveredThrough = -101;
    let hasGap = false;
    for (const interval of normalized) {
      if (interval.minimum > coveredThrough + 1) hasGap = true;
      coveredThrough = Math.max(coveredThrough, interval.maximum);
    }
    if (coveredThrough < 100) hasGap = true;
    if (hasGap) {
      issues.push({
        path: "endings",
        code: "non_exhaustive_ending_predicates",
        params: { npcId },
      });
    }
  }

  // budget_exceeded / hard_limit_exceeded：openingBudget 与实体计数核对。
  const sideQuests = candidate.quests.filter((q) => q.kind === "side");
  const budget = candidate.openingBudget;
  if (candidate.locations.length > budget.locationsCount) {
    issues.push({ path: "openingBudget.locationsCount", code: "budget_exceeded", params: { id: "locations" } });
  }
  if (candidate.npcs.length > budget.npcsCount) {
    issues.push({ path: "openingBudget.npcsCount", code: "budget_exceeded", params: { id: "npcs" } });
  }
  if (sideQuests.length > budget.sideQuestsCount) {
    issues.push({ path: "openingBudget.sideQuestsCount", code: "budget_exceeded", params: { id: "sideQuests" } });
  }
  if (candidate.endings.length > budget.endingsCount) {
    issues.push({ path: "openingBudget.endingsCount", code: "budget_exceeded", params: { id: "endings" } });
  }
  // hard limit：预算计数超过安全上限。
  if (candidate.locations.length > 40) {
    issues.push({ path: "openingBudget.locationsCount", code: "hard_limit_exceeded", params: { id: "locations" } });
  }
  if (candidate.npcs.length > 30) {
    issues.push({ path: "openingBudget.npcsCount", code: "hard_limit_exceeded", params: { id: "npcs" } });
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, validated: candidate };
}

// 任务依赖分析：stage 1 main quests 与无前驱 side quests 初始可接；
// unlock_quests 解锁后续；缺失 predecessor 与环单独报告。
function analyzeQuestDependencies(quests: readonly QuestDefinitionCandidate[]): {
  readonly reachableQuestIds: ReadonlySet<string>;
  readonly missingPredecessorIds: readonly string[];
  readonly cycleIds: readonly string[];
} {
  const byId = new Map(quests.map((q) => [q.id, q]));
  const missingPredecessorIds: string[] = [];
  // 每个任务被谁解锁。
  const unlockedBy = new Map<string, string[]>();

  for (const quest of quests) {
    for (const field of ["onSuccess", "onFailure"] as const) {
      const outcome = quest[field];
      if (outcome?.kind === "unlock_quests") {
        for (const targetId of outcome.questIds ?? []) {
          if (!byId.has(targetId)) {
            if (!missingPredecessorIds.includes(targetId)) missingPredecessorIds.push(targetId);
          } else {
            const list = unlockedBy.get(targetId) ?? [];
            list.push(quest.id);
            unlockedBy.set(targetId, list);
          }
        }
      }
    }
  }

  // 初始可接：stage 1 main quests + 无任何解锁来源的 side quests。
  const initial = new Set<string>();
  for (const quest of quests) {
    const isUnlocked = (unlockedBy.get(quest.id)?.length ?? 0) > 0;
    if (!isUnlocked) {
      if (quest.kind === "main") {
        if (quest.stage === 1) initial.add(quest.id);
      } else {
        initial.add(quest.id);
      }
    }
  }

  // BFS 从初始任务沿 unlock_quests 传播可达。
  const reachable = new Set<string>(initial);
  const queue = [...initial];
  while (queue.length > 0) {
    const questId = queue.shift() as string;
    const quest = byId.get(questId);
    if (!quest) continue;
    for (const field of ["onSuccess", "onFailure"] as const) {
      const outcome = quest[field];
      if (outcome?.kind === "unlock_quests") {
        for (const targetId of outcome.questIds ?? []) {
          if (byId.has(targetId) && !reachable.has(targetId)) {
            reachable.add(targetId);
            queue.push(targetId);
          }
        }
      }
    }
  }

  // 环检测：DFS 三色标记。
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const q of quests) color.set(q.id, WHITE);
  const cycleIds: string[] = [];
  const dfs = (id: string, stack: string[]) => {
    color.set(id, GRAY);
    stack.push(id);
    const quest = byId.get(id);
    if (quest) {
      for (const field of ["onSuccess", "onFailure"] as const) {
        const outcome = quest[field];
        if (outcome?.kind === "unlock_quests") {
          for (const targetId of outcome.questIds ?? []) {
            const c = color.get(targetId);
            if (c === WHITE) dfs(targetId, stack);
            else if (c === GRAY) {
              const cycleStart = stack.indexOf(targetId);
              const cycle = stack.slice(cycleStart);
              if (cycle.length >= 2) cycleIds.push(cycle[0] ?? targetId);
            }
          }
        }
      }
    }
    stack.pop();
    color.set(id, BLACK);
  };
  for (const q of quests) {
    if (color.get(q.id) === WHITE) dfs(q.id, []);
  }

  return { reachableQuestIds: reachable, missingPredecessorIds, cycleIds };
}

function objectiveTargetId(objective: { kind: string }): string | undefined {
  const o = objective as { locationId?: string; npcId?: string; itemId?: string; factId?: string; enemyId?: string };
  return o.locationId ?? o.npcId ?? o.itemId ?? o.factId ?? o.enemyId;
}

function hasCanonicalEndingPartition(
  endings: WorldGenerationCandidate["endings"],
  finalQuestId: string,
): boolean {
  if (endings.length !== 2) return false;

  const discriminators: Array<{
    readonly kind: "npc_affinity_at_least" | "npc_affinity_at_most";
    readonly npcId: string;
    readonly value: number;
  }> = [];

  for (const ending of endings) {
    if (ending.requirements.length !== 2) return false;
    const questRequirements = ending.requirements.filter((requirement) => requirement.kind === "quest_completed");
    const affinityRequirements = ending.requirements.filter(
      (requirement) => requirement.kind === "npc_affinity_at_least" || requirement.kind === "npc_affinity_at_most",
    );
    if (questRequirements.length !== 1 || questRequirements[0]!.questId !== finalQuestId) return false;
    if (affinityRequirements.length !== 1) return false;
    discriminators.push(affinityRequirements[0]!);
  }

  const atMost = discriminators.find((requirement) => requirement.kind === "npc_affinity_at_most");
  const atLeast = discriminators.find((requirement) => requirement.kind === "npc_affinity_at_least");
  return atMost !== undefined
    && atLeast !== undefined
    && atMost.npcId === atLeast.npcId
    && Number.isInteger(atMost.value)
    && Number.isInteger(atLeast.value)
    && atMost.value + 1 === atLeast.value;
}

function collectDuplicates(issues: WorldGenerationIssue[], candidate: WorldGenerationCandidate): void {
  const seen = new Map<string, string>();
  const entities: Array<[string, readonly { id: string }[]]> = [
    ["locations", candidate.locations],
    ["npcs", candidate.npcs],
    ["items", candidate.items],
    ["enemies", candidate.enemies],
    ["quests", candidate.quests],
    ["endings", candidate.endings],
  ];
  for (const [kind, list] of entities) {
    for (const entity of list) {
      if (seen.has(entity.id)) {
        issues.push({ path: kind, code: "duplicate_id", params: { id: entity.id } });
      } else {
        seen.set(entity.id, kind);
      }
    }
  }
  // facts 全局唯一。
  for (const f of [...candidate.world.publicFacts, ...candidate.world.hiddenFacts]) {
    if (seen.has(f.id)) {
      issues.push({ path: "world", code: "duplicate_id", params: { id: f.id } });
    } else {
      seen.set(f.id, "fact");
    }
  }
}
