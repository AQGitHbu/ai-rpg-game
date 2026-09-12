import type { PlanProposal } from "@/game/domain/narrativePlan";
import type { PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";

/** 同一步骤里同一 NPC 只能有一个完整回应任务；规划器负责把全部内容合在其中。 */
export function repeatedNpcResponseUnits(proposal: PlanProposal): readonly string[] {
  const seen = new Set<string>();
  const repeated: string[] = [];
  for (const unit of proposal.units) {
    if (unit.stage !== "character" || unit.speakerId === null) continue;
    const identity = `${unit.point.stepKey}\u0000${unit.speakerId}`;
    if (seen.has(identity)) repeated.push(unit.key);
    else seen.add(identity);
  }
  return repeated;
}

/** Exact displayed-label repetition only. Historical dimensions never reinterpret the utterance. */
export function repeatedDialogueCandidates(job: PendingNarrativeJob, proposal: PlanProposal): readonly string[] {
  const decision = proposal.decision;
  if (decision?.kind !== "ordinary" || decision.point.stepKey !== "current" || decision.npcId !== job.focusNpcId) return [];
  return decision.options.filter(option => option.publicIntent.text === job.selectedDialogue?.label).map(option => option.candidateId);
}
