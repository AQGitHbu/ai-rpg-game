import type { GenerationMetadata, LocationId } from "../worldEntity";
import type { LocationEntry, PlayerState } from "../worldEntries";
import type { CommittedNarrativeEvent } from "../events";
import type { EntityCompatibilityProjection } from "../entity/entityProjection";
import { projectEntityStore } from "../entity/entityProjection";
import { importNpcLayers } from "../entity/npcProjection";
import type { EntityStore } from "../entity/entityStore";
import type { NpcImportedLayers } from "../entity/npcProjection";
import type { NpcId } from "../worldEntity";
import {
  createWorldStateFromProjection,
  type BattleState,
  type EndingEntry,
  type EndingState,
  type WorldState,
} from "../worldState";

// ---------------------------------------------------------------------------
// 仅供 *.test.ts / *.testutil.ts 使用的 WorldState 构造器：一次传入完整兼容投影，
// 由生产组装点编译 store 再投影，禁止在测试里 spread legacy 数组绕过 entityStore。
// 需要损坏存档的测试必须从本 helper 的返回值深拷贝后再篡改，并标注 corruption case。
// ---------------------------------------------------------------------------

export type WorldStateFixtureInput = Readonly<{
  generation: GenerationMetadata;
  projection: EntityCompatibilityProjection;
  createdAtTurn?: number;
  previousStore?: EntityStore;
  battle?: BattleState;
  endings?: readonly EndingEntry[];
  ending?: EndingState;
  eventLedger?: readonly CommittedNarrativeEvent[];
}>;

/**
 * Test-only bridge for old-shaped NPC fixtures. Production callers must supply
 * approved creation layers explicitly instead of importing legacy memory.
 */
export function npcCreationComponentsForProjection(
  projection: EntityCompatibilityProjection,
  previousStore?: EntityStore,
  createdAtTurn = 0,
): ReadonlyMap<NpcId, NpcImportedLayers> {
  const previousNpcIds = new Set(
    previousStore?.records
      .filter((record) => record.core.kind === "npc")
      .map((record) => record.core.id) ?? [],
  );
  return new Map(
    projection.npcs
      .filter((entry) => !previousNpcIds.has(entry.id))
      .map((entry) => [entry.id, importNpcLayers({ entry, createdAtTurn })] as const),
  );
}

/** 只填玩家与地点的最小投影骨架；其余实体集合为空，unlocked/visited 缺省同 createInitialWorldState。 */
export function emptyProjection(input: Readonly<{
  player: PlayerState;
  locations: readonly LocationEntry[];
  currentLocationId: LocationId;
  unlockedLocationIds?: readonly LocationId[];
  visitedLocationIds?: readonly LocationId[];
}>): EntityCompatibilityProjection {
  return {
    player: input.player,
    locations: input.locations,
    currentLocationId: input.currentLocationId,
    unlockedLocationIds: input.unlockedLocationIds ?? [input.currentLocationId],
    visitedLocationIds: input.visitedLocationIds ?? [input.currentLocationId],
    npcs: [],
    items: [],
    inventory: [],
    worldFacts: [],
    quests: [],
    enemies: [],
    defeatedEnemyIds: [],
    factions: [],
  };
}

/** 缺省值固定：createdAtTurn=0、battle={status:"idle"}、endings=[]、ending=null、eventLedger=[]。 */
export function createWorldStateFixture(input: WorldStateFixtureInput): WorldState {
  const normalizedProjection: EntityCompatibilityProjection = {
    ...input.projection,
    // Test fixtures represent newly constructed ordinary facts.  Explicit
    // investigation remains opt-in and must be stated by the fixture itself.
    worldFacts: input.projection.worldFacts.map((fact) => ({
      ...fact,
      discoveryMode: fact.discoveryMode ?? "automatic",
    })),
  };
  const npcCreationComponentsById = npcCreationComponentsForProjection(
    normalizedProjection,
    input.previousStore,
    input.createdAtTurn ?? 0,
  );
  return createWorldStateFromProjection({
    generation: input.generation,
    projection: normalizedProjection,
    createdAtTurn: input.createdAtTurn ?? 0,
    ...(input.previousStore === undefined ? {} : { previousStore: input.previousStore }),
    npcCreationComponentsById,
    battle: input.battle ?? { status: "idle" },
    endings: input.endings ?? [],
    ending: input.ending ?? null,
    eventLedger: input.eventLedger ?? [],
  });
}

// 覆盖项只能是完整数组：兼容字段与 entityStore 必须一起重建，禁止 spread 单条 legacy 数组。
export type WorldStateFixtureOverrides = Partial<EntityCompatibilityProjection> & Readonly<{
  createdAtTurn?: number;
  battle?: BattleState;
  endings?: readonly EndingEntry[];
  ending?: EndingState;
  eventLedger?: readonly CommittedNarrativeEvent[];
}>;

/** 以合法基投影 + 覆盖项合成 fixture：覆盖经同一组装点重建 store，再投影回兼容字段。 */
export function createWorldStateFixtureWith(
  input: Readonly<{ generation: GenerationMetadata; base: EntityCompatibilityProjection; previousStore?: EntityStore }>,
  overrides: WorldStateFixtureOverrides = {},
): WorldState {
  const { createdAtTurn, battle, endings, ending, eventLedger, ...projection } = overrides;
  return createWorldStateFixture({
    generation: input.generation,
    projection: { ...input.base, ...projection },
    ...(input.previousStore === undefined ? {} : { previousStore: input.previousStore }),
    ...(createdAtTurn === undefined ? {} : { createdAtTurn }),
    ...(battle === undefined ? {} : { battle }),
    ...(endings === undefined ? {} : { endings }),
    ...(ending === undefined ? {} : { ending }),
    ...(eventLedger === undefined ? {} : { eventLedger }),
  });
}

/**
 * 在已有合法 fixture 上替换完整兼容投影字段。
 * 测试不得 spread WorldState 后单改 legacy 数组；本入口会重新编译 store 并投影。
 */
export function updateWorldStateFixture(
  worldState: WorldState,
  overrides: WorldStateFixtureOverrides,
): WorldState {
  return createWorldStateFixtureWith(
    { generation: worldState.generation, base: projectEntityStore(worldState.entityStore), previousStore: worldState.entityStore },
    {
      battle: worldState.battle,
      endings: worldState.endings,
      ending: worldState.ending,
      eventLedger: worldState.eventLedger,
      ...overrides,
    },
  );
}
