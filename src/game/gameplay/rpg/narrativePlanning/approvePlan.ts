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
  const graph = checkUnitGraph({
    units: input.proposal.units,
    observations: input.proposal.observations,
    decision: input.proposal.decision,
  });
  if (!graph.ok) return { ok: false, code: graph.code };

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
          units: input.proposal.units,
          choiceExpression: input.proposal.decision,
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
          units: input.proposal.units,
          choiceExpression: input.proposal.decision,
          stepDependencies: stepDependenciesOf(input.proposal.units),
        },
      };
    }
    default:
      return fail("unknown_approval_kind");
  }
}
