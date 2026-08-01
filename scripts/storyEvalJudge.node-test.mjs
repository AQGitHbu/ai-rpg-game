import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildEarlyPredictionPrompt,
  buildSceneLevelPrompt,
  buildStoryLevelPrompt,
  collectLowScenes,
  main,
  parseJudgeJson,
  sampleScenesPerAct,
  scoreEarlyPrediction,
} from "./storyEvalJudge.mjs";

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
  const prompt = buildStoryLevelPrompt({
    scaleText: "# 量表 v9\nS1 三幕式\nS9 游戏性",
    version: "v9",
    manifest,
    story,
  });
  assert.ok(prompt.includes("n5"));
  assert.ok(prompt.includes("终局"));
  assert.ok(prompt.includes("S1"));
  assert.ok(prompt.includes("S9"));
  assert.ok(prompt.includes("v9"));
  assert.ok(prompt.includes("S4 不由你评定"));
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
