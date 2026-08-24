import type { Action, DialogueTopic } from "@/game/domain/action";
import { semanticSummaryOf } from "@/game/domain/approvedChoice";
import { asEnemyId, asFactId, asLocationId, asNpcId, asQuestId } from "@/game/domain/worldEntity";
import type { NarrativeEventState } from "@/game/domain/narrative";
import type { PreparedStepDescriptor } from "@/game/gameplay/rpg/preparedContinuation";
import type { SceneGenerationContext } from "./sceneGenerationContext";

/** 服务端权威的场景选项候选；live source 与显式 fixture 共用这份投影。 */
export type SceneChoiceCandidate = {
  readonly candidateId: string;
  readonly label: string;
  readonly action: Action;
};

export type CurrentNpcLineContext = {
  readonly text: string;
  readonly usedFactIds?: readonly string[];
};

type FactCardLike = { readonly factId: string; readonly text: string };

/**
 * Adapts server-authored prepared choices without renumbering their opaque
 * candidate IDs. Labels are only a read-model concern; actions and IDs remain
 * owned by the gameplay projection.
 */
export function buildPreparedSceneCandidates(
  descriptor: Pick<PreparedStepDescriptor, "choiceCandidates">,
): readonly SceneChoiceCandidate[] {
  return descriptor.choiceCandidates.map((candidate) => ({
    candidateId: candidate.candidateId,
    label: preparedChoiceLabel(candidate.action),
    action: candidate.action,
  }));
}

function preparedChoiceLabel(action: Action): string {
  if (action.type !== "talk") return formatSceneChoiceLabel(action, "继续行动");
  switch (action.dialogueAct) {
    case "support": return "表示支持，继续听对方说明";
    case "challenge": return "提出质疑，要求对方拿出依据";
    default: return "继续询问对方";
  }
}

export function usesFallbackDialogueChoiceLabels(
  selectable: readonly SceneChoiceCandidate[],
  choices: readonly { readonly candidateId: string; readonly label: string }[],
): boolean {
  if (selectable.length < 2 || choices.length !== 2) return false;
  const selectableById = new Map(selectable.map((candidate) => [candidate.candidateId, candidate]));
  return choices.every((choice) => {
    const candidate = selectableById.get(String(choice.candidateId));
    return candidate !== undefined
      && candidate.action.type === "talk"
      && compactChoiceLabel(choice.label) === compactChoiceLabel(candidate.label);
  });
}

