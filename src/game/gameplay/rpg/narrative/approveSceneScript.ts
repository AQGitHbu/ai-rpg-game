import { NARRATIVE_EMOTIONS, type ScenarioBlueprint } from "@/game/domain";
import type {
  ApprovedDirectorPlan,
  ApprovedSceneScript,
  NarrativeApprovalResult,
  SceneScriptProposal,
} from "./types";

const codePointLength = (value: string) => Array.from(value).length;

const VALID_SPEECH_ACTS = new Set([
  "inform", "ask", "evade", "deny", "warn", "encourage",
]);

const VALID_EMOTIONS = new Set<string>(NARRATIVE_EMOTIONS);

export type { ApprovedSceneScript, SceneScriptProposal };

export type ApproveSceneScriptInput = {
  readonly proposal: SceneScriptProposal;
  readonly plan: ApprovedDirectorPlan;
  readonly blueprint: ScenarioBlueprint;
};

export function approveSceneScript(
  input: ApproveSceneScriptInput
): NarrativeApprovalResult<ApprovedSceneScript> {
  const { proposal, plan, blueprint } = input;

  // Schema: narration length 1-600 code points
  const narrationLen = codePointLength(proposal.narration);
  if (narrationLen < 1 || narrationLen > 600) {
    return { ok: false, category: "schema_violation" };
  }

  // Knowledge: usedFactIds must be subset of plan.allowedRevealFactIds
  const allowedRevealSet = new Set(plan.allowedRevealFactIds);
  for (const factId of proposal.usedFactIds) {
    if (!allowedRevealSet.has(factId)) {
      return { ok: false, category: "knowledge_scope_violation" };
    }
  }

  // NPC instruction checks
  if (proposal.npcInstruction !== null) {
    const npcInst = proposal.npcInstruction;

    // NPC ID must match plan focusNpcId when plan specifies one
    if (plan.focusNpcId !== null && npcInst.npcId !== plan.focusNpcId) {
      return { ok: false, category: "reference_broken" };
    }

    // speechAct must be valid
    if (!VALID_SPEECH_ACTS.has(npcInst.speechAct)) {
      return { ok: false, category: "schema_violation" };
    }

    // emotion must be valid
    if (!VALID_EMOTIONS.has(npcInst.emotion)) {
      return { ok: false, category: "schema_violation" };
    }

    // NPC allowedFactIds must be subset of NPC knownFactIds
    const npcDef = blueprint.npcs.find((n) => String(n.id) === npcInst.npcId);
    if (npcDef === undefined) {
      return { ok: false, category: "reference_broken" };
    }
    const knownSet = new Set(npcDef.knownFactIds.map((id) => String(id)));
    for (const factId of npcInst.allowedFactIds) {
      if (!knownSet.has(factId)) {
        return { ok: false, category: "knowledge_scope_violation" };
      }
    }
  }

  // Choice validation: exactly 2 choices matching plan suggestedActionKeys
  if (proposal.choices.length !== 2) {
    return { ok: false, category: "schema_violation" };
  }
  const [choiceA, choiceB] = proposal.choices;
  const planKeys = new Set(plan.suggestedActionKeys);

  // Both choice actionKeys must be in the plan's approved set
  if (!planKeys.has(choiceA.actionKey) || !planKeys.has(choiceB.actionKey)) {
    return { ok: false, category: "choice_not_legal" };
  }

  // Labels must be 1-40 code points
  if (
    codePointLength(choiceA.label) < 1 || codePointLength(choiceA.label) > 40 ||
    codePointLength(choiceB.label) < 1 || codePointLength(choiceB.label) > 40
  ) {
    return { ok: false, category: "schema_violation" };
  }

  // Strategy must be 1-80 code points
  if (
    codePointLength(choiceA.strategy) < 1 || codePointLength(choiceA.strategy) > 80 ||
    codePointLength(choiceB.strategy) < 1 || codePointLength(choiceB.strategy) > 80
  ) {
    return { ok: false, category: "schema_violation" };
  }

  // Construct approved object field by field
  const approved: ApprovedSceneScript = {
    narration: proposal.narration,
    usedFactIds: [...proposal.usedFactIds],
    npcInstruction: proposal.npcInstruction !== null
      ? {
          npcId: proposal.npcInstruction.npcId,
          speechAct: proposal.npcInstruction.speechAct,
          emotion: proposal.npcInstruction.emotion,
          allowedFactIds: [...proposal.npcInstruction.allowedFactIds],
          mayLie: proposal.npcInstruction.mayLie,
        }
      : null,
    choices: [
      {
        actionKey: choiceA.actionKey,
        label: choiceA.label,
        strategy: choiceA.strategy,
      },
      {
        actionKey: choiceB.actionKey,
        label: choiceB.label,
        strategy: choiceB.strategy,
      },
    ],
  };

  return { ok: true, value: approved };
}
