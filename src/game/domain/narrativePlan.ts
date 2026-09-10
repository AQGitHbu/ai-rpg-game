// 剧情规划骨架（Spec §4）。
//
// PlanProposal 是规划器的结构化提案：不是最终展示文案，也未经审批。
// 服务端逐字段重建后交给 gameplay 审批，拒绝未知键、未知枚举、悬空引用与环。

import { parseOpeningGenerationCandidate, type OpeningGenerationCandidate } from "./openingGenerationCandidate";
import {
  hasOnlyKeys,
  isPlainRecord,
  fail,
  parseCosmeticAction,
  parseKey,
  parseKeys,
  parseUnit,
  type Check,
  type CosmeticAction,
  type Unit,
} from "./narrativeUnit";
import { parseObservation, type Observation } from "./narrativeObservation";
import { parseDecision, type Decision, type EndingExpression } from "./narrativeBranch";
import type { NarrativeBundleTerminal, NarrativeBundleTrigger } from "./narrativeBundle";
import type { WorldDeltaProposal } from "./worldDelta";
import { MAX_NARRATIVE_BUNDLE_STEPS } from "./narrativeBundle";

export type { Unit } from "./narrativeUnit";

/** 规划 1 次 + 表达单元上限 39：整包基础工作量必须在预算内。 */
export const MAX_PLAN_UNITS = 39;

/** 未来步骤消费时复核的依赖：纯数据，无任意字段路径。 */
export type StepDependency = {
  readonly phase: "before" | "after";
  readonly predicate:
  | { readonly kind: "player_location"; readonly locationId: string }
  | { readonly kind: "npc_location"; readonly npcId: string; readonly locationId: string }
  | { readonly kind: "item_holder"; readonly itemId: string; readonly holderId: string }
  | { readonly kind: "entity_lifecycle"; readonly entityId: string; readonly lifecycle: "active" | "inactive" | "resolved" }
  | { readonly kind: "branch_selected"; readonly decisionId: string; readonly candidateId: string }
  | { readonly kind: "observation"; readonly observationKey: string; readonly audienceId: string }
  | { readonly kind: "battle_victory"; readonly enemyId: string };
};

export type PlanStep = {
  readonly key: string;
  readonly trigger: NarrativeBundleTrigger;
  readonly next: readonly string[];
};

export type PlanProposal = {
  readonly opening: OpeningGenerationCandidate | null;
  readonly worldDelta: WorldDeltaProposal | null;
  readonly steps: readonly PlanStep[];
  readonly units: readonly Unit[];
  readonly observations: readonly Observation[];
  readonly actions: readonly CosmeticAction[];
  /**
   * ordinary 决策可由 AI 提议（parsePlanProposal 只接受 ordinary）；ending 表达
   * 完全由规则派生（Task 9 铸造），仅出现在服务端构建的 PlanProposal 里。
   */
  readonly decision: Decision | EndingExpression | null;
  readonly terminal: NarrativeBundleTerminal;
};

// ---------------------------------------------------------------------------
// 触发器与终点
// ---------------------------------------------------------------------------

