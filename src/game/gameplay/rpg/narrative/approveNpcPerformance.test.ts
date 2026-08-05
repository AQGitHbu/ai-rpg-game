import { describe, expect, it } from "vitest";
import { approveNpcPerformance } from "./approveNpcPerformance";

describe("approveNpcPerformance", () => {
  it("rejects an NPC line that claims an unresolved item", () => {
    const result = approveNpcPerformance({
      proposal: { text: "我已经把镖局信物收进怀里了。", emotion: "guarded", usedFactIds: [] },
      allowedFactIds: [],
      unresolvedItemNames: ["镖局信物"],
    });
    expect(result).toMatchObject({ ok: false, category: "state_prose_mismatch" });
  });

  it("allows an NPC to point at an item that is still on the table", () => {
    const result = approveNpcPerformance({
      proposal: { text: "信物还在桌上，别急着拿。", emotion: "guarded", usedFactIds: [] },
      allowedFactIds: [],
      unresolvedItemNames: ["信物"],
    });
    expect(result.ok).toBe(true);
  });
});
