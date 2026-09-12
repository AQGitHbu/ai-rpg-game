import { beforeEach, describe, expect, it } from "vitest";
import type { CommittedNarrativeEvent } from "@/game/domain/events";
import { makeCommittedEvent, resetTestEventSequence } from "@/game/domain/testing/committedEventFactory";
import { createWorldStateFixtureWith, emptyProjection, updateWorldStateFixture } from "@/game/domain/testing/worldStateFixture.testutil";
import { WORLD_STATE_SCHEMA_VERSION } from "@/game/domain/worldState";
import { asEnemyId, asGenerationId, asItemId, asLocationId, asNpcId } from "@/game/domain/worldEntity";
import { projectEntityStore, type NpcEntityRecord } from "@/game/domain/entity";
import { validatePersistableWorldState } from "./worldStatePersistenceValidation";
import { compileOpeningGenerationCandidate } from "@/game/gameplay/rpg/openingGeneration";
import { makeOpeningQualityCandidate } from "@/game/domain/openingSituation.testutil";
import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { createMainStoryThread } from "@/game/domain/storyThreads";

const state = () => createWorldStateFixtureWith({
  generation: { generationId: asGenerationId("g"), seed: "s", templateVersion: "v", inputDigest: "", gameType: "wuxia" },
  base: emptyProjection({
    player: { name: "p", identity: "i", stats: { hp: 1, attack: 1, defense: 1 } },
    locations: [{ id: asLocationId("loc"), name: "l", description: "d", kind: "main", connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [] }],
    currentLocationId: asLocationId("loc"),
  }),
});

function stateWithEnemy() {
  return updateWorldStateFixture(state(), {
    enemies: [{
      id: asEnemyId("enemy_1"), name: "灰狼", tier: "normal",
      stats: { hp: 30, attack: 8, defense: 4 }, locationId: asLocationId("loc"), tags: [],
    }],
  });
}

