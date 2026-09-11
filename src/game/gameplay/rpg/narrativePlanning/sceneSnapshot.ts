import type { StepDependency } from "@/game/domain/narrativePlan";
import type { Observation, ScenePoint } from "@/game/domain/narrativeObservation";
import { fail, type UnitOutput } from "@/game/domain/narrativeUnit";
import type { WorldState } from "@/game/domain/worldState";
import { PLAYER_ENTITY_ID, locationScaleOf } from "@/game/domain/worldEntity";
import type { StoryState } from "@/game/domain/storyState";
import type { ApprovedPlan } from "./approvePlan";
import { applyEntityMutations, type EntityMutation } from "@/game/gameplay/rpg/entityWorld";
import { isTravelTarget } from "@/game/domain/worldState";

// ---------------------------------------------------------------------------
// 场景条件快照与步骤依赖复核。
// 快照只投影已批准的权威状态与该时点观察；战斗随机细节等无法在预生成时
// 确定的内容不在可保证范围内（消费时按真实状态重新验证）。
// ---------------------------------------------------------------------------

export type SceneSnapshot = {
  readonly world: WorldState;
  readonly story: StoryState;
  readonly observations: readonly Observation[];
  /** 已批准上游实际披露的条件认知，绝不伪造成已提交 knowledge/EventId。 */
  readonly learned: readonly Observation[];
};

export type SceneSnapshotResult =
  | { readonly ok: true; value: SceneSnapshot }
  | { readonly ok: false; readonly code: string };

const samePoint = (a: ScenePoint, b: ScenePoint): boolean =>
  a.stepKey === b.stepKey && a.order === b.order;

