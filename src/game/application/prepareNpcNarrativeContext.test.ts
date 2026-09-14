import { describe, expect, it, vi } from "vitest";
import type { NpcEntry } from "@/game/domain/worldEntries";
import { createWorldStateFixture } from "@/game/domain/testing/worldStateFixture.testutil";
import {
  asFactId,
  asGenerationId,
  asLocationId,
  asNpcId,
  PLAYER_ENTITY_ID,
} from "@/game/domain/worldEntity";
import { asEventId, asNarrativeJobId, asTurnId } from "@/game/domain/events";
import { makeCommittedEvent } from "@/game/domain/testing/committedEventFactory";
import type { ResolvedEvent } from "@/game/domain/resolvedEvent";
import { createEntityStore } from "@/game/domain/entity";
import { createPendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import { createInitialStoryState, type StoryState } from "@/game/domain/storyState";
import { prepareNpcNarrativeContext, selectNpcDeliberationTarget } from "./prepareNpcNarrativeContext";
import type { NarrativeBundleSourceContext } from "./narrativeBundleSource";
import type { NpcDeliberationProposal } from "./npcDeliberationSource";

function decisionContext(): Extract<NarrativeBundleSourceContext, { kind: "decision" }> {
  const storyState = pendingStoryState();
  if (storyState.narrative.status !== "provider_pending") throw new Error("fixture must be pending");
  return { kind: "decision", worldState: worldState(), storyState, job: storyState.narrative.job, candidateVersion: 2 };
}

function proposal(): NpcDeliberationProposal {
  return { npcId: BOSS, response: "refuse", goalIds: [], evidenceEventIds: [], discloseFactIds: [PUBLIC_FACT], interactionProposals: [] };
}

describe("prepareNpcNarrativeContext", () => {
  it("selects only the focused NPC that is present, active, and needs judgment", () => {
    const context = { ...decisionContext(), job: { ...decisionContext().job, utterance: "我请求引荐" } };
    expect(selectNpcDeliberationTarget(context)).toBe(BOSS);
    expect(selectNpcDeliberationTarget({ ...context, job: { ...context.job, focusNpcId: undefined } })).toBeUndefined();
    expect(selectNpcDeliberationTarget({ ...context, job: { ...context.job, utterance: "你好！" } })).toBeUndefined();
  });

  it("skips opening and uses conditional knowledge as a state-based call trigger", async () => {
    const opening: NarrativeBundleSourceContext = {
      kind: "opening", jobId: JOB_ID, input: { gameType: "wuxia", gameLength: "short", seed: "test" },
    };
    const generate = vi.fn(async () => ({ ok: true as const, proposal: proposal() }));
    expect(await prepareNpcNarrativeContext(opening, { generate })).toEqual({ ok: true, context: opening });
    expect(generate).not.toHaveBeenCalled();
    const base = decisionContext();
    const entityStore = createEntityStore(base.worldState.entityStore.records.map(record => {
      if (!("dynamicState" in record) || record.core.id !== BOSS) return record;
      return { ...record, knowledge: { entries: record.knowledge.entries.map(entry => entry.factId === PRIVATE_FACT ? { ...entry, disclosure: "conditional" as const } : entry) } };
    }));
    const result = await prepareNpcNarrativeContext({
      ...base, worldState: { ...base.worldState, entityStore }, job: { ...base.job, utterance: "你有什么想法？" },
    }, { generate });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });
  it("passes one private context and controls, returns only authorized outward without writes", async () => {
    const base = decisionContext();
    const context = { ...base, job: { ...base.job, utterance: "我请求引荐" } };
    const before = JSON.stringify(context);
    const signal = new AbortController().signal;
    const reserveHttpAttempt = vi.fn(async () => true);
    const generate = vi.fn(async () => ({ ok: true as const, proposal: proposal() }));
    const result = await prepareNpcNarrativeContext({ ...context, signal, reserveHttpAttempt }, { generate });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ npcId: BOSS, candidateVersion: 2, signal, reserveHttpAttempt }));
    expect(JSON.stringify(generate.mock.calls)).toContain("不能让接应人提前得知的暗路");
    expect(JSON.stringify(generate.mock.calls)).not.toContain("接应人的私人记忆");
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    if (!result.ok || result.context.kind !== "decision") throw new Error("expected decision");
    expect(result.context.npcOutward).toEqual([{ npcId: BOSS, response: "refuse", evidenceEventIds: [], discloseFactIds: [PUBLIC_FACT], interactionProposals: [] }]);
    expect(JSON.stringify(result.context.npcOutward)).not.toContain("暗路");
    expect(JSON.stringify(result.context.npcOutward)).not.toContain("goalIds");
    expect(JSON.stringify(context)).toBe(before);
  });

  it("skips a normal greeting and does not choose another NPC when focus is absent", async () => {
    const context = decisionContext();
    const generate = vi.fn();
    const greeting = { ...context, job: { ...context.job, utterance: "你好！" } };
    expect(await prepareNpcNarrativeContext(greeting, { generate })).toEqual({ ok: true, context: greeting });
    const absent = { ...context, job: { ...context.job, focusNpcId: undefined } };
    expect(await prepareNpcNarrativeContext(absent, { generate })).toEqual({ ok: true, context: absent });
    expect(generate).not.toHaveBeenCalled();
  });

  it.each(["secret", "missing_event", "wrong_speaker"] as const)("rejects %s with no outward", async fault => {
    const context = decisionContext();
    const invalid = { ...proposal(),
      ...(fault === "secret" ? { discloseFactIds: [PRIVATE_FACT] } : {}),
      ...(fault === "missing_event" ? { evidenceEventIds: [asEventId("turn:missing:fact")] } : {}),
      ...(fault === "wrong_speaker" ? { npcId: RECIPIENT } : {}),
    };
    const result = await prepareNpcNarrativeContext({ ...context, job: { ...context.job, utterance: "请求引荐" } }, {
      generate: async () => ({ ok: true, proposal: invalid }),
    });
    expect(result).toMatchObject({ ok: false, repairReason: "invalid_reference", failure: { kind: "AI_RESPONSE_INVALID" } });
    expect(result).not.toHaveProperty("context");
  });

  it("returns unified provider failure and rejects cancellation after source returns", async () => {
    const base = decisionContext();
    const context = { ...base, job: { ...base.job, utterance: "请求核验" } };
    expect(await prepareNpcNarrativeContext(context, { generate: async () => ({ ok: false, code: "PROVIDER_FAILURE" }) }))
      .toMatchObject({ ok: false, repairReason: "provider_failure", failure: { kind: "AI_CALL_FAILED" } });
    const controller = new AbortController();
    expect(await prepareNpcNarrativeContext({ ...context, signal: controller.signal }, {
      generate: async () => { controller.abort(); return { ok: true, proposal: proposal() }; },
    })).toMatchObject({ ok: false, repairReason: "provider_failure", repairDetail: "aborted" });
  });
});

