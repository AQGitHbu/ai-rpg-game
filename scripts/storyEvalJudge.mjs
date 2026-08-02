// ---------------------------------------------------------------------------
// storyEvalJudge：LLM-as-judge 评审脚本（spec §8.2）。
// 输入只有 story.jsonl + manifest.json，绝不喂 calls.jsonl（评审只看玩家视角，
// 避免被内部计划带偏）。三段评审：
//   ① 早期预测测试（S4，独立先行，输入隔离：只喂前 25% 场景 + 非剧透 manifest）；
//   ② 故事级评审（S1–S3、S5–S9，完整 manifest 与全部场景，逐维证据；S4 由确定性匹配器计算）；
//   ③ 场景级评审（C1 全量、C2–C4 每幕抽 2）。
// 量表文本唯一事实源：docs/策划文档/AI内容质量评估标准.md（脚本只读，不内嵌）。
// 输出强制 JSON，本地解析 + 一次重试；解析成功但校验失败抛出 judge_schema_invalid，
// 由同一个 callJudge 重试一次，而不是先接受不完整 JSON 再在 report 阶段修补；
// 仍失败记 null，不编分。
// 场景级证据包（Task 13 Step 6）：C1 每条台词附该 NPC 姓名/role/description/
// 关系 tier 与摘要/最近接触；C2 每条抽样场景附紧邻前序场景与当时 memory；
// C3/C4 仍只输入玩家可见场景。
// S8/S9 上限约束（spec §5.3）：metrics.json 的 choices.pairedCheckpoints 为 0
// （无成对分支证据）时 S8/S9 强制 cap 为 3 并注明 "capped: no paired branch evidence"。
// 门禁：RUN_REAL_AI_STORY_EVAL_JUDGE=1 才调用；模型默认 AI_MODEL，
// STORY_EVAL_JUDGE_MODEL 可覆盖；复用 AI_API_BASE_URL/AI_API_KEY。
// ---------------------------------------------------------------------------

import { resolve } from "node:path";

const SCALE_DOC = resolve(import.meta.dirname ?? process.cwd(), "..", "docs", "策划文档", "AI内容质量评估标准.md");

/** 故事级评审维度（S4 由确定性匹配器计算，judge 不评）。 */
const STORY_DIMENSIONS = ["S1", "S2", "S3", "S5", "S6", "S7", "S8", "S9"];

/** S8/S9 上限证据注记（spec §5.3）。 */
const CAP_EVIDENCE_NOTE = "capped: no paired branch evidence";

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

/** 场景行查找：只接受 kind === "scene" 的行（证据引文必须指向真实场景）。 */
function sceneRowAt(story, sceneIndex) {
  return story.find((row) => row.kind === "scene" && row.sceneIndex === sceneIndex) ?? null;
}

