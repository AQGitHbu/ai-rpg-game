import { describe, it, expect } from "vitest";
import { createGame, createFixtureWorldSource, parseGameSetup } from "./createGame";
import type { GameId, GameRepository, GameRecord } from "./server/persistence/gameRepository";
import { asGameId } from "./server/persistence/gameRepository";
import type { GameLength, GameTypeId } from "@/game/domain/newGame";
import { resolveEnding } from "@/game/gameplay/rpg/ruleEngine/resolveEnding";

function createInMemoryRepo(): { repo: GameRepository; getRecord: () => GameRecord | null } {
  let record: GameRecord | null = null;
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
      async clearCurrentGame() { return { ok: true as const }; },
      async replaceCurrentGame(input: {
        expectedCurrentGameId: GameId;
        expectedRevision: number;
        gameId: GameId;
        worldState: GameRecord["worldState"];
        storyState: GameRecord["storyState"];
        createdAt: string;
      }) {
        if (record === null) return { ok: false as const, code: "NO_ACTIVE_GAME" as const };
        if (record.gameId !== input.expectedCurrentGameId || record.revision !== input.expectedRevision) {
          return { ok: false as const, code: "STALE_GAME_REVISION" as const };
        }
        record = { gameId: input.gameId, worldState: input.worldState, storyState: input.storyState, revision: 0, createdAt: input.createdAt };
        return { ok: true as const };
      },
    },
    getRecord: () => record,
  };
}

async function createPersistedGame(input: {
  readonly seed: string;
  readonly gameType?: GameTypeId;
  readonly gameLength?: GameLength;
}): Promise<GameRecord> {
  const { repo, getRecord } = createInMemoryRepo();
  const result = await createGame(
    {
      gameId: asGameId("compiled-proof"),
      gameType: input.gameType ?? "wuxia",
      gameLength: input.gameLength ?? "short",
      seed: input.seed,
    },
    { repository: repo, source: createFixtureWorldSource(), now: () => "2026-01-01" },
  );
  expect(result.ok).toBe(true);
  const record = getRecord();
  expect(record).not.toBeNull();
  return record!;
}

function structuralSignature(record: GameRecord) {
  return {
    world: record.worldState.worldFacts.map((fact) => [fact.factId, fact.text]),
    npcIdentity: record.worldState.npcs.map((npc) => [npc.id, npc.name, npc.role]),
    questGraph: record.worldState.quests.map((quest) => [quest.id, quest.name, quest.stage, quest.objectives, quest.onSuccess]),
    locations: record.worldState.locations.map((location) => [location.id, location.name, location.connectedLocationIds]),
    enemies: record.worldState.enemies.map((enemy) => [enemy.id, enemy.name, enemy.locationId]),
    endingPredicates: record.worldState.endings.map((ending) => ending.requirements),
  };
}

