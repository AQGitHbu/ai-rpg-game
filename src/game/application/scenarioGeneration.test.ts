import { describe, expect, it } from "vitest";
import {
  SCENARIO_CANDIDATE_CONTRACT_VERSION,
  SCENARIO_CANDIDATE_FAILURE_CATEGORIES
} from "./scenarioGeneration";

// Phase 4A Task 2：候选失败类别是版本化契约的一部分。
// 顺序与 spec §3 的枚举一致；新增类别必须升级契约版本并补齐 fixture。
// 蓝图动态化：契约升至 scenario-dynamic-v2（budgetPolicy 取代 contentBudget），失败类别集合不变。
describe("scenarioGeneration port 契约", () => {
  it("契约版本为 scenario-dynamic-v2", () => {
    expect(SCENARIO_CANDIDATE_CONTRACT_VERSION).toBe("scenario-dynamic-v2");
  });

  it("公开完整且冻结的候选失败类别", () => {
    expect(SCENARIO_CANDIDATE_FAILURE_CATEGORIES).toEqual([
      "invalid_json", "schema_violation", "budget_exceeded", "reference_broken",
      "unreachable_ending", "cross_type_content", "illegal_entity", "timeout",
      "rate_limited", "service_error", "empty_response"
    ]);
    expect(Object.isFrozen(SCENARIO_CANDIDATE_FAILURE_CATEGORIES)).toBe(true);
  });
});
