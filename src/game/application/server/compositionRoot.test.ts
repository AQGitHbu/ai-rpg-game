// @vitest-environment node

import { describe, expect, it } from "vitest";
import { getServerGameEntryPoints } from "./compositionRoot";

describe("getServerGameEntryPoints", () => {
  it("returns one process-wide entry point so route bundles share the narrative ensure lock", () => {
    const first = getServerGameEntryPoints();
    const second = getServerGameEntryPoints();

    expect(second).toBe(first);
  });
});
