import type { EnemyId, FactId, ItemId, LocationId, NpcId } from "./worldEntity";
import type { StoryState } from "./storyState";
import { paginateSpeechText } from "./speechPagination";
import {
  parsePendingNarrativeJob,
  PROVIDER_GENERATION_KINDS,
  type PendingNarrativeJob,
} from "./pendingNarrativeJob";
import { createApprovedChoice, type ApprovedChoice } from "./approvedChoice";
import { composeDirectNpcGreeting, normalizeNpcSpeech } from "./npcSpeech";
import {
  isSafeNarrativeGenerationRepairReason,
  type NarrativeGenerationFailure,
  type NarrativeGenerationRetryContext,
} from "./narrativeGenerationFailure";
import {
  parsePreparedContinuationState,
  type PreparedContinuationState,
} from "./preparedContinuation";
import {
  parseNarrativeBundleState,
  type NarrativeBundleState,
} from "./narrativeBundle";
import { areUniqueNpcSpeechReferenceIds } from "./npcSpeechReferences";

export const NARRATIVE_EMOTIONS = [
  "neutral", "warm", "guarded", "afraid", "angry", "sad"
] as const;
export type NarrativeEmotion = (typeof NARRATIVE_EMOTIONS)[number];

/** Dialogue response copy is player speech, not a system/action description. */
export const PLAYER_DIALOGUE_RESPONSE_LABELS = [
  "请问一下目前状况是怎么样的？",
  "是否可以告诉我事情的缘由？",
] as const;

export type NarrativeChoiceState = {
  readonly choiceToken: string;
  readonly label: string;
  readonly hint?: string;
};

export type NarrativeEventKind =
  | "dialogue"
  | "investigate"
  | "item"
  | "battle"
  | "travel"
  | "observe";

/** 一幕只允许有一个主事件；其余内容只能作为该事件的表现或后续候选。 */
export type NarrativeEventState =
  | { readonly kind: "dialogue"; readonly focusNpcId: NpcId }
  | { readonly kind: "investigate"; readonly factId: FactId }
  | { readonly kind: "item"; readonly itemId: ItemId }
  | { readonly kind: "battle"; readonly enemyId: EnemyId }
  | { readonly kind: "travel"; readonly locationId: LocationId }
  | { readonly kind: "observe"; readonly locationId: LocationId };

export type NarrativeNpcLineState = {
  readonly npcId: NpcId;
  readonly text: string;
  readonly emotion: NarrativeEmotion;
  readonly usedFactIds: readonly FactId[];
  /** Authority-checked interaction history references used by this line. */
  readonly usedEventIds: readonly string[];
  /** Task 5：该台词应答的强制节拍 ID 列表（player_utterance 节拍必须命中）。 */
  readonly answeredBeatIds?: readonly string[];
};

/** Phase 14: 场景内 NPC 的对白（含焦点 NPC 与其他在场 NPC）。 */
export type NpcDialogueInScene = {
  readonly npcId: NpcId;
  readonly npcName: string;
  readonly npcRole: string;
  /** 复用现有分页机制（paginateSpeechText）。 */
  readonly speechPages: readonly string[];
  /** Authority-checked fact references used by this dialogue. */
  readonly usedFactIds: readonly FactId[];
  /** Authority-checked interaction references used by this dialogue. */
  readonly usedEventIds: readonly string[];
  /** 台词来源；旧存档缺失时由 read model 按兼容规则推断。 */
  readonly speechSource?: "generated" | "fixture";
  /**
   * 这段台词在生成它的场景中的用途。`focus` 才是可承载正式玩家回应的
   * 焦点对白；`ambient` 只是零回合环境闲聊，之后即使该 NPC 成为任务目标
   * 也不能被升级为正式回应。旧存档缺失时按 scene.npcLine.npcId 推断。
   */
  readonly speechPurpose?: "focus" | "ambient";
  /** 旧存档兼容字段；新 live 场景使用 speechPages + speechSource。 */
  readonly smallTalk?: {
    readonly prompt: string;
    readonly response: string;
  };
};

export type NarrativeSceneState = {
  readonly sceneId: string;
  readonly turn: number;
  readonly narration: string;
  readonly usedFactIds: readonly FactId[];
  readonly npcLine: NarrativeNpcLineState | null;
  /** 普通场景为两个选择；NPC 对话收尾场景为单个 handoff 选择。 */
  readonly choices: readonly NarrativeChoiceState[];
  readonly handoffAcknowledgement?: string;
  readonly source: "generated" | "rule" | "fixture";
  /** 新存档写入；旧场景缺失时按 legacy world-action 场景读取。 */
  readonly event?: NarrativeEventState;
  /** Phase 14: 场景内多 NPC 对白（含焦点 NPC）。 */
  readonly npcDialogues?: readonly NpcDialogueInScene[];
};

