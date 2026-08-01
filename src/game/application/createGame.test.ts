import { describe, expect, it } from "vitest";
import {
  validateNewGameInput,
  type NewGameInput,
  type ScenarioBlueprintCandidate
} from "@/game/domain";
import {
  createFallbackBlueprint,
  loadScenarioProfiles,
  type ScenarioProfiles
} from "@/game/gameplay/rpg/scenario";
import {
  SCENARIO_CANDIDATE_CONTRACT_VERSION,
  type ScenarioCandidateAttempt,
  type ScenarioCandidateSource,
  type ScenarioGenerationEvent,
  type ScenarioGenerationRequest
} from "./scenarioGeneration";
import scienceFictionFixture from "../../../data/fixtures/phase1/science_fiction.json";
import urbanFixture from "../../../data/fixtures/phase1/urban.json";
import wuxiaFixture from "../../../data/fixtures/phase1/wuxia.json";
import { createGame } from "./createGame";
import type { GameRepository } from "./server/persistence/gameRepository";
import {
  createFakeGameRepository,
  createTestDependencies,
  runScenarioPipeline,
  TEST_CREATED_AT,
  TEST_GAME_ID
} from "./applicationFixture.testutil";

// ---------------------------------------------------------------------------
// Task 1：createGame use case 契约测试。
// 覆盖 plan 要求：有效输入的 view、所有验证错误透传、候选/编译失败不触及
// repository（stub/spy 端口）、view 不泄漏隐藏内容、注入 seed/gameId/clock 可重复。
// ---------------------------------------------------------------------------

type Phase1Fixture = { input: NewGameInput; seed: string };
const FIXTURE = wuxiaFixture as unknown as Phase1Fixture;
const PROFILES = loadScenarioProfiles();

