import assert from "node:assert/strict";
import test from "node:test";
import {
  SMOKE_CASES,
  buildCaseSummaryLine,
  checkContentBudget,
  realRunCase,
  resolveOutputFormatLabel,
  runPhase4bAiSmoke,
  summarizeAuditEvents,
  summarizeSmokeRun,
  validateCaseReport,
} from "./phase4bAiSmoke.mjs";

// ---------------------------------------------------------------------------
// Phase 4B 真实 AI smoke 的安全门禁测试：绝不访问网络。主体用例 mock
// runEnvCheck/runCase；末尾另有一条离线实跑用例，以占位 AI 配置驱动真实
// realRunCase（unavailable → 确定性 fallback，临时 SQLite，fetch 记录器拦截）。
// 真实 smoke（RUN_REAL_AI_SMOKE=1）只允许人工 opt-in 执行。
// ---------------------------------------------------------------------------

const SECRET_ENV = {
  AI_API_BASE_URL: "https://secret-provider.example/v1",
  AI_MODEL: "secret-model-name",
  AI_API_KEY: "sk-super-secret-value",
};

function okReport(gameType, source = "generated") {
  return {
    gameType,
    ok: true,
    source,
    durationMs: 1234,
    codes: ["LIVE_TRANSPORT_TIMEOUT"],
    usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
    reloadOk: true,
    openingRuntimeOk: true,
  };
}

