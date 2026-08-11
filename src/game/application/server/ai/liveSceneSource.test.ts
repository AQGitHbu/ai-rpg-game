import { describe, it, expect, vi } from "vitest";
import { generatePendingScene } from "../../generatePendingScene";
import { approveSceneEventProposals, POOL_MAX_CANDIDATES } from "../../approveAndWriteScene";
import { appendLocation, createInitialWorldState, type LocationEntry } from "@/game/domain/worldState";
import { createInitialStoryState, type StoryState } from "@/game/domain/storyState";
import type { EventCandidate } from "@/game/domain/candidateEvent";
import { asLocationId, asGenerationId, asEnemyId } from "@/game/domain/worldEntity";
import { asNarrativeJobId, asTurnId } from "@/game/domain/events";
import { createPendingNarrativeJob, type PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import type { GameRepository, GameRecord, GetCurrentGameResult } from "../../server/persistence/gameRepository";
import type { SceneSource, SceneSourceResult } from "../../sceneSource";
import type { SceneGenerationContext } from "../../sceneGenerationContext";

function makeWorldState() {
  const loc: LocationEntry = {
    id: asLocationId("loc_1"), name: "客栈", description: "t", kind: "main",
    connectedLocationIds: [asLocationId("loc_2")], npcIds: [], availableItemIds: [], tags: [],
  };
  const base = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: loc,
    startingItemIds: [],
  });
  const next = appendLocation(base, {
    id: asLocationId("loc_2"), name: "街道", description: "t", kind: "main",
    connectedLocationIds: [asLocationId("loc_1")], npcIds: [], availableItemIds: [], tags: [],
  });
  return { ...next, unlockedLocationIds: [asLocationId("loc_1"), asLocationId("loc_2")] };
}

function makeJob(): PendingNarrativeJob {
  const result = createPendingNarrativeJob({
    jobId: asNarrativeJobId("job_1"),
    turnId: asTurnId("turn_1"),
    actionId: "act_1",
    expectedRevision: 0,
    turnNumber: 1,
    actionSummary: { kind: "move", locationId: asLocationId("loc_1") },
    resolvedEvent: {
      actionId: "act_1", status: "success", eventKind: "travel",
      facts: [], stateChanges: [], costs: [], rewards: [], triggeredEvents: [], rejectedEffects: [],
    },
    domainEventRange: { fromLedgerIndex: 0, toLedgerIndexExclusive: 1 },
    requestedAt: "2026-01-02",
    objectiveTransition: { before: null, completed: [], after: null, mode: "unchanged" },
    mandatoryBeats: [],
  });
  if (!result.ok) throw new Error("job 构造失败");
  return result.job;
}

function validCandidate(id: string): EventCandidate {
  return {
    id,
    kind: "enemy_appears",
    involvedEntityIds: ["enemy_1", "loc_1"],
    prerequisiteFactIds: [],
    proposedEffects: [{ kind: "enemy_appears", enemyId: asEnemyId("enemy_1"), locationId: asLocationId("loc_1") }],
    intendedPacing: "complicate",
    reason: "r",
    proposedAtTurn: 1,
    expiresAtTurn: 4,
  };
}

function makeRecord(pool: readonly EventCandidate[]): GameRecord {
  const base = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 } });
  const ss: StoryState = { ...base, candidateEventPool: pool, narrative: { ...base.narrative, generation: { status: "pending", job: makeJob() } } };
  return { gameId: "g1" as never, worldState: makeWorldState(), storyState: ss, revision: 0, createdAt: "2026-01-01" };
}

