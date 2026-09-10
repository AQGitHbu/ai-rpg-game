import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  SMOKE_CASES,
  SMOKE_LIMITS,
  buildBranchSummaryLine,
  buildOpeningSummaryLine,
  buildRunSummaryLine,
  realRunOpening,
  realRunContinuation,
  resolveOutputFormatLabel,
  runStagedNarrativeSmoke,
  summarizeAuditEvents,
  summarizeSmokeRun,
  validateBranchReport,
  validateOpeningReport,
} from "./stagedNarrativeSmoke.mjs";

// ---------------------------------------------------------------------------
// 分阶段叙事真实 AI smoke 的安全门禁测试：绝不访问网络。
//
// 主体用例注入 mock runOpening/runContinuation；末尾有一条离线实跑用例，以
// 占位 AI 配置驱动真实 realRunOpening（unavailable → stable failed result，
// 临时 SQLite，fetch 记录器拦截）。真实 smoke（RUN_REAL_AI_SMOKE=1）只允许
// 人工 opt-in 执行。
//
// 覆盖 Plan Task 12 Step 1 的脚本侧要求：无门禁失败退出、独立临时库、
// 不读写用户 current slot、超总请求预算停止。
// ---------------------------------------------------------------------------

const SECRET_ENV = {
  AI_API_BASE_URL: "https://secret-provider.example/v1",
  AI_MODEL: "secret-model-name",
  AI_API_KEY: "sk-super-secret-value",
};

/** 合法的开局报告：生成成功、可 reload 且两次续接都成功。 */
function okOpeningReport(gameType, overrides = {}) {
  return {
    gameType,
    ok: true,
    source: "generated",
    reloadOk: true,
    durationMs: 1234,
    requestCount: 12,
    branches: [
      { candidateId: "cand_left", ok: true, durationMs: 400, requestCount: 5 },
      { candidateId: "cand_right", ok: true, durationMs: 500, requestCount: 5 },
    ],
    ...overrides,
  };
}

/** 合法的续接报告。 */
function okBranchReport(candidateId, overrides = {}) {
  return { candidateId, ok: true, durationMs: 400, requestCount: 5, ...overrides };
}

function createHarness({ runOpening, runContinuation, envCheckOk = true, env = {} } = {}) {
  const calls = [];
  const logs = [];
  return {
    calls,
    logs,
    deps: {
      env,
      runEnvCheck: async () => {
        calls.push("env-check");
        return { ok: envCheckOk };
      },
      // 一局 = 开局 + 该局两个分支续接：编排层只调 runOpening，
      // 续接由 runOpening 在真实路径内部驱动（注入的 mock 同形）。
      runOpening:
        runOpening ??
        (async (smokeCase) => {
          calls.push(`opening:${smokeCase.gameType}`);
          for (const candidateId of smokeCase.candidateIds) calls.push(`branch:${candidateId}`);
          return okOpeningReport(smokeCase.gameType,
            smokeCase.playToEnding === true ? { playthrough: { endingReached: true, turns: 10 } } : {});
        }),
      runContinuation:
        runContinuation ??
        (async (context) => okBranchReport(context.candidateId)),
      log: (line) => logs.push(line),
    },
  };
}

/** 在 mock 运行期间安装 fetch 记录器：任何调用都视为违规。 */
async function withFetchRecorder(run) {
  const original = globalThis.fetch;
  const fetchCalls = [];
  globalThis.fetch = async (...args) => {
    fetchCalls.push(args);
    throw new Error("smoke gate test must never fetch");
  };
  try {
    return { result: await run(), fetchCalls };
  } finally {
    globalThis.fetch = original;
  }
}

test("固定覆盖三组合法输入，且每局同一批准决策各两个分支", () => {
  assert.equal(SMOKE_CASES.length, 3);
  assert.deepEqual(
    SMOKE_CASES.map((smokeCase) => smokeCase.gameType),
    ["wuxia", "science_fiction", "urban"],
  );
  for (const smokeCase of SMOKE_CASES) {
    assert.ok([...smokeCase.input.worldPremise].length >= 20);
    assert.ok([...smokeCase.input.storyOpening].length >= 20);
    assert.ok([...smokeCase.input.characterName].length >= 2);
    assert.ok([...smokeCase.input.characterIdentity].length >= 2);
    // 每局声明恰好两个候选：续接总数必须是 3 局 × 2 = 6。
    assert.equal(smokeCase.candidateIds.length, 2);
    assert.equal(new Set(smokeCase.candidateIds).size, 2);
  }
});

