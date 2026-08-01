// ---------------------------------------------------------------------------
// storyEvalJudge：LLM-as-judge 评审脚本（spec §8.2）。
// 输入只有 story.jsonl + manifest.json，绝不喂 calls.jsonl（评审只看玩家视角，
// 避免被内部计划带偏）。三段评审：
//   ① 早期预测测试（S4，独立先行，输入隔离：只喂前 25% 场景 + 非剧透 manifest）；
//   ② 故事级评审（S1–S3、S5–S9，完整 manifest 与全部场景，逐维证据；S4 由确定性匹配器计算）；
//   ③ 场景级评审（C1 全量、C2–C4 每幕抽 2）。
// 量表文本唯一事实源：docs/策划文档/AI内容质量评估标准.md（脚本只读，不内嵌）。
// 输出强制 JSON，本地解析 + 一次重试；仍失败记 null，不编分。
// 门禁：RUN_REAL_AI_STORY_EVAL_JUDGE=1 才调用；模型默认 AI_MODEL，
// STORY_EVAL_JUDGE_MODEL 可覆盖；复用 AI_API_BASE_URL/AI_API_KEY。
// ---------------------------------------------------------------------------

import { resolve } from "node:path";

const SCALE_DOC = resolve(import.meta.dirname ?? process.cwd(), "..", "docs", "策划文档", "AI内容质量评估标准.md");

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStringToSeed(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 每幕场景按种子确定性抽样（场景内随机打乱后取前 perAct 个）。 */
export function sampleScenesPerAct(story, seed, perAct) {
  const scenes = story.filter((row) => row.kind === "scene");
  const byAct = new Map();
  for (const row of scenes) {
    const act = row.mainStage ?? 0;
    if (!byAct.has(act)) byAct.set(act, []);
    byAct.get(act).push(row);
  }
  const sampled = [];
  for (const [act, rows] of byAct) {
    const rand = mulberry32(hashStringToSeed(`${seed}:${act}`));
    const shuffled = [...rows].sort(() => rand() - 0.5);
    sampled.push(...shuffled.slice(0, perAct));
  }
  return sampled;
}

function sceneToText(row) {
  const parts = [`场景 ${row.sceneIndex}: ${row.narration ?? ""}`];
  if (row.npcLine?.text !== undefined) {
    parts.push(`NPC 台词（${row.npcLine.emotion ?? ""}）：${row.npcLine.text}`);
  }
  if (Array.isArray(row.choices)) {
    parts.push(`选项：${row.choices.map((choice) => choice.label).join(" / ")}`);
  }
  if (row.playerChoice !== undefined) {
    parts.push(`玩家选择：${row.playerChoice.actionKey}（${row.playerChoice.reason}）`);
  }
  if (Array.isArray(row.newEvents) && row.newEvents.length > 0) {
    parts.push(`事件：${row.newEvents.map((event) => event.type).join(", ")}`);
  }
  return parts.join("\n");
}

/** ① 早期预测测试：非剧透 manifest + 前 25% 场景（向上取整）。 */
export function buildEarlyPredictionPrompt(nonSpoiler, story) {
  const scenes = story.filter((row) => row.kind === "scene");
  const quarter = Math.max(1, Math.ceil(scenes.length * 0.25));
  const firstQuarter = scenes.slice(0, quarter).map(sceneToText).join("\n\n");
  return [
    "你是故事质量评审员。以下是开局部分（仅前 25% 场景）与世界观/NPC 档案（不含结局、任务结构与后续内容）。",
    "请预测：1) 结局走向；2) boss/最终敌人的身份；3) 关键反转。每项给出置信度（1-5）。",
    "只输出 JSON：{\"predictions\":[{\"item\":\"结局走向\",\"prediction\":\"...\",\"confidence\":1}],\"reasoning\":\"...\"}",
    `世界观：${JSON.stringify(nonSpoiler.world)}`,
    `NPC 档案：${JSON.stringify(nonSpoiler.npcs)}`,
    `开局场景：\n${firstQuarter}`,
  ].join("\n\n");
}

/** ② 故事级评审：完整 manifest + 全部场景 + S1–S3/S5–S9 量表（S4 由 scoreEarlyPrediction 确定性计算）。 */
export function buildStoryLevelPrompt({ scaleText, version, manifest, story }) {
  const scenes = story.filter((row) => row.kind === "scene").map(sceneToText).join("\n\n");
  return [
    `你是故事质量评审员。请按以下量表（版本 ${version}）为整局故事打分（S1–S3、S5–S9，1-5 分；S4 不由你评定）。`,
    "每个分数必须附证据：场景序号 + 原文引文。无证据的分数将重评一次。",
    "只输出 JSON：{\"scores\":{\"S1\":{\"score\":3,\"evidence\":[{\"sceneIndex\":1,\"quote\":\"...\"}]},\"S2\":{...}},\"reasoning\":\"...\"}",
    `量表：\n${scaleText}`,
    `完整设定（含结局与任务结构）：${JSON.stringify(manifest)}`,
    `完整故事：\n${scenes}`,
  ].join("\n\n");
}

/** ③ 场景级评审：C1 全量或 C2–C4 抽样，逐场景打分。 */
export function buildSceneLevelPrompt({ scaleText, version, sampled, dimension }) {
  const sceneText = sampled.map(sceneToText).join("\n\n");
  return [
    `你是故事质量评审员。请按量表（版本 ${version}）为以下场景评 ${dimension} 维度（1-5 分），逐场景给出分数与一句证据。`,
    "只输出 JSON：{\"scores\":[{\"sceneIndex\":1,\"score\":3,\"evidence\":\"...\"}],\"reasoning\":\"...\"}",
    `量表：\n${scaleText}`,
    `场景：\n${sceneText}`,
  ].join("\n\n");
}

export function parseJudgeJson(text) {
  const trimmed = String(text ?? "").trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\s*```$/i.exec(trimmed)?.[1];
  for (const candidate of [trimmed, fenced]) {
    if (candidate === undefined) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed;
    } catch { /* 继续尝试下一个候选 */ }
  }
  return null;
}

/** 直连兼容 chat/completions（scripts 目录不跨 @ai-game 边界，直接 fetch）。
 *  重试策略：第一次 temperature=0.2（稳定输出），重试时 temperature=0.5（提高输出多样性，
 *  避免相同参数下模型重复输出 invalid JSON）。 */
export async function callJudge({ baseUrl, apiKey, model, messages, fetchImpl = fetch, retries = 1 }) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const temperature = attempt === 0 ? 0.2 : 0.5; // 首次低温度，重试时提高温度增加输出多样性
    try {
      const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, temperature }),
      });
      if (!response.ok) throw new Error(`judge_http_${response.status}`);
      const payload = await response.json();
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("judge_empty_response");
      const parsed = parseJudgeJson(content);
      if (parsed !== null) return { ok: true, parsed };
      throw new Error("judge_invalid_json");
    } catch (error) {
      lastError = error;
    }
  }
  return { ok: false, error: String(lastError?.message ?? "judge_failed") };
}

function readLines(fs, path) {
  return fs.readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
}

/** 人工抽查清单（spec §5.4）：任一维度 ≤2 分的场景 + 每局 seed 随机 3 个场景。 */
export function collectLowScenes(scores, story, manifest) {
  const low = new Set();
  const sceneLevel = scores.sceneLevel ?? {};
  for (const dimension of ["C1", "C2", "C3", "C4"]) {
    const result = sceneLevel[dimension];
    for (const entry of result?.scores ?? []) {
      if (typeof entry.score === "number" && entry.score <= 2) low.add(entry.sceneIndex);
    }
  }
  const storyLevel = scores.storyLevel?.scores ?? {};
  for (const key of Object.keys(storyLevel)) {
    if (typeof storyLevel[key]?.score === "number" && storyLevel[key].score <= 2) {
      low.add(key); // 故事级低分无场景索引：维度名整体列入报告说明
    }
  }
  if (typeof scores.earlyPrediction?.s4Score === "number" && scores.earlyPrediction.s4Score <= 2) {
    low.add("S4");
  }
  const rand = mulberry32(hashStringToSeed(String(manifest?.strategySeed ?? "0")));
  const scenes = story.filter((row) => row.kind === "scene");
  const shuffled = [...scenes].sort(() => rand() - 0.5);
  for (const row of shuffled.slice(0, 3)) low.add(row.sceneIndex);
  return [...low];
}

/** S4 确定性评分（spec §5.1 公式）：
 *  预测逐项同 manifest.answerKey 比对：高置信精确命中 2 分、低置信精确命中 1 分、
 *  仅方向命中 0.5 分、未命中 0 分；总命中率 h = min(1, sum / 6)，
 *  S4 = max(1, min(5, 5 - round(4h)))。answer key 绝不传入预测 prompt。 */
export function scoreEarlyPrediction(predictions, answerKey) {
  if (!Array.isArray(predictions) || !answerKey) return { score: null, hitWeight: 0, matched: [] };
  const normalize = (value) => String(value ?? "").normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
  let sum = 0;
  const matched = [];
  for (const pred of predictions) {
    const key = answerKey[pred.item];
    let match = "miss";
    let weight = 0;
    if (key !== undefined) {
      const prediction = normalize(pred.prediction);
      const exactAliases = (key.exactAliases ?? []).map(normalize).filter(Boolean);
      const directionalAliases = (key.directionalAliases ?? []).map(normalize).filter(Boolean);
      if (prediction !== "" && exactAliases.includes(prediction)) {
        match = "exact";
        weight = (pred.confidence ?? 1) >= 4 ? 2 : 1;
      } else if (prediction !== "" && directionalAliases.some((alias) => prediction.includes(alias))) {
        match = "directional";
        weight = 0.5;
      }
    }
    sum += weight;
    matched.push({ item: pred.item, match, confidence: pred.confidence ?? 1 });
  }
  const h = Math.min(1, sum / 6);
  const score = Math.max(1, Math.min(5, 5 - Math.round(4 * h)));
  return { score, hitWeight: sum, matched };
}

function buildReport({ scores, manifest, lowScenes, sampled }) {
  const lines = [
    `# 故事质量评审报告（量表 ${scores.scaleVersion}，评审模型 ${scores.judgeModel}）`,
    "",
    `- gameId: ${manifest.gameId ?? "unknown"}`,
    `- worldSeed: ${manifest.worldSeed ?? "unknown"}`,
    `- strategySeed: ${manifest.strategySeed ?? "unknown"}`,
    `- gameLength: ${manifest.gameLength ?? "unknown"}`,
    `- status: ${manifest.status ?? "unknown"}（场景数 ${manifest.sceneCount ?? "?"}）`,
    "",
    "## 故事级分数",
    "",
    "| 维度 | 分数 | 权重 | 证据 |",
    "| --- | --- | --- | --- |",
  ];
  const WEIGHTS = { S2: 1.5, S4: 1.5 };
  const storyLevel = scores.storyLevel?.scores ?? {};
  for (const key of ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9"]) {
    const weight = WEIGHTS[key] ?? 1.0;
    if (key === "S4") {
      const s4 = scores.earlyPrediction?.s4Score;
      lines.push(`| S4 | ${s4 ?? "null"} | ${weight} | 确定性匹配器计算（早期预测命中率 h=${scores.earlyPrediction?.hitWeight ?? "?"}/6） |`);
      continue;
    }
    const entry = storyLevel[key];
    if (entry === undefined) {
      lines.push(`| ${key} | null | ${weight} | 评审失败 |`);
      continue;
    }
    const evidence = Array.isArray(entry.evidence)
      ? entry.evidence.map((item) => `场景${item.sceneIndex}:${item.quote}`).join("；")
      : "";
    lines.push(`| ${key} | ${entry.score} | ${weight} | ${evidence} |`);
  }
  lines.push("", "## 早期预测测试（S4 依据）", "", `\`\`\`json\n${JSON.stringify(scores.earlyPrediction, null, 2)}\n\`\`\``, "");
  lines.push("## 场景级分数", "", "| 场景 | C1 | C2 | C3 | C4 |", "| --- | --- | --- | --- | --- |");
  const sampledIndexes = new Set(sampled.map((row) => row.sceneIndex));
  const allIndexes = new Set(sampledIndexes);
  for (const entry of scores.sceneLevel?.C1?.scores ?? []) allIndexes.add(entry.sceneIndex);
  for (const index of [...allIndexes].sort((a, b) => a - b)) {
    const score = (dimension) => {
      const entry = (scores.sceneLevel?.[dimension]?.scores ?? []).find((item) => item.sceneIndex === index);
      return entry?.score ?? "-";
    };
    lines.push(`| ${index} | ${score("C1")} | ${score("C2")} | ${score("C3")} | ${score("C4")} |`);
  }
  lines.push("", "## 人工抽查清单", "", "以下场景需人工复核评审模型判断（检查要点：声线、连续性、选项差异、证据引文）：", "");
  for (const index of lowScenes) lines.push(`- 场景 ${index}`);
  lines.push("", "## 评审失败维度", "", scores.failures.length === 0 ? "无" : scores.failures.map((name) => `- ${name}`).join("\n"));
  return lines.join("\n") + "\n";
}

