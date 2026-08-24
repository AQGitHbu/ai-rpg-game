import { describe, expect, it } from "vitest";
import { decorateNarrativePages, decorateNarrativeText } from "./narrativeText";

describe("narrative text source decoration", () => {
  it("marks fixture text exactly once with the existing player copy", () => {
    expect(decorateNarrativeText("确定性旁白。", "fixture")).toBe("【fallback】确定性旁白。");
    expect(decorateNarrativeText("【fallback】确定性旁白。", "fixture")).toBe("【fallback】确定性旁白。");
  });

  it("leaves generated and blank text unchanged", () => {
    expect(decorateNarrativeText("API 旁白。", "generated")).toBe("API 旁白。");
    expect(decorateNarrativeText("规则旁白。", "rule")).toBe("规则旁白。");
    expect(decorateNarrativeText("", "fixture")).toBe("");
    expect(decorateNarrativeText("   ", "fixture")).toBe("   ");
  });

  it("decorates every page through the same helper", () => {
    expect(decorateNarrativePages(["第一页。", "第二页。"], "fixture"))
      .toEqual(["【fallback】第一页。", "【fallback】第二页。"]);
  });
});
