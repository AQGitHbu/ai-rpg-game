// ---------------------------------------------------------------------------
// Legacy entry / value 类型：WorldState 兼容投影的字段语言。
// 从 worldState.ts 原样迁出，使 entity/** 可以复用这些类型而不与 WorldState 循环依赖。
// worldState.ts 继续 re-export 全部条目，调用方 import 路径不变。
// ---------------------------------------------------------------------------

import type {
  LocationId, NpcId, ItemId, FactId, QuestId, EnemyId, EndingId,
  StatBlock, LocationScale, LocationKind, ItemCategory, ItemRarity, ItemStatLine,
  EnemyTier, FactSource,
} from "./worldEntity";
import type { RelationshipValue } from "./relationship";
import type { NarrativeEmotion } from "./narrative";
import type { DialogueAct, StructuredDialogueTopic } from "./action";
import type { TownRuntimeState } from "./townState";
import type { EventId } from "./events";

export type PlayerState = {
  readonly name: string;
  readonly identity: string;
  readonly stats: StatBlock;
};

export type LocationEntry = {
  readonly id: LocationId;
  readonly name: string;
  readonly description: string;
  readonly kind: LocationKind;
  readonly connectedLocationIds: readonly LocationId[];
  readonly npcIds: readonly NpcId[];
  readonly availableItemIds: readonly ItemId[];
  readonly tags: readonly string[];
  readonly scale?: LocationScale;
  /** 仅 scale="town" 的地点携带：稳定几何 seed + 剧情建筑 slot 绑定（Task 7）。 */
  readonly town?: TownRuntimeState;
};

export type NpcMemory = {
  readonly npcId: NpcId;
  readonly knownFactIds: readonly FactId[];
  readonly hiddenFactIds: readonly FactId[];
  readonly interactionHistory: readonly NpcInteraction[];
  readonly relationship: RelationshipValue;
  readonly emotion: NarrativeEmotion;
  readonly goals: readonly string[];
};

/** 一次与 NPC 的结构化交互记录（Spec §14.2）：规则生成，绝不包含玩家原文。 */
export type NpcInteraction = {
  readonly turnNumber: number;
  readonly actionId: string;
  /** Task 4：该交互对应的事件 ID，成为台词引用的权威证据。 */
  readonly eventId: EventId;
  readonly locationId: LocationId;
  readonly dialogueAct: DialogueAct | "freeform";
  /** Task 5：本轮的结构化主题引用（规则裁决同源）；无主题时为 general 或省略。 */
  readonly topic?: StructuredDialogueTopic;
  readonly topicSummary: string;
  readonly outcome: "positive" | "negative" | "neutral" | "mixed";
  readonly relationshipDelta: number;
  readonly learnedFactIds: readonly FactId[];
  readonly summary: string;
};

export type NpcEntry = {
  readonly id: NpcId;
  readonly name: string;
  readonly role: string;
  readonly description: string;
  readonly locationId: LocationId;
  readonly isCompanion: boolean;
  readonly tags: readonly string[];
  readonly met: boolean;
  /** knownFactIds 只存于 memory 内（spec §8.5），不在 NpcEntry 顶层重复存储，避免双源歧义 */
  readonly memory: NpcMemory;
};

export type ItemEntry = {
  readonly id: ItemId;
  readonly name: string;
  readonly description: string;
  readonly kind: string;
  readonly tags: readonly string[];
  readonly category?: ItemCategory;
  readonly rarity?: ItemRarity;
  readonly level?: number;
  readonly statLines?: readonly ItemStatLine[];
};

/** 一种已审批的调查方式（Spec 2026-08-20）：玩家选择调查方法时产生的代价与后果契约。 */
export type InvestigationApproach = {
  readonly approachId: string;
  /** 玩家可见的安全提示，不得包含事实正文。 */
  readonly label: string;
  readonly hint?: string;
  readonly evidenceQuality: "clean" | "noisy";
  /** 本方式声明的额外张力，合法范围 -5..20；越界由生成审批校验层拒绝。 */
  readonly tensionDelta: number;
};

export type WorldFactEntry = {
  readonly factId: FactId;
  readonly text: string;
  readonly source: FactSource;
  readonly discovered: boolean;
  readonly locationId?: LocationId;
  /** 未发现事实在任务/调查入口中使用的安全提示，不等于事实正文。 */
  readonly investigationLabel?: string;
  /** 已审批的调查方式（2–3 条）；缺省 = 无选项，事实按自动揭示处理。 */
  readonly investigationApproaches?: readonly InvestigationApproach[];
};

export type QuestObjective =
  | { readonly kind: "visit_location"; readonly locationId: LocationId }
  | { readonly kind: "talk_to_npc"; readonly npcId: NpcId }
  | { readonly kind: "obtain_item"; readonly itemId: ItemId }
  | { readonly kind: "discover_fact"; readonly factId: FactId }
  | { readonly kind: "defeat_enemy"; readonly enemyId: EnemyId };

// 幕推进（Task 2）：开局任务不引用预生成后续任务；推进由世界演化（Task 3）消费。
export type QuestOutcome =
  | { readonly kind: "advance_story" }
  | { readonly kind: "resolve_story" }
  | { readonly kind: "closed" };

export type QuestEntry = {
  readonly id: QuestId;
  readonly name: string;
  readonly description: string;
  readonly objectives: readonly QuestObjective[];
  readonly onSuccess: QuestOutcome;
  readonly onFailure: QuestOutcome;
  readonly tags: readonly string[];
  readonly kind: "main" | "side";
  readonly stage?: number;
  readonly status: "locked" | "active" | "completed" | "failed" | "closed";
};

export type EnemyEntry = {
  readonly id: EnemyId;
  readonly name: string;
  readonly tier: EnemyTier;
  readonly stats: StatBlock;
  readonly locationId: LocationId;
  readonly tags: readonly string[];
};

export type EndingEntry = {
  readonly id: EndingId;
  readonly name: string;
  readonly description: string;
  readonly requirements: readonly (EndingRequirement)[];
};

export type EndingRequirement =
  | { readonly kind: "quest_completed"; readonly questId: QuestId }
  | { readonly kind: "quest_failed"; readonly questId: QuestId }
  | { readonly kind: "fact_discovered"; readonly factId: FactId }
  | { readonly kind: "npc_affinity_at_least"; readonly npcId: NpcId; readonly value: number }
  | { readonly kind: "npc_affinity_at_most"; readonly npcId: NpcId; readonly value: number };

export type FactionEntry = {
  readonly factionId: string;
  readonly name: string;
  readonly attitudeToPlayer: number;
};
