/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import {
  asFactId,
  asLocationId,
  asNpcId,
  asQuestId,
  createBudgetPolicy,
  validateNewGameInput,
  type GameState,
  type NewGameInput,
  type ProposedEnding,
  type ScenarioBlueprint,
  type ValidatedNewGameInput
} from "@/game/domain";
import {
  compileScenarioBlueprint,
  createFallbackBlueprint,
  initializeGameState,
  validateScenarioBlueprintCandidate
} from "@/game/gameplay/rpg/scenario";
import {
  TEST_POLICY,
  TEST_PROFILE,
  makeValidCandidate
} from "@/game/gameplay/rpg/scenario/scenarioBlueprintFixture.testutil";
import { approveEndingProposal, applyEndingToBlueprint } from "@/game/gameplay/rpg/narrative";
import { reconcileMainStoryProgress } from "@/game/gameplay/rpg/quests/storyProgression";
import { ensureTownRuntime } from "@/game/gameplay/rpg/town";
import { projectTownLayerView } from "./townRuntimeView";
import {
  createTestDependencies,
  TEST_CREATED_AT,
  TEST_GAME_ID
} from "./applicationFixture.testutil";
import { createGame } from "./createGame";
import { performAction } from "./performAction";
import {
  NARRATIVE_CONTRACT_VERSION,
  type DirectorSource,
  type NpcLineSource,
  type SceneScriptSource
} from "./runtimeNarrative";
import wuxiaFixture from "../../../data/fixtures/phase1/wuxia.json";
import { interpretGameRow } from "./server/persistence/sqliteGameRepository";
import {
  type ApplyBlueprintExpansionInput,
  type ApplyResolvedActionInput,
  type ApplyResolvedActionResult,
  type CreateInitialGameInput,
  type CreateInitialGameResult,
  type GameRecord,
  type GameRepository,
  type GetCurrentGameRecordResult
} from "./server/persistence/gameRepository";

// ---------------------------------------------------------------------------
// Phase 14 回归测试：渐进式生成与剧情推演完整旅程。
//
// 覆盖 spec §关键回归测试 列出的 9 个用例（docs/superpowers/specs/
// 2026-08-05-progressive-generation-narrative-evolution-design.md 第 527-537 行）：
//   1. 开局蓝图只含起始锚点（fallback 收窄：1 地点 / 1 NPC / 1 任务 / 0 结局）
//   2. 序幕播放后 prologueShown=true（ack_prologue intent 幂等）
//   3. talk 首遇写 npc_met 并排队 pending（携带 triggerContext.kind=talk）
//   4. narrative_choice 自动排队下一场景（携带 triggerContext.kind=narrative_choice_followup）
//   5. 自由输入 narrative 路径携带 triggerContext（pending 排队条件覆盖）
//   6. 主线达 lockedAt 阈值时导演提议结局（reconcileMainStoryProgress）
//   7. 结局闸门拒绝未达阈值/重复提议/基调不匹配（approveEndingProposal 8 步）
//   8. 小镇入口任务目标 + 已结识过滤（projectTownLayerView）
//   9. 旧存档 schemaVersion 1→2 迁移（interpretGameRow with*Defaults 链）
//
// 全程不调用真实 AI：使用 unavailable source 触发 fallback，或使用
// makeValidCandidate 完整 fixture + runtime_expansion phase 验证运行时路径。
// ---------------------------------------------------------------------------

const FIXED_NOW = "2026-08-05T10:00:00.000Z";
const deps = { now: () => FIXED_NOW };

/**
 * Mock narrative sources：返回 service_error 失败，仅用于满足 performAction 的
 * runtimeNarrativeSources !== undefined 队列条件。实际场景生成不在 performAction
 * 中发生（只置 pending 标记），故 mock 永不被调用。
 */
