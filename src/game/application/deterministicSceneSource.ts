import type { EventProposal, SceneSource, SceneSourceResult } from "./sceneSource";
import type { SceneGenerationContext } from "./sceneGenerationContext";
import type { NarrativeEmotion, NarrativeNpcLineState, NarrativeEventState } from "@/game/domain/narrative";
import type { ChoiceProposal } from "@/game/domain/approvedChoice";
import { semanticSummaryOf } from "@/game/domain/approvedChoice";
import type { Action } from "@/game/domain/action";
import { asLocationId, asNpcId } from "@/game/domain/worldEntity";
import type { RelationshipTier } from "@/game/domain/relationship";

// ---------------------------------------------------------------------------
// 确定性 fallback 场景生成器（spec §7.6 安全降级模板）。
// 不调用 AI、不读时钟/随机数：sceneId 从 job 纯函数派生，
// 两次调用同样的 context 产出逐字节相同的提案。
// 选项从当前地点的合法行动中选取（移动、交谈、探索）。
// Task 5：NPC 台词按关系档位政策生成（hostile/trusted 肉眼可辨），
// 且必须应答强制 player_utterance 节拍。
// -----------------------------------------------------------------------------

/** 档位 → 确定性台词（同一档位恒定；不同档位肉眼可辨）。 */
const TIER_LINES: Readonly<Record<RelationshipTier, { readonly text: string; readonly emotion: NarrativeEmotion }>> = {
  hostile: { text: "冷冷地答道：\"这不关你的事。\"", emotion: "angry" },
  cold: { text: "谨慎地答道：\"我不便多说。\"", emotion: "guarded" },
  neutral: { text: "如实答道：\"我知道了。\"", emotion: "neutral" },
  friendly: { text: "热情地说：\"我很乐意帮忙。\"", emotion: "warm" },
  trusted: { text: "坦诚地说：\"正好，我也想告诉你这件事。\"", emotion: "warm" },
};

/** 强制 player_utterance 节拍 ID（无则空数组）。 */
export function answeredUtteranceBeatIds(context: SceneGenerationContext): readonly string[] {
  const beat = (context.mandatoryBeats ?? []).find((b) => b.kind === "player_utterance");
  return beat !== undefined ? [beat.beatId] : [];
}

export function createDeterministicSceneSource(): SceneSource {
  return {
    async generateScene(context: SceneGenerationContext): Promise<SceneSourceResult> {
      const { job } = context;

      const sceneId = `scene-${job.jobId}`;
      const turn = job.turnNumber;

      const narration = buildNarration(context);
      const npcLine = buildNpcLineState(context);
      const event = buildEventState(context);
      const choiceProposals = buildChoiceProposals(context, event);

      return {
        sceneId,
        turn,
        narration,
        npcLine,
        event,
        choiceProposals,
        eventProposals: buildRelationshipEventProposals(context, sceneId),
        source: "fallback",
      };
    },
  };
}

function buildRelationshipEventProposals(
  context: SceneGenerationContext,
  sceneId: string,
): readonly EventProposal[] {
  if (context.job.actionSummary.kind !== "talk") return [];
  const npc = focusNpc(context);
  if (npc === undefined) return [];
  const stance = npc.relationship.affinity >= 10
    ? "friendly"
    : npc.relationship.affinity <= 3
      ? "hostile"
      : null;
  if (stance === null) return [];
  return [{
    id: `${sceneId}-stance-${stance}`,
    kind: "npc_changes_stance",
    involvedEntityIds: [String(npc.id)],
    prerequisiteFactIds: [],
    proposedEffects: [{ kind: "npc_changes_stance", npcId: npc.id, stance }],
    intendedPacing: context.story.nextPacingNeed,
    reason: "关键 NPC 的规则关系已形成明确立场",
    proposedAtTurn: context.job.turnNumber,
    expiresAtTurn: context.job.turnNumber + 5,
  }];
}

/** 焦点 NPC：talk job 优先使用 job.focusNpcId，否则第一个在场 NPC。 */
function focusNpc(context: SceneGenerationContext): SceneGenerationContext["presentNpcs"][number] | undefined {
  const { job, presentNpcs } = context;
  const talkTarget = job.actionSummary.kind === "talk" ? job.focusNpcId : undefined;
  if (talkTarget !== undefined) {
    const match = presentNpcs.find((n) => String(n.id) === String(talkTarget));
    if (match !== undefined) return match;
  }
  return presentNpcs[0];
}

