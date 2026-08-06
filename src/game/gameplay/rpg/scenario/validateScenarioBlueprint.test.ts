import { describe, expect, it } from "vitest";
import { createBudgetPolicy, type ScenarioBlueprintCandidate } from "@/game/domain";
import {
  PHASE1_NUMERIC_RANGES,
  validateScenarioBlueprintCandidate,
  type ScenarioBlueprintIssue
} from "./validateScenarioBlueprint";
import { TEST_POLICY, TEST_PROFILE, makeValidCandidate } from "./scenarioBlueprintFixture.testutil";

// ---------------------------------------------------------------------------
// 测试内可变异视图：候选类型全 readonly，变异测试通过 DeepWritable 草稿修改。
// ---------------------------------------------------------------------------

type DeepWritable<T> = T extends readonly (infer E)[]
  ? DeepWritable<E>[]
  : T extends object
    ? { -readonly [K in keyof T]: DeepWritable<T[K]> }
    : T;

type Draft = DeepWritable<ScenarioBlueprintCandidate>;

function draft(): Draft {
  return makeValidCandidate() as unknown as Draft;
}

/** Phase 14：默认用 runtime_expansion 阶段校验，使多幕/多结局的 fixture 通过。 */
function validate(candidate: ScenarioBlueprintCandidate) {
  return validateScenarioBlueprintCandidate(candidate, { profile: TEST_PROFILE, policy: TEST_POLICY, phase: "runtime_expansion" });
}

function issuesOf(candidate: Draft | ScenarioBlueprintCandidate): readonly ScenarioBlueprintIssue[] {
  const result = validate(candidate as ScenarioBlueprintCandidate);
  return result.ok ? [] : result.issues;
}

function codesOf(issues: readonly ScenarioBlueprintIssue[]): string[] {
  return issues.map((issue) => issue.code);
}

// ---------------------------------------------------------------------------
// 合法候选
// ---------------------------------------------------------------------------

