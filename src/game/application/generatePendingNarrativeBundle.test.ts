import { describe, it, expect, vi } from "vitest";
import { generatePendingNarrativeBundle } from "./generatePendingNarrativeBundle";
import type { GameRepository, GameRecord } from "./server/persistence/gameRepository";
import type { NarrativeBundleSource, NarrativeBundleSourceResult } from "./narrativeBundleSource";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import { asNpcId, asLocationId } from "@/game/domain/worldEntity";
import { asNarrativeJobId, asTurnId } from "@/game/domain/events";
import { createInitialWorldState } from "@/game/domain/worldState";
import { createInitialStoryState } from "@/game/domain/storyState";
import type { PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import { createGame, createFixtureOpeningSource } from "./createGame";
import { asGameId } from "./server/persistence/gameRepository";
import { projectGameSessionView } from "./gameSessionView";

function createMinimalWorldState(): WorldState {
  return createInitialWorldState({
    generation: {
      generationId: "gen_test" as never,
      seed: "test",
      templateVersion: "v2",
      inputDigest: "",
      gameType: "wuxia",
    },
    player: { name: "测试玩家", identity: "测试身份", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: {
      id: asLocationId("loc_0"),
      name: "测试地点",
      description: "一个测试地点",
      kind: "main",
      connectedLocationIds: [],
      npcIds: [asNpcId("npc_0")],
      availableItemIds: [],
      tags: [],
    },
    startingItemIds: [],
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
    domainEventRange: { fromLedgerIndex: 0, toLedgerIndexExclusive: 1 },
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
    if (!result.ok) expect(result.code).toBe("AI_RESPONSE_INVALID");
    // Should have written provider_failed state
    expect(getApplyCount()).toBeGreaterThan(0);
    const record = getRecord();
    if (record) {
      expect(record.storyState.narrative.status).toBe("provider_failed");
    }
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

    // The bundle coordinator keeps four bounded attempts so independent
    // next-act entity-name collisions can be repaired in one job.
    expect(generateMock).toHaveBeenCalledTimes(4);
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
                answeredBeatIds: [], usedFactIds: [], usedInteractionActionIds: [],
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

    expect(generateMock).toHaveBeenCalledTimes(4);
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
