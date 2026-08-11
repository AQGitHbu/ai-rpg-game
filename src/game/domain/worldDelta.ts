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
import type { EndingRequirement, WorldState } from "./worldState";

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
  /** 结局的规则达成条件（可选；缺省为「无要求」，即始终可达）。 */
  readonly requirements?: readonly EndingRequirement[];
};

export type WorldDeltaProposal = {
  readonly beatSummary: string;
  readonly newLocation: null | {
    readonly name: string;
    readonly description: string;
    readonly scale: "scene" | "town";
    readonly connectFromLocationId: string;
  };
  readonly newNpc: null | {
    readonly name: string;
    readonly role: string;
    readonly description: string;
    readonly locationRef: { readonly kind: "existing"; readonly id: string } | { readonly kind: "new_location" };
    readonly goals: readonly string[];
  };
  readonly newItem: null | { readonly name: string; readonly description: string; readonly locationRef: "current" | "new_location" };
  readonly newEnemy: null | { readonly name: string; readonly tier: "normal" | "boss"; readonly locationRef: "current" | "new_location" };
  readonly newFact: null | { readonly text: string; readonly visibility: "public" | "npc_private" };
  readonly nextMainQuest: null | DynamicQuestProposal;
  readonly endingPair: null | readonly [DynamicEndingProposal, DynamicEndingProposal];
};

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
};
