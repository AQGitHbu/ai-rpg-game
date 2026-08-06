import {
  asEnemyId,
  asFactId,
  asItemId,
  asLocationId,
  asNpcId,
  type GameState,
  type LocationId,
  type NpcId,
  type ScenarioBlueprint
} from "@/game/domain";
import { buildNpcRuntimeEntry } from "../scenario";
import type { ApprovedBlueprintExpansion } from "./types";

// ---------------------------------------------------------------------------
// compileBlueprintExpansion：将审批通过的扩展提案编译为新蓝图与新状态（spec §4.5）。
// 纯函数：全部新对象展开构造，绝不变异输入。ID 由服务端铸造，绝不采用 AI 提供的 ID。
// ---------------------------------------------------------------------------

export type CompileBlueprintExpansionInput = {
  readonly blueprint: ScenarioBlueprint;
  readonly state: GameState;
  readonly expansion: ApprovedBlueprintExpansion;
  readonly occurredAt: string;
};

export type CompileBlueprintExpansionResult = {
  readonly nextBlueprint: ScenarioBlueprint;
  readonly nextState: GameState;
  readonly newFactId: import("@/game/domain").FactId | null;
  readonly newItemId: import("@/game/domain").ItemId | null;
  readonly newEnemyId: import("@/game/domain").EnemyId | null;
};

