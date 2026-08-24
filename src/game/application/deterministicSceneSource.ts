import type { SceneSource, SceneSourceResult, ScenePerformanceSegment, ScenePerformanceProposal, PreparedContinuationProposal } from "./sceneSource";
import type { SceneGenerationContext } from "./sceneGenerationContext";
import { isFinalDialogueHandoff } from "./sceneGenerationContext";
import type { NarrativeEmotion, NarrativeEventState } from "@/game/domain/narrative";
import type { Action } from "@/game/domain/action";
import { semanticSummaryOf } from "@/game/domain/approvedChoice";
import type { RelationshipTier } from "@/game/domain/relationship";
import { ATMOSPHERE_BEAT_ID } from "@/game/domain/narrativeBeat";
import { composeDirectNpcGreeting, normalizeNpcSpeech } from "@/game/domain/npcSpeech";
import {
  buildSelectableSceneCandidates as buildSharedSelectableSceneCandidates,
  buildPreparedSceneCandidates,
  type CurrentNpcLineContext,
  type SceneChoiceCandidate,
} from "./sceneChoiceCandidates";

export { formatSceneChoiceLabel, usesFallbackDialogueChoiceLabels } from "./sceneChoiceCandidates";
export type { CurrentNpcLineContext, SceneChoiceCandidate } from "./sceneChoiceCandidates";

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

export function buildSelectableSceneCandidates(
  context: SceneGenerationContext,
  currentNpcLine?: string | CurrentNpcLineContext,
): readonly SceneChoiceCandidate[] {
  return buildSharedSelectableSceneCandidates(context, currentNpcLine);
}

export function createDeterministicSceneSource(): SceneSource {
  return {
    async generateScene(context: SceneGenerationContext): Promise<SceneSourceResult> {
      const sceneId = `scene-${context.job.jobId}`;
      const npcLine = buildNpcLineState(context);
      const finalDialogueHandoff = isFinalDialogueHandoff(context);
      const proposal: ScenePerformanceProposal = {
        sceneId,
        segments: buildSegments(context),
        npcLine,
        objectiveLink: buildObjectiveLink(context),
        choices: finalDialogueHandoff ? [] : buildSceneChoices(context, npcLine === null ? undefined : npcLine),
        ...(finalDialogueHandoff ? { handoffAcknowledgement: "你向对方点头致意，记下新的线索。" } : {}),
        preparedContinuations: buildPreparedContinuations(context),
        source: "fixture",
      };
      return { ok: true, proposal };
    },
  };
}

function buildPreparedContinuations(context: SceneGenerationContext): readonly PreparedContinuationProposal[] {
  return (context.preparedStepDescriptors ?? []).map((descriptor) => ({
    stepId: descriptor.stepId,
    segments: [{
      beatId: ATMOSPHERE_BEAT_ID,
      text: preparedStepNarration(context, descriptor.trigger),
    }],
    npcLine: descriptor.arrivalNpc === undefined
      ? null
      : {
          npcId: String(descriptor.arrivalNpc.id),
          text: `${descriptor.arrivalNpc.name}抬眼看向你。这里的线索还没有说完，你最好先证明自己值得信任。`,
          emotion: "guarded" as const,
          answeredBeatIds: [],
          usedFactIds: [],
          usedInteractionActionIds: [],
        },
    objectiveLink: {
      questId: String(descriptor.authority.questId),
      objectiveIndex: descriptor.authority.objectiveIndex,
      mode: "hint" as const,
    },
    choices: buildPreparedSceneCandidates(descriptor).map((choice) => ({
      candidateId: choice.candidateId,
      label: choice.label,
    })),
    source: "fixture" as const,
  }));
}

