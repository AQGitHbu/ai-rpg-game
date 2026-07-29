import assert from "node:assert/strict";
import test from "node:test";
import {
  SMOKE_CASES,
  buildCaseSummaryLine,
  runPhase4bAiSmoke,
  validateCaseReport,
} from "./phase4bAiSmoke.mjs";

// ---------------------------------------------------------------------------
// Phase 4B 真实 AI smoke 的安全门禁测试：全部 mock runEnvCheck/runCase，
// 绝不访问网络。真实 smoke（RUN_REAL_AI_SMOKE=1）只允许人工 opt-in 执行。
// ---------------------------------------------------------------------------

const SECRET_ENV = {
  AI_API_BASE_URL: "https://secret-provider.example/v1",
  AI_MODEL: "secret-model-name",
  AI_API_KEY: "sk-super-secret-value",
};

function okReport(gameType, source = "fallback") {
  return {
    gameType,
    ok: true,
    source,
    durationMs: 1234,
    codes: ["LIVE_TRANSPORT_TIMEOUT"],
    usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
    reloadOk: true,
    endingCount: 2,
    budgetOk: true,
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

test("generated 与 fallback 都算成功；每例输出白名单摘要", async () => {
  const sources = { wuxia: "generated", science_fiction: "fallback", urban: "fallback" };
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
    assert.ok(["generated", "fallback"].includes(parsed.source));
  }
});

test("source 越界 / reload 失败 / 结局与预算违约：退出非零", async () => {
  const badReports = [
    { ...okReport("wuxia"), source: "fixture" },
    { ...okReport("wuxia"), reloadOk: false },
    { ...okReport("wuxia"), endingCount: 3 },
    { ...okReport("wuxia"), budgetOk: false },
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
    ...okReport("urban", "fallback"),
    usage: undefined,
    // 即使 report 被误塞入敏感字段，摘要也不得输出。
    prompt: "should-never-appear",
    baseUrl: "https://should-never-appear.example",
  });
  const parsed = JSON.parse(line.slice(line.indexOf("{")));
  assert.deepEqual(Object.keys(parsed).sort(), ["codes", "durationMs", "gameType", "source"]);
  assert.ok(!line.includes("should-never-appear"));
});
