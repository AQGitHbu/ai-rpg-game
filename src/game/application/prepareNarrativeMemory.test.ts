import { describe, expect, it, vi } from "vitest";
import { asGameId } from "./server/persistence/gameRepository";
import { asGenerationId, asPlayerEntityId } from "@/game/domain/worldEntity";
import type { GameRecord } from "./server/persistence/gameRepository";
import type { NarrativeMemoryPolicy } from "@/game/domain/narrativeMemoryContext";
import type { NarrativeMemorySummarySource } from "./narrativeMemorySummarySource";
import type { NarrativeMemorySummaryRepository } from "./narrativeMemorySummaryRepository";
import { prepareNarrativeMemory } from "./prepareNarrativeMemory";
import { asNarrativeJobId } from "@/game/domain/events";
import type { MemorySummaryState } from "@/game/domain/narrativeMemorySummary";

const PLAYER = asPlayerEntityId("player_0");
const policy: NarrativeMemoryPolicy = { threshold: 50, batchSize: 10, rawSoftEstimatedTokens: 24_000, summarySourceMaxEstimatedTokens: 24_000, overviewMaxEstimatedTokens: 6_000, promptMaxEstimatedTokens: 64_000 };

function record(): GameRecord {
  return {
    gameId: asGameId("game:prepare"), revision: 3, createdAt: "2026-09-14T00:00:00.000Z",
    worldState: { generation: { generationId: asGenerationId("generation:prepare") }, entityStore: { records: [] }, eventLedger: [] } as never,
    storyState: { history: { entries: [] }, threads: [], narrative: { status: "ready" } } as never,
  };
}

function longRecord(length = 61): GameRecord {
  const entries = Array.from({ length }, (_, index) => ({
    id: `history:${index}`,
    segmentId: `segment:${index}`,
    sequence: index,
    actionId: `action:${index}`,
    jobId: asNarrativeJobId(`job:${index}`),
    sceneId: `scene:${index}`,
    revision: index,
    turnNumber: index,
    kind: "narration" as const,
    text: `旧事 ${index}`,
    speakerId: PLAYER,
    audienceIds: [PLAYER],
    entityIds: [PLAYER],
    factIds: [],
    eventIds: [],
    choiceToken: null,
  }));
  return {
    ...record(),
    worldState: { generation: { generationId: asGenerationId("generation:prepare") }, entityStore: { records: [] }, eventLedger: [] } as never,
    storyState: { history: { entries }, threads: [], narrative: { status: "ready" } } as never,
  };
}

