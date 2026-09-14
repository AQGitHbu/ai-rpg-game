import type { NpcDeliberationSource } from "./npcDeliberationSource";
import { hashNarrativeCandidate } from "./narrativeCandidateReview";
import { describe, it, expect, vi } from "vitest";
import { generatePendingNarrativeBundle } from "./generatePendingNarrativeBundle";
import type { GameRepository, GameRecord } from "./server/persistence/gameRepository";
import type { NarrativeBundleSource, NarrativeBundleSourceResult } from "./narrativeBundleSource";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { GenerationMetadata } from "@/game/domain/worldEntity";
import { createWorldStateFixture, updateWorldStateFixture } from "@/game/domain/testing/worldStateFixture.testutil";
import { asNpcId, asLocationId, asQuestId, PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import { asEpisodeId, asEventId, asNarrativeJobId, asTurnId, CommittedNarrativeEvent } from "@/game/domain/events";
import { createInitialStoryState } from "@/game/domain/storyState";
import type { PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import { createGame, createFixtureOpeningSource } from "./createGame";
import { asGameId } from "./server/persistence/gameRepository";
import { projectGameSessionView } from "./gameSessionView";
import { rebuildEpisodicMemory } from "@/game/domain/episodicMemory";
import { retryNarrativeGeneration } from "./retryNarrativeGeneration";
import type { NarrativeCandidateReviewer } from "./narrativeCandidateReview";
import { createNarrativeBundleSource } from "./server/ai/liveNarrativeBundleSource";
import type { RpgAiClient } from "./server/ai/rpgAiClient";
import { createLiveNarrativeCandidateReview } from "./server/ai/liveNarrativeCandidateReview";

const GENERATION: GenerationMetadata = {
  generationId: "gen_test" as never,
  seed: "test",
  templateVersion: "v2",
  inputDigest: "",
  gameType: "wuxia",
};

const LOC_0 = asLocationId("loc_0");

function createMinimalWorldState(): WorldState {
  return createWorldStateFixture({
    generation: GENERATION,
    projection: {
      player: { name: "测试玩家", identity: "测试身份", stats: { hp: 100, attack: 10, defense: 5 } },
      locations: [{
        id: LOC_0,
        name: "测试地点",
        description: "一个测试地点",
        kind: "main",
        connectedLocationIds: [],
        npcIds: [],
        availableItemIds: [],
        tags: [],
      }],
      currentLocationId: LOC_0,
      unlockedLocationIds: [LOC_0],
      visitedLocationIds: [LOC_0],
      npcs: [],
      items: [],
      inventory: [],
      worldFacts: [],
      quests: [],
      enemies: [],
      defeatedEnemyIds: [],
      factions: [],
    },
    eventLedger: [{
      eventId: asEventId("turn_test_0:event_1"), sequence: 0, turnId: asTurnId("turn_test_0"), turnNumber: 0,
      episodeId: asEpisodeId("episode:turn_test_0"), kind: "game_initialized", actorIds: [PLAYER_ENTITY_ID],
      targetIds: [], locationId: LOC_0, causeEventIds: [], factIds: [], questIds: [], outcome: "neutral",
      salience: 50, committedAt: "2026-01-01", payload: { type: "game_initialized", generation: GENERATION },
    } as CommittedNarrativeEvent],
  });
}

function createMinimalStoryState(narrative: StoryState["narrative"]): StoryState {
  return {
    ...createInitialStoryState({
      gameLength: "short",
      initialEntityCounts: { locations: 1, npcs: 1, quests: 1, events: 0 },
      initialNarrative: narrative,
    }),
  };
}

function createPendingJob(): PendingNarrativeJob {
  return {
    jobId: asNarrativeJobId("job_test_0"),
    turnId: asTurnId("turn_test_0"),
    actionId: "action_test",
    expectedRevision: 0,
    turnNumber: 1,
    actionSummary: { kind: "talk", npcId: asNpcId("npc_0") },
    resolvedEvent: {
      actionId: "action_test",
      status: "success",
      eventKind: "dialogue",
      facts: [],
      stateChanges: [],
      costs: [],
      rewards: [],
      triggeredEvents: [],
      rejectedEffects: [],
    },
    domainEventIds: [asEventId("turn_test_0:event_1")],
    focusNpcId: asNpcId("npc_0"),
    requestedAt: "2026-01-01T00:00:00.000Z",
    objectiveTransition: { before: null, completed: [], after: null, mode: "unchanged" },
    mandatoryBeats: [],
    generationKind: "narrative_choice",
    sceneRequestKind: "npc_fixed_choice",
  } as unknown as PendingNarrativeJob;
}

function createInMemoryRepo(record: GameRecord | null): { repo: GameRepository; getRecord: () => GameRecord | null; getApplyCount: () => number } {
  let current: GameRecord | null = record;
  let applyCount = 0;
  return {
    repo: {
      async createInitialGame(input) {
        if (current !== null) return { ok: false as const, code: "ACTIVE_GAME_EXISTS" as const };
        current = {
          gameId: input.gameId,
          worldState: input.worldState,
          storyState: input.storyState,
          revision: 0,
          createdAt: input.createdAt,
        };
        return { ok: true as const };
      },
      async getCurrentGame() {
        if (current === null) return { ok: true as const, status: "none" as const };
        return { ok: true as const, status: "active" as const, record: current };
      },
      async applyState(input) {
        applyCount++;
        if (current === null) return { ok: false, code: "NO_ACTIVE_GAME" as const };
        if (input.expectedRevision !== current.revision) return { ok: false, code: "STALE_GAME_REVISION" as const };
        current = { ...current, worldState: input.nextWorldState, storyState: input.nextStoryState, revision: current.revision + 1 };
        return { ok: true as const, record: current };
      },
      async applySceneWriteBack(input) {
        if (current === null) return { ok: false, code: "NO_ACTIVE_GAME" as const };
        if (input.expectedRevision !== current.revision) return { ok: false, code: "STALE_GAME_REVISION" as const };
        current = { ...current, worldState: input.nextWorldState, storyState: input.nextStoryState, revision: current.revision + 1 };
        return { ok: true as const, record: current };
      },
      async clearCurrentGame() { return { ok: true as const }; },
      async replaceCurrentGame() { return { ok: true as const }; },
    } as GameRepository,
    getRecord: () => current,
    getApplyCount: () => applyCount,
  };
}

describe("generatePendingNarrativeBundle", () => {
  it("carries only the immediately rejected raw draft through actual author requests", async () => {
    const job = createPendingJob();
    const { repo, getRecord } = createInMemoryRepo({
      gameId: asGameId("raw-revision-chain"), worldState: createMinimalWorldState(),
      storyState: createMinimalStoryState({ status: "provider_pending", mode: "ai", job, lastPresentedScene: null }),
      revision: 0, createdAt: "2026-01-01T00:00:00.000Z",
    });
    const baseDelta = {
      beatSummary: "船坞出现新的争执。", newLocation: null, newItem: null, newEnemy: null,
      newFact: null, nextMainQuest: null, endingPair: null,
    };
    const newNpc = {
      name: "郑大桅", role: "船工", description: "熟悉渡口旧事的船工。",
      locationRef: { kind: "existing", id: "loc_0" },
      anchors: { selfConcept: "守船的老船工", values: ["守信"], speechStyle: "直白", capabilityBoundaries: ["只说亲历"], taboos: [] },
      goals: [{ horizon: "short", description: "修好货渡", priority: 3, reason: "维持生计" }],
      relationshipSeeds: [], existingFactIds: ["fact_keep_sentinel"],
    };
    const responses = [
      { worldDelta: { ...baseDelta, newNpc, newFact2: null } },
      { worldDelta: { ...baseDelta, newNpc: { ...newNpc, existingFactIds: undefined }, newFact3: null } },
      { worldDelta: { ...baseDelta, newNpc: null, newFact4: null } },
    ];
    const complete = vi.fn(async () => ({ ok: true as const, content: JSON.stringify(responses.shift()) }));
    const liveSource = createNarrativeBundleSource({
      aiClient: { complete } as unknown as RpgAiClient,
      allowLegacyDecisionDto: true,
    });

    await generatePendingNarrativeBundle({ repository: repo, source: liveSource, now: () => "2026-01-01T00:00:00.000Z" });

    expect(complete).toHaveBeenCalledTimes(3);
    const secondAuthorRequest = ((complete.mock.calls[1] as unknown as readonly [unknown, readonly { content: string }[]])[1])[0]!.content;
    const thirdAuthorRequest = ((complete.mock.calls[2] as unknown as readonly [unknown, readonly { content: string }[]])[1])[0]!.content;
    expect(secondAuthorRequest).toContain("$.worldDelta.newFact2");
    expect(secondAuthorRequest).toContain("fact_keep_sentinel");
    expect(secondAuthorRequest).toContain('"newFact2":null');
    expect(thirdAuthorRequest).toContain("$.worldDelta.newFact3");
    expect(thirdAuthorRequest).not.toContain("fact_keep_sentinel");
    expect(getRecord()?.storyState.narrative).toMatchObject({ status: "provider_failed" });
    expect(JSON.stringify(getRecord())).not.toContain("郑大桅");
  });

  it("clears rejected raw material after a provider failure with no replacement draft", async () => {
    const job = createPendingJob();
    const { repo } = createInMemoryRepo({
      gameId: asGameId("raw-revision-clear"), worldState: createMinimalWorldState(),
      storyState: createMinimalStoryState({ status: "provider_pending", mode: "ai", job, lastPresentedScene: null }),
      revision: 0, createdAt: "2026-01-01T00:00:00.000Z",
    });
    const generate = vi.fn<NarrativeBundleSource["generate"]>()
      .mockResolvedValueOnce({ ok: false, failure: { kind: "AI_RESPONSE_INVALID", phase: "scene" },
        repairReason: "invalid_schema", repairDetail: "unknown_field", rejectedDraft: { sentinel: "raw_must_clear" } })
      .mockResolvedValueOnce({ ok: false, failure: { kind: "AI_CALL_FAILED", phase: "scene" },
        repairReason: "provider_failure", repairDetail: "timeout" })
      .mockResolvedValueOnce({ ok: false, failure: { kind: "AI_CALL_FAILED", phase: "scene" },
        repairReason: "provider_failure", repairDetail: "timeout" });

    await generatePendingNarrativeBundle({ repository: repo, source: { generate }, now: () => "2026-01-01T00:00:00.000Z" });

    expect(generate.mock.calls[1]![0]).toMatchObject({ authorDraftRevision: { draft: { sentinel: "raw_must_clear" } } });
    expect(generate.mock.calls[2]![0]).not.toHaveProperty("authorDraftRevision");
    expect(generate.mock.calls[2]![0]).not.toHaveProperty("candidateRevision");
  });

  it("persists the final cause and delivers it to the same job on manual retry", async () => {
    const job = { ...createPendingJob(), generationKind: "npc_fixed_choice" as const, sceneRequestKind: "npc_response" as const };
    const { repo, getRecord } = createInMemoryRepo({
      gameId: asGameId("manual-repair"), worldState: createMinimalWorldState(),
      storyState: createMinimalStoryState({ status: "provider_pending", mode: "ai", job, lastPresentedScene: null }),
      revision: 0, createdAt: "2026-01-01T00:00:00.000Z",
    });
    const generate = vi.fn<NarrativeBundleSource["generate"]>().mockResolvedValue({
      ok: false, failure: { kind: "AI_RESPONSE_INVALID", phase: "scene" },
      repairReason: "invalid_schema", repairDetail: "world_delta_invalid",
    });
    await generatePendingNarrativeBundle({ repository: repo, source: { generate }, now: () => "2026-01-01T00:00:00.000Z" });
    expect(generate.mock.calls.map(([ctx]) => ctx.contentRepair?.attempt)).toEqual([undefined, 1, 2]);
    expect(getRecord()?.storyState.narrative).toMatchObject({ status: "provider_failed", failure: { reason: "invalid_schema:world_delta_invalid" } });
    const retry = await retryNarrativeGeneration(repo, asGameId("manual-repair"), () => "2026-01-01T00:00:00.000Z");
    expect(retry).toMatchObject({ ok: true, result: "requeued" });
    generate.mockClear();
    await generatePendingNarrativeBundle({ repository: repo, source: { generate }, now: () => "2026-01-01T00:00:00.000Z", auditLink: { retry: { origin: "manual_failed_job", mechanism: "initial", attempt: 0 } } });
    expect(generate.mock.calls[0]?.[0]).toMatchObject({ job, contentRepair: { reason: "invalid_schema:world_delta_invalid" }, auditLink: { retry: { origin: "manual_failed_job", reason: "invalid_schema:world_delta_invalid" } } });
    expect(generate.mock.calls.map(([ctx]) => ctx.contentRepair?.attempt)).toEqual([1, 2, 3]);
  });
  it("returns NOT_PENDING when narrative is not provider_pending", async () => {
    const worldState = createMinimalWorldState();
    const storyState = createMinimalStoryState({
      status: "ready",
      mode: "ai",
      currentScene: {
        sceneId: "scene-1",
        turn: 0,
        narration: "测试",
        usedFactIds: [],
        npcLine: null,
        choices: [],
        source: "generated",
      },
      choiceRegistry: [],
    });

    const { repo } = createInMemoryRepo({
      gameId: "g1" as never,
      worldState,
      storyState,
      revision: 0,
      createdAt: "2026-01-01",
    });

    const source: NarrativeBundleSource = { generate: vi.fn() };
    const result = await generatePendingNarrativeBundle({
      repository: repo,
      source,
      now: () => "2026-01-01",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NOT_PENDING");
    expect(source.generate).not.toHaveBeenCalled();
  });

  it("returns NO_ACTIVE_GAME when no active game exists", async () => {
    const { repo } = createInMemoryRepo(null);
    const source: NarrativeBundleSource = { generate: vi.fn() };
    const result = await generatePendingNarrativeBundle({
      repository: repo,
      source,
      now: () => "2026-01-01",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NO_ACTIVE_GAME");
  });

  it("records provider_failed when source returns failure", async () => {
    const worldState = createMinimalWorldState();
    const job = createPendingJob();
    const storyState = createMinimalStoryState({
      status: "provider_pending",
      mode: "ai",
      job,
      lastPresentedScene: null,
    });

    const { repo, getRecord, getApplyCount } = createInMemoryRepo({
      gameId: "g1" as never,
      worldState,
      storyState,
      revision: 0,
      createdAt: "2026-01-01",
    });

    const source: NarrativeBundleSource = {
      generate: vi.fn().mockResolvedValue({
        ok: false,
        failure: { kind: "AI_CALL_FAILED", phase: "scene", failedAt: "2026-01-01" },
      } as NarrativeBundleSourceResult),
    };

    const result = await generatePendingNarrativeBundle({
      repository: repo,
      source,
      now: () => "2026-01-01",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("AI_CALL_FAILED");
    // Should have written provider_failed state
    expect(getApplyCount()).toBe(1);
    const record = getRecord();
    if (record) {
      expect(record.storyState.narrative).toMatchObject({ status: "provider_failed", job });
      expect(record.storyState.narrative).toHaveProperty("failure.reason", "provider_failure");
      expect(record.worldState).toEqual(worldState);
    }
    const contexts = vi.mocked(source.generate).mock.calls.map(([context]) => context);
    expect(contexts.slice(1).map((context) => context.contentRepair?.reason)).toEqual(["provider_failure", "provider_failure"]);
  });

  it("reports CAS conflict instead of claiming that the retryable failure was saved", async () => {
    const worldState = createMinimalWorldState();
    const storyState = createMinimalStoryState({
      status: "provider_pending", mode: "ai", job: createPendingJob(), lastPresentedScene: null,
    });
    const { repo, getRecord } = createInMemoryRepo({
      gameId: "g1" as never, worldState, storyState, revision: 0, createdAt: "2026-01-01",
    });
    const applyState = vi.fn<GameRepository["applyState"]>().mockResolvedValue({ ok: false, code: "STALE_GAME_REVISION" });
    const result = await generatePendingNarrativeBundle({
      repository: { ...repo, applyState },
      source: { generate: vi.fn().mockResolvedValue({ ok: false, failure: { kind: "AI_RESPONSE_INVALID", phase: "scene", failedAt: "2026-01-01" } }) },
      now: () => "2026-01-01",
    });
    expect(result).toEqual({ ok: false, code: "STALE_GAME_REVISION" });
    expect(applyState).toHaveBeenCalledTimes(1);
    expect(getRecord()?.storyState).toEqual(storyState);
  });

  it("calls source.generate exactly once per attempt", async () => {
    const worldState = createMinimalWorldState();
    const job = createPendingJob();
    const storyState = createMinimalStoryState({
      status: "provider_pending",
      mode: "ai",
      job,
      lastPresentedScene: null,
    });

    const { repo } = createInMemoryRepo({
      gameId: "g1" as never,
      worldState,
      storyState,
      revision: 0,
      createdAt: "2026-01-01",
    });

    const generateMock = vi.fn().mockResolvedValue({
      ok: false,
      failure: { kind: "AI_CALL_FAILED", phase: "scene", failedAt: "2026-01-01" },
    } as NarrativeBundleSourceResult);

    const source: NarrativeBundleSource = { generate: generateMock };

    await generatePendingNarrativeBundle({
      repository: repo,
      source,
      now: () => "2026-01-01",
    });

    // The bundle coordinator keeps three candidate versions per job.
    expect(generateMock).toHaveBeenCalledTimes(3);
  });

  it("把 story_exit 的 B 结果提交为等待生成后的退出结局", async () => {
    const job = {
      ...createPendingJob(),
      actionSummary: { kind: "abandon_quest" as const, questId: asQuestId("quest_exit") },
      focusNpcId: undefined,
      objectiveTransition: { before: null, completed: [], after: null, mode: "unchanged" as const },
      generationKind: "story_exit" as const,
      sceneRequestKind: "story_exit" as const,
    };
    const worldState = updateWorldStateFixture(createMinimalWorldState(), {
      quests: [{
        id: asQuestId("quest_exit"), name: "未竟委托", description: "一项待完成的委托", objectives: [],
        onSuccess: { kind: "advance_story" }, onFailure: { kind: "advance_story" }, tags: [], kind: "main", status: "failed",
      }],
    });
    const storyState = createMinimalStoryState({
      status: "provider_pending",
      mode: "ai",
      job,
      lastPresentedScene: null,
    });
    const { repo, getRecord } = createInMemoryRepo({
      gameId: asGameId("story-exit"), worldState,
      storyState,
      revision: 0, createdAt: "2026-01-01T00:00:00.000Z",
    });
    const source: NarrativeBundleSource = {
      generate: vi.fn().mockResolvedValue({
        ok: true,
        kind: "decision",
        proposal: {
          worldDelta: null,
          currentScene: {
            segments: [{ beatId: "atmosphere", text: "你把这段委托留在身后。" }],
            npcLine: null,
            objectiveLink: null,
            choices: [],
          },
          continuationScenes: [],
          terminal: { kind: "ending" },
        },
      } as NarrativeBundleSourceResult),
    };

    const result = await generatePendingNarrativeBundle({ repository: repo, source, now: () => "2026-01-01T00:00:00.000Z" });

    const saved = getRecord();
    expect(result.ok).toBe(true);
    expect(saved?.worldState.ending).not.toBeNull();
    expect(saved?.worldState.eventLedger.some((event) => event.payload.type === "ending_reached")).toBe(true);
    expect(saved?.storyState.narrative.status).toBe("ready");
  });

  it("forges generated current-scene choices for the revision that will be persisted", async () => {
    const { repo, getRecord } = createInMemoryRepo(null);
    const opening = await createGame(
      { gameId: asGameId("revision-alignment"), gameType: "wuxia", gameLength: "short", seed: "revision-alignment" },
      { repository: repo, source: createFixtureOpeningSource(), now: () => "2026-01-01", aiEnabled: true },
    );
    expect(opening.ok).toBe(true);
    const initialized = getRecord();
    if (initialized === null || initialized.storyState.narrative.status !== "ready") throw new Error("opening fixture missing");

    const npc = initialized.worldState.npcs[0]!;
    const quest = initialized.worldState.quests[0]!;
    const pendingJob: PendingNarrativeJob = {
      ...createPendingJob(),
      domainEventIds: [initialized.worldState.eventLedger[0]!.eventId],
      focusNpcId: npc.id,
      actionSummary: { kind: "talk", npcId: npc.id },
      objectiveTransition: {
        before: { questId: quest.id, objectiveIndex: 0, label: "与 NPC 交谈" },
        completed: [],
        after: { questId: quest.id, objectiveIndex: 0, label: "与 NPC 交谈" },
        mode: "unchanged",
      },
    };
    const pendingWrite = await repo.applyState({
      gameId: initialized.gameId,
      expectedRevision: initialized.revision,
      nextWorldState: initialized.worldState,
      nextStoryState: {
        ...initialized.storyState,
        narrative: {
          status: "provider_pending",
          mode: "ai",
          job: pendingJob,
          lastPresentedScene: initialized.storyState.narrative.currentScene,
          dialogueSession: { npcId: npc.id, turnCount: 1, requiredTurns: 2, completed: false },
        },
      },
    });
    expect(pendingWrite.ok).toBe(true);

    const source: NarrativeBundleSource = {
      async generate() {
        return {
          ok: true,
          kind: "decision",
          proposal: {
            worldDelta: null,
            currentScene: {
              segments: [{ beatId: "atmosphere", text: "老酒鬼放下酒坛，等你开口。" }],
              npcLine: {
                npcId: String(npc.id), text: "这件事不能在街上说。", emotion: "guarded",
                answeredBeatIds: [], usedFactIds: [], usedEventIds: [],
              },
              objectiveLink: { questId: String(quest.id), objectiveIndex: 0, mode: "progress" },
              choices: [
                { candidateId: "current_scene_choice_1", label: "请他细说。" },
                { candidateId: "current_scene_choice_2", label: "追问酒钱的缘由。" },
              ],
            },
            continuationScenes: [],
            terminal: { kind: "next_decision", target: { kind: "current_scene" } },
          },
        };
      },
    };

    const generated = await generatePendingNarrativeBundle({ repository: repo, source, now: () => "2026-01-01" });
    expect(generated.ok).toBe(true);
    const saved = getRecord();
    if (saved === null || saved.storyState.narrative.status !== "ready") throw new Error("generated bundle missing");
    expect(saved.storyState.narrative.choiceRegistry.every((choice) => choice.basedOnRevision === saved.revision)).toBe(true);
    expect(saved.storyState.narrative.dialogueSession).toEqual({ npcId: npc.id, turnCount: 1, requiredTurns: 2, completed: false });
    expect(projectGameSessionView(saved.worldState, saved.storyState, saved.revision, "test-session").narrative.npcDialogues[0]?.choices).toHaveLength(2);
    expect(saved.storyState.memory).toEqual(rebuildEpisodicMemory(saved.worldState.eventLedger));
    expect(saved.storyState.history?.entries.some((entry) => entry.text === "老酒鬼放下酒坛，等你开口。")).toBe(true);
    expect(saved.storyState.history?.entries.at(-1)?.kind).toBe("shown_choice");
  });

  it("repairs ending action overreach through the real author, approval, reviewer and revision loop", async () => {
    const npcId = asNpcId("npc_0");
    const worldState = updateWorldStateFixture(createMinimalWorldState(), {
      npcs: [{ id: npcId, name: "掌柜", role: "掌柜", description: "在场", locationId: LOC_0, isCompanion: false, met: true, tags: [],
        memory: { npcId, knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] } }],
      endings: [
        { id: "ending_trust" as never, name: "合作", description: "合作", requirements: [{ kind: "npc_affinity_at_least", npcId, value: 10 }] },
        { id: "ending_doubt" as never, name: "分歧", description: "分歧", requirements: [{ kind: "npc_affinity_at_most", npcId, value: 9 }] },
      ],
    });
    const job = createPendingJob();
    const base = createMinimalStoryState({ status: "provider_pending", mode: "ai", job, lastPresentedScene: null });
    const { repo, getRecord } = createInMemoryRepo({ gameId: asGameId("ending-repair"), worldState,
      storyState: { ...base, endingAllowed: true, currentAct: 3, storyProgress: 100, turnNumber: 1 }, revision: 0, createdAt: "2026-01-01" });
    const draft = (repaired: boolean) => ({ worldDelta: null,
      sceneDrafts: [{ slotKey: "current", scene: { segments: [{ beatId: "atmosphere", text: "掌柜等着你表明立场。" }], npcLine: null, objectiveLink: null, choices: [] } }],
      endingOutcomes: ["trust", "doubt"].map(themeKey => ({ themeKey,
        choiceLabel: repaired ? (themeKey === "trust" ? "认可你的回应" : "我仍然存疑") : "回去核清账目再回应",
        scene: { segments: [{ beatId: "atmosphere", text: repaired
          ? (themeKey === "trust" ? "你当面表明支持，先前针锋相对的争执终于停下。" : "你当面保留疑虑，双方坦然承认这次分歧。")
          : "你回到远处核清账目，所有欠款都已偿还。" }], npcLine: null, objectiveLink: null, choices: [] },
      })),
    });
    const defects = ["choiceLabel", "scene.segments[0].text"].map(field => ({
      scope: "scene", code: "ACTION_MISMATCH", path: `endingOutcomes[0].${field}`, reason: "实际支持行动未执行返回与核验。",
      evidence: { basisKey: "ending:trust", impact: "action_binding", detail: "预览的当前位置不变，不能将返回核验或财物结清写成已执行的因果依据。" },
    }));
    const responses = [draft(false), { verdict: "revise", defects }, draft(true), { verdict: "pass" }];
    const requests: (readonly { content: string }[])[] = [];
    const complete = vi.fn(async (_role: unknown, messages: readonly { content: string }[]) => {
      requests.push(messages);
      return { ok: true as const, content: JSON.stringify(responses.shift()) };
    });
    const aiClient = { complete } as unknown as RpgAiClient;
    const generated = await generatePendingNarrativeBundle({ repository: repo, source: createNarrativeBundleSource({ aiClient }),
      reviewer: createLiveNarrativeCandidateReview({ aiClient }), now: () => "2026-01-01T00:00:00.000Z" });
    expect(generated.ok).toBe(true);
    expect(complete).toHaveBeenCalledTimes(4);
    expect(requests[2]!.map(message => message.content).join("\n")).toContain("endingOutcomes[0].choiceLabel");
    expect(requests[2]!.map(message => message.content).join("\n")).toContain("ending:trust");
    const firstReview = JSON.parse(requests[1]![1]!.content);
    expect(firstReview.context.ruleBasis).toEqual(expect.arrayContaining([expect.objectContaining({ key: "ending:trust" }), expect.objectContaining({ key: "ending:doubt" })]));
    const saved = getRecord()!;
    expect(saved.storyState.narrative.status).toBe("ready");
    if (saved.storyState.narrative.status !== "ready") throw new Error("ending not approved");
    expect(saved.storyState.narrative.narrativeBundle?.endingOutcomes?.[0]?.choiceLabel).toBe("认可你的回应");
    expect(JSON.stringify(saved.storyState.history)).not.toContain("所有欠款");
    expect(JSON.stringify(saved.storyState.history)).not.toContain("针锋相对");
    expect(saved.worldState.ending).toBeNull();
  });

  it.each([false, true])("retains cumulative revisions and rejects a late reviewed result when cancelled=%s", async (cancel) => {
    const controller = new AbortController();
    const { repo, getRecord } = createInMemoryRepo(null);
    const opening = await createGame(
      { gameId: asGameId("candidate-review-loop"), gameType: "wuxia", gameLength: "short", seed: "candidate-review-loop" },
      { repository: repo, source: createFixtureOpeningSource(), now: () => "2026-01-01", aiEnabled: true },
    );
    expect(opening.ok).toBe(true);
    const initialized = getRecord();
    if (initialized === null || initialized.storyState.narrative.status !== "ready") throw new Error("opening fixture missing");
    const npc = initialized.worldState.npcs[0]!;
    const quest = initialized.worldState.quests[0]!;
    const pendingJob: PendingNarrativeJob = {
      ...createPendingJob(),
      generationKind: "npc_fixed_choice", sceneRequestKind: "npc_response",
      utterance: "先核验身份",
      domainEventIds: [initialized.worldState.eventLedger[0]!.eventId],
      focusNpcId: npc.id,
      actionSummary: { kind: "talk", npcId: npc.id },
      objectiveTransition: {
        before: { questId: quest.id, objectiveIndex: 0, label: "与 NPC 交谈" },
        completed: [],
        after: { questId: quest.id, objectiveIndex: 0, label: "与 NPC 交谈" },
        mode: "unchanged",
      },
    };
    const pendingWrite = await repo.applyState({
      gameId: initialized.gameId,
      expectedRevision: initialized.revision,
      nextWorldState: initialized.worldState,
      nextStoryState: {
        ...initialized.storyState,
        narrative: {
          status: "provider_pending",
          mode: "ai",
          job: pendingJob,
          lastPresentedScene: initialized.storyState.narrative.currentScene,
        },
      },
    });
    expect(pendingWrite.ok).toBe(true);

    const generate = vi.fn<NarrativeBundleSource["generate"]>(async (context) => {
        const label = context.contentRepair === undefined ? "先核验身份" : "现在交付信筒";
        return {
          ok: true,
          kind: "decision",
          proposal: {
            worldDelta: null,
            currentScene: {
              segments: [{ beatId: "atmosphere", text: "酒馆里有人压低声音。" }],
              npcLine: {
                npcId: String(npc.id), text: "这件事需要谨慎。", emotion: "guarded",
                answeredBeatIds: [], usedFactIds: [], usedEventIds: [],
              },
              objectiveLink: { questId: String(quest.id), objectiveIndex: 0, mode: "progress" },
              choices: [
                { candidateId: "current_scene_choice_1", label },
                { candidateId: "current_scene_choice_2", label: "暂时离开" },
              ],
            },
            continuationScenes: [],
            terminal: { kind: "next_decision", target: { kind: "current_scene" } },
          },
        };
    });
    const source: NarrativeBundleSource = { generate };
    const reviewer: NarrativeCandidateReviewer = {
      reviewNarrativeCandidate: vi.fn()
        .mockImplementationOnce(async (input) => ({
          ok: false,
          candidateVersion: input.candidateVersion,
          candidateHash: input.candidateHash,
          defects: [{
            candidateVersion: input.candidateVersion,
            candidateHash: input.candidateHash,
            scope: "scene",
            code: "MISSED_INPUT",
            path: "currentScene.expressions",
            reason: "必须先核验再交付。",
          }],
        }))
        .mockImplementationOnce(async (input) => ({
          ok: false, candidateVersion: input.candidateVersion, candidateHash: input.candidateHash,
          defects: [{ candidateVersion: input.candidateVersion, candidateHash: input.candidateHash,
            scope: "scene", code: "BROKEN_CAUSALITY", path: "currentScene.segments", reason: "不要重复开场。" }],
        }))
        .mockImplementationOnce(async (input) => {
          if (cancel) controller.abort();
          return ({
          ok: true,
          candidateVersion: input.candidateVersion,
          candidateHash: input.candidateHash,
        }); }),
    };

    const npcGenerate = vi.fn(async (input: { npcId: typeof npc.id }) => ({ ok: true as const, proposal: {
      npcId: input.npcId, goalIds: [], response: "question" as const, evidenceEventIds: [], discloseFactIds: [], interactionProposals: [],
    } }));
    const generated = await generatePendingNarrativeBundle({
      repository: repo,
      signal: controller.signal,
      npcDeliberationSource: { generate: npcGenerate },
      source,
      reviewer,
      now: () => "2026-01-01",
    });

    expect(generated.ok).toBe(!cancel);
    expect(reviewer.reviewNarrativeCandidate).toHaveBeenCalledTimes(3);
    expect(generate).toHaveBeenCalledTimes(3);
    expect(getRecord()?.storyState.narrative.status).toBe(cancel ? "provider_failed" : "ready");
    const third = generate.mock.calls[2]![0];
    if (third.kind !== "decision") throw new Error("wrong source kind");
    expect(npcGenerate).toHaveBeenCalledTimes(1);
    expect(third.candidateVersion).toBe(3);
    expect(third.npcOutward).toEqual([expect.objectContaining({ npcId: npc.id, response: "question" })]);
    const reviewCall = vi.mocked(reviewer.reviewNarrativeCandidate).mock.calls[2]![0];
    expect(reviewCall.proposal).toMatchObject({ npcOutwardProposals: third.npcOutward });
    if (reviewCall.context.kind !== "decision") throw new Error("wrong review context kind");
    expect(reviewCall.context.reviewWorldState).toBeDefined();
    expect(reviewCall.context.reviewScenes?.[0]?.npcLine?.npcId).toBe(npc.id);
    expect(reviewCall.candidateHash).toBe(hashNarrativeCandidate(reviewCall.proposal));
    expect(third.candidateRevision).toMatchObject({ candidateVersion: 2, candidateHash: expect.any(String) });
    expect(third.candidateRevision?.findings.map((finding) => finding.detail).join(" ")).toContain("必须先核验再交付");
    expect(third.candidateRevision?.findings.map((finding) => finding.detail).join(" ")).toContain("不要重复开场");
    expect(third.candidateRevision?.proposal.currentScene.choices[0]?.label).toBe("现在交付信筒");
    if (cancel) expect(getRecord()?.storyState.history).toEqual(initialized.storyState.history);
  });

  it.each([false, true])("reuses only successful outward within one worker and rebuilds it for another job (initial NPC failure=%s)", async initiallyFails => {
    const { repo, getRecord } = createInMemoryRepo(null);
    await createGame({ gameId: asGameId("outward-cache"), gameType: "wuxia", gameLength: "short", seed: "outward-cache" },
      { repository: repo, source: createFixtureOpeningSource(), now: () => "2026-01-01", aiEnabled: true });
    const initialized = getRecord();
    if (initialized === null || initialized.storyState.narrative.status !== "ready") throw new Error("opening fixture missing");
    const npc = initialized.worldState.npcs[0]!;
    const lastPresentedScene = initialized.storyState.narrative.currentScene;
    const npcGenerate = vi.fn<NpcDeliberationSource["generate"]>().mockImplementation(async input => ({ ok: true,
      proposal: { npcId: input.npcId, response: "question", goalIds: [], evidenceEventIds: [], discloseFactIds: [], interactionProposals: [] } }));
    if (initiallyFails) npcGenerate.mockResolvedValueOnce({ ok: false, code: "PROVIDER_FAILURE" });
    const generate = vi.fn<NarrativeBundleSource["generate"]>().mockResolvedValue({ ok: false,
      failure: { kind: "AI_RESPONSE_INVALID", phase: "scene" }, repairReason: "invalid_schema", repairDetail: "author_invalid" });
    for (const ordinal of [1, 2]) {
      const current = getRecord()!;
      const job = { ...createPendingJob(), jobId: asNarrativeJobId(`outward-job-${ordinal}`), focusNpcId: npc.id,
        utterance: "请求核验", actionSummary: { kind: "talk" as const, npcId: npc.id } };
      await repo.applyState({ gameId: current.gameId, expectedRevision: current.revision, nextWorldState: current.worldState,
        nextStoryState: { ...initialized.storyState, narrative: { status: "provider_pending", mode: "ai", job, lastPresentedScene } } });
      await generatePendingNarrativeBundle({ repository: repo, source: { generate }, npcDeliberationSource: { generate: npcGenerate }, now: () => "2026-01-01" });
      expect(getRecord()?.storyState.narrative.status).toBe("provider_failed");
      expect(npcGenerate).toHaveBeenCalledTimes(ordinal + (initiallyFails ? 1 : 0));
    }
    expect(generate).toHaveBeenCalledTimes(initiallyFails ? 5 : 6);
    const contexts = generate.mock.calls.map(([context]) => context);
    expect(contexts.at(-1)).toMatchObject({ candidateVersion: 3, job: { jobId: "outward-job-2" }, npcOutward: [{ npcId: npc.id }] });
  });

  it("事件账本提交失败时持久化独立稳定码，不伪装成审批拒绝", async () => {
    const { repo, getRecord } = createInMemoryRepo(null);
    const opening = await createGame(
      { gameId: asGameId("event-commit-failure"), gameType: "wuxia", gameLength: "short", seed: "event-commit-failure" },
      { repository: repo, source: createFixtureOpeningSource(), now: () => "2026-01-01", aiEnabled: true },
    );
    expect(opening.ok).toBe(true);
    const initialized = getRecord();
    if (initialized === null || initialized.storyState.narrative.status !== "ready") throw new Error("opening fixture missing");

    const npc = initialized.worldState.npcs[0]!;
    const quest = initialized.worldState.quests[0]!;
    // 破坏账本序号连续性：审批不读严格账本解析，提交阶段才失败（INVALID_LEDGER）。
    const corruptLedger = initialized.worldState.eventLedger.map((event, index) => ({ ...event, sequence: index + 7 }));
    const pendingJob: PendingNarrativeJob = {
      ...createPendingJob(),
      domainEventIds: [initialized.worldState.eventLedger[0]!.eventId],
      focusNpcId: npc.id,
      actionSummary: { kind: "talk", npcId: npc.id },
      objectiveTransition: {
        before: { questId: quest.id, objectiveIndex: 0, label: "与 NPC 交谈" },
        completed: [],
        after: { questId: quest.id, objectiveIndex: 0, label: "与 NPC 交谈" },
        mode: "unchanged",
      },
    };
    const pendingWrite = await repo.applyState({
      gameId: initialized.gameId,
      expectedRevision: initialized.revision,
      nextWorldState: { ...initialized.worldState, eventLedger: corruptLedger },
      nextStoryState: {
        ...initialized.storyState,
        narrative: {
          status: "provider_pending",
          mode: "ai",
          job: pendingJob,
          lastPresentedScene: initialized.storyState.narrative.currentScene,
        },
      },
    });
    expect(pendingWrite.ok).toBe(true);

    const source: NarrativeBundleSource = {
      async generate() {
        return {
          ok: true,
          kind: "decision",
          proposal: {
            worldDelta: null,
            currentScene: {
              segments: [{ beatId: "atmosphere", text: "老酒鬼放下酒坛，等你开口。" }],
              npcLine: {
                npcId: String(npc.id), text: "这件事不能在街上说。", emotion: "guarded",
                answeredBeatIds: [], usedFactIds: [], usedEventIds: [],
              },
              objectiveLink: { questId: String(quest.id), objectiveIndex: 0, mode: "progress" },
              choices: [
                { candidateId: "current_scene_choice_1", label: "请他细说。" },
                { candidateId: "current_scene_choice_2", label: "追问酒钱的缘由。" },
              ],
            },
            continuationScenes: [],
            terminal: { kind: "next_decision", target: { kind: "current_scene" } },
          },
        };
      },
    };

    const generated = await generatePendingNarrativeBundle({ repository: repo, source, now: () => "2026-01-01" });
    expect(generated).toEqual({ ok: false, code: "AI_RESPONSE_INVALID", failureKind: "AI_RESPONSE_INVALID" });
    // 审批已通过：持久化独立稳定码，手动重试不会被"审批拒绝码"误导修复方向。
    const narrative = getRecord()?.storyState.narrative;
    expect(narrative).toMatchObject({
      status: "provider_failed",
      failure: { kind: "AI_RESPONSE_INVALID", reason: "invalid_schema:event_commit_failed", phase: "scene" },
    });
  });

  it("把审批拒绝码与理由带给第二次尝试，而不是泛化提示", async () => {
    const worldState = createMinimalWorldState();
    const job = createPendingJob();
    const storyState = createMinimalStoryState({
      status: "provider_pending",
      mode: "ai",
      job,
      lastPresentedScene: null,
    });
    const { repo } = createInMemoryRepo({
      gameId: "g1" as never,
      worldState,
      storyState,
      revision: 0,
      createdAt: "2026-01-01",
    });

    const generateMock = vi.fn().mockResolvedValue({
      ok: true,
      kind: "decision",
      proposal: {
        worldDelta: null,
        currentScene: {
          segments: [{ beatId: "atmosphere", text: "风穿过空巷。" }],
          npcLine: null,
          objectiveLink: null,
          choices: [],
        },
        continuationScenes: [],
        terminal: { kind: "next_decision", target: { kind: "continuation_step", stepKey: "move:nowhere" } },
      },
    } as NarrativeBundleSourceResult);

    await generatePendingNarrativeBundle({ repository: repo, source: { generate: generateMock }, now: () => "2026-01-01" });

    expect(generateMock).toHaveBeenCalledTimes(3);
    const firstContext = generateMock.mock.calls[0]?.[0];
    const secondContext = generateMock.mock.calls[1]?.[0];
    expect(firstContext?.contentRepair).toBeUndefined();
    expect(secondContext?.contentRepair).toMatchObject({
      attempt: 1,
      reason: "approval_rejected",
      rejectionCode: "bundle_invalid_scene",
    });
  });

  it("传输失败时把 source 自身的修复原因带给下一次尝试", async () => {
    const worldState = createMinimalWorldState();
    const job = createPendingJob();
    const storyState = createMinimalStoryState({
      status: "provider_pending",
      mode: "ai",
      job,
      lastPresentedScene: null,
    });
    const { repo } = createInMemoryRepo({
      gameId: "g1" as never,
      worldState,
      storyState,
      revision: 0,
      createdAt: "2026-01-01",
    });

    const generateMock = vi.fn().mockResolvedValue({
      ok: false,
      failure: { kind: "AI_RESPONSE_INVALID", phase: "scene", failedAt: "2026-01-01" },
      repairReason: "invalid_json",
    } as NarrativeBundleSourceResult);

    await generatePendingNarrativeBundle({ repository: repo, source: { generate: generateMock }, now: () => "2026-01-01" });

    expect(generateMock.mock.calls[1]?.[0]).toMatchObject({
      contentRepair: { attempt: 1, reason: "invalid_json" },
    });
  });

  it("契约细分理由随 repairDetail 带给下一次尝试", async () => {
    const worldState = createMinimalWorldState();
    const job = createPendingJob();
    const storyState = createMinimalStoryState({
      status: "provider_pending",
      mode: "ai",
      job,
      lastPresentedScene: null,
    });
    const { repo } = createInMemoryRepo({
      gameId: "g1" as never,
      worldState,
      storyState,
      revision: 0,
      createdAt: "2026-01-01",
    });

    const generateMock = vi.fn().mockResolvedValue({
      ok: false,
      failure: { kind: "AI_RESPONSE_INVALID", phase: "scene", failedAt: "2026-01-01" },
      repairReason: "invalid_schema",
      repairDetail: "terminal_step_requires_two_choices（步骤 battle_resolved:victory:enemy_dyn_3）",
    } as NarrativeBundleSourceResult);

    await generatePendingNarrativeBundle({ repository: repo, source: { generate: generateMock }, now: () => "2026-01-01" });

    expect(generateMock.mock.calls[1]?.[0]).toMatchObject({
      contentRepair: {
        attempt: 1,
        reason: "invalid_schema",
        detail: "terminal_step_requires_two_choices（步骤 battle_resolved:victory:enemy_dyn_3）",
      },
    });
  });
});
