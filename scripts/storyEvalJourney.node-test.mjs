import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadStoryEvalCases,
  main,
  resolveBaseSeed,
  resolveCaseId,
  resolveJourneyMode,
  resolveRunCount,
} from "./storyEvalJourney.mjs";

test("resolveCaseId 缺省 undefined，合法 case 返回 ID，未知 case 返回 null", () => {
  const cases = loadStoryEvalCases();
  assert.equal(resolveCaseId([], cases), undefined);
  assert.equal(resolveCaseId(["--case=wuxia-a"], cases), "wuxia-a");
  assert.equal(resolveCaseId(["--case=bogus"], cases), null);
});

test("main 未知 case 打印 INVALID_CASE、不 spawn 且 exit 1", () => {
  const lines = [];
  const code = main({
    argv: ["--mode=record", "--case=bogus"],
    env: { RUN_REAL_AI_STORY_EVAL: "1" },
    sources: () => [],
    log: (line) => lines.push(line),
    spawn: () => { throw new Error("must not spawn"); },
  });
  assert.equal(code, 1);
  assert.ok(lines.some((line) => line.includes("INVALID_CASE")));
});

test("main 无 --case 时 --runs 复制被拒绝", () => {
  const lines = [];
  const code = main({
    argv: ["--mode=record", "--runs=2"],
    env: { RUN_REAL_AI_STORY_EVAL: "1" },
    sources: () => [],
    log: (line) => lines.push(line),
    spawn: () => { throw new Error("must not spawn"); },
  });
  assert.equal(code, 1);
  assert.ok(lines.some((line) => line.includes("REPLICATE_REQUIRES_CASE")));
});

test("resolveJourneyMode 只接受 record/replay", () => {
  assert.equal(resolveJourneyMode(["--mode=record"]), "record");
  assert.equal(resolveJourneyMode(["--mode=replay"]), "replay");
  assert.equal(resolveJourneyMode([]), "replay");
  assert.equal(resolveJourneyMode(["--mode=bogus"]), null);
});

test("resolveRunCount 缺省 1，解析正整数", () => {
  assert.equal(resolveRunCount([]), 1);
  assert.equal(resolveRunCount(["--runs=3"]), 3);
  assert.equal(resolveRunCount(["--runs=0"]), null);
  assert.equal(resolveRunCount(["--runs=abc"]), null);
});

test("resolveBaseSeed 缺省 20260731，解析数字", () => {
  assert.equal(resolveBaseSeed([]), 20260731);
  assert.equal(resolveBaseSeed(["--seed=42"]), 42);
  assert.equal(resolveBaseSeed(["--seed=x"]), null);
});

test("main 在 record 模式且 RUN_REAL_AI_STORY_EVAL 未设置时打印提示并 exit 1", () => {
  const lines = [];
  const code = main({
    argv: ["--mode=record"],
    env: {},
    log: (line) => lines.push(line),
    spawn: () => { throw new Error("must not spawn"); },
  });
  assert.equal(code, 1);
  assert.ok(lines.some((line) => line.includes("REAL_AI_OPT_IN_REQUIRED")));
});

test("main replay 模式 spawn 离线 vitest 且不要求 AI 凭据", () => {
  let spawnedEnv = null;
  const code = main({
    argv: ["--mode=replay"],
    env: {},
    log: () => {},
    spawn: (env) => { spawnedEnv = env; return 0; },
  });
  assert.equal(code, 0);
  assert.ok(spawnedEnv !== null);
  assert.equal(spawnedEnv.RUN_REAL_AI_STORY_EVAL, "0");
});

test("main record 模式缺 AI 凭据时 AI_ENV_INVALID", () => {
  const lines = [];
  const code = main({
    argv: ["--mode=record"],
    env: { RUN_REAL_AI_STORY_EVAL: "1" },
    // sources 注入空列表：确定性失败，不依赖真实 .env 文件（测试环境隔离）。
    sources: () => [],
    log: (line) => lines.push(line),
    spawn: () => { throw new Error("must not spawn"); },
  });
  assert.equal(code, 1);
  assert.ok(lines.some((line) => line.includes("AI_ENV_INVALID")));
});

test("main replay 模式 spawn 抛错时 SPAWN_FAILED 并 exit 1", () => {
  const lines = [];
  const code = main({
    argv: ["--mode=replay"],
    env: {},
    log: (line) => lines.push(line),
    spawn: () => { throw new Error("boom"); },
  });
  assert.equal(code, 1);
  assert.ok(lines.some((line) => line.includes("SPAWN_FAILED")));
});
