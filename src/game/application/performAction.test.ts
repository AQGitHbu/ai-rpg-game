import { describe, expect, it } from "vitest";
import type { NewGameInput } from "@/game/domain";
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
