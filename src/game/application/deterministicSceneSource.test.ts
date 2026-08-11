import { describe, it, expect } from "vitest";
import { createDeterministicSceneSource } from "./deterministicSceneSource";
import type { LocationEntry, NpcEntry } from "@/game/domain/worldState";
import { createInitialStoryState, type StoryState } from "@/game/domain/storyState";
import { asLocationId, asNpcId, asFactId } from "@/game/domain/worldEntity";
import { asNarrativeJobId, asTurnId } from "@/game/domain/events";
import { createPendingNarrativeJob, type PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import type { ResolvedEvent, ResolvedEventStatus } from "@/game/domain/resolvedEvent";
import type { SceneGenerationContext } from "./sceneGenerationContext";
import type { NarrativeEventKind } from "@/game/domain/narrative";
import type { FocusNpcContext } from "./focusNpcContext";
import type { RelationshipTier } from "@/game/domain/relationship";

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
  beats?: PendingNarrativeJob["mandatoryBeats"];
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
    objectiveTransition: { before: null, completed: [], after: null, mode: "unchanged" },
    mandatoryBeats: overrides.beats ?? [],
  });
  if (!result.ok) throw new Error("fixture job 构造失败");
  return result.job;
}

function makeFocusContext(tier: RelationshipTier): FocusNpcContext {
  return {
    id: asNpcId("npc_1"),
    name: "老板",
    role: "客栈老板",
    publicProfile: "热情的老板",
    responsePolicy: {
      tier,
      toneInstruction: tier === "hostile" ? "简短冷淡，拒绝配合" : "坦诚相待",
      initiative: tier === "hostile" ? "refuse" : "proactive",
      allowedDisclosureFactIds: tier === "hostile" ? [] : [asFactId("fact_1")],
      privateKnowledgeIds: [],
    },
    speakableFactCards: tier === "hostile" ? [] : [{ factId: asFactId("fact_1"), text: "矿坑里藏着密道" }],
    recentInteractions: [],
    goals: [],
    emotion: tier === "hostile" ? "angry" : "warm",
    thisTurn: { relationshipDelta: tier === "hostile" ? -2 : 2, outcome: tier === "hostile" ? "negative" : "positive" },
  };
}

// 最小上下文构造：直接按 SceneGenerationContext 契约组装（不引用完整的 record）。
function makeContext(job: PendingNarrativeJob, focus?: FocusNpcContext): SceneGenerationContext {
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
    legalEventTargets: {
      locationIds: [loc1.id, loc2.id], factIds: [], itemIds: [], enemyIds: [],
    },
    worldConstraints: [],
    objectiveTransition: { before: null, completed: [], after: null, mode: "unchanged" },
    mandatoryBeats: job.mandatoryBeats,
    beatSubjects: [],
    ...(focus !== undefined ? { focusNpcContext: focus } : {}),
  };
}

/** talk job + 玩家原话 + 焦点 NPC 上下文的快速构造。 */
function makeUtteranceContext(tier: RelationshipTier): SceneGenerationContext {
  const job = makeJob({
    eventKind: "dialogue",
    summary: { kind: "talk", npcId: asNpcId("npc_1") },
    focusNpcId: "npc_1",
    utterance: "你知道商队失踪的事吗？",
    beats: [{ beatId: "player_utterance", kind: "player_utterance", subjectIds: ["npc_1"], instruction: "直接回应玩家" }],
  });
  return makeContext(job, makeFocusContext(tier));
}