const LOCATION = asLocationId("loc:old_bridge");
const BOSS = asNpcId("npc:night_watch");
const RECIPIENT = asNpcId("npc:guide");
const PUBLIC_FACT = asFactId("fact:bridge_footprints");
const PRIVATE_FACT = asFactId("fact:secret_route");
const RECIPIENT_PRIVATE_FACT = asFactId("fact:recipient_secret");
const TURN_ID = asTurnId("turn:npc_deliberation");
const JOB_ID = asNarrativeJobId("job:npc_deliberation");
const EVENT_ID = asEventId("turn:npc_deliberation:npc_interaction");

const generation = {
  generationId: asGenerationId("generation:test"),
  seed: "npc-deliberation-test",
  templateVersion: "test",
  inputDigest: "",
  gameType: "wuxia" as const,
};

function npc(input: {
  id: typeof BOSS | typeof RECIPIENT;
  name: string;
  knownFactIds: readonly (typeof PUBLIC_FACT | typeof PRIVATE_FACT | typeof RECIPIENT_PRIVATE_FACT)[];
  hiddenFactIds?: readonly (typeof PRIVATE_FACT | typeof RECIPIENT_PRIVATE_FACT)[];
  goals?: readonly string[];
}): NpcEntry {
  return {
    id: input.id,
    name: input.name,
    role: input.id === BOSS ? "旧桥守夜人" : "渡口接应人",
    description: input.id === BOSS ? "熟悉旧桥周边的暗路" : "负责在渡口接应来客",
    locationId: LOCATION,
    isCompanion: false,
    tags: [],
    met: true,
    memory: {
      npcId: input.id,
      knownFactIds: input.knownFactIds,
      hiddenFactIds: input.hiddenFactIds ?? [],
      interactionHistory: [],
      relationship: { affinity: input.id === BOSS ? 65 : 20 },
      emotion: input.id === BOSS ? "guarded" : "neutral",
      goals: input.goals ?? [],
    },
  };
}

