// 应用层公共门面：UI/API 只能从这里导入游戏业务能力，后续任务在此追加导出。
// Phase 4A：候选生成纯 port（只有类型与冻结常量；server factory 不得经此导出）。
export {
  SCENARIO_CANDIDATE_CONTRACT_VERSION,
  SCENARIO_CANDIDATE_FAILURE_CATEGORIES,
  type ScenarioCandidateAttempt,
  type ScenarioCandidateContractVersion,
  type ScenarioCandidateFailureCategory,
  type ScenarioCandidateSource,
  type ScenarioGenerationEvent,
  type ScenarioGenerationRequest,
  type ScenarioGenerationSource,
  type ScenarioGenerationStage
} from "./scenarioGeneration";
export {
  createGame,
  type CreateGameCommand,
  type CreateGameDependencies,
  type CreateGameResult,
  type GenerationSource
} from "./createGame";
export {
  getCurrentGame,
  type CurrentGameResult,
  type CurrentGameUnavailableReason,
  type GetCurrentGameDependencies
} from "./getCurrentGame";
export {
  type OpeningGameView,
  type OpeningGenerationView,
  type OpeningItemView,
  type OpeningLocationView,
  type OpeningNpcView,
  type OpeningPlayerView,
  type OpeningWorldView,
  type AvailableActionView,
  type OpeningFactView
} from "./openingGameView";
// Phase 4 Task 3 + Phase 6 Task 3：语义中性的会话 read model（OpeningGameView 的演进）。
export {
  type GameSessionView,
  type SessionActionView,
  type ActiveQuestView,
  type QuestObjectiveView,
  type BattleView,
  type EndingView,
  type StoryEventView
} from "./gameSessionView";
export {
  performAction,
  type PerformActionCommand,
  type PerformActionDependencies,
  type PerformActionResult,
  type ActionFeedbackView
} from "./performAction";
// UI 端预校验经由 application facade 中转，禁止直连 domain。
export {
  validateNewGameInput,
  type NewGameInput,
  type NewGameInputError,
  type ValidateNewGameInputResult
} from "@/game/domain";
// Phase 3: API handler 需要品牌化 ID 转换与 PlayerIntent 类型（Phase 5 追加 itemId，Phase 6 追加 enemyId）。
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
// Town demo（Task 7）：小镇 demo 投影门面 + 预留生图 port（生产实现恒 not_requested）。
export {
  generateTownDemoView,
  type GenerateTownDemoResult,
  type TownDemoStats,
  type TownDemoView
} from "./townDemo";
// Town demo（Task 8）：UI 渲染地图/档案所需的 domain 类型与纯索引函数经门面中转。
export {
  tileIndex,
  type TileType,
  type TownSnapshot,
  type TownBuilding,
  type TownBuildingType
} from "@/game/domain";
export {
  TOWN_ASSET_CONTRACT_VERSION,
  createUnavailableTownIllustrationSource,
  type TownAssetKind,
  type TownAssetRequest,
  type TownAssetResult,
  type TownAssetStatus,
  type TownIllustrationSource
} from "./townAssets";
export {
  asGameId,
  type ApplyResolvedActionInput,
  type ApplyResolvedActionResult,
  type ClearCurrentGameResult,
  type DevelopmentGameRepository,
  type CorruptGameReason,
  type CreateInitialGameInput,
  type CreateInitialGameResult,
  type GameId,
  type GameRecord,
  type GameRepository,
  type GetCurrentGameRecordResult
} from "./server/persistence/gameRepository";
