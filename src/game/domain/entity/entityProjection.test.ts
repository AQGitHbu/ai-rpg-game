import { describe, expect, it } from "vitest";
import {
  asEnemyId,
  asFactId,
  asFactionId,
  asItemId,
  asLocationId,
  asNpcId,
  asQuestId,
  PLAYER_ENTITY_ID,
} from "../worldEntity";
import type {
  EnemyEntry, FactionEntry, ItemEntry, LocationEntry, NpcEntry, PlayerState, QuestEntry,
  WorldFactEntry,
} from "../worldEntries";
import type { EntityKind } from "./entityCore";
import type { EntityRecord } from "./entityRecord";
import { entitiesOfKind, type EntityStore } from "./entityStore";
import {
  compileEntityStoreFromCompatibilityProjection,
  EntityProjectionInvariantError,
  projectEntityStore,
  validateCompatibilityProjectionInput,
  validateEntityCompatibilityProjection,
  validateEntityReferences,
  type EntityCompatibilityProjection,
} from "./entityProjection";

// ---------------------------------------------------------------------------
// legacy 兼容投影 fixture：8 类实体齐全，两名 NPC、三件物品、两条事实。
// 一律不可变改写（withLocation/withNpc…），避免 readonly 字段被就地篡改。
// ---------------------------------------------------------------------------

const PLAYER: PlayerState = { name: "沈希", identity: "走镖人", stats: { hp: 20, attack: 5, defense: 3 } };
const LOC_0 = asLocationId("loc_0");
const LOC_1 = asLocationId("loc_1");
const NPC_0 = asNpcId("npc_0");
const NPC_1 = asNpcId("npc_1");

function location(id: string, overrides: Partial<LocationEntry> = {}): LocationEntry {
  return {
    id: asLocationId(id),
    name: `地点-${id}`,
    description: "测试地点",
    kind: "main",
    connectedLocationIds: [],
    npcIds: [],
    availableItemIds: [],
    tags: ["town"],
    ...overrides,
  };
}

function npc(id: string, locationId: string, overrides: Partial<NpcEntry> = {}): NpcEntry {
  const npcId = asNpcId(id);
  return {
    id: npcId,
    name: `NPC-${id}`,
    role: "掌柜",
    description: "客栈掌柜",
    locationId: asLocationId(locationId),
    isCompanion: false,
    tags: [],
    met: true,
    memory: {
      npcId,
      knownFactIds: [asFactId("fact_1")],
      hiddenFactIds: [asFactId("fact_2")],
      interactionHistory: [],
      relationship: { affinity: 10 },
      emotion: "warm",
      goals: ["守住客栈"],
    },
    ...overrides,
  };
}

function item(id: string, overrides: Partial<ItemEntry> = {}): ItemEntry {
  return { id: asItemId(id), name: `物品-${id}`, description: "生锈的铜钥", kind: "key", tags: [], ...overrides };
}

function enemy(id: string, locationId: string, overrides: Partial<EnemyEntry> = {}): EnemyEntry {
  return {
    id: asEnemyId(id),
    name: `敌人-${id}`,
    tier: "normal",
    stats: { hp: 10, attack: 3, defense: 1 },
    locationId: asLocationId(locationId),
    tags: [],
    ...overrides,
  };
}

function quest(id: string, overrides: Partial<QuestEntry> = {}): QuestEntry {
  return {
    id: asQuestId(id),
    name: `任务-${id}`,
    description: "查明井中事",
    objectives: [{ kind: "visit_location", locationId: LOC_0 }],
    onSuccess: { kind: "advance_story" },
    onFailure: { kind: "closed" },
    tags: [],
    kind: "main",
    status: "active",
    ...overrides,
  };
}

function fact(id: string, overrides: Partial<WorldFactEntry> = {}): WorldFactEntry {
  return { factId: asFactId(id), text: `事实正文-${id}`, source: "generated", discovered: false, ...overrides };
}

const BASE_LOCATIONS: readonly LocationEntry[] = [
  location("loc_0", {
    connectedLocationIds: [LOC_1],
    npcIds: [NPC_1, NPC_0],
    availableItemIds: [asItemId("item_2")],
  }),
  location("loc_1", { connectedLocationIds: [LOC_0] }),
];

