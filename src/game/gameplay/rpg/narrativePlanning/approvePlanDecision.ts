import type { ApprovedPlan } from "./approvePlan";
import type { Check } from "@/game/domain/narrativeUnit";
import { approveDecision } from "./branches";
import { resolveOpeningResponses } from "@/game/gameplay/rpg/openingGeneration";
import { sceneSnapshot } from "./sceneSnapshot";
import { validateAction } from "@/game/gameplay/rpg/ruleEngine";
import { asNpcId, asQuestId, asFactId } from "@/game/domain/worldEntity";

/** 生产骨架的分支审批闸门；不能把只经过 schema/图检查的候选直接发布。 */
export function approvePlanDecision(plan: ApprovedPlan): Check<ApprovedPlan> {
  let decision = plan.choiceExpression;
  if (decision === null || decision.kind === "ending") return { ok: true, value: plan };
  if (plan.proposal.opening !== null) {
    for (const option of decision.options) {
      const name = option.deferredLocation?.name;
      if (name !== undefined && !plan.world.worldFacts.some(fact => fact.discovered && fact.text.includes(name))) {
        return { ok: false, code: "plan_route_name_not_public" };
      }
    }
    const responses = resolveOpeningResponses(plan.proposal.opening);
    if (responses === null) return { ok: false, code: "plan_opening_responses_invalid" };
    const options = decision.options.map(option => {
      const action = responses.find(response => response.candidateId === option.candidateId)?.action;
      return action?.type === "talk" ? { ...option, dialogueAct: action.dialogueAct, topic: action.topic ?? { kind: "general" as const } } : null;
    });
    if (options[0] == null || options[1] == null) return { ok: false, code: "plan_opening_candidate_mismatch" };
    decision = { ...decision, options: [options[0], options[1]] };
  }
  if (decision.options.some(option => option.task !== undefined && option.task.intent !== option.dialogueAct)) {
    return { ok: false, code: "plan_task_intent_mismatch" };
  }
  const snapshot = sceneSnapshot({ plan, point: decision.point });
  if (!snapshot.ok) return snapshot;
  for (const option of decision.options) {
    const topic = option.topic.kind === "quest" ? { kind: "quest" as const, questId: asQuestId(option.topic.questId) }
      : option.topic.kind === "fact" ? { kind: "fact" as const, factId: asFactId(option.topic.factId) }
      : { kind: "general" as const };
    const action = validateAction(snapshot.value.world, {
      type: "talk", npcId: asNpcId(decision.npcId), dialogueAct: option.dialogueAct, topic,
    });
    if (!action.ok) return { ok: false, code: "decision_action_invalid" };
  }
  if (decision.options.every(option => option.target === null && option.deferredLocation === null)) {
    const npc = snapshot.value.world.npcs.find(npc => String(npc.id) === decision.npcId);
    if (npc === undefined || npc.locationId !== snapshot.value.world.currentLocationId) {
      return { ok: false, code: "decision_npc_absent" };
    }
    const [left, right] = decision.options;
    if (left.candidateId === right.candidateId
      || (left.dialogueAct === right.dialogueAct && JSON.stringify(left.topic) === JSON.stringify(right.topic))) {
      return { ok: false, code: "decision_duplicate_intent" };
    }
    return { ok: true, value: { ...plan, choiceExpression: decision } };
  }
  const approved = approveDecision({ decision, world: snapshot.value.world, story: snapshot.value.story });
  if (!approved.ok) return approved;
  return { ok: true, value: { ...plan, choiceExpression: approved.value } };
}