describe("deterministicSceneSource", () => {
  const source = createDeterministicSceneSource();

  it("derives sceneId purely from the job: scene-<jobId>, identical across calls", async () => {
    const context = makeContext(makeJob({ jobId: "job_7" }));
    const first = await source.generateScene(context);
    const second = await source.generateScene(context);
    expect(first.sceneId).toBe("scene-job_7");
    expect(second.sceneId).toBe("scene-job_7");
    expect(first.sceneId).toBe(second.sceneId);
  });

  it("is fully deterministic: same context → same proposal package", async () => {
    const context = makeContext(makeJob({ jobId: "job_det" }));
    const first = await source.generateScene(context);
    const second = await source.generateScene(context);
    expect(first).toEqual(second);
    expect(first.choiceProposals).toHaveLength(2);
  });

  it("produces a proposal with narration, turn from job, and exactly 2 distinct actions", async () => {
    const result = await source.generateScene(makeContext(makeJob({ eventKind: "travel" })));
    expect(result.narration.length).toBeGreaterThan(0);
    expect(result.turn).toBe(1);
    expect(result.choiceProposals).toHaveLength(2);
    expect(result.source).toBe("fallback");
    expect(result.choiceProposals.every((choice) => choice.label.length > 0)).toBe(true);
    expect(result.choiceProposals[0].action).not.toEqual(result.choiceProposals[1].action);
  });

  it("maps a move/travel job to a travel event state", async () => {
    const result = await source.generateScene(makeContext(makeJob({ eventKind: "travel", summary: { kind: "move", locationId: asLocationId("loc_2") } })));
    expect(result.event).toEqual({ kind: "travel", locationId: asLocationId("loc_1") });
  });

  it("maps a talk job to a dialogue event state focused on the job NPC", async () => {
    const result = await source.generateScene(makeContext(makeJob({
      eventKind: "dialogue",
      summary: { kind: "talk", npcId: asNpcId("npc_1") },
      focusNpcId: "npc_1",
    })));
    expect(result.event).toEqual({ kind: "dialogue", focusNpcId: asNpcId("npc_1") });
    expect(result.npcLine?.npcId).toBe(asNpcId("npc_1"));
    expect(result.choiceProposals.map((choice) => choice.action)).toEqual([
      { type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "support" },
      { type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "challenge" },
    ]);
  });

  it("talk job keeps focusNpcId; narration echoes the utterance and the NPC line answers the player_utterance beat", async () => {
    const utterance = "请问关于失踪的商队有什么线索吗？";
    const job = makeJob({
      eventKind: "dialogue",
      summary: { kind: "talk", npcId: asNpcId("npc_1") },
      focusNpcId: "npc_1",
      utterance,
      beats: [{ beatId: "player_utterance", kind: "player_utterance", subjectIds: ["npc_1"], instruction: "直接回应" }],
    });
    const result = await source.generateScene(makeContext(job, makeFocusContext("trusted")));
    expect(result.npcLine?.npcId).toBe(asNpcId("npc_1"));
    expect(result.narration).toContain(utterance);
    expect(result.npcLine?.answeredBeatIds).toContain("player_utterance");
  });

  it.each(["partial_success", "failure", "blocked"] as const)(
    "does not rewrite %s to a success: narration keeps a non-victory tone",
    async (status) => {
      const result = await source.generateScene(makeContext(makeJob({ status, eventKind: "dialogue", summary: { kind: "talk", npcId: asNpcId("npc_1") }, focusNpcId: "npc_1" })));
      expect(result.narration.length).toBeGreaterThan(0);
      expect(result.npcLine?.text).toBeTruthy();
      expect(result.npcLine?.text).not.toContain("欢迎光临");
      if (status === "partial_success") {
        expect(result.npcLine?.text).toContain("不方便全说");
      } else {
        expect(result.npcLine?.text).not.toContain("欢迎光临");
      }
    },
  );

  it("keeps NPC presentation data as proposal fields; ready pages are built only after approval", async () => {
    const result = await source.generateScene(makeContext(makeJob({ eventKind: "dialogue", summary: { kind: "talk", npcId: asNpcId("npc_1") }, focusNpcId: "npc_1" })));
    expect(result.npcLine?.npcId).toBe(asNpcId("npc_1"));
    expect("npcDialogues" in result).toBe(false);
  });

  it("event proposals is empty for deterministic source", async () => {
    const result = await source.generateScene(makeContext(makeJob()));
    expect(result.eventProposals).toEqual([]);
  });

  it("proposes a structured stance consequence after relationship choices cross a threshold", async () => {
    const base = makeContext(makeJob({
      eventKind: "dialogue",
      summary: { kind: "talk", npcId: asNpcId("npc_1") },
      focusNpcId: "npc_1",
    }));
    const context: SceneGenerationContext = {
      ...base,
      presentNpcs: base.presentNpcs.map((npc) => npc.id === asNpcId("npc_1")
        ? { ...npc, relationship: { affinity: 12 } }
        : npc),
    };
    const result = await source.generateScene(context);
    expect(result.eventProposals).toEqual([
      expect.objectContaining({
        kind: "npc_changes_stance",
        involvedEntityIds: ["npc_1"],
        proposedEffects: [{ kind: "npc_changes_stance", npcId: asNpcId("npc_1"), stance: "friendly" }],
      }),
    ]);
  });

  it("choices include a move action toward a reachable location", async () => {
    const result = await source.generateScene(makeContext(makeJob()));
    expect(result.choiceProposals.some((c) => c.action.type === "move" && String(c.action.locationId) === "loc_2")).toBe(true);
  });

  it("active battle fallback proposes two distinct executable battle actions", async () => {
    const context: SceneGenerationContext = {
      ...makeContext(makeJob({ eventKind: "battle" })),
      legalActionCandidates: [
        { kind: "battle_action", label: "攻击", targetId: "attack" },
        { kind: "battle_action", label: "防守", targetId: "guard" },
        { kind: "battle_action", label: "撤退", targetId: "flee" },
      ],
    };
    const result = await source.generateScene(context);
    expect(result.choiceProposals.map((choice) => choice.action)).toEqual([
      { type: "battle_action", action: "attack" },
      { type: "battle_action", action: "guard" },
    ]);
  });

  // ── Task 5 Step 1 + 4：档位感知台词 + 玩家原话应答 ──────────────────────

  it("hostile 与 trusted 对同一 talk action 产出肉眼可辨的不同台词", async () => {
    const hostile = await source.generateScene(makeUtteranceContext("hostile"));
    const trusted = await source.generateScene(makeUtteranceContext("trusted"));
    expect(hostile.npcLine?.text).not.toBe(trusted.npcLine?.text);
    expect(hostile.npcLine?.text).toBeTruthy();
    expect(trusted.npcLine?.text).toBeTruthy();
    // 旁白保留原话回显（不随档位变化），但台词因政策不同
    expect(hostile.narration).toContain("你知道商队失踪的事吗");
    expect(trusted.narration).toContain("你知道商队失踪的事吗");
  });

  it("hostile 档位 NPC 的台词为冷淡拒绝式", async () => {
    const result = await source.generateScene(makeUtteranceContext("hostile"));
    expect(result.npcLine?.text).toMatch(/冷冷|关你事|拒绝/);
    expect(result.npcLine?.emotion).toBe("angry");
  });

  it("trusted 档位 NPC 的台词为坦诚主动式", async () => {
    const result = await source.generateScene(makeUtteranceContext("trusted"));
    expect(result.npcLine?.text).toMatch(/坦诚|告诉|这件事/);
    expect(result.npcLine?.emotion).toBe("warm");
  });

  it("有 player_utterance 节拍时 npcLine 的 answeredBeatIds 包含该节拍 ID", async () => {
    const result = await source.generateScene(makeUtteranceContext("trusted"));
    expect(result.npcLine?.answeredBeatIds).toEqual(["player_utterance"]);
  });

  it("无 player_utterance 节拍时 answeredBeatIds 为空数组", async () => {
    const context = makeContext(makeJob({
      eventKind: "travel",
      summary: { kind: "move", locationId: asLocationId("loc_2") },
    }));
    const result = await source.generateScene(context);
    expect(result.npcLine?.answeredBeatIds).toEqual([]);
  });
});
