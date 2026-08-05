import { describe, expect, it } from "vitest";
import {
  createBudgetPolicy,
  validateNewGameInput,
  type GameTypeId,
  type NewGameInput,
  type ScenarioBlueprintCandidate,
  type ValidatedNewGameInput
} from "@/game/domain";
import wuxiaFixture from "../../../../../data/fixtures/phase1/wuxia.json";
import scienceFictionFixture from "../../../../../data/fixtures/phase1/science_fiction.json";
import urbanFixture from "../../../../../data/fixtures/phase1/urban.json";
import { compileScenarioBlueprint, initializeGameState } from "./compileScenarioBlueprint";
import { createFallbackBlueprint, FALLBACK_TEMPLATE_VERSION } from "./createFallbackBlueprint";
import { loadScenarioProfiles, type ScenarioProfiles } from "./gameTypeProfiles";
import { createFallbackBlueprint as createFallbackBlueprintViaFacade } from "./index";
import { analyzeQuestReachability } from "./questGraph";
import {
  PHASE1_NUMERIC_RANGES,
  validateScenarioBlueprintCandidate
} from "./validateScenarioBlueprint";

// ---------------------------------------------------------------------------
// Task 6：确定性 fallback 生成器测试。
// 覆盖：确定性、seed 敏感性、inputDigest 字段覆盖、完整管线集成（武侠/科幻/
// 都市）、输入来源标记、越权输入不进状态、标签 ⊆ allowedTags、fixture 回归 pin。
// ---------------------------------------------------------------------------

const ALL_GAME_TYPES: readonly GameTypeId[] = [
  "wuxia", "xianxia", "fantasy", "science_fiction",
  "urban", "alternate_history", "post_apocalypse"
];

const PROFILES = loadScenarioProfiles();

const BASE_RAW_INPUT: NewGameInput = {
  gameType: "wuxia",
  characterName: "沈青崖",
  characterIdentity: "落魄镖师",
  characterProfile: "青崖镖局独子，镖局一夜覆灭后流落江湖。",
  personalityTags: ["坚毅", "重情义"],
  worldPremise: "镖局一夜覆灭，江湖各派暗流涌动，真凶身份成谜，官府与门派各怀心思。",
  storyOpening: "暮色四合，主角背着旧刀走进青石镇，镇口贴着一张字迹潦草的缉凶告示。",
  narrativeStyle: "novel",
  contentIntensity: "normal"
};

function buildInput(overrides: Partial<NewGameInput> = {}): ValidatedNewGameInput {
  const result = validateNewGameInput({ ...BASE_RAW_INPUT, ...overrides });
  if (!result.ok) {
    throw new Error(`测试输入未通过校验：${JSON.stringify(result.errors)}`);
  }
  return result.value;
}

function generate(
  overrides: Partial<NewGameInput> = {},
  seed = "seed-base"
): ScenarioBlueprintCandidate {
  return createFallbackBlueprint(buildInput(overrides), seed);
}

function policyFor(overrides: Partial<NewGameInput> = {}) {
  return createBudgetPolicy(buildInput(overrides).gameLength);
}

/** 收集候选里全部结构化 tags（world/locations/npcs/quests/enemies/items）。 */
function collectAllTags(candidate: ScenarioBlueprintCandidate): string[] {
  return [
    ...candidate.world.tags,
    ...candidate.locations.flatMap((entry) => entry.tags),
    ...candidate.npcs.flatMap((entry) => entry.tags),
    ...candidate.quests.flatMap((entry) => entry.tags),
    ...candidate.enemies.flatMap((entry) => entry.tags),
    ...candidate.items.flatMap((entry) => entry.tags)
  ];
}

