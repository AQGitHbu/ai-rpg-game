import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { NarrativeEventDraft } from "@/game/domain/events";
import type { QuestObjective } from "@/game/domain/worldEntries";
import {
  asEnemyId,
  asFactId,
  asItemId,
  asLocationId,
  asNpcId,
  type LocationId,
  type NpcId,
  PLAYER_ENTITY_ID,
} from "@/game/domain/worldEntity";
import { isTravelTarget } from "@/game/domain/worldState";
import { currentObjectiveOf, isObjectiveSatisfied } from "@/game/gameplay/rpg/narrativeContext";
import {
  DEFERRED_LOCATION_ID_SYMBOL,
  type BranchOption,
  type Decision,
  type RouteTarget,
} from "@/game/domain/narrativeBranch";
import type { Check } from "@/game/domain/narrativeUnit";
import { applyEntityMutations, EntityMutationInvariantError, type EntityMutation } from "@/game/gameplay/rpg/entityWorld";
import {
  materializeDeferredLocation,
  validateDeferredLocationDefinition,
  type DeferredLocationDefinition,
} from "@/game/gameplay/rpg/worldEvolution";

// ---------------------------------------------------------------------------
// 有界路线分支。
//
// 能力是「选择一个已批准的后续目标」，不是任意效果 DSL：
//   - 分支不能替玩家完成移动 / 取物 / 给予 / 击败；
//   - 只有关系变化而没有可用目标差异的提案被拒绝；
//   - 选择只替换当前主线的下一个未执行目标，保留既有已完成前缀与共同后缀。
// 分支从不绕过 reconcileQuests，也不额外 commit；变化在回合的单次 CAS 中提交。
// ---------------------------------------------------------------------------

export type BranchRejectionCode =
  | "duplicate_candidate_id"
  | "decision_npc_missing"
  | "decision_npc_absent"
  | "duplicate_target"
  | "unknown_target_entity"
  | "target_unreachable"
  | "target_already_satisfied"
  | "no_active_quest"
  | "no_pending_objective"
  | "deferred_requires_visit_location"
  | "deferred_symbol_required"
  | "deferred_definition_invalid"
  | "branch_already_selected"
  | "unknown_candidate"
  | "branch_stale"
  | "objective_replacement_rejected";

