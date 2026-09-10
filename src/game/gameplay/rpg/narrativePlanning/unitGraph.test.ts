import { describe, expect, it } from "vitest";
import { checkUnitGraph, readyUnits } from "./unitGraph";
import type { Unit } from "@/game/domain/narrativeUnit";
import {
  makeStagedPlan,
  FIXTURE_CHOICE_UNIT,
  FIXTURE_NARRATION_UNIT,
} from "@/game/domain/testing/stagedNarrativeFixture.testutil";

function unit(overrides: Partial<Unit> & Pick<Unit, "key" | "stage">): Unit {
  return {
    point: { stepKey: "current", order: 1 },
    speakerId: null,
    dependencies: [],
    taskFactIds: [],
    requiredObservationKeys: [],
    requiredBeats: [],
    ...overrides,
  };
}

describe("readyUnits", () => {
  it("同一点内按依赖排序：未来单元在上游通过前不可见", () => {
    const units: readonly Unit[] = [
      unit({ key: "npc", stage: "character", point: { stepKey: "current", order: 1 }, speakerId: "npc_0" }),
      unit({ key: "labels", stage: "choices", point: { stepKey: "current", order: 2 }, dependencies: ["npc"] }),
    ];
    expect(readyUnits(units, new Set()).map((x) => x.key)).toEqual(["npc"]);
    expect(readyUnits(units, new Set(["npc"])).map((x) => x.key)).toEqual(["labels"]);
  });

  it("保留输入顺序：无依赖单元全部就绪", () => {
    const units: readonly Unit[] = [
      unit({ key: "b", stage: "narration", point: { stepKey: "current", order: 2 } }),
      unit({ key: "a", stage: "narration", point: { stepKey: "current", order: 1 } }),
    ];
    expect(readyUnits(units, new Set()).map((x) => x.key)).toEqual(["b", "a"]);
  });
});

describe("checkUnitGraph", () => {
  const plan = makeStagedPlan();

  it("接受骨架 fixture 的单元图", () => {
    expect(checkUnitGraph({ units: plan.units, observations: plan.observations, decision: plan.decision }))
      .toEqual({ ok: true, value: true });
  });

  it("拒绝重复单元 key", () => {
    const duplicated: readonly Unit[] = [
      ...plan.units,
      unit({ key: FIXTURE_NARRATION_UNIT, stage: "narration", point: { stepKey: "current", order: 9 } }),
    ];
    expect(checkUnitGraph({ units: duplicated, observations: [], decision: null }))
      .toEqual({ ok: false, code: "duplicate_unit_key" });
  });

  it("拒绝引用不存在单元的依赖", () => {
    const units: readonly Unit[] = [
      unit({ key: "a", stage: "narration", dependencies: ["ghost"] }),
    ];
    expect(checkUnitGraph({ units, observations: [], decision: null }))
      .toEqual({ ok: false, code: "unknown_dependency" });
  });

  it("拒绝依赖环", () => {
    const units: readonly Unit[] = [
      unit({ key: "a", stage: "narration", dependencies: ["b"] }),
      unit({ key: "b", stage: "narration", dependencies: ["a"] }),
    ];
    expect(checkUnitGraph({ units, observations: [], decision: null }))
      .toEqual({ ok: false, code: "dependency_cycle" });
  });

  it("拒绝超过 39 个表达单元", () => {
    const units: readonly Unit[] = Array.from({ length: 40 }, (_, i) =>
      unit({ key: `u${i}`, stage: "narration", point: { stepKey: "current", order: i + 1 } }));
    expect(checkUnitGraph({ units, observations: [], decision: null }))
      .toEqual({ ok: false, code: "unit_cap_exceeded" });
  });

  it("决策单元数量必须与 decision 字段一致", () => {
    // 有 decision 但没有 choices 单元
    expect(checkUnitGraph({
      units: [unit({ key: "n", stage: "narration" })],
      observations: [],
      decision: plan.decision,
    })).toEqual({ ok: false, code: "decision_unit_mismatch" });
    // 无 decision 但存在 choices 单元
    expect(checkUnitGraph({
      units: [unit({ key: FIXTURE_CHOICE_UNIT, stage: "choices" })],
      observations: [],
      decision: null,
    })).toEqual({ ok: false, code: "decision_unit_mismatch" });
    // 两个 choices 单元
    expect(checkUnitGraph({
      units: [
        unit({ key: "c1", stage: "choices", point: { stepKey: "current", order: 1 } }),
        unit({ key: "c2", stage: "choices", point: { stepKey: "current", order: 2 } }),
      ],
      observations: [],
      decision: plan.decision,
    })).toEqual({ ok: false, code: "decision_unit_mismatch" });
  });

  it("拒绝没有观察来源的知识要求", () => {
    const units: readonly Unit[] = [
      unit({ key: "a", stage: "character", speakerId: "npc_0", requiredObservationKeys: ["obs_ghost"] }),
    ];
    expect(checkUnitGraph({ units, observations: [], decision: null }))
      .toEqual({ ok: false, code: "observation_without_source" });
  });

  it("拒绝排在决策点之后的单元（片段至下一决策止）", () => {
    const units: readonly Unit[] = [
      ...plan.units,
      unit({ key: "late", stage: "narration", point: { stepKey: "current", order: 9 } }),
    ];
    expect(checkUnitGraph({ units, observations: plan.observations, decision: plan.decision }))
      .toEqual({ ok: false, code: "unit_after_decision" });
  });
});
