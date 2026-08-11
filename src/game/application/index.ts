// 客户端可达 application facade：只导出中性 read model 与开局输入类型。
export type { GameSessionView, NpcDialogueView, PlayerChoiceView } from "./gameSessionView";
export type { TownView, InteractiveBuildingEntry, TownRenderSnapshot } from "./townView";
export { tileIndex } from "@/game/domain/townState";
export type { TileType } from "@/game/domain/townState";
export type { NewGameInput } from "@/game/domain/newGame";
// 客户端预校验：与 server 同一校验器，UI 层经 facade 使用（禁止 deep-import domain）。
export { validateNewGameInput, type NewGameInputError } from "@/game/domain/newGame";
// 开局呈现政策：表单与提示词共用的六个性格标签与政策映射（纯呈现，不触规则）。
export { PERSONALITY_TRAIT_OPTIONS, buildStylePolicy, type StylePolicy } from "./stylePolicy";

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