/** 一段 NPC 对话的服务端会话游标；选择不会在第一轮直接完成 talk 目标。 */
export type DialogueSessionState = {
  readonly npcId: NpcId;
  readonly turnCount: number;
  readonly requiredTurns: number;
  readonly completed: boolean;
};

/**
 * 未消费的正式 NPC 抵达场景缓存。
 *
 * 玩家可以在收到 NPC 的第一句和两个已审批回应后先离开地点，再从地图
 * 返回。规则型 travel 场景会替换 currentScene，但不应丢失这段尚未消费的
 * 对话；恢复时由 application 按当前 revision 重新铸造 opaque token。
 */
export type DialogueResumeState = {
  readonly objectiveKey: string;
  readonly npcId: NpcId;
  readonly locationId: LocationId;
  readonly scene: NarrativeSceneState;
  readonly choiceRegistry: readonly ApprovedChoice[];
};

/** 战斗开始时捕获的叙事侧检查点；失败/撤退只恢复该已批准状态。 */
export type BattleNarrativeCheckpointState = {
  readonly storySnapshot: Omit<StoryState, "narrative">;
  readonly currentScene: NarrativeSceneState;
  readonly choiceRegistry: readonly ApprovedChoice[];
  readonly bundle?: NarrativeBundleState;
  readonly preparedContinuation?: PreparedContinuationState;
  readonly dialogueSession?: DialogueSessionState;
  readonly dialogueResume?: DialogueResumeState;
};

/** Runtime AI is opt-in per save. Offline development presets never call it. */
export type NarrativeMode = "ai" | "offline";

export type NarrativeRuntimeState =
  | {
      readonly status: "ready";
      readonly mode: NarrativeMode;
      readonly currentScene: NarrativeSceneState;
      readonly choiceRegistry: readonly ApprovedChoice[];
      /** v7 唯一生产续接图。旧 preparedContinuation 仅保留给离线 fixture。 */
      readonly narrativeBundle?: NarrativeBundleState;
      readonly preparedContinuation?: PreparedContinuationState;
      readonly dialogueSession?: DialogueSessionState;
      readonly dialogueResume?: DialogueResumeState;
      readonly battleCheckpoint?: BattleNarrativeCheckpointState;
    }
  | {
      readonly status: "provider_pending";
      readonly mode: NarrativeMode;
      readonly job: PendingNarrativeJob;
      readonly lastPresentedScene: NarrativeSceneState | null;
      readonly retryContext?: NarrativeGenerationRetryContext;
      readonly dialogueSession?: DialogueSessionState;
    }
  | {
      readonly status: "provider_failed";
      readonly mode: NarrativeMode;
      readonly job: PendingNarrativeJob;
      readonly failure: NarrativeGenerationFailure;
      readonly lastPresentedScene: NarrativeSceneState | null;
      readonly dialogueSession?: DialogueSessionState;
    };

export type ParseNarrativeRuntimeStateResult =
  | { readonly ok: true; readonly value: NarrativeRuntimeState }
  | { readonly ok: false; readonly code: "INVALID_NARRATIVE_RUNTIME" };

const INVALID_NARRATIVE_RUNTIME: ParseNarrativeRuntimeStateResult = {
  ok: false,
  code: "INVALID_NARRATIVE_RUNTIME",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isNarrativeEvent(value: unknown): value is NarrativeEventState {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "dialogue":
      return hasOnlyKeys(value, ["kind", "focusNpcId"]) && isNonEmptyString(value.focusNpcId);
    case "investigate":
      return hasOnlyKeys(value, ["kind", "factId"]) && isNonEmptyString(value.factId);
    case "item":
      return hasOnlyKeys(value, ["kind", "itemId"]) && isNonEmptyString(value.itemId);
    case "battle":
      return hasOnlyKeys(value, ["kind", "enemyId"]) && isNonEmptyString(value.enemyId);
    case "travel":
    case "observe":
      return hasOnlyKeys(value, ["kind", "locationId"]) && isNonEmptyString(value.locationId);
    default:
      return false;
  }
}

