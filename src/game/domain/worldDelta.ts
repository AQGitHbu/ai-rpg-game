import type { EndingDirectionKey } from "./storyContract";
import type {
  EndingId,
  EnemyId,
  FactId,
  ItemId,
  LocationId,
  NpcId,
  QuestId,
} from "./worldEntity";
import type { StoryState } from "./storyState";
import type { EndingRequirement, InvestigationApproach, WorldState } from "./worldState";
import type { BlueprintExpandedPayload, EventId, NarrativeEventDraft, TurnId } from "./events";
import type {
  NpcGoalProposal,
  NpcIdentityAnchors,
  NpcRelationshipSeedProposal,
} from "./entity/npcComponents";

// ---------------------------------------------------------------------------
// 故事演化状态与需求：运行时按需具象化的推进账本。
// ---------------------------------------------------------------------------

export type StoryEvolutionState = {
  readonly nextLocationOrdinal: number;
  readonly nextNpcOrdinal: number;
  readonly nextItemOrdinal: number;
  readonly nextEnemyOrdinal: number;
  readonly nextFactOrdinal: number;
  readonly nextQuestOrdinal: number;
  readonly nextEndingOrdinal: number;
  readonly status: "stable" | "needs_next_act" | "needs_ending_pair";
};

export type EvolutionNeed =
  | { readonly kind: "none" }
  | { readonly kind: "next_act"; readonly act: number }
  | { readonly kind: "pacing"; readonly pacingNeed: "complicate" | "escalate" }
  | { readonly kind: "ending_pair"; readonly finalAct: number };

/** 动态地点的空间归属：世界地图地点，或当前城镇内的剧情建筑。 */
export type DynamicLocationPlacement = "world" | "town_building";

// ---------------------------------------------------------------------------
// 世界演化提议：AI 产出、纯引用（普通字符串 ID），经审批后由服务端铸造品牌化 ID。
// Task 3 细化下述占位类型与审批/具象化流程。
// ---------------------------------------------------------------------------

/** Task 3 细化的动态主线任务提议占位：本任务只定义最小结构。 */
export type DynamicQuestProposal = {
  readonly name: string;
  readonly description: string;
  readonly objectiveText: string;
};

/** Task 3 细化的动态结局提议占位：themeKey 对应故事契约的两个结局方向之一。 */
export type DynamicEndingProposal = {
  readonly name: string;
  readonly description: string;
  readonly themeKey: EndingDirectionKey;
  /**
   * @deprecated 仅为旧提案兼容保留。结局条件由服务端规则按 themeKey/关键 NPC
   * 派生，审批阶段不会采纳 AI 提交的 requirements。
   */
  readonly requirements?: readonly EndingRequirement[];
};

export type WorldDeltaProposal = {
  readonly beatSummary: string;
  readonly newLocation: null | {
    readonly name: string;
    readonly description: string;
    readonly scale: "scene" | "town";
    /** town_building 不会铸造 LocationEntry，而是绑定到 connectFromLocationId 的城镇 slot。 */
    readonly placement: DynamicLocationPlacement;
    readonly connectFromLocationId: string;
  };
  readonly newNpc: null | {
    readonly name: string;
    readonly role: string;
    readonly description: string;
    readonly locationRef: { readonly kind: "existing"; readonly id: string } | { readonly kind: "new_location" };
    readonly anchors: NpcIdentityAnchors;
    readonly goals: readonly NpcGoalProposal[];
    readonly relationshipSeeds: readonly NpcRelationshipSeedProposal[];
    /** Explicit public initial knowledge from existing facts; omission means none. */
    readonly existingFactIds?: readonly string[];
  };
  readonly newItem: null | { readonly name: string; readonly description: string; readonly locationRef: "current" | "new_location"; readonly acquisition?: "scene" | "npc_gift" };
  readonly newEnemy: null | { readonly name: string; readonly tier: "normal" | "boss"; readonly locationRef: "current" | "new_location" };
  readonly newFact: null | {
    readonly text: string;
    readonly visibility: "public" | "npc_private";
    /** 不泄露事实正文的第一阶段调查提示。 */
    readonly investigationLabel?: string;
    /** 复用 WorldFactEntry 的同一 InvestigationApproach 类型，不创建第二份 shape。 */
    readonly investigationApproaches?: readonly InvestigationApproach[];
  };
  readonly nextMainQuest: null | DynamicQuestProposal;
  readonly endingPair: null | readonly [DynamicEndingProposal, DynamicEndingProposal];
};

/** 应用边界明确传入的关系种子可见实体闭包；不是全量世界实体列表。 */
export type WorldDeltaEntityContextClosure = Readonly<{
  readonly mandatoryEntityIds: readonly string[];
  readonly directReferenceEntityIds: readonly string[];
  readonly currentLocationActiveNpcIds: readonly string[];
  readonly declarableExistingFactIds?: readonly string[];
}>;

/** 世界演化草稿使用的规则回合上下文；不包含时钟或随机值。 */
export type WorldDeltaEventContext = Readonly<{
  readonly turnId: TurnId;
  readonly turnNumber: number;
  readonly actionId?: string;
  readonly domainEventIds: readonly EventId[];
  readonly episodeKey?: string;
  readonly eventKey?: string;
}>;

/** 已审批的世界演化：服务端铸造品牌化 ID，并携带预览状态供场景表演构建合法选项。 */
export type ApprovedWorldDelta = {
  readonly mintedLocationIds: readonly LocationId[];
  readonly mintedNpcIds: readonly NpcId[];
  readonly mintedItemIds: readonly ItemId[];
  readonly mintedEnemyIds: readonly EnemyId[];
  readonly mintedFactIds: readonly FactId[];
  readonly mintedQuestIds: readonly QuestId[];
  readonly mintedEndingIds: readonly EndingId[];
  readonly previewWorldState: WorldState;
  readonly previewStoryState: StoryState;
  /** 预览阶段产生的草稿；最终账本只能由应用层统一提交。 */
  readonly eventDrafts: readonly NarrativeEventDraft<BlueprintExpandedPayload>[];
};
