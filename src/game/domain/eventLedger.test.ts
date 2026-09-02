import { describe, expect, it } from "vitest";
import {
  commitEventDrafts,
  type EventCommitSource,
  type EventCommitResult,
} from "./eventLedger";
import {
  asTurnId,
  asEventId,
  asEpisodeId,
  eventIdFor,
  episodeIdForTurn,
  type CommittedNarrativeEvent,
  type NarrativeEventDraft,
  type NarrativeEventPayload,
  type GameInitializedPayload,
} from "./events";
import {
  asLocationId,
  asNpcId,
  asFactId,
  asQuestId,
  asItemId,
  asEnemyId,
  asEndingId,
  asPlayerEntityId,
  asGenerationId,
  PLAYER_ENTITY_ID,
  type GenerationMetadata,
} from "./worldEntity";
import type { EntityStore } from "./entity/entityStore";
import { compileEntityStoreFromCompatibilityProjection, type EntityCompatibilityProjection } from "./entity/entityProjection";
import { importNpcLayers } from "./entity/npcProjection";
import type { PlayerState, LocationEntry, NpcEntry, ItemEntry, EnemyEntry, QuestEntry, WorldFactEntry, FactionEntry, EndingEntry } from "./worldEntries";
import type { EndingId } from "./worldEntity";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function buildGeneration(): GenerationMetadata {
  return {
    generationId: asGenerationId("gen-0001"),
    seed: "seed-1",
    templateVersion: "tpl-1",
    inputDigest: "digest-abc",
    gameType: "wuxia",
  };
}

const PLAYER: PlayerState = { name: "测试玩家", identity: "冒险者", stats: { hp: 30, attack: 10, defense: 5 } };
const LOC_START = asLocationId("loc_start");
const NPC_1 = asNpcId("npc_1");

function locEntry(id: string, overrides: Partial<LocationEntry> = {}): LocationEntry {
  return {
    id: asLocationId(id),
    name: `地点-${id}`,
    description: "测试地点",
    kind: "main",
    connectedLocationIds: [],
    npcIds: [],
    availableItemIds: [],
    tags: [],
    ...overrides,
  };
}

function npcEntry(id: string, locationId: string, overrides: Partial<NpcEntry> = {}): NpcEntry {
  const npcId = asNpcId(id);
  return {
    id: npcId,
    name: `NPC-${id}`,
    role: "向导",
    description: "向导NPC",
    locationId: asLocationId(locationId),
    isCompanion: false,
    tags: [],
    met: true,
    memory: {
      npcId,
      knownFactIds: [],
      hiddenFactIds: [],
      interactionHistory: [],
      relationship: { affinity: 10 },
      emotion: "warm",
      goals: [],
    },
    ...overrides,
  };
}

function itemEntry(id: string, overrides: Partial<ItemEntry> = {}): ItemEntry {
  return { id: asItemId(id), name: `物品-${id}`, description: "测试物品", kind: "key", tags: [], ...overrides };
}

function enemyEntry(id: string, locationId: string, overrides: Partial<EnemyEntry> = {}): EnemyEntry {
  return {
    id: asEnemyId(id),
    name: `敌人-${id}`,
    tier: "normal",
    stats: { hp: 20, attack: 8, defense: 3 },
    locationId: asLocationId(locationId),
    tags: [],
    ...overrides,
  };
}

function questEntry(id: string, overrides: Partial<QuestEntry> = {}): QuestEntry {
  return {
    id: asQuestId(id),
    name: `任务-${id}`,
    description: "测试任务",
    objectives: [{ kind: "visit_location" as const, locationId: LOC_START }],
    onSuccess: { kind: "advance_story" as const },
    onFailure: { kind: "closed" as const },
    tags: [],
    kind: "main",
    status: "active",
    ...overrides,
  };
}

function factEntry(id: string, overrides: Partial<WorldFactEntry> = {}): WorldFactEntry {
  return { factId: asFactId(id), text: `事实-${id}`, source: "generated", discovered: false, ...overrides };
}

function endingEntry(id: string, overrides: Partial<EndingEntry> = {}): EndingEntry {
  return { id: asEndingId(id), name: `结局-${id}`, description: "测试结局", requirements: [], ...overrides };
}

