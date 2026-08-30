import { describe, expect, it } from "vitest";
import {
  createJourneyGame,
  loadWorldState,
} from "./foundationJourney.testutil";
import {
  validateEntityCompatibilityProjection,
  validateEntityReferences,
  validateEntityStoreStructure,
  type EntityCompatibilityProjection,
} from "@/game/domain/entity";
import { validateWorldStateEntityReferences } from "@/game/domain/worldStateValidation";
import type { WorldState } from "@/game/domain/worldState";

function compatibilityProjectionOf(ws: WorldState): EntityCompatibilityProjection {
  return {
    player: ws.player,
    locations: ws.locations,
    currentLocationId: ws.currentLocationId,
    unlockedLocationIds: ws.unlockedLocationIds,
    visitedLocationIds: ws.visitedLocationIds,
    npcs: ws.npcs,
    items: ws.items,
    inventory: ws.inventory,
    worldFacts: ws.worldFacts,
    quests: ws.quests,
    enemies: ws.enemies,
    defeatedEnemyIds: ws.defeatedEnemyIds,
    factions: ws.factions,
  };
}

function expectEntityWorldConsistent(worldState: WorldState): void {
  expect(validateEntityStoreStructure(worldState.entityStore)).toEqual([]);
  expect(validateEntityReferences(worldState.entityStore)).toEqual([]);
  expect(validateWorldStateEntityReferences(worldState)).toEqual([]);
  expect(validateEntityCompatibilityProjection(worldState.entityStore, compatibilityProjectionOf(worldState))).toEqual([]);
}

describe("entity projection cross-layer journey", () => {
  it("keeps store, projection and reload consistent across 15 CAS turns", async () => {
    const { repo } = await createJourneyGame();
    for (let turn = 0; turn < 15; turn += 1) {
      const current = await repo.repo.getCurrentGame();
      expect(current.ok && current.status === "active").toBe(true);
      if (!current.ok || current.status !== "active") return;
      expectEntityWorldConsistent(current.record.worldState);
      const locationId = current.record.worldState.currentLocationId;
      const saved = await repo.repo.applyState({
        gameId: current.record.gameId,
        expectedRevision: current.record.revision,
        nextWorldState: { ...current.record.worldState, entityStore: current.record.worldState.entityStore },
        nextStoryState: current.record.storyState,
      });
      expect(saved.ok).toBe(true);
      if (!saved.ok) return;
      expect(saved.record.worldState.currentLocationId).toBe(locationId);
      expectEntityWorldConsistent(saved.record.worldState);
      if (turn % 5 === 4) {
        const reloaded = repo.record();
        expect(reloaded).not.toBeNull();
        if (reloaded !== null) {
          repo.restore(JSON.parse(JSON.stringify(reloaded)) as typeof reloaded);
          const world = await loadWorldState(repo.repo);
          expect(world).not.toBeNull();
          if (world !== null) expectEntityWorldConsistent(world);
        }
      }
    }
  });
});
