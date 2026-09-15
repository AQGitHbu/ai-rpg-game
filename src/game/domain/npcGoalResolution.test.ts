import { describe, expect, it } from "vitest";
import { asEventId, asTurnId, type CommittedNarrativeEvent } from "@/game/domain/events";
import { asFactId, asGenerationId, asItemId, asLocationId, asNpcId, PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import { createWorldStateFixture, emptyProjection } from "@/game/domain/testing/worldStateFixture.testutil";
import { createEntityStore, getEntity, projectEntityStore, type EntityRecord, type NpcEntityRecord } from "@/game/domain/entity";
import type { NpcGoalResolution } from "@/game/domain/entity/npcComponents";
import { reconcileNpcGoals } from "@/game/gameplay/rpg/npcGoals/reconcileNpcGoals";
import { applyEntityMutations } from "@/game/gameplay/rpg/entityWorld";

const LOCATION = asLocationId("loc_scene");
const KEEPER = asNpcId("npc_keeper");
const OTHER = asNpcId("npc_other");
const FACT = asFactId("fact_ledger");
const ITEM = asItemId("item_ledger");

function statusOf(record: EntityRecord | undefined): string | undefined {
  if (record?.core.kind !== "npc") return undefined;
  return (record as NpcEntityRecord).dynamicState.goals[0]?.status;
}

const resolution: NpcGoalResolution = {
  completeWhen: [{ kind: "investigation_observed", npcId: KEEPER, factId: FACT, evidenceQuality: "clean" }],
  blockWhen: [{ kind: "investigation_observed", npcId: KEEPER, factId: FACT, evidenceQuality: "noisy" }],
};

function event(payload: CommittedNarrativeEvent["payload"], eventId: string): CommittedNarrativeEvent {
  return {
    eventId: asEventId(eventId), sequence: 1, turnId: asTurnId("turn:1"), actionId: "action:1", turnNumber: 1,
    episodeId: "episode:turn:1" as never, kind: payload.type, actorIds: [PLAYER_ENTITY_ID], targetIds: [KEEPER],
    locationId: LOCATION, causeEventIds: [], factIds: payload.type === "fact_discovered" ? [payload.factId] : [],
    questIds: [], outcome: "success", salience: 50, committedAt: "2026-09-15T00:00:00.000Z", payload,
  };
}

function world(goalResolution: NpcGoalResolution = resolution) {
  const base = createWorldStateFixture({
    generation: { generationId: asGenerationId("gen:goal"), seed: "seed", templateVersion: "v1", inputDigest: "", gameType: "wuxia" },
    projection: {
      ...emptyProjection({
        player: { name: "玩家", identity: "旅人", stats: { hp: 10, attack: 2, defense: 1 } },
        locations: [{ id: LOCATION, name: "现场", description: "", kind: "main", scale: "scene", connectedLocationIds: [], npcIds: [KEEPER, OTHER], availableItemIds: [ITEM], tags: [] }],
        currentLocationId: LOCATION,
      }),
      items: [{ id: ITEM, name: "账册", description: "", kind: "quest", tags: [] }],
      npcs: [KEEPER, OTHER].map((id) => ({
        id, name: String(id), role: "见证人", description: "", locationId: LOCATION, isCompanion: false, tags: [], met: true,
        memory: { npcId: id, knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral" as const,
          goals: ["守住记录"] },
      })),
      worldFacts: [{ factId: FACT, text: "账册记录", source: "generated", discovered: false, discoveryMode: "investigation", locationId: LOCATION,
        investigationLabel: "查验账册", investigationApproaches: [
          { approachId: "clean", label: "逐页查验", evidenceQuality: "clean", tensionDelta: 0 },
          { approachId: "noisy", label: "仓促翻阅", evidenceQuality: "noisy", tensionDelta: 1 },
        ] }],
    },
  });
  const keeper = getEntity(base.entityStore, KEEPER);
  if (keeper?.core.kind !== "npc") throw new Error("missing keeper");
  const keeperNpc = keeper as NpcEntityRecord;
  const store = createEntityStore(base.entityStore.records.map((record: EntityRecord) => record.core.id === KEEPER
    ? { ...keeperNpc, dynamicState: { ...keeperNpc.dynamicState, goals: [{ ...keeperNpc.dynamicState.goals[0]!, resolution: goalResolution }] } }
    : record));
  return { ...base, entityStore: store, ...projectEntityStore(store) };
}

describe("npcGoalResolution", () => {
  it("resolves possession conditions from delivery rather than investigation history", () => {
    const current = world({ completeWhen: [{ kind: "has_item", itemId: ITEM, ownerId: KEEPER }], blockWhen: resolution.blockWhen });
    const given = event({ type: "item_given", itemId: ITEM, npcId: KEEPER, locationId: LOCATION }, "turn:1:given");
    const applied = applyEntityMutations(current, [{ kind: "transfer_item", itemId: ITEM, owner: { kind: "npc", npcId: KEEPER } }]);
    if (!applied.ok) throw new Error(applied.code);
    const result = reconcileNpcGoals({ worldState: applied.worldState, triggerEvents: [given], actionId: "action:1", turnId: asTurnId("turn:1"), turnNumber: 1 });
    expect(statusOf(getEntity(result.worldState.entityStore, KEEPER))).toBe("completed");
    expect(result.drafts[0]?.payload).toMatchObject({ evidenceEventIds: [given.eventId] });
  });
  it("resolves an owned promise from its actual fulfillment evidence", () => {
    const current = world();
    const keeper = getEntity(current.entityStore, KEEPER) as NpcEntityRecord;
    const store = createEntityStore(current.entityStore.records.map((record) => record.core.id === KEEPER ? {
      ...keeper, dynamicState: { ...keeper.dynamicState, goals: keeper.dynamicState.goals.map(({ resolution: _resolution, ...goal }) => goal) },
    } : record));
    const opened = applyEntityMutations({ ...current, entityStore: store, ...projectEntityStore(store) }, [{ kind: "apply_relationship_commitment", fromNpcId: KEEPER, targetId: PLAYER_ENTITY_ID,
      operation: { kind: "open_promise", openKey: "pledge", promisor: "target", description: "relationship.promise.confidentiality" },
      source: { kind: "action", actionId: "action:pledge", turnNumber: 1 }, supportingEventId: asEventId("turn:pledge:promise") }]);
    if (!opened.ok) throw new Error(opened.code);
    const npc = getEntity(opened.worldState.entityStore, KEEPER) as NpcEntityRecord;
    const promiseId = npc.relationships.outgoing[0]!.commitments[0]!.commitmentId;
    const fulfilled = event({ type: "npc_relationship_changed", fromNpcId: KEEPER, targetId: PLAYER_ENTITY_ID, signal: "kept_promise" }, "turn:1:fulfilled");
    const applied = applyEntityMutations(opened.worldState, [
      { kind: "bind_npc_goal_resolution", npcId: KEEPER, goalId: npc.dynamicState.goals[0]!.goalId, resolution: {
        completeWhen: [{ kind: "promise_status", npcId: KEEPER, promiseId, status: "fulfilled" }],
        blockWhen: [{ kind: "promise_status", npcId: KEEPER, promiseId, status: "broken" }],
      } },
      { kind: "apply_relationship_commitment", fromNpcId: KEEPER, targetId: PLAYER_ENTITY_ID, operation: { kind: "fulfill", commitmentId: promiseId },
        source: { kind: "action", actionId: "action:1", turnNumber: 1 }, supportingEventId: fulfilled.eventId },
    ]);
    if (!applied.ok) throw new Error(applied.code);
    const result = reconcileNpcGoals({ worldState: applied.worldState, triggerEvents: [fulfilled], actionId: "action:1", turnId: asTurnId("turn:1"), turnNumber: 1 });
    expect(statusOf(getEntity(result.worldState.entityStore, KEEPER))).toBe("completed");
    expect(result.drafts[0]?.payload).toMatchObject({ evidenceEventIds: [fulfilled.eventId] });
  });
  it("uses a recipient's actual knowledge event without requiring an investigation", () => {
    const current = world({ completeWhen: [{ kind: "knows_fact", actorId: KEEPER, factId: FACT }], blockWhen: resolution.blockWhen });
    const learned = event({ type: "npc_knowledge_changed", npcId: KEEPER, factId: FACT, change: "learned" }, "turn:1:learned");
    const applied = applyEntityMutations(current, [{ kind: "record_npc_knowledge", npcId: KEEPER, factId: FACT, certainty: "known", disclosure: "public", source: { kind: "action", mode: "player_told", actionId: "action:1", turnNumber: 1, eventId: learned.eventId } }]);
    if (!applied.ok) throw new Error(applied.code);
    const result = reconcileNpcGoals({ worldState: applied.worldState, triggerEvents: [learned], actionId: "action:1", turnId: asTurnId("turn:1"), turnNumber: 1 });
    expect(statusOf(getEntity(result.worldState.entityStore, KEEPER))).toBe("completed");
    expect(result.drafts[0]?.payload).toMatchObject({ evidenceEventIds: [learned.eventId] });
    expect(result.drafts[0]?.causeKeys).toEqual([{ kind: "same_batch", eventKey: "learned" }]);
    const persisted = reconcileNpcGoals({ worldState: { ...applied.worldState, eventLedger: [learned] }, triggerEvents: [learned], actionId: "action:1", turnId: asTurnId("turn:1"), turnNumber: 1 });
    expect(persisted.drafts[0]?.causeKeys).toEqual([{ kind: "event_id", eventId: learned.eventId }]);
  });

  it("does not recycle old investigation evidence when there is no new relevant event", () => {
    const discovery = event({ type: "fact_discovered", factId: FACT, witnessNpcIds: [KEEPER], approachId: "clean", evidenceQuality: "clean" }, "turn:1:old");
    const current = { ...world(), eventLedger: [discovery] };
    const unrelated = event({ type: "npc_knowledge_changed", npcId: OTHER, factId: FACT, change: "learned" }, "turn:2:other");
    const result = reconcileNpcGoals({ worldState: current, triggerEvents: [unrelated], actionId: "action:2", turnId: asTurnId("turn:2"), turnNumber: 2 });
    expect(statusOf(getEntity(result.worldState.entityStore, KEEPER))).toBe("active");
    expect(result.drafts).toHaveLength(0);
  });
  it("completes only the NPC that actually witnessed a clean investigation", () => {
    const current = world();
    const discovery = event({ type: "fact_discovered", factId: FACT, witnessNpcIds: [KEEPER], approachId: "clean", evidenceQuality: "clean" }, "turn:1:fact_discovered");
    const result = reconcileNpcGoals({ worldState: current, triggerEvents: [discovery], actionId: "action:1", turnId: asTurnId("turn:1"), turnNumber: 1 });
    const keeper = getEntity(result.worldState.entityStore, KEEPER);
    const other = getEntity(result.worldState.entityStore, OTHER);
    expect(statusOf(keeper)).toBe("completed");
    expect(statusOf(other)).toBe("active");
    expect(result.drafts[0]?.payload).toMatchObject({ type: "npc_goal_status_changed", npcId: KEEPER, to: "completed", evidenceEventIds: [discovery.eventId] });
  });

  it("blocks on noisy evidence and does not emit a second change when the same event is consumed again", () => {
    const current = world();
    const discovery = event({ type: "fact_discovered", factId: FACT, witnessNpcIds: [KEEPER], approachId: "noisy", evidenceQuality: "noisy" }, "turn:1:fact_discovered");
    const first = reconcileNpcGoals({ worldState: current, triggerEvents: [discovery], actionId: "action:1", turnId: asTurnId("turn:1"), turnNumber: 1 });
    const second = reconcileNpcGoals({ worldState: first.worldState, triggerEvents: [discovery], actionId: "action:1", turnId: asTurnId("turn:1"), turnNumber: 1 });
    const keeper = getEntity(second.worldState.entityStore, KEEPER);
    expect(statusOf(keeper)).toBe("blocked");
    expect(second.drafts).toHaveLength(0);
  });

  it("does not let a private investigation or an unrelated audience change a goal", () => {
    const current = world();
    const privateDiscovery = event({ type: "fact_discovered", factId: FACT, approachId: "clean", evidenceQuality: "clean" }, "turn:1:fact_discovered");
    const unrelatedShare = event({ type: "story_interaction_resolved", interactionId: "share:other", npcId: OTHER, operation: "share_known_fact", factIds: [FACT], audienceIds: [OTHER], evidenceEventIds: [privateDiscovery.eventId] }, "turn:1:share");
    const result = reconcileNpcGoals({ worldState: current, triggerEvents: [privateDiscovery, unrelatedShare], actionId: "action:1", turnId: asTurnId("turn:1"), turnNumber: 1 });
    const keeper = getEntity(result.worldState.entityStore, KEEPER);
    expect(statusOf(keeper)).toBe("active");
    expect(result.drafts).toHaveLength(0);
  });

  it("allows a private investigation to affect the NPC only after that exact source is shared", () => {
    const current = world();
    const privateDiscovery = event({ type: "fact_discovered", factId: FACT, approachId: "clean", evidenceQuality: "clean" }, "turn:1:private");
    const share = event({ type: "story_interaction_resolved", interactionId: "share:keeper", npcId: KEEPER, operation: "share_known_fact", factIds: [FACT], audienceIds: [KEEPER], evidenceEventIds: [privateDiscovery.eventId] }, "turn:1:share");
    const result = reconcileNpcGoals({ worldState: current, triggerEvents: [privateDiscovery, share], actionId: "action:1", turnId: asTurnId("turn:1"), turnNumber: 1 });
    expect(statusOf(getEntity(result.worldState.entityStore, KEEPER))).toBe("completed");
    expect(result.drafts[0]?.payload).toMatchObject({ evidenceEventIds: [share.eventId] });
  });
});
