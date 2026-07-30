import { describe, expect, it } from "vitest";
import type { GameState, ScenarioBlueprint } from "@/game/domain";
import { TOWN_GENERATOR_VERSION } from "@/game/domain";
import { compileScenarioBlueprint, initializeGameState } from "../scenario/compileScenarioBlueprint";
import { validateScenarioBlueprintCandidate } from "../scenario/validateScenarioBlueprint";
import { TEST_PROFILE, makeValidCandidate } from "../scenario/scenarioBlueprintFixture.testutil";
import { createTownPlanFromLocation } from "./planFromBlueprint";
import { ensureTownRuntime, townSeedFor } from "./enterTown";

const OCCURRED_AT = "2024-01-01T00:00:00.000Z";

function compileFixtureBlueprint(): ScenarioBlueprint {
  const validation = validateScenarioBlueprintCandidate(makeValidCandidate(), { profile: TEST_PROFILE });
  const compiled = compileScenarioBlueprint(validation);
  if (!compiled.ok) throw new Error("fixture 应当编译成功");
  return compiled.blueprint;
}

/** loc_a 标 town 的蓝图 + 初始状态。 */
function makeTownFixture(): { blueprint: ScenarioBlueprint; state: GameState } {
  const compiled = compileFixtureBlueprint();
  const blueprint: ScenarioBlueprint = {
    ...compiled,
    locations: compiled.locations.map((location) =>
      String(location.id) === "loc_a" ? { ...location, scale: "town" as const } : location
    )
  };
  return { blueprint, state: initializeGameState(blueprint) };
}

describe("ensureTownRuntime", () => {
  it("offline 进入 town 地点：产出 towns 追加条目 + town_plan_generated 事件", () => {
    const { blueprint, state } = makeTownFixture();
    const result = ensureTownRuntime(blueprint, state, "loc_a", "offline", OCCURRED_AT);
    if (result.kind !== "generated") throw new Error(`期望 generated，得到 ${result.kind}`);
    const seed = townSeedFor(blueprint.seed, "loc_a");
    expect(result.town).toEqual({
      locationId: "loc_a",
      seed,
      plan: createTownPlanFromLocation(blueprint, "loc_a", seed),
      planSource: "offline",
      generatorVersion: TOWN_GENERATOR_VERSION
    });
    expect(result.event).toEqual({
      type: "town_plan_generated",
      locationId: "loc_a",
      planSource: "offline",
      occurredAt: OCCURRED_AT
    });
  });

  it("同蓝图同状态两次调用深度相等（确定性）", () => {
    const { blueprint, state } = makeTownFixture();
    expect(ensureTownRuntime(blueprint, state, "loc_a", "offline", OCCURRED_AT)).toEqual(
      ensureTownRuntime(blueprint, state, "loc_a", "offline", OCCURRED_AT)
    );
  });

  it("非 town 地点与未知地点均返回 unchanged", () => {
    const { blueprint, state } = makeTownFixture();
    expect(ensureTownRuntime(blueprint, state, "loc_b", "offline", OCCURRED_AT)).toEqual({
      kind: "unchanged"
    });
    expect(ensureTownRuntime(blueprint, state, "loc_missing", "ai", OCCURRED_AT)).toEqual({
      kind: "unchanged"
    });
  });

  it("towns 已有该地点条目时返回 unchanged（离线与 AI 一致）", () => {
    const { blueprint, state } = makeTownFixture();
    const generated = ensureTownRuntime(blueprint, state, "loc_a", "offline", OCCURRED_AT);
    if (generated.kind !== "generated") throw new Error("fixture 应当生成");
    const withTown: GameState = { ...state, towns: [generated.town] };
    expect(ensureTownRuntime(blueprint, withTown, "loc_a", "offline", OCCURRED_AT)).toEqual({
      kind: "unchanged"
    });
    expect(ensureTownRuntime(blueprint, withTown, "loc_a", "ai", OCCURRED_AT)).toEqual({
      kind: "unchanged"
    });
  });

  it("ai 模式产出 pending 标记；同地点已 pending 时返回 unchanged", () => {
    const { blueprint, state } = makeTownFixture();
    const result = ensureTownRuntime(blueprint, state, "loc_a", "ai", OCCURRED_AT);
    expect(result).toEqual({
      kind: "pending",
      townGeneration: { status: "pending", locationId: "loc_a", requestedAt: OCCURRED_AT }
    });
    const pendingState: GameState = {
      ...state,
      townGeneration: { status: "pending", locationId: state.currentLocationId, requestedAt: OCCURRED_AT }
    };
    // fixture 开局在 loc_a：同地点 pending → unchanged。
    expect(ensureTownRuntime(blueprint, pendingState, "loc_a", "ai", OCCURRED_AT)).toEqual({
      kind: "unchanged"
    });
  });
});