function preparedStepNarration(
  context: SceneGenerationContext,
  trigger: import("@/game/domain/preparedContinuation").PreparedContinuationTrigger,
): string {
  switch (trigger.kind) {
    case "move": {
      const location = context.currentLocation.id === trigger.locationId
        ? context.currentLocation.name
        : String(trigger.locationId);
      return `你沿着线索抵达${location}，新的迹象在前方等待核对。`;
    }
    case "investigate": return `你围绕${String(trigger.factId)}留下的痕迹继续查证。`;
    case "battle_started": return `你在路口遭遇${String(trigger.enemyId)}，战斗一触即发。`;
    case "battle_resolved": return `战斗${trigger.outcome}后，你重新整理现场留下的线索。`;
  }
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
          ? `${utteranceLead(context.story.stylePolicy.protagonistTraits)}你把关于眼前线索的疑问直截了当地抛给${npc.name}，等他给出能核查的回答。`
          : "你向对方提出了你的疑问。",
      });
    } else if (beat.kind === "item_obtained") {
      const item = context.beatSubjects.find((subject) =>
        subject.kind === "item" && beat.subjectIds.includes(subject.id),
      );
      const namedInInstruction = beat.instruction.match(/「([^」]+)」/u)?.[1];
      const itemName = item?.name ?? namedInInstruction ?? "那件证物";
      const itemDetail = item?.description.trim();
      segments.push({
        beatId: beat.beatId,
        text: itemDetail === undefined || itemDetail === ""
          ? `你将${itemName}仔细收好，准备在下一次交谈时拿它核对证词。`
          : `你将${itemName}仔细收好。${itemDetail}它足以让接下来的追问有了落脚处。`,
      });
    } else if (beat.kind === "battle_started") {
      const enemy = context.beatSubjects.find((subject) =>
        subject.kind === "enemy" && beat.subjectIds.includes(subject.id),
      );
      segments.push({
        beatId: beat.beatId,
        text: `${enemy?.name ?? "来敌"}拦住去路，${completeSceneSentence(beat.instruction)}`,
      });
    } else if (beat.kind === "battle_resolved") {
      segments.push({
        beatId: beat.beatId,
        text: `${completeSceneSentence(beat.instruction)}你收拢呼吸，重新确认眼前留下的线索。`,
      });
} else if (beat.kind === "fact_discovered") {
      // Task 3：调查发现的兜底旁白在事实文本（beat instruction）之后追加
      // 由 objectiveTarget 结构化的下一目标动线提示（复用 objectiveHandoffLine
      // 的派生，不扫描正文猜主题），保证离线兜底也回答"为什么去下一地点"。
      // Task 4：已结算的 approach 结果（investigate 主动选择）改为确定性组合
      // 旁白：采取方式 → 发现事实 → 证据质量/动静代价 → 下一目标。
      const resolved = context.resolvedInvestigation;
      if (resolved !== undefined) {
        const factLead = "发现了线索：";
        const trimmedInstruction = beat.instruction.trim();
        const factText = trimmedInstruction.startsWith(factLead)
          ? trimmedInstruction.slice(factLead.length)
          : beat.instruction;
        segments.push({
          beatId: beat.beatId,
          text: buildInvestigationOutcomeNarrative({
            approachLabel: resolved.approachLabel,
            evidenceQuality: resolved.evidenceQuality,
            factText,
            ...(context.objectiveTarget === null ? {} : { nextObjectiveLabel: context.objectiveTarget.entityName }),
          }),
        });
      } else {
        segments.push({
          beatId: beat.beatId,
          text: `${completeSceneSentence(beat.instruction)}${objectiveHandoffLine(context)}`,
        });
      }
    } else if (beat.kind === "quest_advanced" && context.objectiveTarget !== null) {
      // 幕边界：turn 时刻的下一个目标尚未具象化，节拍指令里没有实体名；
      // 场景装配的预览状态已具象化，此处保留自然语言交接，并用稳定
      // entityId 提供结构化 grounding；目标身份不再依赖旁白逐字匹配。
      segments.push({
        beatId: beat.beatId,
        text: `主线推进。当前目标：${context.objectiveTarget.entityName}（${context.objectiveTransition.after?.label ?? "新的线索"}）`,
        referencedEntityIds: [String(context.objectiveTarget.entityId)],
      });
    } else {
      segments.push({ beatId: beat.beatId, text: completeSceneSentence(beat.instruction) });
    }
  }
  // 服务端恒带 atmosphere 节拍；纯测试夹具无强制节拍时仍保底一段氛围。
  if (segments.length === 0) {
    segments.push({ beatId: ATMOSPHERE_BEAT_ID, text: buildAtmosphere(context) });
  }
  return segments;
}