function isNarrativeNpcLine(value: unknown): value is NarrativeNpcLineState {
  return isRecord(value)
    && hasOnlyKeys(value, ["npcId", "text", "emotion", "usedFactIds", "usedEventIds", "answeredBeatIds"])
    && isNonEmptyString(value.npcId)
    && isNonEmptyString(value.text)
    && (NARRATIVE_EMOTIONS as readonly unknown[]).includes(value.emotion)
    && isStringArray(value.usedFactIds)
    && isStringArray(value.usedEventIds)
    && areUniqueNpcSpeechReferenceIds(value.usedFactIds)
    && areUniqueNpcSpeechReferenceIds(value.usedEventIds)
    && (value.answeredBeatIds === undefined || isStringArray(value.answeredBeatIds));
}

function isNarrativeChoice(value: unknown): value is NarrativeChoiceState {
  return isRecord(value)
    && hasOnlyKeys(value, ["choiceToken", "label", "hint"])
    && isNonEmptyString(value.choiceToken)
    && isNonEmptyString(value.label)
    && (value.hint === undefined || typeof value.hint === "string");
}

function isNpcDialogue(value: unknown): value is NpcDialogueInScene {
  return isRecord(value)
    && hasOnlyKeys(value, [
      "npcId", "npcName", "npcRole", "speechPages", "speechSource", "speechPurpose", "smallTalk",
      "usedFactIds", "usedEventIds",
    ])
    && isNonEmptyString(value.npcId)
    && typeof value.npcName === "string"
    && typeof value.npcRole === "string"
    && isStringArray(value.speechPages)
    && isStringArray(value.usedFactIds)
    && isStringArray(value.usedEventIds)
    && areUniqueNpcSpeechReferenceIds(value.usedFactIds)
    && areUniqueNpcSpeechReferenceIds(value.usedEventIds)
    && (value.speechSource === undefined
      || value.speechSource === "generated"
      || value.speechSource === "fixture")
    && (value.speechPurpose === undefined
      || value.speechPurpose === "focus"
      || value.speechPurpose === "ambient")
    && (value.smallTalk === undefined || (
      isRecord(value.smallTalk)
      && hasOnlyKeys(value.smallTalk, ["prompt", "response"])
      && typeof value.smallTalk.prompt === "string"
      && typeof value.smallTalk.response === "string"
    ));
}

function isNarrativeScene(value: unknown): value is NarrativeSceneState {
  return isRecord(value)
    && hasOnlyKeys(value, [
      "sceneId", "turn", "narration", "usedFactIds", "npcLine", "choices",
      "handoffAcknowledgement", "source", "event", "npcDialogues",
    ])
    && isNonEmptyString(value.sceneId)
    && Number.isInteger(value.turn)
    && (value.turn as number) >= 0
    && typeof value.narration === "string"
    && isStringArray(value.usedFactIds)
    && (value.npcLine === null || isNarrativeNpcLine(value.npcLine))
    && Array.isArray(value.choices)
    && value.choices.every(isNarrativeChoice)
    && (value.handoffAcknowledgement === undefined
      || isNonEmptyString(value.handoffAcknowledgement))
    && ["generated", "rule", "fixture"].includes(value.source as string)
    && (value.event === undefined || isNarrativeEvent(value.event))
    && (value.npcDialogues === undefined
      || (Array.isArray(value.npcDialogues) && value.npcDialogues.every(isNpcDialogue)));
}

function isDialogueSession(value: unknown): value is DialogueSessionState {
  return isRecord(value)
    && hasOnlyKeys(value, ["npcId", "turnCount", "requiredTurns", "completed"])
    && isNonEmptyString(value.npcId)
    && Number.isInteger(value.turnCount)
    && (value.turnCount as number) >= 0
    && Number.isInteger(value.requiredTurns)
    && (value.requiredTurns as number) > 0
    && typeof value.completed === "boolean";
}

function isDialogueResume(value: unknown): value is DialogueResumeState {
  return isRecord(value)
    && hasOnlyKeys(value, ["objectiveKey", "npcId", "locationId", "scene", "choiceRegistry"])
    && isNonEmptyString(value.objectiveKey)
    && isNonEmptyString(value.npcId)
    && isNonEmptyString(value.locationId)
    && isNarrativeScene(value.scene)
    && Array.isArray(value.choiceRegistry)
    && value.choiceRegistry.every(isApprovedChoice);
}

