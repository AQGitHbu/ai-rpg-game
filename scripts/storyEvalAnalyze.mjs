// ---------------------------------------------------------------------------
// storyEvalAnalyze：零 AI 成本的客观指标分析（spec §8.1）。
// 纯离线：输入任意 run 目录（calls.jsonl / story.jsonl / manifest.json /
// branches/ 分支产物），输出 metrics.json。可对历史 run 重复执行，
// 是每轮调优后的免费第一道体检。
// 指标定义见 docs/策划文档/AI内容质量评估标准.md §3（与本文件保持一致）。
// v2 口径（Task 13 Step 5）：
// - factsPerAct：计划揭示 = directorPlan.allowedRevealFactIds 集合；
//   实际揭示 = 具 factId 的 fact_discovered 事件集合；并列 planned/actual/
//   overlap/missed，不以仅有事件类型的记录代替事实 ID。
// - entities：NPC/地点/物品的 introduced → interacted/used → contribution
//   漏斗；expansion 的 proposed/approved/persisted/adopted 分开，
//   adopted 只统计已持久化且实际首次登场的扩展实体，绝不复用 approved。
// - choices：成对分支证据（branches/ 产物）驱动的选择漏斗；仅 actionKey
//   不同但状态/事件/文本均相同的分支不得计为后果差异。
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

/**
 * 每幕事实揭示（spec §5.3 两种口径）：
 * 计划 = directorPlan.allowedRevealFactIds 集合；实际 = 具 factId 的
 * fact_discovered 事件集合（不以仅有事件类型的记录代替事实 ID）。
 */
function factsPerActOf(sceneRows) {
  const byAct = new Map();
  for (const row of sceneRows) {
    if (typeof row.mainStage !== "number") continue;
    const entry = byAct.get(row.mainStage) ?? { planned: new Set(), actual: new Set() };
    for (const id of row.directorPlan?.allowedRevealFactIds ?? []) {
      if (typeof id === "string" && id !== "") entry.planned.add(id);
    }
    for (const event of row.newEvents ?? []) {
      if (event.type === "fact_discovered" && typeof event.factId === "string" && event.factId !== "") {
        entry.actual.add(event.factId);
      }
    }
    byAct.set(row.mainStage, entry);
  }
  return [...byAct.entries()]
    .sort(([a], [b]) => a - b)
    .map(([act, sets]) => {
      const plannedFactIds = [...sets.planned];
      const actualFactIds = [...sets.actual];
      return {
        act,
        plannedFactIds,
        actualFactIds,
        overlapFactIds: plannedFactIds.filter((id) => sets.actual.has(id)),
        missedFactIds: plannedFactIds.filter((id) => !sets.actual.has(id)),
      };
    });
}

/** 交互事件 → 实体种类（used/interacted 口径）。 */
const KIND_INTERACTION_EVENTS = {
  npc: ["npc_met"],
  location: ["location_observed", "location_visited"],
  item: ["item_obtained"],
};

/** 贡献事件：场景行内含这些事件即视为该行登场的实体对剧情/任务/战斗/结局产生功能贡献。 */
const CONTRIBUTION_EVENTS = new Set([
  "fact_discovered",
  "quest_completed",
  "quest_unlocked",
  "quest_failed",
  "battle_started",
  "battle_resolved",
  "enemy_defeated",
  "ending_reached",
]);

/** 动态扩展实体的铸 ID（compileBlueprintExpansion 服务端铸造，初始蓝图永不含）。 */
const DYNAMIC_ENTITY_ID = /^(loc_dyn_|npc_dyn_)/;

/**
 * 实体漏斗（spec §5.3）：introduced → interacted/used → contribution，
 * 按 NPC/地点/物品分列。contribution = 在含贡献事件的场景行中登场
 * （directorPlan.introducedEntities 或交互事件）的该种类实体去重集合。
 */