function buildMinimalEntityStore(): EntityStore {
  const projection: EntityCompatibilityProjection = {
    player: PLAYER,
    locations: [locEntry("loc_start", { npcIds: [NPC_1] })],
    currentLocationId: LOC_START,
    unlockedLocationIds: [LOC_START],
    visitedLocationIds: [LOC_START],
    npcs: [npcEntry("npc_1", "loc_start")],
    items: [],
    inventory: [],
    worldFacts: [factEntry("fact_1")],
    quests: [questEntry("quest_1")],
    enemies: [enemyEntry("enemy_1", "loc_start")],
    defeatedEnemyIds: [],
    factions: [],
  };
  const npcCreationComponentsById = new Map(
    projection.npcs.map((entry) => [entry.id, importNpcLayers({ entry, createdAtTurn: 0 })] as const),
  );
  return compileEntityStoreFromCompatibilityProjection({ projection, createdAtTurn: 0, npcCreationComponentsById });
}

function buildInitSource(turnId: string): EventCommitSource {
  return {
    turnId: asTurnId(turnId),
    turnNumber: 0,
    committedAt: "2026-09-02T00:00:00Z",
  };
}

function buildTurnSource(turnId: string, turnNumber: number): EventCommitSource {
  return {
    turnId: asTurnId(turnId),
    actionId: "action_1",
    turnNumber,
    committedAt: "2026-09-02T00:01:00Z",
  };
}

// A simple game_initialized payload for testing (re-exported from events.ts)

function makeInitDraft(): NarrativeEventDraft<GameInitializedPayload> {
  return {
    eventKey: "game_initialized",
    episodeKey: "initialization",
    actorIds: [PLAYER_ENTITY_ID],
    targetIds: [],
    locationId: asLocationId("loc_start"),
    causeKeys: [],
    factIds: [],
    questIds: [],
    outcome: "neutral",
    salience: 50,
    payload: { type: "game_initialized", generation: buildGeneration() },
  };
}

function makeLocationVisitedDraft(): NarrativeEventDraft {
  return {
    eventKey: "location_visited:loc_start",
    episodeKey: "turn",
    actorIds: [PLAYER_ENTITY_ID],
    targetIds: [],
    locationId: asLocationId("loc_start"),
    causeKeys: [],
    factIds: [],
    questIds: [],
    outcome: "success" as const,
    salience: 20,
    payload: { type: "location_visited", locationId: asLocationId("loc_start") } as unknown as NarrativeEventPayload,
  };
}

// ---------------------------------------------------------------------------
// Step 1 tests: envelope shape, ID, replay, sequence, salience
// ---------------------------------------------------------------------------

