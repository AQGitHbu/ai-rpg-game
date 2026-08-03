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
  // 批准的扩展（新地点）：其铸 ID loc_dyn_1 在 story 第 2 幕登场 → persisted/adopted = 1。
  { kind: "expansion_decision", decision: { ok: true, expansion: { newLocation: { name: "新地点", description: "d", scale: "scene", connectFromLocationId: "loc_1", reason: "r" }, newNpc: null } } },
  { kind: "expansion_decision", decision: { ok: false, reason: "budget_exhausted" } },
];

const story = [
  {
    kind: "scene", sceneIndex: 1, mainStage: 1, narration: "aaa bbb ccc",
    newEvents: [{ type: "narrative_choice" }], fallback: false,
    directorPlan: { allowedRevealFactIds: [], introducedEntities: [{ kind: "location", id: "loc_1" }] },
  },
  {
    kind: "scene", sceneIndex: 2, mainStage: 2, narration: "aaa bbb ddd",
    newEvents: [
      { type: "fact_discovered", factId: "f1" },
      { type: "fact_discovered", factId: "f9" }, // 实际发现但未计划：只进 actual，不进 overlap
      { type: "npc_met", entityId: "np_1" },
    ],
    fallback: false,
    directorPlan: {
      allowedRevealFactIds: ["f1", "f2"],
      introducedEntities: [{ kind: "npc", id: "np_1" }, { kind: "location", id: "loc_dyn_1" }],
    },
  },
  { kind: "scene", sceneIndex: 3, mainStage: 2, narration: "xxx yyy zzz", newEvents: [], fallback: true, directorPlan: null },
  { kind: "ending", sceneIndex: 4, outcome: "success", newEvents: [] },
];

const manifest = { status: "converged", sceneCount: 3, fallbackScenes: 1 };

test("computeStoryEvalMetrics 计算全部客观指标（v2 真实口径）", () => {
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
  // 每幕事实覆盖：旧 artifact 无 usedFactIds，actual 兼容回退到 fact_discovered；
  // 新口径另列 discoveredFactIds。
  assert.deepEqual(metrics.factsPerAct, [
    { act: 1, plannedFactIds: [], actualFactIds: [], newFactIds: [], repeatedFactIds: [], discoveredFactIds: [], overlapFactIds: [], missedFactIds: [] },
    {
      act: 2,
      plannedFactIds: ["f1", "f2"],
      actualFactIds: ["f1", "f9"],   // f9 实际发现但未计划
      newFactIds: ["f1", "f9"],
      repeatedFactIds: [],
      discoveredFactIds: ["f1", "f9"],
      overlapFactIds: ["f1"],
      missedFactIds: ["f2"],          // 计划但未实际揭示
    },
  ]);
  // 实体漏斗：introduced → interacted → contribution。
  assert.deepEqual(metrics.entities.npc, { introduced: 1, interacted: 1, contributed: 1 }); // np_1 在含 fact_discovered 的行登场
  assert.deepEqual(metrics.entities.location, { introduced: 2, interacted: 0, contributed: 1 }); // loc_1 + loc_dyn_1；loc_dyn_1 在含 fact_discovered 的行登场
  assert.deepEqual(metrics.entities.item, { introduced: 0, interacted: 0, contributed: 0 });
  // 扩展漏斗：proposed/approved 按提案数；persisted/adopted 按登场实体数（不复用 approved）。
  assert.deepEqual(metrics.entities.expansion, { proposed: 2, approved: 1, persisted: 1, adopted: 1 });
  // 无分支产物时选择漏斗全零。
  assert.deepEqual(metrics.choices, { pairedCheckpoints: 0, stateDifferent: 0, eventDifferent: 0, narrationDifferent: 0, reconvergedCheckpoints: 0, notApplicable: 0 });
  assert.ok(metrics.trigramRepeat > 0 && metrics.trigramRepeat < 1);
  assert.equal(metrics.narrationLengths.mean > 0, true);
  assert.equal(metrics.maxScenesHit, false);
});

