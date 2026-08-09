import type { WorldState, NpcEntry } from "@/game/domain/worldState";
import type { FactChange, FactChangeSource } from "@/game/domain/resolvedEvent";
import type { FactId } from "@/game/domain/scenarioBlueprint";

/** 封闭来源集合：非此集合的 source 一律拒绝。 */
const VALID_SOURCES: readonly FactChangeSource[] = [
  "scene_witness",
  "player_told",
  "npc_revealed",
  "public_broadcast",
  "faction_shared",
];

function isValidSource(source: FactChangeSource): boolean {
  return VALID_SOURCES.includes(source);
}

export function propagateKnownFacts(
  ws: WorldState,
  factChanges: readonly FactChange[],
): WorldState {
  if (factChanges.length === 0) return ws;

  const knownFactIds = new Set(ws.worldFacts.map((f) => String(f.factId)));
  const presentNpcKeys = new Set(ws.npcs.map((n) => String(n.id)));

  // 收集每个 NPC 需要追加的新事实
  const additions = new Map<string, Set<string>>();
  for (const change of factChanges) {
    // 1) 拒绝非法 source
    if (!isValidSource(change.source)) continue;
    // 2) 只传播 discovered / revealed
    if (change.change !== "discovered" && change.change !== "revealed") continue;
    // 3) 拒绝不存在的 fact
    if (!knownFactIds.has(String(change.factId))) continue;
    // 4) 无 audience 不传播给任何 NPC（player_told/scene_witness 需显式对象）
    if (change.audience === undefined) continue;
    for (const npcId of change.audience) {
      const key = String(npcId);
      // 5) audience 中的 NPC 必须存在
      if (!presentNpcKeys.has(key)) continue;
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