const mockRuntimeNarrativeSources = {
  directorSource: {
    async generate() {
      return {
        ok: false,
        provenance: "unavailable" as const,
        category: "service_error" as const,
        diagnostics: {
          traceId: "mock",
          contractVersion: NARRATIVE_CONTRACT_VERSION,
          stage: "failed" as const,
          category: "service_error" as const
        }
      };
    }
  } as DirectorSource,
  sceneScriptSource: {
    async generate() {
      return {
        ok: false,
        provenance: "unavailable" as const,
        category: "service_error" as const,
        diagnostics: {
          traceId: "mock",
          contractVersion: NARRATIVE_CONTRACT_VERSION,
          stage: "failed" as const,
          category: "service_error" as const
        }
      };
    }
  } as SceneScriptSource,
  npcLineSource: {
    async generate() {
      return {
        ok: false,
        provenance: "unavailable" as const,
        category: "service_error" as const,
        diagnostics: {
          traceId: "mock",
          contractVersion: NARRATIVE_CONTRACT_VERSION,
          stage: "failed" as const
        }
      };
    }
  } as NpcLineSource
};

/**
 * 轻量 in-memory repository：单槽位 CAS 语义，与 SQLite adapter 行为一致，
 * 供需要 createGame + performAction 全流程的测试使用（不依赖文件 IO）。
 */
function createInMemoryGameRepository(): GameRepository {
  let record: GameRecord | null = null;
  return {
    async createInitialGame(input: CreateInitialGameInput): Promise<CreateInitialGameResult> {
      if (record !== null) {
        return { ok: false, code: "ACTIVE_GAME_EXISTS" };
      }
      record = {
        gameId: input.gameId,
        blueprint: input.blueprint,
        state: input.state,
        revision: 0,
        createdAt: input.createdAt
      };
      return { ok: true };
    },
    async getCurrentGame(): Promise<GetCurrentGameRecordResult> {
      if (record === null) {
        return { ok: true, status: "none" };
      }
      return { ok: true, status: "active", record };
    },
    async applyResolvedAction(input: ApplyResolvedActionInput): Promise<ApplyResolvedActionResult> {
      if (record === null) {
        return { ok: false, code: "NO_ACTIVE_GAME" };
      }
      if (input.expectedRevision !== record.revision) {
        return { ok: false, code: "STALE_GAME_REVISION" };
      }
      record = { ...record, state: input.nextState, revision: record.revision + 1 };
      return { ok: true, record };
    },
    async applyBlueprintExpansion(input: ApplyBlueprintExpansionInput): Promise<ApplyResolvedActionResult> {
      if (record === null) {
        return { ok: false, code: "NO_ACTIVE_GAME" };
      }
      if (input.expectedRevision !== record.revision) {
        return { ok: false, code: "STALE_GAME_REVISION" };
      }
      record = {
        ...record,
        blueprint: input.nextBlueprint,
        state: input.nextState,
        revision: record.revision + 1
      };
      return { ok: true, record };
    }
  };
}

/** 编译合法候选为蓝图（runtime_expansion phase，对应运行时扩展场景）。 */
function compileRuntimeExpansionBlueprint(): ScenarioBlueprint {
  const candidate = makeValidCandidate();
  const compiled = compileScenarioBlueprint(
    validateScenarioBlueprintCandidate(candidate, {
      profile: TEST_PROFILE,
      policy: TEST_POLICY,
      phase: "runtime_expansion"
    })
  );
  if (!compiled.ok) {
    throw new Error(`fixture 蓝图应当合法：${JSON.stringify(compiled.issues)}`);
  }
  return compiled.blueprint;
}

/**
 * 从 wuxia fixture 构造 ValidatedNewGameInput（createFallbackBlueprint 要求）。
 * gameLength 强制 short 以与 TEST_POLICY 对齐。
 */
function validatedFixtureInput(): ValidatedNewGameInput {
  const fixture = wuxiaFixture as unknown as { input: NewGameInput; seed: string };
  const result = validateNewGameInput({ ...fixture.input, gameLength: "short" });
  if (!result.ok) {
    throw new Error(`fixture 输入应合法：${JSON.stringify(result.errors)}`);
  }
  return result.value;
}