const BASE_NPCS: readonly NpcEntry[] = [npc("npc_0", "loc_0"), npc("npc_1", "loc_0")];

function baseProjection(overrides: Partial<EntityCompatibilityProjection> = {}): EntityCompatibilityProjection {
  return {
    player: PLAYER,
    locations: BASE_LOCATIONS,
    currentLocationId: LOC_0,
    unlockedLocationIds: [LOC_0, LOC_1],
    visitedLocationIds: [LOC_0],
    npcs: BASE_NPCS,
    items: [item("item_0"), item("item_1"), item("item_2")],
    inventory: [asItemId("item_1"), asItemId("item_0")],
    worldFacts: [fact("fact_1"), fact("fact_2", { locationId: LOC_1 })],
    quests: [quest("quest_0")],
    enemies: [enemy("enemy_0", "loc_1")],
    defeatedEnemyIds: [],
    factions: [{ factionId: "faction_0", name: "镖行", attitudeToPlayer: 10 }],
    ...overrides,
  };
}

/** 只留一名在场 NPC 的投影：其余测试在此基础上追加 record。 */
function singleNpcProjection(): EntityCompatibilityProjection {
  return baseProjection({
    locations: [
      location("loc_0", { connectedLocationIds: [LOC_1], npcIds: [NPC_0], availableItemIds: [asItemId("item_2")] }),
      location("loc_1", { connectedLocationIds: [LOC_0] }),
    ],
    npcs: [npc("npc_0", "loc_0")],
  });
}

function withLocation(
  projection: EntityCompatibilityProjection,
  id: string,
  overrides: Partial<LocationEntry>,
): EntityCompatibilityProjection {
  return {
    ...projection,
    locations: projection.locations.map((entry) => (entry.id === id ? { ...entry, ...overrides } : entry)),
  };
}

function compile(projection: EntityCompatibilityProjection, previousStore?: EntityStore): EntityStore {
  return compileEntityStoreFromCompatibilityProjection({ projection, createdAtTurn: 0, previousStore });
}

function codesOf(issues: readonly { code: string }[]): string[] {
  return issues.map((entry) => entry.code);
}

/** 定向篡改单条 record：引用/顺序类 issue 只能在 store 层面构造。 */
function tamperRecord(
  store: EntityStore,
  id: string,
  mutate: (record: Record<string, unknown>) => void,
): EntityStore {
  const records = store.records.map((record) => {
    if (record.core.id !== id) return record;
    const copy: unknown = JSON.parse(JSON.stringify(record));
    if (typeof copy !== "object" || copy === null) throw new Error("record is not an object");
    mutate(copy as Record<string, unknown>);
    return copy as typeof record;
  });
  return { version: 1, records };
}

function inactiveNpcRecord(id: string, order: number, createdAtTurn: number): EntityStore["records"][number] {
  return {
    core: { id: asNpcId(id), kind: "npc", name: `隐藏-${id}`, createdAtTurn, lifecycle: "inactive" },
    identity: { role: "线人", description: "暗中的线人", tags: [] },
    position: { locationId: LOC_0, locationOrder: order },
    npcState: {
      isCompanion: false,
      met: false,
      memory: { ...npc(id, "loc_0").memory, knownFactIds: [], hiddenFactIds: [], interactionHistory: [] },
    },
  };
}

function withRecords(store: EntityStore, extra: EntityStore["records"]): EntityStore {
  return { version: 1, records: [...store.records, ...extra] };
}

/** 强类型取 record：嵌套判别式不收窄联合，组件字段只能经 entitiesOfKind 读取。 */
function requireRecord<K extends EntityKind>(
  store: EntityStore,
  kind: K,
  id: string,
): Extract<EntityRecord, { core: { kind: K } }> {
  const found = entitiesOfKind(store, kind).find((record) => record.core.id === id);
  if (found === undefined) throw new Error(`record ${id} (${kind}) missing`);
  return found;
}

// ---------------------------------------------------------------------------

