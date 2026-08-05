import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  answerKeyForPredictionItems,
  buildEarlyPredictionPrompt,
  buildSceneLevelPrompt,
  buildStoryLevelPrompt,
  callJudge,
  collectLowScenes,
  JUDGE_TIMEOUT_DEFAULT_MS,
  JUDGE_TIMEOUT_MAX_MS,
  main,
  parseJudgeJson,
  runWithConcurrency,
  sampleScenesPerAct,
  selectScaleText,
  scoreEarlyPrediction,
  validateSceneLevelResult,
  validateStoryLevelResult,
} from "./storyEvalJudge.mjs";

test("judge timeout 默认值覆盖真实 provider 的大 prompt 延迟", () => {
  assert.equal(JUDGE_TIMEOUT_DEFAULT_MS, 300_000);
  assert.equal(JUDGE_TIMEOUT_MAX_MS, 300_000);
});

test("judge 大 prompt 使用按维度量表与 bounded concurrency", async () => {
  const scale = [
    "# scale",
    "| # | 维度 | 1 分锚点 | 3 分锚点 | 5 分锚点 |",
    "| --- | --- | --- | --- | --- |",
    "| S1 | structure | low | mid | high |",
    "| S2 | tension | low | mid | high |",
    "| C1 | npc | low | mid | high |",
  ].join("\n");
  const selected = selectScaleText(scale, ["S1", "C1"]);
  assert.ok(selected.includes("S1"));
  assert.ok(selected.includes("C1"));
  assert.ok(!selected.includes("S2"));

  let active = 0;
  let maxActive = 0;
  const result = await runWithConcurrency(
    Array.from({ length: 4 }, (_, index) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return index;
    }),
    2,
  );
  assert.deepEqual(result, [0, 1, 2, 3]);
  assert.equal(maxActive, 2);
});

const manifest = {
  world: { name: "W", summary: "S", tone: "dark", themes: ["t"] },
  npcs: [{ name: "N", role: "村民" }],
  quests: [{ id: "q1", name: "主线", kind: "main", stage: 1 }],
  endings: [{ id: "e1", name: "终局", description: "d" }],
};
const story = [
  { kind: "scene", sceneIndex: 1, mainStage: 1, narration: "n1" },
  { kind: "scene", sceneIndex: 2, mainStage: 1, narration: "n2" },
  { kind: "scene", sceneIndex: 3, mainStage: 2, narration: "n3" },
  { kind: "scene", sceneIndex: 4, mainStage: 2, narration: "n4" },
  { kind: "scene", sceneIndex: 5, mainStage: 3, narration: "n5" },
  { kind: "scene", sceneIndex: 6, mainStage: 3, narration: "n6" },
];

test("buildEarlyPredictionPrompt 只含前 25% 场景且排除双结局与任务结构", () => {
  const prompt = buildEarlyPredictionPrompt({ world: manifest.world, npcs: manifest.npcs }, story);
  assert.ok(prompt.includes("n1"));
  assert.ok(prompt.includes("n2"));          // 6 场景的 25% = 1.5 → 向上取整 2
  assert.ok(!prompt.includes("n3"));
  assert.ok(!prompt.includes("终局"));        // 结局排除
  assert.ok(!prompt.includes("q1"));          // 任务结构排除
  assert.ok(prompt.includes("世界观"));       // 非剧透部分包含
});

test("buildStoryLevelPrompt 含完整 manifest 与全部场景与 S 维度清单（含 S9）", () => {
  const storyWithEnding = [...story, { kind: "ending", sceneIndex: 6, endingId: "e1", endingName: "终局兑现", endingDescription: "主线冲突得到解决。", outcome: "success" }];
  const prompt = buildStoryLevelPrompt({
    scaleText: "# 量表 v9\nS1 三幕式\nS9 游戏性",
    version: "v9",
    manifest,
    story: storyWithEnding,
  });
  assert.ok(prompt.includes("n5"));
  assert.ok(prompt.includes("终局"));
  assert.ok(prompt.includes("S1"));
  assert.ok(prompt.includes("S9"));
  assert.ok(prompt.includes("v9"));
  assert.ok(prompt.includes("S4 不由你评定"));
  assert.ok(prompt.includes("终局兑现"));
  assert.ok(prompt.includes("含结局兑现"));
});

