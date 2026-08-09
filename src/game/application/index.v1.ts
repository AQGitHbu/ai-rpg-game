// v1 legacy 业务门面（reference-only，v2.1 为生产链路）。
// 本文件仅承载 v1 业务 re-export（createGame/performAction/handleNpcDialogue/
// orchestrateNarrativeScene 等），供 v1 API 路由、v1 组件与 v1 测试使用。
// 这些文件从主 tsconfig 的 typecheck/build 门禁排除（R1 共享类型变更后 v1
// 产生类型漂移，仅作行为参考）。v2.1 生产链路不要从本文件导入业务函数。

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
export {
  performAction,
  type PerformActionCommand,
  type PerformActionDependencies,
  type PerformActionResult,
  type ActionFeedbackView
} from "./performAction";
export {
  handleNpcDialogue,
  type HandleNpcDialogueCommand,
  type HandleNpcDialogueDependencies,
  type HandleNpcDialogueResult
} from "./handleNpcDialogue";
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
  toTownSpatialContext,
  type DirectorContext,
  type DirectorContextInput,
  type SceneScriptContext,
  type SceneScriptContextInput,
  type NpcLineContext,
  type NpcLineContextInput,
  type TownSpatialContext,
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
export {
  generateTownDemoView,
  type GenerateTownDemoResult,
  type TownDemoStats,
  type TownDemoView
} from "./townDemo";
export {
  TOWN_PLAN_CONTRACT_VERSION,
  TOWN_PLAN_FAILURE_CATEGORIES,
  type TownPlanAttempt,
  type TownPlanCandidateSource,
  type TownPlanContractVersion,
  type TownPlanFailureCategory,
  type TownPlanRequest
} from "./townPlanGeneration";
export {
  projectTownLayerView,
  type TownInteractiveBuildingView,
  type TownLayerStats,
  type TownLayerView,
  type TownRenderSnapshot
} from "./townRuntimeView";
export {
  generatePendingTownPlan,
  TOWN_PLAN_MAX_ATTEMPTS,
  type GeneratePendingTownPlanDependencies,
  type GeneratePendingTownPlanResult
} from "./generatePendingTownPlan";
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
