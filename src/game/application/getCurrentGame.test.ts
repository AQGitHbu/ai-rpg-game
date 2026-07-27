import { describe, expect, it } from "vitest";
import type { NewGameInput } from "@/game/domain";
import wuxiaFixture from "../../../data/fixtures/phase1/wuxia.json";
import { getCurrentGame } from "./getCurrentGame";
import {
  createFakeGameRepository,
  createTestDependencies,
  runScenarioPipeline,
  TEST_CREATED_AT,
  TEST_GAME_ID
} from "./applicationFixture.testutil";

// ---------------------------------------------------------------------------
// Task 1：getCurrentGame use case 契约测试。
// CurrentGameResult 恰有 none / active / corrupt 三态；active 投影同一 OpeningGameView，
// corrupt 只暴露稳定原因，绝不返回 blueprint/state；基础设施失败也归为可恢复态。
// ---------------------------------------------------------------------------

type Phase1Fixture = { input: NewGameInput; seed: string };
const FIXTURE = wuxiaFixture as unknown as Phase1Fixture;

describe("getCurrentGame：无存档", () => {
  it("repository 报告 none ⇒ 状态 none", async () => {
    const repository = createFakeGameRepository();
    repository.setCurrentResult({ ok: true, status: "none" });
    const result = await getCurrentGame(createTestDependencies(repository));
    expect(result).toEqual({ status: "none" });
  });
});

describe("getCurrentGame：存在可玩存档", () => {
  it("active 记录 ⇒ 投影与 createGame 一致的 OpeningGameView", async () => {
    const repository = createFakeGameRepository();
    const { blueprint, state } = runScenarioPipeline(FIXTURE.input, FIXTURE.seed);
    repository.setCurrentResult({
      ok: true,
      status: "active",
      record: { gameId: TEST_GAME_ID, blueprint, state, createdAt: TEST_CREATED_AT }
    });
    const result = await getCurrentGame(createTestDependencies(repository));

    expect(result.status).toBe("active");
    if (result.status !== "active") return;
    expect(result.view.gameId).toBe(TEST_GAME_ID);
    expect(result.view.openingNarration).toBe(blueprint.openingScene.narration);
    expect(result.view.player.identity).toBe(state.player.identity);
    // 隐藏地点不泄漏。
    const hidden = blueprint.locations.filter((entry) => entry.kind === "hidden");
    const viewJson = JSON.stringify(result.view);
    for (const location of hidden) {
      expect(viewJson.includes(location.name)).toBe(false);
    }
  });
});

describe("getCurrentGame：损坏存档", () => {
  it("repository 报告 corrupt ⇒ 状态 corrupt，只暴露稳定原因，无 blueprint/state", async () => {
    const repository = createFakeGameRepository();
    repository.setCurrentResult({ ok: true, status: "corrupt", reason: "GENERATION_MISMATCH" });
    const result = await getCurrentGame(createTestDependencies(repository));
    expect(result).toEqual({ status: "corrupt", reason: "GENERATION_MISMATCH" });
  });

  it("基础设施失败也归为可恢复的 corrupt 态，不抛出异常文本", async () => {
    const repository = createFakeGameRepository();
    repository.setCurrentResult({ ok: false, code: "INFRASTRUCTURE_FAILURE" });
    const result = await getCurrentGame(createTestDependencies(repository));
    expect(result).toEqual({ status: "corrupt", reason: "INFRASTRUCTURE_FAILURE" });
  });
});
