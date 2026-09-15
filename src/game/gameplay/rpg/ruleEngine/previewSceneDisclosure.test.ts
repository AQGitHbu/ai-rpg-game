import { describe, expect, it } from "vitest";
import { baseWorld, makeNpc, NPC_1_ID, NPC_2_ID, FACT_1_ID, LOC_2_ID } from "@/game/gameplay/rpg/narrativeContext/narrativeContext.testutil";
import { createInitialStoryState } from "@/game/domain/storyState";
import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { asTurnId } from "@/game/domain/events";
import { PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import { entitiesOfKind, type NpcEntityRecord } from "@/game/domain/entity";
import { previewSceneDisclosure } from "./previewSceneDisclosure";

function input() {
  return { worldState: baseWorld({ npcs: [makeNpc(NPC_1_ID, "证人", "证人", true), makeNpc(NPC_2_ID, "接应人", "接应人", true)] }),
    storyState: createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short", initialEntityCounts: { locations: 2, npcs: 2, quests: 0, events: 1 } }),
    source: { actionId: "action:ask", turnId: asTurnId("turn:ask"), turnNumber: 1 },
    expressions: [{ kind: "npc_line" as const, npcId: NPC_1_ID, audienceIds: [NPC_2_ID, NPC_1_ID, PLAYER_ENTITY_ID],
      text: "合法披露", emotion: "neutral" as const, answeredBeatIds: [], usedFactIds: [FACT_1_ID], usedEventIds: [] }] };
}

describe("previewSceneDisclosure", () => {
  it("records only the actual NPC listener and preserves line provenance without duplicate writes", () => {
    const original = input();
    const result = previewSceneDisclosure({ ...original, expressions: [...original.expressions, ...original.expressions] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]).toMatchObject({ eventKey: "scene_disclosure:0:npc_2:fact_1", actorIds: [NPC_1_ID], targetIds: [NPC_2_ID] });
    expect(result.worldState.eventLedger).toEqual(original.worldState.eventLedger);
    const listener = entitiesOfKind(result.worldState.entityStore, "npc").find(npc => npc.core.id === NPC_2_ID)!;
    expect(listener.knowledge.entries[0]?.source).toMatchObject({ mode: "npc_revealed", sourceNpcId: NPC_1_ID, eventId: "turn:ask:scene_disclosure:0:npc_2:fact_1" });
    const replay = previewSceneDisclosure({ ...original, worldState: result.worldState });
    if (replay.ok) expect(replay.drafts).toEqual([]);
    expect(entitiesOfKind(original.worldState.entityStore, "npc")[1]!.knowledge.entries).toEqual([]);
  });
  it.each(["remote", "inactive"])("rejects a %s listener before producing effects", mode => {
    const original = input();
    const entityStore = { ...original.worldState.entityStore, records: original.worldState.entityStore.records.map(record => record.core.id !== NPC_2_ID ? record : {
      ...record, ...(mode === "inactive" ? { core: { ...record.core, lifecycle: "inactive" as const } } : { position: { locationId: LOC_2_ID } }),
    } as NpcEntityRecord) };
    expect(previewSceneDisclosure({ ...original, worldState: { ...original.worldState, entityStore } })).toEqual({ ok: false, code: "invalid_audience" });
  });
  it.each(["secret", "conditional"] as const)("does not grant rebroadcast permission for %s source knowledge", disclosure => {
    const original = input();
    const speaker = makeNpc(NPC_1_ID, "证人", "证人", true);
    const world = baseWorld({ npcs: [{ ...speaker, memory: { ...speaker.memory, hiddenFactIds: [FACT_1_ID] } }, makeNpc(NPC_2_ID, "接应人", "接应人", true)] });
    const entityStore = { ...world.entityStore, records: world.entityStore.records.map(record => record.core.id !== NPC_1_ID ? record : {
      ...record, knowledge: { entries: (record as NpcEntityRecord).knowledge.entries.map(entry => ({ ...entry, disclosure })) },
    } as NpcEntityRecord) };
    const result = previewSceneDisclosure({ ...original, worldState: { ...world, entityStore } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(entitiesOfKind(result.worldState.entityStore, "npc").find(npc => npc.core.id === NPC_2_ID)!.knowledge.entries[0]?.disclosure).toBe(disclosure);
  });
});
