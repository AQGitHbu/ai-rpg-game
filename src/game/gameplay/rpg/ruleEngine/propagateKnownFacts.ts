import type { WorldState } from "@/game/domain/worldState";
import type { FactChange, FactChangeSource } from "@/game/domain/resolvedEvent";
import {
  compileLegacyNpcSync,
  entitiesOfKind,
  projectNpcEntry,
  type AddedNpcKnowledge,
} from "@/game/domain/entity";
import { applyEntityMutations, EntityMutationInvariantError, type EntityMutation } from "@/game/gameplay/rpg/entityWorld";

// ---------------------------------------------------------------------------
// P4 Step 1：把本轮 discovered/revealed 事实传播给在场 NPC。
// Plan 3 Task 2 后知识住在 NpcKnowledgeComponent：本文件只负责「哪些 NPC 因为哪条
// 证据得到哪条事实」，写入统一走唯一过渡桥 sync_npc_legacy_memory，
// 由 compileLegacyNpcSync 逐条带上 mode/actionId/learnedAtTurn，绝不从差集猜来源。
// ---------------------------------------------------------------------------

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
  deps: Readonly<{ actionId: string; turnNumber: number }>,
): WorldState {
  if (factChanges.length === 0) return ws;

  const knownFactIds = new Set(ws.worldFacts.map((f) => String(f.factId)));
  const records = entitiesOfKind(ws.entityStore, "npc");
  const presentNpcKeys = new Set(records.map((record) => String(record.core.id)));

  // 收集每个 NPC 需要追加的新事实：连同其真实来源一起记账，来源不能事后反推。
  const additions = new Map<string, AddedNpcKnowledge[]>();
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
      const bucket = additions.get(key);
      const added: AddedNpcKnowledge = {
        factId: change.factId,
        mode: change.source,
      };
      if (bucket === undefined) additions.set(key, [added]);
      else if (!bucket.some((entry) => String(entry.factId) === String(added.factId))) bucket.push(added);
    }
  }

  if (additions.size === 0) return ws;

  const mutations: EntityMutation[] = records.flatMap((record) => {
    const adds = additions.get(String(record.core.id));
    if (adds === undefined) return [];

    const before = projectNpcEntry(record);
    const existingSet = new Set(before.memory.knownFactIds.map(String));
    const toAdd = adds.filter((entry) => !existingSet.has(String(entry.factId)));
    if (toAdd.length === 0) return [];

    return [{
      kind: "sync_npc_legacy_memory" as const,
      npcId: record.core.id,
      npc: compileLegacyNpcSync({
        before: record,
        afterLegacy: {
          ...before,
          memory: {
            ...before.memory,
            knownFactIds: [...before.memory.knownFactIds, ...toAdd.map((entry) => entry.factId)],
          },
        },
        actionId: deps.actionId,
        turnNumber: deps.turnNumber,
        addedKnowledge: toAdd,
      }),
    }];
  });

  if (mutations.length === 0) return ws;
  const applied = applyEntityMutations(ws, mutations);
  if (!applied.ok) throw new EntityMutationInvariantError(applied);
  return applied.worldState;
}