export async function main({ argv, env, fs, log, fetchImpl = fetch }) {
  const runDir = argv[0];
  if (runDir === undefined) {
    log("[story-eval-judge] RUN_DIR_REQUIRED");
    return 1;
  }
  if (env.RUN_REAL_AI_STORY_EVAL_JUDGE !== "1") {
    log("[story-eval-judge] JUDGE_OPT_IN_REQUIRED：需显式设置 RUN_REAL_AI_STORY_EVAL_JUDGE=1（未发起任何请求）");
    return 1;
  }
  const baseUrl = env.AI_API_BASE_URL;
  const apiKey = env.AI_API_KEY;
  const model = env.STORY_EVAL_JUDGE_MODEL ?? env.AI_MODEL;
  if (baseUrl === undefined || apiKey === undefined || model === undefined) {
    log("[story-eval-judge] JUDGE_AI_ENV_INVALID");
    return 1;
  }
  let scaleText;
  try {
    scaleText = fs.readFileSync(SCALE_DOC, "utf8");
  } catch {
    log("[story-eval-judge] SCALE_DOC_MISSING");
    return 1;
  }
  const versionMatch = /^>\s*版本[:：]\s*(\S+)/m.exec(scaleText);
  const version = versionMatch?.[1] ?? "unknown";
  const join = (name) => `${runDir.replace(/[\\/]+$/, "")}/${name}`;
  const story = readLines(fs, join("story.jsonl"));
  const manifest = JSON.parse(fs.readFileSync(join("manifest.json"), "utf8"));

  // ① 早期预测（S4）
  const predictionResult = await callJudge({
    baseUrl, apiKey, model,
    messages: [{ role: "user", content: buildEarlyPredictionPrompt({ world: manifest.blueprint?.world, npcs: manifest.blueprint?.npcs }, story) }],
    fetchImpl,
  });
  // ② 故事级（S1–S3、S5–S9；S4 由 scoreEarlyPrediction 确定性计算）
  const storyResult = await callJudge({
    baseUrl, apiKey, model,
    messages: [{ role: "user", content: buildStoryLevelPrompt({ scaleText, version, manifest: manifest.blueprint, story }) }],
    fetchImpl,
  });
  // ③ 场景级（C1 全量、C2–C4 每幕抽 2）
  const scenesWithNpc = story.filter((row) => row.kind === "scene" && row.npcLine?.text !== undefined);
  const sampled = sampleScenesPerAct(story, Number(manifest.strategySeed ?? "0"), 2);
  const c1Result = scenesWithNpc.length > 0
    ? await callJudge({
        baseUrl, apiKey, model,
        messages: [{ role: "user", content: buildSceneLevelPrompt({ scaleText, version, sampled: scenesWithNpc, dimension: "C1（NPC 声线一致性）" }) }],
        fetchImpl,
      })
    : { ok: true, parsed: { scores: [], reasoning: "no npc lines" } };
  const c2Result = await callJudge({
    baseUrl, apiKey, model,
    messages: [{ role: "user", content: buildSceneLevelPrompt({ scaleText, version, sampled, dimension: "C2（场景衔接连续性）" }) }],
    fetchImpl,
  });
  const c3Result = await callJudge({
    baseUrl, apiKey, model,
    messages: [{ role: "user", content: buildSceneLevelPrompt({ scaleText, version, sampled, dimension: "C3（选项抉择质量）" }) }],
    fetchImpl,
  });
  const c4Result = await callJudge({
    baseUrl, apiKey, model,
    messages: [{ role: "user", content: buildSceneLevelPrompt({ scaleText, version, sampled, dimension: "C4（文本质量）" }) }],
    fetchImpl,
  });

  const scores = {
    scaleVersion: version,
    judgeModel: model,
    earlyPrediction: (() => {
      if (!predictionResult.ok) return null;
      const s4 = scoreEarlyPrediction(predictionResult.parsed?.predictions, manifest.answerKey);
      return { ...predictionResult.parsed, s4Score: s4.score, hitWeight: s4.hitWeight, matched: s4.matched };
    })(),
    storyLevel: storyResult.ok ? storyResult.parsed : null,
    sceneLevel: {
      C1: c1Result.ok ? c1Result.parsed : null,
      C2: c2Result.ok ? c2Result.parsed : null,
      C3: c3Result.ok ? c3Result.parsed : null,
      C4: c4Result.ok ? c4Result.parsed : null,
    },
    failures: [
      ...(predictionResult.ok ? [] : ["early_prediction"]),
      ...(storyResult.ok ? [] : ["story_level"]),
      ...(c1Result.ok ? [] : ["C1"]),
      ...(c2Result.ok ? [] : ["C2"]),
      ...(c3Result.ok ? [] : ["C3"]),
      ...(c4Result.ok ? [] : ["C4"]),
    ],
  };
  const lowScenes = collectLowScenes(scores, story, manifest);
  const report = buildReport({ scores, manifest, lowScenes, sampled });
  fs.writeFileSync(join("scores.json"), JSON.stringify(scores, null, 2) + "\n", "utf8");
  fs.writeFileSync(join("report.md"), report, "utf8");
  log(`[story-eval-judge] version=${version} model=${model} failures=${scores.failures.length === 0 ? "none" : scores.failures.join(",")}`);
  return 0;
}

if (resolve(process.argv[1] ?? "") === resolve(import.meta.filename)) {
  process.exitCode = await main({ argv: process.argv.slice(2), env: process.env, fs: await import("node:fs"), log: console.log });
}