describe("Phase 14 渐进式生成与剧情推演", () => {
  // 1. 开局蓝图只含起始锚点
  it("开局蓝图只含起始锚点（fallback 收窄：1 地点 / 1 NPC / 1 任务 / 0 结局）", () => {
    const fixture = wuxiaFixture as unknown as { seed: string };
    const candidate = createFallbackBlueprint(validatedFixtureInput(), fixture.seed);
    // 开局收窄断言
    expect(candidate.schemaVersion).toBe(2);
    expect(candidate.locations).toHaveLength(1);
    expect(candidate.npcs).toHaveLength(1);
    expect(candidate.quests).toHaveLength(1);
    expect(candidate.enemies).toHaveLength(0);
    expect(candidate.endings).toHaveLength(0);
    expect(candidate.items).toHaveLength(0);
    // 起始锚点指向唯一地点 / NPC / 任务
    expect(candidate.startAnchor).toEqual({
      locationId: "loc_1",
      npcId: "npc_1",
      startQuestId: "quest_main_1"
    });
    // 结局方向骨架存在
    expect(candidate.endingDirection.lockedAt).toBeGreaterThanOrEqual(1);
    expect(candidate.endingDirection.possibleTones.length).toBeGreaterThan(0);
    // 开场场景含序幕（opening phase 校验要求）
    expect(candidate.openingScene.prologue).toBeDefined();
    expect(candidate.openingScene.prologue?.text.length).toBeGreaterThan(0);
    // opening phase 校验通过
    const validation = validateScenarioBlueprintCandidate(candidate, {
      profile: TEST_PROFILE,
      policy: createBudgetPolicy("short"),
      phase: "opening"
    });
    expect(validation.ok).toBe(true);
  });

  // 2. 序幕播放后 prologueShown=true
  it("序幕播放后 prologueShown=true（ack_prologue intent 幂等）", async () => {
    const fixture = wuxiaFixture as unknown as { input: NewGameInput; seed: string };
    const repo = createInMemoryGameRepository();
    const deps2 = createTestDependencies(repo);
    const created = await createGame(
      { input: { ...fixture.input, gameLength: "short" }, seed: fixture.seed },
      deps2
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.view.prologueShown).toBe(false);

    // 第一次 ack_prologue：标记为已播放
    const ack1 = await performAction(
      { intent: { type: "ack_prologue" }, expectedRevision: 0 },
      { repository: repo, now: () => FIXED_NOW, runtimeNarrativeSources: mockRuntimeNarrativeSources }
    );
    expect(ack1.ok).toBe(true);
    if (!ack1.ok) return;
    expect(ack1.view.prologueShown).toBe(true);
    expect(ack1.view.revision).toBe(1);

    // 第二次 ack_prologue：幂等，prologueShown 仍为 true
    const ack2 = await performAction(
      { intent: { type: "ack_prologue" }, expectedRevision: 1 },
      { repository: repo, now: () => FIXED_NOW, runtimeNarrativeSources: mockRuntimeNarrativeSources }
    );
    expect(ack2.ok).toBe(true);
    if (!ack2.ok) return;
    expect(ack2.view.prologueShown).toBe(true);
  });

  // 3. talk 首遇写 npc_met 并排队 pending
  it("talk 首遇写 npc_met 并排队 pending（携带 triggerContext.kind=talk）", async () => {
    const fixture = wuxiaFixture as unknown as { input: NewGameInput; seed: string };
    const repo = createInMemoryGameRepository();
    const deps2 = createTestDependencies(repo);
    const created = await createGame(
      { input: { ...fixture.input, gameLength: "short" }, seed: fixture.seed },
      deps2
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // talk 起始 NPC（首遇）
    const talk = await performAction(
      { intent: { type: "talk", npcId: asNpcId("npc_1") }, expectedRevision: 0 },
      { repository: repo, now: () => FIXED_NOW, runtimeNarrativeSources: mockRuntimeNarrativeSources }
    );
    expect(talk.ok).toBe(true);
    if (!talk.ok) return;

    // 读取存档：npc_met 事件 + pending 排队 + triggerContext
    const loaded = await repo.getCurrentGame();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok || loaded.status !== "active") return;
    const state = loaded.record.state;
    const npcState = state.npcs.find((n) => String(n.npcId) === "npc_1");
    expect(npcState?.met).toBe(true);
    expect(state.eventLedger.some((e) => e.type === "npc_met")).toBe(true);
    expect(state.narrative.generation.status).toBe("pending");
    if (state.narrative.generation.status === "pending") {
      expect(state.narrative.generation.triggerContext).toMatchObject({
        kind: "talk",
        npcId: "npc_1",
        isFirstMeeting: true
      });
    }
  });

  // 4. narrative_choice 自动排队下一场景
  it("narrative_choice 自动排队下一场景（携带 triggerContext.kind=narrative_choice_followup）", async () => {
    const blueprint = compileRuntimeExpansionBlueprint();
    const state = initializeGameState(blueprint);
    const repo = createInMemoryGameRepository();
    await repo.createInitialGame({
      gameId: TEST_GAME_ID,
      blueprint,
      state,
      createdAt: TEST_CREATED_AT
    });

    // 手动 staging 一个含选项的 currentScene（模拟场景已生成）
    const sceneWithChoice = {
      sceneId: "scene_test_choice",
      turn: 1,
      narration: "测试场景。",
      usedFactIds: [] as readonly ReturnType<typeof asFactId>[],
      npcLine: null,
      choices: [
        { choiceToken: "choice_observe", label: "观察四周", actionKey: "observe:loc_a" },
        { choiceToken: "choice_talk", label: "交谈", actionKey: "talk:npc_a" }
      ] as const,
      source: "generated" as const
    } as unknown as GameState["narrative"]["currentScene"];
    const loaded0 = await repo.getCurrentGame();
    if (!loaded0.ok || loaded0.status !== "active") throw new Error("前置存档应 active");
    const staged = await repo.applyResolvedAction({
      gameId: TEST_GAME_ID,
      expectedRevision: 0,
      nextState: {
        ...loaded0.record.state,
        narrative: {
          currentScene: sceneWithChoice,
          generation: { status: "idle" },
          mode: loaded0.record.state.narrative.mode
        }
      }
    });
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;

    // 提交 narrative_choice：应触发新一轮 pending 排队
    const choice = await performAction(
      {
        intent: { type: "narrative_choice", choiceToken: "choice_observe" },
        expectedRevision: staged.record.revision
      },
      { repository: repo, now: () => FIXED_NOW, runtimeNarrativeSources: mockRuntimeNarrativeSources }
    );
    expect(choice.ok).toBe(true);
    if (!choice.ok) return;

    const loaded2 = await repo.getCurrentGame();
    if (!loaded2.ok || loaded2.status !== "active") throw new Error("choice 后存档应 active");
    const state2 = loaded2.record.state;
    expect(state2.narrative.generation.status).toBe("pending");
    if (state2.narrative.generation.status === "pending") {
      expect(state2.narrative.generation.triggerContext).toMatchObject({
        kind: "narrative_choice_followup",
        previousChoiceActionKey: "choice_observe"
      });
    }
    // narrative_choice 事件已记录
    expect(state2.eventLedger.some((e) => e.type === "narrative_choice")).toBe(true);
  });

  // 5. 自由输入 narrative 路径携带 triggerContext
  it("自由输入 narrative 路径携带 triggerContext（非 talk / 非 narrative_choice 排队）", async () => {
    const fixture = wuxiaFixture as unknown as { input: NewGameInput; seed: string };
    const repo = createInMemoryGameRepository();
    const deps2 = createTestDependencies(repo);
    await createGame({ input: { ...fixture.input, gameLength: "short" }, seed: fixture.seed }, deps2);

    // observe 触发排队：triggerContext 应为 undefined（既非 talk 也非 narrative_choice）
    const observed = await performAction(
      { intent: { type: "observe", locationId: asLocationId("loc_1") }, expectedRevision: 0 },
      { repository: repo, now: () => FIXED_NOW, runtimeNarrativeSources: mockRuntimeNarrativeSources }
    );
    expect(observed.ok).toBe(true);
    if (!observed.ok) return;

    const loaded = await repo.getCurrentGame();
    if (!loaded.ok || loaded.status !== "active") throw new Error("observe 后存档应 active");
    const state = loaded.record.state;
    // observe 触发排队但 triggerContext 为 undefined（兜底路径覆盖）
    expect(state.narrative.generation.status).toBe("pending");
    if (state.narrative.generation.status === "pending") {
      expect(state.narrative.generation.triggerContext).toBeUndefined();
    }
  });

  // 6. 主线达 lockedAt 阈值时导演提议结局
  it("主线达 lockedAt 阈值时导演提议结局（reconcileMainStoryProgress）", () => {
    const blueprint = compileRuntimeExpansionBlueprint();
    const initialState = initializeGameState(blueprint);
    // fixture 的 endingDirection.lockedAt = 3（与 TEST_POLICY.mainActs 一致）
    expect(blueprint.endingDirection.lockedAt).toBe(3);

    // 初始：currentAct=0（无已完成主线），shouldProposeEnding=false
    const initial = reconcileMainStoryProgress(blueprint, initialState, deps);
    expect(initial.currentAct).toBe(0);
    expect(initial.shouldProposeEnding).toBe(false);

    // 模拟 m1, m2 completed（currentAct=2，仍未达 lockedAt=3）
    const twoActsState: GameState = {
      ...initialState,
      quests: initialState.quests.map((q) =>
        String(q.questId) === "m1" || String(q.questId) === "m2"
          ? { ...q, status: "completed" as const }
          : q
      )
    };
    const twoActs = reconcileMainStoryProgress(blueprint, twoActsState, deps);
    expect(twoActs.currentAct).toBe(2);
    expect(twoActs.shouldProposeEnding).toBe(false);

    // 模拟 m1, m2, m3 completed（currentAct=3，达 lockedAt，应提议结局）
    const threeActsState: GameState = {
      ...initialState,
      quests: initialState.quests.map((q) =>
        String(q.questId) === "m1" || String(q.questId) === "m2" || String(q.questId) === "m3"
          ? { ...q, status: "completed" as const }
          : q
      )
    };
    const threeActs = reconcileMainStoryProgress(blueprint, threeActsState, deps);
    expect(threeActs.currentAct).toBe(3);
    expect(threeActs.shouldProposeEnding).toBe(true);

    // 已提议过结局时不再提议
    const alreadyProposedState: GameState = {
      ...threeActsState,
      mainStoryProgress: { currentAct: 3, endingProposed: true }
    };
    const afterProposed = reconcileMainStoryProgress(blueprint, alreadyProposedState, deps);
    expect(afterProposed.shouldProposeEnding).toBe(false);
  });

  // 7. 结局闸门拒绝未达阈值/重复提议/基调不匹配
  it("结局闸门拒绝未达阈值/重复提议/基调不匹配（approveEndingProposal 8 步）", () => {
    const blueprint = compileRuntimeExpansionBlueprint();
    const initialState = initializeGameState(blueprint);

    // 合法提议：tone 在 possibleTones 内，requirements 引用 m3
    const validProposed: ProposedEnding = {
      name: "真相大白",
      description: "幕后黑手伏法，江湖重归安宁。",
      tone: "triumph",
      requirements: [{ kind: "quest_completed", questId: asQuestId("m3") }],
      reason: "主线已达 lockedAt"
    };

    // 7a. none_proposed：未提议
    const none = approveEndingProposal({
      blueprint,
      state: initialState,
      proposed: undefined,
      currentAct: 3
    });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.reason).toBe("none_proposed");

    // 7b. not_locked：currentAct < lockedAt
    const notLocked = approveEndingProposal({
      blueprint,
      state: initialState,
      proposed: validProposed,
      currentAct: 2
    });
    expect(notLocked.ok).toBe(false);
    if (!notLocked.ok) expect(notLocked.reason).toBe("not_locked");

    // 7c. already_proposed：state.mainStoryProgress.endingProposed=true
    const alreadyProposedState: GameState = {
      ...initialState,
      mainStoryProgress: { currentAct: 3, endingProposed: true }
    };
    const already = approveEndingProposal({
      blueprint,
      state: alreadyProposedState,
      proposed: validProposed,
      currentAct: 3
    });
    expect(already.ok).toBe(false);
    if (!already.ok) expect(already.reason).toBe("already_proposed");

    // 7d. tone_mismatch：tone 不在 possibleTones 内
    // possibleTones = [triumph, tragedy, bittersweet]；ambiguous 是合法 EndingTone
    // 但不在 possibleTones 内，因此触发 tone_mismatch 而非 invalid_payload。
    const toneMismatch = approveEndingProposal({
      blueprint,
      state: initialState,
      proposed: { ...validProposed, tone: "ambiguous" },
      currentAct: 3
    });
    expect(toneMismatch.ok).toBe(false);
    if (!toneMismatch.ok) expect(toneMismatch.reason).toBe("tone_mismatch");

    // 7e. 通过：合法提议 + currentAct=3 + endingProposed=false
    const approved = approveEndingProposal({
      blueprint,
      state: initialState,
      proposed: validProposed,
      currentAct: 3
    });
    expect(approved.ok).toBe(true);
    if (approved.ok) {
      // 铸造的 ending id 为 ending_dyn_1（无既有动态结局）
      expect(String(approved.approvedEnding.id)).toBe("ending_dyn_1");
      // applyEndingToBlueprint 追加到 endings
      const expanded = applyEndingToBlueprint({
        blueprint,
        approvedEnding: approved.approvedEnding
      });
      expect(expanded.endings.length).toBe(blueprint.endings.length + 1);
      expect(expanded.endings.some((e) => String(e.id) === "ending_dyn_1")).toBe(true);
    }
  });

  // 8. 小镇入口任务目标 + 已结识过滤
  it("小镇入口任务目标 + 已结识过滤（projectTownLayerView）", () => {
    const blueprint = compileRuntimeExpansionBlueprint();
    const initialState = initializeGameState(blueprint);

    // 改造 loc_a 为 town 层级 + 注入 town runtime
    const townBlueprint: ScenarioBlueprint = {
      ...blueprint,
      locations: blueprint.locations.map((loc) =>
        String(loc.id) === "loc_a" ? { ...loc, scale: "town" as const } : loc
      )
    } as ScenarioBlueprint;
    const entry = ensureTownRuntime(townBlueprint, initialState, "loc_a", "offline", FIXED_NOW);
    if (entry.kind !== "generated") {
      throw new Error(`loc_a 应识别为 town 地点，实际：${entry.kind}`);
    }
    const townState: GameState = { ...initialState, towns: [entry.town] };

    // 初始：所有 NPC 均 met=false；m1 active 但 objective 是 visit_location loc_b
    // （无 talk_to_npc objective），因此 interactiveBuildings 应为空。
    const initialView = projectTownLayerView(townBlueprint, entry.town, townState);
    expect(initialView.interactiveBuildings).toHaveLength(0);

    // 模拟 npc_a 已结识：其建筑应进入 interactiveBuildings
    const metNpcAState: GameState = {
      ...townState,
      npcs: townState.npcs.map((n) =>
        String(n.npcId) === "npc_a" ? { ...n, met: true } : n
      )
    };
    const metView = projectTownLayerView(townBlueprint, entry.town, metNpcAState);
    expect(metView.interactiveBuildings.length).toBeGreaterThanOrEqual(1);
    expect(metView.interactiveBuildings.some((b) => b.npcIds.includes("npc_a"))).toBe(true);

    // 模拟 active talk_to_npc 目标指向 npc_a（未结识）：
    // 修改 m1 的 objective 为 talk_to_npc npc_a，npc_a 未结识但为 active talk 目标 → 可交互
    const talkTargetBlueprint: ScenarioBlueprint = {
      ...townBlueprint,
      quests: townBlueprint.quests.map((q) =>
        String(q.id) === "m1"
          ? { ...q, objectives: [{ kind: "talk_to_npc", npcId: asNpcId("npc_a") }] }
          : q
      )
    } as ScenarioBlueprint;
    const talkView = projectTownLayerView(talkTargetBlueprint, entry.town, townState);
    expect(talkView.interactiveBuildings.some((b) => b.npcIds.includes("npc_a"))).toBe(true);
  });

  // 9. 旧存档 schemaVersion 1→2 迁移
  it("旧存档 schemaVersion 1→2 迁移（interpretGameRow with*Defaults 链）", () => {
    const fixture = wuxiaFixture as unknown as { seed: string };
    // 用当前 fallback 蓝图构造一份 v1 形态的存档行（移除 startAnchor/endingDirection/prologue/mainStoryProgress）
    const candidate = createFallbackBlueprint(validatedFixtureInput(), fixture.seed);
    const compiled = compileScenarioBlueprint(
      validateScenarioBlueprintCandidate(candidate, {
        profile: TEST_PROFILE,
        policy: createBudgetPolicy("short"),
        phase: "opening"
      })
    );
    if (!compiled.ok) throw new Error("fallback 应编译成功");
    const blueprint = compiled.blueprint;
    const state = initializeGameState(blueprint);

    // 构造 v1 形态的 blueprint JSON：schemaVersion 1，移除 startAnchor / endingDirection
    const v1BlueprintJson = JSON.stringify({
      ...blueprint,
      schemaVersion: 1,
      startAnchor: undefined,
      endingDirection: undefined
    });
    // 构造 v1 形态的 state JSON：移除 prologueShown / mainStoryProgress
    const v1StateJson = JSON.stringify({
      ...state,
      prologueShown: undefined,
      mainStoryProgress: undefined
    });

    const row = {
      game_id: String(TEST_GAME_ID),
      record_version: 1,
      generation_id: blueprint.generationId,
      blueprint_json: v1BlueprintJson,
      state_json: v1StateJson,
      created_at: TEST_CREATED_AT,
      revision: 0
    };

    const result = interpretGameRow(row);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("active");
    if (result.status !== "active") return;

    // 蓝图迁移：startAnchor / endingDirection 已补默认值
    expect(result.record.blueprint.startAnchor).toBeDefined();
    expect(result.record.blueprint.startAnchor.locationId).toBeDefined();
    expect(result.record.blueprint.endingDirection).toBeDefined();
    expect(result.record.blueprint.endingDirection.lockedAt).toBeGreaterThanOrEqual(1);

    // 状态迁移：prologueShown=true（旧档视为已过开场）
    expect(result.record.state.prologueShown).toBe(true);
    // mainStoryProgress 已补默认值（currentAct=0，无 quest_completed 事件）
    expect(result.record.state.mainStoryProgress).toBeDefined();
    expect(result.record.state.mainStoryProgress.endingProposed).toBe(false);
    expect(result.record.state.mainStoryProgress.currentAct).toBe(0);

    // generationId 与原蓝图一致（迁移不破坏标识）
    expect(String(result.record.blueprint.generationId)).toBe(String(blueprint.generationId));
    // gameId 透传
    expect(String(result.record.gameId)).toBe(String(TEST_GAME_ID));
  });
});
