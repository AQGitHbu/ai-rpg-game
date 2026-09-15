import { describe, expect, it } from "vitest";
import { discoveryModeOf, isExplicitInvestigation } from "./investigation";

describe("investigation domain contract", () => {
  it("defaults an ordinary fact to automatic observation", () => {
    expect(discoveryModeOf({})).toBe("automatic");
    expect(isExplicitInvestigation({})).toBe(false);
  });

  it("does not infer explicit investigation from approaches", () => {
    expect(discoveryModeOf({ discoveryMode: "automatic" })).toBe("automatic");
    expect(isExplicitInvestigation({ discoveryMode: "investigation" })).toBe(true);
  });
});