/** 延迟路线模板：出发抵达所选新地点 → 返回与原 NPC 的新会话。 */
export const DEFERRED_ROUTE_LENGTH = 2 as const;

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function fnv1a(data: string): number {
  let hash = FNV_OFFSET_BASIS >>> 0;
  for (let i = 0; i < data.length; i += 1) {
    hash ^= data.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

/**
 * decisionId 由 Decision 内容确定性派生：同一份已审批 decision 在任何时刻
 * 得到同一个 key，客户端无法提交或猜测它。
 */
export function decisionIdOf(decision: Decision): string {
  const material = [
    decision.kind,
    decision.point.stepKey,
    String(decision.point.order),
    decision.npcId,
    ...decision.options.map((option) => [
      option.candidateId,
      option.dialogueAct,
      option.target === null ? "dialogue" : routeTargetKey(option.target),
      option.deferredLocation === null ? "null" : option.deferredLocation.name,
    ].join(":")),
  ].join("|");
  const a = fnv1a(material).toString(16).padStart(8, "0");
  const b = fnv1a(`${material}|salt:2`).toString(16).padStart(8, "0");
  return `dec_${a}${b}`;
}

function routeTargetKey(target: RouteTarget): string {
  switch (target.kind) {
    case "talk_to_npc": return `talk_to_npc:${target.npcId}`;
    case "visit_location": return `visit_location:${target.locationId}`;
    case "obtain_item": return `obtain_item:${target.itemId}`;
    case "discover_fact": return `discover_fact:${target.factId}`;
    case "defeat_enemy": return `defeat_enemy:${target.enemyId}`;
  }
}

function sameTarget(left: RouteTarget, right: RouteTarget): boolean {
  return routeTargetKey(left) === routeTargetKey(right);
}

/** RouteTarget → QuestObjective：只允许五类封闭目标，不提供任意效果。 */
export function objectiveOfTarget(target: RouteTarget): QuestObjective {
  switch (target.kind) {
    case "talk_to_npc": return { kind: "talk_to_npc", npcId: asNpcId(target.npcId) };
    case "visit_location": return { kind: "visit_location", locationId: asLocationId(target.locationId) };
    case "obtain_item": return { kind: "obtain_item", itemId: asItemId(target.itemId) };
    case "discover_fact": return { kind: "discover_fact", factId: asFactId(target.factId) };
    case "defeat_enemy": return { kind: "defeat_enemy", enemyId: asEnemyId(target.enemyId) };
  }
}

function fail(code: BranchRejectionCode): { readonly ok: false; readonly code: BranchRejectionCode } {
  return { ok: false, code };
}

/** 目标引用的实体必须已经存在；延迟地点在材质化前不存在，由 deferred 分支单独处理。 */
function targetEntityExists(world: WorldState, target: RouteTarget): boolean {
  switch (target.kind) {
    case "talk_to_npc": return world.npcs.some((npc) => String(npc.id) === String(target.npcId));
    case "visit_location": return world.locations.some((loc) => String(loc.id) === String(target.locationId));
    case "obtain_item": return world.items.some((item) => String(item.id) === String(target.itemId));
    case "discover_fact": return world.worldFacts.some((fact) => String(fact.factId) === String(target.factId));
    case "defeat_enemy": return world.enemies.some((enemy) => String(enemy.id) === String(target.enemyId));
  }
}

function targetIsReachable(world: WorldState, target: RouteTarget): boolean {
  // 只有移动目标要求空间可达；其余目标是「在那儿做一件事」，由实体存在保证。
  return target.kind !== "visit_location" || isTravelTarget(world, target.locationId as LocationId);
}

/**
 * 规则审批两条候选：存在性、可达性、未完成、彼此不同、主线有可继续目标。
 *
 * 延迟地点定义在此逐候选重建为服务端保留的真实品牌 ID：provider 的局部符号
 * `$deferred` 只是占位，不能进入 registry / token / 事件。
 */
export function approveDecision(input: {
  readonly decision: Decision;
  readonly world: WorldState;
  readonly story: StoryState;
}): Check<Decision> {
  const { decision, world } = input;
  if (decision.options.some(option => option.target === null)) return fail("unknown_target_entity");

  if (decision.options[0].candidateId === decision.options[1].candidateId) {
    return fail("duplicate_candidate_id");
  }
  const npc = world.npcs.find((entry) => String(entry.id) === String(decision.npcId));
  if (npc === undefined) return fail("decision_npc_missing");
  if (String(npc.locationId) !== String(world.currentLocationId)) return fail("decision_npc_absent");

  if (currentObjectiveOf(world, input.story) === null) return fail("no_active_quest");

  // 逐候选重建：延迟地点的局部符号在这里换成服务端保留的真实 ID。
  const baseOrdinal = input.story.evolution.nextLocationOrdinal;
  const rebuilt: BranchOption[] = [];
  for (let index = 0; index < decision.options.length; index += 1) {
    const option = decision.options[index]!;
    if (option.deferredLocation === null) {
      rebuilt.push(option);
      continue;
    }
    if (option.target?.kind !== "visit_location") return fail("deferred_requires_visit_location");
    // 两条候选各自保留一个序号：未选分支留下空洞，但不合并计算为两个已生成地点。
    const reserved = asLocationId(`loc_dyn_${baseOrdinal + index}`);
    // 第一次审批看到 provider 的局部符号；重复审批（apply 时的 stale 检查）看到
    // 已经重建好的保留 ID。两者之外的任何 ID 都是伪造，一律拒绝。
    if (option.target.locationId !== DEFERRED_LOCATION_ID_SYMBOL
      && option.target.locationId !== String(reserved)) {
      return fail("deferred_symbol_required");
    }
    if (!validateDeferredLocationDefinition({ definition: option.deferredLocation, ws: world }).ok) {
      return fail("deferred_definition_invalid");
    }
    rebuilt.push({ ...option, target: { kind: "visit_location", locationId: reserved } });
  }
  const options = [rebuilt[0]!, rebuilt[1]!] as const;

  for (const option of options) {
    if (option.target === null) return fail("unknown_target_entity");
    if (option.deferredLocation !== null) continue;
    if (!targetEntityExists(world, option.target)) return fail("unknown_target_entity");
    if (!targetIsReachable(world, option.target)) return fail("target_unreachable");
    if (isObjectiveSatisfied(world, objectiveOfTarget(option.target))) return fail("target_already_satisfied");
  }
  if (options[0].target === null || options[1].target === null) return fail("unknown_target_entity");
  if (sameTarget(options[0].target, options[1].target)) return fail("duplicate_target");

  return {
    ok: true,
    value: {
      kind: "ordinary",
      point: { stepKey: decision.point.stepKey, order: decision.point.order },
      npcId: decision.npcId,
      options,
    },
  };
}

export type ApplyNarrativeBranchResult = {
  readonly world: WorldState;
  readonly story: StoryState;
  readonly drafts: readonly NarrativeEventDraft[];
};

/**
 * 应用已选择的分支：只替换当前未完成目标这一个槽位，绝不替玩家完成它。
 *
 * 规则顺序上必须在 reconcileQuests 之前调用，否则原 talk 目标会先被结算完成，
 * 分支访问目标就变成了「已经结束的任务里的多余一步」。
 */
export function applyNarrativeBranch(input: {
  readonly world: WorldState;
  readonly story: StoryState;
  readonly decision: Decision;
  readonly candidateId: string;
}): Check<ApplyNarrativeBranchResult> {
  const decisionId = decisionIdOf(input.decision);
  if (input.story.selectedBranches[decisionId] !== undefined) return fail("branch_already_selected");

  // 世界状态可能已经变化：重新审批一次，前提失效按 stale 拒绝，不挤占实体。
  const reapproved = approveDecision({
    decision: input.decision,
    world: input.world,
    story: input.story,
  });
  if (!reapproved.ok) return fail("branch_stale");
  const approved = reapproved.value;

  const option = approved.options.find((entry) => entry.candidateId === input.candidateId);
  if (option === undefined) return fail("unknown_candidate");
  if (option.target === null) return fail("unknown_target_entity");

  const objective = currentObjectiveOf(input.world, input.story);
  if (objective === null) return fail("no_active_quest");
  const quest = input.world.quests.find((entry) => String(entry.id) === String(objective.questId));
  const expectedOld = quest?.objectives[objective.objectiveIndex];
  if (quest === undefined || expectedOld === undefined) return fail("no_pending_objective");

  let world = input.world;
  let story = input.story;
  const drafts: NarrativeEventDraft[] = [];

  // 延迟地点：先消费已保留的 ID 材质化，再替换目标（引用此时才存在）。
  const baseOrdinal = input.story.evolution.nextLocationOrdinal;
  const reservedOrdinals = [baseOrdinal, baseOrdinal + 1];
  if (option.deferredLocation !== null) {
    if (option.target.kind !== "visit_location") return fail("deferred_requires_visit_location");
    const materialized = materializeDeferredLocation({
      definition: option.deferredLocation,
      ws: world,
      ss: story,
      locationId: asLocationId(option.target.locationId),
      reservedOrdinals,
    });
    if (!materialized.ok) return fail("deferred_definition_invalid");
    world = materialized.worldState;
    story = materialized.storyState;
    drafts.push(...materialized.drafts);
  }

  // 有限模板：延迟路线 = 访问所选新地点 → 与原 NPC 的新会话；否则只替换单个既有目标。
  const branchObjective = objectiveOfTarget(option.target);
  const replacement: readonly QuestObjective[] = option.deferredLocation === null
    ? [branchObjective]
    : [branchObjective, { kind: "talk_to_npc", npcId: approved.npcId as NpcId }];

  const mutations: readonly EntityMutation[] = [{
    kind: "replace_quest_objective",
    questId: quest.id,
    objectiveIndex: objective.objectiveIndex,
    expectedOld,
    replacement,
  }];
  const applied = applyEntityMutations(world, mutations, story);
  if (!applied.ok) throw new EntityMutationInvariantError(applied);
  world = applied.worldState;

  // 返程会话是新的会话：旧 talk 的 completed / usedAction 不得让它自动完成。
  const nextStory: StoryState = {
    ...story,
    branchDecisions: { ...story.branchDecisions, [decisionId]: approved },
    selectedBranches: { ...story.selectedBranches, [decisionId]: input.candidateId },
    narrative: {
      ...story.narrative,
      dialogueSession: {
        npcId: approved.npcId as NpcId,
        turnCount: 0,
        requiredTurns: 2,
        completed: false,
      },
    },
  };

  drafts.push({
    eventKey: `narrative_branch_selected:${decisionId}:${input.candidateId}`,
    episodeKey: "turn",
    actorIds: [PLAYER_ENTITY_ID],
    targetIds: [PLAYER_ENTITY_ID],
    locationId: world.currentLocationId,
    causeKeys: [],
    factIds: [],
    questIds: [quest.id],
    outcome: "success",
    salience: 55,
    payload: {
      type: "narrative_branch_selected",
      decisionId,
      candidateId: input.candidateId,
      questId: quest.id,
      objectiveIndex: objective.objectiveIndex,
      target: option.target,
    },
  });

  return { ok: true, value: { world, story: nextStory, drafts } };
}

/** 供 facade 导出：延迟地点定义的类型再导出。 */
export type { DeferredLocationDefinition };