describe("createGame", () => {
  it("persists byte-equivalent compiled state for one seed and structural differences for another", async () => {
    const first = await createPersistedGame({ seed: "branching-seed-alpha" });
    const replay = await createPersistedGame({ seed: "branching-seed-alpha" });
    const other = await createPersistedGame({ seed: "branching-seed-beta" });
    const gamma = await createPersistedGame({ seed: "branching-seed-gamma" });
    const delta = await createPersistedGame({ seed: "branching-seed-delta" });

    expect(JSON.stringify({ worldState: replay.worldState, storyState: replay.storyState }))
      .toBe(JSON.stringify({ worldState: first.worldState, storyState: first.storyState }));
    const a = structuralSignature(first);
    const b = structuralSignature(other);
    const changedDimensions = (Object.keys(a) as (keyof typeof a)[])
      .filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]));
    expect(changedDimensions.length).toBeGreaterThanOrEqual(4);
    expect(new Set([first, other, gamma, delta].map((record) => JSON.stringify(structuralSignature(record)))).size).toBe(4);
  });

  it("compiles a reachable five-stage medium fallback with a final ending predicate", async () => {
    const record = await createPersistedGame({ seed: "medium-seed", gameLength: "medium" });
    const mainStages = record.worldState.quests
      .filter((quest) => quest.kind === "main")
      .map((quest) => quest.stage)
      .sort((left, right) => (left ?? 0) - (right ?? 0));

    expect(record.storyState.targetActs).toBe(5);
    expect(mainStages).toEqual([1, 2, 3, 4, 5]);
    expect(record.worldState.endings.every((ending) => ending.requirements.some(
      (requirement) => requirement.kind === "quest_completed" && requirement.questId === "quest_climax",
    ))).toBe(true);
  });

  it("covers every possible key-NPC affinity with exactly one deterministic fallback ending", async () => {
    const record = await createPersistedGame({ seed: "ending-coverage-seed", gameLength: "short" });
    const relationshipRequirements = record.worldState.endings.map((ending) =>
      ending.requirements.find((requirement) =>
        requirement.kind === "npc_affinity_at_least" || requirement.kind === "npc_affinity_at_most",
      ),
    );

    for (let affinity = -100; affinity <= 100; affinity += 1) {
      const matchingEndings = relationshipRequirements.filter((requirement) => {
        if (requirement?.kind === "npc_affinity_at_least") return affinity >= requirement.value;
        if (requirement?.kind === "npc_affinity_at_most") return affinity <= requirement.value;
        return false;
      });
      expect(matchingEndings, `affinity ${affinity}`).toHaveLength(1);
    }

    expect(relationshipRequirements).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "npc_affinity_at_least", value: 6 }),
      expect.objectContaining({ kind: "npc_affinity_at_most", value: 5 }),
    ]));

    const affinitySixWorld = {
      ...record.worldState,
      quests: record.worldState.quests.map((quest) =>
        quest.id === "quest_climax" ? { ...quest, status: "completed" as const } : quest,
      ),
      npcs: record.worldState.npcs.map((npc) => ({
        ...npc,
        memory: { ...npc.memory, relationship: { affinity: 6 } },
      })),
    };
    const resolved = resolveEnding(
      affinitySixWorld,
      { ...record.storyState, endingAllowed: true },
      { now: () => "2026-01-01" },
    );
    expect(resolved.nextWorldState.ending?.endingId).toBe("ending_trust");
  });

  it("honors every game type in compiled fallback structure and remains deterministic", async () => {
    const gameTypes: readonly GameTypeId[] = [
      "wuxia", "xianxia", "fantasy", "science_fiction", "urban", "alternate_history", "post_apocalypse",
    ];
    const compiled = await Promise.all(gameTypes.map((gameType) => createPersistedGame({ seed: "genre-seed", gameType })));
    const replay = await createPersistedGame({ seed: "genre-seed", gameType: "science_fiction" });
    const signatures = compiled.map((record) => JSON.stringify(structuralSignature(record)));

    expect(new Set(signatures).size).toBe(gameTypes.length);
    expect(structuralSignature(replay)).toEqual(structuralSignature(compiled[3]!));
    for (let index = 0; index < compiled.length; index += 1) {
      expect(compiled[index]!.worldState.generation.gameType).toBe(gameTypes[index]);
    }
  });

  it("atomically replaces an ended game and preserves it on stale replacement", async () => {
    const { repo, getRecord } = createInMemoryRepo();
    const first = await createGame(
      { gameId: asGameId("old-game"), gameType: "wuxia", gameLength: "short", seed: "old-seed" },
      { repository: repo, source: createFixtureWorldSource(), now: () => "2026-01-01" },
    );
    expect(first.ok).toBe(true);
    const initialized = getRecord()!;
    const ended = await repo.applyState({
      gameId: initialized.gameId,
      expectedRevision: initialized.revision,
      nextWorldState: {
        ...initialized.worldState,
        ending: { endingId: initialized.worldState.endings[0]!.id, outcome: "success" },
      },
      nextStoryState: initialized.storyState,
    });
    expect(ended.ok).toBe(true);
    const oldRecord = structuredClone(getRecord()!);

    const generationFailure = await createGame(
      {
        gameId: asGameId("new-invalid"), gameType: "science_fiction", gameLength: "short", seed: "new-seed",
        replaceCurrent: { expectedGameId: oldRecord.gameId, expectedRevision: oldRecord.revision },
      },
      {
        repository: repo,
        source: { async generate() { return null as never; } },
        now: () => "2026-01-02",
      },
    );
    expect(generationFailure).toEqual({ ok: false, code: "GENERATION_FAILED" });
    expect(getRecord()).toEqual(oldRecord);

    const stale = await createGame(
      {
        gameId: asGameId("new-stale"), gameType: "science_fiction", gameLength: "short", seed: "new-seed",
        replaceCurrent: { expectedGameId: oldRecord.gameId, expectedRevision: 99 },
      },
      { repository: repo, source: createFixtureWorldSource(), now: () => "2026-01-02" },
    );
    expect(stale).toMatchObject({ ok: false, code: "STALE_GAME_REVISION" });
    expect(getRecord()).toEqual(oldRecord);

    const replaced = await createGame(
      {
        gameId: asGameId("new-game"), gameType: "science_fiction", gameLength: "short", seed: "new-seed",
        replaceCurrent: { expectedGameId: oldRecord.gameId, expectedRevision: oldRecord.revision },
      },
      { repository: repo, source: createFixtureWorldSource(), now: () => "2026-01-02" },
    );
    expect(replaced.ok).toBe(true);
    expect(getRecord()).toMatchObject({ gameId: "new-game", revision: 0 });
    expect(getRecord()!.worldState.generation.seed).toBe("new-seed");
    expect(getRecord()!.worldState.ending).toBeNull();

    const replacement = getRecord()!;
    const replacementEnded = await repo.applyState({
      gameId: replacement.gameId,
      expectedRevision: replacement.revision,
      nextWorldState: {
        ...replacement.worldState,
        ending: { endingId: replacement.worldState.endings[0]!.id, outcome: "success" },
      },
      nextStoryState: replacement.storyState,
    });
    expect(replacementEnded.ok).toBe(true);
    const newerAtSameRevision = structuredClone(getRecord()!);
    expect(newerAtSameRevision.revision).toBe(oldRecord.revision);

    const abaAttempt = await createGame(
      {
        gameId: asGameId("stale-page-replacement"), gameType: "urban", gameLength: "short", seed: "aba-seed",
        replaceCurrent: { expectedGameId: oldRecord.gameId, expectedRevision: oldRecord.revision },
      },
      { repository: repo, source: createFixtureWorldSource(), now: () => "2026-01-03" },
    );
    expect(abaAttempt).toEqual({ ok: false, code: "STALE_GAME_REVISION" });
    expect(getRecord()).toEqual(newerAtSameRevision);
  });

  it("creates a game with fixture source", async () => {
    const { repo, getRecord } = createInMemoryRepo();
    const result = await createGame(
      { gameId: asGameId("g1"), gameType: "wuxia", gameLength: "short", seed: "test-seed" },
      { repository: repo, source: createFixtureWorldSource(), now: () => "2026-01-01" },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.revision).toBe(0);
      const record = getRecord();
      expect(record).not.toBeNull();
      expect(record!.worldState.locations.length).toBe(3);
      expect(record!.worldState.npcs.length).toBe(1);
      expect(record!.storyState.currentAct).toBe(1);
    }
  });

  it("开局配置落地：玩家身份采用配置且 setup 持久化到 generation", async () => {
    const { repo, getRecord } = createInMemoryRepo();
    const setup = {
      characterName: "沈砚",
      characterIdentity: "被逐出师门的机关师",
      characterProfile: "擅长修理与改造古代机关。",
      personalityTags: [],
      worldPremise: "大陆由七座浮空城邦统治，城邦之下是机关兽占据的荒原。",
      storyOpening: "沈砚带着一枚核心齿轮逃离师门，来到边陲小镇。",
      narrativeStyle: "cinematic" as const,
      contentIntensity: "normal" as const,
    };
    const result = await createGame(
      { gameId: asGameId("g-setup"), gameType: "fantasy", gameLength: "medium", seed: "setup-seed", setup },
      { repository: repo, source: createFixtureWorldSource(), now: () => "2026-01-01" },
    );
    expect(result.ok).toBe(true);
    const record = getRecord();
    expect(record).not.toBeNull();
    // 玩家身份必须来自配置，而非默认 fixture 文案
    expect(record!.worldState.player.name).toBe("沈砚");
    expect(record!.worldState.player.identity).toBe("被逐出师门的机关师");
    // setup 持久化，供序幕/角色面板/叙事生成消费
    expect(record!.worldState.generation.setup).toEqual(setup);
    // 起始地点必须为小镇层级（town 生成覆盖）
    const startLocation = record!.worldState.locations.find((location) => location.id === record!.worldState.currentLocationId);
    expect(startLocation?.scale).toBe("town");
  });

  it("rejects when active game exists", async () => {
    const { repo } = createInMemoryRepo();
    await createGame(
      { gameId: asGameId("g1"), gameType: "wuxia", gameLength: "short", seed: "s1" },
      { repository: repo, source: createFixtureWorldSource(), now: () => "2026-01-01" },
    );
    const result = await createGame(
      { gameId: asGameId("g2"), gameType: "wuxia", gameLength: "short", seed: "s2" },
      { repository: repo, source: createFixtureWorldSource(), now: () => "2026-01-01" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("ACTIVE_GAME_EXISTS");
  });
});

