import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { GameTypeId } from "@/game/domain/newGame";
import type { OpeningNoveltyRecord } from "@/game/domain/openingNovelty";

declare const gameIdBrand: unique symbol;

export type GameId = string & { readonly [gameIdBrand]: true };

export function asGameId(raw: string): GameId {
  return raw as GameId;
}

export type CorruptGameReason =
  | "UNPARSEABLE_RECORD"
  | "VERSION_MISMATCH"
  | "UNSUPPORTED_RECORD";

export type GameRecord = {
  readonly gameId: GameId;
  readonly worldState: WorldState;
  readonly storyState: StoryState;
  readonly revision: number;
  readonly createdAt: string;
};

export type CreateInitialGameInput = {
  readonly gameId: GameId;
  readonly worldState: WorldState;
  readonly storyState: StoryState;
  readonly createdAt: string;
  /** 与新存档原子写入的开局指纹；清档时保留历史，避免新局重复。 */
  readonly openingHistory?: OpeningNoveltyRecord;
};

/**
 * Atomically install a freshly compiled game in place of the current one.
 * Both the active id and revision participate in the CAS so a failed restart
 * can never clear or overwrite the ended save the player was viewing.
 */
export type ReplaceCurrentGameInput = CreateInitialGameInput & {
  readonly expectedCurrentGameId: GameId;
  readonly expectedRevision: number;
};

export type ApplyStateInput = {
  readonly gameId: GameId;
  readonly expectedRevision: number;
  readonly nextWorldState: WorldState;
  readonly nextStoryState: StoryState;
  /**
   * 是否递增 revision（默认 true）。仅用于"不改变世界状态"的元数据更新
   * （如 ackPrologue 的 prologueShown 标记）：递增会破坏基于旧 revision
   * 铸造的 choiceToken，导致当前场景固定选项全部失效。
   */
  readonly incrementRevision?: boolean;
};

/**
 * 场景写回：与 applyState 同构的 single CAS——一次原子更新 world_state_json 与
 * story_state_json 两列并把 revision + 1（CAS 走 WHERE game_id AND revision）。
 * 世界演化（materializeWorldDelta 装配的预览状态）与场景包一并在此落盘。
 */
export type ApplySceneWriteBackInput = {
  readonly gameId: GameId;
  readonly expectedRevision: number;
  readonly nextWorldState: WorldState;
  readonly nextStoryState: StoryState;
};

export type CreateInitialGameResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "ACTIVE_GAME_EXISTS" }
  | { readonly ok: false; readonly code: "INFRASTRUCTURE_FAILURE" };

export type ReplaceCurrentGameResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "NO_ACTIVE_GAME" }
  | { readonly ok: false; readonly code: "STALE_GAME_REVISION" }
  | { readonly ok: false; readonly code: "INFRASTRUCTURE_FAILURE" };

export type GetCurrentGameResult =
  | { readonly ok: true; readonly status: "none" }
  | { readonly ok: true; readonly status: "active"; readonly record: GameRecord }
  | { readonly ok: true; readonly status: "corrupt"; readonly reason: CorruptGameReason }
  | { readonly ok: false; readonly code: "INFRASTRUCTURE_FAILURE" };

export type ListOpeningHistoryResult =
  | { readonly ok: true; readonly records: readonly OpeningNoveltyRecord[] }
  | { readonly ok: false; readonly code: "INFRASTRUCTURE_FAILURE" };

export type ApplyStateResult =
  | { readonly ok: true; readonly record: GameRecord }
  | { readonly ok: false; readonly code: "STALE_GAME_REVISION" }
  | { readonly ok: false; readonly code: "NO_ACTIVE_GAME" }
  | { readonly ok: false; readonly code: "INFRASTRUCTURE_FAILURE" };

export type ApplySceneWriteBackResult = ApplyStateResult;

export type ClearCurrentGameResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "INFRASTRUCTURE_FAILURE" };

export interface GameRepository {
  createInitialGame(input: CreateInitialGameInput): Promise<CreateInitialGameResult>;
  replaceCurrentGame(input: ReplaceCurrentGameInput): Promise<ReplaceCurrentGameResult>;
  getCurrentGame(): Promise<GetCurrentGameResult>;
  applyState(input: ApplyStateInput): Promise<ApplyStateResult>;
  applySceneWriteBack(input: ApplySceneWriteBackInput): Promise<ApplySceneWriteBackResult>;
  clearCurrentGame(): Promise<ClearCurrentGameResult>;
  /** 生产 SQLite 实现提供；轻量 fixture repository 可省略。 */
  listOpeningHistory?(input: {
    readonly gameType: GameTypeId;
    readonly limit: number;
  }): Promise<ListOpeningHistoryResult>;
}