test("sampleScenesPerAct 每幕抽 2 且确定性", () => {
  // 6 场景 = 每幕各 2 个（act1/act2/act3），perAct=2 → 全量 6。
  const sampled = sampleScenesPerAct(story, 42, 2);
  assert.equal(sampled.length, 6);
  const again = sampleScenesPerAct(story, 42, 2);
  assert.deepEqual(sampled, again);
  const acts = new Set(sampled.map((row) => row.mainStage));
  assert.deepEqual([...acts].sort(), [1, 2, 3]);
});

test("parseJudgeJson 接受 fence 包裹与裸 JSON，拒绝非对象", () => {
  assert.deepEqual(parseJudgeJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJudgeJson('{"a":1}'), { a: 1 });
  assert.equal(parseJudgeJson("nope"), null);
  assert.equal(parseJudgeJson("[1,2]"), null);
});

test("scoreEarlyPrediction 按 spec 公式确定性计算 S4", () => {
  const answerKey = {
    "结局走向": { exactAliases: ["主角胜利"], directionalAliases: ["胜利"] },
    "boss身份": { exactAliases: ["暗影宗主"], directionalAliases: ["暗影"] },
    "关键反转": { exactAliases: ["师父叛变"], directionalAliases: ["叛变"] },
  };
  // 全部高置信精确命中：sum = 2+2+2 = 6, h = min(1, 6/6) = 1, S4 = max(1, 5 - round(4*1)) = 1
  const allHit = scoreEarlyPrediction([
    { item: "结局走向", prediction: "主角胜利", confidence: 5 },
    { item: "boss身份", prediction: "暗影宗主", confidence: 4 },
    { item: "关键反转", prediction: "师父叛变", confidence: 5 },
  ], answerKey);
  assert.equal(allHit.score, 1);
  assert.equal(allHit.hitWeight, 6);

  // 全部未命中：sum = 0, h = 0, S4 = max(1, 5 - 0) = 5
  const allMiss = scoreEarlyPrediction([
    { item: "结局走向", prediction: "主角死亡", confidence: 5 },
    { item: "boss身份", prediction: "路人甲", confidence: 4 },
    { item: "关键反转", prediction: "无反转", confidence: 3 },
  ], answerKey);
  assert.equal(allMiss.score, 5);
  assert.equal(allMiss.hitWeight, 0);

  // 仅方向命中：sum = 0.5*3 = 1.5, h = min(1, 1.5/6) = 0.25, S4 = max(1, 5 - round(1)) = 4
  const directional = scoreEarlyPrediction([
    { item: "结局走向", prediction: "胜利在望", confidence: 2 },
    { item: "boss身份", prediction: "暗影势力", confidence: 1 },
    { item: "关键反转", prediction: "有人叛变", confidence: 2 },
  ], answerKey);
  assert.equal(directional.score, 4);

  // 无 answerKey 时返回 null
  const noKey = scoreEarlyPrediction([{ item: "x", prediction: "y", confidence: 3 }], null);
  assert.equal(noKey.score, null);
});

test("collectLowScenes 收集 ≤2 分场景与 seed 随机 3 场景", () => {
  const scores = {
    sceneLevel: {
      C1: { scores: [{ sceneIndex: 1, score: 2 }, { sceneIndex: 3, score: 4 }] },
      C2: { scores: [{ sceneIndex: 2, score: 5 }] },
      C3: { scores: [] },
      C4: { scores: [] },
    },
    storyLevel: { scores: { S5: { score: 1, evidence: [] } } },
  };
  const low = collectLowScenes(scores, story, { strategySeed: 7 });
  // 断言集合关系而非随机抽样命中的具体 index（seed 随机部分不固定，去 index 依赖）。
  assert.ok(low.includes(1));   // C1 低分场景（sceneIndex 1）
  assert.ok(low.includes("S5")); // 故事级低分维度
  assert.ok(low.length >= 4);   // {1, S5} + seed 随机 3（去重后至少 4）
});

