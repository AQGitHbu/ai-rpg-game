import type { GameRepositoryV2 } from "./server/persistence/gameRepositoryV2";
import type { GameId } from "./server/persistence/gameRepository";
import type { WorldState, LocationEntry, NpcEntry, ItemEntry, QuestEntry } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { GameTypeId, GameLength } from "@/game/domain/newGame";
import { createInitialWorldState, appendLocation, appendNpc, appendItem } from "@/game/domain/worldState";
import type { QuestId, EndingId } from "@/game/domain/scenarioBlueprint";
import { asQuestId, asEndingId } from "@/game/domain/scenarioBlueprint";
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
  /** Whether AI config is available (determines narrative.mode) */
  readonly aiEnabled?: boolean;
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

  // Only unlock the starting location; connected locations are discovered
  // through gameplay (spec: 渐进式世界扩展)
  worldState = {
    ...worldState,
    unlockedLocationIds: [worldState.currentLocationId],
  };

  // Create a default main quest from generated world data
  // (spec §9.2: 初始任务主线3幕骨架)
  const firstNpc = generated.npcs[0];
  const secondLoc = generated.locations.find((l) => l.id !== generated.startingLocationId);
  const quest: QuestEntry = {
    id: asQuestId("quest_main"),
    name: "探索未知世界",
    description: "踏出客栈，探索这个世界隐藏的秘密。",
    kind: "main",
    status: "active",
    objectives: [
      ...(firstNpc ? [{ kind: "talk_to_npc" as const, npcId: firstNpc.id }] : []),
      ...(secondLoc ? [{ kind: "visit_location" as const, locationId: secondLoc.id }] : []),
    ],
    onSuccess: { kind: "reach_ending", endingId: asEndingId("ending_success") },
    onFailure: { kind: "closed" },
    tags: ["main"],
  };
  worldState = {
    ...worldState,
    quests: [quest],
  };
  // Also add a default ending so quest onSuccess can resolve
  worldState = {
    ...worldState,
    endings: [
      { id: asEndingId("ending_success"), name: "冒险成功", description: "你完成了这段冒险。", requirements: [] },
    ],
  };

  const storyState = createInitialStoryState({
    gameLength: input.gameLength,
    initialEntityCounts: {
      locations: generated.locations.length,
      npcs: generated.npcs.length,
      quests: 1,
      events: 0,
    },
  });

  // Set narrative to pending so the first scene (prologue) gets generated
  // by the ensure polling mechanism (spec §9.1: 生成序幕场景)
  // Also set narrative.mode to "ai" when AI config is available
  const narrativeMode = deps.aiEnabled ? "ai" : "offline";
  const storyStateWithPending: StoryState = {
    ...storyState,
    narrative: {
      ...storyState.narrative,
      mode: narrativeMode,
      generation: {
        status: "pending",
        requestedAt: deps.now(),
      },
    },
  };

  const createResult = await deps.repository.createInitialGame({
    gameId: input.gameId,
    worldState,
    storyState: storyStateWithPending,
    createdAt: deps.now(),
  });

  if (!createResult.ok) return createResult;
  return { ok: true, revision: 0 };
}

export function createFixtureWorldSource(): WorldGenerationSource {
  return {
    async generate() {
      // 开局只给 1 个地点 + 1 个 NPC（spec：渐进式世界扩展）
      const loc1: LocationEntry = {
        id: asLocationId("loc_start"), name: "起始客栈", description: "一间简朴的客栈，空气中弥漫着茶香。门外是一条通往小镇的土路。", kind: "main",
        connectedLocationIds: [asLocationId("loc_street")], npcIds: [asNpcId("npc_innkeeper")], availableItemIds: [], tags: [],
      };
      // 第二个地点存在但不解锁——通过剧情推进后 ExpansionProposer 提议解锁
      const loc2: LocationEntry = {
        id: asLocationId("loc_street"), name: "小镇街道", description: "热闹的街道两旁摆满了摊位", kind: "main",
        connectedLocationIds: [asLocationId("loc_start")], npcIds: [], availableItemIds: [], tags: [],
      };
      const npc1: NpcEntry = {
        id: asNpcId("npc_innkeeper"), name: "客栈老板", role: "路人", description: "热情的客栈老板，似乎知道很多消息",
        locationId: asLocationId("loc_start"), isCompanion: false, tags: [], met: false,
        memory: { npcId: asNpcId("npc_innkeeper"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
      };
      return {
        locations: [loc1, loc2],
        npcs: [npc1],
        items: [],
        startingLocationId: loc1.id,
        player: { name: "无名侠客", identity: "流浪剑客", stats: { hp: 100, attack: 10, defense: 5 } },
      };
    },
  };
}
