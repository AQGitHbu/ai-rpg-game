// 玩法层场景门面：仅从这里向外暴露稳定 API，后续任务在此追加导出。
export {
  loadScenarioProfiles,
  ScenarioConfigError,
  type ArtStyleProfile,
  type GameTypeProfile,
  type RawScenarioConfig,
  type ScenarioConfigIssue,
  type ScenarioConfigIssueCode,
  type ScenarioProfiles
} from "./gameTypeProfiles";
export {
  analyzeQuestReachability,
  validateQuestGraph,
  type QuestGraphInput,
  type QuestGraphIssue,
  type QuestGraphIssueCode,
  type QuestGraphKnownEntityIds,
  type QuestReachabilityAnalysis
} from "./questGraph";
export {
  PHASE1_NUMERIC_RANGES,
  validateScenarioBlueprintCandidate,
  type NumericRange,
  type ScenarioBlueprintIssue,
  type ScenarioBlueprintIssueCode,
  type ScenarioValidationContext,
  type ValidateScenarioBlueprintResult,
  type ValidatedScenarioBlueprintCandidate
} from "./validateScenarioBlueprint";
export {
  compileScenarioBlueprint,
  initializeGameState,
  type CompileScenarioBlueprintResult
} from "./compileScenarioBlueprint";
export { createFallbackBlueprint, FALLBACK_TEMPLATE_VERSION } from "./createFallbackBlueprint";
