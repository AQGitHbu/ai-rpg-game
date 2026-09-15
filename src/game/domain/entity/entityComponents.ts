import type {
  EnemyTier, FactSource, ItemCategory, ItemRarity, ItemStatLine, LocationKind, LocationScale,
  LocationId, NpcId, PlayerEntityId, StatBlock,
} from "../worldEntity";
import type { InvestigationApproach, QuestObjective, QuestOutcome, QuestEntry } from "../worldEntries";
import type { NpcIdentityAnchors } from "./npcComponents";
import type { TownRuntimeState } from "../townState";
import type { StoryInteraction } from "../storyInteraction";

// ---------------------------------------------------------------------------
// 固定组件：字段一律命名，不存在动态组件字典、任意 patch 或未信任 JSON 直通。
// 组件只持有事实，不持有引用身份（身份在 EntityCore）。
// 本文件逐字段复用 worldEntries 的稳定类型，投影必须逐字可逆。
// ---------------------------------------------------------------------------

export type PositionComponent = Readonly<{
  locationId: LocationId;
  /** 当前地点成员列表内的稳定顺序；player 固定为 0。 */
  locationOrder: number;
}>;

export type PlayerIdentityComponent = Readonly<{ identity: string; stats: StatBlock }>;

/** Minimal player-side knowledge index; never inferred from another actor's knowledge. */
export type PlayerKnowledgeComponent = Readonly<{
  knownFactIds: readonly import("../worldEntity").FactId[];
}>;

export type NpcIdentityComponent = Readonly<{
  role: string;
  description: string;
  tags: readonly string[];
  /** Plan 3：长期人格锚点，不随回合漂移；validator 见 npcComponents.validateNpcIdentityAnchors。 */
  anchors: NpcIdentityAnchors;
}>;

/** Server-approved finite interaction definitions; runtime state remains in the other NPC components. */
export type NpcInteractionsComponent = readonly StoryInteraction[];

export type LocationComponent = Readonly<{
  description: string;
  kind: LocationKind;
  /** LocationEntry.scale 可选；保留缺省形状，读模型仍用 locationScaleOf() 解析为 scene。 */
  scale?: LocationScale;
  connectedLocationIds: readonly LocationId[];
  tags: readonly string[];
  town?: TownRuntimeState;
  unlocked: boolean;
  visited: boolean;
}>;

export type ItemPresentationComponent = Readonly<{
  description: string;
  kind: string;
  tags: readonly string[];
  category?: ItemCategory;
  rarity?: ItemRarity;
  level?: number;
  statLines?: readonly ItemStatLine[];
}>;

/** owner 是物品唯一归属来源：npc/none 既不进 inventory 也不进任何 availableItemIds。 */
export type ItemOwner =
  | Readonly<{ kind: "player"; playerId: PlayerEntityId }>
  | Readonly<{ kind: "location"; locationId: LocationId }>
  | Readonly<{ kind: "npc"; npcId: NpcId }>
  | Readonly<{ kind: "none" }>;

export type PossessionComponent = Readonly<{
  owner: ItemOwner;
  quantity: number;
  /** 当前 owner 容器内的稳定顺序；owner=none 时固定为 0。 */
  ownerOrder: number;
}>;

export type EnemyComponent = Readonly<{
  tier: EnemyTier;
  stats: StatBlock;
  tags: readonly string[];
  /** defeatedEnemyIds 的唯一来源，必须与 core.lifecycle 一致。 */
  defeated: boolean;
}>;

export type FactionComponent = Readonly<{ attitudeToPlayer: number }>;

export type QuestComponent = Readonly<{
  description: string;
  objectives: readonly QuestObjective[];
  onSuccess: QuestOutcome;
  onFailure: QuestOutcome;
  tags: readonly string[];
  kind: QuestEntry["kind"];
  stage?: number;
  /** status 与 core.lifecycle 单向确定映射，validator 拒绝漂移。 */
  status: QuestEntry["status"];
}>;

export type FactComponent = Readonly<{
  /** 私密事实正文只存在这里，core.name 不得复制。 */
  text: string;
  source: FactSource;
  discovered: boolean;
  /** 未声明的旧兼容投影按 automatic 读取；新事实由生产者显式声明。 */
  discoveryMode?: "automatic" | "investigation";
  locationId?: LocationId;
  investigationLabel?: string;
  investigationApproaches?: readonly InvestigationApproach[];
}>;
