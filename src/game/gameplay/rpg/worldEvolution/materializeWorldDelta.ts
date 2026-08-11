import type { ApprovedWorldDeltaCore } from "./approveWorldDelta";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { EvolutionNeed, ApprovedWorldDelta } from "@/game/domain/worldDelta";
import type { BlueprintExpandedEvent } from "@/game/domain/events";
import type { LocationId, NpcId, ItemId } from "@/game/domain/worldEntity";

// ---------------------------------------------------------------------------
// Task 3：把已审批的世界演化装配为预览状态并落账。
// 纯函数（除注入时钟 now）；不改动入参状态，返回 immutable 预览世界/故事状态。
// 接线规则：新地点与既有地点双向连接并自动解锁；NPC/物品挂载到所属地点；
// 实体经 appended 追加；blueprint_expanded 事件记录本次铸造的 ID。
// ---------------------------------------------------------------------------

export type MaterializeWorldDeltaInput = {
  readonly approved: ApprovedWorldDeltaCore;
  /** 对称签名；非终幕主线为 need.act，装配只消费 approved 内已解析条目。 */
  readonly need: EvolutionNeed;
  readonly ws: WorldState;
  readonly ss: StoryState;
  readonly now: () => string;
};

type LocationPatch = {
  readonly npcIds?: readonly NpcId[];
  readonly availableItemIds?: readonly ItemId[];
};

export function materializeWorldDelta(input: MaterializeWorldDeltaInput): ApprovedWorldDelta {
  const { approved, ws, ss, now } = input;

  const newLocationIds = approved.newLocations.map((l) => l.id);

  // 挂载增量（避免重复挂载到新地点条目）。
  const patch = new Map<LocationId, LocationPatch>();
  for (const npc of approved.newNpcs) {
    const cur = patch.get(npc.locationId) ?? {};
    patch.set(npc.locationId, { ...cur, npcIds: [...(cur.npcIds ?? []), npc.id] });
  }
  if (approved.itemLocationId && approved.newItems[0]) {
    const cur = patch.get(approved.itemLocationId) ?? {};
    patch.set(approved.itemLocationId, {
      ...cur,
      availableItemIds: [...(cur.availableItemIds ?? []), approved.newItems[0].id],
    });
  }

  const locations: WorldState["locations"] = [
    ...ws.locations.map((loc) => {
      const connectedToNew = approved.newLocations
        .filter((nl) => nl.connectedLocationIds.includes(loc.id))
        .map((nl) => nl.id);
      const p = patch.get(loc.id);
      return {
        ...loc,
        connectedLocationIds: [...new Set([...loc.connectedLocationIds, ...connectedToNew])],
        npcIds: p?.npcIds ? [...loc.npcIds, ...p.npcIds] : loc.npcIds,
        availableItemIds: p?.availableItemIds ? [...loc.availableItemIds, ...p.availableItemIds] : loc.availableItemIds,
      };
    }),
    ...approved.newLocations.map((loc) => {
      const p = patch.get(loc.id);
      return {
        ...loc,
        connectedLocationIds: [...new Set([...loc.connectedLocationIds, ...newLocationIds])],
        npcIds: p?.npcIds ?? [...loc.npcIds],
        availableItemIds: p?.availableItemIds ?? [...loc.availableItemIds],
      };
    }),
  ];

  const event: BlueprintExpandedEvent = {
    type: "blueprint_expanded",
    newLocationIds: approved.mintedLocationIds,
    newNpcIds: approved.mintedNpcIds,
    newFactIds: approved.mintedFactIds,
    newItemIds: approved.mintedItemIds,
    newEnemyIds: approved.mintedEnemyIds,
    newQuestIds: approved.mintedQuestIds,
    newEndingIds: approved.mintedEndingIds,
    occurredAt: now(),
  };

  const previewWorldState: WorldState = {
    ...ws,
    locations,
    npcs: [...ws.npcs, ...approved.newNpcs],
    items: [...ws.items, ...approved.newItems],
    enemies: [...ws.enemies, ...approved.newEnemies],
    worldFacts: [...ws.worldFacts, ...approved.newFacts],
    quests: [...ws.quests, ...approved.newQuests],
    endings: [...ws.endings, ...approved.newEndings],
    unlockedLocationIds: newLocationIds.length > 0
      ? [...new Set([...ws.unlockedLocationIds, ...newLocationIds])]
      : ws.unlockedLocationIds,
    eventLedger: [...ws.eventLedger, event],
  };

  const previewStoryState: StoryState = {
    ...ss,
    evolution: { ...approved.nextEvolution, status: "stable" },
    budget: approved.nextBudget,
  };

  return {
    mintedLocationIds: approved.mintedLocationIds,
    mintedNpcIds: approved.mintedNpcIds,
    mintedItemIds: approved.mintedItemIds,
    mintedEnemyIds: approved.mintedEnemyIds,
    mintedFactIds: approved.mintedFactIds,
    mintedQuestIds: approved.mintedQuestIds,
    mintedEndingIds: approved.mintedEndingIds,
    previewWorldState,
    previewStoryState,
  };
}
