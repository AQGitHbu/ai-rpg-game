import type { SceneSource, SceneSourceResult, ScenePerformanceSegment, ScenePerformanceProposal } from "./sceneSource";
import type { SceneGenerationContext } from "./sceneGenerationContext";
import type { NarrativeEmotion, NarrativeNpcLineState, NarrativeEventState } from "@/game/domain/narrative";
import type { Action } from "@/game/domain/action";
import { semanticSummaryOf } from "@/game/domain/approvedChoice";
import { asLocationId, asNpcId } from "@/game/domain/worldEntity";
import type { RelationshipTier } from "@/game/domain/relationship";
import { ATMOSPHERE_BEAT_ID } from "@/game/domain/narrativeBeat";

// ---------------------------------------------------------------------------
// 确定性 fallback 场景表演生成器（spec §7.6 安全降级模板）。
// 不调用 AI、不读时钟/随机数：sceneId 从 job 纯函数派生，
// 两次调用同样的 context 产出逐字节相同的提案。
// Task 6：产出与 approveScenePerformance 同一契约的表演提案（segments/
// npcLine/objectiveLink/choices），必须能通过同一审批——因此所有引用
// （节拍 ID、NPC 台词、目标链接、合法选项）都从服务端权威上下文派生。
// ---------------------------------------------------------------------------

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

/** 场景表演的合法选项候选（服务端权威）：审批、确定性源、live 提示词共用。 */
export type SceneChoiceCandidate = {
  readonly candidateId: string;
  readonly label: string;
  readonly action: Action;
};

/** 判断某行动是否推进/接近/搜集当前目标（objectiveTarget.entityId）。 */
export function actionTargetsObjective(action: Action, entityId: string): boolean {
  switch (action.type) {
    case "move": return String(action.locationId) === entityId;
    case "talk": return String(action.npcId) === entityId;
    case "take_item": return String(action.itemId) === entityId;
    case "investigate": return String(action.factId) === entityId;
    case "attack": return String(action.enemyId) === entityId;
    default: return false;
  }
}

/**
 * 从上下文投影服务端权威的可选候选（candidateId 与 approval 使用同一集合）：
 * - dialogue 事件 → 焦点 NPC 的固定 support/challenge 两选项；
 * - 其余事件 → legalActionCandidates 去重映射（candidate_1..N）。
 */
export function buildSelectableSceneCandidates(context: SceneGenerationContext): readonly SceneChoiceCandidate[] {
  const event = buildEventState(context);
  if (event.kind === "dialogue") {
    const npc = context.presentNpcs.find((entry) => String(entry.id) === String(event.focusNpcId));
    if (npc === undefined) return [];
    return [
      { candidateId: "candidate_1", label: `表示愿意支持${npc.name}`, action: { type: "talk", npcId: npc.id, dialogueAct: "support" } },
      { candidateId: "candidate_2", label: `质疑${npc.name}的说法`, action: { type: "talk", npcId: npc.id, dialogueAct: "challenge" } },
    ];
  }
  const candidates: SceneChoiceCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of context.legalActionCandidates) {
    const action = actionFromLegalCandidate(candidate);
    if (action === null) continue;
    const key = semanticSummaryOf(action);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ candidateId: `candidate_${candidates.length + 1}`, label: candidate.label, action });
  }
  return candidates;
}

export function createDeterministicSceneSource(): SceneSource {
  return {
    async generateScene(context: SceneGenerationContext): Promise<SceneSourceResult> {
      const sceneId = `scene-${context.job.jobId}`;
      return {
        sceneId,
        segments: buildSegments(context),
        npcLine: buildNpcLineState(context),
        objectiveLink: buildObjectiveLink(context),
        choices: buildSceneChoices(context),
        source: "fallback",
      };
    },
  };
}