/** 玩家原话以中性口吻回显（不加工、不评判）；无原话则不适用。 */
function buildNarration(context: SceneGenerationContext): string {
  const { job, currentLocation } = context;
  const { resolvedEvent } = job;
  const locName = currentLocation.name;
  const npc = focusNpc(context);

  const isTalk = job.actionSummary.kind === "talk";
  if (isTalk && job.utterance !== undefined && npc !== undefined) {
    return `你对${npc.name}说："${job.utterance}"。${npc.name}听完，注视着你的眼睛。`;
  }

  switch (resolvedEvent.eventKind) {
    case "travel":
      return `你来到了${locName}。四周的景象映入眼帘，空气中弥漫着不同的气息。`;
    case "dialogue":
      return npc !== undefined
        ? `你与${npc.name}交谈。${npc.name}注视着你，似乎有话要说。`
        : `你在${locName}四处张望，却没看到可以交谈的人。`;
    case "investigate":
      return `你仔细调查了周围的线索，发现了一些值得注意的细节。`;
    case "item":
      return `你获得了某件物品，它或许在旅途中派上用场。`;
    case "battle":
      return resolvedEvent.status === "success"
        ? `战斗结束，你取得了胜利。`
        : `战斗的余波仍在空气中回荡。`;
    default:
      return `你身处${locName}，周围的一切静待探索。`;
  }
}

function buildNpcLineState(context: SceneGenerationContext): NarrativeNpcLineState | null {
  const { job } = context;
  const { resolvedEvent } = job;
  const npc = focusNpc(context);
  if (npc === undefined) return null;

  const policy = context.focusNpcContext?.responsePolicy;
  // Task 5：有焦点 NPC 政策时按档位出台词（同一行动，hostile/trusted 肉眼可辨）；
  // 无政策（纯 fallback 夹具）保持既有状态文案。
  const tierLine = policy !== undefined ? TIER_LINES[policy.tier] : null;
  const text = tierLine !== null
    ? `${npc.name}${tierLine.text}`
    : buildStatusLine(npc.name, resolvedEvent);
  const emotion = tierLine !== null ? tierLine.emotion : "neutral";

  return {
    npcId: npc.id,
    text,
    emotion,
    usedFactIds: [],
    answeredBeatIds: answeredUtteranceBeatIds(context),
  };
}

function buildStatusLine(npcName: string, resolvedEvent: SceneGenerationContext["job"]["resolvedEvent"]): string {
  switch (resolvedEvent.status) {
    case "success":
      return `${npcName}说道："欢迎，有什么需要帮忙的吗？"`;
    case "partial_success":
      return `${npcName}犹豫了一下："这件事……我知道一些，但不方便全说。"`;
    case "failure":
      return `${npcName}摇了摇头："恐怕这件事我帮不上忙。"`;
    case "blocked":
      return `${npcName}摇了摇头："现在还不是做这件事的时候。"`;
    default:
      return `${npcName}看了你一眼，没有说话。`;
  }
}

/** 事件状态由 job 的真实 eventKind 派生：travel→travel，talk→dialogue 焦点 NPC，investigate→首条事实。 */
export function buildEventState(context: SceneGenerationContext): NarrativeEventState {
  const { job, currentLocation } = context;
  switch (job.resolvedEvent.eventKind) {
    case "travel":
      return { kind: "travel", locationId: currentLocation.id };
    case "dialogue": {
      const focus = focusNpc(context);
      return focus !== undefined
        ? { kind: "dialogue", focusNpcId: focus.id }
        : { kind: "observe", locationId: currentLocation.id };
    }
    case "investigate": {
      const factChange = job.resolvedEvent.facts[0];
      return factChange !== undefined
        ? { kind: "investigate", factId: factChange.factId }
        : { kind: "observe", locationId: currentLocation.id };
    }
    default:
      return { kind: "observe", locationId: currentLocation.id };
  }
}

export function buildChoiceProposals(
  context: SceneGenerationContext,
  event: NarrativeEventState,
): readonly [ChoiceProposal, ChoiceProposal] {
  if (event.kind === "dialogue") {
    const npc = context.presentNpcs.find((entry) => entry.id === event.focusNpcId);
    if (npc === undefined) throw new Error("dialogue fallback requires a present focus NPC");
    return [
      { label: `表示愿意支持${npc.name}`, action: { type: "talk", npcId: npc.id, dialogueAct: "support" } },
      { label: `质疑${npc.name}的说法`, action: { type: "talk", npcId: npc.id, dialogueAct: "challenge" } },
    ];
  }

  const distinct: ChoiceProposal[] = [];
  const seen = new Set<string>();
  for (const candidate of context.legalActionCandidates) {
    const action = actionFromLegalCandidate(candidate);
    if (action === null) continue;
    const key = semanticSummaryOf(action);
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push({ label: candidate.label, action });
    if (distinct.length === 2) break;
  }
  if (distinct.length !== 2) throw new Error("non-dialogue fallback requires two legal action candidates");
  return [distinct[0]!, distinct[1]!];
}

export function actionFromLegalCandidate(
  candidate: SceneGenerationContext["legalActionCandidates"][number],
): Action | null {
  switch (candidate.kind) {
    case "explore": return { type: "explore" };
    case "move": return candidate.targetId === undefined
      ? null
      : { type: "move", locationId: asLocationId(candidate.targetId) };
    case "talk": return candidate.targetId === undefined
      ? null
      : { type: "talk", npcId: asNpcId(candidate.targetId), dialogueAct: "ask" };
    case "battle_action": return candidate.targetId === "attack"
      || candidate.targetId === "guard"
      || candidate.targetId === "flee"
      ? { type: "battle_action", action: candidate.targetId }
      : null;
  }
}
