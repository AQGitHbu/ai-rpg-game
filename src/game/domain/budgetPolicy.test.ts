import { describe, expect, it } from "vitest";
import {
  createBudgetPolicy, budgetPolicyOf, finalMainActOf, LEGACY_BUDGET_POLICY
} from "./budgetPolicy";

describe("createBudgetPolicy", () => {
  it("四档位幕数与软上限符合档位表", () => {
    expect(createBudgetPolicy("short").mainActs).toBe(3);
    expect(createBudgetPolicy("medium").mainActs).toBe(5);
    expect(createBudgetPolicy("long").mainActs).toBe(8);
    expect(createBudgetPolicy("open").mainActs).toBe(5);
    expect(createBudgetPolicy("short").expansion).toEqual({ locationsSoftMax: 8, npcsSoftMax: 10 });
    expect(createBudgetPolicy("long").expansion).toEqual({ locationsSoftMax: 22, npcsSoftMax: 24 });
    expect(createBudgetPolicy("open").expansion).toEqual({ locationsSoftMax: null, npcsSoftMax: null });
  });

  it("开局预算与安全上限全档位一致", () => {
    for (const length of ["short", "medium", "long", "open"] as const) {
      const policy = createBudgetPolicy(length);
      expect(policy.opening).toEqual({
        mainLocationsMin: 3, mainLocationsMax: 5, hiddenLocationsMax: 1,
        coreNpcsMin: 4, coreNpcsMax: 6, companionsMax: 1,
        sideQuestsMax: 2, endings: 2, townLocationsMax: 2
      });
      expect(policy.safety).toEqual({ locationsHardMax: 40, npcsHardMax: 30 });
      expect(Object.isFrozen(policy)).toBe(true);
    }
  });
});

describe("budgetPolicyOf / finalMainActOf", () => {
  it("缺省回 LEGACY（旧存档三幕语义）", () => {
    expect(budgetPolicyOf({})).toBe(LEGACY_BUDGET_POLICY);
    expect(LEGACY_BUDGET_POLICY.mainActs).toBe(3);
    expect(LEGACY_BUDGET_POLICY.opening.mainLocationsMin).toBe(4);
    expect(LEGACY_BUDGET_POLICY.opening.mainLocationsMax).toBe(4);
    expect(finalMainActOf({})).toBe(3);
  });

  it("有 budgetPolicy 时原样返回", () => {
    const policy = createBudgetPolicy("long");
    expect(budgetPolicyOf({ budgetPolicy: policy })).toBe(policy);
    expect(finalMainActOf({ budgetPolicy: policy })).toBe(8);
  });
});
