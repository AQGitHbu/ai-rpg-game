import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NARRATIVE_P2_INPUT, NARRATIVE_P2_PROTOCOL_VERSION, NARRATIVE_P2_ROUTES, runNarrativeP2Journey } from "./narrativeP2Journey";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("narrativeP2Journey protocol", () => {
  it("registers two frozen short/medium routes without network or narrative text", async () => {
    const root = mkdtempSync(join(tmpdir(), "narrative-p2-protocol-"));
    roots.push(root);
    const protocolPath = join(root, "protocol.json");
    const result = await runNarrativeP2Journey({ mode: "register", runId: "p2-test", protocolPath, outputDirectory: root });
    expect(result).toEqual({ plannedRoutes: 2, completedRoutes: 0, passed: true });
    const protocol = JSON.parse(readFileSync(protocolPath, "utf8")) as Record<string, unknown>;
    expect(protocol.protocolVersion).toBe(NARRATIVE_P2_PROTOCOL_VERSION);
    expect(protocol.routes).toEqual(NARRATIVE_P2_ROUTES);
    expect(protocol.input).toEqual(NARRATIVE_P2_INPUT);
    expect(JSON.stringify(protocol)).not.toContain("prologue");
  });

  it("replay is zero-network and requires both route artifacts", async () => {
    const root = mkdtempSync(join(tmpdir(), "narrative-p2-replay-"));
    roots.push(root);
    const protocolPath = join(root, "protocol.json");
    await runNarrativeP2Journey({ mode: "register", runId: "p2-replay", protocolPath, outputDirectory: root });
    expect(await runNarrativeP2Journey({ mode: "replay", runId: "p2-replay", protocolPath, outputDirectory: root })).toEqual({ plannedRoutes: 2, completedRoutes: 0, passed: false });
  });
});
