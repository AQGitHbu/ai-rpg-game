// 领域层公共门面：仅从这里向外暴露稳定 API，后续任务在此追加导出。
export {
  validateNewGameInput,
  type GameTypeId,
  type NarrativeStyle,
  type ContentIntensity,
  type NewGameInput,
  type NewGameInputError,
  type NewGameInputErrorCode,
  type ValidatedNewGameInput,
  type ValidateNewGameInputResult
} from "./newGame";