function compactChoiceLabel(label: string): string {
  return label.replace(/[\s“”"「」『』。！？!?，,；;：:、（）()]/gu, "");
}

export function buildSelectableSceneCandidates(
  context: SceneGenerationContext,
  currentNpcLine?: string | CurrentNpcLineContext,
): readonly SceneChoiceCandidate[] {
  const event = buildEventState(context);
  if (context.objectiveTransition.mode === "ready_for_ending") {
    const npc = focusNpc(context);
    if (npc === undefined) return [];
    return [
      {
        candidateId: "candidate_1",
        label: "我愿意和你一起把证据摊开，让该承担的人面对真相。",
        action: { type: "talk", npcId: npc.id, dialogueAct: "support", topic: dialogueTopicFor(context, false) },
      },
      {
        candidateId: "candidate_2",
        label: "我会核对每一份证据，在确认之前不会把结论交给任何人。",
        action: { type: "talk", npcId: npc.id, dialogueAct: "challenge", topic: dialogueTopicFor(context, true) },
      },
    ];
  }
  const objectiveNpc = context.objectiveTarget !== null
    ? context.presentNpcs.find((entry) => String(entry.id) === context.objectiveTarget?.entityId)
    : undefined;
  const focusedObjectiveNpc = objectiveNpc !== undefined
    && context.focusNpcContext !== undefined
    && String(context.focusNpcContext.id) === String(objectiveNpc.id)
    ? objectiveNpc
    : undefined;
  const dialogueNpcId = event.kind === "dialogue" ? event.focusNpcId : focusedObjectiveNpc?.id;
  if (dialogueNpcId !== undefined) {
    const npc = context.presentNpcs.find((entry) => String(entry.id) === String(dialogueNpcId));
    if (npc === undefined) return [];
    const dialogueLabels = dialogueChoiceLabels(context, npc, currentNpcLine);
    const dialogueCandidate: SceneChoiceCandidate = {
      candidateId: "candidate_1",
      label: dialogueLabels.support,
      action: { type: "talk", npcId: npc.id, dialogueAct: "support", topic: dialogueTopicFor(context, false) },
    };
    if (event.kind === "dialogue" || focusedObjectiveNpc !== undefined) {
      return [
        dialogueCandidate,
        {
          candidateId: "candidate_2",
          label: dialogueLabels.challenge,
          action: { type: "talk", npcId: npc.id, dialogueAct: "challenge", topic: dialogueTopicFor(context, true) },
        },
      ];
    }
    const nonDialogueCandidate = context.legalActionCandidates
      .map((candidate) => ({ candidate, action: actionFromLegalCandidate(candidate) }))
      .filter((entry): entry is { candidate: SceneGenerationContext["legalActionCandidates"][number]; action: Action } =>
        entry.action !== null && entry.action.type !== "talk")
      .map(({ candidate, action }): SceneChoiceCandidate => ({
        candidateId: "candidate_2",
        label: nonDialogueChoiceLabel(action, candidate.label),
        action,
      }))[0];
    return [
      dialogueCandidate,
      nonDialogueCandidate ?? {
        candidateId: "candidate_2",
        label: nonDialogueChoiceLabel({ type: "explore" }),
        action: { type: "explore" },
      },
    ];
  }
  const candidates: SceneChoiceCandidate[] = [];
  const investigationFactId = context.objectiveTarget?.entityId;
  if (investigationFactId !== undefined && context.currentInvestigationApproaches !== undefined) {
    for (const approach of context.currentInvestigationApproaches) {
      const action: Action = {
        type: "investigate",
        factId: asFactId(investigationFactId),
        approachId: approach.approachId,
      };
      candidates.push({
        candidateId: `candidate_${candidates.length + 1}`,
        label: formatSceneChoiceLabel(action, approach.label),
        action,
      });
    }
  }
  const seen = new Set<string>();
  for (const candidate of context.legalActionCandidates) {
    const action = actionFromLegalCandidate(candidate);
    if (action === null) continue;
    const key = semanticSummaryOf(action);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      candidateId: `candidate_${candidates.length + 1}`,
      label: action.type === "attack"
        ? nonDialogueChoiceLabel(action, candidate.label)
        : formatSceneChoiceLabel(action, candidate.label),
      action,
    });
  }
  return candidates;
}

function focusNpc(context: SceneGenerationContext): SceneGenerationContext["presentNpcs"][number] | undefined {
  if (context.focusNpcContext !== undefined) {
    const contextFocus = context.presentNpcs.find((n) => String(n.id) === String(context.focusNpcContext?.id));
    if (contextFocus !== undefined) return contextFocus;
  }
  const talkTarget = context.job.actionSummary.kind === "talk" ? context.job.focusNpcId : undefined;
  if (talkTarget !== undefined) {
    const match = context.presentNpcs.find((n) => String(n.id) === String(talkTarget));
    if (match !== undefined) return match;
  }
  return context.presentNpcs[0];
}

type DialogueChoiceLabels = { readonly support: string; readonly challenge: string };