/** 一段节拍对应一个 segment（强制节拍顺序即上下文顺序；atmosphere 可选放最后）。 */
function buildSegments(context: SceneGenerationContext): readonly ScenePerformanceSegment[] {
  const { job } = context;
  const npc = focusNpc(context);
  const segments: ScenePerformanceSegment[] = [];
  for (const beat of context.mandatoryBeats) {
    if (beat.beatId === ATMOSPHERE_BEAT_ID) {
      segments.push({ beatId: beat.beatId, text: buildAtmosphere(context) });
    } else if (beat.kind === "player_utterance") {
      const utterance = job.utterance?.trim() ?? "";
      segments.push({
        beatId: beat.beatId,
        text: npc !== undefined && utterance !== ""
          ? `你对${npc.name}说："${utterance}"。${npc.name}听完，注视着你的眼睛。`
          : "你向对方提出了你的疑问。",
      });
    } else if (beat.kind === "quest_advanced" && context.objectiveTarget !== null) {
      // 幕边界：turn 时刻的下一个目标尚未具象化，节拍指令里没有实体名；
      // 场景装配的预览状态已具象化，此处用权威 objectiveTarget 点名，
      // 保证确定性 fallback 也能通过 quest_advanced_unnamed 审批。
      segments.push({
        beatId: beat.beatId,
        text: `主线推进。当前目标：${context.objectiveTarget.entityName}（${context.objectiveTransition.after?.label ?? "新的线索"}）`,
      });
    } else {
      segments.push({ beatId: beat.beatId, text: beat.instruction });
    }
  }
  // 服务端恒带 atmosphere 节拍；纯测试夹具无强制节拍时仍保底一段氛围。
  if (segments.length === 0) {
    segments.push({ beatId: ATMOSPHERE_BEAT_ID, text: buildAtmosphere(context) });
  }
  return segments;
}

/** 氛围描写：当前地点的最小安全文本（纯函数）。 */
function buildAtmosphere(context: SceneGenerationContext): string {
  const { currentLocation } = context;
  return `你身处${currentLocation.name}，${currentLocation.description}`;
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

function buildNpcLineState(context: SceneGenerationContext): ScenePerformanceProposal["npcLine"] {
  const { job } = context;
  const npc = focusNpc(context);
  if (npc === undefined) return null;

  const policy = context.focusNpcContext?.responsePolicy;
  // Task 5：有焦点 NPC 政策时按档位出台词（同一行动，hostile/trusted 肉眼可辨）；
  // 无政策（纯 fallback 夹具）保持既有状态文案。
  const tierLine = policy !== undefined ? TIER_LINES[policy.tier] : null;
  const text = tierLine !== null
    ? `${npc.name}${tierLine.text}`
    : buildStatusLine(npc.name, job.resolvedEvent);
  const emotion = tierLine !== null ? tierLine.emotion : "neutral";

  return {
    npcId: String(npc.id),
    text,
    emotion,
    usedFactIds: [],
    usedInteractionActionIds: [],
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

/** 目标链接：与 objectiveTransition.after 精确一致；无 after 时为 null。 */
function buildObjectiveLink(context: SceneGenerationContext): ScenePerformanceProposal["objectiveLink"] {
  const after = context.objectiveTransition.after;
  if (after === null) return null;
  const mode = context.objectiveTransition.mode === "advanced_act"
    ? "handoff"
    : context.objectiveTransition.mode === "progressed"
      ? "progress"
      : "hint";
  return { questId: String(after.questId), objectiveIndex: after.objectiveIndex, mode };
}

/** 两个不同的合法选项：优先选择推进当前目标的行动，再保底任意合法候选。 */
export function buildSceneChoices(context: SceneGenerationContext): ScenePerformanceProposal["choices"] {
  const selectable = buildSelectableSceneCandidates(context);
  if (selectable.length < 2) {
    throw new Error("scene fallback requires at least two legal action candidates");
  }
  const targetEntityId = context.objectiveTarget?.entityId;
  const ordered = [...selectable].sort((a, b) => {
    const aScore = targetEntityId !== undefined && actionTargetsObjective(a.action, targetEntityId) ? 1 : 0;
    const bScore = targetEntityId !== undefined && actionTargetsObjective(b.action, targetEntityId) ? 1 : 0;
    return bScore - aScore;
  });
  const distinct: SceneChoiceCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of ordered) {
    const key = semanticSummaryOf(candidate.action);
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push(candidate);
    if (distinct.length === 2) break;
  }
  if (distinct.length !== 2) {
    throw new Error("scene fallback requires two distinct legal action candidates");
  }
  return [
    { candidateId: distinct[0]!.candidateId, label: distinct[0]!.label },
    { candidateId: distinct[1]!.candidateId, label: distinct[1]!.label },
  ];
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