test("main 门禁：RUN_REAL_AI_STORY_EVAL_JUDGE 未设置时打印提示并 exit 1，不发请求", async () => {
  const lines = [];
  const code = await main({
    argv: ["/run/dir"],
    env: {},
    fs: {
      readFileSync: () => { throw new Error("must not read"); },
      writeFileSync: () => { throw new Error("must not write"); },
    },
    log: (line) => lines.push(line),
    fetchImpl: () => { throw new Error("must not fetch"); },
  });
  assert.equal(code, 1);
  assert.ok(lines.some((line) => line.includes("JUDGE_OPT_IN_REQUIRED")));
});

test("judge --resume 复用成功维度缓存，不重复请求 provider", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "story-eval-judge-cache-"));
  const storyRows = [...story, { kind: "ending", sceneIndex: 6, endingId: "e1", endingName: "终局", endingDescription: "兑现", outcome: "success" }];
  const runManifest = {
    gameId: "g1", worldSeed: 1, strategySeed: 7, status: "converged", sceneCount: 6,
    blueprint: manifest, answerKey: {}, model: "ai-slg-game-model",
  };
  writeFileSync(join(runDir, "story.jsonl"), `${storyRows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  writeFileSync(join(runDir, "manifest.json"), `${JSON.stringify(runManifest)}\n`);
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    const prompt = JSON.parse(options.body).messages[0].content;
    calls += 1;
    if (prompt.includes("固定三项预测")) return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ predictions: [], reasoning: "ok" }) } }] }) };
    if (prompt.includes("整局故事")) {
      const keys = prompt.includes("S1、S2、S3、S5") ? ["S1", "S2", "S3", "S5"] : ["S6", "S7", "S8", "S9"];
      const scores = Object.fromEntries(keys.map((key) => [key, { score: 3, evidence: [{ sceneIndex: 1, quote: "n1" }] }]));
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ scores }) } }] }) };
    }
    const indexes = prompt.includes("C2（") ? [2, 4, 6] : [1, 2, 3, 4, 5, 6];
    const scores = indexes.map((index) => ({ sceneIndex: index, score: 3, evidence: `n${index}` }));
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ scores }) } }] }) };
  };
  const base = { argv: [runDir], env: { RUN_REAL_AI_STORY_EVAL_JUDGE: "1", AI_API_BASE_URL: "https://example.invalid", AI_API_KEY: "key", AI_MODEL: "ai-slg-game-model" }, fetchImpl, fs: await import("node:fs"), log: () => {} };
  try {
    assert.equal(await main(base), 0);
    const firstCalls = calls;
    assert.ok(firstCalls >= 5);
    calls = 0;
    assert.equal(await main({ ...base, argv: [runDir, "--resume"] }), 0);
    assert.equal(calls, 0);
    assert.ok(readFileSync(join(runDir, "judge-cache", "C4.json"), "utf8").includes("inputHash"));
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Task 13 Step 6：可判定的 judge 输入与输出验证。
// ---------------------------------------------------------------------------

test("buildSceneLevelPrompt：C1 缺 NPC profile/关系拒绝，C2 缺前序场景拒绝", () => {
  const scaleText = "# 量表\n版本：v2";
  const noProfile = {
    kind: "scene", sceneIndex: 2, mainStage: 1, narration: "n2",
    npcLine: { text: "你好", emotion: "warm" }, npcProfile: null, relationshipSummary: null,
  };
  assert.throws(
    () => buildSceneLevelPrompt({ scaleText, version: "v2", sampled: [noProfile], dimension: "C1（NPC 声线一致性）", story }),
    /C1_EVIDENCE_INCOMPLETE/,
  );
  const firstScene = { kind: "scene", sceneIndex: 1, mainStage: 1, narration: "n1" };
  assert.throws(
    () => buildSceneLevelPrompt({ scaleText, version: "v2", sampled: [firstScene], dimension: "C2（场景衔接连续性）", story }),
    /C2_EVIDENCE_INCOMPLETE/,
  );
});

test("buildSceneLevelPrompt：C1 附身份/关系证据包，C2 附前序与 memory；C3/C4 只含玩家可见文本", () => {
  const scaleText = "量表";
  const withProfile = {
    kind: "scene", sceneIndex: 2, mainStage: 1, narration: "n2",
    npcLine: { text: "你好", emotion: "warm" },
    npcProfile: { name: "阿七", role: "剑客", description: "沉默寡言" },
    relationshipSummary: "tier=ally affinity=30 last=初次相遇",
    memorySummary: [{ type: "npc_met", npcId: "np_1" }],
  };
  const c1 = buildSceneLevelPrompt({ scaleText, version: "v2", sampled: [withProfile], dimension: "C1（NPC 声线一致性）", story });
  assert.ok(c1.includes("NPC 姓名：阿七"));
  assert.ok(c1.includes("NPC role：剑客"));
  assert.ok(c1.includes("NPC description：沉默寡言"));
  assert.ok(c1.includes("关系与最近接触"));
  assert.ok(c1.includes("memory 摘要"));
  const c2 = buildSceneLevelPrompt({
    scaleText, version: "v2",
    sampled: [{ kind: "scene", sceneIndex: 2, mainStage: 1, narration: "n2", memorySummary: [] }],
    dimension: "C2（场景衔接连续性）",
    story,
  });
  assert.ok(c2.includes("紧邻前序场景"));
  assert.ok(c2.includes("n1")); // 前序场景原文
  const c3 = buildSceneLevelPrompt({ scaleText, version: "v2", sampled: [{ kind: "scene", sceneIndex: 2, mainStage: 1, narration: "n2" }], dimension: "C3（选项抉择质量）" });
  assert.ok(c3.includes("n2"));
  assert.ok(!c3.includes("紧邻前序场景"));
  assert.ok(!c3.includes("memory 摘要"));
});

/** 合法的故事级 parsed（8 个应评维度 + 有效证据）；S8/S9 不超 3 时 cap 为无操作。 */
function validStoryLevelParsed() {
  const scores = {};
  for (const [key, sceneIndex] of Object.entries({ S1: 1, S2: 2, S3: 3, S5: 4, S6: 5, S7: 6, S8: 1, S9: 2 })) {
    scores[key] = { score: 3, evidence: [{ sceneIndex, quote: `n${sceneIndex}` }] };
  }
  return { scores };
}

test("validateStoryLevelResult：分数越界/虚构 sceneIndex/虚构引文/缺维度/缺证据拒绝", () => {
  assert.equal(validateStoryLevelResult(validStoryLevelParsed(), story, {}), true);
  const badScore = validStoryLevelParsed();
  badScore.scores.S2.score = 6;
  assert.equal(validateStoryLevelResult(badScore, story, {}), false);
  const badScene = validStoryLevelParsed();
  badScene.scores.S3.evidence = [{ sceneIndex: 99, quote: "n3" }];
  assert.equal(validateStoryLevelResult(badScene, story, {}), false);
  const badQuote = validStoryLevelParsed();
  badQuote.scores.S5.evidence = [{ sceneIndex: 4, quote: "不存在的原文" }];
  assert.equal(validateStoryLevelResult(badQuote, story, {}), false);
  const missingDim = validStoryLevelParsed();
  delete missingDim.scores.S6;
  assert.equal(validateStoryLevelResult(missingDim, story, {}), false);
  const noEvidence = validStoryLevelParsed();
  noEvidence.scores.S7.evidence = [];
  assert.equal(validateStoryLevelResult(noEvidence, story, {}), false);
  assert.equal(validateStoryLevelResult(null, story, {}), false);
});

test("validateStoryLevelResult：S7 可引用最终 ending 行", () => {
  const storyWithEnding = [...story, { kind: "ending", sceneIndex: 6, endingId: "e1", endingName: "终局兑现", endingDescription: "主线冲突得到解决。", outcome: "success" }];
  const parsed = {
    scores: {
      S6: { score: 3, evidence: [{ sceneIndex: 5, quote: "n5" }] },
      S7: { score: 4, evidence: [{ sceneIndex: 6, quote: "主线冲突得到解决" }] },
      S8: { score: 3, evidence: [{ sceneIndex: 1, quote: "n1" }] },
      S9: { score: 3, evidence: [{ sceneIndex: 2, quote: "n2" }] },
    },
  };
  assert.equal(validateStoryLevelResult(parsed, storyWithEnding, { choices: { pairedCheckpoints: 2 } }, ["S6", "S7", "S8", "S9"]), true);
});

test("validateSceneLevelResult：分数越界/虚构 sceneIndex/虚构引文/空结果拒绝", () => {
  assert.equal(validateSceneLevelResult({ scores: [{ sceneIndex: 1, score: 3, evidence: "n1" }] }, story), true);
  assert.equal(validateSceneLevelResult({ scores: [{ sceneIndex: 1, score: 6, evidence: "n1" }] }, story), false);
  assert.equal(validateSceneLevelResult({ scores: [{ sceneIndex: 99, score: 3, evidence: "n1" }] }, story), false);
  assert.equal(validateSceneLevelResult({ scores: [{ sceneIndex: 1, score: 3, evidence: "胡编" }] }, story), false);
  assert.equal(validateSceneLevelResult({ scores: [] }, story), false);
  assert.equal(validateSceneLevelResult(null, story), false);
});

test("validateSceneLevelResult：C1/C2 证据允许引用各自证据包，而非只限当前场景", () => {
  const c1Story = story.map((row) => row.sceneIndex === 2
    ? {
        ...row,
        npcProfile: { name: "阿七", role: "剑客", description: "沉默寡言" },
        relationshipSummary: "tier=ally affinity=30 last=初次相遇",
        memorySummary: [],
        npcLine: { text: "你好", emotion: "warm" },
      }
    : row);
  assert.equal(
    validateSceneLevelResult({ scores: [{ sceneIndex: 2, score: 3, evidence: "沉默寡言" }] }, c1Story, "C1（NPC 声线一致性）"),
    true,
  );
  assert.equal(
    validateSceneLevelResult({ scores: [{ sceneIndex: 2, score: 3, evidence: "n1" }] }, story, "C2（场景衔接连续性）"),
    true,
  );
  assert.equal(validateSceneLevelResult({ scores: [{ sceneIndex: 2, score: 3, evidence: "n1" }] }, story), false);
});

test("validateStoryLevelResult：无分支证据（pairedCheckpoints=0 或 metrics 缺失）时 S8/S9 cap 为 3 并注明", () => {
  const parsed = validStoryLevelParsed();
  parsed.scores.S8 = { score: 5, evidence: [{ sceneIndex: 1, quote: "n1" }] };
  parsed.scores.S9 = { score: 4, evidence: [{ sceneIndex: 2, quote: "n2" }] };
  const ok = validateStoryLevelResult(parsed, story, { choices: { pairedCheckpoints: 0 } });
  assert.equal(ok, true);
  assert.equal(parsed.scores.S8.score, 3);
  assert.equal(parsed.scores.S9.score, 3);
  assert.equal(parsed.scores.S8.capped, true);
  assert.equal(parsed.scores.S9.capped, true);
  assert.ok(parsed.scores.S8.evidence.some((item) => item.quote === "capped: no paired branch evidence"));
  assert.ok(parsed.scores.S9.evidence.some((item) => item.quote === "capped: no paired branch evidence"));
  // metrics.json 缺失（null）同样视为无分支证据 → cap。
  const noMetrics = validStoryLevelParsed();
  noMetrics.scores.S8 = { score: 5, evidence: [{ sceneIndex: 1, quote: "n1" }] };
  assert.equal(validateStoryLevelResult(noMetrics, story, null), true);
  assert.equal(noMetrics.scores.S8.score, 3);
  // 有成对分支证据时不 cap。
  const withBranches = validStoryLevelParsed();
  withBranches.scores.S8 = { score: 5, evidence: [{ sceneIndex: 1, quote: "n1" }] };
  assert.equal(validateStoryLevelResult(withBranches, story, { choices: { pairedCheckpoints: 2 } }), true);
  assert.equal(withBranches.scores.S8.score, 5);
});

test("answerKeyForPredictionItems 把结构化 answer key 分组为固定三项并与评分器集成", () => {
  const grouped = answerKeyForPredictionItems({
    "ending:ending_1": { exactAliases: ["ending_1", "主线胜利"], directionalAliases: [] },
    "ending:reached": { exactAliases: ["victory"], directionalAliases: [] },
    "enemy:enemy_2": { exactAliases: ["enemy_2", "暗影宗主"], directionalAliases: ["暗影"] },
    "main:3": { exactAliases: ["3"], directionalAliases: [] },
    "unknown:9": { exactAliases: ["x"], directionalAliases: [] }, // 未知键忽略
  });
  assert.deepEqual(Object.keys(grouped), ["结局走向", "boss身份", "关键反转"]);
  assert.ok(grouped["结局走向"].exactAliases.includes("主线胜利"));
  assert.ok(grouped["结局走向"].exactAliases.includes("victory"));
  assert.ok(grouped["boss身份"].directionalAliases.includes("暗影"));
  assert.ok(grouped["关键反转"].exactAliases.includes("3"));
  // 集成：分组 key + 高置信精确命中 → S4 = 1（sum = 6 → h = 1）。
  const s4 = scoreEarlyPrediction([
    { item: "结局走向", prediction: "主线胜利", confidence: 5 },
    { item: "boss身份", prediction: "暗影宗主", confidence: 4 },
    { item: "关键反转", prediction: "3", confidence: 5 },
  ], grouped);
  assert.equal(s4.score, 1);
  assert.equal(s4.hitWeight, 6);
});

test("scoreEarlyPrediction：item 名与预测值 Unicode/空白规范化；空字符串与 substring 不构成精确命中", () => {
  const answerKey = {
    "结局走向": { exactAliases: ["主角 胜利"], directionalAliases: ["胜利"] },
  };
  // item 名含空格、预测值含全角空格：规范化后整串相等 → 高置信精确命中 2 分。
  const spaced = scoreEarlyPrediction([
    { item: "结局 走向", prediction: "主角　胜利", confidence: 5 },
  ], answerKey);
  assert.equal(spaced.matched[0].match, "exact");
  assert.equal(spaced.hitWeight, 2);
  // 空字符串/纯空白预测永不计数。
  const empty = scoreEarlyPrediction([
    { item: "结局走向", prediction: "   ", confidence: 5 },
    { item: "结局走向", prediction: "", confidence: 5 },
  ], answerKey);
  assert.equal(empty.hitWeight, 0);
  // 整串不等但包含别名：只算方向命中（0.5），不是精确命中。
  const partial = scoreEarlyPrediction([
    { item: "结局走向", prediction: "主角胜利了", confidence: 5 },
  ], answerKey);
  assert.equal(partial.matched[0].match, "directional");
  assert.equal(partial.hitWeight, 0.5);
});

test("callJudge：解析成功但校验失败 → judge_schema_invalid 且同一 callJudge 重试一次", async () => {
  const fetchCount = [];
  const fetchImpl = async () => {
    fetchCount.push(1);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"scores":{"S1":{"score":6}},"reasoning":"x"}' } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const result = await callJudge({ baseUrl: "http://x/v1", apiKey: "k", model: "m", messages: [], fetchImpl, validateParsed: () => false });
  assert.equal(result.ok, false);
  assert.equal(result.error, "judge_schema_invalid");
  assert.equal(result.attempts, 2);
  assert.equal(fetchCount.length, 2); // 首次 + 重试一次
});

test("callJudge：首次校验失败、重试成功 → ok:true 且恰好两次请求", async () => {
  let count = 0;
  const fetchImpl = async () => {
    count += 1;
    const content = count === 1
      ? '{"scores":{}}'
      : '{"scores":{"S1":{"score":1,"evidence":[]}},"reasoning":"ok"}';
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const result = await callJudge({
    baseUrl: "http://x/v1", apiKey: "k", model: "m", messages: [],
    fetchImpl,
    validateParsed: (parsed) => parsed.scores?.S1 !== undefined,
  });
  assert.equal(result.ok, true);
  assert.equal(result.parsed.scores.S1.score, 1);
  assert.equal(count, 2);
});

test("callJudge：未提供 validateParsed 时解析成功即返回，不额外请求", async () => {
  let count = 0;
  let requestBody;
  const fetchImpl = async (_url, options) => {
    count += 1;
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"a":1}' } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const result = await callJudge({ baseUrl: "http://x/v1", apiKey: "k", model: "m", messages: [], fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(count, 1);
  assert.deepEqual(requestBody.chat_template_kwargs, { enable_thinking: false });
});

test("callJudge：provider 不响应时按 timeoutMs 结束并返回稳定错误", async () => {
  const fetchImpl = async (_url, options) => await new Promise((_, reject) => {
    options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
  const result = await callJudge({
    baseUrl: "http://x/v1", apiKey: "k", model: "m", messages: [], fetchImpl, retries: 0, timeoutMs: 5,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "judge_timeout");
  assert.equal(result.attempts, 1);
});
