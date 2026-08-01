import { test } from "node:test";
import assert from "node:assert/strict";
import { computeStoryEvalMetrics, main, pacingRank } from "./storyEvalAnalyze.mjs";

const calls = [
  { kind: "ai_call", role: "director", traceId: "t1", attempt: 1, failureCategory: null },
  { kind: "ai_call", role: "director", traceId: "t2", attempt: 2, failureCategory: "invalid_json" },
  { kind: "ai_call", role: "director", traceId: "t3", attempt: 2, failureCategory: null },
  { kind: "ai_call", role: "writer", traceId: "t4", attempt: 1, failureCategory: null },
  { kind: "ai_call", role: "scenario", traceId: "t5", attempt: 1, failureCategory: null },
  { kind: "role_approval", role: "director", attempt: 1, category: "reference_violation" },
  { kind: "role_approval", role: "writer", attempt: 1, category: "schema_violation" },
  { kind: "plan_approved", attempt: 1, planSummary: { tensionLevel: 1, pacing: "setup" } },
  { kind: "plan_approved", attempt: 2, planSummary: { tensionLevel: 5, pacing: "develop" } },
  { kind: "expansion_decision", decision: { ok: true, expansion: {} } },
  { kind: "expansion_decision", decision: { ok: false, reason: "budget_exhausted" } },
];

const story = [
  { kind: "scene", sceneIndex: 1, mainStage: 1, narration: "aaa bbb ccc", newEvents: [{ type: "narrative_choice" }], fallback: false, directorPlan: { allowedRevealFactIds: [] } },
  { kind: "scene", sceneIndex: 2, mainStage: 2, narration: "aaa bbb ddd", newEvents: [{ type: "fact_discovered" }], fallback: false, directorPlan: { allowedRevealFactIds: ["f1"] } },
  { kind: "scene", sceneIndex: 3, mainStage: 2, narration: "xxx yyy zzz", newEvents: [], fallback: true, directorPlan: null },
  { kind: "ending", sceneIndex: 4, outcome: "success", newEvents: [] },
];

const manifest = { status: "converged", sceneCount: 3, fallbackScenes: 1 };

test("computeStoryEvalMetrics 计算全部客观指标", () => {
  const metrics = computeStoryEvalMetrics({ calls, story, manifest });
  assert.equal(metrics.sceneCount, 3);
  assert.equal(metrics.converged, true);
  assert.equal(metrics.fallbackRate, 1 / 3);
  assert.equal(metrics.perRole.director.attempts, 3);
  assert.equal(metrics.perRole.director.retries, 2);      // t2/t3 的 attempt>1
  assert.equal(metrics.perRole.director.invalidJson, 1);
  assert.equal(metrics.perRole.writer.attempts, 1);
  assert.equal(metrics.approvalRejections.reference_violation, 1);
  assert.equal(metrics.approvalRejections.schema_violation, 1);
  assert.deepEqual(metrics.tension.values, [1, 5]);
  assert.equal(metrics.tension.stddev, 2);                // [1,5] 总体标准差 = 2
  assert.deepEqual(metrics.pacing.distribution, { setup: 1, develop: 1 });
  assert.equal(metrics.pacing.illegalOrderCount, 0);      // setup→develop 合法
  assert.deepEqual(metrics.factsPerAct, [{ act: 1, revealed: 0 }, { act: 2, revealed: 1 }]);
  assert.ok(metrics.trigramRepeat > 0 && metrics.trigramRepeat < 1);
  assert.equal(metrics.narrationLengths.mean > 0, true);
  assert.equal(metrics.expansions.proposed, 2);
  assert.equal(metrics.expansions.approved, 1);
  assert.equal(metrics.expansions.adoptionRate, 0.5);
  assert.equal(metrics.maxScenesHit, false);
});

test("pacingRank 顺序合法判定", () => {
  assert.ok(pacingRank("setup") < pacingRank("develop"));
  assert.equal(pacingRank("climax"), 3);
  assert.equal(pacingRank("bogus"), -1);
});

test("main 对给定 runDir 写 metrics.json 并打印摘要", () => {
  const files = {};
  const code = main({
    argv: ["/run/dir"],
    fs: {
      readFileSync: (path) => {
        if (path.endsWith("calls.jsonl")) return calls.map((line) => JSON.stringify(line)).join("\n") + "\n";
        if (path.endsWith("story.jsonl")) return story.map((line) => JSON.stringify(line)).join("\n") + "\n";
        if (path.endsWith("manifest.json")) return JSON.stringify(manifest);
        throw new Error(`unexpected read: ${path}`);
      },
      writeFileSync: (path, content) => { files[path] = content; },
    },
    log: () => {},
  });
  assert.equal(code, 0);
  assert.ok(files["/run/dir/metrics.json"] !== undefined);
  const written = JSON.parse(files["/run/dir/metrics.json"]);
  assert.equal(written.sceneCount, 3);
});

test("main 无参数时 RUN_DIR_REQUIRED", () => {
  const lines = [];
  const code = main({ argv: [], fs: {}, log: (line) => lines.push(line) });
  assert.equal(code, 1);
  assert.ok(lines.some((line) => line.includes("RUN_DIR_REQUIRED")));
});