describe("createGame：有效输入产出开场视图", () => {
  it("返回注入的 gameId、fallback 来源与仅含允许字段的 OpeningGameView", async () => {
    const repository = createFakeGameRepository();
    const result = await createGame(
      { input: FIXTURE.input, seed: FIXTURE.seed },
      createTestDependencies(repository)
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.gameId).toBe(TEST_GAME_ID);
    expect(result.source).toBe("fallback");

    const expected = runScenarioPipeline(FIXTURE.input, FIXTURE.seed);
    const view = result.view;
    expect(view.gameId).toBe(TEST_GAME_ID);
    // 世界：名称来自类型 profile 的 label（蓝图暂无独立世界名），摘要/类型来自蓝图。
    expect(view.world.name).toBe(PROFILES.gameTypeProfiles.wuxia.label);
    expect(view.world.summary).toBe(expected.blueprint.world.summary);
    expect(view.world.gameType).toBe("wuxia");
    // 玩家身份来自初始 GameState。
    expect(view.player.name).toBe(expected.state.player.name);
    expect(view.player.identity).toBe(expected.state.player.identity);
    // 当前地点 = state.currentLocationId 对应的蓝图地点。
    const openingLocation = expected.blueprint.locations.find(
      (entry) => entry.id === expected.state.currentLocationId
    );
    expect(view.currentLocation).toEqual({
      name: openingLocation?.name,
      description: openingLocation?.description
    });
    // 可见 NPC = 开场场景在场 NPC，按蓝图顺序。
    expect(view.visibleNpcs).toEqual(
      expected.blueprint.openingScene.presentNpcIds.map((npcId) => {
        const npc = expected.blueprint.npcs.find((entry) => entry.id === npcId);
        return { name: npc?.name, role: npc?.role };
      })
    );
    // 初始物品 = 初始背包对应的蓝图物品。
    expect(view.initialItems).toEqual(
      expected.state.inventory.map((itemId) => {
        const item = expected.blueprint.items.find((entry) => entry.id === itemId);
        return { name: item?.name, description: item?.description };
      })
    );
    expect(view.openingNarration).toBe(expected.blueprint.openingScene.narration);
    expect(view.suggestedActions).toEqual(expected.blueprint.openingScene.suggestedActions);
    // generation metadata 只暴露非敏感展示字段。
    expect(view.generation).toEqual({
      generationId: expected.blueprint.generationId,
      templateVersion: expected.blueprint.templateVersion
    });
  });

  it("repository 收到一次创建载荷：注入的 gameId/createdAt 与管线一致的蓝图/状态", async () => {
    const repository = createFakeGameRepository();
    const result = await createGame(
      { input: FIXTURE.input, seed: FIXTURE.seed },
      createTestDependencies(repository)
    );

    expect(result.ok).toBe(true);
    const expected = runScenarioPipeline(FIXTURE.input, FIXTURE.seed);
    expect(repository.createCalls).toHaveLength(1);
    const record = repository.createCalls[0];
    expect(record.gameId).toBe(TEST_GAME_ID);
    expect(record.createdAt).toBe(TEST_CREATED_AT);
    expect(record.blueprint).toEqual(expected.blueprint);
    expect(record.state).toEqual(expected.state);
  });

  it("未提供 command.seed 时使用注入的 newSeed provider", async () => {
    const repository = createFakeGameRepository();
    const result = await createGame(
      { input: FIXTURE.input },
      createTestDependencies(repository, { newSeed: () => FIXTURE.seed })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expected = runScenarioPipeline(FIXTURE.input, FIXTURE.seed);
    expect(result.view.generation.generationId).toBe(expected.blueprint.generationId);
  });
});

describe("createGame：三种游戏类型均成功创建（Task 3）", () => {
  // wuxia 的字段级细节由上一组用例覆盖；这里保证三种类型走完整编排都成功，
  // 且持久化载荷与独立复跑的管线逐类型一致。
  const fixtures: readonly Phase1Fixture[] = [
    wuxiaFixture,
    scienceFictionFixture,
    urbanFixture
  ] as unknown as Phase1Fixture[];

  for (const fixture of fixtures) {
    it(`${fixture.input.gameType}：创建成功，view 与持久化载荷与管线一致`, async () => {
      const repository = createFakeGameRepository();
      const result = await createGame(
        { input: fixture.input, seed: fixture.seed },
        createTestDependencies(repository)
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.source).toBe("fallback");
      const expected = runScenarioPipeline(fixture.input, fixture.seed);
      expect(result.view.world.gameType).toBe(fixture.input.gameType);
      expect(result.view.world.name).toBe(
        PROFILES.gameTypeProfiles[fixture.input.gameType].label
      );
      expect(result.view.generation.generationId).toBe(expected.blueprint.generationId);
      expect(repository.createCalls).toHaveLength(1);
      expect(repository.createCalls[0].blueprint).toEqual(expected.blueprint);
      expect(repository.createCalls[0].state).toEqual(expected.state);
    });
  }
});

describe("createGame：验证失败立即返回字段错误", () => {
  const invalidInput: NewGameInput = {
    ...FIXTURE.input,
    characterName: "",
    worldPremise: "太短",
    personalityTags: ["果敢", "果敢", " ", "多疑", "谨慎"]
  };

  it("所有 NewGameInputError 原样透传，repository 零调用", async () => {
    const repository = createFakeGameRepository();
    const result = await createGame(
      { input: invalidInput, seed: FIXTURE.seed },
      createTestDependencies(repository)
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_INPUT");
    if (result.code !== "INVALID_INPUT") return;
    const direct = validateNewGameInput(invalidInput);
    expect(direct.ok).toBe(false);
    if (direct.ok) return;
    expect(result.fieldErrors).toEqual(direct.errors);
    expect(repository.createCalls).toHaveLength(0);
  });
});

describe("createGame：生成/编译诊断映射为 GENERATION_INVALID", () => {
  // 注入被污染的 profile（allowedTags 全部同时列为 forbiddenTags），
  // 使既有 validator 必然产生 FORBIDDEN_TAG 诊断。
  const poisonedProfiles: ScenarioProfiles = {
    ...PROFILES,
    gameTypeProfiles: {
      ...PROFILES.gameTypeProfiles,
      wuxia: {
        ...PROFILES.gameTypeProfiles.wuxia,
        forbiddenTags: [...PROFILES.gameTypeProfiles.wuxia.allowedTags]
      }
    }
  };

  it("返回稳定代码且不触及 repository", async () => {
    const repository = createFakeGameRepository();
    const result = await createGame(
      { input: FIXTURE.input, seed: FIXTURE.seed },
      createTestDependencies(repository, { profiles: poisonedProfiles })
    );

    expect(result).toEqual({ ok: false, code: "GENERATION_INVALID" });
    expect(repository.createCalls).toHaveLength(0);
  });
});

describe("createGame：repository 结构化失败透传稳定代码", () => {
  it("已有当前存档 ⇒ ACTIVE_GAME_EXISTS，不含异常文本", async () => {
    const repository = createFakeGameRepository();
    repository.setCreateResult({ ok: false, code: "ACTIVE_GAME_EXISTS" });
    const result = await createGame(
      { input: FIXTURE.input, seed: FIXTURE.seed },
      createTestDependencies(repository)
    );
    expect(result).toEqual({ ok: false, code: "ACTIVE_GAME_EXISTS" });
  });

  it("基础设施失败 ⇒ INFRASTRUCTURE_FAILURE", async () => {
    const repository = createFakeGameRepository();
    repository.setCreateResult({ ok: false, code: "INFRASTRUCTURE_FAILURE" });
    const result = await createGame(
      { input: FIXTURE.input, seed: FIXTURE.seed },
      createTestDependencies(repository)
    );
    expect(result).toEqual({ ok: false, code: "INFRASTRUCTURE_FAILURE" });
  });

  it("repository 端口契约外意外抛错 ⇒ 捕获为 INFRASTRUCTURE_FAILURE，不泄漏异常文本", async () => {
    // 模拟 adapter 漏网的驱动异常：use case 必须兜底为稳定代码，绝不向 API 层抛出。
    const throwingRepository: GameRepository = {
      async createInitialGame() {
        throw new Error("libsql 驱动崩溃：connection refused at F:\\db\\rpg.sqlite");
      },
      async getCurrentGame() {
        return { ok: true, status: "none" };
      },
      async applyResolvedAction() {
        throw new Error("libsql 驱动崩溃：connection refused at F:\\db\\rpg.sqlite");
      },
      async applyBlueprintExpansion() {
        throw new Error("libsql 驱动崩溃：connection refused at F:\\db\\rpg.sqlite");
      }
    };
    const result = await createGame(
      { input: FIXTURE.input, seed: FIXTURE.seed },
      createTestDependencies(throwingRepository)
    );
    // toEqual 精确匹配：结果对象只含稳定代码，异常 message/堆栈不得出现。
    expect(result).toEqual({ ok: false, code: "INFRASTRUCTURE_FAILURE" });
    expect(JSON.stringify(result)).not.toContain("connection refused");
  });
});

describe("createGame：视图不泄漏隐藏内容", () => {
  it("隐藏地点、未解锁任务、结局、敌人、seed/inputDigest 均不出现在视图中", async () => {
    const repository = createFakeGameRepository();
    const result = await createGame(
      { input: FIXTURE.input, seed: FIXTURE.seed },
      createTestDependencies(repository)
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const viewJson = JSON.stringify(result.view);
    const { blueprint, state } = runScenarioPipeline(FIXTURE.input, FIXTURE.seed);

    // 隐藏地点：名称与 ID 都不得出现。
    const hiddenLocations = blueprint.locations.filter((entry) => entry.kind === "hidden");
    expect(hiddenLocations.length).toBeGreaterThan(0);
    for (const location of hiddenLocations) {
      expect(viewJson.includes(location.name), `hidden location=${location.name}`).toBe(false);
      expect(viewJson.includes(location.id), `hidden location id=${location.id}`).toBe(false);
    }
    // 未解锁任务：名称与 ID 都不得出现。
    const lockedQuestIds = new Set(
      state.quests.filter((quest) => quest.status === "locked").map((quest) => quest.questId)
    );
    const lockedQuests = blueprint.quests.filter((quest) => lockedQuestIds.has(quest.id));
    expect(lockedQuests.length).toBeGreaterThan(0);
    for (const quest of lockedQuests) {
      expect(viewJson.includes(quest.name), `locked quest=${quest.name}`).toBe(false);
      expect(viewJson.includes(quest.id), `locked quest id=${quest.id}`).toBe(false);
    }
    // 结局与敌人属于完整蓝图内容，开场视图无权携带。
    for (const ending of blueprint.endings) {
      expect(viewJson.includes(ending.name), `ending=${ending.name}`).toBe(false);
    }
    for (const enemy of blueprint.enemies) {
      expect(viewJson.includes(enemy.name), `enemy=${enemy.name}`).toBe(false);
    }
    // 可复现生成的内部信息与蓝图结构字段不外泄。
    expect(viewJson.includes(blueprint.seed)).toBe(false);
    expect(viewJson.includes(blueprint.inputDigest)).toBe(false);
    expect(viewJson.includes("contentBudget")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Task 3（Phase 4A）：候选编排失败矩阵。
// 合法候选 generated；repairable 修复后 generated；首次不可修复→重试；两次失败
// →fallback；repository 冲突/抛错稳定错误 + failed(persistence_failure) 事件；
// 输入无效时 source/repository 零调用；observer 抛错不影响结果。
// ---------------------------------------------------------------------------

// 此 seed 下的 fallback 候选恰好满额 6 名 NPC：追加第 7 人必然超预算。
const CANDIDATE_SEED = "phase4a-candidate-002";
// 测试专用：去掉根字段 readonly 并允许挂未知字段，便于构造非法候选。
type MutableCandidate = {
  -readonly [K in keyof ScenarioBlueprintCandidate]: ScenarioBlueprintCandidate[K];
} & Record<string, unknown>;

/** 与 fallback 管线同构但 seed 不同的合法候选：可证明持久化蓝图来自 source。 */
function buildSourceCandidate(): ScenarioBlueprintCandidate {
  const validated = validateNewGameInput(FIXTURE.input);
  if (!validated.ok) throw new Error("fixture 输入必须合法");
  return createFallbackBlueprint(validated.value, CANDIDATE_SEED, { profiles: PROFILES });
}

/** 可机械修复：多余根字段 + 超预算第 7 个 NPC（无任何引用指向它）。 */
function buildRepairableCandidate(): ScenarioBlueprintCandidate {
  const candidate = buildSourceCandidate() as MutableCandidate;
  candidate.extraPromptInstruction = "多余指令字段";
  candidate.npcs = [
    ...candidate.npcs,
    {
      id: "npc_7",
      name: "多余随从",
      role: "路人",
      description: "超预算第七人，未被任何地点引用。",
      locationId: "loc_2",
      isCompanion: false,
      knownFactIds: [],
      tags: []
    }
  ];
  return candidate;
}

/** 不可修复：悬空 fact 引用（机械修复禁止伪造引用）。 */
function buildUnrepairableCandidate(): ScenarioBlueprintCandidate {
  const candidate = buildSourceCandidate() as MutableCandidate;
  candidate.npcs = candidate.npcs.map((npc, index) =>
    index === 0 ? { ...npc, knownFactIds: ["fact_missing"] } : npc
  );
  return candidate;
}

/** 记录 calls 的脚本化 source：按预设序列逐次返回 attempt。 */
function createScriptedSource(attempts: readonly ScenarioCandidateAttempt[]): {
  source: ScenarioCandidateSource;
  calls: ScenarioGenerationRequest[];
} {
  const calls: ScenarioGenerationRequest[] = [];
  return {
    calls,
    source: {
      async generate(request) {
        calls.push(request);
        const attempt = attempts[calls.length - 1];
        if (attempt === undefined) throw new Error("scripted source 超出预设尝试次数");
        return attempt;
      }
    }
  };
}

function okAttempt(candidate: ScenarioBlueprintCandidate): ScenarioCandidateAttempt {
  return {
    ok: true,
    contractVersion: SCENARIO_CANDIDATE_CONTRACT_VERSION,
    origin: "fixture",
    candidate,
    diagnostics: []
  };
}

const TIMEOUT_ATTEMPT: ScenarioCandidateAttempt = {
  ok: false,
  contractVersion: SCENARIO_CANDIDATE_CONTRACT_VERSION,
  origin: "fixture",
  category: "timeout",
  diagnostics: ["FIXTURE_TIMEOUT"]
};

describe("createGame：Phase 4A 候选编排", () => {
  it("合法候选一次通过 ⇒ source=generated，持久化 source 候选蓝图", async () => {
    const repository = createFakeGameRepository();
    const scripted = createScriptedSource([okAttempt(buildSourceCandidate())]);
    const events: ScenarioGenerationEvent[] = [];
    const result = await createGame(
      { input: FIXTURE.input, seed: FIXTURE.seed },
      createTestDependencies(repository, {
        scenarioCandidateSource: scripted.source,
        generationObserver: (event) => events.push(event)
      })
    );

    expect(result).toMatchObject({ ok: true, source: "generated" });
    // source 只调用一次，请求携带 validated 输入、command seed 与注入 traceId。
    expect(scripted.calls).toHaveLength(1);
    const validated = validateNewGameInput(FIXTURE.input);
    if (!validated.ok) throw new Error("fixture 输入必须合法");
    expect(scripted.calls[0]).toEqual({
      input: validated.value,
      seed: FIXTURE.seed,
      traceId: "trace-test-0001"
    });
    // 持久化蓝图来自 source 候选（CANDIDATE_SEED），而非本地 fallback。
    const expected = runScenarioPipeline(FIXTURE.input, CANDIDATE_SEED);
    expect(repository.createCalls).toHaveLength(1);
    expect(repository.createCalls[0].blueprint).toEqual(expected.blueprint);
    if (!result.ok) return;
    expect(result.view.generation.generationId).toBe(expected.blueprint.generationId);
    // 阶段序列与 manifest GENERATED 约定一致，completed 携带 outcome。
    expect(events.map((event) => event.stage)).toEqual([
      "requested",
      "candidate_received",
      "validating",
      "completed"
    ]);
    expect(events.at(-1)).toEqual({
      stage: "completed",
      outcome: "generated",
      traceId: "trace-test-0001"
    });
  });

  it("repairable 候选 ⇒ 修复后 generated，source 只调用一次", async () => {
    const repository = createFakeGameRepository();
    const scripted = createScriptedSource([okAttempt(buildRepairableCandidate())]);
    const events: ScenarioGenerationEvent[] = [];
    const result = await createGame(
      { input: FIXTURE.input, seed: FIXTURE.seed },
      createTestDependencies(repository, {
        scenarioCandidateSource: scripted.source,
        generationObserver: (event) => events.push(event)
      })
    );

    expect(result).toMatchObject({ ok: true, source: "generated" });
    expect(scripted.calls).toHaveLength(1);
    // 修复只删多余字段/裁剪尾部 ⇒ 与合法候选编译结果完全一致。
    const expected = runScenarioPipeline(FIXTURE.input, CANDIDATE_SEED);
    expect(repository.createCalls).toHaveLength(1);
    expect(repository.createCalls[0].blueprint).toEqual(expected.blueprint);
    expect(repository.createCalls[0].blueprint.npcs).toHaveLength(6);
    expect(events.map((event) => event.stage)).toEqual([
      "requested",
      "candidate_received",
      "validating",
      "repairing",
      "completed"
    ]);
    expect(events.at(-1)).toEqual({
      stage: "completed",
      outcome: "generated",
      traceId: "trace-test-0001"
    });
  });

  it("首次不可修复、第二次合法 ⇒ generated 且 source 调用两次", async () => {
    const repository = createFakeGameRepository();
    const scripted = createScriptedSource([
      okAttempt(buildUnrepairableCandidate()),
      okAttempt(buildSourceCandidate())
    ]);
    const events: ScenarioGenerationEvent[] = [];
    const result = await createGame(
      { input: FIXTURE.input, seed: FIXTURE.seed },
      createTestDependencies(repository, {
        scenarioCandidateSource: scripted.source,
        generationObserver: (event) => events.push(event)
      })
    );

    expect(result).toMatchObject({ ok: true, source: "generated" });
    expect(scripted.calls).toHaveLength(2);
    expect(repository.createCalls).toHaveLength(1);
    expect(repository.createCalls[0].blueprint).toEqual(
      runScenarioPipeline(FIXTURE.input, CANDIDATE_SEED).blueprint
    );
    // 修复失败不发 repairing；retrying 标记第二次 source 调用。
    expect(events.map((event) => event.stage)).toEqual([
      "requested",
      "candidate_received",
      "validating",
      "retrying",
      "candidate_received",
      "validating",
      "completed"
    ]);
  });

  it("两次 timeout ⇒ fallback 完整可玩，repository 仍收到一次创建", async () => {
    const repository = createFakeGameRepository();
    const scripted = createScriptedSource([TIMEOUT_ATTEMPT, TIMEOUT_ATTEMPT]);
    const events: ScenarioGenerationEvent[] = [];
    const result = await createGame(
      { input: FIXTURE.input, seed: FIXTURE.seed },
      createTestDependencies(repository, {
        scenarioCandidateSource: scripted.source,
        generationObserver: (event) => events.push(event)
      })
    );

    expect(result).toMatchObject({ ok: true, source: "fallback" });
    expect(scripted.calls).toHaveLength(2);
    expect(repository.createCalls).toHaveLength(1);
    // fallback 蓝图使用 command seed，与既有管线一致。
    expect(repository.createCalls[0].blueprint).toEqual(
      runScenarioPipeline(FIXTURE.input, FIXTURE.seed).blueprint
    );
    expect(events.map((event) => event.stage)).toEqual([
      "requested",
      "retrying",
      "falling_back",
      "completed"
    ]);
    expect(events.at(-2)).toEqual({
      stage: "falling_back",
      category: "timeout",
      traceId: "trace-test-0001"
    });
    expect(events.at(-1)).toEqual({
      stage: "completed",
      outcome: "fallback",
      traceId: "trace-test-0001"
    });
  });

  it("两次候选引用违规 ⇒ fallback 记录 reference_broken，供脱敏 smoke 汇总", async () => {
    const repository = createFakeGameRepository();
    const scripted = createScriptedSource([
      okAttempt(buildUnrepairableCandidate()),
      okAttempt(buildUnrepairableCandidate())
    ]);
    const events: ScenarioGenerationEvent[] = [];
    const result = await createGame(
      { input: FIXTURE.input, seed: FIXTURE.seed },
      createTestDependencies(repository, {
        scenarioCandidateSource: scripted.source,
        generationObserver: (event) => events.push(event)
      })
    );

    expect(result).toMatchObject({ ok: true, source: "fallback" });
    expect(scripted.calls).toHaveLength(2);
    expect(events.at(-2)).toEqual({
      stage: "falling_back",
      category: "reference_broken",
      traceId: "trace-test-0001"
    });
  });

  it("候选合法但 repository 冲突 ⇒ ACTIVE_GAME_EXISTS + failed(persistence_failure)", async () => {
    const repository = createFakeGameRepository();
    repository.setCreateResult({ ok: false, code: "ACTIVE_GAME_EXISTS" });
    const scripted = createScriptedSource([okAttempt(buildSourceCandidate())]);
    const events: ScenarioGenerationEvent[] = [];
    const result = await createGame(
      { input: FIXTURE.input, seed: FIXTURE.seed },
      createTestDependencies(repository, {
        scenarioCandidateSource: scripted.source,
        generationObserver: (event) => events.push(event)
      })
    );

    expect(result).toEqual({ ok: false, code: "ACTIVE_GAME_EXISTS" });
    expect(events.at(-1)).toEqual({
      stage: "failed",
      category: "persistence_failure",
      traceId: "trace-test-0001"
    });
  });

  it("候选合法但 repository 抛错 ⇒ INFRASTRUCTURE_FAILURE + failed(persistence_failure)", async () => {
    const throwingRepository: GameRepository = {
      async createInitialGame() {
        throw new Error("libsql 驱动崩溃");
      },
      async getCurrentGame() {
        return { ok: true, status: "none" };
      },
      async applyResolvedAction() {
        throw new Error("libsql 驱动崩溃");
      },
      async applyBlueprintExpansion() {
        throw new Error("libsql 驱动崩溃");
      }
    };
    const scripted = createScriptedSource([okAttempt(buildSourceCandidate())]);
    const events: ScenarioGenerationEvent[] = [];
    const result = await createGame(
      { input: FIXTURE.input, seed: FIXTURE.seed },
      createTestDependencies(throwingRepository, {
        scenarioCandidateSource: scripted.source,
        generationObserver: (event) => events.push(event)
      })
    );

    expect(result).toEqual({ ok: false, code: "INFRASTRUCTURE_FAILURE" });
    expect(events.at(-1)).toEqual({
      stage: "failed",
      category: "persistence_failure",
      traceId: "trace-test-0001"
    });
  });

  it("输入无效 ⇒ source 与 repository 调用均为零，且无任何阶段事件", async () => {
    const repository = createFakeGameRepository();
    const scripted = createScriptedSource([okAttempt(buildSourceCandidate())]);
    const events: ScenarioGenerationEvent[] = [];
    const result = await createGame(
      { input: { ...FIXTURE.input, characterName: "" }, seed: FIXTURE.seed },
      createTestDependencies(repository, {
        scenarioCandidateSource: scripted.source,
        generationObserver: (event) => events.push(event)
      })
    );

    expect(result).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(scripted.calls).toHaveLength(0);
    expect(repository.createCalls).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it("observer 抛错不得影响创建结果", async () => {
    const repository = createFakeGameRepository();
    const scripted = createScriptedSource([okAttempt(buildSourceCandidate())]);
    const result = await createGame(
      { input: FIXTURE.input, seed: FIXTURE.seed },
      createTestDependencies(repository, {
        scenarioCandidateSource: scripted.source,
        generationObserver: () => {
          throw new Error("observer 崩溃");
        }
      })
    );

    expect(result).toMatchObject({ ok: true, source: "generated" });
    expect(repository.createCalls).toHaveLength(1);
  });
});

describe("createGame：注入依赖下完全可重复", () => {
  it("相同 seed/gameId/clock 两次运行 ⇒ 结果与持久化载荷深度相等", async () => {
    const first = createFakeGameRepository();
    const second = createFakeGameRepository();
    const command = { input: FIXTURE.input, seed: FIXTURE.seed };
    const resultA = await createGame(command, createTestDependencies(first));
    const resultB = await createGame(command, createTestDependencies(second));

    expect(resultB).toEqual(resultA);
    expect(JSON.stringify(resultB)).toBe(JSON.stringify(resultA));
    expect(second.createCalls).toEqual(first.createCalls);
    expect(JSON.stringify(second.createCalls)).toBe(JSON.stringify(first.createCalls));
  });
});
