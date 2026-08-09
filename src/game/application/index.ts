// 应用层公共门面：UI/API 只能从这里导入游戏业务能力。

// Phase 4 Task 3 + Phase 6 Task 3：语义中性的会话 read model。
export {
  type GameSessionView,
} from "./gameSessionView";
// Task 4 会把尚未迁移的视觉组件直接改为消费上方 read model；在此之前，
// 兼容形状只用于既有视觉组件，不能作为 server/API 契约。
export {
  type GameSessionView as CompatibilityGameSessionView,
  type SessionActionView,
  type ActiveQuestView,
  type QuestObjectiveView,
  type BattleView,
  type EndingView,
  type InventoryItemView,
  type StoryEventView,
  type NarrativeSceneView
} from "./gameSessionCompatibilityView";
export type { NarrativeGenerationProgress } from "./narrativeProgressTypes";
// 背包富视图的展示元数据基础类型：UI 经由 facade 中转，禁止直连 domain。
export {
  type ItemCategory,
  type ItemIconKey,
  type ItemRarity,
  type ItemStatLine
} from "@/game/domain";
// Phase 7 Task 3：地图 / 地点场景 / 安全对话 read model 只读 view 类型。
export {
  type LocationAdventureView,
  type LocationSceneView,
  type NpcDialogueView,
  type DialogueChoiceView,
  type SceneInteractionView,
  type SceneSlot,
  type TownLayerStatus,
  type WorldMapView,
  type WorldMapNodeView
} from "./locationAdventureView";
// Task 8：town 主循环 UI 只读 view 类型（来源模块无类型漂移，可安全经门面中转）。
export {
  type TownLayerStats,
  type TownLayerView,
  type TownInteractiveBuildingView,
  type TownRenderSnapshot
} from "./townRuntimeView";
// UI 端预校验经由 application facade 中转，禁止直连 domain。
export {
  validateNewGameInput,
  type NewGameInput,
  type NewGameInputError,
  type ValidateNewGameInputResult
} from "@/game/domain";
export {
  createBudgetPolicy,
  budgetPolicyOf,
  finalMainActOf,
  LEGACY_BUDGET_POLICY,
  type BudgetPolicy
} from "@/game/domain";
// Phase 3: API handler 需要品牌化 ID 转换与 PlayerIntent 类型。
export {
  asLocationId,
  asNpcId,
  asFactId,
  asItemId,
  asEnemyId,
  type LocationId,
  type NpcId,
  type FactId,
  type ItemId,
  type EnemyId
} from "@/game/domain";
export { type PlayerIntent } from "@/game/gameplay/rpg/actions";
// Town demo（Task 8）：UI 渲染地图/档案所需的 domain 类型与纯索引函数经门面中转。
export {
  tileIndex,
  type TileType,
  type TownSnapshot,
  type TownBuilding,
  type TownBuildingType
} from "@/game/domain";
// Town 主循环：UI 消费语义投影与规划来源类型经门面中转。
export {
  type TownCompassArea,
  type TownSemanticBuilding,
  type TownSemanticView
} from "@/game/gameplay/rpg/town";
export { type TownPlanSource, type TownSemanticPlan } from "@/game/domain";
// 纯端口（server persistence 契约）：来源模块无类型漂移，UI/API 可安全经门面中转。
export {
  asGameId,
  type ApplySceneWriteBackInput,
  type ApplySceneWriteBackResult,
  type ApplyStateInput,
  type ApplyStateResult,
  type ClearCurrentGameResult,
  type CorruptGameReason,
  type CreateInitialGameInput,
  type CreateInitialGameResult,
  type GameId,
  type GameRecord,
  type GameRepository,
  type GetCurrentGameResult
} from "./server/persistence/gameRepository";
