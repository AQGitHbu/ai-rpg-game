import { describe, it, expect } from "vitest";
import { createDeterministicSceneSource } from "./deterministicSceneSource";
import { createInitialWorldState, appendNpc, appendLocation, type LocationEntry, type NpcEntry } from "@/game/domain/worldState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { asLocationId, asNpcId, asGenerationId } from "@/game/domain/scenarioBlueprint";
import type { ResolvedEvent } from "@/game/domain/resolvedEvent";

function makeWorldWithNpc() {
  const loc: LocationEntry = {
    id: asLocationId("loc_1"), name: "客栈", description: "一间简朴的客栈", kind: "main",
    connectedLocationIds: [asLocationId("loc_2")], npcIds: [asNpcId("npc_1")], availableItemIds: [], tags: [],
  };
  const loc2: LocationEntry = {
    id: asLocationId("loc_2"), name: "街道", description: "一条热闹的街道", kind: "main",
    connectedLocationIds: [asLocationId("loc_1")], npcIds: [], availableItemIds: [], tags: [],
  };
  let ws = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "侠客", identity: "剑客", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: loc,
    startingItemIds: [],
  });
  ws = appendLocation(ws, loc2);
  const npc: NpcEntry = {
    id: asNpcId("npc_1"), name: "客栈老板", role: "路人", description: "热情的老板",
    locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
    memory: { npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
  };
  ws = appendNpc(ws, npc);
  ws = { ...ws, unlockedLocationIds: [asLocationId("loc_1"), asLocationId("loc_2")] };
  return { ws, ss: createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 2, npcs: 1, quests: 0, events: 0 } }) };
}

function makeResolvedEvent(status: "success" | "partial_success" | "failure" | "blocked" = "success", eventKind: string = "observe"): ResolvedEvent {
  return {
    actionId: "act_test",
    status,
    eventKind: eventKind as ResolvedEvent["eventKind"],
    facts: [],
    stateChanges: [],
    costs: [],
    rewards: [],
    triggeredEvents: [],
    rejectedEffects: [],
    stateVersion: 0,
  };
}

describe("deterministicSceneSource", () => {
  it("produces a scene with narration and 2 choices", async () => {
    const { ws, ss } = makeWorldWithNpc();
    const source = createDeterministicSceneSource();
    const result = await source.generateScene({
      worldState: ws,
      storyState: ss,
      resolvedEvent: makeResolvedEvent(),
    });
    expect(result.scene.narration).toBeTruthy();
    expect(result.scene.narration.length).toBeGreaterThan(0);
    expect(result.scene.choices).toHaveLength(2);
    expect(result.scene.source).toBe("fallback");
    expect(result.scene.sceneId).toBeTruthy();
  });

  it("choices have choiceToken and actionKey", async () => {
    const { ws, ss } = makeWorldWithNpc();
    const source = createDeterministicSceneSource();
    const result = await source.generateScene({
      worldState: ws,
      storyState: ss,
      resolvedEvent: makeResolvedEvent(),
    });
    for (const choice of result.scene.choices) {
      expect(choice.choiceToken).toBeTruthy();
      expect(choice.actionKey).toBeTruthy();
      expect(choice.label).toBeTruthy();
    }
  });

  it("produces NPC dialogue when NPC is at location", async () => {
    const { ws, ss } = makeWorldWithNpc();
    const source = createDeterministicSceneSource();
    const result = await source.generateScene({
      worldState: ws,
      storyState: ss,
      resolvedEvent: makeResolvedEvent("success", "dialogue"),
    });
    expect(result.scene.npcLine).not.toBeNull();
    if (result.scene.npcLine) {
      expect(result.scene.npcLine.npcId).toBe(asNpcId("npc_1"));
      expect(result.scene.npcLine.text.length).toBeGreaterThan(0);
    }
  });

  it("event proposals is empty array for deterministic source", async () => {
    const { ws, ss } = makeWorldWithNpc();
    const source = createDeterministicSceneSource();
    const result = await source.generateScene({
      worldState: ws,
      storyState: ss,
      resolvedEvent: makeResolvedEvent(),
    });
    expect(result.eventProposals).toEqual([]);
  });

  it("choices include a move action when connected locations exist", async () => {
    const { ws, ss } = makeWorldWithNpc();
    const source = createDeterministicSceneSource();
    const result = await source.generateScene({
      worldState: ws,
      storyState: ss,
      resolvedEvent: makeResolvedEvent(),
    });
    const hasMoveChoice = result.scene.choices.some(
      (c) => c.actionKey.startsWith("move:"),
    );
    expect(hasMoveChoice).toBe(true);
  });
});
