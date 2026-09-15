/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { baseWorld, makeNpc, quest, NPC_1_ID, NPC_2_ID, FACT_1_ID, LOC_1_ID, LOC_2_ID } from "@/game/gameplay/rpg/narrativeContext/narrativeContext.testutil";
import { projectEntityStore, type NpcEntityRecord } from "@/game/domain/entity";
import { createInitialStoryState } from "@/game/domain/storyState";
import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { rebuildEpisodicMemory } from "@/game/domain/episodicMemory";
import { asEventId, asTurnId, asNarrativeJobId } from "@/game/domain/events";
import { makeCommittedEvent } from "@/game/domain/testing/committedEventFactory";
import { PLAYER_ENTITY_ID, asNpcId } from "@/game/domain/worldEntity";
import { createPendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import { createSqliteClient } from "../server/persistence/sqliteClient";
import { createSqliteGameRepository } from "../server/persistence/sqliteGameRepository";
import { asGameId } from "../server/persistence/gameRepository";
import { createNarrativeBundleSource } from "../server/ai/liveNarrativeBundleSource";
import { generatePendingNarrativeBundle } from "../generatePendingNarrativeBundle";
import { retryNarrativeGeneration } from "../retryNarrativeGeneration";

const now = () => "2026-09-15T00:00:00.000Z";

function fixture(last: boolean, bindInCandidate = false, restrictedListener = false) {
  const q = quest([{ kind: "talk_to_npc", npcId: NPC_2_ID, completionConditions: [{ kind: "knows_fact", actorId: NPC_2_ID, factId: FACT_1_ID }] },
    ...(last ? [] : [{ kind: "visit_location" as const, locationId: LOC_2_ID }, { kind: "talk_to_npc" as const, npcId: asNpcId("npc_3") }])]);
  const speaker = makeNpc(NPC_1_ID, "证人", "证人", true);
  let worldState = baseWorld({ npcs: [{ ...speaker, memory: { ...speaker.memory, knownFactIds: [FACT_1_ID] } }, makeNpc(NPC_2_ID, "接应人", "接应人", true), { ...makeNpc(asNpcId("npc_3"), "旅店主", "旅店主"), locationId: LOC_2_ID }],
    quests: [q], worldFacts: [{ factId: FACT_1_ID, text: "封印完好。", source: "generated", discovered: true, locationId: LOC_1_ID }],
    eventLedger: [makeCommittedEvent({ type: "npc_interaction_recorded", npcId: NPC_2_ID, dialogueAct: "ask" }, {
      eventId: asEventId("turn:ask:interaction"), turnId: asTurnId("turn:ask"), actionId: "action:ask", sequence: 0,
      actorIds: [PLAYER_ENTITY_ID], targetIds: [NPC_2_ID], locationId: LOC_1_ID })] });
  const resolution = { completeWhen: [{ kind: "knows_fact" as const, actorId: NPC_2_ID, factId: FACT_1_ID }], blockWhen: [] };
  const speakerKnowledge = (worldState.entityStore.records.find(record => record.core.id === NPC_1_ID) as NpcEntityRecord).knowledge;
  const entityStore = { ...worldState.entityStore, records: worldState.entityStore.records.map(record => record.core.id !== NPC_2_ID ? record : {
    ...(record as NpcEntityRecord),
    ...(restrictedListener ? { knowledge: { entries: speakerKnowledge.entries.map(entry => ({ ...entry, certainty: "suspected" as const, disclosure: "secret" as const })) } } : {}),
    dynamicState: { ...(record as NpcEntityRecord).dynamicState, goals: [{ goalId: "hear", horizon: "short" as const, description: "获知封印情况", priority: 3 as const,
      status: "active" as const, reason: "确认状况", ...(bindInCandidate ? {} : { resolution }) }] } }) };
  worldState = { ...worldState, entityStore, ...projectEntityStore(entityStore) };
  const transition = { before: null, completed: [], after: { questId: q.id, objectiveIndex: 0, label: "交谈" }, mode: "unchanged" as const };
  const job = createPendingNarrativeJob({ jobId: asNarrativeJobId("job:disclosure"), turnId: asTurnId("turn:ask"), actionId: "action:ask", expectedRevision: 0, turnNumber: 1,
    actionSummary: { kind: "talk", npcId: NPC_2_ID }, resolvedEvent: { actionId: "action:ask", status: "success", eventKind: "dialogue", facts: [], stateChanges: [], costs: [], rewards: [], triggeredEvents: [], rejectedEffects: [] },
    domainEventIds: worldState.eventLedger.map(e => e.eventId), requestedAt: now(), objectiveTransition: transition, mandatoryBeats: [], generationKind: "npc_free_text", sceneRequestKind: "npc_response" });
  if (!job.ok) throw new Error("invalid job");
  const initial = createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short", initialEntityCounts: { locations: 2, npcs: 2, quests: 1, events: 1 } });
  const storyState = { ...initial, evolution: { ...initial.evolution, nextLocationOrdinal: 1, nextNpcOrdinal: 1, nextQuestOrdinal: 1 }, turnNumber: 1, reveal: { questId: q.id, visibleObjectiveIndex: 0 }, memory: rebuildEpisodicMemory(worldState.eventLedger),
    narrative: { status: "provider_pending" as const, mode: "ai" as const, job: job.job, lastPresentedScene: null } };
  const scene = { expressions: [{ kind: "narration", beatId: "atmosphere", text: "证人转向接应人。", referencedEntityIds: [] },
    { kind: "npc_line", npcId: NPC_1_ID, audienceIds: [NPC_2_ID, PLAYER_ENTITY_ID], text: "封印完好。", emotion: "neutral", answeredBeatIds: [], usedFactIds: [FACT_1_ID], usedEventIds: [] }], objectiveLink: last ? null : { questId: q.id, objectiveIndex: 1, mode: "progress" }, choices: [] };
  const target = last ? "loc_dyn_1" : LOC_2_ID;
  const delta = last ? { beatSummary: "接应人得知封印完好，指向下一站。", newLocation: { name: "新驿站", description: "河边驿站。", scale: "scene", placement: "world", connectFromLocationId: LOC_1_ID },
    newNpc: { name: "船夫", role: "引路者", description: "等在岸边。", locationRef: { kind: "new_location" }, anchors: { selfConcept: "船夫", values: ["守约"], speechStyle: "简洁", capabilityBoundaries: ["只知渡口"], taboos: [] }, goals: [{ horizon: "short", description: "引路", priority: 3, reason: "守约" }], relationshipSeeds: [] },
    newItem: null, newEnemy: null, newFact: null, nextMainQuest: { name: "前往渡口", description: "询问渡口。", objectiveText: "拜访船夫" }, endingPair: null } : null;
  const arrival = { segments: [{ beatId: "atmosphere", text: "你抵达下一站。" }], npcLine: { npcId: last ? "npc_dyn_1" : "npc_3", text: "你来了。", emotion: "neutral", answeredBeatIds: [], usedFactIds: [], usedEventIds: [] },
    objectiveLink: null, choices: [1, 2].map(i => ({ candidateId: `move:${target}_choice_${i}`, label: `询问${i}` })) };
  return { worldState, storyState, draft: { worldDelta: delta,
    consequenceBindings: bindInCandidate ? [{ kind: "bind_goal_resolution", npcRef: NPC_2_ID, goalOrdinal: 0, resolution }] : [],
    sceneDrafts: [{ slotKey: "current", scene }, { slotKey: `move:${target}`, scene: arrival }] }, q };
}

describe("B current disclosure through production source and SQLite CAS", () => {
  it.each([
    { last: false, failure: "missing_slot" }, { last: true, failure: "missing_slot" },
    { last: true, failure: "missing_delta" }, { last: false, failure: "absent_audience" },
    { last: false, failure: "unknown_fact" }, { last: false, failure: "future_only" },
    { last: false, failure: "same_candidate_binding" }, { last: true, failure: "same_candidate_binding" },
    { last: false, failure: "restricted_rebroadcast" },
  ])("commits the compiled candidate after $failure rejection (last=$last)", async ({ last, failure }) => {
    const root = mkdtempSync(join(tmpdir(), "rpg-disclosure-"));
    const repository = createSqliteGameRepository({ clientFactory: () => createSqliteClient(join(root, "game.sqlite")), logError: () => undefined });
    try {
      await repository.initializeSchema();
      const { worldState, storyState, draft, q } = fixture(last, failure === "same_candidate_binding", failure === "restricted_rebroadcast");
      expect(await repository.createInitialGame({ gameId: asGameId("disclosure"), worldState, storyState, createdAt: now() })).toEqual({ ok: true });
      let valid = false;
      let calls = 0;
      const invalidDraft = structuredClone(draft);
      if (failure === "missing_slot" || failure === "same_candidate_binding") invalidDraft.sceneDrafts = invalidDraft.sceneDrafts.slice(0, 1);
      if (failure === "missing_delta") invalidDraft.worldDelta = null;
      const current = invalidDraft.sceneDrafts[0]!.scene;
      if ("expressions" in current && current.expressions !== undefined) {
        const line = current.expressions[1]!;
        if (failure === "absent_audience") line.audienceIds = [asNpcId("npc_3")];
        if (failure === "unknown_fact") line.usedFactIds = ["fact:unknown" as typeof FACT_1_ID];
        if (failure === "restricted_rebroadcast" && line.npcId !== undefined) current.expressions.push({ ...line, npcId: NPC_2_ID, audienceIds: [PLAYER_ENTITY_ID] });
        if (failure === "future_only") {
          invalidDraft.sceneDrafts[1]!.scene = { ...invalidDraft.sceneDrafts[1]!.scene, expressions: current.expressions };
          current.expressions = current.expressions.slice(0, 1);
        }
      }
      const prompts: string[] = [];
      let reviews = 0;
      const source = createNarrativeBundleSource({ aiClient: { policy: () => ({ thinking: "off", timeoutMs: 45000, maxTokens: 5000, jsonMode: "prompt_only", maxAttempts: 1 }), complete: async (_role, messages) => { calls++;
        prompts.push(messages[0]!.content);
        return { ok: true, latencyMs: 0, content: JSON.stringify(valid ? draft : invalidDraft) }; } } });
      const failures: unknown[] = [];
      const run = () => generatePendingNarrativeBundle({ repository, source: { generate: async context => { if (context.contentRepair) failures.push(context.contentRepair); const result = await source.generate(context); if (!result.ok) failures.push(result.repairDetail); return result; } }, now,
        reviewer: { reviewNarrativeCandidate: async input => {
          reviews++;
          if (input.context.kind !== "decision") throw new Error("unexpected review");
          expect(input.context.storyState.currentAct).toBe(last ? 2 : 1);
          expect(input.context.job.objectiveTransition.after?.objectiveIndex).toBe(last ? 0 : 1);
          const listener = input.context.worldState.entityStore.records.find(record => record.core.id === NPC_2_ID) as NpcEntityRecord;
          expect(listener.dynamicState.goals[0]?.status).toBe("completed");
          expect(listener.knowledge.entries.some(entry => entry.factId === FACT_1_ID)).toBe(true);
          return { ok: true, candidateVersion: input.candidateVersion, candidateHash: input.candidateHash };
        } },
      });
      expect(await run()).toMatchObject({ ok: false, code: "AI_RESPONSE_INVALID" });
      const failed = await repository.getCurrentGame();
      if (!failed.ok || failed.status !== "active") throw new Error("missing failed game");
      expect(failed.record.worldState.eventLedger).toEqual(worldState.eventLedger);
      expect(failed.record.worldState.quests[0]?.status).toBe("active");
      expect(reviews).toBe(0);
      if (last && failure === "missing_slot") expect(prompts[1]).toContain("第 2 幕");
      expect(await retryNarrativeGeneration(repository, asGameId("disclosure"), now), JSON.stringify(failed.record.storyState.narrative)).toMatchObject({ ok: true });
      valid = true;
      const result = last && failure === "missing_slot"
        ? (await Promise.all([run(), run()])).find(result => result.ok)
        : await run();
      expect(result, JSON.stringify(failures)).toMatchObject({ ok: true });
      const loaded = await repository.getCurrentGame();
      if (!loaded.ok || loaded.status !== "active") throw new Error("missing ready game");
      const record = loaded.record;
      expect(record.storyState.narrative.status).toBe("ready");
      expect(record.worldState.eventLedger.filter(e => e.kind === "npc_knowledge_changed")).toHaveLength(1);
      expect(record.worldState.eventLedger.filter(e => e.kind === "npc_goal_status_changed")).toHaveLength(1);
      expect(record.worldState.eventLedger.filter(e => e.kind === "npc_interaction_recorded")).toHaveLength(1);
      expect(record.worldState.eventLedger.filter(e => ["item_obtained", "item_given", "npc_relationship_changed"].includes(e.kind))).toEqual([]);
      expect(record.worldState.inventory).toEqual(worldState.inventory);
      expect(record.worldState.quests.find(entry => entry.id === q.id)?.status).toBe(last ? "completed" : "active");
      expect(record.storyState.currentAct).toBe(last ? 2 : 1);
      expect(record.storyState.reveal?.visibleObjectiveIndex).toBe(last ? 0 : 1);
      expect(record.worldState.ending).toBeNull();
      expect(reviews).toBe(1);
      const completedCalls = calls;
      await run();
      expect(calls).toBe(completedCalls);
      expect(await repository.getCurrentGame()).toEqual(loaded);
    } finally { await repository.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
