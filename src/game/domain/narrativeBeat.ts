import type { QuestId } from "./worldEntity";

// Task 4：把规则结果与任务变化转成强制叙事节拍（mandatory narrative beats）。
// 纯领域类型；派生逻辑在 gameplay/rpg/narrativeContext。

export type ObjectiveRef = {
  readonly questId: QuestId;
  readonly objectiveIndex: number;
  readonly label: string;
};

export type ObjectiveTransitionMode =
  | "unchanged"
  | "progressed"
  | "advanced_act"
  | "ready_for_ending";

export type ObjectiveTransition = {
  readonly before: ObjectiveRef | null;
  readonly completed: readonly ObjectiveRef[];
  readonly after: ObjectiveRef | null;
  readonly mode: ObjectiveTransitionMode;
};

export type MandatoryNarrativeBeatKind =
  | "player_utterance"
  | "item_obtained"
  | "fact_discovered"
  | "quest_progress"
  | "quest_advanced"
  | "battle_started"
  | "battle_round"
  | "battle_resolved"
  | "entity_introduced";

export type MandatoryNarrativeBeat = {
  readonly beatId: string;
  readonly kind: MandatoryNarrativeBeatKind;
  readonly subjectIds: readonly string[];
  readonly instruction: string;
};

export const MAX_MANDATORY_BEATS = 8 as const;
