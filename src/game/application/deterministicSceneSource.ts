import type { SceneSource, SceneSourceResult, ScenePerformanceSegment, ScenePerformanceProposal } from "./sceneSource";
import type { SceneGenerationContext } from "./sceneGenerationContext";
import type { NarrativeEmotion, NarrativeEventState } from "@/game/domain/narrative";
import type { Action } from "@/game/domain/action";
import { semanticSummaryOf } from "@/game/domain/approvedChoice";
import { asLocationId, asNpcId } from "@/game/domain/worldEntity";
import type { RelationshipTier } from "@/game/domain/relationship";
import { ATMOSPHERE_BEAT_ID } from "@/game/domain/narrativeBeat";
import { composeDirectNpcGreeting, normalizeNpcSpeech } from "@/game/domain/npcSpeech";

// ---------------------------------------------------------------------------
// 确定性 fallback 场景表演生成器（spec §7.6 安全降级模板）。
// 不调用 AI、不读时钟/随机数：sceneId 从 job 纯函数派生，
// 两次调用同样的 context 产出逐字节相同的提案。
// Task 6：产出与 approveScenePerformance 同一契约的表演提案（segments/
// npcLine/objectiveLink/choices），必须能通过同一审批——因此所有引用
// （节拍 ID、NPC 台词、目标链接、合法选项）都从服务端权威上下文派生。
// ---------------------------------------------------------------------------

