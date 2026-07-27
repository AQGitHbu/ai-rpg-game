// 应用层公共门面：UI/API 只能从这里导入游戏业务能力，后续任务在此追加导出。
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
  type OpeningWorldView
} from "./openingGameView";
export {
  asGameId,
  type CorruptGameReason,
  type CreateInitialGameInput,
  type CreateInitialGameResult,
  type GameId,
  type GameRecord,
  type GameRepository,
  type GetCurrentGameRecordResult
} from "./server/persistence/gameRepository";
