import type {
  LocationId, NpcId, ItemId, QuestId, EnemyId, EndingId, GenerationMetadata,
} from "./worldEntity";
import type { GameEvent } from "./events";
import type { ActiveBattleCombatState } from "./combat";
import type {
  EnemyEntry, FactionEntry, EndingEntry, ItemEntry, LocationEntry, NpcEntry,
  PlayerState, QuestEntry, WorldFactEntry,
} from "./worldEntries";
import type { EntityStore } from "./entity/entityStore";
import type { NpcImportedLayers } from "./entity/npcProjection";
import {
  compileEntityStoreFromCompatibilityProjection,
  projectEntityStore,
  type EntityCompatibilityProjection,
} from "./entity/entityProjection";

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

export type BattleStartSnapshot = Readonly<{
  readonly entityStore: EntityStore;
  readonly eventLedger: readonly GameEvent[];
}>;

export type EndingState = { readonly endingId: EndingId; readonly outcome: "success" | "failure" } | null;

// ── World State ──

/** 世界存档 schema 版本唯一来源：v4 起 NPC record 携带分层组件，v3 及更早一律按不支持处理。 */
export const WORLD_STATE_SCHEMA_VERSION = 4 as const;

export type WorldState = {
  readonly version: typeof WORLD_STATE_SCHEMA_VERSION;
  readonly generation: GenerationMetadata;
  /** 唯一世界事实来源；下方集合与索引全部由 projectEntityStore 派生。 */
  readonly entityStore: EntityStore;
  // 兼容投影：生产写入禁止单独修改（必须经 entityProjection 重建）。
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
  readonly factions: readonly FactionEntry[];
  // 非实体权威字段：不进 entityStore，由规则/应用层在 store 之外维护。
  readonly battle: BattleState;
  readonly endings: readonly EndingEntry[];
  readonly ending: EndingState;
  readonly eventLedger: readonly GameEvent[];
};

/** 稳定构造错误：调用方按 code 分支，不用字符串 message 充当协议。 */
export class InitialWorldStateInvariantError extends Error {
  readonly code = "initial_item_details_required" as const;

  constructor() {
    super("初始世界状态需要完整物品条目：不允许只凭 ItemId 伪造实体");
    this.name = "InitialWorldStateInvariantError";
  }
}

// ── 构造入口 ──

/** 唯一的 WorldState 组装点：先编译 store，再由 projector 写全部兼容字段。 */
export function createWorldStateFromProjection(input: {
  readonly generation: GenerationMetadata;
  readonly projection: EntityCompatibilityProjection;
  readonly createdAtTurn?: number;
  readonly previousStore?: EntityStore;
  readonly npcCreationComponentsById?: ReadonlyMap<NpcId, NpcImportedLayers>;
  readonly battle?: BattleState;
  readonly endings?: readonly EndingEntry[];
  readonly ending?: EndingState;
  readonly eventLedger?: readonly GameEvent[];
}): WorldState {
  const entityStore = compileEntityStoreFromCompatibilityProjection({
    projection: input.projection,
    createdAtTurn: input.createdAtTurn ?? 0,
    ...(input.previousStore === undefined ? {} : { previousStore: input.previousStore }),
    ...(input.npcCreationComponentsById === undefined ? {} : { npcCreationComponentsById: input.npcCreationComponentsById }),
  });
  return {
    version: 4,
    generation: input.generation,
    entityStore,
    ...projectEntityStore(entityStore),
    battle: input.battle ?? { status: "idle" },
    endings: input.endings ?? [],
    ending: input.ending ?? null,
    eventLedger: input.eventLedger ?? [],
  };
}

export function createInitialWorldState(input: {
  generation: GenerationMetadata;
  player: PlayerState;
  startingLocation: LocationEntry;
  startingItemIds: readonly ItemId[];
}): WorldState {
  // 最小开局状态——只有玩家与起始地点两条 record；其余实体由开局编译追加。
  if (input.startingItemIds.length > 0) throw new InitialWorldStateInvariantError();
  return createWorldStateFromProjection({
    generation: input.generation,
    projection: {
      player: input.player,
      locations: [input.startingLocation],
      currentLocationId: input.startingLocation.id,
      unlockedLocationIds: [input.startingLocation.id],
      visitedLocationIds: [input.startingLocation.id],
      npcs: [],
      items: [],
      inventory: [],
      worldFacts: [],
      quests: [],
      enemies: [],
      defeatedEnemyIds: [],
      factions: [],
    },
    eventLedger: [{ type: "game_initialized", generation: input.generation }],
  });
}

// ── 只读 selector ──

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