/** 取某步骤时点的场景快照：权威状态 + 该时点批准的观察。 */
export function sceneSnapshot(input: {
  readonly plan: ApprovedPlan;
  readonly point: ScenePoint;
  readonly approved?: ReadonlyMap<string, UnitOutput>;
}): SceneSnapshotResult {
  const { plan, point } = input;
  const observations = plan.proposal.observations.filter((o) => samePoint(o.point, point));
  const hasUnits = plan.proposal.units.some((u) => samePoint(u.point, point));
  const hasActions = plan.proposal.actions.some((a) => samePoint(a.point, point));
  if (observations.length === 0 && !hasUnits && !hasActions) {
    return fail("unknown_point");
  }
  // 只沿该节点的唯一祖先路径预览；多父节点的结果不能盲目取并集。
  const path: string[] = [];
  const seen = new Set<string>();
  let key = point.stepKey;
  while (key !== "current") {
    if (seen.has(key)) return fail("snapshot_step_cycle");
    seen.add(key);
    const step = plan.proposal.steps.find(step => step.key === key);
    if (step === undefined) return fail("snapshot_step_unknown");
    path.unshift(key);
    const parents = plan.proposal.steps.filter(step => step.next.includes(key));
    if (parents.length > 1) return fail("snapshot_path_ambiguous");
    key = parents[0]?.key ?? "current";
  }
  let world = plan.world;
  for (const stepKey of path) {
    const trigger = plan.proposal.steps.find(step => step.key === stepKey)!.trigger;
    let mutation: EntityMutation | null = null;
    switch (trigger.kind) {
      case "move":
        if (!isTravelTarget(world, trigger.locationId)) return fail("snapshot_move_unreachable");
        mutation = { kind: "move_player", toLocationId: trigger.locationId, markVisited: true }; break;
      case "take_item":
        if (!world.locations.find(location => location.id === world.currentLocationId)?.availableItemIds.includes(trigger.itemId)) return fail("snapshot_item_unavailable");
        mutation = { kind: "transfer_item", itemId: trigger.itemId, owner: { kind: "player", playerId: PLAYER_ENTITY_ID } }; break;
      case "give_item":
        if (!world.inventory.includes(trigger.itemId) || !world.npcs.some(npc => npc.id === trigger.npcId && npc.locationId === world.currentLocationId)) return fail("snapshot_give_unavailable");
        mutation = { kind: "transfer_item", itemId: trigger.itemId, owner: { kind: "npc", npcId: trigger.npcId } }; break;
      case "battle_resolved": mutation = { kind: "set_enemy_defeated", enemyId: trigger.enemyId, defeated: true }; break;
      // 只预览 trigger 能保证的事实，不预测战斗 HP/伤害或调查产生的未知信息。
      case "investigate": {
        const fact = world.worldFacts.find(fact => fact.factId === trigger.factId);
        if (fact === undefined || (fact.locationId !== undefined && fact.locationId !== world.currentLocationId)) return fail("snapshot_fact_unavailable");
        if (trigger.approachId !== undefined && !fact.investigationApproaches?.some(approach => approach.approachId === trigger.approachId)) return fail("snapshot_approach_unknown");
        mutation = { kind: "discover_fact", factId: trigger.factId }; break;
      }
      case "explore":
        if (trigger.locationId !== world.currentLocationId) return fail("snapshot_explore_location");
        break;
      case "battle_started": break;
    }
    if (mutation !== null) {
      const applied = applyEntityMutations(world, [mutation]);
      if (!applied.ok) return fail("snapshot_trigger_invalid");
      world = applied.worldState;
    }
    // 正式规则在动作边界确认连续 discover_fact 目标。描述图已把这些零动作
    // 目标折入对应步骤；只预览本路径、本步骤的事实，不能把整包事实提前公开。
    const descriptor = plan.ruleSceneGraph?.steps.find(step => step.stepKey === stepKey);
    const quest = world.quests.find(quest => quest.id === descriptor?.authority.questId);
    const location = world.locations.find(location => location.id === world.currentLocationId);
    const canDiscover = location === undefined || locationScaleOf(location) !== "town"
      || trigger.kind === "explore" || trigger.kind === "take_item";
    if (descriptor !== undefined && quest !== undefined && canDiscover) {
      for (const index of descriptor.absorbedObjectiveIndexes) {
        const objective = quest.objectives[index];
        if (objective?.kind !== "discover_fact") continue;
        const fact = world.worldFacts.find(fact => fact.factId === objective.factId);
        // 与实际自动确认一致：遇到异地/缺失事实即停止，不跳过它揭示后续事实。
        if (fact === undefined || (fact.locationId !== undefined && fact.locationId !== world.currentLocationId)) break;
        if (fact.discovered) continue;
        const discovered = applyEntityMutations(world, [{ kind: "discover_fact", factId: objective.factId }]);
        if (!discovered.ok) return fail("snapshot_trigger_invalid");
        world = discovered.worldState;
      }
    }
  }
  const ranks = new Map(["current", ...path].map((step, index) => [step, index]));
  const rank = ranks.get(point.stepKey)!;
  const learned = plan.proposal.observations.flatMap(observation => {
    const priorRank = ranks.get(observation.point.stepKey);
    if (priorRank === undefined || priorRank > rank
      || (priorRank === rank && observation.point.order >= point.order)) return [];
    const disclosed = plan.units.flatMap(unit => {
      if (unit.point.stepKey !== observation.point.stepKey || unit.point.order > (priorRank === rank ? point.order - 1 : Infinity)
        || !unit.requiredObservationKeys.includes(observation.key)) return [];
      if (observation.source.kind === "speech" ? unit.speakerId !== observation.source.speakerId : unit.stage !== "narration") return [];
      const output = input.approved?.get(unit.key);
      return output !== undefined && output.stage !== "choices" ? output.parts.flatMap(part =>
        part.facts.filter(fact => fact.factId === observation.fact.factId)) : [];
    });
    if (disclosed.length === 0) return [];
    const certainty = observation.fact.certainty === "suspected" || disclosed.some(fact => fact.certainty === "suspected")
      ? "suspected" as const : "known" as const;
    return [{ ...observation, fact: { ...observation.fact, certainty } }];
  });
  return {
    ok: true,
    value: {
      world,
      story: plan.story,
      observations,
      learned,
    },
  };
}

export type StepDependencyCheckResult =
  | { readonly ok: true; readonly value: true }
  | { readonly ok: false; readonly code: string };

/**
 * 离线依赖检查的观察键格式：`audienceId:observationKey`。
 * 计划声明不构成回执。生产发布重放实际表达审批；消费时以 bundle premises
 * 绑定的 ledger 序号下界、受众、事实与 certainty 验证真实观察。
 */
export function observationReceiptKey(audienceId: string, observationKey: string): string {
  return `${audienceId}:${observationKey}`;
}

