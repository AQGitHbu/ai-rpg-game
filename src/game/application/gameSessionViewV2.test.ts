import { describe, it, expect } from "vitest";
import { projectGameSessionView } from "./gameSessionViewV2";
import { createInitialWorldState, appendNpc, appendLocation, type LocationEntry, type NpcEntry } from "@/game/domain/worldState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { asLocationId, asNpcId, asGenerationId } from "@/game/domain/scenarioBlueprint";

describe("projectGameSessionView", () => {
  const loc1: LocationEntry = {
    id: asLocationId("loc_1"), name: "客栈", description: "一间客栈", kind: "main",
    connectedLocationIds: [asLocationId("loc_2")], npcIds: [asNpcId("npc_1")], availableItemIds: [], tags: [],
  };
  const loc2: LocationEntry = {
    id: asLocationId("loc_2"), name: "街道", description: "一条街道", kind: "main",
    connectedLocationIds: [asLocationId("loc_1")], npcIds: [], availableItemIds: [], tags: [],
  };
  const npc1: NpcEntry = {
    id: asNpcId("npc_1"), name: "老板", role: "路人", description: "t",
    locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
    memory: { npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
  };

  const ws = { ...appendNpc(appendLocation(createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "侠客", identity: "剑客", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: loc1,
    startingItemIds: [],
  }), loc2), npc1), unlockedLocationIds: [asLocationId("loc_1"), asLocationId("loc_2")] };
  const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 2, npcs: 1, quests: 0, events: 0 } });

  it("projects player and current location", () => {
    const view = projectGameSessionView(ws, ss, 0);
    expect(view.player.name).toBe("侠客");
    expect(view.currentLocation.name).toBe("客栈");
  });

  it("projects available NPCs at current location", () => {
    const view = projectGameSessionView(ws, ss, 0);
    expect(view.availableNpcs).toHaveLength(1);
    expect(view.availableNpcs[0]?.name).toBe("老板");
  });

  it("projects available moves to connected unlocked locations", () => {
    const view = projectGameSessionView(ws, ss, 0);
    expect(view.availableMoves).toHaveLength(1);
    expect(view.availableMoves[0]?.name).toBe("街道");
  });

  it("projects story metrics", () => {
    const view = projectGameSessionView(ws, ss, 0);
    expect(view.story.currentAct).toBe(1);
    expect(view.story.tension).toBe(30);
    expect(view.story.pacingNeed).toBe("reveal");
  });

  it("projects per-NPC dialogue pages for every present NPC", () => {
    const secondNpc: NpcEntry = {
      id: asNpcId("npc_2"), name: "客人", role: "酒客", description: "t",
      locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
      memory: { npcId: asNpcId("npc_2"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
    };
    const wsTwo = { ...ws, npcs: [...ws.npcs, secondNpc] };
    const view = projectGameSessionView(wsTwo, ss, 0);
    const dialogues = view.narrative.npcDialogues;
    expect(dialogues).toBeDefined();
    const ids = (dialogues ?? []).map((d) => String(d.npcId));
    expect(ids).toContain("npc_1");
    expect(ids).toContain("npc_2");
    for (const d of dialogues ?? []) {
      expect(d.speechPages.length).toBeGreaterThan(0);
    }
  });

  it("npcDialogues prefer scene dialogue pages and fall back to deterministic line", () => {
    const sceneWithDialogue = {
      ...ss,
      narrative: {
        ...ss.narrative,
        currentScene: {
          sceneId: "scene-1",
          turn: 0,
          narration: "你在客栈。",
          usedFactIds: [],
          npcLine: { npcId: asNpcId("npc_1"), text: "老板说道：\"需要什么吗？\"", emotion: "neutral" as const, usedFactIds: [] },
          choices: [] as never,
          source: "generated" as const,
          event: { kind: "dialogue" as const, focusNpcId: asNpcId("npc_1") },
          npcDialogues: [
            { npcId: asNpcId("npc_1"), npcName: "老板", npcRole: "路人", speechPages: ["需要什么吗？"] },
            { npcId: asNpcId("npc_2"), npcName: "客人", npcRole: "酒客", speechPages: [] },
          ],
        },
      },
    };
    const secondNpc: NpcEntry = {
      id: asNpcId("npc_2"), name: "客人", role: "酒客", description: "t",
      locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
      memory: { npcId: asNpcId("npc_2"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
    };
    const wsTwo = { ...ws, npcs: [...ws.npcs, secondNpc] };
    const view = projectGameSessionView(wsTwo, sceneWithDialogue, 0);
    const dialogues = view.narrative.npcDialogues ?? [];
    const lu = dialogues.find((d) => String(d.npcId) === "npc_1");
    const guest = dialogues.find((d) => String(d.npcId) === "npc_2");
    expect(lu!.speechPages.join("")).toBe("需要什么吗？");
    expect(guest!.speechPages.length).toBeGreaterThan(0);
  });
});
