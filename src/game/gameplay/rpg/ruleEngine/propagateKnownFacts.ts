import type { WorldState, NpcEntry } from "@/game/domain/worldState";
import type { FactChange } from "@/game/domain/resolvedEvent";
import type { FactId } from "@/game/domain/scenarioBlueprint";

export function propagateKnownFacts(
  ws: WorldState,
  factChanges: readonly FactChange[],
): WorldState {
  if (factChanges.length === 0) return ws;

  // 收集每个 NPC 需要追加的新事实
  const additions = new Map<string, Set<string>>();
  for (const change of factChanges) {
    if (change.change !== "discovered" && change.change !== "revealed") continue;
    if (change.audience === undefined) continue;
    for (const npcId of change.audience) {
      const key = String(npcId);
      if (!additions.has(key)) additions.set(key, new Set());
      additions.get(key)!.add(String(change.factId));
    }
  }

  if (additions.size === 0) return ws;

  const newNpcs: NpcEntry[] = ws.npcs.map((npc) => {
    const adds = additions.get(String(npc.id));
    if (adds === undefined) return npc;

    const existingSet = new Set(npc.memory.knownFactIds.map(String));
    const toAdd = Array.from(adds).filter((f) => !existingSet.has(f));
    if (toAdd.length === 0) return npc;

    return {
      ...npc,
      memory: {
        ...npc.memory,
        knownFactIds: [
          ...npc.memory.knownFactIds,
          ...toAdd.map((f) => f as FactId),
        ],
      },
    };
  });

  return { ...ws, npcs: newNpcs };
}