test("有界预算：请求 160 次、45 分钟、单局轮次上限，冻结为常量", () => {
  assert.equal(SMOKE_LIMITS.maxProviderRequests, 160);
  assert.equal(SMOKE_LIMITS.maxDurationMs, 45 * 60 * 1000);
  assert.ok(SMOKE_LIMITS.maxTurnsPerPlaythrough > 0);
});

test("至少一局声明通关验收：续接成功不能替代通关", () => {
  assert.ok(SMOKE_CASES.some((smokeCase) => smokeCase.playToEnding === true));
});

test("缺少 RUN_REAL_AI_SMOKE=1：退出非零，且不 env:check、不跑 case、不 fetch", async () => {
  const harness = createHarness({ env: {} });
  const { result, fetchCalls } = await withFetchRecorder(() =>
    runStagedNarrativeSmoke(harness.deps),
  );
  assert.notEqual(result, 0);
  assert.deepEqual(harness.calls, []);
  assert.equal(fetchCalls.length, 0);
  assert.ok(harness.logs.some((line) => line.includes("SMOKE_OPT_IN_REQUIRED")));
});

test("opt-in 后先 env:check 再依序跑三局开局（每局两分支）", async () => {
  const harness = createHarness({ env: { RUN_REAL_AI_SMOKE: "1" } });
  const { result, fetchCalls } = await withFetchRecorder(() =>
    runStagedNarrativeSmoke(harness.deps),
  );
  assert.equal(result, 0);
  assert.equal(fetchCalls.length, 0);
  assert.deepEqual(harness.calls, [
    "env-check",
    "opening:wuxia",
    "branch:cand_left",
    "branch:cand_right",
    "opening:science_fiction",
    "branch:cand_left",
    "branch:cand_right",
    "opening:urban",
    "branch:cand_left",
    "branch:cand_right",
  ]);
});

test("env:check 失败：退出非零且不跑任何 case", async () => {
  const harness = createHarness({
    env: { RUN_REAL_AI_SMOKE: "1" },
    envCheckOk: false,
  });
  const exitCode = await runStagedNarrativeSmoke(harness.deps);
  assert.notEqual(exitCode, 0);
  assert.deepEqual(harness.calls, ["env-check"]);
  assert.ok(harness.logs.some((line) => line.includes("SMOKE_ENV_CHECK_FAILED")));
});

test("stdout 永不包含键值或玩家输入", async () => {
  const harness = createHarness({
    env: { RUN_REAL_AI_SMOKE: "1", ...SECRET_ENV },
  });
  await runStagedNarrativeSmoke(harness.deps);
  const joined = harness.logs.join("\n");
  for (const secret of Object.values(SECRET_ENV)) {
    assert.ok(!joined.includes(secret), "日志泄漏了敏感值片段");
  }
  for (const smokeCase of SMOKE_CASES) {
    assert.ok(!joined.includes(smokeCase.input.worldPremise));
    assert.ok(!joined.includes(smokeCase.input.storyOpening));
    assert.ok(!joined.includes(smokeCase.input.characterName));
  }
});

test("只有 generated 算成功；每局输出白名单摘要", async () => {
  const harness = createHarness({
    env: { RUN_REAL_AI_SMOKE: "1" },
    runOpening: async (smokeCase) => okOpeningReport(smokeCase.gameType, { source: "fallback" }),
  });
  const exitCode = await runStagedNarrativeSmoke(harness.deps);
  assert.notEqual(exitCode, 0);
  assert.ok(harness.logs.some((line) => line.includes("STAGED_OPENING_VIOLATION")));
});

test("续接失败：该局违约并计入退出码", async () => {
  const harness = createHarness({
    env: { RUN_REAL_AI_SMOKE: "1" },
    runOpening: async (smokeCase) => okOpeningReport(smokeCase.gameType, {
      branches: [
        okBranchReport("cand_left"),
        okBranchReport("cand_right", { ok: false, failureCode: "AI_GENERATION_FAILED", failureKind: "AI_CALL_FAILED" }),
      ],
    }),
  });
  const exitCode = await runStagedNarrativeSmoke(harness.deps);
  assert.notEqual(exitCode, 0);
  assert.ok(harness.logs.some((line) => line.includes("STAGED_BRANCH_VIOLATION")));
});

test("runOpening 抛错：记崩溃码且不回显异常文本", async () => {
  const harness = createHarness({
    env: { RUN_REAL_AI_SMOKE: "1" },
    runOpening: async () => { throw new Error("C:/secret/path/leak.sqlite"); },
  });
  const exitCode = await runStagedNarrativeSmoke(harness.deps);
  assert.notEqual(exitCode, 0);
  const joined = harness.logs.join("\n");
  assert.ok(joined.includes("STAGED_OPENING_CRASHED"));
  assert.ok(!joined.includes("secret/path"));
});

