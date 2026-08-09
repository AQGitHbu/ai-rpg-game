import { describe, it, expect } from "vitest";
import { createDeterministicSceneSource } from "./deterministicSceneSource";
import { createInitialWorldState, appendNpc, appendLocation, type LocationEntry, type NpcEntry } from "@/game/domain/worldState";
import { createInitialStoryState, type StoryState } from "@/game/domain/storyState";
import { asLocationId, asNpcId, asGenerationId } from "@/game/domain/scenarioBlueprint";
import { asNarrativeJobId, asTurnId } from "@/game/domain/events";
import { createPendingNarrativeJob, type PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import type { ResolvedEvent, ResolvedEventStatus } from "@/game/domain/resolvedEvent";
import type { SceneGenerationContext } from "./sceneGenerationContext";
import type { NarrativeEventKind } from "@/game/domain/narrative";

const loc1: LocationEntry = {
  id: asLocationId("loc_1"), name: "客栈", description: "一间简朴的客栈", kind: "main",
  connectedLocationIds: [asLocationId("loc_2")], npcIds: [asNpcId("npc_1")], availableItemIds: [], tags: [],
};
const loc2: LocationEntry = {
  id: asLocationId("loc_2"), name: "街道", description: "一条热闹的街道", kind: "main",
  connectedLocationIds: [asLocationId("loc_1")], npcIds: [], availableItemIds: [], tags: [],
};
const npc1: NpcEntry = {
  id: asNpcId("npc_1"), name: "客栈老板", role: "路人", description: "热情的老板",
  locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
  memory: { npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
};
const npc2: NpcEntry = {
  id: asNpcId("npc_2"), name: "客人", role: "酒客", description: "t",
  locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
  memory: { npcId: asNpcId("npc_2"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
};

function makeWorld(): ReturnType<typeof createInitialWorldState> {
  const base = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "侠客", identity: "剑客", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: loc1,
    startingItemIds: [],
  });
  const withNpcs = appendNpc(appendNpc(appendLocation(base, loc2), npc1), npc2);
  return { ...withNpcs, unlockedLocationIds: [asLocationId("loc_1"), asLocationId("loc_2")] };
}

function makeStory(): StoryState {
  return createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 2, npcs: 2, quests: 0, events: 0 } });
}

function makeResolvedEvent(
  status: ResolvedEventStatus = "success",
  eventKind: NarrativeEventKind = "observe",
  facts: ResolvedEvent["facts"] = [],
): ResolvedEvent {
  return {
    actionId: "act_test",
    status,
    eventKind,
    facts,
    stateChanges: [],
    costs: [],
    rewards: [],
    triggeredEvents: [],
    rejectedEffects: [],
  };
}

type JobOverrides = {
  jobId?: string;
  status?: ResolvedEventStatus;
  eventKind?: NarrativeEventKind;
  summary?: PendingNarrativeJob["actionSummary"];
  utterance?: string;
  focusNpcId?: string;
};

function makeJob(overrides: JobOverrides = {}): PendingNarrativeJob {
  const result = createPendingNarrativeJob({
    jobId: asNarrativeJobId(overrides.jobId ?? "job_1"),
    turnId: asTurnId("turn_1"),
    actionId: "act_test",
    expectedRevision: 0,
    turnNumber: 1,
    actionSummary: overrides.summary ?? { kind: "move", locationId: asLocationId("loc_2") },
    utterance: overrides.utterance,
    resolvedEvent: makeResolvedEvent(overrides.status, overrides.eventKind),
    domainEventRange: { fromLedgerIndex: 1, toLedgerIndexExclusive: 2 },
    focusNpcId: overrides.focusNpcId !== undefined ? asNpcId(overrides.focusNpcId) : undefined,
    requestedAt: "2026-01-02",
  });
  if (!result.ok) throw new Error("fixture job 构造失败");
  return result.job;
}

// 最小上下文构造：直接按 SceneGenerationContext 契约组装（不引用完整的 record）。
function makeContext(job: PendingNarrativeJob): SceneGenerationContext {
  const ss = makeStory();
  return {
    job,
    player: { name: "侠客", identity: "剑客", knownFactCards: [] },
    currentLocation: { id: loc1.id, name: loc1.name, description: loc1.description, kind: "main" },
    publicWorldFacts: [],
    sceneVisibleFacts: [],
    presentNpcs: [npc1, npc2].map((n) => ({
      id: n.id, name: n.name, role: n.role, publicProfile: n.description,
      knownFactCards: [], hiddenFactCards: [], sceneVisibleFactIds: [],
      recentInteractionSummaries: [], relationship: { affinity: 0 }, emotion: "neutral",
      goals: [], forbiddenKnowledgeIds: [],
    })),
    story: {
      currentAct: ss.currentAct, targetActs: ss.targetActs, tension: ss.tension,
      nextPacingNeed: ss.nextPacingNeed,
      remainingBudget: { remainingLocations: 1, remainingNpcs: 1, remainingEvents: 1 },
      unresolvedThreadSummaries: [],
    },
    recentBeats: [],
    legalActionCandidates: [
      { kind: "move", label: `前往${loc2.name}`, targetId: loc2.id },
      { kind: "explore", label: "查看四周" },
    ],
    worldConstraints: [],
  };
}

