// Entity/Component 层的公开面：类型化 store、稳定 ID 核心、固定组件、只读 selector
// 与唯一的 legacy 兼容投影。禁止反向 import worldState.ts。
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
export {
  compileEntityStoreFromCompatibilityProjection,
  EntityProjectionInvariantError,
  projectEntityStore,
  validateCompatibilityProjectionInput,
  validateEntityCompatibilityProjection,
  validateEntityReferences,
  type EntityCompatibilityProjection,
  type EntityProjectionIssue,
  type EntityReferenceIssue,
  type EntityReferenceIssueCode,
} from "./entityProjection";
