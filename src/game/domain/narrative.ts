import type { FactId, NpcId } from "./scenarioBlueprint";

export const NARRATIVE_EMOTIONS = [
  "neutral", "warm", "guarded", "afraid", "angry", "sad"
] as const;
export type NarrativeEmotion = (typeof NARRATIVE_EMOTIONS)[number];

export type NarrativeChoiceState = {
  readonly choiceToken: string;
  readonly label: string;
  readonly actionKey: string;
  /** Phase 14: 选项展示提示（如"将引入新 NPC"）。 */
  readonly hint?: string;
  /** Phase 14: 情境语义，供导演后续参考。 */
  readonly narrativeIntent?: "advance_plot" | "introduce_npc" | "introduce_location" | "combat" | "discover_item";
};

export type NarrativeNpcLineState = {
  readonly npcId: NpcId;
  readonly text: string;
  readonly emotion: NarrativeEmotion;
  readonly usedFactIds: readonly FactId[];
};

/** Phase 14: 场景生成的触发上下文，让导演知道场景是为何触发的。 */
export type NarrativeTriggerContext =
  | { readonly kind: "talk"; readonly npcId: NpcId; readonly isFirstMeeting: boolean }
  | { readonly kind: "narrative_choice_followup"; readonly previousChoiceActionKey: string }
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
  /** Phase 14: 场景内多 NPC 对白（含焦点 NPC）。 */
  readonly npcDialogues?: readonly NpcDialogueInScene[];
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
      readonly requestedAt: string;
      /** Phase 14: 场景生成的触发上下文。 */
      readonly triggerContext?: NarrativeTriggerContext;
      readonly playerNpcChat?: PlayerNpcChatState;
    };

/** Runtime AI is opt-in per save. Offline development presets never call it. */
export type NarrativeMode = "ai" | "offline";

export type NarrativeRuntimeState = {
  readonly currentScene: NarrativeSceneState | null;
  readonly generation: NarrativeGenerationState;
  readonly mode: NarrativeMode;
};
