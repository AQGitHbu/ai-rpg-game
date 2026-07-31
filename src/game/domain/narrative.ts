import type { FactId, NpcId } from "./scenarioBlueprint";

export const NARRATIVE_EMOTIONS = [
  "neutral", "warm", "guarded", "afraid", "angry", "sad"
] as const;
export type NarrativeEmotion = (typeof NARRATIVE_EMOTIONS)[number];

export type NarrativeChoiceState = {
  readonly choiceToken: string;
  readonly label: string;
  readonly actionKey: string;
};

export type NarrativeNpcLineState = {
  readonly npcId: NpcId;
  readonly text: string;
  readonly emotion: NarrativeEmotion;
  readonly usedFactIds: readonly FactId[];
};

export type NarrativeSceneState = {
  readonly sceneId: string;
  readonly turn: number;
  readonly narration: string;
  readonly usedFactIds: readonly FactId[];
  readonly npcLine: NarrativeNpcLineState | null;
  readonly choices: readonly [NarrativeChoiceState, NarrativeChoiceState];
  readonly source: "generated" | "fallback";
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
  | { readonly status: "pending"; readonly requestedAt: string; readonly playerNpcChat?: PlayerNpcChatState };

/** Runtime AI is opt-in per save. Offline development presets never call it. */
export type NarrativeMode = "ai" | "offline";

export type NarrativeRuntimeState = {
  readonly currentScene: NarrativeSceneState | null;
  readonly generation: NarrativeGenerationState;
  readonly mode: NarrativeMode;
};