function isEntityPresent(world: WorldState, entityId: string): boolean {
  return world.npcs.some((n) => String(n.id) === entityId)
    || world.locations.some((l) => String(l.id) === entityId)
    || world.quests.some((q) => String(q.id) === entityId)
    || world.enemies.some((e) => String(e.id) === entityId)
    || world.items.some((i) => String(i.id) === entityId);
}

function isEntityResolved(world: WorldState, entityId: string): boolean {
  if (world.defeatedEnemyIds.some((id) => String(id) === entityId)) return true;
  const quest = world.quests.find((q) => String(q.id) === entityId);
  return quest !== undefined && (quest.status === "completed" || quest.status === "failed");
}

function holdsItem(world: WorldState, itemId: string, holderId: string): boolean {
  if (holderId === String(PLAYER_ENTITY_ID)) {
    return world.inventory.some((id) => String(id) === itemId);
  }
  const location = world.locations.find((l) => String(l.id) === holderId);
  return location !== undefined && location.availableItemIds.some((id) => String(id) === itemId);
}

function predicateHolds(input: {
  readonly world: WorldState;
  readonly story: StoryState;
  readonly predicate: StepDependency["predicate"];
  readonly observationReceipts: ReadonlySet<string> | undefined;
}): { ok: true } | { ok: false; code: string } {
  const { world, story, predicate, observationReceipts } = input;
  switch (predicate.kind) {
    case "player_location":
      return String(world.currentLocationId) === predicate.locationId
        ? { ok: true }
        : { ok: false, code: "player_location_mismatch" };
    case "npc_location": {
      const npc = world.npcs.find((n) => String(n.id) === predicate.npcId);
      return npc !== undefined && String(npc.locationId) === predicate.locationId
        ? { ok: true }
        : { ok: false, code: "npc_location_mismatch" };
    }
    case "item_holder":
      return holdsItem(world, predicate.itemId, predicate.holderId)
        ? { ok: true }
        : { ok: false, code: "item_holder_mismatch" };
    case "entity_lifecycle": {
      const holds = predicate.lifecycle === "active"
        ? isEntityPresent(world, predicate.entityId)
        : predicate.lifecycle === "resolved"
          ? isEntityResolved(world, predicate.entityId)
          : !isEntityPresent(world, predicate.entityId);
      return holds ? { ok: true } : { ok: false, code: "entity_lifecycle_mismatch" };
    }
    case "branch_selected":
      return String(story.selectedBranches[predicate.decisionId] ?? "") === predicate.candidateId
        ? { ok: true }
        : { ok: false, code: "branch_not_selected" };
    case "battle_victory":
      return world.defeatedEnemyIds.some((id) => String(id) === predicate.enemyId)
        ? { ok: true }
        : { ok: false, code: "battle_not_won" };
    case "observation": {
      // fail-closed：没有回执凭据就不能证明受众已观察到（回执在任务执行层落地）。
      if (observationReceipts === undefined) {
        return { ok: false, code: "observation_receipt_missing" };
      }
      return observationReceipts.has(observationReceiptKey(predicate.audienceId, predicate.observationKey))
        ? { ok: true }
        : { ok: false, code: "observation_receipt_missing" };
    }
    default: {
      const exhaustive: never = predicate;
      void exhaustive;
      return { ok: false, code: "unknown_predicate" };
    }
  }
}

/**
 * 逐步骤复核依赖：before 在 resolveTurn 前调用，after 在纯规则结果上、
 * 同次 CAS 前调用。任何失败都不提交规则变化。
 */
export function checkStepDependencies(input: {
  readonly world: WorldState;
  readonly story: StoryState;
  readonly phase: "before" | "after";
  readonly expected: readonly StepDependency[];
  /** 已批准观察的回执凭据；缺失时 observation 依赖按 fail-closed 处理。 */
  readonly observationReceipts?: ReadonlySet<string>;
}): StepDependencyCheckResult {
  for (const dependency of input.expected) {
    if (dependency.phase !== input.phase) {
      return { ok: false, code: "phase_mismatch" };
    }
    const holds = predicateHolds({
      world: input.world,
      story: input.story,
      predicate: dependency.predicate,
      observationReceipts: input.observationReceipts,
    });
    if (!holds.ok) return holds;
  }
  return { ok: true, value: true };
}