function worldState() {
  const event = makeCommittedEvent({
    type: "npc_interaction_recorded",
    npcId: BOSS,
    dialogueAct: "ask",
  }, {
    eventId: EVENT_ID,
    turnId: TURN_ID,
    actionId: "action:ask_route",
    turnNumber: 1,
    actorIds: [BOSS, PLAYER_ENTITY_ID],
    targetIds: [PLAYER_ENTITY_ID],
    locationId: LOCATION,
  });
  return createWorldStateFixture({
    generation,
    projection: {
      player: { name: "行者", identity: "调查者", stats: { hp: 100, attack: 10, defense: 5 } },
      locations: [{
        id: LOCATION,
        name: "旧桥",
        description: "雾中的旧桥",
        kind: "main",
        connectedLocationIds: [],
        npcIds: [BOSS, RECIPIENT],
        availableItemIds: [],
        tags: [],
      }],
      currentLocationId: LOCATION,
      unlockedLocationIds: [LOCATION],
      visitedLocationIds: [LOCATION],
      npcs: [
        npc({
          id: BOSS,
          name: "守夜人",
          knownFactIds: [PUBLIC_FACT, PRIVATE_FACT],
          hiddenFactIds: [PRIVATE_FACT],
          goals: ["保护暗路线，拒绝让陌生人暴露它"],
        }),
        npc({
          id: RECIPIENT,
          name: "接应人",
          knownFactIds: [PUBLIC_FACT, RECIPIENT_PRIVATE_FACT],
          hiddenFactIds: [RECIPIENT_PRIVATE_FACT],
        }),
      ],
      items: [],
      inventory: [],
      worldFacts: [
        { factId: PUBLIC_FACT, text: "桥下留有新鲜脚印", source: "generated", discovered: true, locationId: LOCATION },
        { factId: PRIVATE_FACT, text: "守夜人知道一条不能让接应人提前得知的暗路", source: "generated", discovered: false, locationId: LOCATION },
        { factId: RECIPIENT_PRIVATE_FACT, text: "接应人的私人记忆", source: "generated", discovered: false, locationId: LOCATION },
      ],
      quests: [],
      enemies: [],
      defeatedEnemyIds: [],
      factions: [],
    },
    eventLedger: [event],
  });
}

function pendingStoryState(): StoryState {
  const resolvedEvent: ResolvedEvent = {
    actionId: "action:ask_route",
    status: "success",
    eventKind: "dialogue",
    facts: [],
    stateChanges: [],
    costs: [],
    rewards: [],
    triggeredEvents: [],
    rejectedEffects: [],
  };
  const result = createPendingNarrativeJob({
    jobId: JOB_ID,
    turnId: TURN_ID,
    actionId: "action:ask_route",
    expectedRevision: 3,
    turnNumber: 1,
    actionSummary: { kind: "talk", npcId: BOSS },
    utterance: "你为什么不肯让接应人知道路线？",
    resolvedEvent,
    domainEventIds: [EVENT_ID],
    focusNpcId: BOSS,
    selectedDialogue: { dialogueAct: "ask", label: "追问暗路" },
    requestedAt: "2026-09-13T00:00:00.000Z",
    objectiveTransition: { before: null, completed: [], after: null, mode: "unchanged" },
    mandatoryBeats: [],
    generationKind: "npc_free_text",
    sceneRequestKind: "npc_response",
  });
  if (!result.ok) throw new Error("test pending job fixture is invalid");
  return {
    ...createInitialStoryState({
      gameLength: "short",
      initialEntityCounts: { locations: 1, npcs: 2, quests: 0, events: 1 },
      initialNarrative: { status: "ready", mode: "ai", currentScene: {
        sceneId: "scene:previous",
        turn: 0,
        narration: "之前的场景",
        usedFactIds: [],
        npcLine: null,
        choices: [],
        source: "rule",
      }, choiceRegistry: [] },
    }),
    narrative: { status: "provider_pending", mode: "ai", job: result.job, lastPresentedScene: null },
  };
}
