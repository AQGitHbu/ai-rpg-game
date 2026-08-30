import type {
  LocationId, NpcId, ItemId, QuestId, EnemyId, EndingId, GenerationMetadata,
} from "./worldEntity";
import type { GameEvent } from "./events";
import type { ActiveBattleCombatState } from "./combat";
import type {
  EnemyEntry, FactionEntry, EndingEntry, ItemEntry, LocationEntry, NpcEntry,
  PlayerState, QuestEntry, WorldFactEntry,
} from "./worldEntries";

// entry/value 类型住在 worldEntries.ts（entity/** 复用它们而不与 WorldState 循环依赖）；
// 这里继续 re-export，调用方的 `@/game/domain/worldState` import 保持不变。
export type {
  PlayerState, LocationEntry, NpcMemory, NpcInteraction, NpcEntry, ItemEntry,
  InvestigationApproach, WorldFactEntry, QuestObjective, QuestOutcome, QuestEntry,
  EnemyEntry, EndingEntry, EndingRequirement, FactionEntry,
} from "./worldEntries";

// ── 非实体运行时状态 ──

export type BattleState =
  | { readonly status: "idle" }
  | ({ readonly status: "active"; readonly enemyId: EnemyId; readonly enemyIds?: readonly EnemyId[]; readonly playerHp: number; readonly enemyHp: number; readonly round: number; readonly battleKey?: string; readonly preBattleSnapshot?: BattleStartSnapshot }
    & Partial<ActiveBattleCombatState>)
  | { readonly status: "resolved"; readonly enemyId: EnemyId; readonly outcome: "victory" | "defeat" | "withdraw"; readonly battleKey?: string };

export type BattleStartSnapshot = {
  readonly playerStats: PlayerState["stats"];
  readonly defeatedEnemyIds: readonly EnemyId[];
  readonly eventLedger: readonly GameEvent[];
};

export type EndingState = { readonly endingId: EndingId; readonly outcome: "success" | "failure" } | null;

// ── World State ──

export type WorldState = {
  readonly version: 2;
  readonly generation: GenerationMetadata;
  readonly player: PlayerState;
  readonly locations: readonly LocationEntry[];
  readonly currentLocationId: LocationId;
  readonly unlockedLocationIds: readonly LocationId[];
  readonly visitedLocationIds: readonly LocationId[];
  readonly npcs: readonly NpcEntry[];
  readonly items: readonly ItemEntry[];
  readonly inventory: readonly ItemId[];
  readonly worldFacts: readonly WorldFactEntry[];
  readonly quests: readonly QuestEntry[];
  readonly enemies: readonly EnemyEntry[];
  readonly defeatedEnemyIds: readonly EnemyId[];
  readonly battle: BattleState;
  readonly endings: readonly EndingEntry[];
  readonly ending: EndingState;
  readonly factions: readonly FactionEntry[];
  readonly eventLedger: readonly GameEvent[];
};

// ── 纯函数 ──

export function findLocation(ws: WorldState, id: LocationId): LocationEntry | undefined {
  return ws.locations.find((l) => l.id === id);
}

/**
 * 判断地点是否可以作为地图移动目标。
 *
 * 未到访地点仍必须沿当前地点的相邻边进入；已解锁且已经到访的地点
 * 则允许从地图直接回访，避免玩家回到上游地点后被迫沿剧情链逐段折返。
 * 这是地图投影、choice map 和规则校验共用的旅行边界。
 */
export function isTravelTarget(ws: WorldState, locationId: LocationId): boolean {
  if (
    findLocation(ws, locationId) === undefined
    || locationId === ws.currentLocationId
    || !ws.unlockedLocationIds.includes(locationId)
  ) return false;
  if (ws.visitedLocationIds.includes(locationId)) return true;
  return findLocation(ws, ws.currentLocationId)?.connectedLocationIds.includes(locationId) ?? false;
}

export function findNpc(ws: WorldState, id: NpcId): NpcEntry | undefined {
  return ws.npcs.find((n) => n.id === id);
}

export function findItem(ws: WorldState, id: ItemId): ItemEntry | undefined {
  return ws.items.find((i) => i.id === id);
}

export function findQuest(ws: WorldState, id: QuestId): QuestEntry | undefined {
  return ws.quests.find((q) => q.id === id);
}

export function appendLocation(ws: WorldState, loc: LocationEntry): WorldState {
  return { ...ws, locations: [...ws.locations, loc] };
}

export function appendNpc(ws: WorldState, npc: NpcEntry): WorldState {
  return { ...ws, npcs: [...ws.npcs, npc] };
}

export function appendItem(ws: WorldState, item: ItemEntry): WorldState {
  return { ...ws, items: [...ws.items, item] };
}

export function appendEnemy(ws: WorldState, enemy: EnemyEntry): WorldState {
  return { ...ws, enemies: [...ws.enemies, enemy] };
}

export function createInitialWorldState(input: {
  generation: GenerationMetadata;
  player: PlayerState;
  startingLocation: LocationEntry;
  startingItemIds: readonly ItemId[];
}): WorldState {
  // 最小初始状态——实际开局实体由 createGame 通过 AI 生成后追加填充
  return {
    version: 2,
    generation: input.generation,
    player: input.player,
    locations: [input.startingLocation],
    currentLocationId: input.startingLocation.id,
    unlockedLocationIds: [input.startingLocation.id],
    visitedLocationIds: [input.startingLocation.id],
    npcs: [],
    items: [],
    inventory: [...input.startingItemIds],
    worldFacts: [],
    quests: [],
    enemies: [],
    defeatedEnemyIds: [],
    battle: { status: "idle" },
    endings: [],
    ending: null,
    factions: [],
    eventLedger: [{
      type: "game_initialized",
      generation: input.generation,
    }],
  };
}