describe("createFallbackBlueprint：确定性", () => {
  it("相同输入 + seed 两次调用产出深度相等的候选", () => {
    const first = generate();
    const second = generate();
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("不修改传入的已验证输入", () => {
    const input = buildInput();
    const snapshot = JSON.stringify(input);
    Object.freeze(input);
    Object.freeze(input.personalityTags);
    createFallbackBlueprint(input, "seed-purity");
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("seed 与 templateVersion 回写到候选元数据", () => {
    const candidate = generate({}, "seed-meta");
    expect(candidate.seed).toBe("seed-meta");
    expect(candidate.templateVersion).toBe(FALLBACK_TEMPLATE_VERSION);
    expect(candidate.schemaVersion).toBe(1);
    expect(candidate.gameType).toBe("wuxia");
  });

  it("门面 index.ts 导出同一个生成器", () => {
    expect(createFallbackBlueprintViaFacade).toBe(createFallbackBlueprint);
  });
});

describe("createFallbackBlueprint：seed 敏感性", () => {
  it("不同 seed 改变 generationId 与 inputDigest，但预算不变", () => {
    const a = generate({}, "seed-a");
    const b = generate({}, "seed-b");
    expect(b.generationId).not.toBe(a.generationId);
    expect(b.inputDigest).not.toBe(a.inputDigest);
    for (const candidate of [a, b]) {
      expect(candidate.budgetPolicy).toEqual(policyFor());
      expect(candidate.locations.filter((entry) => entry.kind === "main")).toHaveLength(4);
      expect(candidate.endings).toHaveLength(2);
      expect(candidate.npcs.length).toBeGreaterThanOrEqual(policyFor().opening.coreNpcsMin);
      expect(candidate.npcs.length).toBeLessThanOrEqual(policyFor().opening.coreNpcsMax);
    }
  });

  it("多个 seed 下 NPC 数量始终落在 4–6，支线不超过 2", () => {
    for (const seed of ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"]) {
      const candidate = generate({}, seed);
      expect(candidate.npcs.length).toBeGreaterThanOrEqual(4);
      expect(candidate.npcs.length).toBeLessThanOrEqual(6);
      expect(candidate.quests.filter((entry) => entry.kind === "side").length)
        .toBeLessThanOrEqual(policyFor().opening.sideQuestsMax);
    }
  });
});

describe("createFallbackBlueprint：inputDigest 覆盖全部影响字段", () => {
  it("每个影响字段变化都翻转 digest，且所有 digest 互不相同", () => {
    const variants: Partial<NewGameInput>[] = [
      {},
      { gameType: "urban" },
      { characterName: "白霜华" },
      { characterIdentity: "游方郎中" },
      { characterProfile: "自幼习医，行走江湖，见惯生死。" },
      { characterProfile: undefined },
      { personalityTags: ["冷静"] },
      { worldPremise: "王朝更替之际，边关战事吃紧，粮道被劫的消息接连传来。" },
      { storyOpening: "破庙的火堆边，主角从昏迷的信使身上搜出半枚虎符。" },
      { narrativeStyle: "concise" },
      { contentIntensity: "dark" }
    ];
    const digests = variants.map((overrides) => generate(overrides).inputDigest);
    expect(new Set(digests).size).toBe(digests.length);
  });

  it("digest 与 generationId 只由输入 + seed 决定，可复现", () => {
    const a = generate({}, "seed-repeat");
    const b = generate({}, "seed-repeat");
    expect(a.inputDigest).toBe(b.inputDigest);
    expect(a.generationId).toBe(b.generationId);
  });

  it("注入 profile 的 allowedTags 变化会翻转 digest 与 generationId", () => {
    const input = buildInput();
    const base = createFallbackBlueprint(input, "seed-profile", { profiles: PROFILES });
    const mutated: ScenarioProfiles = {
      ...PROFILES,
      gameTypeProfiles: {
        ...PROFILES.gameTypeProfiles,
        wuxia: {
          ...PROFILES.gameTypeProfiles.wuxia,
          allowedTags: [...PROFILES.gameTypeProfiles.wuxia.allowedTags, "注入新标签"]
        }
      }
    };
    const changed = createFallbackBlueprint(input, "seed-profile", { profiles: mutated });
    expect(changed.inputDigest).not.toBe(base.inputDigest);
    expect(changed.generationId).not.toBe(base.generationId);
  });
});

describe("createFallbackBlueprint：内容预算与结构", () => {
  const candidate = createFallbackBlueprint(buildInput(), "seed-structure");

  it("恰好 4 个主要地点 + 1 个隐藏地点", () => {
    expect(candidate.locations.filter((entry) => entry.kind === "main")).toHaveLength(4);
    expect(candidate.locations.filter((entry) => entry.kind === "hidden")).toHaveLength(1);
  });

  it("主线幕数等于 policy.mainActs，支线 1–2 条", () => {
    const policy = policyFor();
    const mains = candidate.quests.filter((entry) => entry.kind === "main");
    expect(mains).toHaveLength(policy.mainActs);
    expect(mains.map((entry) => (entry.kind === "main" ? entry.stage : 0)).sort((a, b) => a - b))
      .toEqual(Array.from({ length: policy.mainActs }, (_, i) => i + 1));
    const sides = candidate.quests.filter((entry) => entry.kind === "side");
    expect(sides.length).toBeGreaterThanOrEqual(1);
    expect(sides.length).toBeLessThanOrEqual(2);
  });

  it("medium/long 主线目标逐幕推进且不会重复已满足目标", () => {
    const expectedChain = [
      "visit_location:loc_2",
      "talk_to_npc:npc_2",
      "visit_location:loc_3",
      "obtain_item:item_key",
      "talk_to_npc:npc_3",
      "talk_to_npc:npc_1",
      "talk_to_npc:npc_4",
      "visit_location:loc_4",
    ];

    for (const gameLength of ["medium", "long"] as const) {
      const generated = generate({ gameLength }, `objective-chain-${gameLength}`);
      const policy = policyFor({ gameLength });
      const mainQuests = generated.quests
        .filter((entry): entry is Extract<typeof entry, { kind: "main" }> => entry.kind === "main")
        .sort((left, right) => left.stage - right.stage);
      const signatures = mainQuests.map((quest) => {
        const objective = quest.objectives[0];
        switch (objective.kind) {
          case "visit_location": return `${objective.kind}:${objective.locationId}`;
          case "talk_to_npc": return `${objective.kind}:${objective.npcId}`;
          case "obtain_item": return `${objective.kind}:${objective.itemId}`;
          case "discover_fact": return `${objective.kind}:${objective.factId}`;
          case "defeat_enemy": return `${objective.kind}:${objective.enemyId}`;
        }
      });

      const expected = gameLength === "medium"
        ? [
          "visit_location:loc_2",
          "talk_to_npc:npc_2",
          "visit_location:loc_3",
          "obtain_item:item_key",
          "visit_location:loc_4",
        ]
        : expectedChain;
      expect(signatures).toEqual(expected.slice(0, policy.mainActs));
      expect(new Set(signatures).size).toBe(signatures.length);
      expect(new Set(mainQuests.map((quest) => quest.description)).size).toBe(mainQuests.length);
      for (const quest of mainQuests) expect(quest.description.trim()).toContain(String(quest.stage));
      const finalQuest = mainQuests.at(-1);
      expect(finalQuest?.objectives.map((objective) => {
        switch (objective.kind) {
          case "visit_location": return `${objective.kind}:${objective.locationId}`;
          case "defeat_enemy": return `${objective.kind}:${objective.enemyId}`;
          default: return objective.kind;
        }
      })).toEqual(["visit_location:loc_4", "defeat_enemy:enemy_boss"]);
      const generatedFactObjectives = mainQuests.flatMap((quest) => quest.objectives)
        .filter((objective): objective is Extract<typeof objective, { kind: "discover_fact" }> => objective.kind === "discover_fact")
        .map((objective) => objective.factId);
      expect(generatedFactObjectives).toEqual(expect.arrayContaining(["fact_gen_1", "fact_gen_2"]));
      const validation = validateScenarioBlueprintCandidate(generated, {
        profile: PROFILES.gameTypeProfiles[generated.gameType],
        policy,
      });
      expect(validation.ok ? [] : validation.issues).toEqual([]);
    }
  });

  it("3 类普通敌人 + 1 名 Boss，数值全部在 Phase 1 范围内", () => {
    expect(candidate.enemies.filter((entry) => entry.tier === "normal")).toHaveLength(3);
    expect(candidate.enemies.filter((entry) => entry.tier === "boss")).toHaveLength(1);
    for (const enemy of candidate.enemies) {
      expect(enemy.stats.hp).toBeGreaterThanOrEqual(PHASE1_NUMERIC_RANGES.enemyHp.min);
      expect(enemy.stats.hp).toBeLessThanOrEqual(PHASE1_NUMERIC_RANGES.enemyHp.max);
      expect(enemy.stats.attack).toBeGreaterThanOrEqual(PHASE1_NUMERIC_RANGES.enemyAttack.min);
      expect(enemy.stats.attack).toBeLessThanOrEqual(PHASE1_NUMERIC_RANGES.enemyAttack.max);
      expect(enemy.stats.defense).toBeGreaterThanOrEqual(PHASE1_NUMERIC_RANGES.enemyDefense.min);
      expect(enemy.stats.defense).toBeLessThanOrEqual(PHASE1_NUMERIC_RANGES.enemyDefense.max);
    }
  });

  it("玩家出生地点/物品/数值合法", () => {
    const locationIds = new Set(candidate.locations.map((entry) => entry.id));
    expect(locationIds.has(candidate.player.startingLocationId)).toBe(true);
    const itemIds = new Set(candidate.items.map((entry) => entry.id));
    for (const itemId of candidate.player.startingItemIds) {
      expect(itemIds.has(itemId)).toBe(true);
    }
    const stats = candidate.player.baseStats;
    expect(stats.hp).toBeGreaterThanOrEqual(PHASE1_NUMERIC_RANGES.playerHp.min);
    expect(stats.hp).toBeLessThanOrEqual(PHASE1_NUMERIC_RANGES.playerHp.max);
    expect(stats.attack).toBeGreaterThanOrEqual(PHASE1_NUMERIC_RANGES.playerAttack.min);
    expect(stats.attack).toBeLessThanOrEqual(PHASE1_NUMERIC_RANGES.playerAttack.max);
    expect(stats.defense).toBeGreaterThanOrEqual(PHASE1_NUMERIC_RANGES.playerDefense.min);
    expect(stats.defense).toBeLessThanOrEqual(PHASE1_NUMERIC_RANGES.playerDefense.max);
  });

  it("开场场景位于公开地点且在场 NPC 位于该地点", () => {
    const openingLocation = candidate.locations.find(
      (entry) => entry.id === candidate.openingScene.locationId
    );
    expect(openingLocation?.kind).toBe("main");
    expect(candidate.openingScene.presentNpcIds.length).toBeGreaterThan(0);
    for (const npcId of candidate.openingScene.presentNpcIds) {
      const npc = candidate.npcs.find((entry) => entry.id === npcId);
      expect(npc?.locationId).toBe(candidate.openingScene.locationId);
    }
  });

  it("两个结局均从初始主线可达", () => {
    const analysis = analyzeQuestReachability(candidate.quests, candidate.endings);
    expect(analysis.reachableEndingIds).toHaveLength(2);
    expect(analysis.loopsWithoutClosure).toEqual([]);
  });
});

describe("createFallbackBlueprint：完整管线集成（validate → compile → initialize）", () => {
  const CORE_INPUTS: Record<"wuxia" | "science_fiction" | "urban", Partial<NewGameInput>> = {
    wuxia: {},
    science_fiction: {
      gameType: "science_fiction",
      characterName: "程曜",
      characterIdentity: "货运飞船领航员",
      characterProfile: "在环带航线上跑了八年货运。",
      worldPremise: "殖民星环带航线接连失联，星港各方势力都在暗中打探失踪船队的下落。",
      storyOpening: "货舱警报骤响，主角在曙光站候船大厅里收到一条来历不明的加密讯息。"
    },
    urban: {
      gameType: "urban",
      characterName: "林之遥",
      characterIdentity: "财经记者",
      characterProfile: "跑了五年财经口的深度报道记者。",
      worldPremise: "滨江金融城连环并购案背后，一笔离奇消失的资金牵动着各方神经。",
      storyOpening: "深夜的编辑部只剩一盏灯，主角收到一封匿名邮件，附件是半份审计底稿。"
    }
  };

  for (const [gameType, overrides] of Object.entries(CORE_INPUTS)) {
    it(`${gameType} 候选通过 validate、compile 与 initializeGameState`, () => {
      const candidate = generate(overrides, `pipeline-${gameType}`);
      const validation = validateScenarioBlueprintCandidate(candidate, {
        profile: PROFILES.gameTypeProfiles[gameType as GameTypeId],
        policy: policyFor(overrides)
      });
      expect(validation.ok ? [] : validation.issues).toEqual([]);
      const compiled = compileScenarioBlueprint(validation);
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) return;
      const state = initializeGameState(compiled.blueprint);
      expect(state.stateVersion).toBe(1);
      expect(state.generation.generationId).toBe(candidate.generationId);
      expect(state.currentLocationId).toBe(candidate.openingScene.locationId);
    });
  }

  it("全部 7 个类型的候选都通过完整校验", () => {
    for (const gameType of ALL_GAME_TYPES) {
      const candidate = generate({ gameType }, `all-types-${gameType}`);
      const validation = validateScenarioBlueprintCandidate(candidate, {
        profile: PROFILES.gameTypeProfiles[gameType],
        policy: policyFor({ gameType })
      });
      expect(validation.ok ? [] : validation.issues, `gameType=${gameType}`).toEqual([]);
    }
  });
});

describe("createFallbackBlueprint：输入来源标记（provenance）", () => {
  const input = buildInput();
  const candidate = createFallbackBlueprint(input, "seed-provenance");

  it("世界摘要携带玩家输入的世界观与标记", () => {
    expect(candidate.world.summary).toContain(input.worldPremise);
    expect(candidate.world.summary).toContain("【玩家输入】");
  });

  it("world.facts 含 source=player_input 的输入事实", () => {
    const playerFacts = candidate.world.facts.filter((fact) => fact.source === "player_input");
    expect(playerFacts.length).toBeGreaterThanOrEqual(2);
    expect(playerFacts.some((fact) => fact.text.includes(input.worldPremise))).toBe(true);
    expect(playerFacts.some((fact) => fact.text.includes(input.characterIdentity))).toBe(true);
    expect(candidate.world.facts.some((fact) => fact.source === "generated")).toBe(true);
  });

  it("玩家身份解释来自输入", () => {
    expect(candidate.player.name).toBe(input.characterName);
    expect(candidate.player.identity).toBe(input.characterIdentity);
    expect(candidate.player.backgroundSummary).toContain(input.characterIdentity);
    expect(candidate.player.backgroundSummary).toContain("【玩家输入】");
  });

  it("开场叙事携带玩家的故事开端", () => {
    expect(candidate.openingScene.narration).toContain(input.storyOpening);
    expect(candidate.openingScene.narration).toContain("【玩家输入】");
  });

  it("主线冲突描述携带玩家姓名、世界观痕迹与来源标记", () => {
    const stageOne = candidate.quests.find(
      (entry) => entry.kind === "main" && entry.stage === 1
    );
    expect(stageOne?.description).toContain(input.characterName);
    expect(stageOne?.description).toContain(input.worldPremise);
    expect(stageOne?.description).toContain("【玩家输入】");
  });
});

describe("createFallbackBlueprint：越权输入不进状态", () => {
  const claimOverrides: Partial<NewGameInput> = {
    worldPremise: "我有神剑和999点攻击力，早已击败了所有仇家，天下无人能挡我。",
    storyOpening: "我带着神剑走进青石镇，众人跪地高呼，把镇上的宝库钥匙献给我。"
  };

  it("宣称的神器不会成为物品，宣称的数值不会成为属性", () => {
    const candidate = generate(claimOverrides, "seed-claim");
    expect(candidate.items.some((item) => item.name.includes("神剑"))).toBe(false);
    expect(candidate.player.startingItemIds.length).toBeLessThanOrEqual(1);
    expect(candidate.player.baseStats.attack).toBeLessThanOrEqual(
      PHASE1_NUMERIC_RANGES.playerAttack.max
    );
  });

  it("基础数值始终来自模板，与自由文本内容无关", () => {
    const withClaim = generate(claimOverrides, "seed-stat");
    const withoutClaim = generate({}, "seed-stat");
    expect(withClaim.player.baseStats).toEqual(withoutClaim.player.baseStats);
    expect(withClaim.enemies.map((entry) => entry.stats))
      .toEqual(withoutClaim.enemies.map((entry) => entry.stats));
  });
});

describe("createFallbackBlueprint：标签来自 profile.allowedTags", () => {
  for (const gameType of ALL_GAME_TYPES) {
    it(`${gameType} 的全部实体标签 ⊆ allowedTags 且不含 forbiddenTags`, () => {
      const candidate = generate({ gameType }, `tags-${gameType}`);
      const profile = PROFILES.gameTypeProfiles[gameType];
      const allowed = new Set(profile.allowedTags);
      const forbidden = new Set(profile.forbiddenTags);
      const tags = collectAllTags(candidate);
      expect(tags.length).toBeGreaterThan(0);
      for (const tag of tags) {
        expect(allowed.has(tag), `tag=${tag}`).toBe(true);
        expect(forbidden.has(tag), `tag=${tag}`).toBe(false);
      }
    });
  }
});

describe("createFallbackBlueprint：地点可取得物品（Phase 5）", () => {
  for (const gameType of ALL_GAME_TYPES) {
    it(`${gameType} 的 obtain_item 目标物品放在唯一的可达主要地点`, () => {
      const candidate = generate({ gameType }, `available-items-${gameType}`);
      const mains = candidate.quests.filter((entry) => entry.kind === "main");
      const obtainObjectives = mains.flatMap((quest) =>
        quest.objectives.filter((o): o is { kind: "obtain_item"; itemId: string } => o.kind === "obtain_item")
      );
      for (const obj of obtainObjectives) {
        const hosts = candidate.locations.filter((entry) =>
          entry.availableItemIds.includes(obj.itemId)
        );
        expect(hosts).toHaveLength(1);
        expect(hosts[0]?.kind).toBe("main");
      }
      // 关键物品始终放在某个主要地点（无论是否有 obtain_item 目标引用）。
      const keyHosts = candidate.locations.filter((entry) =>
        entry.availableItemIds.includes("item_key")
      );
      expect(keyHosts).toHaveLength(1);
      expect(keyHosts[0]?.kind).toBe("main");
    });

    it(`${gameType} 的初始物品不出现在任何地点的可取得列表，且引用均存在`, () => {
      const candidate = generate({ gameType }, `available-items-${gameType}`);
      const itemIds = new Set(candidate.items.map((entry) => entry.id));
      const startingItemIds = new Set(candidate.player.startingItemIds);
      for (const location of candidate.locations) {
        for (const itemId of location.availableItemIds) {
          expect(itemIds.has(itemId), `itemId=${itemId}`).toBe(true);
          expect(startingItemIds.has(itemId), `itemId=${itemId}`).toBe(false);
        }
      }
    });
  }
});

describe("createFallbackBlueprint：town 地点覆盖", () => {
  it("全题材模板恰含一个 town 地点（loc_2，主线一阶段 visit 目标）", () => {
    for (const gameType of ALL_GAME_TYPES) {
      const candidate = generate({ gameType });
      const townLocations = candidate.locations.filter((entry) => entry.scale === "town");
      expect(townLocations.map((entry) => entry.id)).toEqual(["loc_2"]);
      // 其余地点不写 scale 字段（缺省即 scene，旧存档零迁移模式）。
      for (const location of candidate.locations) {
        if (String(location.id) !== "loc_2") expect(location.scale).toBeUndefined();
      }
    }
  });
});

describe("createFallbackBlueprint：fixture 回归 pin", () => {
  type FallbackFixture = {
    input: NewGameInput;
    seed: string;
    expected: {
      templateVersion: string;
      inputDigest: string;
      generationId: string;
      locationIds: string[];
      questIds: string[];
      endingIds: string[];
      npcCount: number;
      normalEnemyCount: number;
      bossEnemyId: string;
      keyItemLocationId: string;
    };
  };

  const fixtures: Record<string, FallbackFixture> = {
    wuxia: wuxiaFixture as unknown as FallbackFixture,
    science_fiction: scienceFictionFixture as unknown as FallbackFixture,
    urban: urbanFixture as unknown as FallbackFixture
  };

  for (const [name, fixture] of Object.entries(fixtures)) {
    it(`${name} fixture 的输入 + seed 复现全部 pin 值`, () => {
      const validated = validateNewGameInput(fixture.input);
      expect(validated.ok).toBe(true);
      if (!validated.ok) return;
      const candidate = createFallbackBlueprint(validated.value, fixture.seed);
      expect(candidate.templateVersion).toBe(fixture.expected.templateVersion);
      expect(candidate.inputDigest).toBe(fixture.expected.inputDigest);
      expect(candidate.generationId).toBe(fixture.expected.generationId);
      expect(candidate.locations.map((entry) => entry.id)).toEqual(fixture.expected.locationIds);
      expect(candidate.quests.map((entry) => entry.id)).toEqual(fixture.expected.questIds);
      expect(candidate.endings.map((entry) => entry.id)).toEqual(fixture.expected.endingIds);
      expect(candidate.npcs).toHaveLength(fixture.expected.npcCount);
      expect(candidate.enemies.filter((entry) => entry.tier === "normal"))
        .toHaveLength(fixture.expected.normalEnemyCount);
      expect(candidate.enemies.find((entry) => entry.tier === "boss")?.id)
        .toBe(fixture.expected.bossEnemyId);
      // Phase 5 pin：主线关键物品的落位地点。
      const keyHost = candidate.locations.find((entry) =>
        entry.availableItemIds.includes("item_key")
      );
      expect(keyHost?.id).toBe(fixture.expected.keyItemLocationId);
    });
  }
});

// ---------------------------------------------------------------------------
// 背包界面重构：fallback 模板物品携带展示元数据，且仍通过完整管线。
// ---------------------------------------------------------------------------

describe("createFallbackBlueprint：物品展示元数据", () => {
  for (const gameType of ALL_GAME_TYPES) {
    it(`${gameType} 的两件物品都有显式 category/rarity，并通过校验管线`, () => {
      const candidate = generate({ gameType });
      const startItem = candidate.items.find((entry) => entry.id === "item_start");
      const keyItem = candidate.items.find((entry) => entry.id === "item_key");
      expect(startItem).toBeDefined();
      expect(keyItem).toBeDefined();

      // 初始物品：随身装备，至少一条展示属性行与等级。
      expect(startItem?.category).toBe("equipment");
      expect(startItem?.rarity).toBeDefined();
      expect(startItem?.level).toBeGreaterThanOrEqual(1);
      expect(startItem?.statLines?.length).toBeGreaterThanOrEqual(1);
      for (const line of startItem?.statLines ?? []) {
        expect(line.label.trim()).not.toBe("");
        expect(line.value.trim()).not.toBe("");
      }

      // 主线关键物品：任务分类 + 稀有。
      expect(keyItem?.category).toBe("quest");
      expect(keyItem?.rarity).toBe("rare");

      // 携带新字段的候选仍能通过校验 + 编译管线。
      const profile = PROFILES.gameTypeProfiles[gameType];
      const compiled = compileScenarioBlueprint(
        validateScenarioBlueprintCandidate(candidate, { profile, policy: policyFor({ gameType }) })
      );
      expect(compiled.ok).toBe(true);
    });
  }
});
