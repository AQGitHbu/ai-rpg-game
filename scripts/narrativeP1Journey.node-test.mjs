import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_NARRATIVE_P1_PROTOCOL_PATH,
  DEFAULT_NARRATIVE_P1_OUTPUT_ROOT,
  closeNarrativeP1Entry,
  parseNarrativeP1Args,
  resolveNarrativeP1ArtifactDirectory,
  validateNarrativeP1Args,
} from "./narrativeP1Journey.mjs";

test("parses register/live/replay arguments without accepting unknown modes", () => {
  assert.deepEqual(parseNarrativeP1Args([
    "--mode=register",
    "--run-id=sample-1",
    "--protocol=protocol.json",
    "--output=artifacts",
  ]), {
    mode: "register",
    runId: "sample-1",
    protocolPath: "protocol.json",
    output: "artifacts",
  });
  assert.equal(validateNarrativeP1Args({ mode: "other", runId: "x", protocolPath: "p", output: "o" }), "INVALID_MODE");
});

test("defaults keep protocol and artifacts in the narrative P1 namespace", () => {
  assert.match(DEFAULT_NARRATIVE_P1_PROTOCOL_PATH, /artifacts[\\/]narrative-p1/);
  assert.match(DEFAULT_NARRATIVE_P1_OUTPUT_ROOT, /artifacts[\\/]narrative-p1/);
});

test("missing required run id is a parameter error", () => {
  assert.equal(validateNarrativeP1Args({ mode: "replay", runId: "", protocolPath: "p", output: "o" }), "MISSING_RUN_ID");
});

test("does not append the run id twice when output already names the run directory", () => {
  assert.match(
    resolveNarrativeP1ArtifactDirectory({ runId: "p1-01", output: "artifacts/narrative-p1/p1-01" }, true),
    /artifacts[\\/]narrative-p1[\\/]p1-01$/,
  );
  assert.match(
    resolveNarrativeP1ArtifactDirectory({ runId: "p1-01", output: "artifacts/narrative-p1" }, false),
    /artifacts[\\/]narrative-p1[\\/]p1-01$/,
  );
});

test("cleanup does not replace a route failure when an entry close rejects", async () => {
  await assert.doesNotReject(() => closeNarrativeP1Entry({ close: async () => { throw new Error("close failed"); } }));
});