test("mainlineObjective 区分下一跳呈现、直接目标命中与物品规则事件", () => {
  const metrics = computeStoryEvalMetrics({
    calls: [],
    story: [
      {
        kind: "scene", sceneIndex: 1, mainStage: 1, narration: "一",
        activeMainObjective: {
          questId: "q1", stage: 1, kind: "visit_location", targetId: "loc_2",
          targetActionKey: "move:loc_2", suggestedActionKey: "move:loc_2",
        },
        choices: [{ label: "去镇上", actionKey: "move:loc_2" }],
        playerChoice: { index: 0, actionKey: "move:loc_2", reason: "objective" },
        newEvents: [],
      },
      {
        kind: "scene", sceneIndex: 2, mainStage: 2, narration: "二",
        activeMainObjective: {
          questId: "q2", stage: 2, kind: "obtain_item", targetId: "item_key",
          targetActionKey: "take_item:item_key", suggestedActionKey: "move:loc_3",
        },
        choices: [{ label: "去取物品", actionKey: "move:loc_3" }],
        playerChoice: { index: 0, actionKey: "move:loc_3", reason: "objective" },
        newEvents: [{ type: "location_visited", entityId: "loc_3" }],
      },
      {
        kind: "scene", sceneIndex: 3, mainStage: 2, narration: "三",
        activeMainObjective: {
          questId: "q2", stage: 2, kind: "obtain_item", targetId: "item_key",
          targetActionKey: "take_item:item_key", suggestedActionKey: "take_item:item_key",
        },
        choices: [{ label: "拾取", actionKey: "take_item:item_key" }],
        playerChoice: { index: 0, actionKey: "take_item:item_key", reason: "objective" },
        newEvents: [{ type: "item_obtained", entityId: "item_key" }],
      },
    ],
    manifest: {},
  });
  assert.equal(metrics.mainlineObjective.opportunities, 3);
  assert.equal(metrics.mainlineObjective.suggestedPresented, 3);
  assert.equal(metrics.mainlineObjective.targetChosen, 2);
  assert.equal(metrics.mainlineObjective.objectiveEventHits, 1);
  assert.equal(metrics.itemObjective.opportunities, 2);
  assert.equal(metrics.itemObjective.suggestedChosen, 2);
  assert.equal(metrics.itemObjective.objectiveEventHits, 1);
});

test("mainlineObjective 优先使用当前选择产生的 actionEvents", () => {
  const metrics = computeStoryEvalMetrics({
    calls: [],
    story: [{
      kind: "scene", sceneIndex: 1, mainStage: 1, narration: "一",
      activeMainObjective: {
        questId: "q1", stage: 1, kind: "visit_location", targetId: "loc_2",
        targetActionKey: "move:loc_2", suggestedActionKey: "move:loc_2",
      },
      choices: [{ label: "去", actionKey: "move:loc_2" }],
      playerChoice: { index: 0, actionKey: "move:loc_2", reason: "objective" },
      // newEvents 是旧产物的兼容字段；新产物的目标结果看 actionEvents。
      newEvents: [{ type: "narrative_scene_presented" }],
      actionEvents: [{ type: "location_visited", entityId: "loc_2" }],
    }],
    manifest: {},
  });
  assert.equal(metrics.mainlineObjective.objectiveEventHits, 1);
  assert.equal(metrics.mainlineObjective.progressedScenes, 1);
});

test("defeat_enemy 以 start_battle 的直接规则事件计入，胜负另由 ending 证明", () => {
  const metrics = computeStoryEvalMetrics({
    calls: [],
    story: [{
      kind: "scene", sceneIndex: 1, mainStage: 8, narration: "决战",
      activeMainObjective: {
        questId: "q8", stage: 8, kind: "defeat_enemy", targetId: "enemy_boss",
        targetActionKey: "start_battle:enemy_boss", suggestedActionKey: "start_battle:enemy_boss",
      },
      choices: [{ label: "迎战", actionKey: "start_battle:enemy_boss" }],
      playerChoice: { index: 0, actionKey: "start_battle:enemy_boss", reason: "objective:main_battle" },
      actionEvents: [{ type: "battle_started", entityId: "enemy_boss" }],
    }, { kind: "ending", sceneIndex: 3, outcome: "win" }],
    manifest: { status: "converged" },
  });
  assert.equal(metrics.mainlineObjective.targetChosen, 1);
  assert.equal(metrics.mainlineObjective.objectiveEventHits, 1);
  assert.equal(metrics.mainlineObjective.progressedScenes, 1);
  assert.equal(metrics.mainlineObjective.byKind.defeat_enemy.objectiveEventHits, 1);
});

test("approved 但未登场的扩展提案：approved=1、adopted=0", () => {
  const metrics = computeStoryEvalMetrics({
    calls: [
      {
        kind: "expansion_decision",
        decision: { ok: true, expansion: { newLocation: null, newNpc: { name: "神秘人", role: "npc", description: "d", locationId: "loc_1" } } },
      },
    ],
    story: [
      { kind: "scene", sceneIndex: 1, mainStage: 1, narration: "n", directorPlan: { allowedRevealFactIds: [], introducedEntities: [] }, newEvents: [] },
    ],
    manifest: {},
  });
  assert.equal(metrics.entities.expansion.proposed, 1);
  assert.equal(metrics.entities.expansion.approved, 1);
  assert.equal(metrics.entities.expansion.persisted, 0); // 动态 ID 不可观测 → 无法确认持久化
  assert.equal(metrics.entities.expansion.adopted, 0);    // 绝不复用 approved
});

test("实际发现但未计划的事实只进 actual 不进 overlap", () => {
  const metrics = computeStoryEvalMetrics({
    calls: [],
    story: [
      {
        kind: "scene", sceneIndex: 1, mainStage: 3, narration: "n",
        directorPlan: { allowedRevealFactIds: ["f1"], introducedEntities: [] },
        newEvents: [{ type: "fact_discovered", factId: "f9" }],
      },
    ],
    manifest: {},
  });
  assert.deepEqual(metrics.factsPerAct[0].actualFactIds, ["f9"]);
  assert.deepEqual(metrics.factsPerAct[0].discoveredFactIds, ["f9"]);
  assert.deepEqual(metrics.factsPerAct[0].overlapFactIds, []);
  assert.deepEqual(metrics.factsPerAct[0].missedFactIds, ["f1"]);
});

