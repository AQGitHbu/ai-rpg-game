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

export type NarrativeGenerationState =
  | { readonly status: "idle" }
  | { readonly status: "pending"; readonly requestedAt: string };

export type NarrativeRuntimeState = {
  readonly currentScene: NarrativeSceneState | null;
  readonly generation: NarrativeGenerationState;
};
