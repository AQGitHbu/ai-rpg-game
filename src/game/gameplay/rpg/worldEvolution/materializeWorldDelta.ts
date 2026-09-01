import type { ApprovedWorldDeltaCore } from "./approveWorldDelta";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { EvolutionNeed, ApprovedWorldDelta } from "@/game/domain/worldDelta";
import type { BlueprintExpandedEvent } from "@/game/domain/events";
import type { LocationId, NpcId, ItemId } from "@/game/domain/worldEntity";
import type { TownRuntimeState } from "@/game/domain/townState";
import { createTownRuntime, townSeedFor, bindNpcToTownSlot } from "@/game/gameplay/rpg/town";
import {
  compileEntityStoreFromCompatibilityProjection,
  entitiesOfKind,
  projectEntityStore,
} from "@/game/domain/entity";
import { applyEntityMutations, EntityMutationInvariantError, type EntityMutation } from "@/game/gameplay/rpg/entityWorld";

// ---------------------------------------------------------------------------
// Task 3：把已审批的世界演化装配为预览状态并落账。
// 纯函数（除注入时钟 now）；不改动入参状态，返回 immutable 预览世界/故事状态。
// 接线规则：新地点与既有地点双向连接；是否解锁由主线释放游标决定；NPC/物品挂载到所属地点；
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
  readonly townBuildingNames?: readonly { readonly npcId: NpcId; readonly displayName: string }[];
};

function bindTownNpcIfAvailable(
  town: TownRuntimeState,
  npcId: NpcId,
  displayName?: string,
): TownRuntimeState {
  // 满槽小镇里的临时剧情人物仍挂在 locationId 上，但不占用建筑入口。
  // 有空槽时才绑定一个建筑；这样 town 的几何保持稳定，场景层仍可展示该人物。
  if (!town.slots.some((slot) => slot.boundNpcId === null)) return town;
  return bindNpcToTownSlot(town, npcId, displayName).town;
}

export function materializeWorldDelta(input: MaterializeWorldDeltaInput): ApprovedWorldDelta {
  const { approved, ws, ss, now } = input;

  const newLocationIds = approved.newLocations.map((l) => l.id);
  const stagedQuest = approved.newQuests[0];
  const firstObjective = stagedQuest?.objectives[0];
  const locationsReleasedImmediately = stagedQuest === undefined || firstObjective?.kind === "visit_location"
    ? newLocationIds
    : [];

  // 挂载增量（避免重复挂载到新地点条目）。
  const patch = new Map<LocationId, LocationPatch>();
  for (const npc of approved.newNpcs) {
    const cur = patch.get(npc.locationId) ?? {};
    const townBuildingBinding = approved.townBuildingBindings.find((binding) => binding.npcId === npc.id);
    patch.set(npc.locationId, {
      ...cur,
      npcIds: [...(cur.npcIds ?? []), npc.id],
      ...(townBuildingBinding === undefined
        ? {}
        : {
            townBuildingNames: [
              ...(cur.townBuildingNames ?? []),
              { npcId: npc.id, displayName: townBuildingBinding.displayName },
            ],
          }),
    });
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
          town = bindTownNpcIfAvailable(
            town,
            npcId,
            p.townBuildingNames?.find((binding) => binding.npcId === npcId)?.displayName,
          );
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

  // 先用唯一 projection compiler 在局部构造所需 EntityRecord；再只将新 records、
  // 已有地点组件和解锁索引作为一批规则可信 mutation 应用到原 store。
  const desiredStore = compileEntityStoreFromCompatibilityProjection({
    projection: {
      ...projectEntityStore(ws.entityStore),
      locations,
      npcs: [...ws.npcs, ...approved.newNpcs],
      items: [...ws.items, ...approved.newItems],
      enemies: [...ws.enemies, ...approved.newEnemies],
      worldFacts: [...ws.worldFacts, ...approved.newFacts],
      quests: [...ws.quests, ...approved.newQuests],
    },
    createdAtTurn: ss.turnNumber,
    previousStore: ws.entityStore,
  });
  const existingIds = new Set(ws.entityStore.records.map((record) => record.core.id));
  const mutations: EntityMutation[] = [];
  const createdRecords = desiredStore.records.filter((record) => !existingIds.has(record.core.id));
  if (createdRecords.length > 0) mutations.push({ kind: "create_entities", records: createdRecords });
  for (const location of entitiesOfKind(desiredStore, "location")) {
    if (existingIds.has(location.core.id)) {
      mutations.push({ kind: "replace_location_component", locationId: location.core.id, location: location.location });
    }
  }
  for (const locationId of locationsReleasedImmediately) {
    mutations.push({ kind: "set_location_unlocked", locationId, unlocked: true });
  }
  const applied = applyEntityMutations(ws, mutations);
  if (!applied.ok) throw new EntityMutationInvariantError(applied);
  const previewWorldState: WorldState = {
    ...applied.worldState,
    endings: [...applied.worldState.endings, ...approved.newEndings],
    eventLedger: [...applied.worldState.eventLedger, event],
  };

  const previewStoryState: StoryState = {
    ...ss,
    evolution: { ...approved.nextEvolution, status: "stable" },
    budget: approved.nextBudget,
    // A provider NPC handoff may pre-materialize the following act while the
    // current act still has item/battle objectives. That hidden future quest
    // must not steal the current reveal cursor; only the natural act boundary
    // (need.act === currentAct) releases its first objective.
    reveal: stagedQuest === undefined || stagedQuest.objectives.length === 0
      ? ss.reveal ?? null
      : stagedQuest.stage === ss.currentAct
        ? { questId: stagedQuest.id, visibleObjectiveIndex: 0 }
        : ss.reveal ?? null,
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
