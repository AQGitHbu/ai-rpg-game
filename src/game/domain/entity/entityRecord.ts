import type {
  EnemyId, FactionId, FactId, ItemId, LocationId, NpcId, PlayerEntityId, QuestId,
} from "../worldEntity";
import type { EntityCore } from "./entityCore";
import type {
  EnemyComponent, FactionComponent, FactComponent, ItemPresentationComponent, LocationComponent,
  NpcIdentityComponent, PlayerIdentityComponent, PossessionComponent,
  PositionComponent, QuestComponent,
} from "./entityComponents";
import type {
  NpcDynamicStateComponent, NpcHistoryComponent, NpcKnowledgeComponent, NpcRelationshipComponent,
} from "./npcComponents";

// ---------------------------------------------------------------------------
// EntityRecord 是 8 分支判别联合：每个分支只携带该 kind 合法的组件。
// 合法的组件集合由 kind 唯一决定，validator 以此拒绝多余/缺失组件。
// ---------------------------------------------------------------------------

export type PlayerEntityRecord = Readonly<{
  core: EntityCore<PlayerEntityId, "player_character">;
  identity: PlayerIdentityComponent;
  position: PositionComponent;
}>;

export type NpcEntityRecord = Readonly<{
  core: EntityCore<NpcId, "npc">;
  identity: NpcIdentityComponent;
  position: PositionComponent;
  dynamicState: NpcDynamicStateComponent;
  knowledge: NpcKnowledgeComponent;
  relationships: NpcRelationshipComponent;
  history: NpcHistoryComponent;
}>;

export type LocationEntityRecord = Readonly<{
  core: EntityCore<LocationId, "location">;
  location: LocationComponent;
}>;

export type ItemEntityRecord = Readonly<{
  core: EntityCore<ItemId, "item">;
  presentation: ItemPresentationComponent;
  possession: PossessionComponent;
}>;

export type EnemyEntityRecord = Readonly<{
  core: EntityCore<EnemyId, "enemy">;
  enemy: EnemyComponent;
  position: PositionComponent;
}>;

export type FactionEntityRecord = Readonly<{
  core: EntityCore<FactionId, "faction">;
  faction: FactionComponent;
}>;

export type QuestEntityRecord = Readonly<{
  core: EntityCore<QuestId, "quest">;
  quest: QuestComponent;
}>;

export type FactEntityRecord = Readonly<{
  core: EntityCore<FactId, "fact">;
  fact: FactComponent;
}>;

export type EntityRecord =
  | PlayerEntityRecord
  | NpcEntityRecord
  | LocationEntityRecord
  | ItemEntityRecord
  | EnemyEntityRecord
  | FactionEntityRecord
  | QuestEntityRecord
  | FactEntityRecord;
