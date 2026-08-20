import { describe, expect, it } from "vitest";
import { decorateNarrativePages, decorateNarrativeText } from "./narrativeText";

describe("narrative text source decoration", () => {
  it("marks fallback text exactly once", () => {
    expect(decorateNarrativeText("确定性旁白。", "fallback")).toBe("【fallback】确定性旁白。");
    expect(decorateNarrativeText("【fallback】确定性旁白。", "fallback")).toBe("【fallback】确定性旁白。");
  });

  it("leaves generated and blank text unchanged", () => {
    expect(decorateNarrativeText("API 旁白。", "generated")).toBe("API 旁白。");
    expect(decorateNarrativeText("", "fallback")).toBe("");
    expect(decorateNarrativeText("   ", "fallback")).toBe("   ");
  });

  it("decorates every page through the same helper", () => {
    expect(decorateNarrativePages(["第一页。", "第二页。"], "fallback"))
      .toEqual(["【fallback】第一页。", "【fallback】第二页。"]);
  });
});
