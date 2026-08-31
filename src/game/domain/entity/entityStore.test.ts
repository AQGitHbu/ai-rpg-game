import { describe, expect, it } from "vitest";
import {
  asEnemyId,
  asFactId,
  asFactionId,
  asItemId,
  asLocationId,
  asNpcId,
  asPlayerEntityId,
  asQuestId,
  PLAYER_ENTITY_ID,
} from "../worldEntity";
import type { EntityLifecycle } from "./entityCore";
import type { EntityRecord, PlayerEntityRecord } from "./entityRecord";
import {
  createEntityStore,
  entitiesOfKind,
  EntityStoreInvariantError,
  getEntity,
  parseEntityStore,
  validateEntityStoreStructure,
} from "./entityStore";

// ---------------------------------------------------------------------------
// 合法 record 构造器：每个测试只篡改它要验证的那一处，避免复合失败原因。
// ---------------------------------------------------------------------------

const STATS = { hp: 20, attack: 5, defense: 3 } as const;

function playerRecord(overrides: { id?: string; lifecycle?: EntityLifecycle } = {}): EntityRecord {
  return {
    core: {
      id: asPlayerEntityId(overrides.id ?? PLAYER_ENTITY_ID),
      kind: "player_character",
      name: "沈希",
      createdAtTurn: 0,
      lifecycle: overrides.lifecycle ?? "active",
    },
    identity: { identity: "走镖人", stats: STATS },
    position: { locationId: asLocationId("loc_0"), locationOrder: 0 },
  };
}

function npcRecord(id = "npc_0", overrides: { lifecycle?: EntityLifecycle } = {}): EntityRecord {
  return {
    core: {
      id: asNpcId(id),
      kind: "npc",
      name: "老周",
      createdAtTurn: 0,
      lifecycle: overrides.lifecycle ?? "active",
    },
    identity: { role: "掌柜", description: "客栈掌柜", tags: ["shopkeep"] },
    position: { locationId: asLocationId("loc_0"), locationOrder: 0 },
    npcState: {
      isCompanion: false,
      met: false,
      memory: {
        npcId: asNpcId(id),
        knownFactIds: [],
        hiddenFactIds: [asFactId("fact_1")],
        interactionHistory: [],
        relationship: { affinity: 0 },
        emotion: "neutral",
        goals: ["守住客栈"],
      },
    },
  };
}

function locationRecord(id = "loc_0"): EntityRecord {
  return {
    core: { id: asLocationId(id), kind: "location", name: "青石镇", createdAtTurn: 0, lifecycle: "active" },
    location: {
      description: "山镇入口",
      kind: "main",
      connectedLocationIds: [asLocationId("loc_1")],
      tags: ["town"],
      unlocked: true,
      visited: true,
    },
  };
}

function itemRecord(id = "item_0", owner: "player" | "location" | "npc" | "none" = "player"): EntityRecord {
  return {
    core: { id: asItemId(id), kind: "item", name: "井钥", createdAtTurn: 2, lifecycle: "active" },
    presentation: { description: "生锈的铜钥", kind: "key", tags: [] },
    possession: {
      owner:
        owner === "player"
          ? { kind: "player", playerId: PLAYER_ENTITY_ID }
          : owner === "location"
            ? { kind: "location", locationId: asLocationId("loc_0") }
            : owner === "npc"
              ? { kind: "npc", npcId: asNpcId("npc_0") }
              : { kind: "none" },
      quantity: 1,
      ownerOrder: owner === "player" ? 0 : 1,
    },
  };
}

function enemyRecord(defeated = false): EntityRecord {
  return {
    core: {
      id: asEnemyId("enemy_0"),
      kind: "enemy",
      name: "野狼",
      createdAtTurn: 0,
      lifecycle: defeated ? "resolved" : "active",
    },
    enemy: { tier: "normal", stats: STATS, tags: [], defeated },
    position: { locationId: asLocationId("loc_0"), locationOrder: 0 },
  };
}

function factionRecord(): EntityRecord {
  return {
    core: { id: asFactionId("faction_0"), kind: "faction", name: "镖行", createdAtTurn: 0, lifecycle: "active" },
    faction: { attitudeToPlayer: 10 },
  };
}