function dialogueChoiceLabels(
  context: SceneGenerationContext,
  npc: SceneGenerationContext["presentNpcs"][number],
  currentNpcLine?: string | CurrentNpcLineContext,
): DialogueChoiceLabels {
  const lineContext = typeof currentNpcLine === "string"
    ? { text: currentNpcLine, usedFactIds: [] as readonly string[] }
    : currentNpcLine;
  const focusFacts = context.focusNpcContext?.speakableFactCards ?? [];
  const sceneFacts = [...context.sceneVisibleFacts, ...context.publicWorldFacts];
  const factsById = new Map<string, FactCardLike>();
  for (const fact of [...focusFacts, ...sceneFacts]) factsById.set(String(fact.factId), fact);
  const referencedFacts = lineContext?.usedFactIds
    ?.map((factId) => factsById.get(String(factId)))
    .filter((fact): fact is FactCardLike => fact !== undefined) ?? [];
  const groundingFacts = referencedFacts.length > 0 ? referencedFacts : focusFacts;
  const hasGrounding = groundingFacts.length > 0;
  const hasQuest = context.story.activeQuest !== undefined;
  const previousAct = context.previousDialogue?.selectedChoice?.dialogueAct;
  const hasCurrentLineGrounding = lineContext !== undefined && referencedFacts.length > 0;
  if (previousAct === "challenge" && !hasCurrentLineGrounding) {
    return {
      support: "你先逐点回应刚才的疑问，再把能核对的下一步说清楚。",
      challenge: "刚才的疑点还没有解开；请指出一件能让我们当场核对的证物。",
    };
  }
  if (previousAct === "support" && !hasCurrentLineGrounding) {
    return {
      support: "既然你愿意继续说，就把下一步和能够核对的凭据交代清楚。",
      challenge: "我可以继续听，但每个判断都要有能落到实处的证物支撑。",
    };
  }
  if (hasGrounding) {
    const variants: readonly DialogueChoiceLabels[] = [
      {
        support: "请把你刚才提到的这条线索的来历、时间和地点说清楚，我好按眼前的主线核对。",
        challenge: "这条线索还不能直接下结论；哪一件原始证物能把它和眼前的主线联系起来？",
      },
      {
        support: "请把这条线索落到可核对的事实，再沿眼前的主线查下去。",
        challenge: "这条线索还不能下结论；请指出一件能当场核对的原始证物。",
      },
    ];
    return variants[dialogueChoiceVariantIndex(context, npc, variants.length)] ?? variants[0]!;
  }
  if (hasQuest) {
    return {
      support: "先把眼前主线下一步要核对的人、地点或物证说清楚，我就按它查下去。",
      challenge: "眼前的主线还不能只凭传闻下结论；哪一件原件能证明你的说法？",
    };
  }
  const variants: readonly DialogueChoiceLabels[] = [
    {
      support: "请把这件事的来历和下一步说清楚，我按能核对的线索查下去。",
      challenge: "这还不足以下结论；请指出一件能当场核对的原件或证物。",
    },
    {
      support: "先交代清楚你掌握的事实，以及我接下来该去核对什么。",
      challenge: "我不会只凭一句话判断；什么证据能证明你的说法？",
    },
  ];
  return variants[dialogueChoiceVariantIndex(context, npc, variants.length)] ?? variants[0]!;
}

function dialogueTopicFor(context: SceneGenerationContext, secondary: boolean): DialogueTopic {
  if (!secondary) return { kind: "general" };
  const threadId = context.story.unresolvedThreadSummaries[0];
  if (threadId !== undefined && threadId.trim() !== "") return { kind: "thread", threadId };
  const questId = context.objectiveTransition.after?.questId;
  if (questId !== undefined) return { kind: "quest", questId: asQuestId(String(questId)) };
  return { kind: "general" };
}

function dialogueChoiceVariantIndex(
  context: SceneGenerationContext,
  npc: SceneGenerationContext["presentNpcs"][number],
  variantCount: number,
): number {
  if (variantCount <= 1) return 0;
  const recentInteractions = context.focusNpcContext?.recentInteractions ?? [];
  if (context.generationSeed === undefined && recentInteractions.length === 0) return 0;
  const seed = [
    context.generationSeed ?? "",
    String(npc.id),
    npc.name,
    npc.role,
    String(context.currentLocation.id),
    context.objectiveTarget?.entityId ?? "",
    context.job.actionSummary.kind,
    String(context.story.currentAct),
    context.story.nextPacingNeed,
  ].join("|");
  let hash = 2_166_136_261;
  for (const character of seed) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  const sequenceOffset = context.job.turnNumber + recentInteractions.length;
  return (hash % variantCount + sequenceOffset) % variantCount;
}

