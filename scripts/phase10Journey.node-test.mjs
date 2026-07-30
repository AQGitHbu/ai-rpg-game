import assert from "node:assert/strict";
import test from "node:test";
import {
  isPathInside,
  main,
  resolveJourneyMode,
} from "./phase10Journey.mjs";

test("mode defaults to replay and rejects unknown values", () => {
  assert.equal(resolveJourneyMode([]), "replay");
  assert.equal(resolveJourneyMode(["--mode=record"]), "record");
  assert.equal(resolveJourneyMode(["--mode=other"]), null);
});

test("record mode requires explicit opt-in before spawning", () => {
  let spawned = 0;
  const logs = [];
  const code = main({
    argv: ["--mode=record"],
    env: {},
    log: (line) => logs.push(line),
    spawn: () => { spawned += 1; return 0; },
  });
  assert.notEqual(code, 0);
  assert.equal(spawned, 0);
  assert.ok(logs.some((line) => line.includes("REAL_AI_OPT_IN_REQUIRED")));
});

test("replay mode spawns with real AI disabled", () => {
  let childEnv;
  const code = main({
    argv: ["--mode=replay"],
    env: { RUN_REAL_AI_JOURNEY: "1" },
    log: () => {},
    spawn: (env) => { childEnv = env; return 0; },
  });
  assert.equal(code, 0);
  assert.equal(childEnv.RUN_REAL_AI_JOURNEY, "0");
});

test("artifact containment rejects siblings and accepts a child", () => {
  assert.equal(isPathInside("F:/repo/artifacts/phase10", "F:/repo/artifacts/phase10/run-1"), true);
  assert.equal(isPathInside("F:/repo/artifacts/phase10", "F:/repo/data/fixtures"), false);
});