/** 把规则节拍的短标签收束为可直接拼进场景旁注的完整句。 */
function completeSceneSentence(text: string): string {
  const trimmed = text.trim();
  return /[。！？]$/u.test(trimmed) ? trimmed : `${trimmed}。`;
}

/**
 * Task 4：已结算调查结果的确定性旁白包装。
 * 组合顺序：采取方式 → 发现事实 → 证据质量/动静代价 → 下一目标。
 * baseNarrative（已结算叙事上下文）存在时优先
 * 作为主体，approach/evidence/next 随后补充。
 */
export function buildInvestigationOutcomeNarrative(input: {
  readonly approachLabel: string;
  readonly evidenceQuality: "clean" | "noisy";
  readonly factText: string;
  readonly baseNarrative?: string;
  readonly nextObjectiveLabel?: string;
}): string {
  const trimmedBase = input.baseNarrative?.trim() ?? "";
  // Task 5：baseNarrative（已结算的队列叙事）作为主体时，仍需点名所选方式，
  // 让结果场景始终可读；无 baseNarrative 时沿用 Task 4 的组合句式。
  const base = trimmedBase !== ""
    ? `${trimmedBase}你按「${input.approachLabel}」的方式完成了查证。`
    : `你按「${input.approachLabel}」的方式仔细查证，${input.factText}`;
  const lead = /[。！？]$/u.test(base) ? base : `${base}。`;
  const outcome = input.evidenceQuality === "clean"
    ? "这次查证干净利落，没有惊动任何人。"
    : "翻找的动静不小，现场留下了动静。";
  const next = input.nextObjectiveLabel === undefined || input.nextObjectiveLabel.trim() === ""
    ? "接下来沿着这条线索继续核对。"
    : `接下来按主线继续核对：${input.nextObjectiveLabel}。`;
  return `${lead}${outcome}${next}`;
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
  if (traits.includes("冲动")) return "你几乎没多想，便";
  if (traits.includes("寡言")) return "你沉默了片刻，才";
  if (traits.includes("幽默")) return "你带着轻松的笑意，仍";
  if (traits.includes("多疑")) return "你打量着对方，随后";
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

/** 同一档位的回退台词也必须承接当前话语，且只使用 NPC 第一人称。 */
function buildContextualTierLine(context: SceneGenerationContext, tier: RelationshipTier): string {
  if ((context.job.utterance?.trim() ?? "") === "") {
    const fixedReply = structuredDialogueReply(context, context.previousDialogue?.selectedChoice?.dialogueAct === "challenge");
    if (fixedReply !== null) return fixedReply;
    if (context.focusNpcContext !== undefined && ["neutral", "friendly", "trusted"].includes(tier)) {
      return composeDirectNpcGreeting(context.focusNpcContext.role, context.focusNpcContext.name);
    }
    switch (tier) {
      case "hostile": return "有事就直说，但别指望我什么都回答。真想查下去，先拿能对上的证据来。";
      case "cold": return "有事就直说，我只回答我确定的部分。其余的，等你拿出证据再谈。";
      case "neutral": return "你是来打听事情的吧？想知道什么，直接问我。别把传闻当成证据。";
      case "friendly": return "有什么想问的尽管说，我能帮你的会尽量帮。先把你知道的那一段讲清楚。";
      case "trusted": return "不用绕弯子，你想知道什么就问吧。我会把我知道的都告诉你。";
    }
  }

  // 玩家原话是生成约束而不是 NPC 应逐字复读的稿子。确定性 fallback 只引用
  // 服务端已解析的当前目标，不按角色名猜测证物或地点，避免 NPC 平白知道
  // 一组尚未在故事中出现的细节。
  const directReply = objectiveDialogueReply(context, false);
  switch (tier) {
    case "hostile": return `这不关你的事，我不会替任何人担保。${directReply}再逼问，我只会把门关上。`;
    case "cold": return `我只说亲眼见过的部分。${directReply}其余的，等你拿出能对上的证据再谈。`;
    case "neutral": return `${directReply}这条线索够你先走一步，别急着替谁下结论。`;
    case "friendly": return `${directReply}你把手里的证据带上，我们可以把前后两段对起来。`;
    case "trusted": return `${directReply}我会把能证明这件事的东西交给你，一起把来龙去脉查清。`;
  }
}

/**
 * 固定选择和自由输入共用同一条结构化 fallback。它只使用当前主线已经
 * 解析出的目标类型/实体，不从 NPC role 或对白文本匹配出“松脂/车辙”等
 * 额外证物；具体 NPC 事实由 live performer 从 speakableFactCards 生成。
 */
function structuredDialogueReply(context: SceneGenerationContext, questioning: boolean): string | null {
  if (context.job.actionSummary.kind !== "talk" || context.previousDialogue === undefined) return null;
  const interaction = context.focusNpcContext?.recentInteractions
    .find((entry) => entry.actionId === context.job.actionId);
  if (interaction?.dialogueAct !== "support" && interaction?.dialogueAct !== "challenge") return null;
  return objectiveDialogueReply(context, questioning);
}

function objectiveDialogueReply(context: SceneGenerationContext, questioning: boolean): string {
  const lead = questioning
    ? "你问得在理，我只说我能确认的部分。"
    : "既然你愿意继续查，我把眼前能确认的范围说清楚。";
  return `${lead}${objectiveHandoffLine(context)}`;
}

/** 当前任务交接只从结构化目标产生，不能由 NPC 身份或台词关键词推断。 */
function objectiveHandoffLine(context: SceneGenerationContext): string {
  const target = context.objectiveTarget;
  const kind = context.story.activeQuest?.objectiveKind;
  if (target === null || kind === undefined) {
    return "先把眼前这条线索核对清楚，再往下判断。";
  }
  switch (kind) {
    case "visit_location": return `接下来去${target.entityName}核对现场。`;
    case "talk_to_npc": return `接下来找${target.entityName}把这一环问清。`;
    case "obtain_item": return `接下来先找到${target.entityName}，拿实物核对。`;
    case "discover_fact": return `接下来查明${target.entityName}，不要只凭传闻判断。`;
    case "defeat_enemy": return `接下来先处理${target.entityName}，再追查后面的线索。`;
    default: return `接下来按主线核对${target.entityName}。`;
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
export function buildSceneChoices(
  context: SceneGenerationContext,
  currentNpcLine?: string | CurrentNpcLineContext,
): ScenePerformanceProposal["choices"] {
  const selectable = buildSelectableSceneCandidates(context, currentNpcLine);
  const finalDialogueHandoff = isFinalDialogueHandoff(context);
  if (selectable.length < (finalDialogueHandoff ? 1 : 2)) {
    throw new Error(finalDialogueHandoff
      ? "scene fallback requires a legal handoff candidate"
      : "scene fallback requires at least two legal action candidates");
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
    if (distinct.length === (finalDialogueHandoff ? 1 : 2)) break;
  }
  if (distinct.length !== (finalDialogueHandoff ? 1 : 2)) {
    throw new Error("scene fallback requires two distinct legal action candidates");
  }
  if (finalDialogueHandoff) {
    return [{ candidateId: distinct[0]!.candidateId, label: distinct[0]!.label }];
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