function parseTrigger(value: unknown): NarrativeBundleTrigger | null {
  if (!isPlainRecord(value)) return null;
  switch (value.kind) {
    case "move":
    case "explore": {
      if (!hasOnlyKeys(value, ["kind", "locationId"])) return null;
      const locationId = parseKey(value.locationId);
      return locationId === null ? null : { kind: value.kind, locationId } as NarrativeBundleTrigger;
    }
    case "investigate": {
      if (!hasOnlyKeys(value, ["kind", "factId", "approachId"])) return null;
      const factId = parseKey(value.factId);
      if (factId === null) return null;
      if (value.approachId === undefined) {
        return { kind: "investigate", factId } as NarrativeBundleTrigger;
      }
      const approachId = parseKey(value.approachId);
      return approachId === null ? null : { kind: "investigate", factId, approachId } as NarrativeBundleTrigger;
    }
    case "take_item": {
      if (!hasOnlyKeys(value, ["kind", "itemId"])) return null;
      const itemId = parseKey(value.itemId);
      return itemId === null ? null : { kind: "take_item", itemId } as NarrativeBundleTrigger;
    }
    case "give_item": {
      if (!hasOnlyKeys(value, ["kind", "itemId", "npcId"])) return null;
      const itemId = parseKey(value.itemId);
      const npcId = parseKey(value.npcId);
      return itemId === null || npcId === null ? null : { kind: "give_item", itemId, npcId } as NarrativeBundleTrigger;
    }
    case "battle_started": {
      if (!hasOnlyKeys(value, ["kind", "enemyId"])) return null;
      const enemyId = parseKey(value.enemyId);
      return enemyId === null ? null : { kind: "battle_started", enemyId } as NarrativeBundleTrigger;
    }
    case "battle_resolved": {
      if (!hasOnlyKeys(value, ["kind", "enemyId", "outcome"])) return null;
      if (value.outcome !== "victory") return null;
      const enemyId = parseKey(value.enemyId);
      return enemyId === null ? null : { kind: "battle_resolved", enemyId, outcome: "victory" } as NarrativeBundleTrigger;
    }
    default:
      return null;
  }
}

function parseTerminal(value: unknown): NarrativeBundleTerminal | null {
  if (!isPlainRecord(value)) return null;
  if (value.kind === "ending") {
    return hasOnlyKeys(value, ["kind"]) ? { kind: "ending" } : null;
  }
  if (value.kind !== "next_decision") return null;
  if (!hasOnlyKeys(value, ["kind", "target"])) return null;
  if (!isPlainRecord(value.target)) return null;
  if (value.target.kind === "current_scene") {
    return hasOnlyKeys(value.target, ["kind"]) ? { kind: "next_decision", target: { kind: "current_scene" } } : null;
  }
  if (value.target.kind !== "continuation_step") return null;
  if (!hasOnlyKeys(value.target, ["kind", "stepKey"])) return null;
  const stepKey = parseKey(value.target.stepKey);
  return stepKey === null ? null : { kind: "next_decision", target: { kind: "continuation_step", stepKey } };
}

// ---------------------------------------------------------------------------
// 图结构
// ---------------------------------------------------------------------------

/** 返回按依赖拓扑可达的键集合；存在环时返回 null。 */
function acyclicOrder(
  nodes: ReadonlyMap<string, readonly string[]>,
): readonly string[] | null {
  const state = new Map<string, "visiting" | "done">();
  const order: string[] = [];
  const visit = (key: string): boolean => {
    const current = state.get(key);
    if (current === "done") return true;
    if (current === "visiting") return false;
    state.set(key, "visiting");
    for (const dependency of nodes.get(key) ?? []) {
      if (!visit(dependency)) return false;
    }
    state.set(key, "done");
    order.push(key);
    return true;
  };
  for (const key of nodes.keys()) {
    if (!visit(key)) return null;
  }
  return order;
}

// ---------------------------------------------------------------------------
// 整包解析
// ---------------------------------------------------------------------------

