import { test } from "node:test";
import assert from "node:assert/strict";
import { buildVerificationCommand, main, resolveVerificationLayer } from "./storyEvalVerify.mjs";

test("分层解析默认 offline，拒绝未知层", () => {
  assert.equal(resolveVerificationLayer([]), "offline");
  assert.equal(resolveVerificationLayer(["--layer=regression"]), "regression");
  assert.equal(resolveVerificationLayer(["--layer=unknown"]), null);
});

test("offline 不携带真实 AI，regression 使用 regression profile", () => {
  assert.deepEqual(buildVerificationCommand("offline"), {
    script: "scripts/storyEvalJourney.mjs", args: ["--mode=replay"],
  });
  assert.deepEqual(buildVerificationCommand("regression", ["--layer=regression", "--case=wuxia-a"]), {
    script: "scripts/storyEvalJourney.mjs",
    args: ["--mode=record", "--reuse-completed", "--profile=regression", "--case=wuxia-a"],
  });
});

test("真实层没有显式 opt-in 时不 spawn", () => {
  const lines = [];
  const code = main({
    argv: ["--layer=smoke"], env: {}, log: (line) => lines.push(line),
    spawn: () => { throw new Error("must not spawn"); },
  });
  assert.equal(code, 1);
  assert.ok(lines.some((line) => line.includes("REAL_AI_OPT_IN_REQUIRED")));
});

test("release 同时要求 judge opt-in", () => {
  const lines = [];
  const code = main({
    argv: ["--layer=release"], env: { RUN_REAL_AI_STORY_EVAL: "1" }, log: (line) => lines.push(line),
    spawn: () => { throw new Error("must not spawn"); },
  });
  assert.equal(code, 1);
  assert.ok(lines.some((line) => line.includes("JUDGE_OPT_IN_REQUIRED")));
});

