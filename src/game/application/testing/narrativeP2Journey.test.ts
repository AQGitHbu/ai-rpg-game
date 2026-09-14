import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NARRATIVE_P2_INPUT, NARRATIVE_P2_PROTOCOL_VERSION, NARRATIVE_P2_ROUTES, hashP2, readNarrativeP2Protocol, runNarrativeP2Journey, type NarrativeP2JourneyDeps } from "./narrativeP2Journey";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const deps: NarrativeP2JourneyDeps = { environment: { model: "fixture-model", apiBaseUrl: "https://fixture.invalid", inputMaxEstimatedTokens: 64000 }, codeFingerprint: "fixture-code" };
const setup = () => { const root = mkdtempSync(join(tmpdir(), "narrative-p2-protocol-")); roots.push(root); return { runId: "p2-test", protocolPath: join(root, "protocol.json"), outputDirectory: root }; };
describe("P2 frozen experiment orchestration", () => {
  it("registers the single complete protocol without invoking any runner and refuses overwrite", async () => {
    const input = setup();
    const runner = vi.fn();
    expect(await runNarrativeP2Journey({ ...input, mode: "register" }, { ...deps, routeRunner: runner })).toEqual({ plannedRoutes: 2, completedRoutes: 0, passed: true });
    expect(runner).not.toHaveBeenCalled();
    const protocol = JSON.parse(readFileSync(input.protocolPath, "utf8"));
    expect(protocol.protocolVersion).toBe(NARRATIVE_P2_PROTOCOL_VERSION);
    expect(protocol.stages.focusSelection).toBe("first freeInputEnabled NPC in current public view order");
    expect(protocol.routes).toEqual(NARRATIVE_P2_ROUTES);
    expect(protocol.input).toEqual(NARRATIVE_P2_INPUT);
    expect(protocol.transport).toMatchObject({ narrativeHttpPerEpoch: 24, summaryHttpPerEpoch: 8 });
    await expect(runNarrativeP2Journey({ ...input, mode: "register" }, deps)).rejects.toThrow();
  });
  it("rejects changed model/code/budget before running any route", async () => {
    const input = setup();
    await runNarrativeP2Journey({ ...input, mode: "register" }, deps);
    const runner = vi.fn();
    await expect(runNarrativeP2Journey({ ...input, mode: "replay" }, { ...deps, codeFingerprint: "changed", routeRunner: runner })).rejects.toThrow("P2_FROZEN_CONFIGURATION_MISMATCH");
    expect(runner).not.toHaveBeenCalled();
  });
  it("completed JSON files are never accepted as replay evidence", async () => {
    const input = setup();
    await runNarrativeP2Journey({ ...input, mode: "register" }, deps);
    writeFileSync(join(input.outputDirectory, "S-short.json"), '{"completed":true}');
    writeFileSync(join(input.outputDirectory, "M-medium.json"), '{"completed":true}');
    await expect(runNarrativeP2Journey({ ...input, mode: "replay" }, deps)).rejects.toThrow("P2_STAGE_REQUIRED");
  });
  it("fails closed for both stages even with an injected optimistic runner", async () => {
    const input = setup();
    await runNarrativeP2Journey({ ...input, mode: "register" }, deps);
    const runner = vi.fn();
    for (const stage of ["A", "B"] as const) {
      await expect(runNarrativeP2Journey({ ...input, mode: "replay", stage, outputDirectory: join(input.outputDirectory, stage) }, { ...deps, routeRunner: runner })).rejects.toThrow("P2_STAGE_RUNTIME_NOT_IMPLEMENTED");
    }
    expect(runner).not.toHaveBeenCalled();
  });
  it("rejects correctly rehashed v1 protocols without replaying them", async () => {
    const input = setup();
    await runNarrativeP2Journey({ ...input, mode: "register" }, deps);
    const { protocolHash: ignored, ...body } = JSON.parse(readFileSync(input.protocolPath, "utf8"));
    expect(ignored).toBeTruthy();
    body.protocolVersion = "narrative-p2/v1";
    writeFileSync(input.protocolPath, JSON.stringify({ ...body, protocolHash: hashP2(body) }));
    expect(() => readNarrativeP2Protocol(input.protocolPath)).toThrow("P2_PROTOCOL_VERSION_UNSUPPORTED_USE_FROZEN_IMPLEMENTATION");
  });
});
