// ---------------------------------------------------------------------------
// storyEvalAnalyze：零 AI 成本的客观指标分析（spec §8.1）。
// 纯离线：输入任意 run 目录（calls.jsonl / story.jsonl / manifest.json），
// 输出 metrics.json。可对历史 run 重复执行，是每轮调优后的免费第一道体检。
// 指标定义见 docs/策划文档/AI内容质量评估标准.md §3（与本文件保持一致）。
// ---------------------------------------------------------------------------

import { resolve } from "node:path";

const PACING_ORDER = ["setup", "develop", "turn", "climax", "resolution"];

export function pacingRank(pacing) {
  return PACING_ORDER.indexOf(pacing);
}

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** 总体标准差（除以 n 而非 n-1；口径与接口文档一致，避免与样本标准差混淆）。 */
function stddev(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const variance = mean(values.map((value) => (value - avg) ** 2));
  return Math.sqrt(variance);
}

/** 相邻 narration 字符 3-gram 重复率（Jaccard 平均），0=无重复。 */
function trigramRepeatRate(narrations) {
  const grams = (text) => {
    const chars = Array.from(text);
    const set = new Set();
    for (let index = 0; index + 3 <= chars.length; index += 1) {
      set.add(chars.slice(index, index + 3).join(""));
    }
    return set;
  };
  const ratios = [];
  for (let index = 1; index < narrations.length; index += 1) {
    const prev = grams(narrations[index - 1]);
    const curr = grams(narrations[index]);
    if (prev.size === 0 || curr.size === 0) continue;
    let overlap = 0;
    for (const gram of curr) if (prev.has(gram)) overlap += 1;
    ratios.push(overlap / (prev.size + curr.size - overlap));
  }
  return ratios.length === 0 ? 0 : mean(ratios);
}

export function computeStoryEvalMetrics({ calls, story, manifest }) {
  const sceneRows = story.filter((row) => row.kind === "scene");
  const endingRow = story.find((row) => row.kind === "ending");
  const aiCalls = calls.filter((call) => call.kind === "ai_call");
  const perRole = {};
  for (const role of ["scenario", "director", "writer", "npc"]) {
    const roleCalls = aiCalls.filter((call) => call.role === role);
    const attemptsByTrace = new Map();
    for (const call of roleCalls) {
      const previous = attemptsByTrace.get(call.traceId) ?? 0;
      attemptsByTrace.set(call.traceId, Math.max(previous, call.attempt));
    }
    // 关联键契约（Task 1/2）：attempt 为同场景同角色 1-based 尝试序号；重试 = 出现 attempt>1 的 trace 数。
    const retries = [...attemptsByTrace.values()].filter((attempt) => attempt > 1).length;
    perRole[role] = {
      attempts: roleCalls.length,
      retries,
      invalidJson: roleCalls.filter((call) => call.failureCategory === "invalid_json").length,
      failures: roleCalls.filter((call) => call.failureCategory !== null).length,
    };
  }
  const approvalRejections = {};
  for (const call of calls) {
    if (call.kind !== "role_approval" || call.category === null) continue;
    approvalRejections[call.category] = (approvalRejections[call.category] ?? 0) + 1;
  }
  const planApproved = calls.filter((call) => call.kind === "plan_approved");
  const tension = planApproved
    .map((call) => call.planSummary?.tensionLevel)
    .filter((value) => typeof value === "number");
  const pacingValues = planApproved
    .map((call) => call.planSummary?.pacing)
    .filter((value) => typeof value === "string");
  const pacing = { distribution: {}, illegalOrderCount: 0 };
  let previousRank = -1;
  for (const value of pacingValues) {
    const rank = pacingRank(value);
    if (rank < 0) continue;
    pacing.distribution[value] = (pacing.distribution[value] ?? 0) + 1;
    if (rank < previousRank) pacing.illegalOrderCount += 1;
    previousRank = rank;
  }
  const factsPerAct = [];
  for (const row of sceneRows) {
    if (typeof row.mainStage !== "number") continue;
    const act = factsPerAct.find((entry) => entry.act === row.mainStage);
    const revealed = (row.directorPlan?.allowedRevealFactIds ?? []).length;
    if (act === undefined) {
      factsPerAct.push({ act: row.mainStage, revealed });
    } else {
      act.revealed += revealed;
    }
  }
  const narrationLengths = sceneRows.map((row) => Array.from(row.narration ?? "").length);
  const lineLengths = sceneRows
    .flatMap((row) => (row.npcLine === null || row.npcLine === undefined ? [] : [Array.from(row.npcLine.text ?? "").length]));
  const expansions = calls.filter((call) => call.kind === "expansion_decision");
  const approved = expansions.filter((call) => call.decision?.ok === true).length;
  return {
    sceneCount: sceneRows.length,
    converged: endingRow !== undefined,
    fallbackRate: sceneRows.length === 0 ? 0 : sceneRows.filter((row) => row.fallback === true).length / sceneRows.length,
    fallbackScenes: sceneRows.filter((row) => row.fallback === true).length,
    perRole,
    approvalRejections,
    tension: { values: tension, stddev: stddev(tension) },
    pacing,
    factsPerAct,
    trigramRepeat: trigramRepeatRate(sceneRows.map((row) => row.narration ?? "")),
    narrationLengths: {
      min: narrationLengths.length === 0 ? 0 : Math.min(...narrationLengths),
      max: narrationLengths.length === 0 ? 0 : Math.max(...narrationLengths),
      mean: mean(narrationLengths),
    },
    lineLengths: {
      min: lineLengths.length === 0 ? 0 : Math.min(...lineLengths),
      max: lineLengths.length === 0 ? 0 : Math.max(...lineLengths),
      mean: mean(lineLengths),
    },
    expansions: {
      proposed: expansions.length,
      approved,
      adoptionRate: expansions.length === 0 ? 0 : approved / expansions.length,
    },
    maxScenesHit: manifest?.status === "max_scenes",
  };
}

function readLines(text) {
  return text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
}

export function main({ argv, fs, log }) {
  const runDir = argv[0];
  if (runDir === undefined) {
    log("[story-eval-analyze] RUN_DIR_REQUIRED");
    return 1;
  }
  const join = (name) => `${runDir.replace(/[\\/]+$/, "")}/${name}`;
  const metrics = computeStoryEvalMetrics({
    calls: readLines(fs.readFileSync(join("calls.jsonl"), "utf8")),
    story: readLines(fs.readFileSync(join("story.jsonl"), "utf8")),
    manifest: JSON.parse(fs.readFileSync(join("manifest.json"), "utf8")),
  });
  fs.writeFileSync(join("metrics.json"), JSON.stringify(metrics, null, 2) + "\n", "utf8");
  log(`[story-eval-analyze] scenes=${metrics.sceneCount} converged=${metrics.converged} fallbackRate=${metrics.fallbackRate.toFixed(3)} tensionStddev=${metrics.tension.stddev.toFixed(3)} trigramRepeat=${metrics.trigramRepeat.toFixed(3)}`);
  return 0;
}

if (resolve(process.argv[1] ?? "") === resolve(import.meta.filename)) {
  process.exitCode = main({ argv: process.argv.slice(2), fs: await import("node:fs"), log: console.log });
}