function makeRepo(record: GameRecord | null): GameRepository {
  let current = record;
  return {
    createInitialGame: vi.fn(),
    replaceCurrentGame: vi.fn(),
    getCurrentGame: vi.fn(async () => {
      if (current === null) return { ok: true as const, status: "none" as const };
      return { ok: true as const, status: "active" as const, record: current };
    }),
    applyState: vi.fn(),
    applySceneWriteBack: vi.fn(async (input) => {
      if (current === null) return { ok: false as const, code: "NO_ACTIVE_GAME" as const };
      current = { ...current, worldState: input.nextWorldState, storyState: input.nextStoryState, revision: current.revision + 1 };
      return { ok: true as const, record: current };
    }),
    clearCurrentGame: vi.fn(async () => ({ ok: true as const })),
  };
}

function makeSceneSource(proposals: readonly EventCandidate[]): SceneSource {
  return {
    async generateScene(context: SceneGenerationContext): Promise<SceneSourceResult> {
      return {
        sceneId: `scene-${context.job.jobId}`,
        turn: context.job.turnNumber,
        narration: "dummy",
        npcLine: null,
        event: { kind: "observe", locationId: asLocationId("loc_1") },
        choiceProposals: [
          { label: "a", action: { type: "explore" } },
          { label: "b", action: { type: "move", locationId: asLocationId("loc_2") } },
        ],
        eventProposals: proposals,
        source: "generated",
      };
    },
  };
}

describe("scene source 候选事件提议 → 写回审批（Task 21）", () => {
  it("合法候选经 generatePendingScene 写回池，且不改变 World State/tension", async () => {
    const record = makeRecord([]);
    const repo = makeRepo(record);
    const source = makeSceneSource([validCandidate("ce-1")]);
    const result = await generatePendingScene({ repository: repo, sceneSource: source, now: () => "2026-01-02" });
    expect(result).toBe("saved");
    const current: GetCurrentGameResult = await repo.getCurrentGame();
    const saved = current.ok && current.status === "active" ? current.record : null;
    expect(saved?.storyState.candidateEventPool.map((c) => c.id)).toEqual(["ce-1"]);
    // 写回不触碰世界事实
    expect(saved?.worldState).toBe(record.worldState);
  });

  it("非法/path patch 提议被丢弃，合法提议保留；不拖垮场景", async () => {
    const pathPatch = {
      ...validCandidate("ce-patch"),
      proposedEffects: [{ kind: "arbitrary_patch", path: "worldState.player.stats.hp", value: 999 }],
    } as unknown as EventCandidate;
    const malformed = { ...validCandidate("ce-bad"), proposedEffects: [] } as unknown as EventCandidate;
    const ok = validCandidate("ce-good");

    const record = makeRecord([]);
    const repo = makeRepo(record);
    const source = makeSceneSource([pathPatch, malformed, ok]);
    const result = await generatePendingScene({ repository: repo, sceneSource: source, now: () => "2026-01-02" });
    expect(result).toBe("saved");
    const current: GetCurrentGameResult = await repo.getCurrentGame();
    const saved = current.ok && current.status === "active" ? current.record : null;
    expect(saved?.storyState.candidateEventPool.map((c) => c.id)).toEqual(["ce-good"]);
  });

  it("FIFO 上限与去重在写回时仍生效", () => {
    const existing = Array.from({ length: POOL_MAX_CANDIDATES }, (_, i) => validCandidate(`old-${i}`));
    const approval = approveSceneEventProposals({ existingPool: existing, proposals: [validCandidate("new-1")] });
    expect(approval.ok).toBe(true);
    if (!approval.ok) return;
    expect(approval.nextCandidateEventPool.length).toBe(POOL_MAX_CANDIDATES);
    expect(approval.nextCandidateEventPool.map((c) => c.id)).not.toContain("old-0");
    expect(approval.nextCandidateEventPool.map((c) => c.id)).toContain("new-1");

    const dup = approveSceneEventProposals({ existingPool: [validCandidate("ce-dup")], proposals: [validCandidate("ce-dup")] });
    expect(dup.ok).toBe(true);
    if (!dup.ok) return;
    expect(dup.nextCandidateEventPool.filter((c) => c.id === "ce-dup").length).toBe(1);
  });
});
