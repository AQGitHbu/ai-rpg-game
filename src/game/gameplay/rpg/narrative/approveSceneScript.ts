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
  /** 当前地点尚未取得的物品名称；仅用于阻止叙事提前写入规则结果。 */
  readonly unresolvedItemNames?: readonly string[];
};

const ITEM_CLAIM_VERBS = [
  "拾起", "捡起", "拿起", "拿到", "取得", "取回", "获得", "收进", "收入", "放入", "装入", "带走", "拥有",
  "picked up", "pick up", "obtained", "acquired", "in inventory",
];

function escapesRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 叙事不能凭空替规则动作结算。只检查“当前仍未取得的物品”与占有动词
 * 同句出现，否定句（尚未拾起/没有拿到）保留给编剧描述可用状态。
 */
export function claimsUnresolvedItem(narration: string, itemNames: readonly string[]): boolean {
  return itemNames.some((itemName) => {
    if (itemName.trim() === "") return false;
    const item = escapesRegex(itemName);
    const verbs = ITEM_CLAIM_VERBS.map(escapesRegex).join("|");
    const positive = new RegExp(`(?:${verbs})[^。！？\\n]{0,16}${item}|${item}[^。！？\\n]{0,16}(?:${verbs})`, "i");
    if (!positive.test(narration)) return false;
    const negativeBefore = new RegExp(`(?:未|没有|尚未|还未|还没有|不要|不可|无法|不便)[^。！？\\n]{0,8}(?:${verbs})[^。！？\\n]{0,16}${item}`, "i");
    const negativeAfter = new RegExp(`${item}[^。！？\\n]{0,8}(?:未|没有|尚未|还未|还没有|不要|不可|无法|不便)[^。！？\\n]{0,8}(?:${verbs})`, "i");
    return !negativeBefore.test(narration) && !negativeAfter.test(narration);
  });
}

export function approveSceneScript(
  input: ApproveSceneScriptInput
): NarrativeApprovalResult<ApprovedSceneScript> {
  const { proposal, plan, blueprint } = input;

  // Schema: narration length 1-600 code points
  const narrationLen = codePointLength(proposal.narration);
  if (narrationLen < 1 || narrationLen > 600) {
    return { ok: false, category: "schema_violation" };
  }

  if (claimsUnresolvedItem(proposal.narration, input.unresolvedItemNames ?? [])) {
    return { ok: false, category: "state_prose_mismatch" };
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
