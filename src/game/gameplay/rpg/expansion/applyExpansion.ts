import type { WorldState } from "@/game/domain/worldState";
import type { GameEvent } from "@/game/domain/events";
import type { ApprovedExpansion } from "./expansionTypes";
import { asLocationId, type LocationId } from "@/game/domain/scenarioBlueprint";

/** 审批阶段为 item 记录的挂载目标：`location_id:<id>` tag（无 path patch）。 */
const ITEM_LOCATION_TAG = "location_id:";

/**
 * 纯函数应用已审批的扩展（Spec §15.3）：
 * - 新地点立即 unlocked（进入 unlockedLocationIds）并与源地点双向连接；
 * - 新 NPC 加入其所在地点的 npcIds 索引；
 * - 新物品挂到其目标地点的 availableItemIds；
 * - 新敌人保留合法地点与遭遇方式（enemy.locationId 已在审批校验）；
 * - 绝不覆盖既有定义字段（只追加，不做任意 path patch）。
 */
export function applyApprovedExpansion(ws: WorldState, approved: ApprovedExpansion, occurredAt: string): WorldState {
  const event: GameEvent = {
    type: "blueprint_expanded",
    newLocationIds: approved.newLocations.map((l) => l.id),
    newNpcIds: approved.newNpcs.map((n) => n.id),
    newFactIds: approved.newFacts.map((f) => f.factId),
    newItemIds: approved.newItems.map((i) => i.id),
    newEnemyIds: approved.newEnemies.map((e) => e.id),
    occurredAt,
  };

  let locations = [...ws.locations, ...approved.newLocations];

  // 双向连接：新地点 ↔ 源地点
  for (const newLoc of approved.newLocations) {
    locations = locations.map((l) => {
      if (l.id === newLoc.id) {
        // 新地点已声明 connectFrom；此处确保它指向源地点（若源地点为同批新地点也已展开）
        return l;
      }
      if (l.id === newLoc.connectedLocationIds[0] && !l.connectedLocationIds.includes(newLoc.id)) {
        return { ...l, connectedLocationIds: [...l.connectedLocationIds, newLoc.id] };
      }
      return l;
    });
  }

  // NPC 挂载索引：把新 NPC 加入其所在地点的 npcIds
  for (const newNpc of approved.newNpcs) {
    locations = locations.map((l) =>
      l.id === newNpc.locationId && !l.npcIds.includes(newNpc.id)
        ? { ...l, npcIds: [...l.npcIds, newNpc.id] }
        : l,
    );
  }

  // 物品挂载：新物品加入其目标地点的 availableItemIds（依据 location_id:<id> tag）
  for (const newItem of approved.newItems) {
    const targetLocId = itemTargetLocationId(newItem);
    if (targetLocId === null) continue;
    locations = locations.map((l) =>
      l.id === targetLocId && !l.availableItemIds.includes(newItem.id)
        ? { ...l, availableItemIds: [...l.availableItemIds, newItem.id] }
        : l,
    );
  }

  // 新地点立即解锁（不重复）
  const newLocIds = approved.newLocations.map((l) => l.id);
  const unlockedLocationIds = [...ws.unlockedLocationIds];
  for (const id of newLocIds) {
    if (!unlockedLocationIds.some((u) => u === id)) unlockedLocationIds.push(id);
  }

  return {
    ...ws,
    locations,
    unlockedLocationIds,
    npcs: [...ws.npcs, ...approved.newNpcs],
    items: [...ws.items, ...approved.newItems],
    enemies: [...ws.enemies, ...approved.newEnemies],
    worldFacts: [...ws.worldFacts, ...approved.newFacts],
    eventLedger: [...ws.eventLedger, event],
  };
}

function itemTargetLocationId(item: { readonly tags: readonly string[] }): LocationId | null {
  for (const tag of item.tags) {
    if (tag.startsWith(ITEM_LOCATION_TAG)) {
      return asLocationId(tag.slice(ITEM_LOCATION_TAG.length));
    }
  }
  return null;
}
