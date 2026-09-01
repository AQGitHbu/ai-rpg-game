import { describe, expect, it } from "vitest";
import { asNarrativeJobId, asTurnId } from "./events";
import type { ResolvedEvent } from "./resolvedEvent";
import { createPendingNarrativeJob, type PendingNarrativeJob } from "./pendingNarrativeJob";
import { asLocationId, asNpcId } from "./worldEntity";
import type {
  NarrativeRuntimeState,
  NarrativeSceneState,
} from "./narrative";
import { buildNpcDialoguePages, parseNarrativeRuntimeState } from "./narrative";
import type { NarrativeGenerationFailure } from "./narrativeGenerationFailure";

function canonicalResolvedEvent(): ResolvedEvent {
  return {
    actionId: "action-1",
    status: "success",
    eventKind: "observe",
    facts: [],
    stateChanges: [],
    costs: [],
    rewards: [],
    triggeredEvents: [],
    rejectedEffects: [],
  };
}

function providerJob(): PendingNarrativeJob {
  const result = createPendingNarrativeJob({
    jobId: asNarrativeJobId("job-1"),
    turnId: asTurnId("turn-1"),
    actionId: "action-1",
    expectedRevision: 41,
    turnNumber: 3,
    actionSummary: { kind: "talk", npcId: asNpcId("npc_1") },
    utterance: "我想打听矿坑的事",
    resolvedEvent: canonicalResolvedEvent(),
    domainEventRange: { fromLedgerIndex: 12, toLedgerIndexExclusive: 15 },
    focusNpcId: asNpcId("npc_1"),
    requestedAt: "2026-08-08T08:00:00.000Z",
    objectiveTransition: { before: null, completed: [], after: null, mode: "unchanged" },
    mandatoryBeats: [],
    generationKind: "npc_fixed_choice",
    sceneRequestKind: "npc_response",
  });
  if (!result.ok) throw new Error("fixture 构造失败");
  return result.job;
}

const readyScene = {
  sceneId: "scene-1",
  turn: 1,
  narration: "雨声压低了酒馆里的交谈。",
  usedFactIds: [],
  npcLine: null,
  choices: [
    { choiceToken: "c_0123456789abcdef", label: "询问掌柜" },
    { choiceToken: "c_fedcba9876543210", label: "检查角落", hint: "可能发现新线索" },
  ],
  source: "fixture",
  event: { kind: "observe", locationId: asLocationId("loc_1") },
} satisfies NarrativeSceneState;

const failure = {
  kind: "AI_RESPONSE_INVALID",
  phase: "scene",
  failedAt: "2026-08-21T00:00:00.000Z",
  reason: "segment_unknown_beat",
} satisfies NarrativeGenerationFailure;

describe("NarrativeSceneState", () => {
  it("stores fixture scenes and optional handoff acknowledgement", () => {
    const scene = {
      ...readyScene,
      handoffAcknowledgement: "我会沿着河岸去找他。",
    } satisfies NarrativeSceneState;

    expect(scene.choices).toHaveLength(2);
    expect(scene.source).toBe("fixture");
    expect(JSON.stringify(scene)).not.toContain("actionKey");
  });

  it("marks deterministic non-focus NPC speech as fixture", () => {
    const dialogues = buildNpcDialoguePages([
      { id: asNpcId("npc_1"), name: "老周", role: "茶摊老人" },
      { id: asNpcId("npc_2"), name: "赵四", role: "客栈掌柜" },
    ], {
      focusNpcId: asNpcId("npc_1"),
      focusSpeech: "旧案的线索我会说清楚。你去客栈找赵四，他见过那晚的来客。",
      generatedNpcLines: new Map([
        ["npc_2", "客官若是来打听旧案，先坐下喝口热茶。店里的出入我都记得几分。"],
      ]),
    });

    expect(dialogues[0]?.speechSource).toBe("generated");
    expect(dialogues[0]?.speechPurpose).toBe("focus");
    expect(dialogues[1]?.speechSource).toBe("generated");
    expect(dialogues[1]?.speechPurpose).toBe("ambient");
    const fallback = buildNpcDialoguePages([
      { id: asNpcId("npc_3"), name: "钱五", role: "脚夫" },
    ])[0];
    expect(fallback?.speechSource).toBe("fixture");
    expect(fallback?.speechPurpose).toBe("ambient");
  });
});