function questRecord(status: "locked" | "active" | "completed" | "failed" | "closed" = "active"): EntityRecord {
  const lifecycle: EntityLifecycle =
    status === "locked" ? "inactive" : status === "active" ? "active" : "resolved";
  return {
    core: { id: asQuestId("quest_0"), kind: "quest", name: "查明井中事", createdAtTurn: 0, lifecycle },
    quest: {
      description: "前往青石镇调查",
      objectives: [{ kind: "visit_location", locationId: asLocationId("loc_0") }],
      onSuccess: { kind: "advance_story" },
      onFailure: { kind: "closed" },
      tags: [],
      kind: "main",
      status,
    },
  };
}

function factRecord(): EntityRecord {
  return {
    core: { id: asFactId("fact_1"), kind: "fact", name: "fact:fact_1", createdAtTurn: 0, lifecycle: "active" },
    fact: { text: "国王在深夜会见了使者", source: "generated", discovered: false },
  };
}

function fullStoreRecords(): EntityRecord[] {
  return [
    playerRecord(),
    npcRecord(),
    locationRecord(),
    locationRecord("loc_1"),
    itemRecord(),
    enemyRecord(),
    factionRecord(),
    questRecord(),
    factRecord(),
  ];
}

function issueCodesOf(value: unknown): string[] {
  return validateEntityStoreStructure(value).map((issue) => issue.code);
}

/** 深拷贝到 unknown：模拟从 SQLite JSON 读回的未信任值。 */
function untrusted<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

/** 篡改视图：core 字段可直接寻址，组件字段仍是 unknown，由各个篡改点自行窄化。 */
type TamperRecord = {
  core: { id: string; kind: string; name: string; createdAtTurn: number; lifecycle: string };
} & Record<string, unknown>;

function tamperStore(store: unknown, mutate: (records: TamperRecord[]) => void): unknown {
  const copy = untrusted(store) as { records: TamperRecord[] };
  mutate(copy.records);
  return copy;
}

// ---------------------------------------------------------------------------

describe("entity store identity 与结构", () => {
  it("accepts one record per kind with globally unique IDs", () => {
    const store = createEntityStore(fullStoreRecords());
    expect(store.version).toBe(1);
    expect(store.records).toHaveLength(9);
  });

  it("rejects a duplicate entity id across kinds in createEntityStore", () => {
    const clash = npcRecord("loc_0");
    expect(() => createEntityStore([...fullStoreRecords(), clash])).toThrowError(EntityStoreInvariantError);
    let code: string | undefined;
    try {
      createEntityStore([...fullStoreRecords(), clash]);
    } catch (error) {
      code = (error as EntityStoreInvariantError).code;
    }
    expect(code).toBe("duplicate_entity_id");
  });

  it("reports duplicate_entity_id as a structure issue without throwing", () => {
    const issues = validateEntityStoreStructure(
      untrusted({ version: 1, records: [...fullStoreRecords(), itemRecord("npc_0")] }),
    );
    expect(issues.some((issue) => issue.code === "duplicate_entity_id")).toBe(true);
  });

  it("requires npc records to carry identity + position + npcState and no foreign component", () => {
    const missing = untrusted(createEntityStore(fullStoreRecords()));
    expect(
      issueCodesOf(
        tamperStore(missing, (records) => {
          delete records[1].npcState;
        }),
      ),
    ).toContain("invalid_record_shape");

    const foreign = tamperStore(missing, (records) => {
      records[1].quest = { status: "active" };
    });
    expect(issueCodesOf(foreign)).toContain("invalid_record_shape");
  });

  it("rejects negative or fractional createdAtTurn", () => {
    const store = untrusted(createEntityStore(fullStoreRecords()));
    expect(
      issueCodesOf(
        tamperStore(store, (records) => {
          records[0].core.createdAtTurn = -1;
        }),
      ),
    ).toContain("invalid_created_turn");
    expect(
      issueCodesOf(
        tamperStore(store, (records) => {
          records[0].core.createdAtTurn = 1.5;
        }),
      ),
    ).toContain("invalid_created_turn");
  });

  it("rejects a lifecycle outside the four fixed values", () => {
    const store = untrusted(createEntityStore(fullStoreRecords()));
    expect(
      issueCodesOf(
        tamperStore(store, (records) => {
          records[0].core.lifecycle = "undeleted";
        }),
      ),
    ).toContain("invalid_lifecycle");
  });

  it("rejects a kind that disagrees with the record component shape", () => {
    const store = untrusted(createEntityStore(fullStoreRecords()));
    expect(
      issueCodesOf(
        tamperStore(store, (records) => {
          records[2].core.kind = "npc";
        }),
      ),
    ).toContain("kind_id_mismatch");
  });

  it("requires memory.npcId to equal core.id", () => {
    const store = untrusted(createEntityStore(fullStoreRecords()));
    expect(
      issueCodesOf(
        tamperStore(store, (records) => {
          (records[1].npcState as { memory: { npcId: string } }).memory.npcId = "npc_other";
        }),
      ),
    ).toContain("component_id_mismatch");
  });

  it("requires exactly one player record", () => {
    const withoutPlayer = untrusted({ version: 1, records: fullStoreRecords().filter((r) => r.core.kind !== "player_character") });
    expect(issueCodesOf(withoutPlayer)).toContain("missing_player");

    const withTwo = untrusted({ version: 1, records: [...fullStoreRecords(), playerRecord({ id: asLocationId("dup_player") })] });
    const codes = issueCodesOf(withTwo);
    expect(codes).toContain("multiple_players");
  });

  it("rejects a store version other than 1", () => {
    expect(issueCodesOf(untrusted({ version: 2, records: fullStoreRecords() }))).toContain("invalid_store_version");
  });
});

