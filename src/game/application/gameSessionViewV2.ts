import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { LocationId, NpcId } from "@/game/domain/scenarioBlueprint";

export type GameSessionViewV2 = {
  readonly revision: number;
  readonly player: { readonly name: string; readonly identity: string; readonly hp: number; readonly attack: number; readonly defense: number };
  readonly currentLocation: { readonly id: LocationId; readonly name: string; readonly description: string };
  readonly availableNpcs: readonly { readonly id: NpcId; readonly name: string; readonly role: string; readonly met: boolean }[];
  readonly availableMoves: readonly { readonly locationId: LocationId; readonly name: string }[];
  readonly inventory: readonly { readonly itemId: string; readonly name: string }[];
  readonly story: {
    readonly currentAct: number;
    readonly targetActs: number;
    readonly tension: number;
    readonly pacingNeed: string;
    readonly storyProgress: number;
  };
  readonly narrative: {
    readonly mode: string;
    readonly hasScene: boolean;
  };
  readonly ending: { readonly endingId: string; readonly outcome: string } | null;
};

export function projectGameSessionView(
  worldState: WorldState,
  storyState: StoryState,
  revision: number,
): GameSessionViewV2 {
  const currentLoc = worldState.locations.find((l) => l.id === worldState.currentLocationId);
  const npcsHere = worldState.npcs.filter((n) => n.locationId === worldState.currentLocationId);
  const moves = currentLoc?.connectedLocationIds
    .filter((id) => worldState.unlockedLocationIds.includes(id))
    .map((id) => {
      const loc = worldState.locations.find((l) => l.id === id);
      return { locationId: id, name: loc?.name ?? "???" };
    }) ?? [];

  return {
    revision,
    player: {
      name: worldState.player.name,
      identity: worldState.player.identity,
      hp: worldState.player.stats.hp,
      attack: worldState.player.stats.attack,
      defense: worldState.player.stats.defense,
    },
    currentLocation: {
      id: worldState.currentLocationId,
      name: currentLoc?.name ?? "???",
      description: currentLoc?.description ?? "",
    },
    availableNpcs: npcsHere.map((n) => ({ id: n.id, name: n.name, role: n.role, met: n.met })),
    availableMoves: moves,
    inventory: worldState.inventory.map((itemId) => {
      const item = worldState.items.find((i) => i.id === itemId);
      return { itemId: String(itemId), name: item?.name ?? "???" };
    }),
    story: {
      currentAct: storyState.currentAct,
      targetActs: storyState.targetActs,
      tension: storyState.tension,
      pacingNeed: storyState.nextPacingNeed,
      storyProgress: storyState.storyProgress,
    },
    narrative: {
      mode: storyState.narrative.mode,
      hasScene: storyState.narrative.currentScene !== null,
    },
    ending: worldState.ending ? { endingId: String(worldState.ending.endingId), outcome: worldState.ending.outcome } : null,
  };
}
