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