describe("prepareNarrativeMemory", () => {
  it("does not force another compression because of long source text already covered and omitted", async () => {
    const base = longRecord();
    const current = { ...base, storyState: { ...base.storyState, history: { entries: base.storyState.history.entries.map(entry =>
      entry.sequence === 5 ? { ...entry, text: "旧".repeat(30_000) } : entry) } } };
    const source: NarrativeMemorySummarySource = { select: vi.fn(async () => ({ ok: false as const, failure: { kind: "AI_CALL_FAILED" as const, phase: "scene" as const } })) };
    await prepareNarrativeMemory({ record: current, observerId: PLAYER, job: {} as never, source,
      repository: { load: async () => ({ summaryRevision: 1, state: { formatVersion: 1, observerId: PLAYER, policyVersion: "memory-p2/1",
        summaryRevision: 1, coveredThroughSequence: 49, coveredSourceFingerprint: "valid", batches: [], overview: { historyIds: ["history:0"], eventIds: [] } } }), publish: async () => ({ ok: true }) },
      policy, summaries: "enabled", signal: new AbortController().signal, reserveBatchUpdate: async () => true, reserveSummaryHttpAttempt: async () => true });
    expect(source.select).not.toHaveBeenCalled();
  });
  it.each([false, true])("protects current job inputs for length forcing=%s", async (force) => {
    const source: NarrativeMemorySummarySource = { select: vi.fn(async () => { throw new Error("current input must stay raw"); }) };
    const repository: NarrativeMemorySummaryRepository = { load: async () => ({ state: null, summaryRevision: 0 }), publish: async () => ({ ok: true }) };
    const length = force ? 10 : 50;
    const result = await prepareNarrativeMemory({ record: longRecord(length), observerId: PLAYER,
      job: { actionId: `action:${length - 1}`, jobId: asNarrativeJobId(`job:${length - 1}`) } as never,
      source, repository, policy: { ...policy, rawSoftEstimatedTokens: force ? 1 : 24_000 }, summaries: "enabled",
      signal: new AbortController().signal, reserveBatchUpdate: async () => true, reserveSummaryHttpAttempt: async () => true });
    expect(source.select).not.toHaveBeenCalled();
    expect(result.ok && result.context.uncovered.map(entry => entry.id)).toContain(`history:${length - 1}`);
  });

  it("does not finish or publish after cancellation during summary selection", async () => {
    const controller = new AbortController();
    const source: NarrativeMemorySummarySource = { select: vi.fn(async () => {
      controller.abort();
      return { ok: true as const, selection: { historyIds: ["history:0"], eventIds: [] } };
    }) };
    const repository: NarrativeMemorySummaryRepository = { load: async () => ({ state: null, summaryRevision: 0 }), publish: vi.fn(async () => ({ ok: true as const })) };
    expect(await prepareNarrativeMemory({ record: longRecord(50), observerId: PLAYER, job: {} as never,
      source, repository, policy, summaries: "enabled", signal: controller.signal,
      reserveBatchUpdate: async () => true, reserveSummaryHttpAttempt: async () => true })).toEqual({ ok: false, code: "CANCELLED" });
    expect(repository.publish).not.toHaveBeenCalled();
  });
  it("keeps the original-source path available when summaries are disabled", async () => {
    const source: NarrativeMemorySummarySource = { select: vi.fn(async () => { throw new Error("must not call summary source"); }) };
    const repository: NarrativeMemorySummaryRepository = { load: vi.fn(async () => ({ state: null, summaryRevision: 0 })), publish: vi.fn(async () => ({ ok: true as const })) };
    const result = await prepareNarrativeMemory({
      record: record(), observerId: PLAYER, job: {} as never, source, repository, policy,
      summaries: "disabled", signal: new AbortController().signal,
      reserveBatchUpdate: vi.fn(async () => true), reserveSummaryHttpAttempt: vi.fn(async () => true),
    });
    expect(result).toMatchObject({ ok: true, context: { observerId: PLAYER, coveredThroughSequence: -1 } });
    expect(source.select).not.toHaveBeenCalled();
  });

  it("keeps every uncovered source without re-sending already covered history when summary maintenance fails", async () => {
    const source: NarrativeMemorySummarySource = { select: vi.fn(async () => ({ ok: false as const, failure: { kind: "AI_CALL_FAILED" as const, phase: "scene" as const } })) };
    const previous: MemorySummaryState = {
      formatVersion: 1, observerId: PLAYER, policyVersion: "memory-p2/1", summaryRevision: 2,
      coveredThroughSequence: 49, coveredSourceFingerprint: "source:49", batches: [],
      overview: { historyIds: ["history:0"], eventIds: [] },
    };
    const repository: NarrativeMemorySummaryRepository = {
      load: vi.fn(async () => ({ state: previous, summaryRevision: previous.summaryRevision })),
      publish: vi.fn(async () => ({ ok: true as const })),
    };
    const result = await prepareNarrativeMemory({
      record: longRecord(), observerId: PLAYER, job: {} as never, source, repository, policy,
      summaries: "enabled", signal: new AbortController().signal,
      reserveBatchUpdate: vi.fn(async () => false), reserveSummaryHttpAttempt: vi.fn(async () => true),
    });
    expect(result).toMatchObject({ ok: true, context: { coveredThroughSequence: 49 } });
    if (result.ok) {
      expect(result.context.uncovered.map((entry) => entry.sequence)).toEqual(Array.from({ length: 11 }, (_, index) => index + 50));
      expect(result.context.recalled.map((entry) => entry.id)).toEqual(["history:0"]);
    }
    expect(source.select).not.toHaveBeenCalled();
  });

  it("publishes a new leaf batch only together with an overview rebuilt from leaf sources", async () => {
    const calls: string[] = [];
    const source: NarrativeMemorySummarySource = { select: vi.fn(async (input: Parameters<NarrativeMemorySummarySource["select"]>[0]) => {
      calls.push(input.kind);
      return { ok: true as const, selection: { historyIds: input.history.slice(0, 1).map((entry) => entry.id), eventIds: [] } };
    }) };
    const repository: NarrativeMemorySummaryRepository = {
      load: vi.fn(async () => ({ state: null, summaryRevision: 0 })),
      publish: vi.fn(async () => ({ ok: true as const })),
    };
    const result = await prepareNarrativeMemory({
      record: longRecord(50), observerId: PLAYER, job: {} as never, source, repository, policy,
      summaries: "enabled", signal: new AbortController().signal,
      reserveBatchUpdate: vi.fn(async () => true), reserveSummaryHttpAttempt: vi.fn(async () => true),
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual(["batch", "overview"]);
    expect(repository.publish).toHaveBeenCalledTimes(1);
  });

  it("forces summary maintenance when the raw source exceeds the soft token budget", async () => {
    const source: NarrativeMemorySummarySource = { select: vi.fn(async (input: Parameters<NarrativeMemorySummarySource["select"]>[0]) => ({
      ok: true as const,
      selection: { historyIds: input.history.slice(0, 1).map((entry) => entry.id), eventIds: [] },
    })) };
    const repository: NarrativeMemorySummaryRepository = {
      load: vi.fn(async () => ({ state: null, summaryRevision: 0 })),
      publish: vi.fn(async () => ({ ok: true as const })),
    };
    const result = await prepareNarrativeMemory({
      record: longRecord(10), observerId: PLAYER, job: {} as never, source, repository,
      policy: { ...policy, rawSoftEstimatedTokens: 1 }, summaries: "enabled",
      signal: new AbortController().signal,
      reserveBatchUpdate: vi.fn(async () => true), reserveSummaryHttpAttempt: vi.fn(async () => true),
    });

    expect(result.ok).toBe(true);
    expect(source.select).toHaveBeenCalledTimes(2);
    expect(source.select).toHaveBeenNthCalledWith(1, expect.objectContaining({ kind: "batch" }));
  });
});


it.each([[6_000, false], [24_000, true]] as const)("overview source budget %i preserves publication gate (%s)", async (budget, published) => {
  const base = longRecord(50);
  const current = { ...base, storyState: { ...base.storyState, history: { entries: base.storyState.history.entries.map((h, i) => i < 4 ? { ...h, text: "旧事".repeat(900) } : h) } } };
  const source: NarrativeMemorySummarySource = { select: vi.fn(async input => ({ ok: true as const, selection: { historyIds: input.history.slice(0, 4).map(h => h.id), eventIds: [] } })) };
  const repository: NarrativeMemorySummaryRepository = { load: async () => ({ state: null, summaryRevision: 0 }), publish: vi.fn(async () => ({ ok: true as const })) };
  const result = await prepareNarrativeMemory({ record: current, observerId: PLAYER, job: {} as never, source, repository,
    policy: { ...policy, overviewMaxEstimatedTokens: budget }, summaries: "enabled", signal: new AbortController().signal,
    reserveBatchUpdate: async () => true, reserveSummaryHttpAttempt: async () => true });
  expect(result.ok).toBe(true);
  expect(repository.publish).toHaveBeenCalledTimes(published ? 1 : 0);
  expect(result.ok && result.context.coveredThroughSequence).toBe(published ? 9 : -1);
});
