import type { LocationId } from "@/game/domain/worldEntity";
import type { LocationEntry, WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { WorldDeltaProposal } from "@/game/domain/worldDelta";
import type { NarrativeEventDraft } from "@/game/domain/events";
import { PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import { entitiesOfKind, projectEntityStore } from "@/game/domain/entity";
import { compileEntityStoreFromCompatibilityProjection } from "@/game/domain/entity/entityProjection";
import { applyEntityMutations, EntityMutationInvariantError, type EntityMutation } from "@/game/gameplay/rpg/entityWorld";
import { validName, validText } from "./approveWorldDelta";

// ---------------------------------------------------------------------------
// 开局延迟地点的有界审批与材质化。
//
// 这里**不是**第二条 world evolution 通道：普通 world evolution 由
// deriveEvolutionNeed 的 need 闸门驱动，延迟路线不能伪造或绕过那个闸门。
// 本文件只提取「无 need 前提的纯结构校验」与「消费已保留 ID 的有界材质化」，
// 供 narrativePlanning 的分支选择在同一规则事务内使用。
// ---------------------------------------------------------------------------

export type DeferredLocationDefinition = NonNullable<WorldDeltaProposal["newLocation"]>;

export type DeferredLocationRejectionCode =
  | "deferred_placement_invalid"
  | "deferred_scale_invalid"
  | "deferred_connect_missing"
  | "deferred_name_invalid"
  | "deferred_duplicate_name"
  | "deferred_budget_exhausted"
  | "deferred_id_taken";

export type DeferredLocationCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: DeferredLocationRejectionCode };

/**
 * 纯结构审批：复用 newLocation 的严格结构与连通性校验，但不声称这是普通
 * world evolution 审批（没有 need、没有预算预占、不铸造主线任务）。
 *
 * 延迟地点只支持 placement:"world" + scale:"scene"：town_building 不是
 * LocationEntry，会让「访问地点」目标指向一个不存在的旅行终点。
 */
export function validateDeferredLocationDefinition(input: {
  readonly definition: DeferredLocationDefinition;
  readonly ws: WorldState;
}): DeferredLocationCheck {
  const d = input.definition;
  if (d.placement !== "world") return { ok: false, code: "deferred_placement_invalid" };
  if (d.scale !== "scene") return { ok: false, code: "deferred_scale_invalid" };
  if (!input.ws.locations.some((loc) => String(loc.id) === String(d.connectFromLocationId))) {
    return { ok: false, code: "deferred_connect_missing" };
  }
  if (!validName(d.name) || !validText(d.description)) return { ok: false, code: "deferred_name_invalid" };
  if (input.ws.locations.some((loc) => loc.name === d.name)) return { ok: false, code: "deferred_duplicate_name" };
  return { ok: true };
}

export type MaterializeDeferredLocationResult =
  | {
      readonly ok: true;
      readonly worldState: WorldState;
      readonly storyState: StoryState;
      readonly drafts: readonly NarrativeEventDraft[];
    }
  | { readonly ok: false; readonly code: DeferredLocationRejectionCode };

/**
 * 消费一个**已保留**的 locationId 材质化延迟地点，不再次自增铸造。
 *
 * - 玩家位置不变，只解锁新地点并与来源地点建立双向连接；
 * - 只推进 nextLocationOrdinal 到覆盖两条分支已保留的序号（未选分支留下空洞），
 *   实体预算仍只按「一个地点」预留；
 * - 不发 provider 请求、不递增幕数、不铸造 NPC/任务。
 */
export function materializeDeferredLocation(input: {
  readonly definition: DeferredLocationDefinition;
  readonly ws: WorldState;
  readonly ss: StoryState;
  readonly locationId: LocationId;
  /** 两条分支各自保留的序号；材质化后 ordinal 推进到 max+1。 */
  readonly reservedOrdinals: readonly number[];
  readonly episodeKey?: string;
}): MaterializeDeferredLocationResult {
  const structural = validateDeferredLocationDefinition({ definition: input.definition, ws: input.ws });
  if (!structural.ok) return structural;
  if (input.ws.locations.some((loc) => String(loc.id) === String(input.locationId))) {
    return { ok: false, code: "deferred_id_taken" };
  }
  if (input.ss.budget.locations.expanded >= input.ss.budget.locations.max) {
    return { ok: false, code: "deferred_budget_exhausted" };
  }

  const connectFrom = input.ws.locations.find(
    (loc) => String(loc.id) === String(input.definition.connectFromLocationId),
  );
  if (connectFrom === undefined) return { ok: false, code: "deferred_connect_missing" };

  const created: LocationEntry = {
    id: input.locationId,
    name: input.definition.name,
    description: input.definition.description,
    kind: "main",
    connectedLocationIds: [connectFrom.id],
    npcIds: [],
    availableItemIds: [],
    tags: ["deferred_route"],
    scale: "scene",
  };
  const locations: readonly LocationEntry[] = [
    ...input.ws.locations.map((loc) => (
      String(loc.id) === String(connectFrom.id)
        ? { ...loc, connectedLocationIds: [...loc.connectedLocationIds, created.id] }
        : loc
    )),
    created,
  ];

  const desiredStore = compileEntityStoreFromCompatibilityProjection({
    projection: { ...projectEntityStore(input.ws.entityStore), locations },
    createdAtTurn: input.ss.turnNumber,
    previousStore: input.ws.entityStore,
  });
  const existingIds = new Set(input.ws.entityStore.records.map((record) => record.core.id));
  const mutations: EntityMutation[] = [];
  const createdRecords = desiredStore.records.filter((record) => !existingIds.has(record.core.id));
  if (createdRecords.length > 0) mutations.push({ kind: "create_entities", records: createdRecords });
  for (const location of entitiesOfKind(desiredStore, "location")) {
    if (!existingIds.has(location.core.id)) continue;
    mutations.push({ kind: "replace_location_component", locationId: location.core.id, location: location.location });
  }
  mutations.push({ kind: "set_location_unlocked", locationId: created.id, unlocked: true });

  const applied = applyEntityMutations(input.ws, mutations);
  if (!applied.ok) throw new EntityMutationInvariantError(applied);

  const nextOrdinal = input.reservedOrdinals.length === 0
    ? input.ss.evolution.nextLocationOrdinal
    : Math.max(input.ss.evolution.nextLocationOrdinal, ...input.reservedOrdinals) + 1;

  return {
    ok: true,
    worldState: { ...applied.worldState, eventLedger: input.ws.eventLedger },
    storyState: {
      ...input.ss,
      evolution: { ...input.ss.evolution, nextLocationOrdinal: nextOrdinal },
      budget: {
        ...input.ss.budget,
        locations: { ...input.ss.budget.locations, expanded: input.ss.budget.locations.expanded + 1 },
      },
    },
    drafts: [{
      eventKey: `blueprint_expanded:${created.id}`,
      episodeKey: input.episodeKey ?? "turn",
      actorIds: [PLAYER_ENTITY_ID],
      targetIds: [PLAYER_ENTITY_ID],
      locationId: input.ws.currentLocationId,
      causeKeys: [],
      factIds: [],
      questIds: [],
      outcome: "success",
      salience: 40,
      payload: { type: "blueprint_expanded", newLocationIds: [created.id], newNpcIds: [] },
    }],
  };
}