function isBattleCheckpoint(value: unknown): value is BattleNarrativeCheckpointState {
  return isRecord(value)
    && hasOnlyKeys(value, ["storySnapshot", "currentScene", "choiceRegistry", "bundle", "preparedContinuation", "dialogueSession", "dialogueResume"])
    && isRecord(value.storySnapshot)
    && isNarrativeScene(value.currentScene)
    && Array.isArray(value.choiceRegistry)
    && value.choiceRegistry.every(isApprovedChoice)
    && (value.bundle === undefined || parseNarrativeBundleState(value.bundle).ok)
    && (value.preparedContinuation === undefined || parsePreparedContinuationState(value.preparedContinuation).ok)
    && (value.dialogueSession === undefined || isDialogueSession(value.dialogueSession))
    && (value.dialogueResume === undefined || isDialogueResume(value.dialogueResume));
}

function isApprovedChoice(value: unknown): value is ApprovedChoice {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "choiceToken", "sceneId", "basedOnRevision", "label", "action", "semanticSummary",
  ])) return false;
  if (!isNonEmptyString(value.choiceToken)
    || !isNonEmptyString(value.sceneId)
    || !Number.isInteger(value.basedOnRevision)
    || (value.basedOnRevision as number) < 0
    || !isNonEmptyString(value.label)
    || !isRecord(value.action)
    || typeof value.action.type !== "string"
    || !isNonEmptyString(value.semanticSummary)) return false;
  try {
    const rebuilt = createApprovedChoice({
      sceneId: value.sceneId,
      basedOnRevision: value.basedOnRevision as number,
      label: value.label,
      action: value.action as ApprovedChoice["action"],
    });
    return rebuilt.ok
      && rebuilt.choice.choiceToken === value.choiceToken
      && rebuilt.choice.semanticSummary === value.semanticSummary;
  } catch {
    return false;
  }
}

function isFailure(value: unknown): value is NarrativeGenerationFailure {
  if (!isRecord(value) || !hasOnlyKeys(value, ["kind", "phase", "failedAt", "reason"])) return false;
  if ((value.kind !== "AI_CALL_FAILED" && value.kind !== "AI_RESPONSE_INVALID")
    || value.phase !== "scene"
    || typeof value.failedAt !== "string") return false;
  if (value.reason !== undefined && !isSafeNarrativeGenerationRepairReason(value.reason)) return false;
  const timestamp = new Date(value.failedAt);
  return !Number.isNaN(timestamp.valueOf()) && timestamp.toISOString() === value.failedAt;
}

function isRetryContext(value: unknown): value is NarrativeGenerationRetryContext {
  return isRecord(value)
    && hasOnlyKeys(value, ["attempt", "reason"])
    && value.attempt === 1
    && isSafeNarrativeGenerationRepairReason(value.reason);
}

function parseProviderJob(value: unknown): PendingNarrativeJob | null {
  try {
    const parsed = parsePendingNarrativeJob(value);
    if (!parsed.ok) return null;
    if (!(PROVIDER_GENERATION_KINDS as readonly (string | null)[])
      .includes(parsed.job.generationKind)) return null;
    return parsed.job;
  } catch {
    return null;
  }
}

