import { describe, expect, it } from "vitest";
import { createWorldStateFixture, emptyProjection } from "@/game/domain/testing/worldStateFixture.testutil";
import type { EntityRecord, EntityStore } from "@/game/domain/entity";
import { asGenerationId, asItemId, asLocationId, asNpcId } from "@/game/domain/worldEntity";
import { parseProposedEntityCommands, approveProposedEntityCommands, entityMutationsForApprovedCommands } from "./proposedEntityCommand";
import { applyEntityMutations } from "./entityMutation";

const npcId = asNpcId("npc");
const itemId = asItemId("item");
const locA = asLocationId("a");
const locB = asLocationId("b");
const store = createWorldStateFixture({
  generation: { generationId: asGenerationId("g"), seed: "s", templateVersion: "v", inputDigest: "", gameType: "wuxia" },
  projection: {
    ...emptyProjection({ player: { name: "p", identity: "i", stats: { hp: 1, attack: 1, defense: 1 } }, locations: [
      { id: locA, name: "a", description: "", kind: "main", connectedLocationIds: [locB], npcIds: [npcId], availableItemIds: [itemId], tags: [] },
      { id: locB, name: "b", description: "", kind: "main", connectedLocationIds: [locA], npcIds: [], availableItemIds: [], tags: [] },
    ], currentLocationId: locA }),
    npcs: [{ id: npcId, name: "n", role: "r", description: "", locationId: locA, isCompanion: false, tags: [], met: false, memory: { npcId, knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] } }],
    items: [{ id: itemId, name: "i", description: "", kind: "k", tags: [] }],
  },
});
const context = { allowedEntityIds: [npcId, itemId], allowedLocationIds: [locB], immovableEntityIds: [], provenance: { jobId: "job", basedOnRevision: 1 } };

