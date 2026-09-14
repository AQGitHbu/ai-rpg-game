import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NARRATIVE_P2_INPUT, NARRATIVE_P2_PROTOCOL_VERSION, NARRATIVE_P2_ROUTES, runNarrativeP2Journey, type NarrativeP2JourneyDeps } from "./narrativeP2Journey";
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
    await expect(runNarrativeP2Journey({ ...input, mode: "replay" }, deps)).rejects.toThrow("P2_PRODUCTION_ADAPTER_REQUIRED");
  });
  it("both routes stay in the denominator and coverage plus strict replay are required", async () => {
    const input = setup();
    await runNarrativeP2Journey({ ...input, mode: "register" }, deps);
    const runner = vi.fn(async () => ({ completed: true, coveragePassed: true, strictReplayPassed: false, httpAttempts: 0, logicalAttempts: 2, actionCount: 1 }));
    expect(await runNarrativeP2Journey({ ...input, mode: "replay", outputDirectory: join(input.outputDirectory, "replay") }, { ...deps, routeRunner: runner })).toEqual({ plannedRoutes: 2, completedRoutes: 2, passed: false });
    expect(runner.mock.calls).toHaveLength(2);
  });
});
