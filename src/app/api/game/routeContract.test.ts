/** @vitest-environment node */
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const API_ROOT = join(process.cwd(), "src/app/api");

function collectRoutes(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectRoutes(path);
    return entry.name === "route.ts" ? [relative(API_ROOT, path).replaceAll("\\", "/")] : [];
  });
}

describe("canonical game route tree", () => {
  it("contains exactly the six neutral routes and no compatibility endpoints", () => {
    expect(collectRoutes(API_ROOT).sort()).toEqual([
      "game/actions/route.ts",
      "game/current/route.ts",
      "game/dev/current/route.ts",
      "game/narrative/ensure/route.ts",
      "game/prologue/ack/route.ts",
      "game/route.ts",
    ]);
  });
});
