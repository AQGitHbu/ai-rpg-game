import { NARRATIVE_EMOTIONS, type NarrativeEventKind, type ScenarioBlueprint } from "@/game/domain";
import type {
  ApprovedDirectorPlan,
  ApprovedSceneScript,
  NarrativeApprovalCategory,
  NarrativeApprovalResult,
  NpcInstruction,
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
  /** 编排层依据触发上下文推导的当前原子事件。 */
  readonly eventKind?: NarrativeEventKind;
  readonly eventTargetId?: string;
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

/**
 * 校验单条 NPC 对白指令的公共约束：speechAct/emotion 合法、NPC 存在于蓝图、
 * allowedFactIds 同时为该 NPC 已知事实与本场允许揭示事实的子集。
 * 焦点 NPC 与附加 NPC 共用此校验；通过返回 null，违反返回对应拒绝类别。
 */
function validateNpcInstruction(args: {
  readonly instruction: NpcInstruction;
  readonly blueprint: ScenarioBlueprint;
  readonly sceneAllowedRevealSet: Set<string>;
}): NarrativeApprovalCategory | null {
  if (!VALID_SPEECH_ACTS.has(args.instruction.speechAct)) {
    return "schema_violation";
  }
  if (!VALID_EMOTIONS.has(args.instruction.emotion)) {
    return "schema_violation";
  }
  const npcDef = args.blueprint.npcs.find((n) => String(n.id) === args.instruction.npcId);
  if (npcDef === undefined) {
    return "reference_broken";
  }
  const knownSet = new Set(npcDef.knownFactIds.map((id) => String(id)));
  for (const factId of args.instruction.allowedFactIds) {
    if (!knownSet.has(factId) || !args.sceneAllowedRevealSet.has(factId)) {
      return "knowledge_scope_violation";
    }
  }
  return null;
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

    // 焦点 NPC ID 必须匹配 plan.focusNpcId（plan 声明焦点时）
    if (plan.focusNpcId !== null && npcInst.npcId !== plan.focusNpcId) {
      return { ok: false, category: "reference_broken" };
    }

    const npcRejection = validateNpcInstruction({
      instruction: npcInst,
      blueprint,
      sceneAllowedRevealSet: allowedRevealSet,
    });
    if (npcRejection !== null) {
      return { ok: false, category: npcRejection };
    }
  }

  // Phase 14：附加 NPC 指令校验——与焦点 NPC 共用公共约束（不含焦点匹配）。
  if (proposal.additionalNpcInstructions !== undefined) {
    for (const additionalInst of proposal.additionalNpcInstructions) {
      const additionalRejection = validateNpcInstruction({
        instruction: additionalInst,
        blueprint,
        sceneAllowedRevealSet: allowedRevealSet,
      });
      if (additionalRejection !== null) {
        return { ok: false, category: additionalRejection };
      }
    }
  }

  // Choice validation: dialogue responses are semantic player replies; world
  // choices remain bound to the two rule-approved action candidates.
  if (proposal.choices.length !== 2) {
    return { ok: false, category: "schema_violation" };
  }
  const [choiceA, choiceB] = proposal.choices;
  const isDialogue = input.eventKind === "dialogue" || plan.eventKind === "dialogue";
  const planKeys = new Set(plan.suggestedActionKeys);
  const dynamicEventActionKey = input.eventTargetId !== undefined && input.eventTargetId.startsWith("runtime:")
    ? `${input.eventKind === "item" ? "take_item" : input.eventKind === "battle" ? "start_battle" : "investigate"}:${input.eventTargetId}`
    : undefined;

  if (!isDialogue && (!planKeys.has(choiceA.actionKey) && choiceA.actionKey !== dynamicEventActionKey ||
    !planKeys.has(choiceB.actionKey) && choiceB.actionKey !== dynamicEventActionKey)) {
    return { ok: false, category: "choice_not_legal" };
  }
  if (isDialogue && (choiceA.label === choiceB.label || choiceA.dialogueIntent === choiceB.dialogueIntent)) {
    return { ok: false, category: "schema_violation" };
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
    // Phase 14：透传附加 NPC 指令——未提供时保持 undefined（与类型可选语义一致），
    // 供 collectNpcDialogues 为非焦点 NPC 走重试生成路径。
    additionalNpcInstructions: proposal.additionalNpcInstructions !== undefined
      ? proposal.additionalNpcInstructions.map((inst) => ({
          npcId: inst.npcId,
          speechAct: inst.speechAct,
          emotion: inst.emotion,
          allowedFactIds: [...inst.allowedFactIds],
          mayLie: inst.mayLie,
        }))
      : undefined,
    choices: [
      {
        actionKey: choiceA.actionKey,
        label: choiceA.label,
        strategy: choiceA.strategy,
        ...(choiceA.choiceKind !== undefined ? { choiceKind: choiceA.choiceKind } : {}),
        ...(choiceA.dialogueIntent !== undefined ? { dialogueIntent: choiceA.dialogueIntent } : {}),
      },
      {
        actionKey: choiceB.actionKey,
        label: choiceB.label,
        strategy: choiceB.strategy,
        ...(choiceB.choiceKind !== undefined ? { choiceKind: choiceB.choiceKind } : {}),
        ...(choiceB.dialogueIntent !== undefined ? { dialogueIntent: choiceB.dialogueIntent } : {}),
      },
    ],
  };

  return { ok: true, value: approved };
}
