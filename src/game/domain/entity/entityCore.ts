import type {
  EnemyId, FactionId, FactId, ItemId, LocationId, NpcId, PlayerEntityId, QuestId,
} from "../worldEntity";

/** Entity Store 支持的八类实体。禁止动态新增 kind。 */
export type EntityKind =
  | "player_character"
  | "npc"
  | "location"
  | "item"
  | "enemy"
  | "faction"
  | "quest"
  | "fact";

/**
 * 实体生命周期。Plan 2 只开放 NPC 的 active/inactive 切换；
 * resolved/destroyed 保留在 core 模型中供后续实体类型使用。
 */
export type EntityLifecycle = "active" | "inactive" | "resolved" | "destroyed";

/** 全局唯一引用键：一个 ID 在整个 store 内只属于一个实体。 */
export type EntityId =
  | PlayerEntityId
  | NpcId
  | LocationId
  | ItemId
  | EnemyId
  | FactionId
  | QuestId
  | FactId;

/** 每个实体共享的稳定核心；可变事实一律放在类型化组件里。 */
export type EntityCore<Id extends EntityId, Kind extends EntityKind> = Readonly<{
  id: Id;
  kind: Kind;
  name: string;
  createdAtTurn: number;
  lifecycle: EntityLifecycle;
}>;