/** Strict persisted-state parser. Legacy and mixed discriminants are rejected. */
export function parseNarrativeRuntimeState(value: unknown): ParseNarrativeRuntimeStateResult {
  if (!isRecord(value) || (value.mode !== "ai" && value.mode !== "offline")) {
    return INVALID_NARRATIVE_RUNTIME;
  }
  const dialogueSessionValid = value.dialogueSession === undefined
    || isDialogueSession(value.dialogueSession);
  if (!dialogueSessionValid) return INVALID_NARRATIVE_RUNTIME;

  if (value.status === "ready") {
    if (!hasOnlyKeys(value, [
      "status", "mode", "currentScene", "choiceRegistry", "narrativeBundle", "preparedContinuation", "dialogueSession", "dialogueResume", "battleCheckpoint",
    ])) return INVALID_NARRATIVE_RUNTIME;
    if (!isNarrativeScene(value.currentScene)
      || !Array.isArray(value.choiceRegistry)
      || !value.choiceRegistry.every(isApprovedChoice)) return INVALID_NARRATIVE_RUNTIME;
    if (value.preparedContinuation !== undefined
      && !parsePreparedContinuationState(value.preparedContinuation).ok) {
      return INVALID_NARRATIVE_RUNTIME;
    }
    if (value.narrativeBundle !== undefined && !parseNarrativeBundleState(value.narrativeBundle).ok) {
      return INVALID_NARRATIVE_RUNTIME;
    }
    if (value.dialogueResume !== undefined && !isDialogueResume(value.dialogueResume)) {
      return INVALID_NARRATIVE_RUNTIME;
    }
    if (value.battleCheckpoint !== undefined && !isBattleCheckpoint(value.battleCheckpoint)) {
      return INVALID_NARRATIVE_RUNTIME;
    }
    return { ok: true, value: value as NarrativeRuntimeState };
  }

  if (value.status === "provider_pending") {
    if (!hasOnlyKeys(value, ["status", "mode", "job", "lastPresentedScene", "retryContext", "dialogueSession"])) {
      return INVALID_NARRATIVE_RUNTIME;
    }
    if (parseProviderJob(value.job) === null
      || (value.lastPresentedScene !== null && !isNarrativeScene(value.lastPresentedScene))
      || (value.retryContext !== undefined && !isRetryContext(value.retryContext))) {
      return INVALID_NARRATIVE_RUNTIME;
    }
    return { ok: true, value: value as NarrativeRuntimeState };
  }

  if (value.status === "provider_failed") {
    if (!hasOnlyKeys(value, [
      "status", "mode", "job", "failure", "lastPresentedScene", "dialogueSession",
    ])) return INVALID_NARRATIVE_RUNTIME;
    if (parseProviderJob(value.job) === null
      || !isFailure(value.failure)
      || (value.lastPresentedScene !== null && !isNarrativeScene(value.lastPresentedScene))) {
      return INVALID_NARRATIVE_RUNTIME;
    }
    return { ok: true, value: value as NarrativeRuntimeState };
  }

  return INVALID_NARRATIVE_RUNTIME;
}

/** 场景对白每页字符预算：纯展示策略常量。 */
export const NPC_SCENE_PAGE_CHAR_BUDGET = 48;

/** 确定性 NPC 台词兜底：无场景对白/AI 行无效时的稳定问候（纯函数，零 AI/IO/随机）。 */
export function composeDeterministicNpcLine(npcName: string, npcRole: string): string {
  return composeDirectNpcGreeting(npcRole, npcName);
}

/**
 * 为在场 NPC 列表构造场景对白（NpcDialogueInScene）：焦点 NPC 优先使用
 * 给定台词，其余与无焦点时均回退确定性兜底台词；纯函数，输出顺序与输入一致。
 */
export function buildNpcDialoguePages(
  npcs: readonly { readonly id: unknown; readonly name: string; readonly role: string }[],
  options?: {
    readonly focusNpcId?: unknown;
    readonly focusSpeech?: string;
    readonly generatedNpcLines?: ReadonlyMap<string, string>;
    readonly speechSource?: "generated" | "fixture";
    readonly smallTalkData?: ReadonlyMap<string, { prompt: string; response: string }>;
  },
): readonly NpcDialogueInScene[] {
  return npcs.map((npc) => {
    const normalizedFocusSpeech = options?.focusSpeech === undefined
      ? ""
      : normalizeNpcSpeech(options.focusSpeech, npc.name);
    const isFocus = options?.focusNpcId !== undefined
      && String(npc.id) === String(options.focusNpcId)
      && normalizedFocusSpeech !== "";
    const generatedNpcLine = options?.generatedNpcLines?.get(String(npc.id));
    const normalizedGeneratedNpcLine = generatedNpcLine === undefined
      ? ""
      : normalizeNpcSpeech(generatedNpcLine, npc.name);
    const hasGeneratedLine = !isFocus && normalizedGeneratedNpcLine !== "";
    const focusSpeechSource = options?.speechSource ?? "generated";
    const text = isFocus
      ? normalizedFocusSpeech
      : hasGeneratedLine
        ? normalizedGeneratedNpcLine
        : composeDeterministicNpcLine(npc.name, npc.role);
    const smallTalk = !isFocus && options?.smallTalkData
      ? options.smallTalkData.get(String(npc.id))
      : undefined;
    return {
      npcId: npc.id as NpcId,
      npcName: npc.name,
      npcRole: npc.role,
      speechPages: paginateSpeechText(text, NPC_SCENE_PAGE_CHAR_BUDGET),
      usedFactIds: [],
      usedEventIds: [],
      speechSource: isFocus ? focusSpeechSource : hasGeneratedLine ? "generated" : "fixture",
      speechPurpose: isFocus ? "focus" : "ambient",
      ...(smallTalk ? { smallTalk } : {}),
    };
  });
}
