import { describe, expect, it } from "vitest";
import { createFixtureOpeningCandidateSource, createFixtureOpeningSource, createGame } from "../createGame";
import type { NarrativeBundleSourceContext } from "../narrativeBundleSource";
import type { GameRecord, GameRepository } from "../server/persistence/gameRepository";
import { asGameId } from "../server/persistence/gameRepository";
import { createOpeningNoveltyRecord } from "@/game/domain/openingNovelty";

function createRepo(history: readonly ReturnType<typeof createOpeningNoveltyRecord>[] = []): {
  readonly repo: GameRepository;
  readonly getRecord: () => GameRecord | null;
  readonly history: ReturnType<typeof createOpeningNoveltyRecord>[];
} {
  let record: GameRecord | null = null;
  const persistedHistory = [...history];
  const repo: GameRepository = {
    async createInitialGame(input) {
      record = { gameId: input.gameId, worldState: input.worldState, storyState: input.storyState, revision: 0, createdAt: input.createdAt };
      if (input.openingHistory !== undefined) persistedHistory.push(input.openingHistory);
      return { ok: true };
    },
    async getCurrentGame() {
      return record === null ? { ok: true as const, status: "none" as const } : { ok: true as const, status: "active" as const, record };
    },
    async applyState(input) {
      if (record === null || input.expectedRevision !== record.revision) return { ok: false, code: "STALE_GAME_REVISION" as const };
      record = { ...record, worldState: input.nextWorldState, storyState: input.nextStoryState, revision: record.revision + 1 };
      return { ok: true, record };
    },
    async applySceneWriteBack(input) {
      if (record === null || input.expectedRevision !== record.revision) return { ok: false, code: "STALE_GAME_REVISION" as const };
      record = { ...record, worldState: input.nextWorldState, storyState: input.nextStoryState, revision: record.revision + 1 };
      return { ok: true, record };
    },
    async clearCurrentGame() { record = null; return { ok: true }; },
    async replaceCurrentGame() { return { ok: false, code: "STALE_GAME_REVISION" as const }; },
    async listOpeningHistory() { return { ok: true as const, records: [...persistedHistory].reverse() }; },
  };
  return { repo, getRecord: () => record, history: persistedHistory };
}

async function createOpening(seed: string): Promise<GameRecord> {
  const { repo, getRecord } = createRepo();
  const result = await createGame(
    { gameId: asGameId(`opening-${seed}`), gameType: "wuxia", gameLength: "short", seed },
    { repository: repo, source: createFixtureOpeningSource(), now: () => "2026-01-01" },
  );
  expect(result.ok).toBe(true);
  return getRecord()!;
}

describe("opening novelty journey", () => {
  it("不同 seed 产生不同的自然生成开局结构，且建筑名来自候选而非城镇默认名", async () => {
    const records = await Promise.all(
      Array.from({ length: 12 }, (_, index) => createOpening(`natural-seed-${index}`)),
    );
    const signatures = records.map((record) => {
      const location = record.worldState.locations[0]!;
      const npc = record.worldState.npcs[0]!;
      const quest = record.worldState.quests[0]!;
      return [location.name, npc.name, location.town?.slots[0]?.displayName, quest.name].join("|");
    });

    expect(new Set(signatures).size).toBeGreaterThanOrEqual(4);
    expect(signatures.every((signature) => !signature.includes("福来酒楼"))).toBe(true);
  });

  it("同一 seed 且同一重试次数可重放", async () => {
    const first = await createOpening("replay-opening-seed");
    const replay = await createOpening("replay-opening-seed");
    expect(replay.worldState).toEqual(first.worldState);
    expect(replay.storyState).toEqual(first.storyState);
  });

  it("清档后保留开局历史：同一 seed 会进入新的结构候选，而不是复用首局", async () => {
    const { repo, getRecord, history } = createRepo();
    const source = createFixtureOpeningSource();
    const input = { gameType: "wuxia" as const, gameLength: "short" as const };

    const firstResult = await createGame(
      { ...input, gameId: asGameId("clear-history-first"), seed: "clear-history-seed" },
      { repository: repo, source, now: () => "2026-01-01" },
    );
    expect(firstResult.ok).toBe(true);
    const first = getRecord()!;
    expect((await repo.clearCurrentGame()).ok).toBe(true);

    const secondResult = await createGame(
      { ...input, gameId: asGameId("clear-history-second"), seed: "clear-history-seed" },
      { repository: repo, source, now: () => "2026-01-02" },
    );
    expect(secondResult.ok).toBe(true);
    const second = getRecord()!;

    expect(history).toHaveLength(2);
    expect(second.worldState.generation.openingAttempt ?? 0).toBeGreaterThanOrEqual(0);
    expect(second.worldState).not.toEqual(first.worldState);
    expect(second.worldState.npcs[0]?.name).not.toBe(first.worldState.npcs[0]?.name);
  });

  it("novelty retry keeps the complete setup and includes the rejected candidate summary", async () => {
    const seed = "retry-preserves-opening-context";
    const setup = {
      characterName: "林舟", characterIdentity: "领航员", characterProfile: "曾在船厂修理引擎。",
      personalityTags: ["冷静", "多疑"], worldPremise: "殖民卫星依靠老旧轨道港维持补给。",
      storyOpening: "林舟发现一份署有自己名字的陌生维修清单。",
      narrativeStyle: "cinematic" as const, contentIntensity: "dark" as const,
    };
    const existing = await createFixtureOpeningCandidateSource().generate({
      gameType: "science_fiction", gameLength: "short", seed, setup,
      novelty: { recent: [], attempt: 0 }, attempt: 0,
    });
    const historyRecord = createOpeningNoveltyRecord({
      candidate: existing, gameType: "science_fiction", createdAt: "2026-09-08T00:00:00.000Z",
    });
    const { repo } = createRepo([historyRecord]);
    const fixture = createFixtureOpeningSource();
    const calls: Extract<NarrativeBundleSourceContext, { kind: "opening" }>[] = [];

    const result = await createGame(
      { gameId: asGameId("retry-context"), gameType: "science_fiction", gameLength: "short", seed, setup },
      {
        repository: repo,
        now: () => "2026-09-09T00:00:00.000Z",
        source: {
          async generate(context) {
            if (context.kind === "opening") calls.push(context);
            if (context.kind === "opening" && calls.length === 1) {
              return fixture.generate({
                ...context,
                input: { ...context.input, novelty: { recent: [], attempt: 0 }, attempt: 0 },
              });
            }
            return fixture.generate(context);
          },
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.input.setup)).toEqual([setup, setup]);
    expect(calls[1]!.input.novelty?.attempt).toBe(1);
    expect(calls[1]!.input.novelty?.recent).toHaveLength(2);
    expect(calls[1]!.input.novelty?.recent.at(-1)?.summary).toBe(historyRecord.summary);
  });
});
