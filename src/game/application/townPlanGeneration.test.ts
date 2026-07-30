import { describe, expect, it } from "vitest";
import {
  TOWN_PLAN_CONTRACT_VERSION,
  TOWN_PLAN_FAILURE_CATEGORIES
} from "./townPlanGeneration";

// Town 主循环 S4：小镇规划候选失败类别是版本化契约的一部分。
// 前三项 provider 侧失败之外的 schema_violation / coverage_missing /
// compile_failed 与 validateTownPlanCandidate 的拒绝原因一一对应；
// 新增类别必须升级契约版本并补齐 fixture。
describe("townPlanGeneration port 契约", () => {
  it("契约版本为 town-plan-v1", () => {
    expect(TOWN_PLAN_CONTRACT_VERSION).toBe("town-plan-v1");
  });

  it("公开完整且冻结的候选失败类别", () => {
    expect(TOWN_PLAN_FAILURE_CATEGORIES).toEqual([
      "invalid_json", "schema_violation", "coverage_missing", "compile_failed",
      "timeout", "rate_limited", "service_error", "empty_response"
    ]);
    expect(Object.isFrozen(TOWN_PLAN_FAILURE_CATEGORIES)).toBe(true);
  });
});
