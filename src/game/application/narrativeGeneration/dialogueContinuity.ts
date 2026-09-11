import type { ExpressionTask } from "@/game/domain/expressionTask";
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

/** 只比较同 NPC 当前场景的已编码问题，不从旧 label 猜意图。换 act 或附加新问题不消除重复。 */
export function repeatedDialogueCandidates(job: PendingNarrativeJob, proposal: PlanProposal): readonly string[] {
  const previous = job.selectedDialogue?.task;
  const decision = proposal.decision;
  if (previous === undefined || decision?.kind !== "ordinary"
    || decision.point.stepKey !== "current" || decision.npcId !== job.focusNpcId
    || (previous.intent !== "ask" && previous.intent !== "challenge")) return [];
  const covered = (next: ExpressionTask) => (next.intent === "ask" || next.intent === "challenge")
    && ((next.inquiries ?? []).some(inquiry => inquiry.aspects.some(aspect =>
      previous.inquiries?.some(asked => asked.factId === inquiry.factId && asked.aspects.includes(aspect))))
      || next.focusFactIds.some(id => previous.inquiries?.some(asked => asked.factId === id)
        && !next.inquiries?.some(inquiry => inquiry.factId === id)));
  return decision.options.filter(option => option.task !== undefined && covered(option.task)).map(option => option.candidateId);
}

/** 有结构化提问的新任务逐维度规划回应；无 task 的旧 fixture 继续兼容。 */
export function plannedReplyRejection(job: PendingNarrativeJob, proposal: PlanProposal): string | null {
  const questions = job.selectedDialogue?.task?.inquiries ?? [];
  const replies = proposal.units.filter(unit => unit.stage === "character"
    && unit.point.stepKey === "current" && unit.speakerId === job.focusNpcId);
  const answers = replies.flatMap(unit => unit.task?.answers ?? []);
  if (proposal.units.some(unit => (unit.task?.answers?.length ?? 0) > 0 && !replies.includes(unit))
    || proposal.decision?.options.some(option => "task" in option && (option.task?.answers?.length ?? 0) > 0)
    || answers.some(answer => !questions.some(question => question.factId === answer.factId
      && question.aspects.includes(answer.aspect)))) return "plan_reply_question_mismatch";
  if (replies.some(unit => unit.task !== undefined) && questions.some(question => question.aspects.some(aspect =>
    answers.filter(answer => answer.factId === question.factId && answer.aspect === aspect).length !== 1)))
    return "plan_reply_missing";
  return null;
}
