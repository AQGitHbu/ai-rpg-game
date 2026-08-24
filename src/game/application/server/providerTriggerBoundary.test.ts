import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");
const occurrences = (source: string, token: string): number => source.split(token).length - 1;

describe("provider trigger architecture boundary", () => {
  it("keeps performTurn free of scene/world provider capabilities", () => {
    const source = read("src/game/application/performTurn.ts");
    expect(source).not.toMatch(/SceneSource|WorldEvolutionSource|generatePendingScene/);
  });

  it("keeps compositionRoot with one pending-job generation entry", () => {
    const source = read("src/game/application/server/compositionRoot.ts");
    expect(occurrences(source, "generatePendingScene({")).toBe(1);
    expect(source).not.toMatch(/shouldCompleteSceneInAction|immediateSceneResult|battleScenePrewarm/);
  });

  it("keeps free-text intent conversion as performTurn's only provider capability", () => {
    const source = read("src/game/application/performTurn.ts");
    expect(source).toMatch(/IntentParserSource/);
    expect(occurrences(source, "intentParserSource")).toBeGreaterThan(0);
  });
});
