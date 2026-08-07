import { describe, it, expect } from "vitest";
import { createGameV2, createFixtureWorldSource } from "./createGameV2";
import { performActionV2 } from "./performActionV2";
import { projectGameSessionView } from "./gameSessionViewV2";
import type { GameRepositoryV2, GameRecordV2 } from "./server/persistence/gameRepositoryV2";
import { asGameId } from "./server/persistence/gameRepository";
import type { Action } from "@/game/domain/action";
import { asNpcId } from "@/game/domain/scenarioBlueprint";

function createInMemoryRepo(): { repo: GameRepositoryV2; getRecord: () => GameRecordV2 | null } {
  let record: GameRecordV2 | null = null;
  return {
    repo: {
      async createInitialGame(input) {
        if (record !== null) return { ok: false, code: "ACTIVE_GAME_EXISTS" as const };
        record = { gameId: input.gameId, worldState: input.worldState, storyState: input.storyState, revision: 0, createdAt: input.createdAt };
        return { ok: true as const };
      },
      async getCurrentGame() {
        if (record === null) return { ok: true as const, status: "none" as const };
        return { ok: true as const, status: "active" as const, record };
      },
      async applyState(input) {
        if (record === null) return { ok: false, code: "NO_ACTIVE_GAME" as const };
        if (input.expectedRevision !== record.revision) return { ok: false, code: "STALE_GAME_REVISION" as const };
        record = { ...record, worldState: input.nextWorldState, storyState: input.nextStoryState, revision: record.revision + 1 };
        return { ok: true as const, record };
      },
      async applySceneWriteBack(input) {
        if (record === null) return { ok: false, code: "NO_ACTIVE_GAME" as const };
        if (input.expectedRevision !== record.revision) return { ok: false, code: "STALE_GAME_REVISION" as const };
        record = { ...record, storyState: { ...record.storyState, narrative: input.nextNarrative, candidateEventPool: input.nextCandidateEventPool }, revision: record.revision + 1 };
        return { ok: true as const, record };
      },
    },
    getRecord: () => record,
  };
}

describe("P1 offline regression: full createGame -> performAction -> view cycle", () => {
  it("creates game, performs talk action, projects view - all offline", async () => {
    const { repo, getRecord } = createInMemoryRepo();
    const gameId = asGameId("g1");
    const now = () => "2026-01-01T00:00:00Z";

    // 1. Create game with fixture source (no AI)
    const createResult = await createGameV2(
      { gameId, gameType: "wuxia", gameLength: "short", seed: "regression-test" },
      { repository: repo, source: createFixtureWorldSource(), now },
    );
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    // 2. Project initial view
    const initialRecord = getRecord()!;
    const initialView = projectGameSessionView(initialRecord.worldState, initialRecord.storyState, initialRecord.revision);
    expect(initialView.player.name).toBe("无名侠客");
    expect(initialView.currentLocation.name).toBe("起始客栈");
    expect(initialView.availableNpcs).toHaveLength(1);
    expect(initialView.availableNpcs[0]?.name).toBe("客栈老板");
    expect(initialView.availableNpcs[0]?.met).toBe(false);

    // 3. Perform talk action with fixed_choice
    const talkAction: Action = { type: "talk", npcId: asNpcId("npc_innkeeper") };
    const choiceMap = new Map([["tok_talk_innkeeper", talkAction]]);
    const actionResult = await performActionV2(
      { gameId, actionId: "act_1", interaction: { kind: "fixed_choice", choiceToken: "tok_talk_innkeeper" }, expectedRevision: 0, choiceMap },
      { repository: repo, now },
    );
    expect(actionResult.ok).toBe(true);
    if (!actionResult.ok) return;
    expect(actionResult.resolvedEvent.status).toBe("success");
    expect(actionResult.resolvedEvent.eventKind).toBe("dialogue");

    // 4. Project view after action
    const updatedRecord = getRecord()!;
    const updatedView = projectGameSessionView(updatedRecord.worldState, updatedRecord.storyState, updatedRecord.revision);
    expect(updatedView.revision).toBe(1);
    expect(updatedView.availableNpcs[0]?.met).toBe(true);
    expect(updatedView.story.tension).toBe(33); // 30 + 3 (npc_met)
  });
});
