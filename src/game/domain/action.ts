import type { LocationId, NpcId, FactId, ItemId, EnemyId, QuestId } from "./scenarioBlueprint";

export type Interaction =
  | { readonly kind: "fixed_choice"; readonly choiceToken: string }
  | { readonly kind: "free_text"; readonly text: string; readonly targetNpcId?: NpcId };

export type Action =
  | { readonly type: "talk"; readonly npcId: NpcId; readonly utterance?: string }
  | { readonly type: "move"; readonly locationId: LocationId }
  | { readonly type: "explore" }
  | { readonly type: "investigate"; readonly factId: FactId; readonly utterance?: string }
  | { readonly type: "take_item"; readonly itemId: ItemId }
  | { readonly type: "use_item"; readonly itemId: ItemId; readonly targetId?: string; readonly utterance?: string }
  | { readonly type: "give_item"; readonly itemId: ItemId; readonly targetNpcId: NpcId; readonly utterance?: string }
  | { readonly type: "attack"; readonly enemyId: EnemyId }
  | { readonly type: "battle_action"; readonly action: "attack" | "guard" | "flee" }
  | { readonly type: "interact"; readonly targetId: string; readonly utterance?: string }
  | { readonly type: "rest" }
  | { readonly type: "accept_quest"; readonly questId: QuestId }
  | { readonly type: "narrative_choice"; readonly choiceToken: string }
  | { readonly type: "ack_prologue" }
  | { readonly type: "freeform"; readonly intent: string; readonly rawText: string };
