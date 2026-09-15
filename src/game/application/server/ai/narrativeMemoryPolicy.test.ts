import { describe, expect, it } from "vitest";
import { DEFAULT_NARRATIVE_MEMORY_POLICY, resolveNarrativeMemoryPolicy } from "./narrativeMemoryPolicy";

describe("narrativeMemoryPolicy", () => {
  it("uses the fixed P2 policy and accepts a positive prompt budget override", () => {
    expect(DEFAULT_NARRATIVE_MEMORY_POLICY).toMatchObject({ threshold: 50, batchSize: 10, rawSoftEstimatedTokens: 24_000, summarySourceMaxEstimatedTokens: 24_000, overviewMaxEstimatedTokens: 24_000, promptMaxEstimatedTokens: 64_000 });
    expect(resolveNarrativeMemoryPolicy({ AI_NARRATIVE_INPUT_MAX_ESTIMATED_TOKENS: "70000" }).promptMaxEstimatedTokens).toBe(70_000);
  });

  it("rejects invalid injected policy values", () => {
    expect(() => resolveNarrativeMemoryPolicy({}, { batchSize: 0 })).toThrow("INVALID_NARRATIVE_MEMORY_POLICY");
  });
});