describe("validateScenarioBlueprintCandidate：合法候选", () => {
  it("满足全部规则的候选通过校验并原样返回", () => {
    const candidate = makeValidCandidate();
    const result = validate(candidate);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.validated).toEqual(makeValidCandidate());
  });

  it("是纯函数：不修改候选", () => {
    const candidate = makeValidCandidate();
    validate(candidate);
    expect(candidate).toEqual(makeValidCandidate());
  });

  it("失败结果不携带 validated 字段", () => {
    const bad = draft();
    bad.seed = " ";
    const result = validate(bad as ScenarioBlueprintCandidate);
    expect(result.ok).toBe(false);
    expect("validated" in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 1. schema 基础
// ---------------------------------------------------------------------------

describe("validateScenarioBlueprintCandidate：schema 基础", () => {
  it("schemaVersion 不是 1 或 2 时拒绝", () => {
    const candidate = draft();
    (candidate as { schemaVersion: number }).schemaVersion = 3;
    expect(issuesOf(candidate)).toContainEqual({
      path: "schemaVersion",
      code: "INVALID_SCHEMA_VERSION",
      params: { expected: "1|2", actual: "3" }
    });
  });

  const requiredFields = ["generationId", "seed", "templateVersion", "inputDigest"] as const;
  for (const field of requiredFields) {
    it(`${field} 为空白时拒绝`, () => {
      const candidate = draft();
      candidate[field] = "  ";
      expect(issuesOf(candidate)).toContainEqual({
        path: field,
        code: "REQUIRED",
        params: {}
      });
    });
  }

  it("gameType 与注入的 profile 不一致时拒绝", () => {
    const candidate = draft();
    candidate.gameType = "fantasy";
    expect(issuesOf(candidate)).toContainEqual({
      path: "gameType",
      code: "GAME_TYPE_MISMATCH",
      params: { expected: "wuxia", actual: "fantasy" }
    });
  });

  it("候选自带的 budgetPolicy 与派生 policy 不符时拒绝", () => {
    const candidate = draft();
    candidate.budgetPolicy = { ...candidate.budgetPolicy!, mainActs: 99 };
    expect(issuesOf(candidate)).toContainEqual({
      path: "budgetPolicy",
      code: "BUDGET_POLICY_MISMATCH",
      params: {}
    });
  });
});

// ---------------------------------------------------------------------------
// 2. 内容预算数量（主线/支线/结局数量由任务图校验覆盖）
// ---------------------------------------------------------------------------

describe("validateScenarioBlueprintCandidate：内容预算", () => {
  it("主要地点少于 3 个时拒绝（同时检出隐藏地点超额）", () => {
    const candidate = draft();
    candidate.locations[2].kind = "hidden";
    candidate.locations[3].kind = "hidden";
    const issues = issuesOf(candidate);
    expect(issues).toContainEqual({
      path: "locations",
      code: "MAIN_LOCATION_COUNT_OUT_OF_RANGE",
      params: { min: 3, max: 5, actual: 2 }
    });
    expect(issues).toContainEqual({
      path: "locations",
      code: "HIDDEN_LOCATION_OVERBUDGET",
      params: { max: 1, actual: 3 }
    });
  });

  it("核心 NPC 超过 6 名时拒绝", () => {
    const candidate = draft();
    for (const n of ["npc_e", "npc_f", "npc_g"]) {
      candidate.npcs.push({ ...candidate.npcs[1], id: n, name: `路人${n}` });
    }
    expect(issuesOf(candidate)).toContainEqual({
      path: "npcs",
      code: "CORE_NPC_COUNT_OUT_OF_RANGE",
      params: { min: 4, max: 6, actual: 7 }
    });
  });

  it("核心 NPC 少于 4 名时拒绝", () => {
    const candidate = draft();
    candidate.npcs.pop();
    expect(codesOf(issuesOf(candidate))).toContain("CORE_NPC_COUNT_OUT_OF_RANGE");
  });

  it("同伴超过 1 名时拒绝", () => {
    const candidate = draft();
    candidate.npcs[1].isCompanion = true;
    expect(issuesOf(candidate)).toContainEqual({
      path: "npcs",
      code: "COMPANION_OVERBUDGET",
      params: { max: 1, actual: 2 }
    });
  });
});

describe("validateScenarioBlueprintCandidate：主线语义密度", () => {
  it("拒绝多个主线阶段复用同一非空描述", () => {
    const candidate = draft();
    candidate.quests[1].description = candidate.quests[0].description;
    expect(issuesOf(candidate)).toContainEqual({
      path: "quests[1].description",
      code: "REPEATED_MAIN_QUEST_DESCRIPTION",
      params: { firstStage: 1, stage: 2 },
    });
  });

  it("允许空描述继续由既有必填/图校验处理", () => {
    const candidate = draft();
    candidate.quests[1].description = "";
    expect(codesOf(issuesOf(candidate))).not.toContain("REPEATED_MAIN_QUEST_DESCRIPTION");
  });

  it("拒绝只改变幕号、仍重复语义尾句的主线描述", () => {
    const candidate = draft();
    candidate.quests.filter((quest) => quest.kind === "main").slice(1, 4).forEach((quest) => {
      quest.description = `第 ${quest.stage} 幕：完成当前目标。深入山庄求证并取回关键信物。`;
    });
    expect(codesOf(issuesOf(candidate))).toContain("REPEATED_MAIN_QUEST_DESCRIPTION_FRAGMENT");
  });
});

describe("validateScenarioBlueprintCandidate：生成事实可达性", () => {
  it("拒绝没有规则锚点或已知 NPC 的生成事实", () => {
    const candidate = draft();
    candidate.world.facts.push({ id: "fact_orphan", text: "无人可知的真相", source: "generated" });
    expect(issuesOf(candidate)).toContainEqual(expect.objectContaining({
      code: "UNANCHORED_GENERATED_FACT",
      params: { factId: "fact_orphan" },
    }));
  });

  it("中长线必须把生成事实放进至少一个主线 discover_fact 目标", () => {
    const candidate = draft();
    candidate.budgetPolicy = createBudgetPolicy("medium");
    const result = validateScenarioBlueprintCandidate(candidate as ScenarioBlueprintCandidate, {
      profile: TEST_PROFILE,
      policy: createBudgetPolicy("medium"),
      phase: "runtime_expansion",
    });
    expect(result.ok ? [] : result.issues).toContainEqual(expect.objectContaining({
      code: "MAINLINE_GENERATED_FACT_MISSING",
      params: { factId: "fact_b" },
    }));
  });
});

// ---------------------------------------------------------------------------
// 3. 全局 ID 唯一
// ---------------------------------------------------------------------------

describe("validateScenarioBlueprintCandidate：全局 ID 唯一", () => {
  it("不同实体种类共用 ID 时拒绝（地点与敌人）", () => {
    const candidate = draft();
    candidate.enemies[0].id = "loc_a";
    expect(issuesOf(candidate)).toContainEqual({
      path: "enemies[0].id",
      code: "DUPLICATE_GLOBAL_ID",
      params: { id: "loc_a", kind: "enemy", firstKind: "location" }
    });
  });

  it("开场场景 ID 与其他实体重复时拒绝", () => {
    const candidate = draft();
    candidate.openingScene.id = "fact_a";
    expect(issuesOf(candidate)).toContainEqual({
      path: "openingScene.id",
      code: "DUPLICATE_GLOBAL_ID",
      params: { id: "fact_a", kind: "scene", firstKind: "fact" }
    });
  });
});

// ---------------------------------------------------------------------------
// 4. 引用完整（任务 objective/outcome 由任务图校验覆盖）
// ---------------------------------------------------------------------------

describe("validateScenarioBlueprintCandidate：引用完整", () => {
  const cases: { name: string; mutate: (candidate: Draft) => void; path: string; refKind: string }[] = [
    {
      name: "地点连接指向不存在的地点",
      mutate: (c) => { c.locations[0].connectedLocationIds[0] = "ghost"; },
      path: "locations[0].connectedLocationIds[0]",
      refKind: "location"
    },
    {
      name: "地点 npcIds 指向不存在的 NPC",
      mutate: (c) => { c.locations[0].npcIds[0] = "ghost"; },
      path: "locations[0].npcIds[0]",
      refKind: "npc"
    },
    {
      name: "NPC 所在地点不存在",
      mutate: (c) => { c.npcs[1].locationId = "ghost"; },
      path: "npcs[1].locationId",
      refKind: "location"
    },
    {
      name: "NPC knownFactIds 指向不存在的事实",
      mutate: (c) => { c.npcs[0].knownFactIds[0] = "ghost"; },
      path: "npcs[0].knownFactIds[0]",
      refKind: "fact"
    },
    {
      name: "结局要求指向不存在的任务",
      mutate: (c) => { (c.endings[0].requirements[0] as { questId: string }).questId = "ghost"; },
      path: "endings[0].requirements[0].questId",
      refKind: "quest"
    },
    {
      name: "结局要求 quest_failed 指向不存在的任务",
      mutate: (c) => { (c.endings[1].requirements[0] as { questId: string }).questId = "ghost"; },
      path: "endings[1].requirements[0].questId",
      refKind: "quest"
    },
    {
      name: "敌人预置地点不存在",
      mutate: (c) => { c.enemies[0].locationId = "ghost"; },
      path: "enemies[0].locationId",
      refKind: "location"
    },
    {
      name: "玩家起始地点不存在",
      mutate: (c) => { c.player.startingLocationId = "ghost"; },
      path: "player.startingLocationId",
      refKind: "location"
    },
    {
      name: "玩家初始物品不存在",
      mutate: (c) => { c.player.startingItemIds[0] = "ghost"; },
      path: "player.startingItemIds[0]",
      refKind: "item"
    }
  ];

  for (const { name, mutate, path, refKind } of cases) {
    it(`拒绝：${name}`, () => {
      const candidate = draft();
      mutate(candidate);
      expect(issuesOf(candidate)).toContainEqual({
        path,
        code: "DANGLING_REFERENCE",
        params: { refKind, id: "ghost" }
      });
    });
  }
});

// ---------------------------------------------------------------------------
// 4a. 地点可取得物品（Phase 5：availableItemIds）
// ---------------------------------------------------------------------------

describe("validateScenarioBlueprintCandidate：地点可取得物品", () => {
  it("合法候选中 availableItemIds 引用存在且唯一，校验通过", () => {
    const candidate = makeValidCandidate();
    expect(candidate.locations.some((entry) => entry.availableItemIds.length > 0)).toBe(true);
    expect(validate(candidate).ok).toBe(true);
  });

  it("拒绝：availableItemIds 指向不存在的物品", () => {
    const candidate = draft();
    candidate.locations[2].availableItemIds = ["ghost"];
    expect(issuesOf(candidate)).toContainEqual({
      path: "locations[2].availableItemIds[0]",
      code: "DANGLING_REFERENCE",
      params: { refKind: "item", id: "ghost" }
    });
  });

  it("拒绝：同一物品出现在多个地点（首次出现的地点回填在 params）", () => {
    const candidate = draft();
    // 合法 fixture 中 item_b 已在 loc_c（locations[2]）；再挂到 loc_b（locations[1]）。
    candidate.locations[1].availableItemIds = ["item_b"];
    expect(issuesOf(candidate)).toContainEqual({
      path: "locations[2].availableItemIds[0]",
      code: "DUPLICATE_AVAILABLE_ITEM",
      params: { itemId: "item_b", firstLocationId: "loc_b" }
    });
  });

  it("拒绝：同一地点内重复列出同一物品", () => {
    const candidate = draft();
    candidate.locations[2].availableItemIds = ["item_b", "item_b"];
    expect(issuesOf(candidate)).toContainEqual({
      path: "locations[2].availableItemIds[1]",
      code: "DUPLICATE_AVAILABLE_ITEM",
      params: { itemId: "item_b", firstLocationId: "loc_c" }
    });
  });

  it("拒绝：玩家初始物品同时被列为地点可取得物品", () => {
    const candidate = draft();
    candidate.locations[0].availableItemIds = ["item_a"];
    expect(issuesOf(candidate)).toContainEqual({
      path: "locations[0].availableItemIds[0]",
      code: "STARTING_ITEM_AVAILABLE_AT_LOCATION",
      params: { itemId: "item_a" }
    });
  });

  it("collect-all：悬空引用、多地点重复与初始物品冲突一次性全部检出", () => {
    const candidate = draft();
    candidate.locations[0].availableItemIds = ["item_a"]; // 初始物品冲突
    candidate.locations[1].availableItemIds = ["item_b", "ghost"]; // item_b 与 loc_c 重复 + 悬空
    const codes = codesOf(issuesOf(candidate));
    expect(codes).toContain("STARTING_ITEM_AVAILABLE_AT_LOCATION");
    expect(codes).toContain("DUPLICATE_AVAILABLE_ITEM");
    expect(codes).toContain("DANGLING_REFERENCE");
  });
});

// ---------------------------------------------------------------------------
// 4b. 结局要求合法性（闭合 kind 联合 + 载荷 id 防御）
// ---------------------------------------------------------------------------

describe("validateScenarioBlueprintCandidate：结局要求合法性", () => {
  it("未知的 requirement kind 拒绝", () => {
    const candidate = draft();
    (candidate.endings[0].requirements[0] as { kind: string }).kind = "bogus";
    expect(issuesOf(candidate)).toContainEqual({
      path: "endings[0].requirements[0]",
      code: "INVALID_ENDING_REQUIREMENT",
      params: { kind: "bogus" }
    });
  });

  it("quest_completed 缺少 questId 时拒绝（不落入悬空引用检查）", () => {
    const candidate = draft();
    delete (candidate.endings[0].requirements[0] as { questId?: string }).questId;
    const issues = issuesOf(candidate);
    expect(issues).toContainEqual({
      path: "endings[0].requirements[0]",
      code: "INVALID_ENDING_REQUIREMENT",
      params: { kind: "quest_completed", reason: "missing_quest_id" }
    });
    expect(issues.filter((issue) => issue.code === "DANGLING_REFERENCE")).toEqual([]);
  });

  it("quest_failed 缺少 questId 时拒绝（不落入悬空引用检查）", () => {
    const candidate = draft();
    delete (candidate.endings[1].requirements[0] as { questId?: string }).questId;
    const issues = issuesOf(candidate);
    expect(issues).toContainEqual({
      path: "endings[1].requirements[0]",
      code: "INVALID_ENDING_REQUIREMENT",
      params: { kind: "quest_failed", reason: "missing_quest_id" }
    });
    expect(issues.filter((issue) => issue.code === "DANGLING_REFERENCE")).toEqual([]);
  });

  it("fact_discovered 的 factId 非字符串时拒绝（不落入悬空引用检查）", () => {
    const candidate = draft();
    // 构造一个 fact_discovered requirement 来测试 factId 非字符串。
    (candidate.endings[0].requirements[0] as { kind: string; factId?: unknown }).kind = "fact_discovered";
    (candidate.endings[0].requirements[0] as { factId?: unknown }).factId = 42;
    const issues = issuesOf(candidate);
    expect(issues).toContainEqual({
      path: "endings[0].requirements[0]",
      code: "INVALID_ENDING_REQUIREMENT",
      params: { kind: "fact_discovered", reason: "missing_fact_id" }
    });
    expect(issues.filter((issue) => issue.code === "DANGLING_REFERENCE")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. 开场场景
// ---------------------------------------------------------------------------

describe("validateScenarioBlueprintCandidate：开场场景", () => {
  it("开场地点是隐藏地点时拒绝", () => {
    const candidate = draft();
    candidate.openingScene.locationId = "loc_h";
    expect(issuesOf(candidate)).toContainEqual({
      path: "openingScene.locationId",
      code: "OPENING_SCENE_HIDDEN_LOCATION",
      params: { locationId: "loc_h" }
    });
  });

  it("开场地点不存在时拒绝", () => {
    const candidate = draft();
    candidate.openingScene.locationId = "ghost";
    expect(issuesOf(candidate)).toContainEqual({
      path: "openingScene.locationId",
      code: "DANGLING_REFERENCE",
      params: { refKind: "location", id: "ghost" }
    });
  });

  it("在场 NPC 不存在时拒绝", () => {
    const candidate = draft();
    candidate.openingScene.presentNpcIds[0] = "ghost";
    expect(issuesOf(candidate)).toContainEqual({
      path: "openingScene.presentNpcIds[0]",
      code: "DANGLING_REFERENCE",
      params: { refKind: "npc", id: "ghost" }
    });
  });

  it("在场 NPC 不在开场地点时拒绝", () => {
    const candidate = draft();
    candidate.openingScene.presentNpcIds[0] = "npc_b";
    expect(issuesOf(candidate)).toContainEqual({
      path: "openingScene.presentNpcIds[0]",
      code: "OPENING_NPC_NOT_AT_LOCATION",
      params: { npcId: "npc_b", npcLocationId: "loc_b", sceneLocationId: "loc_a" }
    });
  });
});

// ---------------------------------------------------------------------------
// 5b. 开场场景可调查事实 (Phase 3)
// ---------------------------------------------------------------------------

describe("validateScenarioBlueprintCandidate：开场可调查事实", () => {
  it("开场可调查事实为空时拒绝", () => {
    const candidate = draft();
    candidate.openingScene.investigableFactIds = [];
    expect(issuesOf(candidate)).toContainEqual({
      path: "openingScene.investigableFactIds",
      code: "OPENING_SCENE_NO_INVESTIGABLE_FACTS",
      params: {}
    });
  });

  it("开场可调查事实引用不存在的事实时拒绝", () => {
    const candidate = draft();
    candidate.openingScene.investigableFactIds = ["ghost_fact"];
    expect(issuesOf(candidate)).toContainEqual({
      path: "openingScene.investigableFactIds[0]",
      code: "DANGLING_REFERENCE",
      params: { refKind: "fact", id: "ghost_fact" }
    });
  });

  it("开场可调查事实有重复 ID 时拒绝", () => {
    const candidate = draft();
    candidate.openingScene.investigableFactIds = ["fact_b", "fact_b"];
    expect(issuesOf(candidate)).toContainEqual({
      path: "openingScene.investigableFactIds[1]",
      code: "DUPLICATE_INVESTIGABLE_FACT",
      params: { factId: "fact_b", firstIndex: 0 }
    });
  });

  it("合法的可调查事实通过校验", () => {
    const candidate = draft();
    candidate.openingScene.investigableFactIds = ["fact_b"];
    const result = validate(candidate as ScenarioBlueprintCandidate);
    expect(result.ok).toBe(true);
  });

  it("多个不同可调查事实通过校验", () => {
    const candidate = draft();
    candidate.openingScene.investigableFactIds = ["fact_a", "fact_b"];
    const result = validate(candidate as ScenarioBlueprintCandidate);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. 任务图问题直接并入（复用 questGraph，不另行包装）
// ---------------------------------------------------------------------------

describe("validateScenarioBlueprintCandidate：任务图问题并入", () => {
  it("结局不可达时并入 UNREACHABLE_ENDING", () => {
    const candidate = draft();
    candidate.quests[2].onFailure = { kind: "closed" };
    expect(issuesOf(candidate)).toContainEqual({
      path: "endings[1]",
      code: "UNREACHABLE_ENDING",
      params: { endingId: "e2" }
    });
  });

  it("objective 指向未知实体时并入 UNKNOWN_OBJECTIVE_TARGET", () => {
    const candidate = draft();
    (candidate.quests[3].objectives[0] as { factId: string }).factId = "ghost";
    expect(issuesOf(candidate)).toContainEqual({
      path: "quests[3].objectives[0]",
      code: "UNKNOWN_OBJECTIVE_TARGET",
      params: { kind: "discover_fact", targetId: "ghost" }
    });
  });

  it("objective 指向静态隐藏地点时拒绝不可达目标", () => {
    const candidate = draft();
    candidate.locations[1].kind = "hidden";
    expect(issuesOf(candidate)).toContainEqual({
      path: "quests[0].objectives[0]",
      code: "HIDDEN_LOCATION_OBJECTIVE_UNREACHABLE",
      params: { kind: "visit_location", targetId: "loc_b", locationId: "loc_b" }
    });
  });

  it("缺少主线阶段时并入 MISSING_MAIN_STAGE", () => {
    const candidate = draft();
    candidate.quests.splice(2, 1);
    candidate.quests[1].onSuccess = { kind: "reach_ending", endingId: "e1" };
    candidate.quests[1].onFailure = { kind: "reach_ending", endingId: "e2" };
    expect(codesOf(issuesOf(candidate))).toContain("MISSING_MAIN_STAGE");
  });
});

// ---------------------------------------------------------------------------
// 8. 数值范围（Phase 1 catalog）
// ---------------------------------------------------------------------------

describe("validateScenarioBlueprintCandidate：数值范围", () => {
  it("敌人 hp 低于下限时拒绝", () => {
    const candidate = draft();
    candidate.enemies[0].stats.hp = PHASE1_NUMERIC_RANGES.enemyHp.min - 1;
    expect(issuesOf(candidate)).toContainEqual({
      path: "enemies[0].stats.hp",
      code: "OUT_OF_RANGE",
      params: {
        min: PHASE1_NUMERIC_RANGES.enemyHp.min,
        max: PHASE1_NUMERIC_RANGES.enemyHp.max,
        value: PHASE1_NUMERIC_RANGES.enemyHp.min - 1
      }
    });
  });

  it("敌人攻击高于上限时拒绝", () => {
    const candidate = draft();
    candidate.enemies[1].stats.attack = PHASE1_NUMERIC_RANGES.enemyAttack.max + 1;
    expect(codesOf(issuesOf(candidate))).toContain("OUT_OF_RANGE");
  });

  it("玩家基础属性低于下限时拒绝", () => {
    const candidate = draft();
    candidate.player.baseStats.defense = PHASE1_NUMERIC_RANGES.playerDefense.min - 1;
    expect(issuesOf(candidate)).toContainEqual({
      path: "player.baseStats.defense",
      code: "OUT_OF_RANGE",
      params: {
        min: PHASE1_NUMERIC_RANGES.playerDefense.min,
        max: PHASE1_NUMERIC_RANGES.playerDefense.max,
        value: PHASE1_NUMERIC_RANGES.playerDefense.min - 1
      }
    });
  });

  it("非整数数值拒绝", () => {
    const candidate = draft();
    candidate.player.baseStats.hp = 10.5;
    expect(codesOf(issuesOf(candidate))).toContain("OUT_OF_RANGE");
  });
});

// ---------------------------------------------------------------------------
// 9. profile 禁止标签
// ---------------------------------------------------------------------------

describe("validateScenarioBlueprintCandidate：禁止标签", () => {
  it("NPC tags 含禁止标签时拒绝", () => {
    const candidate = draft();
    candidate.npcs[0].tags.push("科技");
    expect(issuesOf(candidate)).toContainEqual({
      path: "npcs[0].tags[0]",
      code: "FORBIDDEN_TAG",
      params: { tag: "科技" }
    });
  });

  it("world tags 含禁止标签时拒绝", () => {
    const candidate = draft();
    candidate.world.tags.push("枪械");
    expect(issuesOf(candidate)).toContainEqual({
      path: "world.tags[1]",
      code: "FORBIDDEN_TAG",
      params: { tag: "枪械" }
    });
  });

  it("地点/任务/敌人/物品 tags 中的禁止标签都会检出", () => {
    const candidate = draft();
    candidate.locations[0].tags.push("科技");
    candidate.quests[0].tags.push("科技");
    candidate.enemies[0].tags.push("枪械");
    candidate.items[0].tags.push("枪械");
    const forbidden = issuesOf(candidate).filter((issue) => issue.code === "FORBIDDEN_TAG");
    expect(forbidden.map((issue) => issue.path)).toEqual([
      "locations[0].tags[1]",
      "quests[0].tags[0]",
      "enemies[0].tags[0]",
      "items[0].tags[0]"
    ]);
  });
});

// ---------------------------------------------------------------------------
// 10. 物品展示元数据（背包界面重构）：可选字段，提供时必须合法
// ---------------------------------------------------------------------------

describe("validateScenarioBlueprintCandidate：物品展示元数据", () => {
  it("全部展示字段缺省时通过（旧候选零迁移）", () => {
    expect(validate(makeValidCandidate()).ok).toBe(true);
  });

  it("合法的显式 category / rarity / level / statLines 通过", () => {
    const candidate = draft();
    candidate.items[0].category = "equipment";
    candidate.items[0].rarity = "rare";
    candidate.items[0].level = 8;
    candidate.items[0].statLines = [
      { label: "攻击力", value: "24" },
      { label: "暴击率", value: "+3%" }
    ];
    expect(issuesOf(candidate)).toEqual([]);
  });

  it("未知 category 拒绝", () => {
    const candidate = draft();
    (candidate.items[0] as { category?: string }).category = "bogus";
    expect(issuesOf(candidate)).toContainEqual({
      path: "items[0].category",
      code: "INVALID_ITEM_PRESENTATION",
      params: { reason: "unknown_category", value: "bogus" }
    });
  });

  it("未知 rarity 拒绝", () => {
    const candidate = draft();
    (candidate.items[0] as { rarity?: string }).rarity = "legendary";
    expect(issuesOf(candidate)).toContainEqual({
      path: "items[0].rarity",
      code: "INVALID_ITEM_PRESENTATION",
      params: { reason: "unknown_rarity", value: "legendary" }
    });
  });

  it("level 越界（0、非整数、超上限）拒绝", () => {
    for (const level of [0, 2.5, 100]) {
      const candidate = draft();
      candidate.items[0].level = level;
      expect(issuesOf(candidate)).toContainEqual({
        path: "items[0].level",
        code: "INVALID_ITEM_PRESENTATION",
        params: { reason: "level_out_of_range", value: String(level) }
      });
    }
  });

  it("statLines 条目 label/value 为空时拒绝", () => {
    const candidate = draft();
    candidate.items[0].statLines = [{ label: " ", value: "24" }];
    expect(issuesOf(candidate)).toContainEqual({
      path: "items[0].statLines[0]",
      code: "INVALID_ITEM_PRESENTATION",
      params: { reason: "empty_stat_line" }
    });
  });

  it("statLines 超过 6 条拒绝", () => {
    const candidate = draft();
    candidate.items[0].statLines = Array.from({ length: 7 }, (_, i) => ({
      label: `属性${i}`,
      value: String(i)
    }));
    expect(issuesOf(candidate)).toContainEqual({
      path: "items[0].statLines",
      code: "INVALID_ITEM_PRESENTATION",
      params: { reason: "too_many_stat_lines", max: 6, actual: 7 }
    });
  });
});

// ---------------------------------------------------------------------------
// 11. Town 层：地点层级（可选字段，提供时必须合法）
// ---------------------------------------------------------------------------

describe("validateScenarioBlueprintCandidate：地点层级", () => {
  it("scale 缺省时通过（旧候选零迁移）", () => {
    expect(validate(makeValidCandidate()).ok).toBe(true);
  });

  it("合法的显式 scene / town 通过", () => {
    const candidate = draft();
    candidate.locations[0].scale = "town";
    candidate.locations[1].scale = "scene";
    expect(issuesOf(candidate)).toEqual([]);
  });

  it("未知 scale 拒绝", () => {
    const candidate = draft();
    (candidate.locations[0] as { scale?: string }).scale = "city";
    expect(issuesOf(candidate)).toContainEqual({
      path: "locations[0].scale",
      code: "INVALID_LOCATION_SCALE",
      params: { value: "city" }
    });
  });

  it("town 地点超过 2 个拒绝", () => {
    const candidate = draft();
    candidate.locations[0].scale = "town";
    candidate.locations[1].scale = "town";
    candidate.locations[2].scale = "town";
    expect(issuesOf(candidate)).toContainEqual({
      path: "locations",
      code: "TOWN_LOCATION_OVERBUDGET",
      params: { max: 2, actual: 3 }
    });
  });

  it("恰好 2 个 town 地点通过", () => {
    const candidate = draft();
    candidate.locations[0].scale = "town";
    candidate.locations[1].scale = "town";
    expect(issuesOf(candidate)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// collect-all：一次返回全部问题
// ---------------------------------------------------------------------------

describe("validateScenarioBlueprintCandidate：collect-all", () => {
  it("多处问题一次全部报告", () => {
    const candidate = draft();
    (candidate as { schemaVersion: number }).schemaVersion = 3;
    candidate.gameType = "fantasy";
    candidate.enemies[0].stats.hp = 0;
    candidate.npcs[0].tags.push("科技");
    const codes = codesOf(issuesOf(candidate));
    expect(codes).toContain("INVALID_SCHEMA_VERSION");
    expect(codes).toContain("GAME_TYPE_MISMATCH");
    expect(codes).toContain("OUT_OF_RANGE");
    expect(codes).toContain("FORBIDDEN_TAG");
  });
});