describe("commitEventDrafts: envelope and ID rules", () => {
  it("same turnId + eventKey produces same eventId on replay", () => {
    const store = buildMinimalEntityStore();
    const source = buildInitSource("init:gen-0001");
    const draft = makeInitDraft();

    const r1 = commitEventDrafts({ ledger: [], drafts: [draft], source, entityStore: store });
    const r2 = commitEventDrafts({ ledger: [], drafts: [draft], source, entityStore: store });

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;

    const id1 = r1.appended[0]!.eventId;
    const id2 = r2.appended[0]!.eventId;
    expect(id1).toBe(id2);
  });

  it("different eventKey produces different eventId", () => {
    const store = buildMinimalEntityStore();
    const source = buildTurnSource("turn:1", 1);

    const d1: NarrativeEventDraft = {
      eventKey: "location_visited:loc_start",
      episodeKey: "turn",
      actorIds: [PLAYER_ENTITY_ID],
      targetIds: [],
      locationId: asLocationId("loc_start"),
      causeKeys: [],
      factIds: [],
      questIds: [],
      outcome: "success",
      salience: 20,
      payload: { type: "location_visited", locationId: asLocationId("loc_start") } as unknown as NarrativeEventPayload,
    };
    const d2: NarrativeEventDraft = {
      eventKey: "location_observed:loc_start",
      episodeKey: "turn",
      actorIds: [PLAYER_ENTITY_ID],
      targetIds: [],
      locationId: asLocationId("loc_start"),
      causeKeys: [],
      factIds: [],
      questIds: [],
      outcome: "success",
      salience: 20,
      payload: { type: "location_observed", locationId: asLocationId("loc_start") } as unknown as NarrativeEventPayload,
    };

    const r = commitEventDrafts({ ledger: [], drafts: [d1, d2], source, entityStore: store });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.appended).toHaveLength(2);
    expect(r.appended[0]!.eventId).not.toBe(r.appended[1]!.eventId);
  });

  it("sequence starts from ledger length and is consecutive", () => {
    const store = buildMinimalEntityStore();
    const source = buildInitSource("init:gen-0001");
    const draft = makeInitDraft();

    const r1 = commitEventDrafts({ ledger: [], drafts: [draft], source, entityStore: store });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.appended[0]!.sequence).toBe(0);

    const r2 = commitEventDrafts({ ledger: r1.ledger, drafts: [makeLocationVisitedDraft()], source: buildTurnSource("turn:1", 1), entityStore: store });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.appended[0]!.sequence).toBe(1);
  });

  it("rejects non-integer salience", () => {
    const store = buildMinimalEntityStore();
    const source = buildTurnSource("turn:1", 1);
    const draft: NarrativeEventDraft = {
      ...makeLocationVisitedDraft(),
      salience: 20.5 as number,
    };
    const r = commitEventDrafts({ ledger: [], drafts: [draft], source, entityStore: store });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_SALIENCE");
  });

  it("rejects salience out of 0..100 range", () => {
    const store = buildMinimalEntityStore();
    const source = buildTurnSource("turn:1", 1);
    const draft: NarrativeEventDraft = {
      ...makeLocationVisitedDraft(),
      salience: 101,
    };
    const r = commitEventDrafts({ ledger: [], drafts: [draft], source, entityStore: store });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_SALIENCE");
  });

  it("rejects empty actorIds element", () => {
    const store = buildMinimalEntityStore();
    const source = buildTurnSource("turn:1", 1);
    const draft: NarrativeEventDraft = {
      ...makeLocationVisitedDraft(),
      actorIds: ["" as any],
    };
    const r = commitEventDrafts({ ledger: [], drafts: [draft], source, entityStore: store });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_REFS");
  });

  it("rejects payload with type mismatch", () => {
    const store = buildMinimalEntityStore();
    const source = buildTurnSource("turn:1", 1);
    const draft = {
      eventKey: "bad",
      episodeKey: "turn",
      actorIds: [PLAYER_ENTITY_ID],
      targetIds: [],
      locationId: asLocationId("loc_start"),
      causeKeys: [],
      factIds: [],
      questIds: [],
      outcome: "success" as const,
      salience: 20,
      payload: { type: "narrative_choice", choiceToken: "x" } as any, // not in new union
    };
    const r = commitEventDrafts({ ledger: [], drafts: [draft] as any, source, entityStore: store });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("UNKNOWN_PAYLOAD_TYPE");
  });

  it("retruning same draft to existing ledger with same source is idempotent", () => {
    const store = buildMinimalEntityStore();
    const source = buildInitSource("init:gen-0001");
    const draft = makeInitDraft();

    const r1 = commitEventDrafts({ ledger: [], drafts: [draft], source, entityStore: store });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    // Same commit on same ledger → idempotent
    const r2 = commitEventDrafts({ ledger: r1.ledger, drafts: [draft], source, entityStore: store });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.appended).toHaveLength(0);
  });

  it("same eventId but different payload returns EVENT_ID_CONFLICT", () => {
    const store = buildMinimalEntityStore();
    const source = buildInitSource("init:gen-0001");
    const draft = makeInitDraft();

    const r1 = commitEventDrafts({ ledger: [], drafts: [draft], source, entityStore: store });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    // Different payload, same eventKey → same ID → conflict
    const conflictDraft: NarrativeEventDraft = {
      ...draft,
      salience: 99,
    };
    const r2 = commitEventDrafts({ ledger: r1.ledger, drafts: [conflictDraft], source, entityStore: store });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.code).toBe("EVENT_ID_CONFLICT");
  });
});

