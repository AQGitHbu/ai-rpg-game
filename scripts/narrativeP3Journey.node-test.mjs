import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  NARRATIVE_P3_PROTOCOL_VERSION,
  parseNarrativeP3Args,
  runNarrativeP3Journey,
  validateNarrativeP3Args,
} from "./narrativeP3Journey.mjs";
import { installTsHooks } from "./narrativeP1Journey.mjs";

installTsHooks();
const { createNarrativeP3Protocol } = await import("../src/game/application/testing/narrativeP3LiveJourney.ts");
const env = {
  AI_MODEL: "fixture-model",
  AI_API_BASE_URL: "https://fixture.invalid",
  AI_API_KEY: "fixture-secret",
  AI_NARRATIVE_INPUT_MAX_ESTIMATED_TOKENS: "64000",
};
const deps = {
  environment: { model: env.AI_MODEL, apiBaseUrl: env.AI_API_BASE_URL, inputMaxEstimatedTokens: 64_000 },
  codeFingerprint: "fixture-code",
};
const options = { environment: env, codeFingerprint: "fixture-code" };

test("P3 CLI registers a fixed denominator without transport and keeps route statuses", async () => {
  const root = mkdtempSync(join(tmpdir(), "p3-script-register-"));
  try {
    const protocolPath = join(root, "protocol.json");
    assert.deepEqual(parseNarrativeP3Args(["--mode=register", "--run-id=p3", `--protocol=${protocolPath}`, `--output=${root}`]), {
      mode: "register", runId: "p3", protocol: protocolPath, output: root, replaySource: "",
    });
    assert.equal(validateNarrativeP3Args({ mode: "other", runId: "p3", protocol: protocolPath, output: root }), "INVALID_MODE");
    assert.equal(validateNarrativeP3Args({ mode: "register", runId: "", protocol: protocolPath, output: root }), "INVALID_RUN_ID");
    const registered = await runNarrativeP3Journey({ mode: "register", runId: "p3", protocolPath, outputDirectory: root }, options);
    assert.deepEqual(registered, {
      plannedRoutes: 2,
      routes: [
        { routeId: "private", status: "not_run" },
        { routeId: "public", status: "not_run" },
      ],
      completedRoutes: 0,
      httpAttempts: 0,
      passed: false,
    });
    const protocol = JSON.parse(readFileSync(protocolPath, "utf8"));
    assert.equal(protocol.protocolVersion, NARRATIVE_P3_PROTOCOL_VERSION);
    assert.deepEqual(protocol, createNarrativeP3Protocol("p3", deps));
    assert.ok(!JSON.stringify(protocol).includes(env.AI_API_KEY));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P3 live records completed and blocked routes while replay invokes only the zero-HTTP route runner", async () => {
  const root = mkdtempSync(join(tmpdir(), "p3-script-replay-"));
  const previousGate = process.env.RUN_REAL_AI_JOURNEY;
  process.env.RUN_REAL_AI_JOURNEY = "1";
  try {
    const protocolPath = join(root, "protocol.json");
    const record = join(root, "record");
    const replay = join(root, "replay");
    await runNarrativeP3Journey({ mode: "register", runId: "p3", protocolPath, outputDirectory: record }, options);
    const live = await runNarrativeP3Journey({ mode: "live", runId: "p3", protocolPath, outputDirectory: record }, options, {
      routeRunner: async ({ route }) => route.routeId === "private"
        ? { status: "completed", completed: true, httpAttempts: 3, actionCount: 7 }
        : { status: "blocked", completed: false, failureCode: "P3_CAPABILITY_COVERAGE_FAILED", httpAttempts: 2, actionCount: 4 },
    });
    assert.deepEqual(live.routes.map((route) => route.status), ["completed", "blocked"]);
    let replayCalls = 0;
    const replayed = await runNarrativeP3Journey({ mode: "replay", runId: "p3", protocolPath, outputDirectory: replay, replaySource: record }, options, {
      routeRunner: async ({ mode, route }) => {
        replayCalls += 1;
        assert.equal(mode, "replay");
        return route.routeId === "private"
          ? { status: "completed", completed: true, httpAttempts: 0, actionCount: 7 }
          : { status: "blocked", completed: false, failureCode: "P3_CAPABILITY_COVERAGE_FAILED", httpAttempts: 0, actionCount: 4 };
      },
    });
    assert.deepEqual(replayed.routes.map((route) => route.status), ["completed", "blocked"]);
    assert.equal(replayed.httpAttempts, 0);
    assert.equal(replayed.strictReplayPassed, true);
    assert.equal(replayCalls, 2);
  } finally {
    if (previousGate === undefined) delete process.env.RUN_REAL_AI_JOURNEY;
    else process.env.RUN_REAL_AI_JOURNEY = previousGate;
    rmSync(root, { recursive: true, force: true });
  }
});

test("P3 replay rejects fabricated completed status without a recorded route manifest", async () => {
  const root = mkdtempSync(join(tmpdir(), "p3-script-fake-"));
  try {
    const protocolPath = join(root, "protocol.json");
    await runNarrativeP3Journey({ mode: "register", runId: "p3", protocolPath, outputDirectory: root }, options);
    writeFileSync(join(root, "routes.json"), JSON.stringify({ routes: [{ routeId: "private", status: "completed" }, { routeId: "public", status: "completed" }] }));
    await assert.rejects(
      runNarrativeP3Journey({ mode: "replay", runId: "p3", protocolPath, outputDirectory: join(root, "replay"), replaySource: root }, options),
      /P3_ROUTE_MANIFEST_INVALID/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P3 live requires the explicit real-journey gate before creating a runner", async () => {
  const root = mkdtempSync(join(tmpdir(), "p3-script-gate-"));
  const previousGate = process.env.RUN_REAL_AI_JOURNEY;
  delete process.env.RUN_REAL_AI_JOURNEY;
  try {
    await assert.rejects(
      runNarrativeP3Journey({ mode: "live", runId: "p3", protocolPath: join(root, "protocol.json"), outputDirectory: root }, options, {
        routeRunner: async () => { throw new Error("RUNNER_MUST_NOT_BE_CREATED"); },
      }),
      /P3_LIVE_REQUIRES_RUN_REAL_AI_JOURNEY/,
    );
  } finally {
    if (previousGate === undefined) delete process.env.RUN_REAL_AI_JOURNEY;
    else process.env.RUN_REAL_AI_JOURNEY = previousGate;
    rmSync(root, { recursive: true, force: true });
  }
});