describe("entity 兼容投影：legacy → store → legacy", () => {
  it("compiles all eight kinds and re-projects the identical legacy shape", () => {
    const projection = baseProjection();
    const store = compile(projection);
    expect(store.records).toHaveLength(13);
    expect(store.records.filter((record) => record.core.kind === "fact").map((record) => record.core.id)).toEqual([
      asFactId("fact_1"), asFactId("fact_2"),
    ]);
    expect(projectEntityStore(store)).toEqual(projection);
  });

  it("restores npcIds, availableItemIds and inventory from orders instead of record order", () => {
    const projected = projectEntityStore(compile(baseProjection()));
    // legacy 名册里 npc_1 排在 npc_0 之前：必须按既有顺序还原，而不是 npcs 数组顺序。
    expect(projected.locations[0]?.npcIds).toEqual([NPC_1, NPC_0]);
    expect(projected.inventory).toEqual([asItemId("item_1"), asItemId("item_0")]);
    expect(projected.locations[0]?.availableItemIds).toEqual([asItemId("item_2")]);
    expect(projected.locations[1]?.availableItemIds).toEqual([]);
  });

  it("leaves items owned by npc or nobody out of every legacy container", () => {
    const projection = baseProjection();
    const store = compile(projection);
    expect(requireRecord(store, "item", asItemId("item_0")).possession.owner)
      .toEqual({ kind: "player", playerId: PLAYER_ENTITY_ID });

    // item_1 与 item_2 都离开容器：一个归 NPC，一个无主。
    const storeWithNpcItem = tamperRecord(store, asItemId("item_1"), (record) => {
      record.possession = { owner: { kind: "npc", npcId: NPC_0 }, quantity: 1, ownerOrder: 0 };
    });
    const projected = projectEntityStore(storeWithNpcItem);
    expect(projected.inventory).toEqual([asItemId("item_0")]);
    expect(projected.items.map((entry) => entry.id)).toContain(asItemId("item_1"));

    const projectionWithHiddenItem1 = baseProjection({
      inventory: [asItemId("item_0")],
    });
    expect(codesOf(validateCompatibilityProjectionInput(projectionWithHiddenItem1))).toEqual([]);
    const recompiled = compile(projectionWithHiddenItem1, storeWithNpcItem);
    expect(requireRecord(recompiled, "item", asItemId("item_1")).possession.owner)
      .toEqual({ kind: "npc", npcId: NPC_0 });
  });

  it("does not retain an entity omitted from the complete items projection", () => {
    const previous = compile(baseProjection());
    const projection = baseProjection({
      items: [item("item_0"), item("item_2")],
      inventory: [asItemId("item_0")],
    });

    const recompiled = compile(projection, previous);
    expect(entitiesOfKind(recompiled, "item").map((record) => record.core.id)).toEqual([
      asItemId("item_0"), asItemId("item_2"),
    ]);
    expect(projectEntityStore(recompiled)).toEqual(projection);
  });

  it("turns a previous visible owner into none when the item leaves every visible container", () => {
    const previous = compile(baseProjection());
    const projection = baseProjection({ inventory: [asItemId("item_1")] });
    const recompiled = compile(projection, previous);

    expect(requireRecord(recompiled, "item", asItemId("item_0")).possession).toEqual({
      owner: { kind: "none" }, quantity: 1, ownerOrder: 0,
    });
    expect(projectEntityStore(recompiled)).toEqual(projection);
  });

  it("compensates a brand-new absent item as owner none with order 0", () => {
    const projection = baseProjection();
    const store = compile(withLocation(projection, "loc_0", { availableItemIds: [] }));
    const absence = requireRecord(store, "item", asItemId("item_2")).possession;
    expect(absence.owner).toEqual({ kind: "none" });
    expect(absence.ownerOrder).toBe(0);
  });

  it("keeps inactive npcs addressable but out of every location roster", () => {
    const base = compile(singleNpcProjection());
    const store = withRecords(base, [inactiveNpcRecord("npc_9", 12, 2)]);
    const projected = projectEntityStore(store);
    expect(projected.npcs.map((entry) => entry.id)).toEqual([NPC_0, asNpcId("npc_9")]);
    expect(projected.locations[0]?.npcIds).toEqual([NPC_0]);

    const reactivated = tamperRecord(store, asNpcId("npc_9"), (record) => {
      record.core = { ...(record.core as object), lifecycle: "active" };
    });
    // 切回 active 后按 PositionComponent 重新挂载，order 12 排在既有 NPC 之后。
    expect(projectEntityStore(reactivated).locations[0]?.npcIds).toEqual([NPC_0, asNpcId("npc_9")]);
  });

  it("preserves createdAtTurn, lifecycle and hidden orders through previousStore", () => {
    const base = compile(singleNpcProjection());
    const aged = tamperRecord(base, NPC_0, (record) => {
      record.core = { ...(record.core as object), createdAtTurn: 7 };
    });
    const withHidden = withRecords(aged, [inactiveNpcRecord("npc_9", 12, 9)]);
    const roundTripped = compile(projectEntityStore(withHidden), withHidden);

    expect(requireRecord(roundTripped, "npc", NPC_0).core.createdAtTurn).toBe(7);
    const npc9 = requireRecord(roundTripped, "npc", asNpcId("npc_9"));
    expect(npc9.core.lifecycle).toBe("inactive");
    expect(npc9.position.locationOrder).toBe(12);
    expect(npc9.core.createdAtTurn).toBe(9);
    expect(projectEntityStore(roundTripped)).toEqual(projectEntityStore(withHidden));
  });

  it("uses a non-private core name for fact records", () => {
    const store = compile(baseProjection());
    const facts = entitiesOfKind(store, "fact");
    expect(facts).toHaveLength(2);
    for (const record of facts) {
      expect(record.core.name).toBe(`fact:${record.core.id}`);
      expect(record.core.name).not.toContain(record.fact.text);
    }
  });

  it("keeps the read-model faction id plain while the store id is branded", () => {
    const projection = baseProjection({
      factions: [{ factionId: "faction_0", name: "镖行", attitudeToPlayer: -3 }],
    });
    const store = compile(projection);
    const faction = store.records.find((record) => record.core.kind === "faction");
    expect(faction?.core.id).toBe(asFactionId("faction_0"));
    expect(projectEntityStore(store).factions).toEqual<FactionEntry[]>([
      { factionId: "faction_0", name: "镖行", attitudeToPlayer: -3 },
    ]);
  });
});

