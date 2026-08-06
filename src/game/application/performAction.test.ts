import { describe, expect, it } from "vitest";
import {
  asItemId,
  asLocationId,
  asNpcId,
  asQuestId,
  type GameState,
  type ScenarioBlueprint
} from "@/game/domain";
import { resolveAction, type PlayerIntent } from "@/game/gameplay/rpg/actions";
import { reconcileMainStoryProgress, reconcileQuests } from "@/game/gameplay/rpg/quests";
import { reconcileStoryMemory } from "@/game/gameplay/rpg/narrative";
import { initializeGameState } from "@/game/gameplay/rpg/scenario";
import { makeValidCandidate } from "@/game/gameplay/rpg/scenario/scenarioBlueprintFixture.testutil";
import { performAction, type PerformActionDependencies } from "./performAction";
import { canQueueRuntimeNarrativeScene } from "./runtimeNarrativeEligibility";
import {
  createFakeGameRepository,
  TEST_CREATED_AT,
  TEST_GAME_ID
} from "./applicationFixture.testutil";
import {
  type ApplyResolvedActionResult,
  type GameRecord,
  type GameRepository,
} from "./server/persistence/gameRepository";

// ---------------------------------------------------------------------------
// Phase 3 Task 4：performAction use case 契约测试。
// 覆盖 plan 要求：成功行动投影最新 view + 反馈；拒绝不写入；陈旧 revision；
// 无存档/损坏/基础设施失败映射稳定结果；注入时钟可重复；不泄漏 SQL/state/seed。
// ---------------------------------------------------------------------------

// Phase 14 开局收窄后，fallback 蓝图仅含起始锚点（loc_1/npc_1/quest_main_1）。
// 本文件的契约测试需要"运行时扩展后"的完整蓝图：以 makeValidCandidate 为基座
// 恢复测试引用的预存实体（town 地点 loc_2、后继地点 loc_3、npc_3、item_key、
// 任务链），并让 move 到 loc_2 能完成 visit_location 前置阶段。
const PIPELINE = buildRuntimePipeline();

const FIXED_TIME = "2026-07-27T10:00:00.000Z";

/**
 * 构造"运行时扩展后"的完整蓝图与初始状态。
 *
 * Phase 14 的 fallback 开局蓝图只有起始锚点；本文件的契约测试（move 到
 * loc_2、take item_key、talk npc_3、town 层懒生成等）依赖旧版完整预存数据，
 * 因此以 makeValidCandidate 为基座恢复多地点/NPC/物品并定制任务链：
 *   - m1（主线 1）：与开场 NPC 交谈（talk npc_1 → 完成）；
 *   - quest_visit（side，初始 active）：访问 loc_2 → 解锁 m2；
 *   - m2（主线 2）：talk npc_3 + 取得 item_key → 解锁 m3；
 *   - m3（主线 3）：击败最终敌人。
 * loc_2 标记为 scale="town"，供 town 层懒生成测试使用。
 */
function buildRuntimePipeline(): { blueprint: ScenarioBlueprint; state: GameState } {
  const candidate = makeValidCandidate();
  const blueprint = {
    ...candidate,
    locations: candidate.locations.map((location) =>
      location.id === "loc_b" ? { ...location, scale: "town" } : location
    ),
    quests: [
      {
        kind: "main",
        stage: 1,
        id: "m1",
        name: "旧案重启",
        description: "向老掌柜打听灭门案线索。",
        objectives: [{ kind: "talk_to_npc", npcId: "npc_a" }],
        onSuccess: { kind: "closed" },
        onFailure: { kind: "closed" },
        tags: []
      },
      {
        kind: "side",
        id: "quest_visit",
        name: "前往渡口",
        description: "前往渡口集市打探灭门案线索。",
        objectives: [{ kind: "visit_location", locationId: "loc_b" }],
        onSuccess: { kind: "unlock_quests", questIds: ["m2"] },
        onFailure: { kind: "closed" },
        tags: []
      },
      ...candidate.quests.filter((quest) => quest.id !== "m1")
    ]
  } as unknown as ScenarioBlueprint;
  const base = initializeGameState(blueprint);
  return {
    blueprint,
    state: {
      ...base,
      // quest_visit 是 side 任务，initializeGameState 默认置 locked；
      // move 到 loc_2 的 visit_location 前置阶段需要它初始 active。
      quests: base.quests.map((quest) =>
        quest.questId === "quest_visit" ? { ...quest, status: "active" } : quest
      )
    }
  };
}

function buildActiveRecord(): GameRecord {
  return {
    gameId: TEST_GAME_ID,
    blueprint: PIPELINE.blueprint,
    state: PIPELINE.state,
    revision: 0,
    createdAt: TEST_CREATED_AT
  };
}

function buildPerformDeps(
  repository: ReturnType<typeof createFakeGameRepository>,
  overrides: Partial<PerformActionDependencies> = {}
): PerformActionDependencies {
  return {
    repository,
    now: () => FIXED_TIME,
    ...overrides
  };
}

