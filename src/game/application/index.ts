// 客户端可达 application facade：只导出中性 read model 与开局输入类型。
export type { GameSessionView, NpcDialogueView, PlayerChoiceView } from "./gameSessionView";
export type { NewGameInput } from "@/game/domain/newGame";

// 纯持久化端口经 facade 暴露给 application contract tests；不加载 server adapter。
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
  type ReplaceCurrentGameInput,
  type ReplaceCurrentGameResult,
  type GameId,
  type GameRecord,
  type GameRepository,
  type GetCurrentGameResult,
} from "./server/persistence/gameRepository";
