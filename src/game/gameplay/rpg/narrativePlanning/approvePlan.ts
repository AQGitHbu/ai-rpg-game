import type { GameLength } from "@/game/domain/newGame";
import type { PlanProposal, StepDependency } from "@/game/domain/narrativePlan";
import type { ChoiceExpression } from "@/game/domain/narrativeBranch";
import type { GenerationMetadata } from "@/game/domain/worldEntity";
import { PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { Unit } from "@/game/domain/narrativeUnit";
import { fail } from "@/game/domain/narrativeUnit";
import { compileOpeningStructure } from "@/game/gameplay/rpg/openingGeneration";
import { checkUnitGraph } from "./unitGraph";
import { endingDecisionStances } from "../narrativeBundle";
import type { BundleDescriptorGraph } from "../narrativeBundle";

// ---------------------------------------------------------------------------
// 骨架规则审批：把已验证提案固定到权威世界/剧情状态上。
// preview 不是权威状态；只有 approvePlan 的返回值可进入表达与发布。
// ---------------------------------------------------------------------------

export type ApprovedPlan = {
  readonly proposal: PlanProposal;
  readonly world: WorldState;
  readonly story: StoryState;
  readonly units: readonly Unit[];
  readonly choiceExpression: ChoiceExpression | null;
  readonly stepDependencies: Readonly<Record<string, readonly StepDependency[]>>;
  /** 由应用层在核对提案后附加的规则图；不来自模型、不持久化为知识或事件。 */
  readonly ruleSceneGraph?: BundleDescriptorGraph;
  /** 应用层绑定本回合真实提问，属于待回应话语，不是知识事实。 */
  /** 服务端绑定当前任务完成节拍的规则事件；不授予任何 NPC 知识。 */
  readonly currentBeatEvidence?: Readonly<Record<string, readonly string[]>>;
  readonly currentUtterance?: Readonly<{
    npcId: string | null;
    text: string;
    inquiries?: NonNullable<import("@/game/domain/expressionTask").ExpressionTask["inquiries"]>;
    previousReply?: Readonly<{ text: string; factIds: readonly string[] }>;
    previousChoices?: readonly string[];
  }>;
};

export type PlanApprovalInput =
  | {
      readonly kind: "opening";
      readonly proposal: PlanProposal;
      readonly generation: GenerationMetadata;
      readonly gameLength: GameLength;
      readonly seed: string;
    }
  | {
      readonly kind: "decision";
      readonly proposal: PlanProposal;
      readonly world: WorldState;
      readonly story: StoryState;
    };

export type ApprovePlanResult =
  | { readonly ok: true; readonly value: ApprovedPlan }
  | { readonly ok: false; readonly code: string };

/**
 * 从单元的观察要求铸造 before 观察依赖：旁白受众是玩家（speakerId 为 null），
 * 角色单元受众是说话 NPC。回执核对（受众确实收到）在消费时按真实状态执行。
 */
function stepDependenciesOf(
  units: readonly Unit[],
): Readonly<Record<string, readonly StepDependency[]>> {
  const map: Record<string, readonly StepDependency[]> = {};
  for (const unit of units) {
    if (unit.requiredObservationKeys.length === 0) continue;
    const audienceId = unit.speakerId ?? String(PLAYER_ENTITY_ID);
    map[unit.key] = unit.requiredObservationKeys.map((observationKey) => ({
      phase: "before" as const,
      predicate: { kind: "observation" as const, observationKey, audienceId },
    }));
  }
  return map;
}

export function approvePlan(input: PlanApprovalInput): ApprovePlanResult {
  const proposal = input.proposal;
  let decision = proposal.decision;
  if (proposal.terminal.kind === "ending") {
    if (input.kind !== "decision" || decision !== null || proposal.steps.length !== 0) {
      return fail("plan_ending_decision_invalid");
    }
    const choice = proposal.units.find(unit => unit.stage === "choices");
    const stances = endingDecisionStances(input.world, input.story);
    if (stances.length !== 2 || choice?.point.stepKey !== "current") return fail("plan_ending_not_ready");
    decision = { kind: "ending", point: choice.point, npcId: String(stances[0]!.action.npcId), options: [
      { candidateId: "trust", dialogueAct: "support", publicIntent: { text: "表明信任与支持的立场", facts: [], evidence: [], beatIds: [] } },
      { candidateId: "doubt", dialogueAct: "challenge", publicIntent: { text: "表明质疑与核验的立场", facts: [], evidence: [], beatIds: [] } },
    ] };
  }
  const graph = checkUnitGraph({
    units: input.proposal.units,
    observations: input.proposal.observations,
    decision,
  });
  if (!graph.ok) return { ok: false, code: graph.code };

  if (!proposal.units.some(unit => unit.point.stepKey === "current" && unit.stage !== "choices")) {
    return fail("plan_current_scene_missing");
  }
  const stepKeys = new Set(proposal.steps.map(step => step.key));
  if (stepKeys.has("current")) return fail("plan_current_is_not_future_step");
  if (proposal.units.some(unit => unit.point.stepKey !== "current" && !stepKeys.has(unit.point.stepKey))) {
    return fail("plan_unit_step_unknown");
  }
  const choice = proposal.units.find(unit => unit.stage === "choices");
  if (choice !== undefined && proposal.units.some(unit => unit.stage !== "choices"
    && unit.point.stepKey === choice.point.stepKey && unit.point.order >= choice.point.order)) {
    return fail("plan_choices_before_expression");
  }
  if (decision !== null && (choice?.point.stepKey !== decision.point.stepKey
    || choice.point.order !== decision.point.order)) return fail("plan_decision_point_mismatch");
  if (proposal.terminal.kind === "next_decision") {
    const target = proposal.terminal.target;
    const targetKey = target.kind === "current_scene" ? "current" : target.stepKey;
    if (choice?.point.stepKey !== targetKey) return fail("plan_terminal_choice_mismatch");
    if (targetKey === "current" && proposal.steps.length > 0) return fail("plan_steps_after_decision");
  }

  const ancestorsOf = (key: string, seen = new Set<string>()): Set<string> => {
    if (key === "current" || seen.has(key)) return seen;
    seen.add("current");
    for (const parent of proposal.steps.filter(step => step.next.includes(key))) {
      if (seen.has(parent.key)) continue;
      seen.add(parent.key); ancestorsOf(parent.key, seen);
    }
    return seen;
  };
  const units = proposal.units.map(unit => {
    const ancestors = ancestorsOf(unit.point.stepKey);
    const prior = proposal.units.filter(candidate => candidate.key !== unit.key
      && (ancestors.has(candidate.point.stepKey) || (candidate.point.stepKey === unit.point.stepKey && candidate.point.order < unit.point.order)));
    return { ...unit, dependencies: [...new Set([...unit.dependencies, ...prior.map(candidate => candidate.key)])] };
  });
  if (units.some(unit => unit.dependencies.some(key => {
    const dependency = units.find(candidate => candidate.key === key)!;
    return dependency.point.stepKey === unit.point.stepKey
      ? dependency.point.order > unit.point.order : !ancestorsOf(unit.point.stepKey).has(dependency.point.stepKey);
  }))) return fail("plan_future_dependency");
  const orderedGraph = checkUnitGraph({ units, observations: proposal.observations, decision });
  if (!orderedGraph.ok) return orderedGraph;

  switch (input.kind) {
    case "opening": {
      if (input.proposal.opening === null) {
        return { ok: false, code: "opening_required" };
      }
      const structure = compileOpeningStructure({
        candidate: input.proposal.opening,
        generation: input.generation,
        gameLength: input.gameLength,
        seed: input.seed,
      });
      return {
        ok: true,
        value: {
          proposal: input.proposal,
          world: structure.worldState,
          story: structure.storyState,
          units,
          choiceExpression: decision,
          stepDependencies: stepDependenciesOf(input.proposal.units),
        },
      };
    }
    case "decision": {
      if (input.proposal.opening !== null) {
        return { ok: false, code: "opening_forbidden" };
      }
      return {
        ok: true,
        value: {
          proposal: input.proposal,
          world: input.world,
          story: input.story,
          units,
          choiceExpression: decision,
          stepDependencies: stepDependenciesOf(input.proposal.units),
        },
      };
    }
    default:
      return fail("unknown_approval_kind");
  }
}
