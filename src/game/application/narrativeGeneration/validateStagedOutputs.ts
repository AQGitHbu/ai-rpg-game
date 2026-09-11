import type { ApprovedPlan } from "@/game/gameplay/rpg/narrativePlanning";
import { collectDisclosures, readyUnits } from "@/game/gameplay/rpg/narrativePlanning";
import { fail, type Check, type UnitOutput } from "@/game/domain/narrativeUnit";
import type { BundleScenePremises } from "@/game/domain/narrativeBundle";
import { PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import type { Observation } from "@/game/domain/narrativeObservation";
import { approveUnit } from "./approveUnit";
import { projectUnitContext } from "./perspectiveContext";

export type StagedSpeechFacts = ReadonlyMap<string, ReadonlySet<string>>;

/** 发布时重放逐单元审批；仅已重放上游可进入条件快照，不将全包观察冒充回执。 */
export function validateStagedOutputs(plan: ApprovedPlan, outputs: ReadonlyMap<string, UnitOutput>): Check<{
  observations: readonly Observation[];
  speechFactsByStep: ReadonlyMap<string, StagedSpeechFacts>;
  prerequisitesByStep: ReadonlyMap<string, BundleScenePremises["observations"]>;
}> {
  const prerequisitesByStep = new Map<string, BundleScenePremises["observations"]>();
  const approved = new Map<string, UnitOutput>();
  const observations = new Map<string, Observation>();
  const speechFactsByStep = new Map<string, Map<string, Set<string>>>();
  while (approved.size < plan.units.length) {
    const units = readyUnits(plan.units, new Set(approved.keys()));
    if (units.length === 0) return fail("staged_dependency_unmet");
    for (const unit of units) {
      const output = outputs.get(unit.key);
      if (output === undefined) return fail("assemble_unit_missing");
      const context = projectUnitContext({ plan, unit, approved });
      if (!context.ok) return context;
      // 只保存跨场景条件来源；同幕上游在逐单元重放中验证，不能提前要求 ledger 已提交。
      const prerequisites = [...(prerequisitesByStep.get(unit.point.stepKey) ?? [])];
      for (const fact of context.value.visibleFacts) {
        for (const source of fact.sources) {
          if (source.kind !== "conditional") continue;
          const observation = observations.get(source.observationKey);
          if (observation === undefined || observation.point.stepKey === unit.point.stepKey) continue;
          prerequisites.push({ observationKey: source.observationKey, audienceId: unit.speakerId ?? String(PLAYER_ENTITY_ID),
            factId: fact.id, certainty: fact.certainty });
        }
      }
      prerequisitesByStep.set(unit.point.stepKey, prerequisites);
      const checked = approveUnit({ unit, context: context.value, output });
      if (!checked.ok) return checked;
      const disclosed = collectDisclosures({ plan, unit, output, approved });
      if (!disclosed.ok) return disclosed;
      for (const observation of disclosed.value) observations.set(observation.key, observation);
      if (output.stage === "character") {
        const scene = speechFactsByStep.get(unit.point.stepKey) ?? new Map<string, Set<string>>();
        const facts = scene.get(output.speakerId) ?? new Set<string>();
        output.parts.forEach(part => part.facts.forEach(fact => facts.add(fact.factId)));
        scene.set(output.speakerId, facts); speechFactsByStep.set(unit.point.stepKey, scene);
      }
      approved.set(unit.key, output);
    }
  }
  return { ok: true, value: { observations: [...observations.values()], speechFactsByStep, prerequisitesByStep } };
}