describe("NarrativeRuntimeState", () => {
  const ready = {
    status: "ready",
    mode: "offline",
    currentScene: readyScene,
    choiceRegistry: [],
  } satisfies NarrativeRuntimeState;
  const pending = {
    status: "provider_pending",
    mode: "ai",
    job: providerJob(),
    lastPresentedScene: readyScene,
    retryContext: { attempt: 1, reason: "segment_unknown_beat" },
  } satisfies NarrativeRuntimeState;
  const failed = {
    status: "provider_failed",
    mode: "ai",
    job: providerJob(),
    failure,
    lastPresentedScene: readyScene,
  } satisfies NarrativeRuntimeState;

  it.each([ready, pending, failed])("parses valid $status state", (runtime) => {
    expect(parseNarrativeRuntimeState(runtime)).toEqual({ ok: true, value: runtime });
  });

  it("保留 provider pending 的上次稳定失败原因", () => {
    expect(parseNarrativeRuntimeState(pending)).toMatchObject({
      ok: true,
      value: { retryContext: { attempt: 1, reason: "segment_unknown_beat" } },
    });
  });

  it("rejects legacy generation and mixed variant fields", () => {
    expect(parseNarrativeRuntimeState({
      ...ready,
      generation: { status: "idle" },
    })).toEqual({ ok: false, code: "INVALID_NARRATIVE_RUNTIME" });
    expect(parseNarrativeRuntimeState({ ...ready, job: providerJob() }))
      .toEqual({ ok: false, code: "INVALID_NARRATIVE_RUNTIME" });
    expect(parseNarrativeRuntimeState({ ...pending, choiceRegistry: [] }))
      .toEqual({ ok: false, code: "INVALID_NARRATIVE_RUNTIME" });
    expect(parseNarrativeRuntimeState({ ...failed, currentScene: readyScene }))
      .toEqual({ ok: false, code: "INVALID_NARRATIVE_RUNTIME" });
  });

  it("rejects ready state without its scene or registry", () => {
    const { currentScene: _scene, ...missingScene } = ready;
    const { choiceRegistry: _registry, ...missingRegistry } = ready;
    expect(parseNarrativeRuntimeState(missingScene))
      .toEqual({ ok: false, code: "INVALID_NARRATIVE_RUNTIME" });
    expect(parseNarrativeRuntimeState(missingRegistry))
      .toEqual({ ok: false, code: "INVALID_NARRATIVE_RUNTIME" });
  });

  it("rejects provider states whose job is not provider-authorized", () => {
    const localJob = { ...providerJob(), generationKind: null, sceneRequestKind: null };
    expect(parseNarrativeRuntimeState({ ...pending, job: localJob }))
      .toEqual({ ok: false, code: "INVALID_NARRATIVE_RUNTIME" });
  });

  it("rejects malformed persisted failure", () => {
    expect(parseNarrativeRuntimeState({
      ...failed,
      failure: { kind: "AI_RESPONSE_INVALID", phase: "world", failedAt: "yesterday" },
    })).toEqual({ ok: false, code: "INVALID_NARRATIVE_RUNTIME" });
    expect(parseNarrativeRuntimeState({
      ...failed,
      failure: { kind: "AI_RESPONSE_INVALID", phase: "scene", failedAt: "2026-08-21T00:00:00.000Z", reason: "contains spaces" },
    })).toEqual({ ok: false, code: "INVALID_NARRATIVE_RUNTIME" });
  });

  it("rejects a prepared graph containing unknown active IDs", () => {
    expect(parseNarrativeRuntimeState({
      ...ready,
      preparedContinuation: {
        originJobId: asNarrativeJobId("job-prepared"),
        steps: [],
        activeStepIds: ["missing-step"],
      },
    })).toEqual({ ok: false, code: "INVALID_NARRATIVE_RUNTIME" });
  });

  it("round-trips complete battle checkpoint continuation fields and keeps old omissions compatible", () => {
    const checkpoint = {
      storySnapshot: { turnNumber: 3 },
      currentScene: readyScene,
      choiceRegistry: [],
      preparedContinuation: {
        originJobId: asNarrativeJobId("job-checkpoint"),
        steps: [],
        activeStepIds: [],
      },
      dialogueResume: {
        objectiveKey: "quest_1:0",
        npcId: asNpcId("npc_1"),
        locationId: asLocationId("loc_1"),
        scene: readyScene,
        choiceRegistry: [],
      },
      dialogueSession: {
        npcId: asNpcId("npc_1"), turnCount: 1, requiredTurns: 2, completed: false,
      },
    };
    const runtime = { ...ready, battleCheckpoint: checkpoint };
    expect(parseNarrativeRuntimeState(runtime)).toEqual({ ok: true, value: runtime });
    expect(parseNarrativeRuntimeState({ ...ready, battleCheckpoint: {
      storySnapshot: { turnNumber: 3 }, currentScene: readyScene, choiceRegistry: [],
    } })).toMatchObject({ ok: true });
    expect(parseNarrativeRuntimeState({ ...ready, battleCheckpoint: {
      ...checkpoint, preparedContinuation: { ...checkpoint.preparedContinuation, unexpected: true },
    } })).toEqual({ ok: false, code: "INVALID_NARRATIVE_RUNTIME" });
    expect(parseNarrativeRuntimeState({ ...ready, battleCheckpoint: {
      ...checkpoint, dialogueResume: { ...checkpoint.dialogueResume, choiceRegistry: [null] },
    } })).toEqual({ ok: false, code: "INVALID_NARRATIVE_RUNTIME" });
  });
});