/** 关系档位只决定回应政策；具体台词还必须读取本轮情境。 */
const TIER_EMOTIONS: Readonly<Record<RelationshipTier, NarrativeEmotion>> = {
  hostile: "angry",
  cold: "guarded",
  neutral: "neutral",
  friendly: "warm",
  trusted: "warm",
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
  // ready scene 已经把当前主线目标 NPC 编排到当前地点。这个场景的真实
  // event 可以仍然是 travel/observe（用于表达“抵达/新线索出现”），但玩家
  // 进入目标 NPC 后需要直接拥有对该 NPC 的两项回应，而不是把场景里的
  // `与某人交谈` / `查看四周` 当成对话选项，再额外提交一次 talk。
  // 仅在 focusNpcContext 与主线目标一致时启用，避免玩家主动和旁 NPC 闲谈
  // 后把主线目标错误地投影成当前对话对象。
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
          ? `${utteranceLead(context.story.stylePolicy.protagonistTraits)}你开口对${npc.name}说："${utterance}"。${npc.name}听完，注视着你的眼睛。`
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

/** 氛围描写：当前地点的最小安全文本；dark 呈现克制的暗色意象（纯函数）。 */
function buildAtmosphere(context: SceneGenerationContext): string {
  const { currentLocation } = context;
  const base = `你身处${currentLocation.name}，${currentLocation.description}`;
  if (context.story.stylePolicy.intensity === "dark") {
    return `${base}。阴影里似乎有什么在注视着这里。`;
  }
  return `${base}。`;
}

/** 性格标签 → 玩家原话 segment 的确定性前缀（只影响措辞，纯函数）。 */
function utteranceLead(traits: readonly string[]): string {
  if (traits.includes("冲动")) return "你几乎没多想，";
  if (traits.includes("寡言")) return "你沉默了片刻，";
  if (traits.includes("幽默")) return "你带着轻松的笑意，";
  if (traits.includes("多疑")) return "你打量着对方，";
  return "";
}

/** 焦点 NPC：talk job 优先使用 job.focusNpcId，否则第一个在场 NPC。 */
function focusNpc(context: SceneGenerationContext): SceneGenerationContext["presentNpcs"][number] | undefined {
  const { job, presentNpcs } = context;
  if (context.focusNpcContext !== undefined) {
    const contextFocus = presentNpcs.find((n) => String(n.id) === String(context.focusNpcContext?.id));
    if (contextFocus !== undefined) return contextFocus;
  }
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
  // 回退台词也必须从当前玩家话语/交谈情境生成，不能用脱离上下文的固定确认句。
  const text = policy !== undefined
    ? buildContextualTierLine(context, policy.tier)
    : buildStatusLine(job.resolvedEvent);
  const emotion = policy !== undefined ? TIER_EMOTIONS[policy.tier] : "neutral";

  return {
    npcId: String(npc.id),
    text: normalizeNpcSpeech(text, npc.name),
    emotion,
    usedFactIds: [],
    usedInteractionActionIds: [],
    answeredBeatIds: answeredUtteranceBeatIds(context),
  };
}

function boundedUtteranceReference(utterance: string | undefined): string | null {
  const normalized = utterance?.replace(/\s+/gu, " ").trim().replace(/[。！？!?]+$/u, "") ?? "";
  if (normalized === "") return null;
  const bounded = Array.from(normalized).slice(0, 36).join("");
  return bounded === normalized ? bounded : `${bounded}…`;
}

function contextReference(context: SceneGenerationContext): string {
  const utterance = boundedUtteranceReference(context.job.utterance);
  if (utterance !== null) return `你刚才问的“${utterance}”`;
  const objective = context.objectiveTransition.after?.label;
  if (objective !== undefined) return `当前要查的“${objective}”`;
  return "你刚才提到的事情";
}

/** 同一档位的回退台词也必须承接当前话语，且只使用 NPC 第一人称。 */
function buildContextualTierLine(context: SceneGenerationContext, tier: RelationshipTier): string {
  const utterance = boundedUtteranceReference(context.job.utterance);
  const reference = contextReference(context);
  if (utterance === null) {
    if (context.focusNpcContext !== undefined && ["neutral", "friendly", "trusted"].includes(tier)) {
      return composeDirectNpcGreeting(context.focusNpcContext.role, context.focusNpcContext.name);
    }
    switch (tier) {
      case "hostile": return "有事就直说，但别指望我什么都回答。";
      case "cold": return "有事就直说，我只回答我确定的部分。";
      case "neutral": return "你是来打听事情的吧？想知道什么，直接问我。";
      case "friendly": return "有什么想问的尽管说，我能帮你的会尽量帮。";
      case "trusted": return "不用绕弯子，你想知道什么就问吧，我会把我知道的都告诉你。";
    }
  }

  switch (tier) {
    case "hostile": return `${reference}，这不关你的事，我不想回答。`;
    case "cold": return `${reference}，我只能先说我确定的部分。`;
    case "neutral": return `${reference}，我先说我确定的部分；你还想了解哪一段？`;
    case "friendly": return `${reference}，我愿意把知道的告诉你，我们可以一起理清楚。`;
    case "trusted": return `${reference}，这正是我想和你谈的事；我会把来龙去脉说清楚。`;
  }
}

function buildStatusLine(resolvedEvent: SceneGenerationContext["job"]["resolvedEvent"]): string {
  switch (resolvedEvent.status) {
    case "success":
      return "你想了解什么？我可以先说说我知道的。";
    case "partial_success":
      return "这件事我知道一些，但有些部分不方便现在全说。";
    case "failure":
      return "恐怕这件事我帮不上忙，你换个问题吧。";
    case "blocked":
      return "现在还不是做这件事的时候。";
    default:
      return "我还没弄清楚这件事，先别急着下结论。";
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
  // 幕推进已经把权威目标交给下一名人物/地点；上一回合的 talk 只说明
  // “刚才发生了什么”，不能继续把旧 NPC 设为新一幕的焦点，否则会重新
  // 铸造同一组 support/challenge 选项。交接场景改用通用合法候选，并由
  // objectiveTarget 排序把真正的下一步放在前面。
  if (context.objectiveTransition.mode === "advanced_act") {
    return { kind: "observe", locationId: currentLocation.id };
  }
  switch (job.resolvedEvent.eventKind) {
    case "travel":
      return { kind: "travel", locationId: currentLocation.id };
    case "dialogue": {
      const focus = focusNpc(context);
      if (focus === undefined) return { kind: "observe", locationId: currentLocation.id };
      const objectiveNpc = context.objectiveTarget === null
        ? undefined
        : context.presentNpcs.find((npc) => String(npc.id) === context.objectiveTarget?.entityId);
      const latestDialogueAct = context.focusNpcContext?.recentInteractions.at(-1)?.dialogueAct;
      if (objectiveNpc !== undefined
        && String(objectiveNpc.id) !== String(focus.id)
        && latestDialogueAct !== "ask") {
        return { kind: "observe", locationId: currentLocation.id };
      }
      return { kind: "dialogue", focusNpcId: focus.id };
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
