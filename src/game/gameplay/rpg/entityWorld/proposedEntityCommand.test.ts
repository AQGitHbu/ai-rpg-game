import { describe, expect, it } from "vitest";
import { emptyProjection } from "@/game/domain/testing/worldStateFixture.testutil";
import { createWorldStateFromProjection } from "@/game/domain/worldState";
import { asGenerationId, asItemId, asLocationId, asNpcId } from "@/game/domain/worldEntity";
import { parseProposedEntityCommands, approveProposedEntityCommands, entityMutationsForApprovedCommands } from "./proposedEntityCommand";

const npcId = asNpcId("npc");
const itemId = asItemId("item");
const locA = asLocationId("a");
const locB = asLocationId("b");
const store = createWorldStateFromProjection({
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
      .toEqual({ ok: false, code: "invalid_field", index: 0 });
  });
});