describe("entity store 读取与序列化", () => {
  it("returns entities by id and by kind in stable record order", () => {
    const store = createEntityStore(fullStoreRecords());
    expect(getEntity(store, "npc_0")?.core.name).toBe("老周");
    expect(getEntity(store, "does_not_exist")).toBeUndefined();
    expect(entitiesOfKind(store, "location").map((r) => r.core.id)).toEqual([
      asLocationId("loc_0"),
      asLocationId("loc_1"),
    ]);
    expect(entitiesOfKind(store, "fact").map((r) => r.core.id)).toEqual([asFactId("fact_1")]);
    expect(entitiesOfKind(store, "item").map((r) => r.core.id)).toEqual([asItemId("item_0")]);
  });

  it("survives a JSON round trip unchanged", () => {
    const store = createEntityStore(fullStoreRecords());
    const parsed = parseEntityStore(JSON.parse(JSON.stringify(store)) as unknown);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.store).toEqual(store);
  });

  it("keeps private fact prose out of core.name and serializes it exactly once", () => {
    const store = createEntityStore([playerRecord(), factRecord()]);
    const serialized = JSON.stringify(store);
    const [fact] = entitiesOfKind(store, "fact");
    if (fact === undefined) throw new Error("fact record missing");
    expect(fact.core.name).not.toContain(fact.fact.text);
    expect(serialized.split(fact.fact.text).length - 1).toBe(1);
  });

  it("preserves position and possession ordering across a round trip", () => {
    const store = createEntityStore([
      playerRecord(),
      npcRecord("npc_0"),
      locationRecord(),
      itemRecord("item_9", "location"),
    ]);
    const parsed = parseEntityStore(JSON.parse(JSON.stringify(store)) as unknown);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const [item] = entitiesOfKind(parsed.store, "item");
    if (item === undefined) throw new Error("item record missing");
    expect(item.possession.ownerOrder).toBe(1);
    const [npc] = entitiesOfKind(parsed.store, "npc");
    if (npc === undefined) throw new Error("npc record missing");
    expect(npc.position.locationOrder).toBe(0);
  });

  it("rejects negative or fractional locationOrder / ownerOrder", () => {
    const store = untrusted(createEntityStore(fullStoreRecords()));
    expect(
      issueCodesOf(
        tamperStore(store, (records) => {
          (records[1].position as { locationOrder: number }).locationOrder = -1;
        }),
      ),
    ).toContain("invalid_component_value");
    expect(
      issueCodesOf(
        tamperStore(store, (records) => {
          (records[4].possession as { ownerOrder: number }).ownerOrder = 0.5;
        }),
      ),
    ).toContain("invalid_component_value");
  });

  it("rejects nested value-domain errors coming from parsed JSON", () => {
    const store = untrusted(createEntityStore(fullStoreRecords()));
    expect(
      issueCodesOf(
        tamperStore(store, (records) => {
          (records[0].identity as { stats: unknown }).stats = { hp: "twenty", attack: 5, defense: 3 };
        }),
      ),
    ).toContain("invalid_component_value");
    expect(
      issueCodesOf(
        tamperStore(store, (records) => {
          (records[8].fact as { source: string }).source = "whispered";
        }),
      ),
    ).toContain("invalid_component_value");
    expect(
      issueCodesOf(
        tamperStore(store, (records) => {
          records[0].unknownComponent = { hi: true };
        }),
      ),
    ).toContain("invalid_record_shape");
  });

  it("enforces non-lossy component ranges and town identity", () => {
    const store = untrusted(createEntityStore(fullStoreRecords()));
    expect(issueCodesOf(tamperStore(store, (records) => {
      (records[4].possession as { quantity: number }).quantity = 2;
    }))).toContain("invalid_component_value");
    expect(issueCodesOf(tamperStore(store, (records) => {
      (records[1].npcState as { memory: { relationship: { affinity: number } } }).memory.relationship.affinity = 101;
    }))).toContain("invalid_component_value");
    expect(issueCodesOf(tamperStore(store, (records) => {
      records[2].location = {
        ...(records[2].location as object),
        town: { locationId: "loc_other", seed: "s", generatorVersion: "v", slots: [] },
      };
    }))).toContain("component_id_mismatch");
    expect(issueCodesOf(tamperStore(store, (records) => {
      records[2].location = {
        ...(records[2].location as object),
        town: {
          locationId: "loc_0", seed: "s", generatorVersion: "v",
          slots: [{ slotId: "s0", buildingId: "b0", buildingType: "castle", boundNpcId: null }],
        },
      };
    }))).toContain("invalid_component_value");
  });

  it("rejects quest and enemy lifecycle drift from their component state", () => {
    const store = untrusted(createEntityStore(fullStoreRecords()));
    expect(
      issueCodesOf(
        tamperStore(store, (records) => {
          records[7].core.lifecycle = "active";
          (records[7].quest as { status: string }).status = "completed";
        }),
      ),
    ).toContain("component_lifecycle_mismatch");
    expect(
      issueCodesOf(
        tamperStore(store, (records) => {
          records[5].core.lifecycle = "active";
          (records[5].enemy as { defeated: boolean }).defeated = true;
        }),
      ),
    ).toContain("component_lifecycle_mismatch");
  });

  it("parseEntityStore reports the same issues and yields no store", () => {
    const result = parseEntityStore({ version: 1, records: "not-an-array" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0]?.code).toBe("invalid_record_shape");
  });
});

describe("entity store 类型面拒绝任意 patch 与动态组件", () => {
  it("does not accept a dynamic component dictionary or a patch envelope", () => {
    const dynamic: Record<string, unknown> = { hp: 1, attack: 1, defense: 1 };
    const dynamicRecord: PlayerEntityRecord = {
      core: {
        id: PLAYER_ENTITY_ID,
        kind: "player_character",
        name: "沈希",
        createdAtTurn: 0,
        lifecycle: "active",
      },
      identity: { identity: "走镖人", stats: STATS },
      position: { locationId: asLocationId("loc_0"), locationOrder: 0 },
      // @ts-expect-error 组件必须是命名字段，EntityRecord 不接受 components 动态字典
      components: dynamic,
    };
    expect(dynamicRecord).toBeDefined();

    // @ts-expect-error Entity 不接受 {op,path,value} 形式的任意 patch
    const patch: EntityRecord = { op: "replace", path: "player.stats.hp", value: 99 };
    expect(patch).toBeDefined();

    // @ts-expect-error lifecycle 只允许四个固定值
    const badLifecycle: EntityLifecycle = "pending";
    expect(badLifecycle).toBeDefined();
  });
});
