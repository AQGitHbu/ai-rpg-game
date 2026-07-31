import {
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
};

export function compileBlueprintExpansion(
  input: CompileBlueprintExpansionInput
): CompileBlueprintExpansionResult {
  const { blueprint, state, expansion, occurredAt } = input;

  const newLocationIds: LocationId[] = [];
  const newNpcIds: NpcId[] = [];

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

  const nextBlueprint: ScenarioBlueprint = {
    ...blueprint,
    locations: nextBlueprintLocations,
    npcs: nextBlueprintNpcs
  } as ScenarioBlueprint;

  // 构造新状态
  const nextUnlocked = newLocationId !== null
    ? [...state.unlockedLocationIds, newLocationId]
    : [...state.unlockedLocationIds];
  const nextNpcs = newNpcDef !== null
    ? [...state.npcs, buildNpcRuntimeEntry(newNpcDef)]
    : [...state.npcs];

  const nextState: GameState = {
    ...state,
    unlockedLocationIds: nextUnlocked,
    npcs: nextNpcs,
    eventLedger: [
      ...state.eventLedger,
      {
        type: "blueprint_expanded" as const,
        newLocationIds,
        newNpcIds,
        occurredAt
      }
    ]
  } as GameState;

  return { nextBlueprint, nextState };
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