test("全部开局真实失败：必须失败退出（反对「合法失败冒充通过」的回归）", async () => {
  const harness = createHarness({
    env: { RUN_REAL_AI_SMOKE: "1" },
    // 复现真实运行观测到的形态：ok=false、requestCount=0、编码合法的失败原因。
    runOpening: async (smokeCase) => ({
      gameType: smokeCase.gameType,
      ok: false,
      durationMs: 22,
      requestCount: 0,
      failureCode: "INFRASTRUCTURE_FAILURE",
      failureKind: "AI_CALL_FAILED",
    }),
  });
  const exitCode = await runStagedNarrativeSmoke(harness.deps);
  assert.notEqual(exitCode, 0);
  const joined = harness.logs.join("\n");
  assert.ok(joined.includes("STAGED_OPENING_VIOLATION"));
  assert.ok(joined.includes("SMOKE_FAILED"));
  assert.ok(!joined.includes("SMOKE_OK"), "失败运行不得输出 SMOKE_OK");
});

test("报告非对象：记 REPORT_MISSING 且不抛出", async () => {
  const harness = createHarness({
    env: { RUN_REAL_AI_SMOKE: "1" },
    runOpening: async () => null,
  });
  const exitCode = await runStagedNarrativeSmoke(harness.deps);
  assert.notEqual(exitCode, 0);
  assert.ok(harness.logs.some((line) => line.includes("REPORT_MISSING")));
});

test("超总请求预算：停止后续局并记录未完成", async () => {
  let opened = 0;
  const harness = createHarness({
    env: { RUN_REAL_AI_SMOKE: "1" },
    // 第一局就吃满预算：第二局开始前应触发总量上限并停止。
    runOpening: async (smokeCase) => {
      opened += 1;
      return okOpeningReport(smokeCase.gameType, { requestCount: 200 });
    },
  });
  const exitCode = await runStagedNarrativeSmoke(harness.deps);
  assert.notEqual(exitCode, 0);
  assert.ok(harness.logs.join("\n").includes("SMOKE_BUDGET_STOP"));
  // 第二局之后的局不再执行：只跑了一局。
  assert.equal(opened, 1);
});

test("超时预算：停止后续局并记录未完成", async () => {
  const harness = createHarness({
    env: { RUN_REAL_AI_SMOKE: "1" },
    runOpening: async (smokeCase) => okOpeningReport(smokeCase.gameType, { durationMs: 46 * 60 * 1000 }),
  });
  const exitCode = await runStagedNarrativeSmoke(harness.deps);
  assert.notEqual(exitCode, 0);
  assert.ok(harness.logs.join("\n").includes("SMOKE_BUDGET_STOP"));
});

test("validateOpeningReport：合法通过，越界/缺字段违约", () => {
  assert.deepEqual(validateOpeningReport(okOpeningReport("wuxia")), []);
  assert.ok(validateOpeningReport(null).includes("REPORT_MISSING"));
  assert.ok(validateOpeningReport({ gameType: "wuxia", ok: true, source: "fixture", reloadOk: true, branches: [] })
    .includes("OPENING_SOURCE_NOT_GENERATED"));
  assert.ok(validateOpeningReport({ gameType: "wuxia", ok: false })
    .includes("OPENING_FAILURE_KIND_INVALID"));
  assert.ok(validateOpeningReport({ gameType: "wuxia", ok: false, failureKind: "AI_CALL_FAILED" })
    .includes("OPENING_FAILURE_IDENTITY_MISSING"));
  // 编码完全合法的失败报告（kind 在白名单内 + 有 failureCode）仍必须违约：
  // 通过标准是「每局都由真实 AI 生成」，绝不允许失败冒充通过。
  assert.ok(validateOpeningReport({
    gameType: "wuxia",
    ok: false,
    failureCode: "INFRASTRUCTURE_FAILURE",
    failureKind: "AI_CALL_FAILED",
  }).includes("OPENING_NOT_GENERATED"));
  // 分支数不为 2：拒绝（保证「同一决策两个分支」不被静默降级）。
  assert.ok(validateOpeningReport(okOpeningReport("wuxia", { branches: [] })).includes("OPENING_BRANCH_COUNT_INVALID"));
  // 分支失败但 kind 合法：仍按违约计入（未完成即不通过）。
  assert.ok(validateOpeningReport(okOpeningReport("wuxia", {
    branches: [{ candidateId: "a", ok: false, failureKind: "AI_CALL_FAILED", failureCode: "X" },
      { candidateId: "b", ok: true, durationMs: 1, requestCount: 1 }],
  })).length > 0);
});