describe("validatePersistableWorldState", () => {
  beforeEach(() => resetTestEventSequence());
  it(`accepts v${WORLD_STATE_SCHEMA_VERSION} state and rebuilds compatibility projections from entityStore`, () => {
    const valid = state();
    expect(valid.version).toBe(WORLD_STATE_SCHEMA_VERSION);
    const result = validatePersistableWorldState(valid);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.value.locations).toEqual(valid.locations);
  });

  it("rejects an opening background event whose fact reference no longer exists", () => {
    const compiled = compileOpeningGenerationCandidate({
      candidate: makeOpeningQualityCandidate(),
      generation: { generationId: asGenerationId("opening"), seed: "s", templateVersion: "v", inputDigest: "", gameType: "science_fiction" },
      gameLength: "short",
      initialNarrative: createFixtureNarrativeRuntimeState(),
    });
    const ledger = compiled.worldState.eventLedger.map((event) => event.kind === "opening_history_established"
      ? { ...event, factIds: ["fact_missing"], payload: { ...event.payload, factIds: ["fact_missing"] } }
      : event);
    expect(validatePersistableWorldState({ ...compiled.worldState, eventLedger: ledger })).toMatchObject({
      ok: false, code: "invalid_event_ledger", issueCode: "unknown_event_entity_ref",
    });
  });

  it("rejects an opening background fact reference rewritten to an existing NPC", () => {
    const compiled = compileOpeningGenerationCandidate({
      candidate: makeOpeningQualityCandidate(),
      generation: { generationId: asGenerationId("opening-kind"), seed: "s", templateVersion: "v", inputDigest: "", gameType: "science_fiction" },
      gameLength: "short",
      initialNarrative: createFixtureNarrativeRuntimeState(),
    });
    const ledger = compiled.worldState.eventLedger.map((event) => event.kind === "opening_history_established"
      ? { ...event, factIds: ["npc_0"], payload: { ...event.payload, factIds: ["npc_0"] } }
      : event);
    expect(validatePersistableWorldState({ ...compiled.worldState, eventLedger: ledger })).toMatchObject({
      ok: false, code: "invalid_event_ledger", issueCode: "wrong_event_entity_kind",
    });
  });

  it("版本闸门与 WORLD_STATE_SCHEMA_VERSION 同源：非当前世代（高低两侧）一律 wrong_world_version", () => {
    // 闸门若重新写死字面量，版本再上台阶时旧/新世代会被静默放行或伪装成
    // invalid_entity_store/ENTITY_STATE_INVALID（老存档误分类为内容损坏）。
    const valid = state();
    expect(validatePersistableWorldState({ ...valid, version: WORLD_STATE_SCHEMA_VERSION - 1 })).toMatchObject({ ok: false, code: "wrong_world_version" });
    expect(validatePersistableWorldState({ ...valid, version: WORLD_STATE_SCHEMA_VERSION + 1 })).toMatchObject({ ok: false, code: "wrong_world_version" });
  });

  it("拒绝 ledger 重复 ID、断裂序号、future cause 与未知实体引用", () => {
    const valid = state();
    const event = makeCommittedEvent({ type: "player_intent_expressed", intentCode: "unmapped_freeform" }, { sequence: 0 });
    expect(validatePersistableWorldState({ ...valid, eventLedger: [event, { ...event, sequence: 1 }] })).toMatchObject({ ok: false });
    expect(validatePersistableWorldState({ ...valid, eventLedger: [{ ...event, sequence: 2 }] })).toMatchObject({ ok: false });
    expect(validatePersistableWorldState({ ...valid, eventLedger: [{ ...event, targetIds: ["npc_missing"], sequence: 0 }] })).toMatchObject({ ok: false });
  });

  it("拒绝 NPC provenance 指向未参与该事件的实体", () => {
    const event = makeCommittedEvent({ type: "player_intent_expressed", intentCode: "unmapped_freeform" }, { sequence: 0 });
    const withNpc = updateWorldStateFixture(state(), {
      npcs: [{
        id: asNpcId("npc_1"), name: "证人", role: "证人", description: "证人", locationId: asLocationId("loc"),
        isCompanion: false, tags: [], met: true,
        memory: {
          npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [],
          relationship: { affinity: 0 }, emotion: "neutral", goals: [],
        },
      }],
    });
    const entityStore = {
      ...withNpc.entityStore,
      records: withNpc.entityStore.records.map((record) => record.core.kind === "npc" && record.core.id === "npc_1"
        ? { ...(record as NpcEntityRecord), history: { ...(record as NpcEntityRecord).history, interactions: [{
            turnNumber: 0, actionId: "a", eventId: event.eventId, locationId: asLocationId("loc"),
            dialogueAct: "freeform" as const, topicSummary: "general", outcome: "neutral" as const, relationshipDelta: 0,
            learnedFactIds: [], summary: "交互记录",
          }] } }
        : record),
    };
    expect(validatePersistableWorldState({ ...withNpc, ...projectEntityStore(entityStore), entityStore, eventLedger: [event] })).toMatchObject({
      ok: false, code: "invalid_entity_store", issueCode: "invalid_event_provenance",
    });
  });

  it("rejects a missing store, duplicate id and compatibility projection tampering", () => {
    const valid = state();
    expect(validatePersistableWorldState({ ...valid, entityStore: undefined })).toMatchObject({ ok: false, code: "invalid_entity_store" });
    expect(validatePersistableWorldState({ ...valid, entityStore: { ...valid.entityStore, records: [...valid.entityStore.records, valid.entityStore.records[0]] } })).toMatchObject({ ok: false, code: "invalid_entity_store", issueCode: "duplicate_entity_id" });
    expect(validatePersistableWorldState({ ...valid, locations: [] })).toMatchObject({ ok: false, code: "projection_mismatch" });
  });

  it("rejects a forged player identity, non-canonical unowned item order, and incomplete active battle", () => {
    const valid = state();
    const player = valid.entityStore.records.find((record) => record.core.kind === "player_character")!;
    expect(validatePersistableWorldState({
      ...valid,
      entityStore: {
        ...valid.entityStore,
        records: valid.entityStore.records.map((record) => record === player
          ? { ...record, core: { ...record.core, id: "other_player" } }
          : record),
      },
    })).toMatchObject({ ok: false, code: "invalid_entity_store", issueCode: "invalid_player_id" });

    const unownedItem = {
      core: { id: "item_unowned", kind: "item", name: "遗失物", createdAtTurn: 0, lifecycle: "active" },
      presentation: { description: "无人持有", kind: "quest", tags: [] },
      possession: { owner: { kind: "none" }, quantity: 1, ownerOrder: 9 },
    };
    expect(validatePersistableWorldState({
      ...valid,
      entityStore: { ...valid.entityStore, records: [...valid.entityStore.records, unownedItem] },
    })).toMatchObject({ ok: false, code: "invalid_entity_store", issueCode: "invalid_component_value" });

    expect(validatePersistableWorldState({
      ...valid,
      battle: { status: "active", enemyId: "enemy_missing", playerHp: 10, enemyHp: 10, round: 1 },
    })).toMatchObject({ ok: false, code: "invalid_world_envelope" });
  });

  it("parses resolved battle optional fields and rejects malformed nested battle state", () => {
    const valid = state();
    expect(validatePersistableWorldState({
      ...valid,
      battle: { status: "resolved", enemyId: "enemy_missing", outcome: "defeat" },
    })).toMatchObject({ ok: false, code: "invalid_entity_reference", issueCode: "unknown_battle_enemy_ref" });

    expect(validatePersistableWorldState({
      ...valid,
      battle: {
        status: "active", enemyId: "enemy_missing", playerHp: 10, enemyHp: 10, round: 1,
        preBattleSnapshot: { entityStore: valid.entityStore, eventLedger: [] },
        combatants: [{ combatantId: "bad", source: null }],
      },
    })).toMatchObject({ ok: false, code: "invalid_world_envelope" });
  });

  it("保留完全 legacy active battle，但任一 modern 字段出现就要求六字段完整存在", () => {
    const valid = stateWithEnemy();
    const legacyBattle = {
      status: "active" as const,
      enemyId: asEnemyId("enemy_1"),
      playerHp: 100,
      enemyHp: 30,
      round: 1,
      preBattleSnapshot: { entityStore: valid.entityStore, eventLedger: valid.eventLedger },
    };
    expect(validatePersistableWorldState({ ...valid, battle: legacyBattle })).toMatchObject({ ok: true });

    const completeModernBattle = {
      ...legacyBattle,
      combatants: [{
        combatantId: "ally:protagonist",
        side: "allies",
        controller: "player",
        source: { kind: "protagonist" },
        name: "p",
        stats: { maxHp: 100, maxEnergy: 40, attack: 10, defense: 5, speed: 12 },
        hp: 100,
        energy: 40,
        guarding: false,
      }, {
        combatantId: "enemy:enemy_1",
        side: "enemies",
        controller: "rule",
        source: { kind: "enemy", enemyId: "enemy_1" },
        name: "灰狼",
        stats: { maxHp: 30, maxEnergy: 30, attack: 8, defense: 4, speed: 8 },
        hp: 30,
        energy: 15,
        guarding: false,
      }],
      turnOrder: ["ally:protagonist", "enemy:enemy_1"],
      turnIndex: 0,
      enemyIntents: [],
      downedEnemyIds: [],
      lastAdvance: [],
    };
    expect(validatePersistableWorldState({ ...valid, battle: completeModernBattle })).toMatchObject({ ok: true });
    expect(validatePersistableWorldState({ ...valid, battle: {
      ...completeModernBattle,
      combatants: [{
        ...completeModernBattle.combatants[0]!,
        stats: { ...completeModernBattle.combatants[0]!.stats, maxHp: 0 },
      }],
    } })).toMatchObject({ ok: false, code: "invalid_world_envelope" });
    expect(validatePersistableWorldState({ ...valid, battle: {
      ...completeModernBattle,
      turnOrder: ["missing-combatant"],
    } })).toMatchObject({ ok: false, code: "invalid_world_envelope" });
    expect(validatePersistableWorldState({ ...valid, battle: {
      ...completeModernBattle,
      enemyIntents: [{ actorId: "ally:protagonist", kind: "attack", targetId: "enemy:enemy_1" }],
    } })).toMatchObject({ ok: false, code: "invalid_world_envelope" });
    expect(validatePersistableWorldState({ ...valid, battle: {
      ...completeModernBattle,
      lastAdvance: [{
        round: 1, sequence: 0, actorId: "ally:protagonist", targetId: "enemy:enemy_1",
        kind: "attack", damage: 1, actorEnergyAfter: 41, targetHpAfter: 29,
      }],
    } })).toMatchObject({ ok: false, code: "invalid_world_envelope" });
    expect(validatePersistableWorldState({ ...valid, battle: {
      ...completeModernBattle,
      downedEnemyIds: ["enemy_1"],
    } })).toMatchObject({ ok: false, code: "invalid_world_envelope" });
    expect(validatePersistableWorldState({ ...valid, battle: {
      ...completeModernBattle,
      combatants: completeModernBattle.combatants.map((combatant) => combatant.source.kind === "enemy"
        ? { ...combatant, hp: 0 }
        : combatant),
      turnOrder: ["ally:protagonist"],
      downedEnemyIds: [],
    } })).toMatchObject({ ok: false, code: "invalid_world_envelope" });
    expect(validatePersistableWorldState({ ...valid, battle: {
      ...completeModernBattle,
      downedEnemyIds: ["enemy_1", "enemy_1"],
    } })).toMatchObject({ ok: false, code: "invalid_world_envelope" });

    const unknownCompanion = {
      combatantId: "companion:npc_missing",
      side: "allies",
      controller: "rule",
      source: { kind: "companion", npcId: "npc_missing" },
      name: "缺席同伴",
      stats: { maxHp: 80, maxEnergy: 40, attack: 16, defense: 8, speed: 10 },
      hp: 80,
      energy: 20,
      guarding: false,
    };
    expect(validatePersistableWorldState({ ...valid, battle: {
      ...completeModernBattle,
      combatants: [completeModernBattle.combatants[0], unknownCompanion, completeModernBattle.combatants[1]],
      turnOrder: ["ally:protagonist", "companion:npc_missing", "enemy:enemy_1"],
    } })).toMatchObject({
      ok: false,
      code: "invalid_entity_reference",
      issueCode: "unknown_battle_combatant_companion_ref",
    });

    const modernFields = [
      { combatants: completeModernBattle.combatants },
      { turnOrder: completeModernBattle.turnOrder },
      { turnIndex: completeModernBattle.turnIndex },
      { enemyIntents: completeModernBattle.enemyIntents },
      { downedEnemyIds: completeModernBattle.downedEnemyIds },
      { lastAdvance: completeModernBattle.lastAdvance },
    ] as const;
    for (const field of modernFields) {
      expect(validatePersistableWorldState({
        ...valid,
        battle: { ...legacyBattle, ...field },
      })).toMatchObject({ ok: false, code: "invalid_world_envelope" });
    }
  });

  it("accepts and validates the history snapshot carried by an active battle", () => {
    const valid = stateWithEnemy();
    const battle = {
      status: "active" as const,
      enemyId: asEnemyId("enemy_1"),
      playerHp: 100,
      enemyHp: 30,
      round: 1,
      preBattleSnapshot: {
        entityStore: valid.entityStore,
        eventLedger: valid.eventLedger,
        history: { entries: [] },
      },
    };
    expect(validatePersistableWorldState({ ...valid, battle })).toMatchObject({ ok: true });
    expect(validatePersistableWorldState({
      ...valid,
      battle: { ...battle, preBattleSnapshot: { ...battle.preBattleSnapshot, history: { entries: [{ bad: true }] } } },
    })).toMatchObject({ ok: false, code: "invalid_world_envelope" });
  });

  it("accepts story threads in an active battle snapshot and rejects malformed threads", () => {
    const valid = stateWithEnemy();
    const battle = {
      status: "active" as const,
      enemyId: asEnemyId("enemy_1"),
      playerHp: 100,
      enemyHp: 30,
      round: 1,
      preBattleSnapshot: {
        entityStore: valid.entityStore,
        eventLedger: valid.eventLedger,
        threads: [createMainStoryThread("thread-main")],
      },
    };
    expect(validatePersistableWorldState({ ...valid, battle })).toMatchObject({ ok: true });
    expect(validatePersistableWorldState({
      ...valid,
      battle: { ...battle, preBattleSnapshot: { ...battle.preBattleSnapshot, threads: [{ id: "bad" }] } },
    })).toMatchObject({ ok: false, code: "invalid_world_envelope" });
  });

  it("rejects a dialogue focus that points at an event outside the battle snapshot ledger", () => {
    const valid = stateWithEnemy();
    const battle = {
      status: "active" as const,
      enemyId: asEnemyId("enemy_1"),
      playerHp: 100,
      enemyHp: 30,
      round: 1,
      preBattleSnapshot: {
        entityStore: valid.entityStore,
        eventLedger: valid.eventLedger,
        dialogueFocus: {
          npcId: "npc_focus",
          entityIds: ["player_0", "npc_focus"],
          eventIds: ["turn:missing:dialogue"],
        },
      },
    };
    expect(validatePersistableWorldState({ ...valid, battle })).toMatchObject({ ok: false, code: "invalid_world_envelope" });
  });

  it("rejects unknown or malformed ending requirements without throwing", () => {
    const valid = state();
    expect(() => validatePersistableWorldState({
      ...valid,
      endings: [{ id: "ending_bad", name: "坏结局", description: "坏", requirements: [{ kind: "unknown" }] }],
    })).not.toThrow();
    expect(validatePersistableWorldState({
      ...valid,
      endings: [{ id: "ending_bad", name: "坏结局", description: "坏", requirements: [{ kind: "unknown" }] }],
    })).toMatchObject({ ok: false, code: "invalid_world_envelope" });
  });

  it("rejects unknown event variants, extra keys and malformed generation metadata", () => {
    const valid = state();
    expect(validatePersistableWorldState({
      ...valid,
      eventLedger: [{ type: "invented_event", occurredAt: "now" } as unknown as CommittedNarrativeEvent],
    })).toMatchObject({ ok: false, code: "invalid_world_envelope" });
    expect(validatePersistableWorldState({
      ...valid,
      eventLedger: [{ type: "location_visited", locationId: "loc", occurredAt: "now", payload: "extra" } as unknown as CommittedNarrativeEvent],
    })).toMatchObject({ ok: false, code: "invalid_world_envelope" });
    expect(validatePersistableWorldState({
      ...valid,
      generation: { ...valid.generation, gameType: "unknown_genre" },
    })).toMatchObject({ ok: false, code: "invalid_world_envelope" });
  });

  it("accepts server actionId evidence on dialogue/item events while retaining legacy event compatibility", () => {
    const valid = state();
    const result = validatePersistableWorldState({
      ...valid,
      eventLedger: [
        makeCommittedEvent({ type: "npc_dialogue_completed", npcId: asNpcId("npc_1") }),
        makeCommittedEvent({ type: "npc_dialogue_completed", npcId: asNpcId("npc_1") }, { actionId: "dialogue_action" }),
        makeCommittedEvent({ type: "item_given", itemId: asItemId("item_1"), npcId: asNpcId("npc_1"), locationId: asLocationId("loc") }, { actionId: "give_action" }),
      ],
    });
    expect(result).toMatchObject({ ok: true });
  });

  it("rejects malformed optional event actionId evidence", () => {
    const valid = state();
    expect(validatePersistableWorldState({
      ...valid,
      eventLedger: [{ type: "npc_dialogue_completed", npcId: "npc_1", actionId: 42, occurredAt: "now" } as unknown as CommittedNarrativeEvent],
    })).toMatchObject({ ok: false, code: "invalid_world_envelope" });
  });
});