function buildEventState(context: SceneGenerationContext): NarrativeEventState {
  if (context.objectiveTransition.mode === "advanced_act") {
    return { kind: "observe", locationId: context.currentLocation.id };
  }
  switch (context.job.resolvedEvent.eventKind) {
    case "travel": return { kind: "travel", locationId: context.currentLocation.id };
    case "dialogue": {
      const focus = focusNpc(context);
      if (focus === undefined) return { kind: "observe", locationId: context.currentLocation.id };
      const objectiveNpc = context.objectiveTarget === null
        ? undefined
        : context.presentNpcs.find((npc) => String(npc.id) === context.objectiveTarget?.entityId);
      const latestDialogueAct = context.focusNpcContext?.recentInteractions.at(-1)?.dialogueAct;
      if (objectiveNpc !== undefined
        && String(objectiveNpc.id) !== String(focus.id)
        && latestDialogueAct !== "ask") {
        return { kind: "observe", locationId: context.currentLocation.id };
      }
      return { kind: "dialogue", focusNpcId: focus.id };
    }
    case "investigate": {
      const factChange = context.job.resolvedEvent.facts[0];
      return factChange !== undefined
        ? { kind: "investigate", factId: factChange.factId }
        : { kind: "observe", locationId: context.currentLocation.id };
    }
    default: return { kind: "observe", locationId: context.currentLocation.id };
  }
}

function actionFromLegalCandidate(
  candidate: SceneGenerationContext["legalActionCandidates"][number],
): Action | null {
  switch (candidate.kind) {
    case "explore": return { type: "explore" };
    case "move": return candidate.targetId === undefined ? null : { type: "move", locationId: asLocationId(candidate.targetId) };
    case "talk": return candidate.targetId === undefined ? null : { type: "talk", npcId: asNpcId(candidate.targetId), dialogueAct: "ask" };
    case "attack": return candidate.targetId === undefined ? null : { type: "attack", enemyId: asEnemyId(candidate.targetId) };
    case "battle_action": return candidate.targetId === "attack" || candidate.targetId === "guard" || candidate.targetId === "flee"
      ? { type: "battle_action", action: candidate.targetId }
      : null;
  }
}

function nonDialogueChoiceLabel(action: Action, sourceLabel?: string): string {
  const label = (() => {
    switch (action.type) {
      case "explore": return "默默不作声，先观察四周";
      case "move": return "不再追问，离开这里";
      case "take_item": return "暂不回应，先拾取眼前物品";
      case "investigate": return "暂不回应，先调查现场";
      case "attack": return `（拔出兵器，向${sourceLabel?.replace(/^挑战/u, "").trim() || "眼前的敌人"}发起攻击）`;
      case "battle_action": return "暂不回应，先做好应战准备";
      default: return "暂不回应，先做自己的事";
    }
  })();
  return formatSceneChoiceLabel(action, label);
}

export function formatSceneChoiceLabel(action: Action, label: string): string {
  const trimmed = label.trim();
  if (action.type === "talk") return stripDialoguePrefix(trimmed);
  if (/^（.*）$/u.test(trimmed)) return trimmed;
  // AI 偶尔会把动作写成“（动作）随后说出的对白”。不要再给整句套一层
  // 括号，避免玩家看到“（（动作）对白）”这种伪舞台说明；把两部分合并成
  // 一个可执行的玩家回应/动作选项。
  const leadingWrapper = trimmed.match(/^（([^（）]*)）(.+)$/u);
  if (leadingWrapper !== null) {
    return `（${leadingWrapper[1]}；${leadingWrapper[2]!.trim()}）`;
  }
  const withoutAsciiWrapper = trimmed.match(/^\((.*)\)$/u)?.[1]?.trim() ?? trimmed;
  return `（${withoutAsciiWrapper}）`;
}

function stripDialoguePrefix(label: string): string {
  const withoutPrefix = label.replace(/^(?:回应|追问|质疑|询问)[^：:]{0,24}[：:]\s*/u, "").trim();
  if ((withoutPrefix.startsWith("“") && withoutPrefix.endsWith("”"))
    || (withoutPrefix.startsWith("\"") && withoutPrefix.endsWith("\""))) {
    return withoutPrefix.slice(1, -1).trim();
  }
  return withoutPrefix;
}
