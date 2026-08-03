import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadStoryEvalCases,
  buildStoryEvalArtifactDir,
  buildPairedRunSpecs,
  main,
  resolveEvalProfile,
  resolveEvalProfileConfig,
  resolveBaseSeed,
  resolveCaseId,
  resolveStrategy,
  resolveBlueprintArtifact,
  resolveJourneyMode,
  resolveRunCount,
} from "./storyEvalJourney.mjs";

test("buildPairedRunSpecs 为同一 case 的策略复用 seed 与 pairId", () => {
  assert.deepEqual(buildPairedRunSpecs([{ caseId: "wuxia-a" }], ["explore", "objective"], 2, 77), [
    { pairId: "wuxia-a-77-1", caseId: "wuxia-a", replicate: 0, seed: 77, strategies: ["explore", "objective"] },
    { pairId: "wuxia-a-78-2", caseId: "wuxia-a", replicate: 1, seed: 78, strategies: ["explore", "objective"] },
  ]);
});

test("三种 profile 解析为明确的场景/重试/超时/分支配置", () => {
  assert.equal(resolveEvalProfile({}), "baseline");
  assert.deepEqual(resolveEvalProfileConfig({ STORY_EVAL_PROFILE: "smoke" }), {
    profile: "smoke", maxScenes: 3, maxRoleAttempts: 1, aiTimeoutMs: 60_000, branchMode: "none", totalBudgetMs: 10 * 60_000,
  });
  assert.deepEqual(resolveEvalProfileConfig({ STORY_EVAL_PROFILE: "regression" }), {
    profile: "regression", maxScenes: 16, maxRoleAttempts: 2, aiTimeoutMs: 90_000, branchMode: "sample", totalBudgetMs: 45 * 60_000,
  });
  assert.deepEqual(resolveEvalProfileConfig({ STORY_EVAL_PROFILE: "baseline" }), {
    profile: "baseline", maxScenes: 60, maxRoleAttempts: 3, aiTimeoutMs: 120_000, branchMode: "full", totalBudgetMs: 90 * 60_000,
  });
  assert.equal(resolveEvalProfile({ STORY_EVAL_PROFILE: "unknown" }), null);
  assert.equal(resolveEvalProfileConfig({ STORY_EVAL_PROFILE: "smoke", STORY_EVAL_BRANCH_MODE: "bad" }), null);
});

test("buildStoryEvalArtifactDir 每次生成唯一目录，避免 calls.jsonl 跨 run 追加", () => {
  const options = {
    artifactRoot: "artifacts/story-eval",
    caseId: "wuxia-a",
    strategy: "explore",
    runIndex: 0,
  };
  const first = buildStoryEvalArtifactDir(options);
  const second = buildStoryEvalArtifactDir(options);
  assert.notEqual(first, second);
  assert.match(first, /wuxia-a-explore-0-/);
  assert.match(second, /wuxia-a-explore-0-/);
});

test("resolveCaseId 缺省 undefined，合法 case 返回 ID，未知 case 返回 null", () => {
  const cases = loadStoryEvalCases();
  assert.equal(resolveCaseId([], cases), undefined);
  assert.equal(resolveCaseId(["--case=wuxia-a"], cases), "wuxia-a");
  assert.equal(resolveCaseId(["--case=bogus"], cases), null);
});

test("resolveStrategy 缺省 undefined，只接受 explore/objective", () => {
  assert.equal(resolveStrategy([]), undefined);
  assert.equal(resolveStrategy(["--strategy=explore"]), "explore");
  assert.equal(resolveStrategy(["--strategy=objective"]), "objective");
  assert.equal(resolveStrategy(["--strategy=bogus"]), null);
});

test("resolveBlueprintArtifact 缺省 undefined，拒绝空值并保留合法路径", () => {
  assert.equal(resolveBlueprintArtifact([]), undefined);
  assert.equal(resolveBlueprintArtifact(["--blueprint-artifact="]), null);
  assert.equal(resolveBlueprintArtifact(["--blueprint-artifact=artifacts/run/calls.jsonl"]), "artifacts/run/calls.jsonl");
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

test("main record 模式未知 profile 打印 INVALID_PROFILE 且不读取凭据", () => {
  const lines = [];
  const code = main({
    argv: ["--mode=record"],
    env: { RUN_REAL_AI_STORY_EVAL: "1", STORY_EVAL_PROFILE: "unknown" },
    sources: () => { throw new Error("must not read"); },
    log: (line) => lines.push(line),
    spawn: () => { throw new Error("must not spawn"); },
  });
  assert.equal(code, 1);
  assert.ok(lines.some((line) => line.includes("INVALID_PROFILE")));
});

test("main record 成对运行：第二策略捕获第一策略的蓝图并复用 seed", () => {
  const envDir = mkdtempSync(join(tmpdir(), "story-eval-env-"));
  const envPath = join(envDir, ".env.local");
  writeFileSync(envPath, [
    "AI_API_BASE_URL=https://example.invalid/v1",
    "AI_MODEL=test-model",
    "AI_API_KEY=test-key",
  ].join("\n"), "utf8");
  const spawned = [];
  try {
    const code = main({
      argv: ["--mode=record", "--case=wuxia-a", "--runs=1", "--seed=77"],
      env: { RUN_REAL_AI_STORY_EVAL: "1", STORY_EVAL_PROFILE: "regression" },
      sources: [envPath],
      log: () => {},
      spawn: (childEnv) => {
        spawned.push(childEnv);
        if (childEnv.STORY_EVAL_STRATEGY === "explore") {
          mkdirSync(childEnv.STORY_EVAL_ARTIFACT_DIR, { recursive: true });
          writeFileSync(join(childEnv.STORY_EVAL_ARTIFACT_DIR, "calls.jsonl"), "{}\n", "utf8");
        }
        return 0;
      },
    });
    assert.equal(code, 0);
    assert.equal(spawned.length, 2);
    assert.equal(spawned[0].STORY_EVAL_SEED, "77");
    assert.equal(spawned[1].STORY_EVAL_SEED, "77");
    assert.equal(spawned[0].STORY_EVAL_PAIR_ID, spawned[1].STORY_EVAL_PAIR_ID);
    assert.equal(spawned[0].STORY_EVAL_BLUEPRINT_ARTIFACT, undefined);
    assert.equal(spawned[1].STORY_EVAL_BLUEPRINT_ARTIFACT, join(spawned[0].STORY_EVAL_ARTIFACT_DIR, "calls.jsonl"));
  } finally {
    rmSync(envDir, { recursive: true, force: true });
  }
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
