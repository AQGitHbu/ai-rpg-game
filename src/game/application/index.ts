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
  type InventoryItemView,
  type StoryEventView,
  type NarrativeSceneView
} from "./gameSessionView";
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
  type WorldMapView,
  type WorldMapNodeView
} from "./locationAdventureView";
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
// Phase 10 Task 3：运行时导演 / 编剧 / 演员 contracts 与 contexts。
export {
  NARRATIVE_CONTRACT_VERSION,
  NARRATIVE_FAILURE_CATEGORIES,
  type NarrativeContractVersion,
  type NarrativeFailureCategory,
  type NarrativeDiagnostics,
  type DirectorRequest,
  type DirectorAttempt,
  type DirectorSource,
  type SceneScriptRequest,
  type SceneScriptAttempt,
  type SceneScriptSource,
  type NpcLineRequest,
  type NpcLineAttempt,
  type NpcLineSource,
} from "./runtimeNarrative";
export {
  toDirectorContext,
  toSceneScriptContext,
  toNpcLineContext,
  type DirectorContext,
  type DirectorContextInput,
  type SceneScriptContext,
  type SceneScriptContextInput,
  type NpcLineContext,
  type NpcLineContextInput,
} from "./runtimeNarrativeContexts";
export {
  orchestrateNarrativeScene,
  type OrchestrateNarrativeSceneInput,
  type OrchestrateSceneResult,
} from "./orchestrateNarrativeScene";
export {
  generatePendingNarrativeScene,
  type GeneratePendingNarrativeSceneDependencies,
  type GeneratePendingNarrativeSceneResult,
} from "./generatePendingNarrativeScene";
export {
  getOrCreateScene,
  type GetOrCreateSceneInput,
  type GetOrCreateSceneResult,
} from "./getOrCreateScene";
export {
  JOURNEY_REPORT_VERSION,
  JOURNEY_ISSUE_CODES,
  validateJourneyReport,
  toJourneySummary,
  type JourneyCoverage,
  type JourneyIssueCode,
  type JourneyReport,
} from "./testing/runtimeNarrativeJourney";
export { type PlayerIntent } from "@/game/gameplay/rpg/actions";
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