test("validateBranchReport：合法通过，未成功/缺 failureKind 违约", () => {
  assert.deepEqual(validateBranchReport(okBranchReport("cand_left")), []);
  assert.ok(validateBranchReport(null).includes("BRANCH_REPORT_MISSING"));
  // 续接未成功即为未完成。
  assert.ok(validateBranchReport({ candidateId: "c", ok: false, failureCode: "X", failureKind: "AI_CALL_FAILED" })
    .includes("BRANCH_NOT_SUCCEEDED"));
  assert.ok(validateBranchReport({ candidateId: "c", ok: false, failureKind: "WAT" })
    .includes("BRANCH_FAILURE_KIND_INVALID"));
});

/** 从 `[staged-smoke] <label> {...}` 摘要行里取出 JSON 主体。 */
function payloadOf(line) {
  const braceIndex = line.indexOf("{");
  assert.ok(braceIndex > 0, `摘要行缺少 JSON 主体：${line.slice(0, 40)}`);
  return JSON.parse(line.slice(braceIndex));
}

test("通关局未到结局：违约（续接成功不算通关）", async () => {
  const harness = createHarness({
    env: { RUN_REAL_AI_SMOKE: "1" },
    runOpening: async (smokeCase) => okOpeningReport(smokeCase.gameType, {
      playthrough: { endingReached: false, turns: 40 },
    }),
  });
  const exitCode = await runStagedNarrativeSmoke(harness.deps);
  assert.notEqual(exitCode, 0);
  assert.ok(harness.logs.join("\n").includes("PLAYTHROUGH_ENDING_NOT_REACHED"));
});

test("摘要行只含白名单键，且不含请求正文", () => {
  const parsed = payloadOf(buildOpeningSummaryLine(okOpeningReport("wuxia", {
    playthrough: { endingReached: true, turns: 12 },
  })));
  assert.deepEqual(
    Object.keys(parsed).sort(),
    ["branches", "durationMs", "gameType", "ok", "playthrough", "requestCount", "source"].sort(),
  );
  assert.equal(parsed.branches.length, 2);
  assert.deepEqual(parsed.playthrough, { endingReached: true, turns: 12 });

  const branchParsed = payloadOf(buildBranchSummaryLine(okBranchReport("cand_left")));
  assert.deepEqual(Object.keys(branchParsed).sort(), ["candidateId", "durationMs", "ok", "requestCount"].sort());
});

test("summarizeAuditEvents：区分结果类别并累加用量", () => {
  const summary = summarizeAuditEvents([
    { outcome: "ok", promptTokens: 10, completionTokens: 20, totalTokens: 30, estimatedCostUsd: 0.01 },
    { transportCode: "timeout" },
    { category: "invalid_schema" },
    { outcome: "failed" },
  ]);
  assert.deepEqual(summary.codes, ["attempt_ok", "transport_timeout", "invalid_schema"]);
  assert.equal(summary.usage.totalTokens, 30);
  assert.ok(Math.abs(summary.estimatedCostUsd - 0.01) < 1e-9);
  // 无 story_text 事件时 sources 为空：来源不可信，不得被当成 generated。
  assert.deepEqual(summary.sources, []);
});

test("summarizeAuditEvents：只从 story_text 事件收集来源标记", () => {
  const summary = summarizeAuditEvents([
    // ai_call 事件不带 story_text 语义：其 source 字段不得被当作来源依据。
    { kind: "ai_call", source: "generated" },
    { kind: "story_text", source: "generated" },
    { kind: "story_text", source: "fixture" },
  ]);
  assert.deepEqual(summary.sources, ["generated", "fixture"]);
});

test("resolveOutputFormatLabel：空白回退 prompt_only，非法值不回显", () => {
  assert.equal(resolveOutputFormatLabel(undefined), "prompt_only");
  assert.equal(resolveOutputFormatLabel("  "), "prompt_only");
  assert.equal(resolveOutputFormatLabel("json_schema"), "json_schema");
  assert.equal(resolveOutputFormatLabel("evil-value"), "invalid");
});

