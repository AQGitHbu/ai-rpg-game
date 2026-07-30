import { describe, expect, it } from "vitest";
import { asItemId, asLocationId, asNpcId, asQuestId, type GameState, type NewGameInput } from "@/game/domain";
import { resolveAction, type PlayerIntent } from "@/game/gameplay/rpg/actions";
import { reconcileQuests } from "@/game/gameplay/rpg/quests";
import wuxiaFixture from "../../../data/fixtures/phase1/wuxia.json";
import { performAction, type PerformActionDependencies } from "./performAction";
import {
  createFakeGameRepository,
  runScenarioPipeline,
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

type Phase1Fixture = { input: NewGameInput; seed: string };
const FIXTURE = wuxiaFixture as unknown as Phase1Fixture;
const PIPELINE = runScenarioPipeline(FIXTURE.input, FIXTURE.seed);

const FIXED_TIME = "2026-07-27T10:00:00.000Z";

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
    const moveIntent = { type: "move" as const, locationId: asLocationId("loc_2") };
    const resolved = resolveAction(record.blueprint, record.state, moveIntent, {
      now: () => FIXED_TIME
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const reconciled = reconcileQuests(record.blueprint, resolved.state, {
      now: () => FIXED_TIME
    });
    expect(reconciled.events.length).toBeGreaterThan(0);

    repository.setApplyResult({
      ok: true,
      record: { ...record, state: reconciled.state, revision: 1 }
    });

    const result = await performAction(
      { intent: moveIntent, expectedRevision: 0 },
      buildPerformDeps(repository)
    );

    expect(result.ok).toBe(true);
    // 恰好一次写入，且载荷已含任务事件与状态迁移（无第二次写入、无旁路）。
    expect(repository.applyCalls).toHaveLength(1);
    expect(repository.applyCalls[0].nextState).toEqual(reconciled.state);
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
      { intent: { type: "move", locationId: asLocationId("loc_2") }, expectedRevision: 0 },
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
      { intent: { type: "move", locationId: asLocationId("loc_2") }, expectedRevision: 0 },
      buildPerformDeps(repository)
    );

    expect(result).toEqual({ ok: false, code: "INFRASTRUCTURE_FAILURE" });
    expect(repository.applyCalls).toHaveLength(0);
  });
});

describe("performAction：take_item + 任务 reconciliation 单次写入（Phase 5 Task 3）", () => {
  const ruleDeps = { now: () => FIXED_TIME };

  /** 走真实规则管线推进到 stage-2 就绪：loc_2 → loc_3 → talk npc_3（未取物品）。 */
  function buildStageTwoReadyState(): GameState {
    const intents: readonly PlayerIntent[] = [
      { type: "move", locationId: asLocationId("loc_2") },
      { type: "move", locationId: asLocationId("loc_3") },
      { type: "talk", npcId: asNpcId("npc_3") }
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
    const takeIntent: PlayerIntent = { type: "take_item", itemId: asItemId("item_key") };
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
    expect(repository.applyCalls[0].nextState).toEqual(reconciled.state);
    const tailTypes = repository.applyCalls[0].nextState.eventLedger
      .slice(readyState.eventLedger.length)
      .map((event) => event.type);
    expect(tailTypes).toEqual(["item_obtained", "quest_completed", "quest_unlocked"]);
    const statusById = new Map(
      repository.applyCalls[0].nextState.quests.map((quest) => [quest.questId, quest.status])
    );
    expect(statusById.get(asQuestId("quest_m2"))).toBe("completed");
    expect(statusById.get(asQuestId("quest_m3"))).toBe("active");
    // 已保存 state 投影的 view：背包收录 key 物品，可取得列表清空。
    expect(result.view.revision).toBe(4);
    expect(result.view.obtainableItems).toEqual([]);
    const keyItem = PIPELINE.blueprint.items.find((item) => item.id === asItemId("item_key"));
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
      inventory: [...readyState.inventory, asItemId("item_key")]
    };
    repository.setCurrentResult({
      ok: true,
      status: "active",
      record: { ...buildActiveRecord(), state: ownedState, revision: 3 }
    });

    const result = await performAction(
      { intent: { type: "take_item", itemId: asItemId("item_key") }, expectedRevision: 3 },
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
      }
    };

    const result = await performAction(
      { intent: { type: "take_item", itemId: asItemId("item_key") }, expectedRevision: 3 },
      { repository: throwingRepository, now: () => FIXED_TIME }
    );

    expect(result).toEqual({ ok: false, code: "INFRASTRUCTURE_FAILURE" });
  });
});

describe("performAction：dialogue_choice 单次写入与零写入（Phase 7 Task 2）", () => {
  const ruleDeps = { now: () => FIXED_TIME };

  it("成功对话：恰好一次 CAS，尾部恰好一个 npc_met 事件", async () => {
    const repository = createFakeGameRepository();
    const record = buildActiveRecord();
    repository.setCurrentResult({ ok: true, status: "active", record });

    // 开局无 npc_1 的 talk_to_npc 目标（quest_m1 是 visit_location）→ greet 可用。
    const intent: PlayerIntent = {
      type: "dialogue_choice",
      npcId: asNpcId("npc_1"),
      choiceId: "npc_1:greet"
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
    // 恰好一次写入，且尾部只有一个 npc_met（无多余事件/无旁路写入）。
    expect(repository.applyCalls).toHaveLength(1);
    expect(repository.applyCalls[0].nextState).toEqual(reconciled.state);
    const tailTypes = repository.applyCalls[0].nextState.eventLedger
      .slice(record.state.eventLedger.length)
      .map((event) => event.type);
    expect(tailTypes).toEqual(["npc_met"]);
    expect(result.feedback.ok).toBe(true);
    expect(result.feedback.message).toBeTruthy();
  });

  it("伪造 choiceId 被拒 ⇒ ACTION_REJECTED 且零 CAS", async () => {
    const repository = createFakeGameRepository();
    const record = buildActiveRecord();
    repository.setCurrentResult({ ok: true, status: "active", record });

    const result = await performAction(
      {
        intent: {
          type: "dialogue_choice",
          npcId: asNpcId("npc_1"),
          choiceId: "npc_1:steal_items"
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

  it("过期 choice（NPC 已结识）被拒 ⇒ ACTION_REJECTED 且零 CAS", async () => {
    const repository = createFakeGameRepository();
    const record = buildActiveRecord();
    const metState = {
      ...record.state,
      npcs: record.state.npcs.map((npc) =>
        npc.npcId === asNpcId("npc_1") ? { ...npc, met: true } : npc
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
          type: "dialogue_choice",
          npcId: asNpcId("npc_1"),
          choiceId: "npc_1:greet"
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