/** 逐字段重建规划骨架；悬空引用、重复身份与环一律拒绝。 */
export function parsePlanProposal(raw: unknown): Check<PlanProposal> {
  if (!isPlainRecord(raw)) return fail("plan_not_object");
  if (!hasOnlyKeys(raw, [
    "opening", "worldDelta", "steps", "units", "observations", "actions", "decision", "terminal",
  ])) return fail("plan_unknown_key");

  let opening: OpeningGenerationCandidate | null = null;
  if (raw.opening !== null && raw.opening !== undefined) {
    const parsed = parseOpeningGenerationCandidate(raw.opening);
    if (!parsed.ok) return fail("plan_opening_invalid");
    opening = parsed.value;
  }

  // worldDelta 的结构解析由 domain 的同一实现承担（见 worldDeltaProposal.ts）；
  // 规则过滤仍留在 gameplay，本层不做审批。
  let worldDelta: WorldDeltaProposal | null = null;
  if (raw.worldDelta !== null && raw.worldDelta !== undefined) {
    if (!isPlainRecord(raw.worldDelta)) return fail("plan_world_delta_invalid");
    worldDelta = raw.worldDelta as unknown as WorldDeltaProposal;
  }

  if (!Array.isArray(raw.steps)) return fail("plan_steps_invalid");
  if (raw.steps.length > MAX_NARRATIVE_BUNDLE_STEPS) return fail("plan_steps_over_cap");
  const steps: PlanStep[] = [];
  const stepKeys = new Set<string>();
  for (const item of raw.steps) {
    if (!isPlainRecord(item) || !hasOnlyKeys(item, ["key", "trigger", "next"])) return fail("plan_step_shape_invalid");
    const key = parseKey(item.key);
    if (key === null || stepKeys.has(key)) return fail("plan_step_key_invalid");
    stepKeys.add(key);
    const trigger = parseTrigger(item.trigger);
    if (trigger === null) return fail("plan_step_trigger_invalid");
    const next = parseKeys(item.next);
    if (next === null) return fail("plan_step_next_invalid");
    steps.push({ key, trigger, next });
  }
  for (const step of steps) {
    if (step.next.some((key) => !stepKeys.has(key))) return fail("plan_step_next_dangling");
  }
  const stepGraph = new Map<string, readonly string[]>(steps.map((step) => [step.key, step.next]));
  if (acyclicOrder(stepGraph) === null) return fail("plan_step_cycle");

  if (!Array.isArray(raw.units)) return fail("plan_units_invalid");
  if (raw.units.length > MAX_PLAN_UNITS) return fail("plan_units_over_cap");
  const units: Unit[] = [];
  const unitKeys = new Set<string>();
  for (const item of raw.units) {
    const unit = parseUnit(item);
    if (unit === null) return fail("plan_unit_invalid");
    if (unitKeys.has(unit.key)) return fail("plan_unit_key_duplicate");
    unitKeys.add(unit.key);
    units.push(unit);
  }
  for (const unit of units) {
    if (unit.dependencies.some((key) => !unitKeys.has(key))) return fail("plan_unit_dependency_dangling");
  }
  const unitGraph = new Map<string, readonly string[]>(units.map((unit) => [unit.key, unit.dependencies]));
  if (acyclicOrder(unitGraph) === null) return fail("plan_unit_cycle");

  if (!Array.isArray(raw.observations)) return fail("plan_observations_invalid");
  const observations: Observation[] = [];
  const observationKeys = new Set<string>();
  for (const item of raw.observations) {
    const parsed = parseObservation(item);
    if (!parsed.ok) return parsed;
    if (observationKeys.has(parsed.value.key)) return fail("plan_observation_key_duplicate");
    observationKeys.add(parsed.value.key);
    observations.push(parsed.value);
  }

  if (!Array.isArray(raw.actions)) return fail("plan_actions_invalid");
  const actions: CosmeticAction[] = [];
  const actionKeys = new Set<string>();
  for (const item of raw.actions) {
    const action = parseCosmeticAction(item);
    if (action === null) return fail("plan_action_invalid");
    if (actionKeys.has(action.key)) return fail("plan_action_key_duplicate");
    actionKeys.add(action.key);
    actions.push(action);
  }

  let decision: Decision | null = null;
  if (raw.decision !== null && raw.decision !== undefined) {
    const parsed = parseDecision(raw.decision);
    if (!parsed.ok) return parsed;
    decision = parsed.value;
  }

  const terminal = parseTerminal(raw.terminal);
  if (terminal === null) return fail("plan_terminal_invalid");
  if (terminal.kind === "next_decision" && terminal.target.kind === "continuation_step"
    && !stepKeys.has(terminal.target.stepKey)) {
    return fail("plan_terminal_step_dangling");
  }

  return {
    ok: true,
    value: {
      opening,
      worldDelta,
      steps,
      units,
      observations,
      actions,
      decision,
      terminal,
    },
  };
}