describe("parseGameSetup", () => {
  it("无配置字段时返回 null（保持旧契约）", () => {
    expect(parseGameSetup({ gameType: "wuxia", gameLength: "short" })).toBeNull();
  });

  it("合法配置产出 trim 后的 GameSetup", () => {
    const result = parseGameSetup({
      gameType: "fantasy",
      gameLength: "medium",
      characterName: " 沈砚 ",
      characterIdentity: "被逐出师门的机关师",
      worldPremise: "大陆由七座浮空城邦统治，城邦之下是机关兽占据的荒原。",
      storyOpening: "沈砚带着一枚核心齿轮逃离师门，来到边陲小镇。",
      narrativeStyle: "cinematic",
    });
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(true);
    if (result!.ok) {
      expect(result!.setup.characterName).toBe("沈砚");
      expect(result!.setup.narrativeStyle).toBe("cinematic");
    }
  });

  it("提交任一配置字段但缺必填时返回字段错误而非静默丢弃", () => {
    const result = parseGameSetup({
      gameType: "fantasy",
      gameLength: "medium",
      characterName: "沈砚",
    });
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(false);
    if (!result!.ok) {
      const fields = result!.errors.map((error) => error.field);
      expect(fields).toContain("characterIdentity");
      expect(fields).toContain("worldPremise");
    }
  });
});
