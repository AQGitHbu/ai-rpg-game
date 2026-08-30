import { describe, expect, it } from "vitest";
import { createWorldStateFixtureWith, emptyProjection } from "@/game/domain/testing/worldStateFixture.testutil";
import { asGenerationId, asLocationId } from "@/game/domain/worldEntity";
import { validatePersistableWorldState } from "./worldStatePersistenceValidation";

const state = () => createWorldStateFixtureWith({
  generation: { generationId: asGenerationId("g"), seed: "s", templateVersion: "v", inputDigest: "", gameType: "wuxia" },
  base: emptyProjection({
    player: { name: "p", identity: "i", stats: { hp: 1, attack: 1, defense: 1 } },
    locations: [{ id: asLocationId("loc"), name: "l", description: "d", kind: "main", connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [] }],
    currentLocationId: asLocationId("loc"),
  }),
});

describe("validatePersistableWorldState", () => {
  it("accepts v3 state and rebuilds compatibility projections from entityStore", () => {
    const valid = state();
    const result = validatePersistableWorldState(valid);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.value.locations).toEqual(valid.locations);
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
});
