import { describe, expect, it } from "vitest";
import { NARRATIVE_CONTRACT_VERSION, NARRATIVE_FAILURE_CATEGORIES } from "./runtimeNarrative";

describe("runtimeNarrative", () => {
  it("exposes the contract version", () => {
    expect(typeof NARRATIVE_CONTRACT_VERSION).toBe("string");
    expect(NARRATIVE_CONTRACT_VERSION).toMatch(/^runtime-narrative-/);
  });

  it("NARRATIVE_FAILURE_CATEGORIES covers all three roles", () => {
    const cats = NARRATIVE_FAILURE_CATEGORIES;
    // 导演特有失败
    expect(cats.includes("rejected_by_rules")).toBe(true);
    // 编剧特有失败
    expect(cats.includes("rejected_by_rules")).toBe(true);
    // 演员特有失败
    expect(cats.includes("rejected_by_rules")).toBe(true);
    // 共同可能失败
    expect(cats.includes("service_error")).toBe(true);
    expect(cats.includes("rate_limited")).toBe(true);
    expect(cats.includes("invalid_json")).toBe(true);
    expect(cats.includes("timeout")).toBe(true);
    expect(cats.includes("empty_response")).toBe(true);
  });

  it("has at least 3 failure categories", () => {
    expect(NARRATIVE_FAILURE_CATEGORIES.length).toBeGreaterThanOrEqual(3);
  });
});
