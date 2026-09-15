import { describe, expect, it } from "vitest";
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
import { createEntityStore, entitiesOfKind, type NpcEntityRecord, type RelationshipCommitment } from "@/game/domain/entity";
import { createPendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import { createInitialStoryState, type StoryState } from "@/game/domain/storyState";
import { playerActionHistoryEntry } from "@/game/domain/narrativeHistory";
import type { NarrativeMemoryContext } from "@/game/domain/narrativeMemoryContext";
import { projectNpcDeliberation } from "./projectNpcDeliberation";
import { prepareNarrativeMemory } from "./prepareNarrativeMemory";
import { asGameId } from "./server/persistence/gameRepository";

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

describe("projectNpcDeliberation", () => {
  it("把本轮实际事件关联的 Thread 与可用互动引用送入 NPC 私有判断", () => {
    const baseStory = pendingStoryState();
    const story = {
      ...baseStory,
      threads: [{
        ...baseStory.threads[0]!,
        id: "thread:private-consequence",
        participantIds: [BOSS],
        causeEventIds: [EVENT_ID],
        goalRefs: [{ npcId: BOSS, goalId: "goal_private" }],
        question: "调查后是否继续守密",
      }],
    };
    const projected = projectNpcDeliberation({
      worldState: worldState(), storyState: story, npcId: BOSS, jobId: JOB_ID, candidateVersion: 1,
    });
    const envelope = JSON.parse(projected.privateContext) as {
      currentConsequences?: { activeThreadIds: readonly string[]; requiredEventIds: readonly string[] };
    };
    expect(envelope.currentConsequences?.activeThreadIds).toEqual(["thread:private-consequence"]);
    expect(envelope.currentConsequences?.requiredEventIds).toEqual([EVENT_ID]);
  });

  it("uses observer preparation to recall private old words and preserves multiple event payloads", async () => {
    const baseWorld = worldState();
    const second = { ...baseWorld.eventLedger[0]!, eventId: asEventId("old:second"), sequence: 100 };
    const world = { ...baseWorld, eventLedger: [...baseWorld.eventLedger, second] };
    const baseStory = pendingStoryState();
    if (baseStory.narrative.status !== "provider_pending") throw new Error("expected pending job");
    const job = { ...baseStory.narrative.job, utterance: "接下来怎么办", domainEventIds: [EVENT_ID, second.eventId] };
    const quote = "只有我记得桥底那枚暗记，接应人没有听见。";
    const entries = Array.from({ length: 20 }, (_, sequence) => ({
      id: `private:${sequence}`, segmentId: `segment:${sequence}`, sequence, actionId: null, jobId: null, sceneId: `scene:${sequence}`,
      revision: 1, turnNumber: 1, kind: "npc_line" as const, speakerId: BOSS, audienceIds: [BOSS],
      entityIds: sequence === 0 || sequence === 5 ? [LOCATION] : [], factIds: [], eventIds: [], choiceToken: null,
      text: sequence === 5 ? quote : `本人的独立记忆${sequence}`,
    }));
    const story = { ...baseStory, history: { entries }, narrative: { ...baseStory.narrative, job } };
    const prepare = (observerId: typeof BOSS) => prepareNarrativeMemory({
      record: { gameId: asGameId("npc:prepared"), worldState: world, storyState: story, revision: 4, createdAt: "2026-01-01" },
      observerId, job, source: { select: async () => { throw new Error("unexpected summary"); } },
      repository: { load: async () => ({ summaryRevision: 1, state: {
        formatVersion: 1, observerId, policyVersion: "memory-p2/1", summaryRevision: 1, coveredThroughSequence: 9,
        coveredSourceFingerprint: "valid", batches: [], overview: { historyIds: ["private:0"], eventIds: [] },
      } }), publish: async () => ({ ok: true }) },
      summaries: "enabled", signal: new AbortController().signal, reserveBatchUpdate: async () => false, reserveSummaryHttpAttempt: async () => false,
      policy: { threshold: 50, batchSize: 10, rawSoftEstimatedTokens: 24_000, summarySourceMaxEstimatedTokens: 24_000, overviewMaxEstimatedTokens: 6_000, promptMaxEstimatedTokens: 64_000 },
    });
    const result = await prepare(BOSS);
    if (!result.ok) throw new Error(result.code);
    const projected = projectNpcDeliberation({ worldState: world, storyState: story, npcId: BOSS, jobId: JOB_ID, candidateVersion: 1, memoryContext: result.context });
    const envelope = JSON.parse(projected.privateContext);
    expect(envelope.historicalMemory.recalled.some((entry: { text: string }) => entry.text === quote)).toBe(true);
    expect(envelope.historicalMemory.requiredEvents.map((event: { eventId: string }) => event.eventId)).toEqual([EVENT_ID, second.eventId]);
    expect(envelope.historicalMemory.requiredEvents[1].payload).toEqual(second.payload);
    const other = await prepare(RECIPIENT);
    if (!other.ok) throw new Error(other.code);
    expect(JSON.stringify(other.context)).not.toContain(quote);
  });
  it("projects one NPC's private knowledge and goals without importing another NPC's secret", () => {
    const input = projectNpcDeliberation({
      worldState: worldState(),
      storyState: pendingStoryState(),
      npcId: BOSS,
      jobId: JOB_ID,
      candidateVersion: 4,
    });

    expect(input).toMatchObject({ npcId: BOSS, jobId: JOB_ID, candidateVersion: 4 });
    expect(input.privateContext).toContain("守夜人知道一条不能让接应人提前得知的暗路");
    expect(input.privateContext).toContain("保护暗路线，拒绝让陌生人暴露它");
    expect(input.privateContext).toContain(String(EVENT_ID));
    expect(input.privateContext).toContain("你为什么不肯让接应人知道路线？");
    expect(input.privateContext).not.toContain("接应人的私人记忆");
    expect(input.privateContext).not.toContain("authorPrompt");
    const envelope = JSON.parse(input.privateContext);
    expect(envelope.outwardAuthority.allowedDiscloseFactIds).not.toContain(PRIVATE_FACT);
    expect(envelope.currentEvidence.map((event: { eventId: string }) => event.eventId))
      .toEqual(envelope.outwardAuthority.allowedEvidenceEventIds);
  });

  it("preserves the initial_world provenance boundary for a newly materialized NPC", () => {
    const store = worldState().entityStore;
    const boss = entitiesOfKind(store, "npc").find((record) => record.core.id === BOSS);
    const recipient = entitiesOfKind(store, "npc").find((record) => record.core.id === RECIPIENT);
    expect(boss).toBeDefined();
    expect(recipient).toBeDefined();
    if (boss === undefined || recipient === undefined) return;

    expect(boss.knowledge.entries.find((entry) => entry.factId === PRIVATE_FACT)?.source).toEqual({
      kind: "initial_world",
      learnedAtTurn: 0,
    });
    expect(recipient.knowledge.entries.some((entry) => entry.factId === PRIVATE_FACT)).toBe(false);
  });
});

it("shows only this NPC's open and resolved confidentiality terms in private deliberation", () => {
  const base = worldState();
  const terms = { protectedFactIds: [PRIVATE_FACT], allowedAudienceIds: [PLAYER_ENTITY_ID, BOSS], fulfillment: { kind: "story_delivery" as const } };
  const store = createEntityStore(base.entityStore.records.map((record) => {
    if (record.core.kind !== "npc") return record;
    const npcRecord = record as NpcEntityRecord;
    const commitments: RelationshipCommitment[] = ["open", "broken", "fulfilled"].map((status) => ({
      kind: "promise", commitmentId: `${record.core.id}:${status}`, promisor: "target", status: status as "open" | "broken" | "fulfilled",
      description: record.core.id === BOSS ? "本人的保密约定" : "其他NPC的秘密约定",
      source: { kind: "action", actionId: "pledge", turnNumber: 1 }, confidentiality: terms,
    }));
    return { ...npcRecord, relationships: { outgoing: npcRecord.relationships.outgoing.map((edge) => ({ ...edge, commitments })) } };
  }));
  const input = projectNpcDeliberation({ worldState: { ...base, entityStore: store }, storyState: pendingStoryState(), npcId: BOSS, jobId: JOB_ID, candidateVersion: 1 });
  const context = JSON.parse(input.privateContext);
  expect(context.relationships[0].openCommitments).toEqual([expect.objectContaining({ commitmentId: `${BOSS}:open`, status: "open", confidentiality: terms })]);
  expect(context.relationships[0].resolvedCommitments).toEqual([
    expect.objectContaining({ commitmentId: `${BOSS}:broken`, status: "broken", confidentiality: terms }),
    expect.objectContaining({ commitmentId: `${BOSS}:fulfilled`, status: "fulfilled", confidentiality: terms }),
  ]);
  expect(input.privateContext).not.toContain("其他NPC的秘密约定");
  expect(input.privateContext).not.toContain(`${RECIPIENT}:broken`);
});


it("recovers only the current focused player expression without turning labels into utterances", () => {
  const base = pendingStoryState();
  if (base.narrative.status !== "provider_pending") throw new Error("fixture");
  const job = { ...base.narrative.job, utterance: undefined, selectedDialogue: { dialogueAct: "ask" as const } };
  const entry = playerActionHistoryEntry({ history: base.history, action: { type: "talk", npcId: BOSS, dialogueAct: "ask" },
    actionId: job.actionId, text: "actual selected words", sceneId: "selected", revision: 1, turnNumber: 1, eventIds: [EVENT_ID] });
  const storyState = { ...base, narrative: { ...base.narrative, job }, history: { entries: [entry, { ...entry, id: "other", actionId: "other", text: "unrelated private words" }] } };
  const project = (npcId: typeof BOSS) => JSON.parse(projectNpcDeliberation({ worldState: worldState(), storyState, npcId, jobId: JOB_ID, candidateVersion: 1 }).privateContext);
  expect(project(BOSS).currentJob.selectedExpression).toEqual([{ kind: "player_choice", text: "actual selected words" }]);
  expect(project(BOSS).currentJob.utterance).toBeUndefined();
  expect(JSON.stringify(project(BOSS))).not.toContain("unrelated private words");
  expect(project(RECIPIENT).currentJob.selectedExpression).toBeUndefined();
});

it("adds only the matching NPC's source-linked private memory and rejects a mismatched observer", () => {
  const memory: NarrativeMemoryContext = {
    observerId: BOSS,
    coveredThroughSequence: -1,
    overviewHistoryIds: [],
    overviewEventIds: [],
    uncovered: [{
      id: "history:boss-private",
      segmentId: "segment:boss-private",
      sequence: 0,
      actionId: "action:boss-private",
      jobId: null,
      sceneId: "scene:boss-private",
      revision: 1,
      turnNumber: 1,
      kind: "npc_line",
      text: "我只对自己说过的暗路仍记得清楚。",
      speakerId: BOSS,
      audienceIds: [BOSS],
      entityIds: [BOSS],
      factIds: [],
      eventIds: [],
      choiceToken: null,
    }],
    recalled: [],
    requiredEvents: [],
    referencedEntityIds: [BOSS],
    ambiguousEntityIds: [],
    manifest: [{ ref: "history:boss-private", reason: "private_history", mandatory: true }],
  };
  const input = projectNpcDeliberation({
    worldState: worldState(), storyState: pendingStoryState(), npcId: BOSS,
    jobId: JOB_ID, candidateVersion: 1, memoryContext: memory,
  });
  expect(input.privateContext).toContain("我只对自己说过的暗路仍记得清楚");
  expect(() => projectNpcDeliberation({
    worldState: worldState(), storyState: pendingStoryState(), npcId: RECIPIENT,
    jobId: JOB_ID, candidateVersion: 1, memoryContext: memory,
  })).toThrow("NPC_MEMORY_OBSERVER_MISMATCH");
});
