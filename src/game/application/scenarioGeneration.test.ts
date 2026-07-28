import { describe, expect, it } from "vitest";
import { SCENARIO_CANDIDATE_FAILURE_CATEGORIES } from "./scenarioGeneration";

// Phase 4A Task 2：候选失败类别是版本化契约（phase4a-v1）的一部分。
// 顺序与 spec §3 的枚举一致；新增类别必须升级契约版本并补齐 fixture。
describe("scenarioGeneration port 契约", () => {
  it("公开完整且冻结的候选失败类别", () => {
    expect(SCENARIO_CANDIDATE_FAILURE_CATEGORIES).toEqual([
      "invalid_json", "schema_violation", "budget_exceeded", "reference_broken",
      "unreachable_ending", "cross_type_content", "illegal_entity", "timeout",
      "rate_limited", "service_error", "empty_response"
    ]);
    expect(Object.isFrozen(SCENARIO_CANDIDATE_FAILURE_CATEGORIES)).toBe(true);
  });
});
