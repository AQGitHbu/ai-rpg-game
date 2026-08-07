import type { WorldState } from "@/game/domain/worldState";
import { findLocation } from "@/game/domain/worldState";

export type IntentContextEntity = {
  readonly id: string;
  readonly name: string;
};

export type IntentContext = {
  readonly currentLocationName: string;
  readonly connectedLocations: readonly IntentContextEntity[];
  readonly presentNpcs: readonly IntentContextEntity[];
  readonly availableItems: readonly IntentContextEntity[];
  readonly undiscoveredFacts: readonly IntentContextEntity[];
  readonly activeQuests: readonly IntentContextEntity[];
};

export function buildIntentContext(ws: WorldState): IntentContext {
  const currentLoc = findLocation(ws, ws.currentLocationId);

  const connectedLocations = currentLoc
    ? currentLoc.connectedLocationIds
        .map((id) => findLocation(ws, id))
        .filter((l): l is NonNullable<typeof l> => l !== undefined)
        .map((l) => ({ id: String(l.id), name: l.name }))
    : [];

  const presentNpcs = ws.npcs
    .filter((n) => n.locationId === ws.currentLocationId)
    .map((n) => ({ id: String(n.id), name: n.name }));

  const availableItems = currentLoc
    ? currentLoc.availableItemIds
        .map((id) => ws.items.find((i) => i.id === id))
        .filter((i): i is NonNullable<typeof i> => i !== undefined)
        .map((i) => ({ id: String(i.id), name: i.name }))
    : [];

  const undiscoveredFacts = ws.worldFacts
    .filter((f) => !f.discovered)
    .map((f) => ({ id: String(f.factId), name: f.text.slice(0, 20) }));

  const activeQuests = ws.quests
    .filter((q) => q.status === "active")
    .map((q) => ({ id: String(q.id), name: q.name }));

  return {
    currentLocationName: currentLoc?.name ?? "未知",
    connectedLocations,
    presentNpcs,
    availableItems,
    undiscoveredFacts,
    activeQuests,
  };
}
