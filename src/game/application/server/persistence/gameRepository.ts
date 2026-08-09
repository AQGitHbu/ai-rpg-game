import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";

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
};

export type ApplyStateInput = {
  readonly gameId: GameId;
  readonly expectedRevision: number;
  readonly nextWorldState: WorldState;
  readonly nextStoryState: StoryState;
};

export type ApplySceneWriteBackInput = {
  readonly gameId: GameId;
  readonly expectedRevision: number;
  /** Ready scene and its ApprovedChoice registry travel in this same CAS payload. */
  readonly nextNarrative: StoryState["narrative"];
  readonly nextCandidateEventPool: StoryState["candidateEventPool"];
};

export type CreateInitialGameResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "ACTIVE_GAME_EXISTS" }
  | { readonly ok: false; readonly code: "INFRASTRUCTURE_FAILURE" };

export type GetCurrentGameResult =
  | { readonly ok: true; readonly status: "none" }
  | { readonly ok: true; readonly status: "active"; readonly record: GameRecord }
  | { readonly ok: true; readonly status: "corrupt"; readonly reason: CorruptGameReason }
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
  getCurrentGame(): Promise<GetCurrentGameResult>;
  applyState(input: ApplyStateInput): Promise<ApplyStateResult>;
  applySceneWriteBack(input: ApplySceneWriteBackInput): Promise<ApplySceneWriteBackResult>;
  clearCurrentGame(): Promise<ClearCurrentGameResult>;
}
