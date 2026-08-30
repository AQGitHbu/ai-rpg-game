// Entity/Component 层的公开面：类型化 store、稳定 ID 核心、固定组件与只读 selector。
// 禁止反向 import worldState.ts；兼容投影在 entityProjection.ts（Task 2）中登记。
export type { EntityCore, EntityId, EntityKind, EntityLifecycle } from "./entityCore";
export type {
  EnemyComponent,
  FactionComponent,
  FactComponent,
  ItemOwner,
  ItemPresentationComponent,
  LocationComponent,
  NpcIdentityComponent,
  NpcStateComponent,
  PlayerIdentityComponent,
  PossessionComponent,
  PositionComponent,
  QuestComponent,
} from "./entityComponents";
export type {
  EnemyEntityRecord,
  EntityRecord,
  FactionEntityRecord,
  FactEntityRecord,
  ItemEntityRecord,
  LocationEntityRecord,
  NpcEntityRecord,
  PlayerEntityRecord,
  QuestEntityRecord,
} from "./entityRecord";
export {
  createEntityStore,
  entitiesOfKind,
  EntityStoreInvariantError,
  getEntity,
  parseEntityStore,
  validateEntityStoreStructure,
  type EntityStore,
  type EntityStoreValidationCode,
  type EntityStoreValidationIssue,
  type ParseEntityStoreResult,
} from "./entityStore";
