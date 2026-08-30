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
});