describe("ProposedEntityCommand", () => {
  it("parses only closed command shapes and rejects patch-shaped input", () => {
    expect(parseProposedEntityCommands([{ kind: "move_npc", npcId: "npc", toLocationId: "b" }])).toMatchObject({ ok: true });
    expect(parseProposedEntityCommands([{ op: "replace", path: "/entity", value: 1 }])).toEqual({ ok: false, code: "unknown_kind", index: 0 });
    expect(parseProposedEntityCommands([{ kind: "move_npc", npcId: "npc", toLocationId: "b", component: "position" }])).toEqual({ ok: false, code: "unknown_key", index: 0 });
  });

  it("approves only authorized active subjects and targets, then maps absolutely to mutations", () => {
    const parsed = parseProposedEntityCommands([{ kind: "move_npc", npcId: "npc", toLocationId: "b" }, { kind: "place_item", itemId: "item", owner: { kind: "npc", npcId: "npc" } }]);
    if (!parsed.ok) throw new Error("fixture parse failed");
    const approved = approveProposedEntityCommands(store.entityStore, parsed.proposals, context);
    expect(approved).toMatchObject({ ok: true });
    if (approved.ok) expect(entityMutationsForApprovedCommands(approved.commands)).toEqual([
      { kind: "move_npc", npcId, toLocationId: locB },
      { kind: "transfer_item", itemId, owner: { kind: "npc", npcId } },
    ]);
  });

  it("rejects one unauthorized command as a whole batch", () => {
    const parsed = parseProposedEntityCommands([{ kind: "move_npc", npcId: "npc", toLocationId: "b" }, { kind: "place_item", itemId: "item", owner: { kind: "location", locationId: "a" } }]);
    if (!parsed.ok) throw new Error("fixture parse failed");
    expect(approveProposedEntityCommands(store.entityStore, parsed.proposals, context)).toEqual({ ok: false, code: "location_not_allowed", index: 1, entityId: "a" });
  });

  it("rejects an immovable battle actor and malformed owner without exposing a partial command", () => {
    const parsed = parseProposedEntityCommands([{ kind: "move_npc", npcId: "npc", toLocationId: "b" }]);
    if (!parsed.ok) throw new Error("fixture parse failed");
    expect(approveProposedEntityCommands(store.entityStore, parsed.proposals, { ...context, immovableEntityIds: [npcId] }))
      .toEqual({ ok: false, code: "entity_immovable", index: 0, entityId: npcId });
    expect(parseProposedEntityCommands([{ kind: "place_item", itemId: "item", owner: { kind: "npc", npcId: "npc", extra: true } }]))
      .toEqual({ ok: false, code: "unknown_key", index: 0 });
  });

  it("rejects unknown IDs, wrong kinds and every missing allowlist grant", () => {
    const proposals = [
      [{ kind: "move_npc", npcId: "missing", toLocationId: "b" }],
      [{ kind: "move_npc", npcId: "item", toLocationId: "b" }],
      [{ kind: "move_npc", npcId: "npc", toLocationId: "b" }],
      [{ kind: "place_item", itemId: "item", owner: { kind: "npc", npcId: "npc" } }],
    ] as const;
    const expected = ["unknown_entity", "wrong_entity_kind", "entity_not_allowed", "entity_not_allowed"];
    proposals.forEach((raw, index) => {
      const parsed = parseProposedEntityCommands(raw);
      if (!parsed.ok) throw new Error("fixture parse failed");
      const approvalContext = index === 2
        ? { ...context, allowedEntityIds: [itemId] }
        : index === 3
          ? { ...context, allowedEntityIds: [itemId] }
          : context;
      expect(approveProposedEntityCommands(store.entityStore, parsed.proposals, approvalContext)).toMatchObject({
        ok: false, code: expected[index], index: 0,
      });
    });
  });

  it("rejects inactive location/item and resolved NPC lifecycle transitions", () => {
    const inactiveLocationStore: EntityStore = {
      ...store.entityStore,
      records: store.entityStore.records.map((record): EntityRecord => {
        if (record.core.id !== locB) return record;
        const location = record as Extract<EntityRecord, { core: { kind: "location" } }>;
        return { ...location, core: { ...location.core, lifecycle: "inactive" } };
      }),
    };
    const move = parseProposedEntityCommands([{ kind: "move_npc", npcId: "npc", toLocationId: "b" }]);
    if (!move.ok) throw new Error("fixture parse failed");
    expect(approveProposedEntityCommands(inactiveLocationStore, move.proposals, context)).toMatchObject({
      ok: false, code: "invalid_entity_lifecycle", index: 0,
    });

    const resolvedNpcStore: EntityStore = {
      ...store.entityStore,
      records: store.entityStore.records.map((record): EntityRecord => {
        if (record.core.id !== npcId) return record;
        const npc = record as Extract<EntityRecord, { core: { kind: "npc" } }>;
        return { ...npc, core: { ...npc.core, lifecycle: "resolved" } };
      }),
    };
    const lifecycle = parseProposedEntityCommands([{ kind: "set_npc_lifecycle", npcId: "npc", lifecycle: "active" }]);
    if (!lifecycle.ok) throw new Error("fixture parse failed");
    expect(approveProposedEntityCommands(resolvedNpcStore, lifecycle.proposals, context)).toMatchObject({
      ok: false, code: "invalid_lifecycle_transition", index: 0,
    });
  });

  it("maps to absolute idempotent mutations", () => {
    const parsed = parseProposedEntityCommands([
      { kind: "move_npc", npcId: "npc", toLocationId: "b" },
      { kind: "place_item", itemId: "item", owner: { kind: "npc", npcId: "npc" } },
    ]);
    if (!parsed.ok) throw new Error("fixture parse failed");
    const approved = approveProposedEntityCommands(store.entityStore, parsed.proposals, context);
    if (!approved.ok) throw new Error("fixture approval failed");
    const mutations = entityMutationsForApprovedCommands(approved.commands);
    const once = applyEntityMutations(store, mutations);
    if (!once.ok) throw new Error("first mutation failed");
    const twice = applyEntityMutations(once.worldState, mutations);
    if (!twice.ok) throw new Error("second mutation failed");
    expect(twice.worldState.entityStore).toEqual(once.worldState.entityStore);
  });
});
