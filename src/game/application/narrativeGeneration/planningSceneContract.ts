import type { BundleDescriptorGraph } from "@/game/gameplay/rpg/narrativeBundle";

/** 只投影规则图的场景绑定；当前回应对象不等于下一个决策对象。 */
export function planningSceneContract(graph: BundleDescriptorGraph, currentResponseNpcId: string | null) {
  const target = graph.terminal.kind === "next_decision" ? graph.terminal.target : null;
  const decisionPoint = target?.kind === "continuation_step" ? target.stepKey : "current";
  const decisionStep = graph.steps.find(step => step.stepKey === decisionPoint);
  const candidates = target === null ? [] : decisionPoint === "current"
    ? graph.currentChoiceCandidates : decisionStep?.choiceCandidates ?? [];
  const action = candidates[0]?.action;
  return {
    graphStatus: "approved" as const,
    steps: graph.steps.map(step => ({ key: step.stepKey, trigger: step.trigger, next: step.nextStepKeys })),
    terminal: graph.terminal,
    requiredScenes: ["current", ...graph.steps.map(step => step.stepKey)],
    decisionPoint,
    decisionNpcId: action?.type === "talk" ? String(action.npcId) : null,
    candidateIds: candidates.map(candidate => candidate.candidateId),
    scenes: [
      { stepKey: "current", responseNpcId: currentResponseNpcId, allowsChoices: decisionPoint === "current" },
      ...graph.steps.map(step => ({ stepKey: step.stepKey,
        responseNpcId: step.arrivalNpc?.id ?? null, allowsChoices: step.stepKey === decisionPoint })),
    ],
  };
}
