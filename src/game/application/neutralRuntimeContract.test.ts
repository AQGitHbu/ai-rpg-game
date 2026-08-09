/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { createGame } from "./createGame";
import { generatePendingScene } from "./generatePendingScene";
import { projectGameSessionView, type GameSessionView } from "./gameSessionView";
import {
  createServerGameEntryPoints,
  getServerGameEntryPoints,
  type ServerGameEntryPoints,
} from "./server/compositionRoot";
import type {
  ApplySceneWriteBackInput,
  ApplyStateInput,
  ApplyStateResult,
  ClearCurrentGameResult,
  CreateInitialGameInput,
  CreateInitialGameResult,
  GameRecord,
  GameRepository,
  GetCurrentGameResult,
} from "./server/persistence/gameRepository";
import { createSqliteGameRepository } from "./server/persistence/sqliteGameRepository";

describe("neutral runtime public contract", () => {
  it("exposes only neutral production entry-point names", () => {
    expect(typeof createGame).toBe("function");
    expect(typeof generatePendingScene).toBe("function");
    expect(typeof projectGameSessionView).toBe("function");
    expect(typeof createServerGameEntryPoints).toBe("function");
    expect(typeof getServerGameEntryPoints).toBe("function");
    expect(typeof createSqliteGameRepository).toBe("function");
  });

  it("keeps the neutral repository and session-view types importable", () => {
    type RepositoryContract = GameRepository & {
      createInitialGame(input: CreateInitialGameInput): Promise<CreateInitialGameResult>;
      getCurrentGame(): Promise<GetCurrentGameResult>;
      applyState(input: ApplyStateInput): Promise<ApplyStateResult>;
      applySceneWriteBack(input: ApplySceneWriteBackInput): Promise<ApplyStateResult>;
      clearCurrentGame(): Promise<ClearCurrentGameResult>;
    };
    const compileOnly = null as unknown as {
      repository: RepositoryContract;
      record: GameRecord;
      view: GameSessionView;
      entryPoints: ServerGameEntryPoints;
    };
    expect(compileOnly).toBeNull();
  });
});