function createHarness({ runCase, envCheckOk = true, env = {} } = {}) {
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
      runCase:
        runCase ??
        (async (smokeCase) => {
          calls.push(`case:${smokeCase.gameType}`);
          return okReport(smokeCase.gameType);
        }),
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

test("固定覆盖武侠/科幻/都市三组合法输入", () => {
  assert.deepEqual(
    SMOKE_CASES.map((smokeCase) => smokeCase.gameType),
    ["wuxia", "science_fiction", "urban"],
  );
  for (const smokeCase of SMOKE_CASES) {
    assert.equal(smokeCase.input.gameType, smokeCase.gameType);
    assert.equal(smokeCase.input.gameLength, "medium");
    // 与 domain 校验的下限保持一致：worldPremise ≥ 20、storyOpening ≥ 20。
    assert.ok([...smokeCase.input.worldPremise].length >= 20);
    assert.ok([...smokeCase.input.storyOpening].length >= 20);
    assert.ok([...smokeCase.input.characterName].length >= 2);
    assert.ok([...smokeCase.input.characterIdentity].length >= 2);
  }
});

test("缺少 RUN_REAL_AI_SMOKE=1：退出非零，且不 env:check、不跑 case、不 fetch", async () => {
  const harness = createHarness({ env: {} });
  const { result, fetchCalls } = await withFetchRecorder(() =>
    runPhase4bAiSmoke(harness.deps),
  );
  assert.notEqual(result, 0);
  assert.deepEqual(harness.calls, []);
  assert.equal(fetchCalls.length, 0);
  assert.ok(harness.logs.some((line) => line.includes("SMOKE_OPT_IN_REQUIRED")));
});

test("opt-in 后先 env:check 再依序跑三例，整体成功", async () => {
  const harness = createHarness({ env: { RUN_REAL_AI_SMOKE: "1" } });
  const { result, fetchCalls } = await withFetchRecorder(() =>
    runPhase4bAiSmoke(harness.deps),
  );
  assert.equal(result, 0);
  assert.equal(fetchCalls.length, 0);
  assert.deepEqual(harness.calls, [
    "env-check",
    "case:wuxia",
    "case:science_fiction",
    "case:urban",
  ]);
});

test("env:check 失败：退出非零且不跑任何 case", async () => {
  const harness = createHarness({
    env: { RUN_REAL_AI_SMOKE: "1" },
    envCheckOk: false,
  });
  const exitCode = await runPhase4bAiSmoke(harness.deps);
  assert.notEqual(exitCode, 0);
  assert.deepEqual(harness.calls, ["env-check"]);
  assert.ok(harness.logs.some((line) => line.includes("SMOKE_ENV_CHECK_FAILED")));
});

test("stdout 永不包含键值、玩家输入或 prompt 素材", async () => {
  const harness = createHarness({
    env: { RUN_REAL_AI_SMOKE: "1", ...SECRET_ENV },
  });
  await runPhase4bAiSmoke(harness.deps);
  const joined = harness.logs.join("\n");
  for (const secret of Object.values(SECRET_ENV)) {
    assert.ok(!joined.includes(secret), `日志泄漏了敏感值片段：${secret.length} chars`);
  }
  for (const smokeCase of SMOKE_CASES) {
    assert.ok(!joined.includes(smokeCase.input.worldPremise));
    assert.ok(!joined.includes(smokeCase.input.storyOpening));
    assert.ok(!joined.includes(smokeCase.input.characterName));
  }
});

test("只有 generated 算真实 AI smoke 成功；每例输出白名单摘要", async () => {
  const sources = { wuxia: "generated", science_fiction: "generated", urban: "generated" };
  const harness = createHarness({
    env: { RUN_REAL_AI_SMOKE: "1" },
    runCase: async (smokeCase) => okReport(smokeCase.gameType, sources[smokeCase.gameType]),
  });
  const exitCode = await runPhase4bAiSmoke(harness.deps);
  assert.equal(exitCode, 0);
  const summaryLines = harness.logs.filter((line) => line.includes('"source"'));
  assert.equal(summaryLines.length, 3);
  for (const line of summaryLines) {
    const parsed = JSON.parse(line.slice(line.indexOf("{")));
    assert.deepEqual(
      Object.keys(parsed).sort(),
      ["codes", "durationMs", "gameType", "promptTokens", "completionTokens",
        "totalTokens", "source"].sort(),
    );
    assert.equal(parsed.source, "generated");
  }
});

test("fallback 保持可观测，但真实 AI smoke 必须失败", async () => {
  const harness = createHarness({
    env: { RUN_REAL_AI_SMOKE: "1" },
    runCase: async (smokeCase) => okReport(smokeCase.gameType, "fallback"),
  });
  const exitCode = await runPhase4bAiSmoke(harness.deps);
  assert.notEqual(exitCode, 0);
  assert.ok(harness.logs.some((line) => line.includes("AI_FALLBACK_USED")));
});

test("source 越界 / reload 失败 / 开局预算违约：退出非零", async () => {
  const badReports = [
    { ...okReport("wuxia"), source: "fixture" },
    { ...okReport("wuxia"), reloadOk: false },
    { ...okReport("wuxia"), openingRuntimeOk: false },
    { gameType: "wuxia", ok: false, failureCode: "INFRASTRUCTURE_FAILURE", durationMs: 5 },
  ];
  for (const bad of badReports) {
    const harness = createHarness({
      env: { RUN_REAL_AI_SMOKE: "1" },
      runCase: async (smokeCase) =>
        smokeCase.gameType === "wuxia" ? bad : okReport(smokeCase.gameType),
    });
    const exitCode = await runPhase4bAiSmoke(harness.deps);
    assert.notEqual(exitCode, 0, `应拒绝违约报告：${JSON.stringify(Object.keys(bad))}`);
    assert.ok(validateCaseReport(bad).length > 0);
  }
});

test("runCase 抛错（本地故障）：退出非零且错误文本不进日志", async () => {
  const harness = createHarness({
    env: { RUN_REAL_AI_SMOKE: "1" },
    runCase: async () => {
      throw new Error("local sqlite path exploded at C:/secret/path");
    },
  });
  const exitCode = await runPhase4bAiSmoke(harness.deps);
  assert.notEqual(exitCode, 0);
  const joined = harness.logs.join("\n");
  assert.ok(!joined.includes("C:/secret/path"));
  assert.ok(joined.includes("SMOKE_CASE_CRASHED"));
});

test("runCase 返回非对象报告：退出非零且不抛出", async () => {
  const harness = createHarness({
    env: { RUN_REAL_AI_SMOKE: "1" },
    runCase: async () => null,
  });
  const exitCode = await runPhase4bAiSmoke(harness.deps);
  assert.notEqual(exitCode, 0);
  assert.ok(harness.logs.some((line) => line.includes("REPORT_MISSING")));
});

test("摘要行只包含白名单字段，usage 缺失时省略 tokens", () => {
  const line = buildCaseSummaryLine({
    ...okReport("urban"),
    usage: undefined,
    // 即使 report 被误塞入敏感字段，摘要也不得输出。
    prompt: "should-never-appear",
    baseUrl: "https://should-never-appear.example",
  });
  const parsed = JSON.parse(line.slice(line.indexOf("{")));
  assert.deepEqual(Object.keys(parsed).sort(), ["codes", "durationMs", "gameType", "source"]);
  assert.ok(!line.includes("should-never-appear"));
});

// ---------------------------------------------------------------------------
// 真实路径纯函数直接覆盖：checkContentBudget / summarizeAuditEvents。
// ---------------------------------------------------------------------------

/** 与 domain budgetPolicy.opening 同值的字面量（测试不加载 TS，预算经参数注入）。 */
const TEST_BUDGET = Object.freeze({
  opening: Object.freeze({
    mainLocationsMin: 3,
    mainLocationsMax: 5,
    hiddenLocationsMax: 1,
    coreNpcsMin: 4,
    coreNpcsMax: 6,
    companionsMax: 1,
    sideQuestsMax: 2,
    endings: 2,
    townLocationsMax: 2,
  }),
});

/** 刚好踩在预算内的最小 blueprint 骨架（只含 checkContentBudget 读的字段）。 */
function budgetOkBlueprint() {
  return {
    locations: [
      { kind: "main" },
      { kind: "main" },
      { kind: "main" },
      { kind: "main" },
      { kind: "hidden" },
    ],
    npcs: [
      { isCompanion: true },
      { isCompanion: false },
      { isCompanion: false },
      { isCompanion: false },
    ],
    quests: [{ kind: "main" }, { kind: "side" }, { kind: "side" }],
    endings: [{}, {}],
  };
}

test("checkContentBudget：预算内 blueprint 通过，含上限边界", () => {
  assert.equal(checkContentBudget(budgetOkBlueprint(), TEST_BUDGET), true);
  // 下限边界：无隐藏地点 / 无同伴 / 无支线也合法。
  const minimal = budgetOkBlueprint();
  minimal.locations = minimal.locations.filter((entry) => entry.kind === "main");
  minimal.npcs = minimal.npcs.map(() => ({ isCompanion: false }));
  minimal.quests = [{ kind: "main" }];
  assert.equal(checkContentBudget(minimal, TEST_BUDGET), true);
});

test("checkContentBudget：主地点/隐藏/NPC/同伴/支线/结局越界各自判败", () => {
  const mutations = [
    (bp) => bp.locations.push({ kind: "main" }, { kind: "main" }), // 6 个主地点（超上限）
    (bp) => bp.locations.splice(0, 2), // 2 个主地点（低于下限）
    (bp) => bp.locations.push({ kind: "hidden" }), // 2 个隐藏地点
    (bp) => bp.npcs.splice(0, 1), // 3 个 NPC（低于下限）
    (bp) => bp.npcs.push({}, {}, {}), // 7 个 NPC（超上限）
    (bp) => bp.npcs.push({ isCompanion: true }), // 2 个同伴
    (bp) => bp.quests.push({ kind: "side" }), // 3 条支线
    (bp) => bp.endings.push({}), // 3 个结局
    (bp) => bp.endings.splice(0, 1), // 1 个结局
  ];
  for (const [index, mutate] of mutations.entries()) {
    const blueprint = budgetOkBlueprint();
    mutate(blueprint);
    assert.equal(checkContentBudget(blueprint, TEST_BUDGET), false, `变异 #${index} 应判败`);
  }
});

test("summarizeAuditEvents：混合事件提取诊断码、tokens 与成本合计", () => {
  const summary = summarizeAuditEvents([
    {
      outcome: "failure",
      transportCode: "timeout",
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      estimatedCostUsd: 0.001,
    },
    { outcome: "failure", category: "schema_violation" },
    {
      outcome: "ok",
      promptTokens: 200,
      completionTokens: 80,
      totalTokens: 280,
      estimatedCostUsd: 0.002,
    },
  ]);
  assert.deepEqual(summary.codes, ["transport_timeout", "schema_violation", "attempt_ok"]);
  assert.deepEqual(summary.usage, { promptTokens: 300, completionTokens: 100, totalTokens: 400 });
  assert.ok(Math.abs(summary.estimatedCostUsd - 0.003) < 1e-12);
});

test("summarizeAuditEvents：畸形事件与非数值字段一律忽略，空入参得空摘要", () => {
  const summary = summarizeAuditEvents([
    null,
    "not-an-object",
    42,
    { outcome: "ok", promptTokens: "100", estimatedCostUsd: "0.5" },
    { transportCode: 500, category: 7 },
  ]);
  // 只有合法的 ok 事件产生诊断码；字符串/数字字段不计入 tokens 与成本。
  assert.deepEqual(summary.codes, ["attempt_ok"]);
  assert.equal(summary.usage, undefined);
  assert.equal(summary.estimatedCostUsd, undefined);

  const empty = summarizeAuditEvents([]);
  assert.deepEqual(empty, { codes: [], usage: undefined, estimatedCostUsd: undefined });
});

// ---------------------------------------------------------------------------
// Task 6：按输出格式聚合的安全汇总（resolveOutputFormatLabel / summarizeSmokeRun
// / summary 行门禁）。红线：通过条件不变，summary 只含白名单字段且绝不回显原值。
// ---------------------------------------------------------------------------

test("resolveOutputFormatLabel：合法值原样、缺失/空白按 prompt_only、非法值判 invalid 且不回显", () => {
  assert.equal(resolveOutputFormatLabel("json_schema"), "json_schema");
  assert.equal(resolveOutputFormatLabel("json_object"), "json_object");
  assert.equal(resolveOutputFormatLabel("prompt_only"), "prompt_only");
  assert.equal(resolveOutputFormatLabel(undefined), "prompt_only");
  assert.equal(resolveOutputFormatLabel(""), "prompt_only");
  assert.equal(resolveOutputFormatLabel("  "), "prompt_only");
  const invalid = resolveOutputFormatLabel("bogus-value");
  assert.equal(invalid, "invalid");
  assert.ok(!invalid.includes("bogus"));
});

test("summarizeSmokeRun：generated/fallback/failed 三份报告聚合白名单统计", () => {
  const summary = summarizeSmokeRun(
    [
      {
        gameType: "wuxia",
        ok: true,
        source: "generated",
        durationMs: 1000,
        codes: ["attempt_ok"],
        usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
        estimatedCostUsd: 0.001,
      },
      {
        gameType: "science_fiction",
        ok: true,
        source: "fallback",
        durationMs: 2000,
        codes: ["transport_timeout"],
        usage: { promptTokens: 50, completionTokens: 60, totalTokens: 110 },
        estimatedCostUsd: 0.002,
      },
      { gameType: "urban", ok: false },
    ],
    "json_schema",
  );
  assert.deepEqual(summary, {
    outputFormat: "json_schema",
    cases: 3,
    generated: 1,
    fallback: 1,
    failed: 1,
    fallbackCategories: { transport_timeout: 1 },
    totalDurationMs: 3000,
    usage: { promptTokens: 150, completionTokens: 260, totalTokens: 410 },
    estimatedCostUsd: 0.003,
  });
});

test("summary 行：恰一行、JSON 键集合在白名单内、不泄漏玩家输入", async () => {
  const harness = createHarness({
    env: { RUN_REAL_AI_SMOKE: "1" },
    runCase: async (smokeCase) => okReport(smokeCase.gameType, "generated"),
  });
  harness.deps.outputFormatLabel = "json_object";
  const exitCode = await runPhase4bAiSmoke(harness.deps);
  assert.equal(exitCode, 0);
  const summaryLines = harness.logs.filter((line) =>
    line.startsWith("[phase4b-smoke] summary "),
  );
  assert.equal(summaryLines.length, 1);
  const parsed = JSON.parse(summaryLines[0].slice(summaryLines[0].indexOf("{")));
  const allowedKeys = [
    "outputFormat",
    "cases",
    "generated",
    "fallback",
    "failed",
    "fallbackCategories",
    "totalDurationMs",
    "usage",
    "estimatedCostUsd",
  ];
  for (const key of Object.keys(parsed)) {
    assert.ok(allowedKeys.includes(key), `summary 出现白名单外的键：${key}`);
  }
  assert.equal(parsed.outputFormat, "json_object");
  assert.equal(parsed.cases, 3);
  assert.equal(parsed.generated, 3);
  for (const smokeCase of SMOKE_CASES) {
    assert.ok(!summaryLines[0].includes(smokeCase.input.characterName));
    assert.ok(!summaryLines[0].includes(smokeCase.input.worldPremise));
  }
});

test("无 opt-in：仍提前退出，不输出 summary 行", async () => {
  const harness = createHarness({ env: {} });
  harness.deps.outputFormatLabel = "json_schema";
  const exitCode = await runPhase4bAiSmoke(harness.deps);
  assert.notEqual(exitCode, 0);
  assert.ok(!harness.logs.some((line) => line.includes("summary")));
});

// ---------------------------------------------------------------------------
// 离线实跑：用占位 AI 配置驱动真实 realRunCase（加载 TS 链路，不触网）。
// ---------------------------------------------------------------------------

/** 占位配置：parseAiRuntimeConfig 必判 unavailable（PLACEHOLDER 诊断），
 * 值本身兼作“绝不入日志”的泄漏探针。 */
const OFFLINE_PLACEHOLDER_ENV = {
  AI_API_BASE_URL: "https://offline-probe-should-never-appear.invalid/v1",
  AI_MODEL: "replace-me",
  AI_API_KEY: "<offline-probe-key-should-never-appear>",
};

test("离线实跑：占位配置驱动真实链路 → 确定性 fallback，零 fetch，输出不含配置值", async () => {
  const { result, fetchCalls } = await withFetchRecorder(() =>
    realRunCase(SMOKE_CASES[0], { aiEnv: OFFLINE_PLACEHOLDER_ENV }),
  );
  assert.equal(fetchCalls.length, 0);

  // 完整穿过真实装配：创建可恢复的 fallback 存档并通过 reload/开局预算复查；
  // 但严格真实 AI 验收必须把它报成失败。
  assert.equal(result.ok, true);
  assert.equal(result.source, "fallback");
  assert.equal(result.reloadOk, true);
  assert.equal(result.openingRuntimeOk, true);
  // unavailable source 不伪造 transport 失败码；来源标记已足以让严格验收失败。
  assert.deepEqual(result.codes, []);
  assert.deepEqual(validateCaseReport(result), ["AI_FALLBACK_USED"]);

  // 摘要行与 report 序列化中都不得出现任何配置值或玩家输入。
  const line = buildCaseSummaryLine(result);
  const serialized = `${line}\n${JSON.stringify(result)}`;
  for (const value of Object.values(OFFLINE_PLACEHOLDER_ENV)) {
    assert.ok(!serialized.includes(value));
  }
  assert.ok(!serialized.includes(SMOKE_CASES[0].input.worldPremise));
  assert.ok(!serialized.includes(SMOKE_CASES[0].input.characterName));
});