function entityFunnel(sceneRows) {
  const introduced = { npc: new Set(), location: new Set(), item: new Set() };
  const interacted = { npc: new Set(), location: new Set(), item: new Set() };
  const contributed = { npc: new Set(), location: new Set(), item: new Set() };
  for (const row of sceneRows) {
    const rowEntities = { npc: new Set(), location: new Set(), item: new Set() };
    for (const entry of row.directorPlan?.introducedEntities ?? []) {
      if (entry.kind in rowEntities && typeof entry.id === "string" && entry.id !== "") {
        introduced[entry.kind].add(entry.id);
        rowEntities[entry.kind].add(entry.id);
      }
    }
    for (const event of row.newEvents ?? []) {
      for (const kind of Object.keys(KIND_INTERACTION_EVENTS)) {
        if (KIND_INTERACTION_EVENTS[kind].includes(event.type) && typeof event.entityId === "string" && event.entityId !== "") {
          interacted[kind].add(event.entityId);
          rowEntities[kind].add(event.entityId);
        }
      }
    }
    if ((row.newEvents ?? []).some((event) => CONTRIBUTION_EVENTS.has(event.type))) {
      for (const kind of ["npc", "location", "item"]) {
        for (const id of rowEntities[kind]) contributed[kind].add(id);
      }
    }
  }
  return {
    npc: { introduced: introduced.npc.size, interacted: interacted.npc.size, contributed: contributed.npc.size },
    location: { introduced: introduced.location.size, interacted: interacted.location.size, contributed: contributed.location.size },
    item: { introduced: introduced.item.size, interacted: interacted.item.size, contributed: contributed.item.size },
  };
}

/**
 * 扩展实体漏斗：proposed（提案数）→ approved（批准数）→ persisted →
 * adopted（已持久化且实际首次登场的扩展实体数，不复用 approved）。
 * 编译铸 ID（loc_dyn_* / npc_dyn_*）同步于审批：动态 ID 在故事数据中可观测
 * （directorPlan.introducedEntities 或事件 entityId）即证明已持久化且登场；
 * 当前产物口径下任何登场即首次登场，adopted 与 persisted 在数值上一致，
 * 但语义上 adopted 只统计"实际首次登场"的实体。proposed/approved 按提案数，
 * persisted/adopted 按实体数。
 */
function expansionFunnel(calls, sceneRows) {
  const decisions = calls.filter((call) => call.kind === "expansion_decision");
  const approved = decisions.filter((call) => call.decision?.ok === true).length;
  const dynamicIds = new Set();
  for (const row of sceneRows) {
    for (const entry of row.directorPlan?.introducedEntities ?? []) {
      if (typeof entry.id === "string" && DYNAMIC_ENTITY_ID.test(entry.id)) dynamicIds.add(entry.id);
    }
    for (const event of row.newEvents ?? []) {
      if (typeof event.entityId === "string" && DYNAMIC_ENTITY_ID.test(event.entityId)) dynamicIds.add(event.entityId);
    }
  }
  const persisted = dynamicIds.size;
  return { proposed: decisions.length, approved, persisted, adopted: persisted };
}

/** 分支 outcome 快照：只取 after 侧可观察状态，用于成对比较后果差异。 */
function branchOutcomeOf(branch) {
  return JSON.stringify({
    location: branch.stateDiff?.location?.after,
    facts: branch.stateDiff?.facts?.newlyDiscovered,
    quests: branch.stateDiff?.quests?.after,
    relationships: branch.stateDiff?.relationships?.after,
    items: branch.stateDiff?.items?.gained,
    battle: branch.stateDiff?.battle?.after,
    ending: branch.stateDiff?.ending?.after,
  });
}

/**
 * 选择漏斗（spec §5.3）：成对分支证据（branch.json）驱动。
 * stateDifferent/eventDifferent/narrationDifferent 只统计实际存在差异的
 * 成对检查点——仅 actionKey 不同但状态/事件/文本均相同不得计为后果差异。
 */
function choicesOf(branches, notApplicable) {
  const byCheckpoint = new Map();
  for (const branch of branches) {
    const list = byCheckpoint.get(branch.checkpoint) ?? [];
    list.push(branch);
    byCheckpoint.set(branch.checkpoint, list);
  }
  const paired = [...byCheckpoint.values()].filter((list) => list.length === 2);
  const differs = (pick) => paired.filter(([a, b]) => pick(a) !== pick(b)).length;
  return {
    pairedCheckpoints: paired.length,
    stateDifferent: differs(branchOutcomeOf),
    eventDifferent: differs((branch) => JSON.stringify(branch.eventsAfter ?? [])),
    narrationDifferent: differs((branch) => JSON.stringify(branch.narration ?? [])),
    notApplicable: notApplicable.length,
  };
}

