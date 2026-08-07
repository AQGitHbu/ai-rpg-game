import type { GameRepositoryV2 } from "./server/persistence/gameRepositoryV2";
import type { GameId } from "./server/persistence/gameRepository";
import type { WorldState, LocationEntry, NpcEntry, ItemEntry } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { GameTypeId, GameLength } from "@/game/domain/newGame";
import { createInitialWorldState, appendLocation, appendNpc, appendItem } from "@/game/domain/worldState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { asLocationId, asNpcId, asItemId, asGenerationId } from "@/game/domain/scenarioBlueprint";

export type WorldGenerationSource = {
  generate(input: {
    gameType: GameTypeId;
    seed: string;
    gameLength: GameLength;
  }): Promise<{
    locations: readonly LocationEntry[];
    npcs: readonly NpcEntry[];
    items: readonly ItemEntry[];
    startingLocationId: LocationEntry["id"];
    player: { name: string; identity: string; stats: { hp: number; attack: number; defense: number } };
  }>;
};

export type CreateGameV2Input = {
  readonly gameId: GameId;
  readonly gameType: GameTypeId;
  readonly gameLength: GameLength;
  readonly seed: string;
};

export type CreateGameV2Result =
  | { readonly ok: true; readonly revision: number }
  | { readonly ok: false; readonly code: "ACTIVE_GAME_EXISTS" | "GENERATION_FAILED" | "INFRASTRUCTURE_FAILURE" };

export type CreateGameV2Deps = {
  readonly repository: GameRepositoryV2;
  readonly source: WorldGenerationSource;
  readonly now: () => string;
};

export async function createGameV2(
  input: CreateGameV2Input,
  deps: CreateGameV2Deps,
): Promise<CreateGameV2Result> {
  const generated = await deps.source.generate({
    gameType: input.gameType,
    seed: input.seed,
    gameLength: input.gameLength,
  });
  if (!generated) return { ok: false, code: "GENERATION_FAILED" };

  const generation = {
    generationId: asGenerationId(`gen_${input.seed}`),
    seed: input.seed,
    templateVersion: "v2" as const,
    inputDigest: "",
    gameType: input.gameType,
  };

  const startingLocation = generated.locations.find((l) => l.id === generated.startingLocationId);
  if (startingLocation === undefined) return { ok: false, code: "GENERATION_FAILED" };

  let worldState = createInitialWorldState({
    generation,
    player: generated.player,
    startingLocation,
    startingItemIds: [],
  });

  for (const loc of generated.locations) {
    if (loc.id !== startingLocation.id) worldState = appendLocation(worldState, loc);
  }
  for (const npc of generated.npcs) worldState = appendNpc(worldState, npc);
  for (const item of generated.items) worldState = appendItem(worldState, item);

  // Unlock starting location + its direct connections so the world map has nodes
  const startLoc = generated.locations.find((l) => l.id === generated.startingLocationId);
  const unlockIds = startLoc?.connectedLocationIds ?? [];
  worldState = {
    ...worldState,
    unlockedLocationIds: [worldState.currentLocationId, ...unlockIds],
  };

  const storyState = createInitialStoryState({
    gameLength: input.gameLength,
    initialEntityCounts: {
      locations: generated.locations.length,
      npcs: generated.npcs.length,
      quests: 0,
      events: 0,
    },
  });

  const createResult = await deps.repository.createInitialGame({
    gameId: input.gameId,
    worldState,
    storyState,
    createdAt: deps.now(),
  });

  if (!createResult.ok) return createResult;
  return { ok: true, revision: 0 };
}

export function createFixtureWorldSource(): WorldGenerationSource {
  return {
    async generate() {
      const loc1: LocationEntry = {
        id: asLocationId("loc_start"), name: "起始客栈", description: "一间简朴的客栈，空气中弥漫着茶香", kind: "main",
        connectedLocationIds: [asLocationId("loc_street"), asLocationId("loc_forest")], npcIds: [asNpcId("npc_innkeeper")], availableItemIds: [], tags: [],
      };
      const loc2: LocationEntry = {
        id: asLocationId("loc_street"), name: "小镇街道", description: "热闹的街道两旁摆满了摊位", kind: "main",
        connectedLocationIds: [asLocationId("loc_start"), asLocationId("loc_temple")], npcIds: [asNpcId("npc_merchant")], availableItemIds: [asItemId("item_map")], tags: [],
      };
      const loc3: LocationEntry = {
        id: asLocationId("loc_forest"), name: "镇外松林", description: "茂密的松林，远处传来鸟鸣", kind: "main",
        connectedLocationIds: [asLocationId("loc_start"), asLocationId("loc_temple")], npcIds: [asNpcId("npc_hunter")], availableItemIds: [], tags: ["wild"],
      };
      const loc4: LocationEntry = {
        id: asLocationId("loc_temple"), name: "古寺废墟", description: "残垣断壁间杂草丛生，隐约可见昔日佛像", kind: "main",
        connectedLocationIds: [asLocationId("loc_street"), asLocationId("loc_forest")], npcIds: [], availableItemIds: [asItemId("item_amulet")], tags: ["ruin"],
      };
      const npc1: NpcEntry = {
        id: asNpcId("npc_innkeeper"), name: "客栈老板", role: "路人", description: "热情的客栈老板，似乎知道很多消息",
        locationId: asLocationId("loc_start"), isCompanion: false, tags: [], met: false,
        memory: { npcId: asNpcId("npc_innkeeper"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
      };
      const npc2: NpcEntry = {
        id: asNpcId("npc_merchant"), name: "游方商贩", role: "路人", description: "精明的商贩，摊上摆着各种杂货",
        locationId: asLocationId("loc_street"), isCompanion: false, tags: [], met: false,
        memory: { npcId: asNpcId("npc_merchant"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
      };
      const npc3: NpcEntry = {
        id: asNpcId("npc_hunter"), name: "老猎人", role: "路人", description: "沉默的老猎人，守在松林边缘",
        locationId: asLocationId("loc_forest"), isCompanion: false, tags: [], met: false,
        memory: { npcId: asNpcId("npc_hunter"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
      };
      const item1: ItemEntry = {
        id: asItemId("item_map"), name: "残破地图", description: "一张残破的地图，标记着古寺的位置", kind: "key",
        tags: [],
      };
      const item2: ItemEntry = {
        id: asItemId("item_amulet"), name: "旧护符", description: "一枚褪色的护符，摸起来微微发热", kind: "key",
        tags: [],
      };
      return {
        locations: [loc1, loc2, loc3, loc4],
        npcs: [npc1, npc2, npc3],
        items: [item1, item2],
        startingLocationId: loc1.id,
        player: { name: "无名侠客", identity: "流浪剑客", stats: { hp: 100, attack: 10, defense: 5 } },
      };
    },
  };
}
