import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { GameId, CorruptGameReason } from "./gameRepository";

export type GameRecordV2 = {
  readonly gameId: GameId;
  readonly worldState: WorldState;
  readonly storyState: StoryState;
  readonly revision: number;
  readonly createdAt: string;
};

export type CreateInitialGameV2Input = {
  readonly gameId: GameId;
  readonly worldState: WorldState;
  readonly storyState: StoryState;
  readonly createdAt: string;
};

export type ApplyStateV2Input = {
  readonly gameId: GameId;
  readonly expectedRevision: number;
  readonly nextWorldState: WorldState;
  readonly nextStoryState: StoryState;
};

export type ApplySceneWriteBackInput = {
  readonly gameId: GameId;
  readonly expectedRevision: number;
  readonly nextNarrative: StoryState["narrative"];
  readonly nextCandidateEventPool: StoryState["candidateEventPool"];
};

export type CreateInitialGameV2Result =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "ACTIVE_GAME_EXISTS" }
  | { readonly ok: false; readonly code: "INFRASTRUCTURE_FAILURE" };

export type GetCurrentGameV2Result =
  | { readonly ok: true; readonly status: "none" }
  | { readonly ok: true; readonly status: "active"; readonly record: GameRecordV2 }
  | { readonly ok: true; readonly status: "corrupt"; readonly reason: CorruptGameReason }
  | { readonly ok: false; readonly code: "INFRASTRUCTURE_FAILURE" };

export type ApplyStateV2Result =
  | { readonly ok: true; readonly record: GameRecordV2 }
  | { readonly ok: false; readonly code: "STALE_GAME_REVISION" }
  | { readonly ok: false; readonly code: "NO_ACTIVE_GAME" }
  | { readonly ok: false; readonly code: "INFRASTRUCTURE_FAILURE" };

export type ApplySceneWriteBackResult = ApplyStateV2Result;

export interface GameRepositoryV2 {
  createInitialGame(input: CreateInitialGameV2Input): Promise<CreateInitialGameV2Result>;
  getCurrentGame(): Promise<GetCurrentGameV2Result>;
  applyState(input: ApplyStateV2Input): Promise<ApplyStateV2Result>;
  applySceneWriteBack(input: ApplySceneWriteBackInput): Promise<ApplySceneWriteBackResult>;
}
