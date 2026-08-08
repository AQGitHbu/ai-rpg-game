import type { EnemyId, FactId, ItemId, LocationId, NpcId } from "./scenarioBlueprint";
import { paginateSpeechText } from "./speechPagination";
import type { PendingNarrativeJob } from "./pendingNarrativeJob";

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
  /** 规则行动与 NPC 对话回应是两种不同的提交语义。 */
  readonly choiceKind?: "dialogue_response" | "world_action";
  /** 对话回应的稳定语义，不是规则 actionKey。 */
  readonly dialogueIntent?: string;
  readonly actionKey: string;
  /** Phase 14: 选项展示提示（如"将引入新 NPC"）。 */
  readonly hint?: string;
  /** Phase 14: 情境语义，供导演后续参考。 */
  readonly narrativeIntent?: "advance_plot" | "introduce_npc" | "introduce_location" | "combat" | "discover_item";
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
      /** v2.1：pending 的唯一载体；玩家原文只在 job.utterance 内。 */
      readonly job: PendingNarrativeJob;
    };

/** Runtime AI is opt-in per save. Offline development presets never call it. */
export type NarrativeMode = "ai" | "offline";

export type NarrativeRuntimeState = {
  readonly currentScene: NarrativeSceneState | null;
  readonly generation: NarrativeGenerationState;
  readonly mode: NarrativeMode;
};

/** 场景对白每页字符预算：纯展示策略常量，与 V1 的 SPEECH_PAGE_CHAR_BUDGET 对齐。 */
export const NPC_SCENE_PAGE_CHAR_BUDGET = 48;

/** 确定性 NPC 台词兜底：无场景对白/AI 行无效时的稳定问候（纯函数，零 AI/IO/随机）。 */
export function composeDeterministicNpcLine(npcName: string, npcRole: string): string {
  return `${npcName}（${npcRole}）看了你一眼："欢迎光临，有什么需要帮忙的吗？"`;
}

/**
 * 为在场 NPC 列表构造场景对白（NpcDialogueInScene）：焦点 NPC 优先使用
 * 给定台词，其余与无焦点时均回退确定性兜底台词；纯函数，输出顺序与输入一致。
 */
export function buildNpcDialoguePages(
  npcs: readonly { readonly id: unknown; readonly name: string; readonly role: string }[],
  options?: { readonly focusNpcId?: unknown; readonly focusSpeech?: string },
): readonly NpcDialogueInScene[] {
  return npcs.map((npc) => {
    const isFocus = options?.focusNpcId !== undefined
      && String(npc.id) === String(options.focusNpcId)
      && (options.focusSpeech ?? "").trim() !== "";
    const text = isFocus
      ? options!.focusSpeech!.trim()
      : composeDeterministicNpcLine(npc.name, npc.role);
    return {
      npcId: npc.id as NpcId,
      npcName: npc.name,
      npcRole: npc.role,
      speechPages: paginateSpeechText(text, NPC_SCENE_PAGE_CHAR_BUDGET),
    };
  });
}