test("新产物把叙事使用与规则调查分开统计", () => {
  const metrics = computeStoryEvalMetrics({
    calls: [],
    story: [{
      kind: "scene", sceneIndex: 1, mainStage: 2, narration: "n",
      directorPlan: { allowedRevealFactIds: ["f1", "f2"], introducedEntities: [] },
      usedFactIds: ["f1"],
      npcUsedFactIds: ["f2"],
      actionEvents: [{ type: "fact_discovered", factId: "f9" }],
    }],
    manifest: {},
  });
  assert.deepEqual(metrics.factsPerAct[0], {
    act: 2,
    plannedFactIds: ["f1", "f2"],
    actualFactIds: ["f1", "f2"],
    newFactIds: ["f1", "f2"],
    repeatedFactIds: [],
    discoveredFactIds: ["f9"],
    overlapFactIds: ["f1", "f2"],
    missedFactIds: [],
  });
});

const branchBase = {
  eventsAfter: [{ type: "npc_met", entityId: "np_1" }],
  stateDiff: {
    location: { before: "loc_0", after: "loc_1" },
    facts: { newlyDiscovered: [] },
    quests: { after: {} },
    relationships: { after: {} },
    items: { gained: [] },
    battle: { after: "idle" },
    ending: { after: null },
  },
  narration: ["文本 A"],
};

test("两个 branch 仅 actionKey 不同但状态/事件/文本相同：不得算后果差异", () => {
  const metrics = computeStoryEvalMetrics({
    calls: [],
    story: [],
    manifest: {},
    branches: [
      { checkpoint: 2, choiceActionKey: "move:loc_1", ...branchBase },
      { checkpoint: 2, choiceActionKey: "move:loc_2", ...branchBase },
    ],
  });
  assert.equal(metrics.choices.pairedCheckpoints, 1);
  assert.equal(metrics.choices.stateDifferent, 0);
  assert.equal(metrics.choices.eventDifferent, 0);
  assert.equal(metrics.choices.narrationDifferent, 0);
  assert.equal(metrics.choices.reconvergedCheckpoints, 1);
  assert.equal(metrics.choices.notApplicable, 0);
});

test("成对分支确有状态/事件/文本差异时逐项计入，且 not_applicable 单独计数", () => {
  const divergedBranch = {
    checkpoint: 2,
    choiceActionKey: "investigate:fact_2",
    eventsAfter: [{ type: "fact_discovered", factId: "f2" }],
    stateDiff: {
      location: { before: "loc_0", after: "loc_0" },
      facts: { newlyDiscovered: ["f2"] },
      quests: { after: { q1: "active" } },
      relationships: { after: {} },
      items: { gained: ["it_9"] },
      battle: { after: "idle" },
      ending: { after: null },
    },
    narration: ["另一段文本"],
  };
  const metrics = computeStoryEvalMetrics({
    calls: [],
    story: [],
    manifest: {},
    branches: [
      { checkpoint: 2, choiceActionKey: "move:loc_1", ...branchBase },
      { checkpoint: 2, choiceActionKey: "investigate:fact_2", ...divergedBranch },
    ],
    notApplicable: [{ checkpoint: 4 }],
  });
  assert.equal(metrics.choices.pairedCheckpoints, 1);
  assert.equal(metrics.choices.stateDifferent, 1);
  assert.equal(metrics.choices.eventDifferent, 1);
  assert.equal(metrics.choices.narrationDifferent, 1);
  assert.equal(metrics.choices.reconvergedCheckpoints, 0);
  assert.equal(metrics.choices.notApplicable, 1);
});

test("重复引用事实不会被误报为新覆盖，none_proposed 不计扩展提案", () => {
  const metrics = computeStoryEvalMetrics({
    calls: [{ kind: "expansion_decision", decision: { ok: false, reason: "none_proposed" } }],
    story: [
      { kind: "scene", sceneIndex: 1, mainStage: 1, narration: "一", usedFactIds: ["f1"], npcUsedFactIds: [], actionEvents: [] },
      { kind: "scene", sceneIndex: 2, mainStage: 1, narration: "二", usedFactIds: ["f1"], npcUsedFactIds: [], actionEvents: [] },
    ],
    manifest: { blueprint: { facts: [{ id: "f1" }, { id: "f2" }] } },
  });
  assert.deepEqual(metrics.factsPerAct[0].newFactIds, ["f1"]);
  assert.deepEqual(metrics.factsPerAct[0].repeatedFactIds, ["f1"]);
  assert.equal(metrics.facts.usedCoverageRate, 0.5);
  assert.equal(metrics.entities.expansion.proposed, 0);
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
  assert.ok(written.entities.expansion.adopted >= 0);
});

test("main 无参数时 RUN_DIR_REQUIRED", () => {
  const lines = [];
  const code = main({ argv: [], fs: {}, log: (line) => lines.push(line) });
  assert.equal(code, 1);
  assert.ok(lines.some((line) => line.includes("RUN_DIR_REQUIRED")));
});