describe("entity 兼容投影：非法输入返回稳定 issue", () => {
  it("normalizes a legacy active NPC omitted from every location roster", () => {
    const projection = baseProjection({
      locations: BASE_LOCATIONS.map((entry) => ({ ...entry, npcIds: [] })),
    });
    const projected = projectEntityStore(compile(projection));
    expect(projected.locations[0]?.npcIds).toEqual([NPC_0, NPC_1]);
  });

  it("rejects container references to an item missing from the entity list", () => {
    const projection = baseProjection({ items: [item("item_0"), item("item_1")] });
    expect(() => compile(projection)).toThrowError(EntityProjectionInvariantError);
  });

  it("refuses to silently pick one location when an npc sits in two rosters", () => {
    const projection = withLocation(baseProjection(), "loc_1", { npcIds: [NPC_0] });
    const issues = validateCompatibilityProjectionInput(projection);
    expect(codesOf(issues)).toEqual(["npc_multiple_locations"]);
    expect(issues[0]?.entityId).toBe(NPC_0);
    expect(() => compile(projection)).toThrowError(EntityProjectionInvariantError);
  });

  it("refuses npc membership that disagrees with its own locationId", () => {
    const projection = baseProjection();
    const moved: EntityCompatibilityProjection = {
      ...withLocation(withLocation(projection, "loc_0", { npcIds: [NPC_0] }), "loc_1", { npcIds: [NPC_1] }),
      npcs: [npc("npc_0", "loc_0"), npc("npc_1", "loc_0")],
    };
    expect(codesOf(validateCompatibilityProjectionInput(moved))).toContain("npc_membership_mismatch");
  });

  it("refuses an item that is both carried and lying on the ground", () => {
    const projection = baseProjection({ inventory: [asItemId("item_1"), asItemId("item_0"), asItemId("item_2")] });
    expect(codesOf(validateCompatibilityProjectionInput(projection))).toContain("item_multiple_owners");
  });

  it("reports unknown, self and asymmetric references found on the store", () => {
    const base = compile(baseProjection());
    expect(codesOf(validateEntityReferences(tamperRecord(base, NPC_1, (record) => {
      record.position = { locationId: asLocationId("loc_x"), locationOrder: 1 };
    })))).toContain("unknown_location_ref");

    expect(codesOf(validateEntityReferences(tamperRecord(base, LOC_0, (record) => {
      record.location = { ...(record.location as object), connectedLocationIds: [LOC_0, LOC_1] };
    })))).toContain("self_connection");

    // 单向断边只能在 store 上构造：compile 会直接拒绝同一形状的非对称投影。
    expect(codesOf(validateEntityReferences(tamperRecord(base, LOC_1, (record) => {
      record.location = { ...(record.location as object), connectedLocationIds: [] };
    })))).toContain("asymmetric_connection");
    const asymmetric = withLocation(baseProjection(), "loc_1", { connectedLocationIds: [] });
    expect(() => compile(asymmetric)).toThrowError(EntityProjectionInvariantError);

    expect(codesOf(validateEntityReferences(tamperRecord(base, asQuestId("quest_0"), (record) => {
      record.quest = { ...(record.quest as object), objectives: [{ kind: "defeat_enemy", enemyId: asEnemyId("enemy_404") }] };
    })))).toContain("unknown_quest_objective_ref");

    expect(codesOf(validateEntityReferences(tamperRecord(base, NPC_0, (record) => {
      record.npcState = { ...(record.npcState as object), memory: { ...(npc("npc_0", "loc_0").memory as object), knownFactIds: [asFactId("fact_404")] } };
    })))).toContain("unknown_npc_fact_ref");

    expect(codesOf(validateEntityReferences(tamperRecord(base, asItemId("item_2"), (record) => {
      record.possession = { owner: { kind: "location", locationId: asLocationId("loc_404") }, quantity: 1, ownerOrder: 0 };
    })))).toContain("unknown_item_owner_ref");

    expect(codesOf(validateEntityReferences(tamperRecord(base, PLAYER_ENTITY_ID, (record) => {
      record.position = { locationId: asLocationId("loc_404"), locationOrder: 0 };
    })))).toContain("unknown_player_location");
  });

  it("reports duplicate orders inside the same roster or container", () => {
    const base = compile(baseProjection());
    // loc_0 名册为 [npc_1, npc_0]：把 npc_1 改成 order 1 才与 npc_0 冲突。
    expect(codesOf(validateEntityReferences(tamperRecord(base, NPC_1, (record) => {
      record.position = { locationId: LOC_0, locationOrder: 1 };
    })))).toContain("duplicate_location_order");

    expect(codesOf(validateEntityReferences(tamperRecord(base, asItemId("item_0"), (record) => {
      record.possession = { owner: { kind: "player", playerId: PLAYER_ENTITY_ID }, quantity: 1, ownerOrder: 0 };
    })))).toContain("duplicate_owner_order");
  });

  it("flags a hand-tampered compatibility projection", () => {
    const store = compile(baseProjection());
    const tampered: EntityCompatibilityProjection = { ...baseProjection(), visitedLocationIds: [LOC_0, LOC_1] };
    const issues = validateEntityCompatibilityProjection(store, tampered);
    expect(codesOf(issues)).toContain("projection_mismatch");
    expect(issues[0]?.field).toContain("visitedLocationIds");

    // 容器引用了没有 ItemEntry 的 ID：编译边界直接拒绝，不再产出漂移 store。
    const phantom = baseProjection({
      inventory: [asItemId("item_1"), asItemId("item_0"), asItemId("item_404")],
    });
    expect(() => compile(phantom)).toThrowError(EntityProjectionInvariantError);
    const phantomIssues = validateEntityCompatibilityProjection(store, phantom);
    expect(codesOf(phantomIssues)).toEqual(["projection_mismatch"]);
    expect(phantomIssues[0]?.field).toContain("inventory");
  });

  it("throws an error carrying only code and entityId", () => {
    const projection = withLocation(baseProjection(), "loc_1", { npcIds: [NPC_0] });
    let thrown: unknown;
    try {
      compile(projection);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(EntityProjectionInvariantError);
    const error = thrown as EntityProjectionInvariantError;
    expect(error.code).toBe("npc_multiple_locations");
    expect(error.entityId).toBe(NPC_0);
    // 只带 code/entityId：不携带 issue 列表或投影副本，避免日志泄露剧情正文。
    expect(Object.keys(error).sort()).toEqual(["code", "entityId", "name"]);
  });
});
