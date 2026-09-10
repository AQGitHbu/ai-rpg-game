import type { StepDependency } from "@/game/domain/narrativePlan";
import type { Observation, ScenePoint } from "@/game/domain/narrativeObservation";
import { fail } from "@/game/domain/narrativeUnit";
import type { WorldState } from "@/game/domain/worldState";
import { PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import type { StoryState } from "@/game/domain/storyState";
import type { ApprovedPlan } from "./approvePlan";

// ---------------------------------------------------------------------------
// 场景条件快照与步骤依赖复核。
// 快照只投影已批准的权威状态与该时点观察；战斗随机细节等无法在预生成时
// 确定的内容不在可保证范围内（消费时按真实状态重新验证）。
// ---------------------------------------------------------------------------

export type SceneSnapshot = {
  readonly world: WorldState;
  readonly story: StoryState;
  readonly observations: readonly Observation[];
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
}): SceneSnapshotResult {
  const { plan, point } = input;
  const observations = plan.proposal.observations.filter((o) => samePoint(o.point, point));
  const hasUnits = plan.proposal.units.some((u) => samePoint(u.point, point));
  const hasActions = plan.proposal.actions.some((a) => samePoint(a.point, point));
  if (observations.length === 0 && !hasUnits && !hasActions) {
    return fail("unknown_point");
  }
  return {
    ok: true,
    value: {
      world: plan.world,
      story: plan.story,
      observations,
    },
  };
}

export type StepDependencyCheckResult =
  | { readonly ok: true; readonly value: true }
  | { readonly ok: false; readonly code: string };

/**
 * 观察回执凭据格式：`audienceId:observationKey`。由任务执行层（decisionJob
 * 的 observationReceiptsOf）在装配审批前铸造：计划获批即其全部声明观察获批，
 * 无逐条观察审批。持有回执才能通过 observation 依赖的 fail-closed 检查。
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

