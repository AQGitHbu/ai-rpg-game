import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NARRATIVE_P2_PROTOCOL_VERSION, parseNarrativeP2Args, runNarrativeP2Journey, validateNarrativeP2Args } from "./narrativeP2Journey.mjs";

test("P2 script registers a protocol and replay never needs a provider", async () => {
  const root = mkdtempSync(join(tmpdir(), "p2-script-"));
  try {
    const protocol = join(root, "protocol.json");
    assert.deepEqual(parseNarrativeP2Args(["--mode=register", "--run-id=p2", `--protocol=${protocol}`, `--output=${root}`]), { mode: "register", runId: "p2", protocol, output: root, replaySource: "" });
    assert.equal(validateNarrativeP2Args({ mode: "other", runId: "p2", protocol, output: root }), "INVALID_MODE");
    assert.deepEqual(await runNarrativeP2Journey({ mode: "register", runId: "p2", protocolPath: protocol, outputDirectory: root }), { plannedRoutes: 2, completedRoutes: 0, passed: true });
    assert.equal(JSON.parse(readFileSync(protocol, "utf8")).protocolVersion, NARRATIVE_P2_PROTOCOL_VERSION);
    assert.deepEqual(await runNarrativeP2Journey({ mode: "replay", runId: "p2", protocolPath: protocol, outputDirectory: root }), { plannedRoutes: 2, completedRoutes: 0, passed: false });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("P2 replay reports both completed route artifacts", async () => {
  const root = mkdtempSync(join(tmpdir(), "p2-script-complete-"));
  try {
    const protocol = join(root, "protocol.json");
    await runNarrativeP2Journey({ mode: "register", runId: "p2", protocolPath: protocol, outputDirectory: root });
    writeFileSync(join(root, "S-short.json"), JSON.stringify({ completed: true }));
    writeFileSync(join(root, "M-medium.json"), JSON.stringify({ completed: true }));
    assert.deepEqual(await runNarrativeP2Journey({ mode: "replay", runId: "p2", protocolPath: protocol, outputDirectory: root }), { plannedRoutes: 2, completedRoutes: 2, passed: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
