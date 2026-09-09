import { describe, it, expect, vi } from "vitest";
import { createGame, createFixtureOpeningCandidateSource, createFixtureOpeningSource, parseGameSetup } from "./createGame";
import type { GameId, GameRepository, GameRecord } from "./server/persistence/gameRepository";
import { asGameId } from "./server/persistence/gameRepository";
import type { GameLength, GameTypeId } from "@/game/domain/newGame";
import { asEndingId } from "@/game/domain/worldEntity";
import { createOpeningNoveltyRecord } from "@/game/domain/openingNovelty";
import type { NarrativeBundleSourceContext } from "./narrativeBundleSource";

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
        record = { ...record, worldState: input.nextWorldState, storyState: input.nextStoryState, revision: record.revision + 1 };
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
    { repository: repo, source: createFixtureOpeningSource(), now: () => "2026-01-01" },
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
    questGraph: record.worldState.quests.map((quest) => [quest.id, quest.name, quest.objectives, quest.onSuccess]),
    locations: record.worldState.locations.map((location) => [location.id, location.name, location.description]),
    contract: [record.storyState.contract.centralConflict, ...record.storyState.contract.endingDirections.map((direction) => direction.theme)],
    prologue: [record.storyState.prologueText],
  };
}

describe("createGame", () => {
  it("passes the latest schema rejection into the next opening attempt before saving", async () => {
    const { repo, getRecord } = createInMemoryRepo();
    const fixture = createFixtureOpeningSource();
    const contexts: NarrativeBundleSourceContext[] = [];
    const result = await createGame(
      { gameId: asGameId("schema-repair"), gameType: "wuxia", gameLength: "short", seed: "schema-repair" },
      { repository: repo, now: () => "2026-09-09", source: {
        async generate(context) {
          contexts.push(context);
          expect(getRecord()).toBeNull();
          if (contexts.length <= 2) return {
            ok: false, failure: { kind: "AI_RESPONSE_INVALID", phase: "opening" },
            repairReason: "invalid_schema",
            repairDetail: contexts.length === 1 ? "opening_INVALID_FACT" : "invalid_response_reference",
          };
          return fixture.generate(context);
        },
      } },
    );
    expect(result.ok).toBe(true);
    expect(contexts).toHaveLength(3);
    expect(contexts[0]).not.toHaveProperty("contentRepair");
    expect(contexts[1]).toHaveProperty("contentRepair", { attempt: 1, reason: "invalid_schema", detail: "opening_INVALID_FACT" });
    expect(contexts[2]).toHaveProperty("contentRepair", { attempt: 1, reason: "invalid_schema", detail: "invalid_response_reference" });
    expect(getRecord()).not.toBeNull();
  });
  it("authority-rejects an opening line that cites the NPC's undisclosed fact before persistence", async () => {
    const { repo: repository } = createInMemoryRepo();
    const fixture = createFixtureOpeningSource();
    const source = {
      async generate(input: Parameters<typeof fixture.generate>[0]) {
        const result = await fixture.generate(input);
        if (!result.ok) return result;
        if (result.kind !== "opening") return result;
        const proposal = {
          ...result.proposal,
          opening: {
            ...result.proposal.opening,
            opening: {
              ...result.proposal.opening.opening,
              npc: {
                ...result.proposal.opening.opening.npc,
                privateFactKeys: [result.proposal.opening.world.publicFacts[0]!.key],
              },
            },
          },
        } as typeof result.proposal;
        return { ...result, proposal };
      },
    };
    const result = await createGame(
      { gameId: "game-opening-authority" as never, gameType: "wuxia", gameLength: "short", seed: "opening-authority" },
      { repository, source, now: () => "2026-01-01" },
    );
    expect(result).toMatchObject({ ok: false, code: "AI_GENERATION_FAILED" });
    expect(await repository.getCurrentGame()).toMatchObject({ status: "none" });
  });

  it("authority-rejects an opening line with a foreign interaction before persistence", async () => {
    const { repo: repository } = createInMemoryRepo();
    const fixture = createFixtureOpeningSource();
    const source = {
      async generate(input: Parameters<typeof fixture.generate>[0]) {
        const result = await fixture.generate(input);
        if (!result.ok || result.kind !== "opening") return result;
        return {
          ...result,
          proposal: {
            ...result.proposal,
            currentScene: {
              ...result.proposal.currentScene,
              npcLine: {
                ...result.proposal.currentScene.npcLine!,
                usedEventIds: ["npc_other:trade"],
              },
            },
          },
        } as typeof result;
      },
    };

    const result = await createGame(
      { gameId: "game-opening-interaction-authority" as never, gameType: "wuxia", gameLength: "short", seed: "opening-interaction-authority" },
      { repository, source, now: () => "2026-01-01" },
    );

    expect(result).toMatchObject({ ok: false, code: "AI_GENERATION_FAILED" });
    expect(await repository.getCurrentGame()).toMatchObject({ status: "none" });
  });

  it("opening authority runs before novelty and persists the same preview without extra provider calls", async () => {
    const { repo, getRecord } = createInMemoryRepo();
    const fixture = createFixtureOpeningSource();
    const events: string[] = [];
    let calls = 0;
    let nowCalls = 0;
    let persistedWorldState: GameRecord["worldState"] | undefined;
    const source = {
      async generate(context: NarrativeBundleSourceContext) {
        calls += 1;
        events.push(`provider:${calls}`);
        const result = await fixture.generate(context);
        if (!result.ok || result.kind !== "opening") return result;
        if (calls !== 1) return result;
        const authorityOnlyFactIds = new Proxy(["fact_1"], {
          get(target, property, receiver) {
            if (property === "every") events.push("fact-array-validation");
            return Reflect.get(target, property, receiver);
          },
        });
        return {
          ...result,
          proposal: {
            ...result.proposal,
            currentScene: {
              ...result.proposal.currentScene,
              npcLine: {
                ...result.proposal.currentScene.npcLine!,
                // fact_1 is a valid candidate-world ID but is private to the
                // opening NPC, so only the preview authority can reject it.
                usedFactIds: authorityOnlyFactIds,
              },
            },
          },
        };
      },
    };
    const repository: GameRepository = {
      ...repo,
      async createInitialGame(input) {
        events.push("persist");
        persistedWorldState = input.worldState;
        return repo.createInitialGame(input);
      },
    };

    const result = await createGame(
      { gameId: asGameId("opening-preview-order"), gameType: "wuxia", gameLength: "short", seed: "opening-preview-order" },
      {
        repository,
        source,
        now: () => {
          nowCalls += 1;
          events.push(`now:${nowCalls}`);
          return "2026-01-01";
        },
      },
    );

    expect(result).toEqual({ ok: true, revision: 0 });
    expect(calls).toBe(2);
    expect(events).toEqual([
      "provider:1",
      "fact-array-validation",
      "provider:2",
      "now:1",
      "now:2",
      "persist",
    ]);
    expect(persistedWorldState).toBe(getRecord()!.worldState);
    expect(persistedWorldState?.generation.openingAttempt).toBe(1);
  });

  it("检测到近期故事过于相似时重新请求，而不是覆盖 AI 的实体名称", async () => {
    const { repo, getRecord } = createInMemoryRepo();
    const fixture = createFixtureOpeningSource();
    const duplicate = await createFixtureOpeningCandidateSource().generate({ gameType: "wuxia", gameLength: "short", seed: "novelty-seed", attempt: 0 });
    const history = createOpeningNoveltyRecord({ candidate: duplicate, gameType: "wuxia", createdAt: "2026-01-01" });
    let calls = 0;
    let acceptedNpcName = "";
    const source = {
      async generate(context: NarrativeBundleSourceContext) {
        calls += 1;
        const next = await fixture.generate(context);
        if (!next.ok || next.kind !== "opening") return next;
        if (calls === 1) {
          return { ...next, proposal: { ...next.proposal, opening: duplicate } };
        }
        acceptedNpcName = next.proposal.opening.opening.npc.name;
        return next;
      },
    };
    const result = await createGame(
      { gameId: asGameId("novelty-retry"), gameType: "wuxia", gameLength: "short", seed: "novelty-seed" },
      {
        repository: {
          ...repo,
          async listOpeningHistory() { return { ok: true as const, records: [history] }; },
        },
        source,
        now: () => "2026-01-01",
      },
    );

    expect(result.ok).toBe(true);
    expect(calls).toBeGreaterThan(1);
    expect(getRecord()!.worldState.generation.openingAttempt).toBeGreaterThan(0);
    expect(getRecord()!.worldState.npcs[0]!.name).toBe(acceptedNpcName);
  });

  it("live API 连续重复时返回稳定格式失败，而不接受重复候选", async () => {
    const { repo, getRecord } = createInMemoryRepo();
    const fixture = createFixtureOpeningSource();
    const repeated = await createFixtureOpeningCandidateSource().generate({ gameType: "wuxia", gameLength: "short", seed: "live-repeat-seed", attempt: 0 });
    const history = createOpeningNoveltyRecord({ candidate: repeated, gameType: "wuxia", createdAt: "2026-01-01" });
    let calls = 0;
    const source = {
      async generate(context: NarrativeBundleSourceContext) {
        calls += 1;
        const next = await fixture.generate(context);
        if (!next.ok || next.kind !== "opening") return next;
        return { ...next, proposal: { ...next.proposal, opening: repeated } };
      },
    };
    const result = await createGame(
      { gameId: asGameId("live-repeat"), gameType: "wuxia", gameLength: "short", seed: "live-repeat-seed" },
      {
        repository: {
          ...repo,
          async listOpeningHistory() { return { ok: true as const, records: [history] }; },
        },
        source,
        now: () => "2026-01-01",
      },
    );

    expect(result).toEqual({ ok: false, code: "AI_GENERATION_FAILED", failureKind: "AI_RESPONSE_INVALID" });
    expect(calls).toBeGreaterThan(0);
    expect(getRecord()).toBeNull();
  });

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
    expect(changedDimensions.length).toBeGreaterThanOrEqual(2);
    expect(new Set([first, other, gamma, delta].map((record) => JSON.stringify(structuralSignature(record)))).size).toBe(4);
  });

  it("compiles a medium fallback opening slice with a 5-act story contract", async () => {
    const record = await createPersistedGame({ seed: "medium-seed", gameLength: "medium" });
    expect(record.storyState.targetActs).toBe(5);
    expect(record.storyState.contract.targetActs).toBe(5);
    const mainQuests = record.worldState.quests.filter((quest) => quest.kind === "main");
    expect(mainQuests).toHaveLength(1);
    expect(mainQuests[0]?.stage).toBe(1);
    expect(mainQuests[0]?.status).toBe("active");
    expect(record.worldState.endings).toEqual([]);
  });

  it("materializes exactly one location/NPC/active main quest and no enemies, endings, or items", async () => {
    const record = await createPersistedGame({ seed: "opening-shape", gameLength: "short" });
    expect(record.worldState.locations).toHaveLength(1);
    expect(record.worldState.npcs).toHaveLength(1);
    expect(record.worldState.quests).toHaveLength(1);
    expect(record.worldState.quests[0]?.status).toBe("active");
    expect(record.worldState.quests[0]?.onSuccess).toEqual({ kind: "advance_story" });
    expect(record.worldState.quests[0]?.objectives).toEqual([{ kind: "talk_to_npc", npcId: record.worldState.npcs[0]!.id }]);
    expect(record.worldState.enemies).toEqual([]);
    expect(record.worldState.endings).toEqual([]);
    expect(record.worldState.items).toEqual([]);
    expect(record.storyState.contract.endingDirections.map((direction) => direction.key)).toEqual(["trust", "doubt"]);
    expect(record.storyState.evolution.status).toBe("stable");
  });

  it("prepares the opening NPC dialogue before the player submits a turn", async () => {
    const record = await createPersistedGame({ seed: "opening-dialogue", gameLength: "short" });
    const openingNpcId = record.worldState.npcs[0]!.id;
    const generation = record.storyState.narrative;

    // Task 6: 开局现在直接生成 ready 叙事 bundle，不再走 provider_pending
    expect(generation.status).toBe("ready");
    if (generation.status !== "ready") return;
    expect(generation.currentScene.source).toBe("generated");
    expect(generation.currentScene.npcLine?.npcId).toBe(openingNpcId);
    expect(generation.currentScene.choices).toHaveLength(2);
    expect(generation.choiceRegistry).toHaveLength(2);
    expect(generation.choiceRegistry.map((choice) => choice.action)).toEqual([
      expect.objectContaining({ dialogueAct: "ask", topic: { kind: "fact", factId: "fact_0" } }),
      expect.objectContaining({ dialogueAct: "challenge", topic: { kind: "thread", threadId: "thread_init_lead" } }),
    ]);
    expect(new Set(generation.choiceRegistry.map((choice) => choice.choiceToken)).size).toBe(2);
  });

  it("rejects opening scene choices that do not match situation responses atomically", async () => {
    const { repo } = createInMemoryRepo();
    const fixture = createFixtureOpeningSource();
    const source = {
      async generate(input: Parameters<typeof fixture.generate>[0]) {
        const result = await fixture.generate(input);
        if (!result.ok || result.kind !== "opening") return result;
        return { ...result, proposal: { ...result.proposal, currentScene: {
          ...result.proposal.currentScene,
          choices: [{ candidateId: "ask_lead", label: "先问线索" }, { candidateId: "extra", label: "额外选项" }],
        } } } as typeof result;
      },
    };
    const result = await createGame(
      { gameId: asGameId("opening-choice-mismatch"), gameType: "wuxia", gameLength: "short", seed: "opening-choice-mismatch" },
      { repository: repo, source, now: () => "2026-01-01" },
    );
    expect(result).toMatchObject({ ok: false, code: "AI_GENERATION_FAILED" });
    expect(await repo.getCurrentGame()).toMatchObject({ status: "none" });
  });

  it("compiles ask/refuse and equal-act distinct-topic responses through createGame", async () => {
    for (const [suffix, acts] of [["ask-refuse", ["ask", "refuse"]], ["ask-ask", ["ask", "ask"]]] as const) {
      const { repo, getRecord } = createInMemoryRepo();
      const fixture = createFixtureOpeningSource();
      const source = {
        async generate(input: Parameters<typeof fixture.generate>[0]) {
          const result = await fixture.generate(input);
          if (!result.ok || result.kind !== "opening") return result;
          const responses = [
            { key: "fact_response", dialogueAct: acts[0], topic: { kind: "fact", key: "fact_inn" } },
            { key: "thread_response", dialogueAct: acts[1], topic: { kind: "thread", key: "lead" } },
          ] as const;
          return { ...result, proposal: {
            ...result.proposal,
            opening: { ...result.proposal.opening, opening: { ...result.proposal.opening.opening,
              situation: { ...result.proposal.opening.opening.situation, responses },
            } },
            currentScene: { ...result.proposal.currentScene, choices: [
              { candidateId: "fact_response", label: "先核对消息" },
              { candidateId: "thread_response", label: "回应当前问题" },
            ] },
          } } as typeof result;
        },
      };
      const created = await createGame(
        { gameId: asGameId(`opening-${suffix}`), gameType: "wuxia", gameLength: "short", seed: `opening-${suffix}` },
        { repository: repo, source, now: () => "2026-01-01" },
      );
      expect(created.ok).toBe(true);
      const narrative = getRecord()!.storyState.narrative;
      expect(narrative.status).toBe("ready");
      if (narrative.status !== "ready") continue;
      expect(narrative.choiceRegistry.map((choice) => choice.action)).toEqual([
        expect.objectContaining({ dialogueAct: "ask", topic: { kind: "fact", factId: "fact_0" } }),
        expect.objectContaining({ dialogueAct: acts[1], topic: { kind: "thread", threadId: "thread_init_lead" } }),
      ]);
      expect(new Set(narrative.choiceRegistry.map((choice) => choice.choiceToken)).size).toBe(2);
    }
  });

  it("rejects semantic duplicates and unknown or private response topics through createGame", async () => {
    const invalidResponses = [
      [
        { key: "duplicate_a", dialogueAct: "ask", topic: { kind: "fact", key: "fact_inn" } },
        { key: "duplicate_b", dialogueAct: "ask", topic: { kind: "fact", key: "fact_inn" } },
      ],
      [
        { key: "unknown", dialogueAct: "ask", topic: { kind: "fact", key: "fact_missing" } },
        { key: "thread", dialogueAct: "refuse", topic: { kind: "thread", key: "lead" } },
      ],
      [
        { key: "private", dialogueAct: "ask", topic: { kind: "fact", key: "fact_pact" } },
        { key: "thread", dialogueAct: "refuse", topic: { kind: "thread", key: "lead" } },
      ],
    ] as const;
    for (const [index, responses] of invalidResponses.entries()) {
      const { repo } = createInMemoryRepo();
      const fixture = createFixtureOpeningSource();
      const source = {
        async generate(input: Parameters<typeof fixture.generate>[0]) {
          const result = await fixture.generate(input);
          if (!result.ok || result.kind !== "opening") return result;
          return { ...result, proposal: {
            ...result.proposal,
            opening: { ...result.proposal.opening, opening: { ...result.proposal.opening.opening,
              situation: { ...result.proposal.opening.opening.situation, responses },
            } },
            currentScene: { ...result.proposal.currentScene, choices: responses.map((response) => ({ candidateId: response.key, label: response.key })) },
          } } as typeof result;
        },
      };
      const created = await createGame(
        { gameId: asGameId(`opening-invalid-topic-${index}`), gameType: "wuxia", gameLength: "short", seed: `opening-invalid-topic-${index}` },
        { repository: repo, source, now: () => "2026-01-01" },
      );
      expect(created).toMatchObject({ ok: false, code: "AI_GENERATION_FAILED" });
      expect(await repo.getCurrentGame()).toMatchObject({ status: "none" });
    }
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

  it("为每个题材的 stock contact 提供与开场地点一致的显式 anchors 与 typed goal", async () => {
    const source = createFixtureOpeningCandidateSource();
    const gameTypes: readonly GameTypeId[] = [
      "wuxia", "xianxia", "fantasy", "science_fiction", "urban", "alternate_history", "post_apocalypse",
    ];

    for (const gameType of gameTypes) {
      const candidate = await source.generate({ gameType, gameLength: "short", seed: `stock-${gameType}` });
      const npc = candidate.opening.npc;
      const buildingName = candidate.opening.location.buildingName ?? candidate.opening.location.name;

      expect(npc.anchors.selfConcept).toContain(candidate.opening.location.name);
      expect(npc.anchors.values.length).toBeGreaterThanOrEqual(1);
      expect(npc.anchors.speechStyle.length).toBeGreaterThan(0);
      expect(npc.anchors.capabilityBoundaries.length).toBeGreaterThanOrEqual(1);
      expect(npc.anchors.taboos.length).toBeGreaterThanOrEqual(0);
      expect(npc.goals.length).toBeGreaterThanOrEqual(1);
      expect(npc.goals[0]).toEqual(expect.objectContaining({
        horizon: expect.any(String),
        description: expect.any(String),
        priority: expect.any(Number),
        reason: expect.stringContaining(buildingName),
      }));
      expect(npc.goals[0]).not.toHaveProperty("goalId");
      expect(npc.goals[0]).not.toHaveProperty("status");
    }
  });

  it("atomically replaces an ended game and preserves it on stale replacement", async () => {
    const { repo, getRecord } = createInMemoryRepo();
    const first = await createGame(
      { gameId: asGameId("old-game"), gameType: "wuxia", gameLength: "short", seed: "old-seed" },
      { repository: repo, source: createFixtureOpeningSource(), now: () => "2026-01-01" },
    );
    expect(first.ok).toBe(true);
    const initialized = getRecord()!;
    const ended = await repo.applyState({
      gameId: initialized.gameId,
      expectedRevision: initialized.revision,
      nextWorldState: {
        ...initialized.worldState,
        ending: { endingId: asEndingId("ended_game"), outcome: "success" },
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
    expect(generationFailure).toEqual({ ok: false, code: "AI_GENERATION_FAILED", failureKind: "AI_RESPONSE_INVALID" });
    expect(getRecord()).toEqual(oldRecord);

    const stale = await createGame(
      {
        gameId: asGameId("new-stale"), gameType: "science_fiction", gameLength: "short", seed: "new-seed",
        replaceCurrent: { expectedGameId: oldRecord.gameId, expectedRevision: 99 },
      },
      { repository: repo, source: createFixtureOpeningSource(), now: () => "2026-01-02" },
    );
    expect(stale).toMatchObject({ ok: false, code: "STALE_GAME_REVISION" });
    expect(getRecord()).toEqual(oldRecord);

    const replaced = await createGame(
      {
        gameId: asGameId("new-game"), gameType: "science_fiction", gameLength: "short", seed: "new-seed",
        replaceCurrent: { expectedGameId: oldRecord.gameId, expectedRevision: oldRecord.revision },
      },
      { repository: repo, source: createFixtureOpeningSource(), now: () => "2026-01-02" },
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
        ending: { endingId: asEndingId("ended_replacement"), outcome: "success" },
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
      { repository: repo, source: createFixtureOpeningSource(), now: () => "2026-01-03" },
    );
    expect(abaAttempt).toEqual({ ok: false, code: "STALE_GAME_REVISION" });
    expect(getRecord()).toEqual(newerAtSameRevision);
  });

  it("creates a game with fixture source", async () => {
    const { repo, getRecord } = createInMemoryRepo();
    const result = await createGame(
      { gameId: asGameId("g1"), gameType: "wuxia", gameLength: "short", seed: "test-seed" },
      { repository: repo, source: createFixtureOpeningSource(), now: () => "2026-01-01" },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.revision).toBe(0);
      const record = getRecord();
      expect(record).not.toBeNull();
      expect(record!.worldState.locations.length).toBe(1);
      expect(record!.worldState.npcs.length).toBe(1);
      expect(record!.storyState.currentAct).toBe(1);
    }
  });

  it("initialization invokes one opening bundle and persists its ready first decision", async () => {
    const { repo, getRecord } = createInMemoryRepo();
    const fixture = createFixtureOpeningSource();
    const source = { generate: vi.fn(fixture.generate) };

    const result = await createGame(
      { gameId: asGameId("opening-one-bundle"), gameType: "wuxia", gameLength: "short", seed: "opening-one-bundle" },
      { repository: repo, source, now: () => "2026-01-01", aiEnabled: true },
    );

    expect(result.ok).toBe(true);
    expect(source.generate).toHaveBeenCalledTimes(1);
    expect(source.generate).toHaveBeenCalledWith(expect.objectContaining({
      kind: "opening",
      jobId: "job_opening-one-bundle_0",
    }));
    const narrative = getRecord()!.storyState.narrative;
    expect(narrative.status).toBe("ready");
    if (narrative.status === "ready") {
      expect(narrative.currentScene.source).toBe("generated");
      expect(narrative.currentScene.npcLine?.npcId).toBe("npc_0");
      expect(narrative.currentScene.choices).toHaveLength(2);
      expect(narrative.choiceRegistry).toHaveLength(2);
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
      { repository: repo, source: createFixtureOpeningSource(), now: () => "2026-01-01" },
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
      { repository: repo, source: createFixtureOpeningSource(), now: () => "2026-01-01" },
    );
    const result = await createGame(
      { gameId: asGameId("g2"), gameType: "wuxia", gameLength: "short", seed: "s2" },
      { repository: repo, source: createFixtureOpeningSource(), now: () => "2026-01-01" },
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