describe("performAction：成功行动", () => {
  it("observe 成功：revision 递增，view 更新，反馈确定", async () => {
    const repository = createFakeGameRepository();
    const record = buildActiveRecord();
    repository.setCurrentResult({
      ok: true,
      status: "active",
      record
    });

    const updatedState = {
      ...record.state,
      eventLedger: [
        ...record.state.eventLedger,
        {
          type: "location_observed" as const,
          locationId: record.state.currentLocationId,
          occurredAt: FIXED_TIME
        }
      ]
    };
    const applyResult: ApplyResolvedActionResult = {
      ok: true,
      record: { ...record, state: updatedState, revision: 1 }
    };
    repository.setApplyResult(applyResult);

    const result = await performAction(
      {
        intent: { type: "observe", locationId: record.state.currentLocationId },
        expectedRevision: 0
      },
      buildPerformDeps(repository)
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.view.revision).toBe(1);
    expect(result.feedback.ok).toBe(true);
    expect(result.feedback.message).toBeTruthy();
    // availableActions 应反映已观察后的状态（observe 不再可用）。
    const observeActions = result.view.availableActions.filter((a) => a.type === "observe");
    expect(observeActions).toHaveLength(0);
    // knownFacts 只含已发现事实，不泄漏未发现事实。
    expect(result.view.knownFacts.length).toBeGreaterThan(0);
  });

  it("repository.applyResolvedAction 收到正确的 gameId 和 expectedRevision", async () => {
    const repository = createFakeGameRepository();
    repository.setCurrentResult({
      ok: true,
      status: "active",
      record: buildActiveRecord()
    });
    repository.setApplyResult({
      ok: true,
      record: { ...buildActiveRecord(), revision: 1 }
    });

    await performAction(
      {
        intent: { type: "observe", locationId: PIPELINE.state.currentLocationId },
        expectedRevision: 0
      },
      buildPerformDeps(repository)
    );

    expect(repository.applyCalls).toHaveLength(1);
    expect(repository.applyCalls[0].gameId).toBe(TEST_GAME_ID);
    expect(repository.applyCalls[0].expectedRevision).toBe(0);
  });
});

describe("performAction：pending 叙事任务", () => {
  it("场景尚未 ready 时拒绝任何规则推进，且零写入", async () => {
    const repository = createFakeGameRepository();
    const base = buildActiveRecord();
    const record: GameRecord = {
      ...base,
      state: {
        ...base.state,
        narrative: {
          currentScene: null,
          generation: { status: "pending", requestedAt: FIXED_TIME },
          mode: "ai",
        },
      },
    };
    repository.setCurrentResult({ ok: true, status: "active", record });

    const result = await performAction(
      { intent: { type: "observe", locationId: record.state.currentLocationId }, expectedRevision: 0 },
      buildPerformDeps(repository),
    );

    expect(result).toMatchObject({ ok: false, code: "ACTION_REJECTED" });
    expect(repository.applyCalls).toHaveLength(0);
  });
});