// ---------------------------------------------------------------------------
// Step 2 tests: causal graph and reference closure
// ---------------------------------------------------------------------------

describe("commitEventDrafts: causal and reference validation", () => {
  it("cause can reference earlier event in same batch via same_batch", () => {
    const store = buildMinimalEntityStore();
    const source = buildTurnSource("turn:1", 1);

    const d1 = makeLocationVisitedDraft();
    const d2: NarrativeEventDraft = {
      eventKey: "location_observed:loc_start",
      episodeKey: "turn",
      actorIds: [PLAYER_ENTITY_ID],
      targetIds: [],
      locationId: asLocationId("loc_start"),
      causeKeys: [{ kind: "same_batch", eventKey: "location_visited:loc_start" }],
      factIds: [],
      questIds: [],
      outcome: "success",
      salience: 20,
      payload: { type: "location_observed", locationId: asLocationId("loc_start") } as unknown as NarrativeEventPayload,
    };

    const r = commitEventDrafts({ ledger: [], drafts: [d1, d2], source, entityStore: store });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.appended).toHaveLength(2);
    // d2's causeEventIds should reference d1's eventId
    const causeIds = r.appended[1]!.causeEventIds;
    expect(causeIds).toHaveLength(1);
    expect(causeIds[0]).toBe(r.appended[0]!.eventId);
  });

  it("cause can reference existing ledger event via event_id", () => {
    const store = buildMinimalEntityStore();
    const initSource = buildInitSource("init:gen-0001");
    const turnSource = buildTurnSource("turn:1", 1);

    const initDraft = makeInitDraft();
    const r1 = commitEventDrafts({ ledger: [], drafts: [initDraft], source: initSource, entityStore: store });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const initEventId = r1.appended[0]!.eventId;

    const d2: NarrativeEventDraft = {
      eventKey: "location_visited:loc_start",
      episodeKey: "turn",
      actorIds: [PLAYER_ENTITY_ID],
      targetIds: [],
      locationId: asLocationId("loc_start"),
      causeKeys: [{ kind: "event_id", eventId: initEventId }],
      factIds: [],
      questIds: [],
      outcome: "success",
      salience: 20,
      payload: { type: "location_visited", locationId: asLocationId("loc_start") } as unknown as NarrativeEventPayload,
    };

    const r2 = commitEventDrafts({ ledger: r1.ledger, drafts: [d2], source: turnSource, entityStore: store });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.appended[0]!.causeEventIds).toEqual([initEventId]);
  });

  it("rejects cause referencing future event (later in same batch)", () => {
    const store = buildMinimalEntityStore();
    const source = buildTurnSource("turn:1", 1);

    const d1: NarrativeEventDraft = {
      eventKey: "location_visited:loc_start",
      episodeKey: "turn",
      actorIds: [PLAYER_ENTITY_ID],
      targetIds: [],
      locationId: asLocationId("loc_start"),
      causeKeys: [{ kind: "same_batch", eventKey: "location_observed:loc_start" }],
      factIds: [],
      questIds: [],
      outcome: "success",
      salience: 20,
      payload: { type: "location_visited", locationId: asLocationId("loc_start") } as unknown as NarrativeEventPayload,
    };
    const d2: NarrativeEventDraft = {
      eventKey: "location_observed:loc_start",
      episodeKey: "turn",
      actorIds: [PLAYER_ENTITY_ID],
      targetIds: [],
      locationId: asLocationId("loc_start"),
      causeKeys: [],
      factIds: [],
      questIds: [],
      outcome: "success",
      salience: 20,
      payload: { type: "location_observed", locationId: asLocationId("loc_start") } as unknown as NarrativeEventPayload,
    };

    const r = commitEventDrafts({ ledger: [], drafts: [d1, d2], source, entityStore: store });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("CAUSE_FUTURE_EVENT");
  });

  it("rejects unknown cause event_id not in ledger", () => {
    const store = buildMinimalEntityStore();
    const source = buildTurnSource("turn:1", 1);

    const fakeEventId = asEventId("evt_nonexistent");
    const d: NarrativeEventDraft = {
      eventKey: "location_visited:loc_start",
      episodeKey: "turn",
      actorIds: [PLAYER_ENTITY_ID],
      targetIds: [],
      locationId: asLocationId("loc_start"),
      causeKeys: [{ kind: "event_id", eventId: fakeEventId }],
      factIds: [],
      questIds: [],
      outcome: "success",
      salience: 20,
      payload: { type: "location_visited", locationId: asLocationId("loc_start") } as unknown as NarrativeEventPayload,
    };

    const r = commitEventDrafts({ ledger: [], drafts: [d], source, entityStore: store });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("CAUSE_NOT_FOUND");
  });

  it("rejects duplicate eventKey in same batch", () => {
    const store = buildMinimalEntityStore();
    const source = buildTurnSource("turn:1", 1);

    const d1 = makeLocationVisitedDraft();
    const d2 = makeLocationVisitedDraft();

    const r = commitEventDrafts({ ledger: [], drafts: [d1, d2], source, entityStore: store });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("DUPLICATE_EVENT_KEY");
  });

  it("rejects entity reference not in EntityStore", () => {
    const store = buildMinimalEntityStore();
    const source = buildTurnSource("turn:1", 1);

    const d: NarrativeEventDraft = {
      eventKey: "location_visited:loc_other",
      episodeKey: "turn",
      actorIds: [PLAYER_ENTITY_ID],
      targetIds: [],
      locationId: asLocationId("loc_nonexistent"),
      causeKeys: [],
      factIds: [],
      questIds: [],
      outcome: "success",
      salience: 20,
      payload: { type: "location_visited", locationId: asLocationId("loc_nonexistent") } as unknown as NarrativeEventPayload,
    };

    const r = commitEventDrafts({ ledger: [], drafts: [d], source, entityStore: store });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_ENTITY_REF");
  });

  it("rejects factId reference not in EntityStore", () => {
    const store = buildMinimalEntityStore();
    const source = buildTurnSource("turn:1", 1);

    const d: NarrativeEventDraft = {
      eventKey: "fact_discovered:fact_missing",
      episodeKey: "turn",
      actorIds: [PLAYER_ENTITY_ID],
      targetIds: [],
      locationId: asLocationId("loc_start"),
      causeKeys: [],
      factIds: [asFactId("fact_missing")],
      questIds: [],
      outcome: "success",
      salience: 65,
      payload: { type: "fact_discovered", factId: asFactId("fact_missing") } as unknown as NarrativeEventPayload,
    };

    const r = commitEventDrafts({ ledger: [], drafts: [d], source, entityStore: store });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_ENTITY_REF");
  });

  it("rejects questId reference not in EntityStore", () => {
    const store = buildMinimalEntityStore();
    const source = buildTurnSource("turn:1", 1);

    const d: NarrativeEventDraft = {
      eventKey: "quest_completed:quest_missing",
      episodeKey: "turn",
      actorIds: [PLAYER_ENTITY_ID],
      targetIds: [],
      locationId: asLocationId("loc_start"),
      causeKeys: [],
      factIds: [],
      questIds: [asQuestId("quest_missing")],
      outcome: "success",
      salience: 80,
      payload: { type: "quest_completed", questId: asQuestId("quest_missing") } as unknown as NarrativeEventPayload,
    };

    const r = commitEventDrafts({ ledger: [], drafts: [d], source, entityStore: store });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_ENTITY_REF");
  });

  it("rejects duplicate eventId already in ledger with different payload (conflict)", () => {
    const store = buildMinimalEntityStore();
    const source = buildInitSource("init:gen-0001");

    const draft = makeInitDraft();
    const r1 = commitEventDrafts({ ledger: [], drafts: [draft], source, entityStore: store });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    // Construct a draft with same eventKey but different payload content
    const conflictGen: GenerationMetadata = {
      ...buildGeneration(),
      seed: "different-seed",
    };
    const conflictDraft: NarrativeEventDraft = {
      ...draft,
      payload: { type: "game_initialized", generation: conflictGen } as unknown as NarrativeEventPayload,
    };

    const r2 = commitEventDrafts({ ledger: r1.ledger, drafts: [conflictDraft], source, entityStore: store });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.code).toBe("EVENT_ID_CONFLICT");
  });
});