test("CLI 依赖装配：输出格式标签取自 AI 配置来源，而非 process.env", async () => {
  // 真实缺陷回归：realRunCaseDeps 曾读 process.env.AI_OUTPUT_FORMAT，而真实链路
  // 的配置来自 findUsableAiEnvSource（可能回退主仓 .env.local）。两者不一致时
  // 摘要会显示 prompt_only 而链路实际按 json_object 运行。
  const scriptPath = new URL("./stagedNarrativeSmoke.mjs", import.meta.url);
  const source = readFileSync(scriptPath, "utf8");
  const start = source.indexOf("function realRunCaseDeps");
  assert.ok(start > 0, "被测脚本必须含 realRunCaseDeps");
  const body = source.slice(start, source.indexOf("\n}", start));
  assert.ok(
    !/process\.env\.AI_OUTPUT_FORMAT/.test(body),
    "realRunCaseDeps 不得直接读 process.env.AI_OUTPUT_FORMAT",
  );
  assert.ok(body.includes("resolveAiEnvOrEmpty"), "outputFormatLabel 必须从 AI 配置来源解析");
});

test("summarizeSmokeRun：无 opt-in 时不出 summary 行", async () => {
  const harness = createHarness({ env: {} });
  await runStagedNarrativeSmoke(harness.deps);
  assert.ok(!harness.logs.some((line) => line.includes("STAGED_SMOKE_SUMMARY")));
});

test("离线实跑：占位 AI 配置 → 稳定失败，零 fetch，不泄漏配置", async () => {
  // 必须用**被 aiRuntimeConfig 判为 unavailable** 的配置（占位值），而不是
  // 一个合法但不可达的 URL：后者仍会装配 live source 并真实发起（失败的）
  // 网络请求，使「零 fetch」断言失去意义。
  const offlineEnv = {
    AI_API_BASE_URL: "change-me",
    AI_MODEL: "offline-placeholder",
    AI_API_KEY: "offline-placeholder-key",
    AI_OUTPUT_FORMAT: "prompt_only",
  };
  const { result, fetchCalls } = await withFetchRecorder(() =>
    realRunOpening(SMOKE_CASES[0], { aiEnv: offlineEnv }),
  );
  assert.equal(fetchCalls.length, 0);
  assert.equal(result.ok, false);
  assert.equal(typeof result.failureCode, "string");
  const serialized = JSON.stringify(result);
  // 配置值一律不得回显。
  for (const value of Object.values(offlineEnv)) {
    assert.ok(!serialized.includes(value));
  }
  // 玩家文本输入（世界观/开场/角色名）不得进入报告。
  for (const [key, value] of Object.entries(SMOKE_CASES[0].input)) {
    if (key === "gameType" || key === "gameLength") continue;
    assert.ok(!serialized.includes(String(value)));
  }
});

test("离线实跑：续接在没有真实开局时返回稳定失败，不触网", async () => {
  // 同前：占位值才会被判为 unavailable，从而保证零网络请求。
  const offlineEnv = {
    AI_API_BASE_URL: "change-me",
    AI_MODEL: "offline-placeholder",
    AI_API_KEY: "offline-placeholder-key",
  };
  const { result, fetchCalls } = await withFetchRecorder(() =>
    realRunContinuation(
      { gameType: "wuxia", candidateId: "cand_left", input: SMOKE_CASES[0].input },
      { aiEnv: offlineEnv },
    ),
  );
  assert.equal(fetchCalls.length, 0);
  assert.equal(result.ok, false);
  assert.equal(typeof result.failureCode, "string");
});

test("汇总行：只含白名单字段且不含玩家隐私", () => {
  const summary = summarizeSmokeRun([
    okOpeningReport("wuxia", { playthrough: { endingReached: true, turns: 10 } }),
    okOpeningReport("science_fiction", { ok: false, failureCode: "AI_GENERATION_FAILED" }),
  ], "prompt_only");
  assert.deepEqual(
    Object.keys(summary).sort(),
    ["continuations", "openings", "outputFormat", "playthroughsReached", "totalDurationMs", "totalRequests"].sort(),
  );
  assert.equal(summary.openings.total, 2);
  // 每份报告带两个分支：2 局 × 2 = 4 次续接，且分支自身均成功。
  assert.equal(summary.continuations.total, 4);
  assert.equal(summary.continuations.ok, 4);
  assert.equal(summary.playthroughsReached, 1);
  const line = buildRunSummaryLine([
    okOpeningReport("wuxia"),
    okOpeningReport("science_fiction", { ok: false, failureCode: "AI_GENERATION_FAILED" }),
  ], "prompt_only");
  for (const smokeCase of SMOKE_CASES) {
    assert.ok(!line.includes(smokeCase.input.storyOpening));
  }
});
