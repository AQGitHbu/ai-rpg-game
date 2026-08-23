import type { EnemyId, FactId, ItemId, LocationId, NpcId } from "./worldEntity";
import { paginateSpeechText } from "./speechPagination";
import type { PendingNarrativeJob } from "./pendingNarrativeJob";
import type { ApprovedChoice } from "./approvedChoice";
import { composeDirectNpcGreeting, normalizeNpcSpeech } from "./npcSpeech";
import type { NarrativeGenerationFailure } from "./narrativeGenerationFailure";

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
  /** Task 5：该台词应答的强制节拍 ID 列表（player_utterance 节拍必须命中）。 */
  readonly answeredBeatIds?: readonly string[];
};

/** Pre-generated branch consumed immediately by a dialogue response choice. */
export type NarrativeDialogueFollowupState = {
  readonly dialogueIntent: string;
  readonly narration: string;
  readonly npcLine: NarrativeNpcLineState;
  readonly nextEventHint?: string;
};

/** Phase 14: 场景生成的触发上下文，让导演知道场景是为何触发的。 */
export type NarrativeTriggerContext =
  | { readonly kind: "initial_opening"; readonly npcId: NpcId }
  | { readonly kind: "talk"; readonly npcId: NpcId; readonly isFirstMeeting: boolean }
  | { readonly kind: "narrative_choice_followup"; readonly previousChoiceActionKey: string }
  | { readonly kind: "dialogue_response"; readonly npcId: NpcId; readonly dialogueIntent: string; readonly playerText: string }
  | { readonly kind: "free_input"; readonly npcId: NpcId; readonly playerText: string }
  | { readonly kind: "location_entered"; readonly locationId: string; readonly isFirstVisit: boolean };

/** Phase 14: 场景内 NPC 的对白（含焦点 NPC 与其他在场 NPC）。 */
export type NpcDialogueInScene = {
  readonly npcId: NpcId;
  readonly npcName: string;
  readonly npcRole: string;
  /** 复用现有分页机制（paginateSpeechText）。 */
  readonly speechPages: readonly string[];
  /** 台词来源；旧存档缺失时由 read model 按兼容规则推断。 */
  readonly speechSource?: "generated" | "fallback";
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
  readonly choices: readonly [NarrativeChoiceState, NarrativeChoiceState];
  readonly source: "generated" | "fallback";
  /** 新存档写入；旧场景缺失时按 legacy world-action 场景读取。 */
  readonly event?: NarrativeEventState;
  /** Phase 14: 场景内多 NPC 对白（含焦点 NPC）。 */
  readonly npcDialogues?: readonly NpcDialogueInScene[];
  /** Pre-generated dialogue branches; intentionally server-only in read models. */
  readonly dialogueFollowups?: readonly [NarrativeDialogueFollowupState, NarrativeDialogueFollowupState];
  /** Safe hint shown only after a pre-generated branch is selected. */
  readonly nextEventHint?: string;
};

// 玩家自由输入触发叙事场景时的上下文快照：随 pending 变体单次消费，
// 场景 ready 时 generation 收窄回 idle 自动丢弃，防止跨场景残留。
export type PlayerNpcChatState = {
  readonly npcId: NpcId;
  readonly playerText: string;
  readonly npcName: string;
  readonly npcRole: string;
};

export type NarrativeGenerationState =
  | { readonly status: "idle" }
  | {
      readonly status: "pending";
      /** pending 的唯一载体；玩家原文只在 job.utterance 内。 */
      readonly job: PendingNarrativeJob;
    }
  | {
      readonly status: "failed";
      /** 失败时仍保留原 job，使重试能复用同一 jobId/行动摘要而不重复规则回合。 */
      readonly job: PendingNarrativeJob;
      readonly failure: NarrativeGenerationFailure;
    };

/** 一段 NPC 对话的服务端会话游标；选择不会在第一轮直接完成 talk 目标。 */
export type DialogueSessionState = {
  readonly npcId: NpcId;
  readonly turnCount: number;
  readonly requiredTurns: number;
  readonly completed: boolean;
};

/**
 * AI 预生成单线行动（investigate/move）叙事的持久化形态（Task 2）。
 * 由审批器从 `LinearActionNarrative` 逐字段重建：绝不直接持久化提案对象原引用。
 */
export type LinearActionNarrativeState =
  | {
      readonly actionKind: "investigate";
      readonly factId: FactId;
      readonly narration: string;
      readonly source: "generated";
    }
  | {
      readonly actionKind: "move";
      readonly locationId: LocationId;
      readonly narration: string;
      readonly source: "generated";
    };

/** Runtime AI is opt-in per save. Offline development presets never call it. */
export type NarrativeMode = "ai" | "offline";

export type NarrativeRuntimeState = {
  readonly currentScene: NarrativeSceneState | null;
  readonly generation: NarrativeGenerationState;
  readonly mode: NarrativeMode;
  readonly dialogueSession?: DialogueSessionState;
  /**
   * 服务端持久化选项注册表（Spec §8.2）：ApprovedChoice 只存在于服务端，
   * 绝不进入 read model；客户端只能拿到 { choiceToken, label, hint? }。
   * 条目自带 sceneId/basedOnRevision，消费时校验
   * entry.sceneId === currentScene.sceneId &&
   * entry.basedOnRevision === 当前 record revision，否则视为过期失效。
   */
  readonly choiceRegistry?: readonly ApprovedChoice[];
  /**
   * AI 预生成单线行动叙事队列（Task 2）：随场景写回覆盖式更新，仅 fast path
   * 消费时读取，消费即除；残留条目仅在实体 ID 精确匹配时生效，无越权风险。
   */
  readonly linearNarrativeQueue?: readonly LinearActionNarrativeState[];
};

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
    readonly speechSource?: "generated" | "fallback";
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
      speechSource: isFocus ? focusSpeechSource : hasGeneratedLine ? "generated" : "fallback",
      ...(smallTalk ? { smallTalk } : {}),
    };
  });
}