export function computeStoryEvalMetrics({ calls, story, manifest, branches = [], notApplicable = [] }) {
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
  const narrationLengths = sceneRows.map((row) => Array.from(row.narration ?? "").length);
  const lineLengths = sceneRows
    .flatMap((row) => (row.npcLine === null || row.npcLine === undefined ? [] : [Array.from(row.npcLine.text ?? "").length]));
  return {
    sceneCount: sceneRows.length,
    converged: endingRow !== undefined,
    fallbackRate: sceneRows.length === 0 ? 0 : sceneRows.filter((row) => row.fallback === true).length / sceneRows.length,
    fallbackScenes: sceneRows.filter((row) => row.fallback === true).length,
    perRole,
    approvalRejections,
    tension: { values: tension, stddev: stddev(tension) },
    pacing,
    factsPerAct: factsPerActOf(sceneRows),
    entities: {
      ...entityFunnel(sceneRows),
      expansion: expansionFunnel(calls, sceneRows),
    },
    choices: choicesOf(branches, notApplicable),
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
    maxScenesHit: manifest?.status === "max_scenes",
  };
}

function readLines(text) {
  return text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
}

/** 读取 branches/ 产物：<runDir>/branches/stage<N>/<choice>/branch.json 与 not_applicable.json。
 *  缺失/损坏分支产物静默跳过（旧 run 无分支目录 → 选择漏斗全零）。 */
function readBranchArtifacts(fs, join) {
  const branches = [];
  const notApplicable = [];
  let stageDirs;
  try {
    stageDirs = fs.readdirSync(join("branches"));
  } catch {
    return { branches, notApplicable };
  }
  for (const stageName of stageDirs) {
    if (!stageName.startsWith("stage")) continue;
    let entries;
    try {
      entries = fs.readdirSync(join("branches", stageName));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry === "not_applicable.json") {
        try {
          const parsed = JSON.parse(fs.readFileSync(join("branches", stageName, "not_applicable.json"), "utf8"));
          if (typeof parsed?.checkpoint === "number") notApplicable.push(parsed);
        } catch { /* 跳过损坏产物 */ }
        continue;
      }
      try {
        const parsed = JSON.parse(fs.readFileSync(join("branches", stageName, entry, "branch.json"), "utf8"));
        branches.push(parsed);
      } catch { /* 跳过损坏产物 */ }
    }
  }
  return { branches, notApplicable };
}

export function main({ argv, fs, log }) {
  const runDir = argv[0];
  if (runDir === undefined) {
    log("[story-eval-analyze] RUN_DIR_REQUIRED");
    return 1;
  }
  const join = (...names) => `${runDir.replace(/[\\/]+$/, "")}/${names.join("/")}`;
  const branchInput = readBranchArtifacts(fs, join);
  const metrics = computeStoryEvalMetrics({
    calls: readLines(fs.readFileSync(join("calls.jsonl"), "utf8")),
    story: readLines(fs.readFileSync(join("story.jsonl"), "utf8")),
    manifest: JSON.parse(fs.readFileSync(join("manifest.json"), "utf8")),
    ...branchInput,
  });
  fs.writeFileSync(join("metrics.json"), JSON.stringify(metrics, null, 2) + "\n", "utf8");
  log(`[story-eval-analyze] scenes=${metrics.sceneCount} converged=${metrics.converged} fallbackRate=${metrics.fallbackRate.toFixed(3)} tensionStddev=${metrics.tension.stddev.toFixed(3)} trigramRepeat=${metrics.trigramRepeat.toFixed(3)}`);
  return 0;
}

if (resolve(process.argv[1] ?? "") === resolve(import.meta.filename)) {
  process.exitCode = main({ argv: process.argv.slice(2), fs: await import("node:fs"), log: console.log });
}
