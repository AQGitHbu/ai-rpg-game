import type { LocationId, NpcId, FactId, ItemId, EnemyId, QuestId } from "./scenarioBlueprint";
import type { ThreadId } from "./storyState";

/** 规则可识别的对话行为（Spec §7.2）。utterance 只供叙事表现，不得声明结果。 */
export const DIALOGUE_ACTS = [
  "ask",
  "support",
  "challenge",
  "threaten",
  "deceive",
  "offer",
  "refuse",
  "reassure",
] as const;

export type DialogueAct = (typeof DIALOGUE_ACTS)[number];

/** 对话主题：规则只读取 kind 与实体 ID；thread 复用 storyState.ThreadId。 */
export type DialogueTopic =
  | { readonly kind: "fact"; readonly factId: FactId }
  | { readonly kind: "quest"; readonly questId: QuestId }
  | { readonly kind: "thread"; readonly threadId: ThreadId }
  | { readonly kind: "general" };

export type Interaction =
  | { readonly kind: "fixed_choice"; readonly choiceToken: string }
  | { readonly kind: "free_text"; readonly text: string; readonly targetNpcId?: NpcId };

/** 固定对话选项（Spec §7.2）：dialogueAct 必填，topic/utterance 可选。 */
export type TalkAction = {
  readonly type: "talk";
  readonly npcId: NpcId;
  readonly dialogueAct: DialogueAct;
  readonly topic?: DialogueTopic;
  readonly utterance?: string;
};

/**
 * 生产支持的 Action union（Spec §7 / Task 29）。
 * use_item/interact/accept_quest/narrative_choice 无规则实现，
 * 已从生产 union 移除——不得作为永远 INTENT_NOT_ROUTED 的公开候选保留。
 * give_item 于 2026-08-09 实机试玩补齐规则实现（背包物品移交给在场 NPC）。
 */
export type Action =
  | TalkAction
  | { readonly type: "move"; readonly locationId: LocationId }
  | { readonly type: "explore" }
  | { readonly type: "investigate"; readonly factId: FactId; readonly utterance?: string }
  | { readonly type: "take_item"; readonly itemId: ItemId }
  | { readonly type: "give_item"; readonly itemId: ItemId; readonly npcId: NpcId }
  | { readonly type: "attack"; readonly enemyId: EnemyId }
  | { readonly type: "battle_action"; readonly action: "attack" | "guard" | "flee" }
  | { readonly type: "rest" }
  | { readonly type: "ack_prologue" }
  | { readonly type: "freeform"; readonly intent: string; readonly rawText: string };

/** Action 的判别字段（用于数据驱动支持矩阵测试）。 */
export type ActionType = Action["type"];

/** 生产支持的 Action type 集合（Task 29：与 Action union 保持一致）。 */
export const SUPPORTED_ACTION_TYPES: readonly ActionType[] = [
  "talk",
  "move",
  "explore",
  "investigate",
  "take_item",
  "give_item",
  "attack",
  "battle_action",
  "rest",
  "ack_prologue",
  "freeform",
];
