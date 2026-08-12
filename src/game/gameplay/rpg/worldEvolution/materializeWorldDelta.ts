import type { ApprovedWorldDeltaCore } from "./approveWorldDelta";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { EvolutionNeed, ApprovedWorldDelta } from "@/game/domain/worldDelta";
import type { BlueprintExpandedEvent } from "@/game/domain/events";
import type { LocationId, NpcId, ItemId } from "@/game/domain/worldEntity";
import type { TownRuntimeState } from "@/game/domain/townState";
import { createTownRuntime, townSeedFor, bindNpcToTownSlot } from "@/game/gameplay/rpg/town";

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

function bindTownNpcIfAvailable(town: TownRuntimeState, npcId: NpcId): TownRuntimeState {
  // 审批阶段会拒绝满槽小镇；这里仍保持装配函数防御性，避免旧存档或直接调用
  // materializeWorldDelta 时因 slot 不足把整条叙事流水线抛出异常。
  if (!town.slots.some((slot) => slot.boundNpcId === null)) return town;
  return bindNpcToTownSlot(town, npcId).town;
}

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
      // Task 7：NPC 具象化到既有小镇地点时绑定第一个空闲 slot（几何/建筑 ID 不变）。
      let town = loc.town;
      if (town !== undefined && p?.npcIds) {
        for (const npcId of p.npcIds) {
          town = bindTownNpcIfAvailable(town, npcId);
        }
      }
      return {
        ...loc,
        connectedLocationIds: [...new Set([...loc.connectedLocationIds, ...connectedToNew])],
        npcIds: p?.npcIds ? [...loc.npcIds, ...p.npcIds] : loc.npcIds,
        availableItemIds: p?.availableItemIds ? [...loc.availableItemIds, ...p.availableItemIds] : loc.availableItemIds,
        town,
      };
    }),
    ...approved.newLocations.map((loc) => {
      const p = patch.get(loc.id);
      // Task 7：新具象化的 town 地点在装配时创建稳定几何；随行 NPC 绑定空闲 slot。
      let town: WorldState["locations"][number]["town"] = loc.scale === "town"
        ? createTownRuntime({ locationId: loc.id, seed: townSeedFor(ws.generation.seed, loc.id) })
        : undefined;
      if (town !== undefined) {
        const npcIds = p?.npcIds ?? [...loc.npcIds];
        for (const npcId of npcIds) {
          town = bindTownNpcIfAvailable(town, npcId);
        }
      }
      return {
        ...loc,
        // approved.newLocations 已在审批时带有 connectFrom 的反向边；不要把
        // 同批新地点（尤其自身）再次并入连接表，否则会产生“前往当前地点”的自环。
        connectedLocationIds: [...new Set(loc.connectedLocationIds)],
        npcIds: p?.npcIds ?? [...loc.npcIds],
        availableItemIds: p?.availableItemIds ?? [...loc.availableItemIds],
        town,
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