describe("deterministicSceneSource", () => {
  const source = createDeterministicSceneSource();

  it("derives sceneId purely from the job: scene-<jobId>, identical across calls", async () => {
    const context = makeContext(makeJob({ jobId: "job_7" }));
    const first = await source.generateScene(context);
    const second = await source.generateScene(context);
    expect(first.scene.sceneId).toBe("scene-job_7");
    expect(second.scene.sceneId).toBe("scene-job_7");
    expect(first.scene.sceneId).toBe(second.scene.sceneId);
  });

  it("is fully deterministic: same context → same scene, choices and choiceTokens", async () => {
    const context = makeContext(makeJob({ jobId: "job_det" }));
    const first = await source.generateScene(context);
    const second = await source.generateScene(context);
    expect(first.scene).toEqual(second.scene);
    expect(first.scene.choices.map((c) => c.choiceToken)).toEqual(["scene-job_det-a", "scene-job_det-b"]);
  });

  it("produces a scene with narration, turn from job, and 2 choices with tokens/actionKeys", async () => {
    const result = await source.generateScene(makeContext(makeJob({ eventKind: "travel" })));
    expect(result.scene.narration.length).toBeGreaterThan(0);
    expect(result.scene.turn).toBe(1);
    expect(result.scene.choices).toHaveLength(2);
    expect(result.scene.source).toBe("fallback");
    for (const choice of result.scene.choices) {
      expect(choice.choiceToken).toBeTruthy();
      expect(choice.actionKey).toBeTruthy();
      expect(choice.label).toBeTruthy();
    }
  });

  it("maps a move/travel job to a travel event state", async () => {
    const result = await source.generateScene(makeContext(makeJob({ eventKind: "travel", summary: { kind: "move", locationId: asLocationId("loc_2") } })));
    expect(result.scene.event).toEqual({ kind: "travel", locationId: asLocationId("loc_1") });
  });

  it("maps a talk job to a dialogue event state focused on the job NPC", async () => {
    const result = await source.generateScene(makeContext(makeJob({
      eventKind: "dialogue",
      summary: { kind: "talk", npcId: asNpcId("npc_1") },
      focusNpcId: "npc_1",
    })));
    expect(result.scene.event).toEqual({ kind: "dialogue", focusNpcId: asNpcId("npc_1") });
    expect(result.scene.npcLine?.npcId).toBe(asNpcId("npc_1"));
  });

  it("talk job keeps focusNpcId and echoes the utterance neutrally", async () => {
    const utterance = "请问关于失踪的商队有什么线索吗？";
    const result = await source.generateScene(makeContext(makeJob({
      eventKind: "dialogue",
      summary: { kind: "talk", npcId: asNpcId("npc_1") },
      focusNpcId: "npc_1",
      utterance,
    })));
    expect(result.scene.npcLine?.npcId).toBe(asNpcId("npc_1"));
    expect(result.scene.npcLine?.text).toContain(utterance);
    expect(result.scene.narration).toContain(utterance);
  });

  it.each(["partial_success", "failure", "blocked"] as const)(
    "does not rewrite %s to a success: narration keeps a non-victory tone",
    async (status) => {
      const result = await source.generateScene(makeContext(makeJob({ status, eventKind: "dialogue", summary: { kind: "talk", npcId: asNpcId("npc_1") }, focusNpcId: "npc_1" })));
      expect(result.scene.narration.length).toBeGreaterThan(0);
      expect(result.scene.npcLine?.text).toBeTruthy();
      expect(result.scene.npcLine?.text).not.toContain("欢迎光临");
      if (status === "partial_success") {
        expect(result.scene.npcLine?.text).toContain("不方便全说");
      } else {
        expect(result.scene.npcLine?.text).not.toContain("欢迎光临");
      }
    },
  );

  it("produces NPC dialogue pages covering every present NPC", async () => {
    const result = await source.generateScene(makeContext(makeJob({ eventKind: "dialogue", summary: { kind: "talk", npcId: asNpcId("npc_1") }, focusNpcId: "npc_1" })));
    const dialogues = result.scene.npcDialogues;
    expect(dialogues).toBeDefined();
    const ids = (dialogues ?? []).map((d) => String(d.npcId));
    expect(ids).toEqual(["npc_1", "npc_2"]);
    for (const d of dialogues ?? []) {
      expect(d.speechPages.length).toBeGreaterThan(0);
    }
    const focus = (dialogues ?? []).find((d) => String(d.npcId) === String(result.scene.npcLine?.npcId));
    expect(focus).toBeDefined();
    expect(focus!.speechPages.join("")).toBe(result.scene.npcLine!.text);
  });

  it("event proposals is empty for deterministic source", async () => {
    const result = await source.generateScene(makeContext(makeJob()));
    expect(result.eventProposals).toEqual([]);
  });

  it("choices include a move action toward a reachable location", async () => {
    const result = await source.generateScene(makeContext(makeJob()));
    expect(result.scene.choices.some((c) => c.actionKey === "move:loc_2")).toBe(true);
  });
});