describe("performAction：move + 任务 reconciliation 单次写入（Phase 4 Task 3）", () => {
  it("applyResolvedAction 收到 reconcile 后的最终 state：move 与 quest 事件同一次写入", async () => {
    const repository = createFakeGameRepository();
    const record = buildActiveRecord();
    repository.setCurrentResult({ ok: true, status: "active", record });

    // 独立复跑 actions + quests facade 得到期望的最终 state。
    const moveIntent = { type: "move" as const, locationId: asLocationId("loc_b") };
    const resolved = resolveAction(record.blueprint, record.state, moveIntent, {
      now: () => FIXED_TIME
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const reconciled = reconcileQuests(record.blueprint, resolved.state, {
      now: () => FIXED_TIME
    });
    expect(reconciled.events.length).toBeGreaterThan(0);
    // performAction 在 reconciliation 后派生写回 currentAct（Phase 14 spec §405），
    // 独立复跑同步对齐该行为，保证载荷比较与真实写入一致。
    const expectedState = {
      ...reconciled.state,
      mainStoryProgress: {
        ...reconciled.state.mainStoryProgress,
        currentAct: reconcileMainStoryProgress(record.blueprint, reconciled.state, {
          now: () => FIXED_TIME
        }).currentAct
      }
    };

    repository.setApplyResult({
      ok: true,
      record: { ...record, state: expectedState, revision: 1 }
    });

    const result = await performAction(
      { intent: moveIntent, expectedRevision: 0 },
      buildPerformDeps(repository)
    );

    expect(result.ok).toBe(true);
    // 恰好一次写入，且载荷已含任务事件与状态迁移（无第二次写入、无旁路）。
    // Town 层：loc_b 为 town 地点且存档为 ai 模式，performAction 在同一次写入中
    // 附加 pending 标记（Step 4.5 懒生成，见 town 层懒生成 describe）。
    expect(repository.applyCalls).toHaveLength(1);
    expect(repository.applyCalls[0].nextState).toEqual({
      ...expectedState,
      townGeneration: { status: "pending", locationId: asLocationId("loc_b"), requestedAt: FIXED_TIME },
      storyMemory: reconcileStoryMemory({ state: expectedState })
    });
    const ledger = repository.applyCalls[0].nextState.eventLedger;
    const tailTypes = ledger.slice(record.state.eventLedger.length).map((event) => event.type);
    expect(tailTypes[0]).toBe("location_visited");
    expect(tailTypes).toContain("quest_completed");
    expect(tailTypes).toContain("quest_unlocked");
  });

  it("任务 reconciliation 契约外抛错 ⇒ INFRASTRUCTURE_FAILURE 且零写入", async () => {
    const repository = createFakeGameRepository();
    const record = buildActiveRecord();
    // 构造 quests 字段缺失的坏状态：resolver 可通过，但 reconciliation 会抛 TypeError。
    const brokenState = { ...record.state, quests: undefined } as unknown as GameState;
    repository.setCurrentResult({
      ok: true,
      status: "active",
      record: { ...record, state: brokenState }
    });

    const result = await performAction(
      { intent: { type: "move", locationId: asLocationId("loc_b") }, expectedRevision: 0 },
      buildPerformDeps(repository)
    );

    expect(result).toEqual({ ok: false, code: "INFRASTRUCTURE_FAILURE" });
    expect(repository.applyCalls).toHaveLength(0);
  });

  it("陈旧 revision + 损坏记录时场景投影抛错 ⇒ INFRASTRUCTURE_FAILURE 且零写入", async () => {
    const repository = createFakeGameRepository();
    const record = buildActiveRecord();
    // currentLocationId 悬挂：投影当前 view 时 requireEntity 抛错，
    // 必须映射稳定基础设施失败，不得向 API 层抛异常文本。
    const danglingState = {
      ...record.state,
      currentLocationId: asLocationId("loc-does-not-exist")
    };
    repository.setCurrentResult({
      ok: true,
      status: "active",
      record: { ...record, state: danglingState, revision: 5 }
    });

    const result = await performAction(
      { intent: { type: "move", locationId: asLocationId("loc_b") }, expectedRevision: 0 },
      buildPerformDeps(repository)
    );

    expect(result).toEqual({ ok: false, code: "INFRASTRUCTURE_FAILURE" });
    expect(repository.applyCalls).toHaveLength(0);
  });
});

describe("performAction：take_item + 任务 reconciliation 单次写入（Phase 5 Task 3）", () => {
  const ruleDeps = { now: () => FIXED_TIME };

  /** 走真实规则管线推进到 stage-2 就绪：loc_b → loc_c → talk npc_c（未取物品）。 */
  function buildStageTwoReadyState(): GameState {
    const intents: readonly PlayerIntent[] = [
      { type: "move", locationId: asLocationId("loc_b") },
      { type: "move", locationId: asLocationId("loc_c") },
      { type: "talk", npcId: asNpcId("npc_c") }
    ];
    let state = PIPELINE.state;
    for (const intent of intents) {
      const resolved = resolveAction(PIPELINE.blueprint, state, intent, ruleDeps);
      if (!resolved.ok) throw new Error(`前置行动应当成功：${resolved.code}`);
      state = reconcileQuests(PIPELINE.blueprint, resolved.state, ruleDeps).state;
    }
    return state;
  }

  it("applyResolvedAction 收到含 item_obtained + quest_completed + quest_unlocked 的最终 state，仅一次写入", async () => {
    const repository = createFakeGameRepository();
    const readyState = buildStageTwoReadyState();
    const record = { ...buildActiveRecord(), state: readyState, revision: 3 };
    repository.setCurrentResult({ ok: true, status: "active", record });

    // 独立复跑 actions + quests facade 得到期望的最终 state。
    const takeIntent: PlayerIntent = { type: "take_item", itemId: asItemId("item_b") };
    const resolved = resolveAction(record.blueprint, readyState, takeIntent, ruleDeps);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const reconciled = reconcileQuests(record.blueprint, resolved.state, ruleDeps);
    repository.setApplyResult({
      ok: true,
      record: { ...record, state: reconciled.state, revision: 4 }
    });

    const result = await performAction(
      { intent: takeIntent, expectedRevision: 3 },
      buildPerformDeps(repository)
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 恰好一次写入：行动事件、完成事件与三阶段解锁事件全在同一份载荷。
    expect(repository.applyCalls).toHaveLength(1);
    expect(repository.applyCalls[0].nextState).toEqual({
      ...reconciled.state,
      storyMemory: reconcileStoryMemory({ state: reconciled.state })
    });
    const tailTypes = repository.applyCalls[0].nextState.eventLedger
      .slice(readyState.eventLedger.length)
      .map((event) => event.type);
    expect(tailTypes).toEqual(["item_obtained", "quest_completed", "quest_unlocked"]);
    const statusById = new Map(
      repository.applyCalls[0].nextState.quests.map((quest) => [quest.questId, quest.status])
    );
    expect(statusById.get(asQuestId("m2"))).toBe("completed");
    expect(statusById.get(asQuestId("m3"))).toBe("active");
    // 已保存 state 投影的 view：背包收录 key 物品，可取得列表清空。
    expect(result.view.revision).toBe(4);
    expect(result.view.obtainableItems).toEqual([]);
    const keyItem = PIPELINE.blueprint.items.find((item) => item.id === asItemId("item_b"));
    // 背包已升级为富视图：附带展示元数据（契约详见 gameSessionView.test）。
    expect(result.view.inventoryItems).toContainEqual(
      expect.objectContaining({
        name: keyItem?.name,
        description: keyItem?.description,
        category: "quest",
        icon: "key"
      })
    );
  });

  it("已拥有物品的 take 被拒 ⇒ ACTION_REJECTED 且零写入", async () => {
    const repository = createFakeGameRepository();
    const readyState = buildStageTwoReadyState();
    const ownedState = {
      ...readyState,
      inventory: [...readyState.inventory, asItemId("item_b")]
    };
    repository.setCurrentResult({
      ok: true,
      status: "active",
      record: { ...buildActiveRecord(), state: ownedState, revision: 3 }
    });

    const result = await performAction(
      { intent: { type: "take_item", itemId: asItemId("item_b") }, expectedRevision: 3 },
      buildPerformDeps(repository)
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("ACTION_REJECTED");
    if (result.code !== "ACTION_REJECTED") return;
    expect(result.feedback.ok).toBe(false);
    expect(repository.applyCalls).toHaveLength(0);
  });

  it("repository.applyResolvedAction 抛错 ⇒ INFRASTRUCTURE_FAILURE（异常文本不外泄）", async () => {
    const repository = createFakeGameRepository();
    const readyState = buildStageTwoReadyState();
    repository.setCurrentResult({
      ok: true,
      status: "active",
      record: { ...buildActiveRecord(), state: readyState, revision: 3 }
    });
    const throwingRepository: GameRepository = {
      createInitialGame: (input) => repository.createInitialGame(input),
      getCurrentGame: () => repository.getCurrentGame(),
      applyResolvedAction: async () => {
        throw new Error("libsql 崩溃：disk I/O error");
      },
      applyBlueprintExpansion: async () => {
        throw new Error("libsql 崩溃：disk I/O error");
      }
    };

    const result = await performAction(
      { intent: { type: "take_item", itemId: asItemId("item_b") }, expectedRevision: 3 },
      { repository: throwingRepository, now: () => FIXED_TIME }
    );

    expect(result).toEqual({ ok: false, code: "INFRASTRUCTURE_FAILURE" });
  });
});

describe("performAction：talk 单次写入与零写入（Phase 14：dialogue_choice 废除后 talk 升级）", () => {
  const ruleDeps = { now: () => FIXED_TIME };

  it("成功对话：恰好一次 CAS，尾部 npc_met + quest_completed 事件", async () => {
    const repository = createFakeGameRepository();
    const record = buildActiveRecord();
    repository.setCurrentResult({ ok: true, status: "active", record });

    // Phase 14：talk 是唯一 NPC 交互触发器，首遇写 npc_met。
    const intent: PlayerIntent = {
      type: "talk",
      npcId: asNpcId("npc_a")
    };
    // 独立复跑 actions + quests facade 得到期望的最终 state。
    const resolved = resolveAction(record.blueprint, record.state, intent, ruleDeps);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const reconciled = reconcileQuests(record.blueprint, resolved.state, ruleDeps);
    repository.setApplyResult({
      ok: true,
      record: { ...record, state: reconciled.state, revision: 1 }
    });

    const result = await performAction(
      { intent, expectedRevision: 0 },
      buildPerformDeps(repository)
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 恰好一次写入，尾部 npc_met（talk）+ quest_completed（reconcileQuests）。
    expect(repository.applyCalls).toHaveLength(1);
    expect(repository.applyCalls[0].nextState).toEqual({
      ...reconciled.state,
      storyMemory: reconcileStoryMemory({ state: reconciled.state })
    });
    const tailTypes = repository.applyCalls[0].nextState.eventLedger
      .slice(record.state.eventLedger.length)
      .map((event) => event.type);
    expect(tailTypes).toEqual(["npc_met", "quest_completed"]);
    expect(result.feedback.ok).toBe(true);
    expect(result.feedback.message).toBeTruthy();
  });

  it("Phase 14：dialogue_choice 伪造载荷被拒 ⇒ ACTION_REJECTED 且零 CAS", async () => {
    const repository = createFakeGameRepository();
    const record = buildActiveRecord();
    repository.setCurrentResult({ ok: true, status: "active", record });

    const result = await performAction(
      {
        intent: {
          type: "dialogue_choice",
          npcId: asNpcId("npc_a"),
          choiceId: "npc_a:steal_items"
        } as unknown as PlayerIntent,
        expectedRevision: 0
      },
      buildPerformDeps(repository)
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("ACTION_REJECTED");
    if (result.code !== "ACTION_REJECTED") return;
    expect(result.feedback.ok).toBe(false);
    expect(repository.applyCalls).toHaveLength(0);
  });

  it("过期 talk（NPC 已结识）被拒 ⇒ ACTION_REJECTED 且零 CAS", async () => {
    const repository = createFakeGameRepository();
    const record = buildActiveRecord();
    const metState = {
      ...record.state,
      npcs: record.state.npcs.map((npc) =>
        npc.npcId === asNpcId("npc_a") ? { ...npc, met: true } : npc
      )
    };
    repository.setCurrentResult({
      ok: true,
      status: "active",
      record: { ...record, state: metState }
    });

    const result = await performAction(
      {
        intent: {
          type: "talk",
          npcId: asNpcId("npc_a")
        },
        expectedRevision: 0
      },
      buildPerformDeps(repository)
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("ACTION_REJECTED");
    if (result.code !== "ACTION_REJECTED") return;
    expect(result.feedback.ok).toBe(false);
    expect(repository.applyCalls).toHaveLength(0);
  });
});

describe("performAction：talk 触发 pending（NPC 对话驱动叙事场景）", () => {
  const ruleDeps = { now: () => FIXED_TIME };

  /** performAction 不会调用这些 source，仅作为已装配运行时叙事的标记。 */
  function fakeNarrativeSources() {
    return {
      directorSource: { async generate() { throw new Error("performAction 不得调用导演"); } },
      sceneScriptSource: { async generate() { throw new Error("performAction 不得调用编剧"); } },
      npcLineSource: { async generate() { throw new Error("performAction 不得调用 NPC 演员"); } },
    } as unknown as NonNullable<PerformActionDependencies["runtimeNarrativeSources"]>;
  }

  /** 真实规则管线推进到 loc_c：npc_c 未结识且有 active 主线 talk_to_npc 目标。 */
  function buildAskMainQuestReadyState(): GameState {
    const intents: readonly PlayerIntent[] = [
      { type: "move", locationId: asLocationId("loc_b") },
      { type: "move", locationId: asLocationId("loc_c") },
    ];
    let state = PIPELINE.state;
    for (const intent of intents) {
      const resolved = resolveAction(PIPELINE.blueprint, state, intent, ruleDeps);
      if (!resolved.ok) throw new Error(`前置行动应当成功：${resolved.code}`);
      state = reconcileQuests(PIPELINE.blueprint, resolved.state, ruleDeps).state;
    }
    return state;
  }

  it("直接规则行动在 AI 模式且仍有两个合法行动时也排队下一幕", async () => {
    const repository = createFakeGameRepository();
    const record = buildActiveRecord();
    repository.setCurrentResult({ ok: true, status: "active", record });
    repository.setApplyResult({ ok: true, record: { ...record, revision: 1 } });

    const result = await performAction(
      {
        intent: { type: "observe", locationId: record.state.currentLocationId },
        expectedRevision: 0
      },
      buildPerformDeps(repository, { runtimeNarrativeSources: fakeNarrativeSources() })
    );

    expect(result.ok).toBe(true);
    expect(repository.applyCalls).toHaveLength(1);
    const saved = repository.applyCalls[0].nextState;
    expect(saved.narrative.generation.status).toBe("pending");
    expect(saved.narrative.currentScene).toBeNull();
  });

  it("talk（首遇主线 NPC）且 canQueueRuntimeNarrativeScene → 排队 pending", async () => {
    const repository = createFakeGameRepository();
    const readyState = buildAskMainQuestReadyState();
    const record = { ...buildActiveRecord(), state: readyState, revision: 2 };
    repository.setCurrentResult({ ok: true, status: "active", record });
    repository.setApplyResult({ ok: true, record: { ...record, revision: 3 } });

    const result = await performAction(
      {
        intent: { type: "talk", npcId: asNpcId("npc_c") },
        expectedRevision: 2
      },
      buildPerformDeps(repository, { runtimeNarrativeSources: fakeNarrativeSources() })
    );

    expect(result.ok).toBe(true);
    expect(repository.applyCalls).toHaveLength(1);
    const saved = repository.applyCalls[0].nextState;
    expect(saved.narrative.generation.status).toBe("pending");
    if (saved.narrative.generation.status !== "pending") return;
    expect(saved.narrative.generation.requestedAt).toBe(FIXED_TIME);
    expect(saved.narrative.currentScene).toBeNull();
  });

  it("talk（首次）且 canQueueRuntimeNarrativeScene → 排队 pending", async () => {
    const repository = createFakeGameRepository();
    const record = buildActiveRecord();
    repository.setCurrentResult({ ok: true, status: "active", record });
    repository.setApplyResult({ ok: true, record: { ...record, revision: 1 } });

    const result = await performAction(
      {
        intent: { type: "talk", npcId: asNpcId("npc_a") },
        expectedRevision: 0
      },
      buildPerformDeps(repository, { runtimeNarrativeSources: fakeNarrativeSources() })
    );

    expect(result.ok).toBe(true);
    expect(repository.applyCalls).toHaveLength(1);
    const saved = repository.applyCalls[0].nextState;
    expect(saved.narrative.generation.status).toBe("pending");
    // 规则结果与排队解耦：npc_met 事件在同一次写入中已持久化。
    const tailTypes = saved.eventLedger
      .slice(record.state.eventLedger.length)
      .map((event) => event.type);
    expect(tailTypes).toContain("npc_met");
  });

  it("talk（首次）但 canQueueRuntimeNarrativeScene 为 false → 不排队，规则结果仍写入", async () => {
    const repository = createFakeGameRepository();
    const record = buildActiveRecord();
    // 构造“合法行动 < 2”的局面：已观察开场地点、所有事实已发现、
    // 同地点其他 NPC 已结识，talk 后只剩 move 一个合法行动。
    const sparseState: GameState = {
      ...record.state,
      worldFacts: record.state.worldFacts.map((fact) => ({ ...fact, discovered: true })),
      npcs: record.state.npcs.map((npc) =>
        npc.npcId === asNpcId("npc_a") ? npc : { ...npc, met: true }
      ),
      eventLedger: [
        ...record.state.eventLedger,
        { type: "location_observed" as const, locationId: record.state.currentLocationId, occurredAt: FIXED_TIME }
      ]
    };
    repository.setCurrentResult({ ok: true, status: "active", record: { ...record, state: sparseState } });
    repository.setApplyResult({ ok: true, record: { ...record, revision: 1 } });

    // 前置断言：talk 解决后的状态确实不满足排队条件（fixture 变化时快速暴露）。
    const resolved = resolveAction(
      record.blueprint, sparseState,
      { type: "talk", npcId: asNpcId("npc_a") },
      ruleDeps
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(canQueueRuntimeNarrativeScene(record.blueprint, resolved.state)).toBe(false);

    const result = await performAction(
      {
        intent: { type: "talk", npcId: asNpcId("npc_a") },
        expectedRevision: 0
      },
      buildPerformDeps(repository, { runtimeNarrativeSources: fakeNarrativeSources() })
    );

    expect(result.ok).toBe(true);
    expect(repository.applyCalls).toHaveLength(1);
    const saved = repository.applyCalls[0].nextState;
    expect(saved.narrative.generation.status).not.toBe("pending");
    const tailTypes = saved.eventLedger
      .slice(sparseState.eventLedger.length)
      .map((event) => event.type);
    expect(tailTypes).toContain("npc_met");
  });

  it("offline 模式不排队 pending", async () => {
    const repository = createFakeGameRepository();
    const base = buildActiveRecord();
    const record: GameRecord = {
      ...base,
      state: {
        ...base.state,
        narrative: { currentScene: null, generation: { status: "idle" }, mode: "offline" }
      }
    };
    repository.setCurrentResult({ ok: true, status: "active", record });
    repository.setApplyResult({ ok: true, record: { ...record, revision: 1 } });

    const result = await performAction(
      {
        intent: { type: "talk", npcId: asNpcId("npc_a") },
        expectedRevision: 0
      },
      buildPerformDeps(repository, { runtimeNarrativeSources: fakeNarrativeSources() })
    );

    expect(result.ok).toBe(true);
    expect(repository.applyCalls).toHaveLength(1);
    expect(repository.applyCalls[0].nextState.narrative.generation.status).not.toBe("pending");
  });

  it("对白回应不是规则 action：写入对白事件并携带玩家原话触发下一幕", async () => {
    const repository = createFakeGameRepository();
    const base = buildActiveRecord();
    const dialogueScene = {
      sceneId: "scene-dialogue",
      turn: 0,
      narration: "站务调度员抬头看向你。",
      usedFactIds: [],
      npcLine: null,
      npcDialogues: [],
      event: { kind: "dialogue", focusNpcId: asNpcId("npc_a") },
      choices: [
        {
          choiceToken: "choice-ask",
          label: "询问一下目前发生什么状况了",
          choiceKind: "dialogue_response",
          dialogueIntent: "ask_current_situation",
          actionKey: "dialogue:scene:0"
        },
        {
          choiceToken: "choice-repair",
          label: "太空站刚维修，怎么又坏了",
          choiceKind: "dialogue_response",
          dialogueIntent: "challenge_recent_repair",
          actionKey: "dialogue:scene:1"
        }
      ],
      source: "generated"
    } as unknown as NonNullable<GameState["narrative"]["currentScene"]>;
    const record: GameRecord = {
      ...base,
      state: {
        ...base.state,
        narrative: { currentScene: dialogueScene, generation: { status: "idle" }, mode: "ai" }
      }
    };
    repository.setCurrentResult({ ok: true, status: "active", record });
    repository.setApplyResult({ ok: true, record: { ...record, revision: 1 } });

    const result = await performAction(
      { intent: { type: "narrative_choice", choiceToken: "choice-ask" }, expectedRevision: 0 },
      buildPerformDeps(repository, { runtimeNarrativeSources: fakeNarrativeSources() })
    );

    expect(result.ok).toBe(true);
    expect(repository.applyCalls).toHaveLength(1);
    const saved = repository.applyCalls[0].nextState;
    expect(saved.narrative.currentScene).toBeNull();
    expect(saved.narrative.generation).toMatchObject({
      status: "pending",
      triggerContext: {
        kind: "dialogue_response",
        npcId: asNpcId("npc_a"),
        dialogueIntent: "ask_current_situation",
        playerText: "请问一下目前状况是怎么样的？"
      },
      playerNpcChat: {
        npcId: asNpcId("npc_a"),
        playerText: "请问一下目前状况是怎么样的？"
      }
    });
    expect(saved.eventLedger.at(-1)).toMatchObject({
      type: "narrative_dialogue_choice",
      choiceToken: "choice-ask",
      dialogueIntent: "ask_current_situation",
      npcId: asNpcId("npc_a"),
      sceneId: "scene-dialogue"
    });
    expect(saved.eventLedger.some((event) => event.type === "narrative_choice")).toBe(false);
  });

  it("有预生成对白分支时：选择立即显示下一句对白，不重新进入 pending", async () => {
    const repository = createFakeGameRepository();
    const base = buildActiveRecord();
    const dialogueScene = {
      sceneId: "scene-dialogue-prebuilt",
      turn: 0,
      narration: "站务调度员抬头看向你。",
      usedFactIds: [],
      npcLine: null,
      npcDialogues: [],
      event: { kind: "dialogue", focusNpcId: asNpcId("npc_a") },
      choices: [
        { choiceToken: "choice-ask", label: "旧文案", choiceKind: "dialogue_response", dialogueIntent: "ask_current_situation", actionKey: "dialogue:scene:0" },
        { choiceToken: "choice-reason", label: "旧文案", choiceKind: "dialogue_response", dialogueIntent: "challenge_recent_repair", actionKey: "dialogue:scene:1" }
      ],
      dialogueFollowups: [
        {
          dialogueIntent: "ask_current_situation",
          narration: "你追问目前状况，站务调度员压低声音回答。",
          npcLine: { npcId: asNpcId("npc_a"), text: "目前故障和昨夜的异常记录有关。", emotion: "guarded", usedFactIds: [] },
          nextEventHint: "接下来可以调查报表。"
        },
        {
          dialogueIntent: "challenge_recent_repair",
          narration: "你追问事情缘由，站务调度员神色凝重。",
          npcLine: { npcId: asNpcId("npc_a"), text: "事情还要从那份维修记录说起。", emotion: "guarded", usedFactIds: [] },
          nextEventHint: "接下来可以寻找其他线索。"
        }
      ],
      source: "generated"
    } as unknown as NonNullable<GameState["narrative"]["currentScene"]>;
    const record: GameRecord = {
      ...base,
      state: { ...base.state, narrative: { currentScene: dialogueScene, generation: { status: "idle" }, mode: "ai" } }
    };
    repository.setCurrentResult({ ok: true, status: "active", record });
    repository.setApplyResult({ ok: true, record: { ...record, revision: 1 } });

    const result = await performAction(
      { intent: { type: "narrative_choice", choiceToken: "choice-ask" }, expectedRevision: 0 },
      buildPerformDeps(repository, { runtimeNarrativeSources: fakeNarrativeSources() })
    );

    expect(result.ok).toBe(true);
    const saved = repository.applyCalls[0].nextState;
    expect(saved.narrative.generation).toEqual({ status: "idle" });
    expect(saved.narrative.currentScene?.narration).toBe("你追问目前状况，站务调度员压低声音回答。");
    expect(saved.narrative.currentScene?.npcLine?.text).toBe("目前故障和昨夜的异常记录有关。");
    expect(saved.narrative.currentScene?.nextEventHint).toBe("接下来可以调查报表。");
    expect(saved.narrative.currentScene?.choices.map((choice) => choice.label)).toEqual([
      "请问一下目前状况是怎么样的？",
      "是否可以告诉我事情的缘由？",
    ]);
    expect(saved.narrative.generation.status).not.toBe("pending");
    expect(saved.eventLedger.at(-1)).toMatchObject({ type: "narrative_dialogue_choice" });
  });
});

describe("performAction：Phase 11 剧情记忆与规则事件同一次 CAS", () => {
  it("investigate 成功后 memory 同步归约：recent 含该事实、cursor 追齐 ledger、不含 AI 文案", async () => {
    const repository = createFakeGameRepository();
    const record = buildActiveRecord();
    repository.setCurrentResult({ ok: true, status: "active", record });
    const factId = record.blueprint.openingScene.investigableFactIds[0];
    repository.setApplyResult({ ok: true, record: { ...record, revision: 1 } });

    const result = await performAction(
      { intent: { type: "investigate", factId }, expectedRevision: 0 },
      buildPerformDeps(repository)
    );

    expect(result.ok).toBe(true);
    expect(repository.applyCalls).toHaveLength(1);
    const saved = repository.applyCalls[0].nextState;
    expect(saved.storyMemory?.reducedThroughEventCount).toBe(saved.eventLedger.length);
    expect(
      saved.storyMemory?.recent.some((entry) => entry.kind === "fact" && entry.factId === factId)
    ).toBe(true);
    // 剧情记忆绝不携带 AI 文案/token/actionKey。
    const serialized = JSON.stringify(saved.storyMemory);
    expect(serialized).not.toContain("narration");
    expect(serialized).not.toContain("choiceToken");
    expect(serialized).not.toContain("actionKey");
  });
});

describe("performAction：规则拒绝不写入", () => {
  it("重复 observe 返回 ACTION_REJECTED + 当前 view，applyResolvedAction 零调用", async () => {
    const repository = createFakeGameRepository();
    // 状态中已有 location_observed 事件 → 重复 observe 会被 resolver 拒绝。
    const record = buildActiveRecord();
    const observedState = {
      ...record.state,
      eventLedger: [
        ...record.state.eventLedger,
        {
          type: "location_observed" as const,
          locationId: record.state.currentLocationId,
          occurredAt: FIXED_TIME
        }
      ]
    };
    repository.setCurrentResult({
      ok: true,
      status: "active",
      record: { ...record, state: observedState }
    });

    const result = await performAction(
      {
        intent: { type: "observe", locationId: record.state.currentLocationId },
        expectedRevision: 0
      },
      buildPerformDeps(repository)
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("ACTION_REJECTED");
    if (result.code !== "ACTION_REJECTED") return;
    expect(result.feedback.ok).toBe(false);
    expect(result.feedback.message).toBeTruthy();
    expect(result.view.revision).toBe(0);
    expect(repository.applyCalls).toHaveLength(0);
  });
});

describe("performAction：陈旧 revision", () => {
  it("expectedRevision 不匹配时返回 STALE_GAME_REVISION + 当前 view", async () => {
    const repository = createFakeGameRepository();
    repository.setCurrentResult({
      ok: true,
      status: "active",
      record: { ...buildActiveRecord(), revision: 5 }
    });

    const result = await performAction(
      {
        intent: { type: "observe", locationId: PIPELINE.state.currentLocationId },
        expectedRevision: 0
      },
      buildPerformDeps(repository)
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("STALE_GAME_REVISION");
    if (result.code !== "STALE_GAME_REVISION") return;
    expect(result.view.revision).toBe(5);
    expect(repository.applyCalls).toHaveLength(0);
  });

  it("applyResolvedAction 返回 STALE_GAME_REVISION 时也映射为陈旧", async () => {
    const repository = createFakeGameRepository();
    repository.setCurrentResult({
      ok: true,
      status: "active",
      record: buildActiveRecord()
    });
    repository.setApplyResult({ ok: false, code: "STALE_GAME_REVISION" });

    const result = await performAction(
      {
        intent: { type: "observe", locationId: PIPELINE.state.currentLocationId },
        expectedRevision: 0
      },
      buildPerformDeps(repository)
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("STALE_GAME_REVISION");
  });
});

describe("performAction：无存档/损坏/基础设施失败", () => {
  it("无存档时返回 NO_ACTIVE_GAME", async () => {
    const repository = createFakeGameRepository();
    repository.setCurrentResult({ ok: true, status: "none" });

    const result = await performAction(
      {
        intent: { type: "observe", locationId: PIPELINE.state.currentLocationId },
        expectedRevision: 0
      },
      buildPerformDeps(repository)
    );

    expect(result).toEqual({ ok: false, code: "NO_ACTIVE_GAME" });
  });

  it("存档损坏时返回 CORRUPT_GAME", async () => {
    const repository = createFakeGameRepository();
    repository.setCurrentResult({ ok: true, status: "corrupt", reason: "VERSION_MISMATCH" });

    const result = await performAction(
      {
        intent: { type: "observe", locationId: PIPELINE.state.currentLocationId },
        expectedRevision: 0
      },
      buildPerformDeps(repository)
    );

    expect(result).toEqual({ ok: false, code: "CORRUPT_GAME" });
  });

  it("读取基础设施失败时返回 INFRASTRUCTURE_FAILURE", async () => {
    const repository = createFakeGameRepository();
    repository.setCurrentResult({ ok: false, code: "INFRASTRUCTURE_FAILURE" });

    const result = await performAction(
      {
        intent: { type: "observe", locationId: PIPELINE.state.currentLocationId },
        expectedRevision: 0
      },
      buildPerformDeps(repository)
    );

    expect(result).toEqual({ ok: false, code: "INFRASTRUCTURE_FAILURE" });
  });

  it("applyResolvedAction 基础设施失败时返回 INFRASTRUCTURE_FAILURE", async () => {
    const repository = createFakeGameRepository();
    repository.setCurrentResult({
      ok: true,
      status: "active",
      record: buildActiveRecord()
    });
    repository.setApplyResult({ ok: false, code: "INFRASTRUCTURE_FAILURE" });

    const result = await performAction(
      {
        intent: { type: "observe", locationId: PIPELINE.state.currentLocationId },
        expectedRevision: 0
      },
      buildPerformDeps(repository)
    );

    expect(result).toEqual({ ok: false, code: "INFRASTRUCTURE_FAILURE" });
  });
});

describe("performAction：不泄漏敏感信息", () => {
  it("成功结果 body 不含 SQL/seed/blueprint/state/inputDigest", async () => {
    const repository = createFakeGameRepository();
    repository.setCurrentResult({
      ok: true,
      status: "active",
      record: buildActiveRecord()
    });
    repository.setApplyResult({
      ok: true,
      record: { ...buildActiveRecord(), revision: 1 }
    });

    const result = await performAction(
      {
        intent: { type: "observe", locationId: PIPELINE.state.currentLocationId },
        expectedRevision: 0
      },
      buildPerformDeps(repository)
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const json = JSON.stringify(result);
    expect(json).not.toContain(PIPELINE.blueprint.seed);
    expect(json).not.toContain(PIPELINE.blueprint.inputDigest);
    expect(json).not.toContain("blueprint");
    expect(json).not.toContain("stateVersion");
    expect(json).not.toContain("contentBudget");
  });
});

// ---------------------------------------------------------------------------
// Town 主循环 S4：抵达 scale="town" 地点时的懒生成。离线存档同步派生，
// AI 存档只置 pending；非 town 地点与已生成地点均零变更。
// 运行时扩展蓝图的 loc_b（原 loc_2）固定为 town 地点且与开场 loc_a 相邻。
// ---------------------------------------------------------------------------

describe("performAction：town 层懒生成", () => {
  const TOWN_ID = asLocationId("loc_b");

  function buildRecordWithMode(mode: "offline" | "ai"): GameRecord {
    const base = buildActiveRecord();
    return {
      ...base,
      state: {
        ...base.state,
        narrative: { currentScene: null, generation: { status: "idle" }, mode }
      }
    };
  }

  async function performMoveToTown(record: GameRecord) {
    const repository = createFakeGameRepository();
    repository.setCurrentResult({ ok: true, status: "active", record });
    repository.setApplyResult({ ok: true, record: { ...record, revision: 1 } });
    const result = await performAction(
      { intent: { type: "move", locationId: TOWN_ID }, expectedRevision: 0 },
      buildPerformDeps(repository)
    );
    expect(result.ok).toBe(true);
    expect(repository.applyCalls).toHaveLength(1);
    return repository.applyCalls[0].nextState;
  }

  it("离线存档 move 到 town 地点：同步派生 towns 条目 + 事件，无 pending", async () => {
    const next = await performMoveToTown(buildRecordWithMode("offline"));

    expect(next.towns).toHaveLength(1);
    expect(String(next.towns[0].locationId)).toBe("loc_b");
    expect(next.towns[0].planSource).toBe("offline");
    expect(next.towns[0].seed).toBe(`${PIPELINE.blueprint.seed}#town#loc_b`);
    expect(next.townGeneration).toEqual({ status: "idle" });
    const townEvents = next.eventLedger.filter((event) => event.type === "town_plan_generated");
    expect(townEvents).toHaveLength(1);
    expect(townEvents[0]).toEqual({
      type: "town_plan_generated",
      locationId: TOWN_ID,
      planSource: "offline",
      occurredAt: FIXED_TIME
    });
  });

  it("AI 存档 move 到 town 地点：只置 pending，不同步生成、不写事件", async () => {
    const next = await performMoveToTown(buildRecordWithMode("ai"));

    expect(next.towns).toEqual([]);
    expect(next.townGeneration).toEqual({
      status: "pending",
      locationId: TOWN_ID,
      requestedAt: FIXED_TIME
    });
    expect(next.eventLedger.some((event) => event.type === "town_plan_generated")).toBe(false);
  });

  it("非 town 地点的行动：towns / townGeneration 零变更", async () => {
    const record = buildRecordWithMode("offline");
    const repository = createFakeGameRepository();
    repository.setCurrentResult({ ok: true, status: "active", record });
    repository.setApplyResult({ ok: true, record: { ...record, revision: 1 } });

    const result = await performAction(
      {
        intent: { type: "observe", locationId: record.state.currentLocationId },
        expectedRevision: 0
      },
      buildPerformDeps(repository)
    );

    expect(result.ok).toBe(true);
    const next = repository.applyCalls[0].nextState;
    expect(next.towns).toEqual([]);
    expect(next.townGeneration).toEqual({ status: "idle" });
  });

  it("towns 已有条目时重复行动不重复生成", async () => {
    const base = buildRecordWithMode("offline");
    const seeded = await performMoveToTown(base);
    const record: GameRecord = {
      ...base,
      state: seeded,
      revision: 1
    };
    const repository = createFakeGameRepository();
    repository.setCurrentResult({ ok: true, status: "active", record });
    repository.setApplyResult({ ok: true, record: { ...record, revision: 2 } });

    const result = await performAction(
      { intent: { type: "observe", locationId: TOWN_ID }, expectedRevision: 1 },
      buildPerformDeps(repository)
    );

    expect(result.ok).toBe(true);
    const next = repository.applyCalls[0].nextState;
    expect(next.towns).toHaveLength(1);
    expect(
      next.eventLedger.filter((event) => event.type === "town_plan_generated")
    ).toHaveLength(1);
  });
});