export function compileBlueprintExpansion(
  input: CompileBlueprintExpansionInput
): CompileBlueprintExpansionResult {
  const { blueprint, state, expansion, occurredAt } = input;

  const newLocationIds: LocationId[] = [];
  const newNpcIds: NpcId[] = [];
  const newFactIds: string[] = [];
  const newItemIds: string[] = [];
  const newEnemyIds: string[] = [];

  // 铸造新地点 ID
  let newLocationId: LocationId | null = null;
  let newLocationDef: ScenarioBlueprint["locations"][number] | null = null;
  if (expansion.newLocation !== null) {
    newLocationId = mintLocationId(blueprint);
    newLocationIds.push(newLocationId);
    const proposed = expansion.newLocation;
    newLocationDef = {
      id: newLocationId,
      name: proposed.name,
      description: proposed.description,
      kind: "main",
      connectedLocationIds: [asLocationId(proposed.connectFromLocationId)],
      npcIds: [],
      availableItemIds: [],
      tags: [],
      scale: proposed.scale
    } as ScenarioBlueprint["locations"][number];
  }

  // 铸造新 NPC ID
  let newNpcDef: ScenarioBlueprint["npcs"][number] | null = null;
  if (expansion.newNpc !== null) {
    const newNpcId = mintNpcId(blueprint);
    newNpcIds.push(newNpcId);
    const proposed = expansion.newNpc;
    const resolvedLocationId = proposed.locationId === "new:0" && newLocationId !== null
      ? newLocationId
      : asLocationId(proposed.locationId);
    newNpcDef = {
      id: newNpcId,
      name: proposed.name,
      role: proposed.role,
      description: proposed.description,
      locationId: resolvedLocationId,
      isCompanion: false,
      knownFactIds: [],
      tags: []
    } as ScenarioBlueprint["npcs"][number];
  }

  // 构造新蓝图：双向连通
  const nextLocations = blueprint.locations.map((loc) => {
    if (newLocationId !== null && String(loc.id) === expansion.newLocation!.connectFromLocationId) {
      return { ...loc, connectedLocationIds: [...loc.connectedLocationIds, newLocationId] };
    }
    return loc;
  });
  const nextBlueprintLocations = newLocationDef !== null
    ? [...nextLocations, newLocationDef]
    : nextLocations;
  const nextBlueprintNpcs = newNpcDef !== null
    ? [...blueprint.npcs, newNpcDef]
    : [...blueprint.npcs];

  const newFactId = expansion.newFact !== undefined && expansion.newFact !== null
    ? asFactId(mintResourceId(blueprint.world.facts.map((fact) => String(fact.id)), "fact_dyn"))
    : null;
  if (newFactId !== null) newFactIds.push(String(newFactId));
  const newItemId = expansion.newItem !== undefined && expansion.newItem !== null
    ? asItemId(mintResourceId(blueprint.items.map((item) => String(item.id)), "item_dyn"))
    : null;
  if (newItemId !== null) newItemIds.push(String(newItemId));
  const newEnemyId = expansion.newEnemy !== undefined && expansion.newEnemy !== null
    ? asEnemyId(mintResourceId(blueprint.enemies.map((enemy) => String(enemy.id)), "enemy_dyn"))
    : null;
  if (newEnemyId !== null) newEnemyIds.push(String(newEnemyId));

  const nextLocationsWithItems = nextBlueprintLocations.map((location) => {
    if (newItemId !== null && String(location.id) === String(state.currentLocationId)) {
      return { ...location, availableItemIds: [...location.availableItemIds, newItemId] };
    }
    return location;
  });
  const nextWorld = newFactId !== null && expansion.newFact !== undefined && expansion.newFact !== null
    ? {
        ...blueprint.world,
        facts: [...blueprint.world.facts, { id: newFactId, text: expansion.newFact.text, source: "generated" as const }]
      }
    : blueprint.world;
  const nextItems = newItemId !== null && expansion.newItem !== undefined && expansion.newItem !== null
    ? [...blueprint.items, { id: newItemId, name: expansion.newItem.name, description: expansion.newItem.description, kind: expansion.newItem.kind, tags: [...expansion.newItem.tags] }]
    : [...blueprint.items];
  const nextEnemies = newEnemyId !== null && expansion.newEnemy !== undefined && expansion.newEnemy !== null
    ? [...blueprint.enemies, { id: newEnemyId, name: expansion.newEnemy.name, tier: expansion.newEnemy.tier, stats: { ...expansion.newEnemy.stats }, locationId: asLocationId(expansion.newEnemy.locationId), tags: [] }]
    : [...blueprint.enemies];

  const nextBlueprint: ScenarioBlueprint = {
    ...blueprint,
    world: nextWorld,
    locations: nextLocationsWithItems,
    npcs: nextBlueprintNpcs,
    items: nextItems,
    enemies: nextEnemies,
  } as ScenarioBlueprint;

  // 构造新状态
  const nextUnlocked = newLocationId !== null
    ? [...state.unlockedLocationIds, newLocationId]
    : [...state.unlockedLocationIds];
  const nextNpcs = newNpcDef !== null
    ? [...state.npcs, buildNpcRuntimeEntry(newNpcDef)]
    : [...state.npcs];
  const nextWorldFacts = newFactId !== null
    ? [...state.worldFacts, { factId: newFactId, discovered: false, locationId: state.currentLocationId }]
    : [...state.worldFacts];

  const nextState: GameState = {
    ...state,
    unlockedLocationIds: nextUnlocked,
    npcs: nextNpcs,
    worldFacts: nextWorldFacts,
    eventLedger: [
      ...state.eventLedger,
      {
        type: "blueprint_expanded" as const,
        newLocationIds,
        newNpcIds,
        ...(newFactIds.length > 0 ? { newFactIds: newFactIds.map(asFactId) } : {}),
        ...(newItemIds.length > 0 ? { newItemIds: newItemIds.map(asItemId) } : {}),
        ...(newEnemyIds.length > 0 ? { newEnemyIds: newEnemyIds.map(asEnemyId) } : {}),
        occurredAt
      }
    ]
  } as GameState;

  return { nextBlueprint, nextState, newFactId, newItemId, newEnemyId };
}

function mintLocationId(blueprint: ScenarioBlueprint): LocationId {
  let max = 0;
  for (const loc of blueprint.locations) {
    const match = /^loc_dyn_(\d+)$/.exec(String(loc.id));
    if (match !== null) {
      const n = Number.parseInt(match[1], 10);
      if (n > max) max = n;
    }
  }
  return asLocationId(`loc_dyn_${max + 1}`);
}

function mintNpcId(blueprint: ScenarioBlueprint): NpcId {
  let max = 0;
  for (const npc of blueprint.npcs) {
    const match = /^npc_dyn_(\d+)$/.exec(String(npc.id));
    if (match !== null) {
      const n = Number.parseInt(match[1], 10);
      if (n > max) max = n;
    }
  }
  return asNpcId(`npc_dyn_${max + 1}`);
}

function mintResourceId(existingIds: readonly string[], prefix: "fact_dyn" | "item_dyn" | "enemy_dyn"): string {
  let max = 0;
  for (const id of existingIds) {
    const match = new RegExp(`^${prefix}_(\\d+)$`).exec(id);
    if (match !== null) max = Math.max(max, Number.parseInt(match[1], 10));
  }
  return `${prefix}_${max + 1}`;
}