/** ① 早期预测测试：非剧透 manifest + 前 25% 场景（向上取整）。 */
export function buildEarlyPredictionPrompt(nonSpoiler, story) {
  const scenes = story.filter((row) => row.kind === "scene");
  const quarter = Math.max(1, Math.ceil(scenes.length * 0.25));
  const firstQuarter = scenes.slice(0, quarter).map(sceneToText).join("\n\n");
  return [
    "你是故事质量评审员。以下是开局部分（仅前 25% 场景）与世界观/NPC 档案（不含结局、任务结构与后续内容）。",
    "请按固定三项预测：1) 结局走向；2) boss身份；3) 关键反转。每项给出置信度（1-5）。",
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

/** C1 证据包：该 NPC 的姓名/role/description/关系 tier 与摘要/最近接触 + 当时 memory。 */
function c1EvidenceBlock(row) {
  const profile = row.npcProfile;
  if (profile === null || typeof profile !== "object" || typeof row.relationshipSummary !== "string") {
    throw new Error("C1_EVIDENCE_INCOMPLETE");
  }
  return [
    `场景 ${row.sceneIndex} 证据包（C1）`,
    `NPC 姓名：${profile.name ?? "?"}`,
    `NPC role：${profile.role ?? "?"}`,
    `NPC description：${profile.description ?? "?"}`,
    `关系与最近接触：${row.relationshipSummary}`,
    `当时 memory 摘要：${JSON.stringify(row.memorySummary ?? [])}`,
    sceneToText(row),
  ].join("\n");
}

/** C2 证据包：紧邻前序场景 + 当时 memory 摘要。 */
function c2EvidenceBlock(row, story) {
  const previous = story?.find((entry) => entry.sceneIndex === row.sceneIndex - 1) ?? null;
  if (previous === null) {
    throw new Error("C2_EVIDENCE_INCOMPLETE");
  }
  return [
    `场景 ${row.sceneIndex} 证据包（C2）`,
    `紧邻前序场景（场景 ${previous.sceneIndex}）：\n${sceneToText(previous)}`,
    `当时 memory 摘要：${JSON.stringify(row.memorySummary ?? [])}`,
    sceneToText(row),
  ].join("\n");
}

/** ③ 场景级评审：C1 全量或 C2–C4 抽样，逐场景打分。
 *  C1 每个包必须带该 NPC 档案/关系/最近接触；C2 每个包必须带紧邻前序场景与
 *  memory；证据包不齐时拒绝输入（C1_EVIDENCE_INCOMPLETE / C2_EVIDENCE_INCOMPLETE）。
 *  C3/C4 仍只输入玩家可见场景与必要世界资料，不附加内部证据。 */
export function buildSceneLevelPrompt({ scaleText, version, sampled, dimension, story }) {
  const blocks = sampled.map((row) => {
    if (dimension.startsWith("C1")) return c1EvidenceBlock(row);
    if (dimension.startsWith("C2")) return c2EvidenceBlock(row, story);
    return sceneToText(row);
  });
  return [
    `你是故事质量评审员。请按量表（版本 ${version}）为以下场景评 ${dimension} 维度（1-5 分），逐场景给出分数与一句证据。`,
    "证据必须引用对应证据包中的原文。只输出 JSON：{\"scores\":[{\"sceneIndex\":1,\"score\":3,\"evidence\":\"...\"}],\"reasoning\":\"...\"}",
    `量表：\n${scaleText}`,
    `场景：\n${blocks.join("\n\n")}`,
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
 *  避免相同参数下模型重复输出 invalid JSON）。解析成功但 validateParsed 校验失败时
 *  抛出 judge_schema_invalid，由本函数重试一次（不在 report 阶段修补）。 */
export async function callJudge({ baseUrl, apiKey, model, messages, fetchImpl = fetch, retries = 1, timeoutMs = 120_000, validateParsed }) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const temperature = attempt === 0 ? 0.2 : 0.5; // 首次低温度，重试时提高温度增加输出多样性
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, temperature }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`judge_http_${response.status}`);
      const payload = await response.json();
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("judge_empty_response");
      const parsed = parseJudgeJson(content);
      if (parsed !== null) {
        if (validateParsed !== undefined && !validateParsed(parsed)) {
          throw new Error("judge_schema_invalid");
        }
        return { ok: true, parsed };
      }
      throw new Error("judge_invalid_json");
    } catch (error) {
      lastError = controller.signal.aborted ? new Error("judge_timeout") : error;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
  return { ok: false, error: String(lastError?.message ?? "judge_failed") };
}

function readLines(fs, path) {
  return fs.readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
}

/** 读取 metrics.json（analyze 产物）：缺失视为无成对分支证据（S8/S9 触发上限约束）。 */
function readMetrics(fs, join) {
  try {
    return JSON.parse(fs.readFileSync(join("metrics.json"), "utf8"));
  } catch {
    return null;
  }
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
 *  S4 = max(1, min(5, 5 - round(4h)))。answer key 绝不传入预测 prompt。
 *  比较前做 Unicode/空白规范化；精确命中要求整串相等（禁止用空字符串或任意单词
 *  的 substring 误判精确命中）；空字符串预测永不计数。item 名也做规范化键查找，
 *  容忍模型输出中多余空白。 */
export function scoreEarlyPrediction(predictions, answerKey) {
  if (!Array.isArray(predictions) || !answerKey) return { score: null, hitWeight: 0, matched: [] };
  const normalize = (value) => String(value ?? "").normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
  const keys = Object.keys(answerKey);
  const keyForItem = (item) => {
    const normalized = normalize(item);
    return keys.find((key) => normalize(key) === normalized);
  };
  let sum = 0;
  const matched = [];
  for (const pred of predictions) {
    const key = keyForItem(pred.item);
    let match = "miss";
    let weight = 0;
    if (key !== undefined) {
      const prediction = normalize(pred.prediction);
      const exactAliases = (answerKey[key].exactAliases ?? []).map(normalize).filter(Boolean);
      const directionalAliases = (answerKey[key].directionalAliases ?? []).map(normalize).filter(Boolean);
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

/** 把 manifest 的结构化 answer key（ending:* / enemy:* / main:* / ending:reached）分组为
 *  早期预测 prompt 的固定三项（结局走向/boss身份/关键反转，spec §5.1/§8.2）。
 *  只合并别名集合，绝不把结局/任务内容写入预测 prompt（保持输入隔离）。 */
export function answerKeyForPredictionItems(answerKey) {
  const groups = {
    "结局走向": { exactAliases: [], directionalAliases: [] },
    "boss身份": { exactAliases: [], directionalAliases: [] },
    "关键反转": { exactAliases: [], directionalAliases: [] },
  };
  for (const [key, value] of Object.entries(answerKey ?? {})) {
    const group = key.startsWith("ending:")
      ? "结局走向"
      : key.startsWith("enemy:")
        ? "boss身份"
        : key.startsWith("main:")
          ? "关键反转"
          : null;
    if (group === null) continue;
    const entry = value ?? {};
    groups[group].exactAliases.push(...(Array.isArray(entry.exactAliases) ? entry.exactAliases : []));
    groups[group].directionalAliases.push(...(Array.isArray(entry.directionalAliases) ? entry.directionalAliases : []));
  }
  return groups;
}

function isIntScore(value) {
  return Number.isInteger(value) && value >= 1 && value <= 5;
}

/**
 * S8/S9 上限规范化（spec §5.3）：metrics.json 的 choices.pairedCheckpoints 为 0
 * （无成对分支证据）时，S8/S9 分数不得超过 3；超过时强制 cap 为 3 并在 evidence
 * 中注明 "capped: no paired branch evidence"。校验通过后由 validateStoryLevelResult
 * 调用（在 parsed 对象上就地规范化，report 据此标注）。
 */
export function applyStoryLevelS8S9Cap(scores, metrics) {
  const pairedCheckpoints = metrics?.choices?.pairedCheckpoints ?? 0;
  if (pairedCheckpoints !== 0) return;
  for (const key of ["S8", "S9"]) {
    const entry = scores?.[key];
    if (entry === null || typeof entry !== "object") continue;
    if (typeof entry.score === "number" && entry.score > 3) {
      entry.score = 3;
      entry.capped = true;
      if (!Array.isArray(entry.evidence)) entry.evidence = [];
      entry.evidence.push({ sceneIndex: null, quote: CAP_EVIDENCE_NOTE });
    }
  }
}

/** 故事级结果校验：所有应评维度齐全（S1–S3、S5–S9）、整数 1–5、sceneIndex 存在、
 *  引文是相应场景原文子串；通过后就地执行 S8/S9 上限规范化。校验失败返回 false
 *  （callJudge 据此抛出 judge_schema_invalid 并重试一次）。 */
export function validateStoryLevelResult(parsed, story, metrics) {
  if (parsed === null || typeof parsed !== "object") return false;
  const scores = parsed.scores;
  if (scores === null || typeof scores !== "object" || Array.isArray(scores)) return false;
  for (const key of STORY_DIMENSIONS) {
    const entry = scores[key];
    if (entry === null || typeof entry !== "object") return false;
    if (!isIntScore(entry.score)) return false;
    const evidence = entry.evidence;
    if (!Array.isArray(evidence) || evidence.length === 0) return false;
    for (const item of evidence) {
      if (item === null || typeof item !== "object") return false;
      const row = sceneRowAt(story, item.sceneIndex);
      if (row === null) return false;
      if (typeof item.quote !== "string" || !sceneToText(row).includes(item.quote)) return false;
    }
  }
  applyStoryLevelS8S9Cap(scores, metrics);
  return true;
}

/** 场景级结果校验：非空 scores 数组、每个分数整数 1–5、sceneIndex 存在、
 *  证据是相应场景原文子串。校验失败返回 false（callJudge 重试一次）。 */
function sceneLevelEvidenceText(row, story, dimension) {
  if (dimension.startsWith("C1")) return c1EvidenceBlock(row);
  if (dimension.startsWith("C2")) return c2EvidenceBlock(row, story);
  return sceneToText(row);
}

export function validateSceneLevelResult(parsed, story, dimension = "C3") {
  if (parsed === null || typeof parsed !== "object") return false;
  const scores = parsed.scores;
  if (!Array.isArray(scores) || scores.length === 0) return false;
  for (const entry of scores) {
    if (entry === null || typeof entry !== "object") return false;
    if (!isIntScore(entry.score)) return false;
    const row = sceneRowAt(story, entry.sceneIndex);
    if (row === null) return false;
    if (typeof entry.evidence !== "string" || !sceneLevelEvidenceText(row, story, dimension).includes(entry.evidence)) return false;
  }
  return true;
}

function evidenceTextOf(entry) {
  if (!Array.isArray(entry?.evidence)) return "";
  return entry.evidence
    .map((item) => (item?.sceneIndex === null || item?.sceneIndex === undefined ? item.quote : `场景${item.sceneIndex}:${item.quote}`))
    .join("；");
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
      const matched = scores.earlyPrediction?.matched ?? [];
      const matchText = matched.map((item) => `${item.item}=${item.match}`).join("、");
      lines.push(`| S4 | ${s4 ?? "null"} | ${weight} | 确定性匹配器计算（命中率 h=${scores.earlyPrediction?.hitWeight ?? "?"}/6；匹配：${matchText || "无"}） |`);
      continue;
    }
    const entry = storyLevel[key];
    if (entry === undefined) {
      lines.push(`| ${key} | null | ${weight} | 评审失败 |`);
      continue;
    }
    const capped = entry.capped === true ? "（上限约束：无分支证据）" : "";
    lines.push(`| ${key} | ${entry.score} | ${weight} | ${evidenceTextOf(entry)} ${capped}|`);
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
  const join = (...names) => `${runDir.replace(/[\\/]+$/, "")}/${names.join("/")}`;
  const story = readLines(fs, join("story.jsonl"));
  const manifest = JSON.parse(fs.readFileSync(join("manifest.json"), "utf8"));
  const metrics = readMetrics(fs, join);
  const judgeTimeoutMs = (() => {
    const value = Number(env.STORY_EVAL_JUDGE_TIMEOUT_MS ?? 120_000);
    return Number.isInteger(value) && value >= 1_000 && value <= 120_000 ? value : 120_000;
  })();

  // ① 早期预测（S4）：answer key 分组为固定三项后确定性打分；绝不传入预测 prompt。
  const rawAnswerKey = manifest.answerKey;
  const predictionItemKey =
    rawAnswerKey === null || typeof rawAnswerKey !== "object"
      ? null
      : answerKeyForPredictionItems(rawAnswerKey);
  const predictionResult = await callJudge({
    baseUrl, apiKey, model,
    messages: [{ role: "user", content: buildEarlyPredictionPrompt({ world: manifest.blueprint?.world, npcs: manifest.blueprint?.npcs }, story) }],
    fetchImpl,
    timeoutMs: judgeTimeoutMs,
  });
  // ② 故事级（S1–S3、S5–S9；S4 由 scoreEarlyPrediction 确定性计算）。
  const storyResult = await callJudge({
    baseUrl, apiKey, model,
    messages: [{ role: "user", content: buildStoryLevelPrompt({ scaleText, version, manifest: manifest.blueprint, story }) }],
    fetchImpl,
    timeoutMs: judgeTimeoutMs,
    validateParsed: (parsed) => validateStoryLevelResult(parsed, story, metrics),
  });
  // ③ 场景级（C1 全量、C2–C4 每幕抽 2）。
  const scenesWithNpc = story.filter((row) => row.kind === "scene" && row.npcLine?.text !== undefined);
  const sampledAll = sampleScenesPerAct(story, Number(manifest.strategySeed ?? "0"), 2);
  // C2 只抽有紧邻前序场景的场景（开局场景无前序，不参与 C2）。
  const sampledC2 = sampledAll.filter((row) => story.some((entry) => entry.sceneIndex === row.sceneIndex - 1));
  const c1Promise = scenesWithNpc.length > 0
    ? callJudge({
        baseUrl, apiKey, model,
        messages: [{ role: "user", content: buildSceneLevelPrompt({ scaleText, version, sampled: scenesWithNpc, dimension: "C1（NPC 声线一致性）", story }) }],
        fetchImpl,
        timeoutMs: judgeTimeoutMs,
        validateParsed: (parsed) => validateSceneLevelResult(parsed, story, "C1（NPC 声线一致性）"),
      })
    : { ok: true, parsed: { scores: [], reasoning: "no npc lines" } };
  const c2Promise = callJudge({
    baseUrl, apiKey, model,
    messages: [{ role: "user", content: buildSceneLevelPrompt({ scaleText, version, sampled: sampledC2, dimension: "C2（场景衔接连续性）", story }) }],
    fetchImpl,
    timeoutMs: judgeTimeoutMs,
    validateParsed: (parsed) => validateSceneLevelResult(parsed, story, "C2（场景衔接连续性）"),
  });
  const c3Promise = callJudge({
    baseUrl, apiKey, model,
    messages: [{ role: "user", content: buildSceneLevelPrompt({ scaleText, version, sampled: sampledAll, dimension: "C3（选项抉择质量）" }) }],
    fetchImpl,
    timeoutMs: judgeTimeoutMs,
    validateParsed: (parsed) => validateSceneLevelResult(parsed, story, "C3（选项抉择质量）"),
  });
  const c4Promise = callJudge({
    baseUrl, apiKey, model,
    messages: [{ role: "user", content: buildSceneLevelPrompt({ scaleText, version, sampled: sampledAll, dimension: "C4（文本质量）" }) }],
    fetchImpl,
    timeoutMs: judgeTimeoutMs,
    validateParsed: (parsed) => validateSceneLevelResult(parsed, story, "C4（文本质量）"),
  });
  const [c1Result, c2Result, c3Result, c4Result] = await Promise.all([
    c1Promise,
    c2Promise,
    c3Promise,
    c4Promise,
  ]);

  const scores = {
    scaleVersion: version,
    judgeModel: model,
    earlyPrediction: (() => {
      if (!predictionResult.ok) return null;
      const s4 = scoreEarlyPrediction(predictionResult.parsed?.predictions, predictionItemKey);
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
  const report = buildReport({ scores, manifest, lowScenes, sampled: sampledAll });
  fs.writeFileSync(join("scores.json"), JSON.stringify(scores, null, 2) + "\n", "utf8");
  fs.writeFileSync(join("report.md"), report, "utf8");
  log(`[story-eval-judge] version=${version} model=${model} failures=${scores.failures.length === 0 ? "none" : scores.failures.join(",")}`);
  return 0;
}

if (resolve(process.argv[1] ?? "") === resolve(import.meta.filename)) {
  process.exitCode = await main({ argv: process.argv.slice(2), env: process.env, fs: await import("node:fs"), log: console.log });
}
