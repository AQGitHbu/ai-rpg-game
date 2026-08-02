import { describe, expect, it } from "vitest";
import type {
  EndingDefinitionCandidate,
  QuestDefinitionCandidate,
  QuestOutcomeCandidate
} from "@/game/domain";
import {
  analyzeQuestReachability,
  validateQuestGraph,
  type QuestGraphIssue,
  type QuestGraphKnownEntityIds
} from "./questGraph";

// ---------------------------------------------------------------------------
// Fixture builders：默认构造一张满足全部规则的合法任务图。
//   m1(主线1) --成功--> m2(主线2) + s1(支线)
//   m2(主线2) --成功--> m3(主线3)
//   m3(主线3) --成功--> e1 / --失败--> e2
//   失败路径未特别声明时为 closed。
// ---------------------------------------------------------------------------

const KNOWN_ENTITIES: QuestGraphKnownEntityIds = {
  locationIds: ["loc_a", "loc_b"],
  npcIds: ["npc_a"],
  itemIds: ["item_a"],
  factIds: ["fact_a"],
  enemyIds: ["enemy_a"]
};

const CLOSED: QuestOutcomeCandidate = { kind: "closed" };

function unlock(...questIds: string[]): QuestOutcomeCandidate {
  return { kind: "unlock_quests", questIds };
}

function ending(endingId: string): QuestOutcomeCandidate {
  return { kind: "reach_ending", endingId };
}

type QuestOverrides = Partial<QuestDefinitionCandidate> & { id: string };

function mainQuest(stage: number, overrides: QuestOverrides): QuestDefinitionCandidate {
  const defaultObjective = stage === 1
    ? { kind: "visit_location" as const, locationId: "loc_a" }
    : stage === 2
      ? { kind: "talk_to_npc" as const, npcId: "npc_a" }
      : stage === 3
        ? { kind: "obtain_item" as const, itemId: "item_a" }
        : stage === 4
          ? { kind: "discover_fact" as const, factId: "fact_a" }
          : { kind: "visit_location" as const, locationId: "loc_b" };
  return {
    kind: "main",
    stage,
    name: `主线任务 ${overrides.id}`,
    description: "测试描述",
    objectives: [defaultObjective],
    onSuccess: CLOSED,
    onFailure: CLOSED,
    tags: [],
    ...overrides
  } as QuestDefinitionCandidate;
}

function sideQuest(overrides: QuestOverrides): QuestDefinitionCandidate {
  return {
    kind: "side",
    name: `支线任务 ${overrides.id}`,
    description: "测试描述",
    objectives: [{ kind: "talk_to_npc", npcId: "npc_a" }],
    onSuccess: CLOSED,
    onFailure: CLOSED,
    tags: [],
    ...overrides
  } as QuestDefinitionCandidate;
}

function makeEnding(id: string): EndingDefinitionCandidate {
  return { id, name: `结局 ${id}`, description: "测试结局", requirements: [] };
}

function makeQuests(): QuestDefinitionCandidate[] {
  return [
    mainQuest(1, { id: "m1", onSuccess: unlock("m2", "s1") }),
    mainQuest(2, { id: "m2", onSuccess: unlock("m3") }),
    mainQuest(3, { id: "m3", onSuccess: ending("e1"), onFailure: ending("e2") }),
    sideQuest({ id: "s1" })
  ];
}

function makeEndings(): EndingDefinitionCandidate[] {
  return [makeEnding("e1"), makeEnding("e2")];
}

const DEFAULT_BUDGET = { mainActs: 3, sideQuestsMax: 2, endings: 2 };

function issuesOf(
  quests: readonly QuestDefinitionCandidate[],
  endings: readonly EndingDefinitionCandidate[] = makeEndings(),
  knownEntityIds: QuestGraphKnownEntityIds = KNOWN_ENTITIES,
  budget = DEFAULT_BUDGET
): readonly QuestGraphIssue[] {
  return validateQuestGraph({ quests, endings, knownEntityIds, budget });
}

function codesOf(issues: readonly QuestGraphIssue[]): string[] {
  return issues.map((issue) => issue.code);
}

// ---------------------------------------------------------------------------
// validateQuestGraph
// ---------------------------------------------------------------------------

describe("validateQuestGraph：合法任务图", () => {
  it("满足全部规则的任务图不产生任何问题", () => {
    expect(issuesOf(makeQuests())).toEqual([]);
  });

  it("带闭环但可达关闭路径的任务图合法", () => {
    // m2 失败回到 m1，形成 m1↔m2 闭环；但 m2 成功仍可走到 m3 → 结局。
    const quests = makeQuests();
    quests[1] = mainQuest(2, { id: "m2", onSuccess: unlock("m3"), onFailure: unlock("m1") });
    expect(issuesOf(quests)).toEqual([]);
  });
});

describe("validateQuestGraph：重复或悬空 ID", () => {
  it("拒绝重复的任务 ID", () => {
    const quests = [...makeQuests(), sideQuest({ id: "s1" })];
    const issues = issuesOf(quests);
    expect(issues).toContainEqual({
      path: "quests[4].id",
      code: "DUPLICATE_QUEST_ID",
      params: { id: "s1" }
    });
  });

  it("拒绝重复的结局 ID", () => {
    const issues = issuesOf(makeQuests(), [makeEnding("e1"), makeEnding("e1")]);
    expect(codesOf(issues)).toContain("DUPLICATE_ENDING_ID");
  });

  it("拒绝 unlock_quests 指向不存在的任务", () => {
    const quests = makeQuests();
    quests[0] = mainQuest(1, { id: "m1", onSuccess: unlock("m2", "ghost") });
    const issues = issuesOf(quests);
    expect(issues).toContainEqual({
      path: "quests[0].onSuccess.questIds[1]",
      code: "DANGLING_QUEST_REF",
      params: { questId: "ghost" }
    });
  });

  it("拒绝 reach_ending 指向不存在的结局", () => {
    const quests = makeQuests();
    quests[2] = mainQuest(3, { id: "m3", onSuccess: ending("e1"), onFailure: ending("ghost") });
    const issues = issuesOf(quests);
    expect(issues).toContainEqual({
      path: "quests[2].onFailure.endingId",
      code: "DANGLING_ENDING_REF",
      params: { endingId: "ghost" }
    });
  });
});

describe("validateQuestGraph：objective 引用不存在实体", () => {
  const cases = [
    { objective: { kind: "visit_location", locationId: "ghost" }, target: "ghost" },
    { objective: { kind: "talk_to_npc", npcId: "ghost" }, target: "ghost" },
    { objective: { kind: "obtain_item", itemId: "ghost" }, target: "ghost" },
    { objective: { kind: "discover_fact", factId: "ghost" }, target: "ghost" },
    { objective: { kind: "defeat_enemy", enemyId: "ghost" }, target: "ghost" }
  ] as const;

  for (const { objective } of cases) {
    it(`拒绝 ${objective.kind} 引用未知实体`, () => {
      const quests = makeQuests();
      quests[3] = sideQuest({
        id: "s1",
        objectives: [objective as QuestDefinitionCandidate["objectives"][number]]
      });
      const issues = issuesOf(quests);
      expect(issues).toContainEqual({
        path: "quests[3].objectives[0]",
        code: "UNKNOWN_OBJECTIVE_TARGET",
        params: { kind: objective.kind, targetId: "ghost" }
      });
    });
  }

  it("拒绝未知的 objective 类型（候选来自 JSON，运行时防御）", () => {
    const quests = makeQuests();
    quests[3] = sideQuest({
      id: "s1",
      objectives: [{ kind: "fly_to_moon" } as unknown as QuestDefinitionCandidate["objectives"][number]]
    });
    expect(codesOf(issuesOf(quests))).toContain("INVALID_OBJECTIVE");
  });
});

describe("validateQuestGraph：唯一初始主线节点", () => {
  it("没有 stage 1 主线任务时拒绝", () => {
    const quests = makeQuests().filter((quest) => quest.id !== "m1");
    quests[0] = mainQuest(2, { id: "m2", onSuccess: unlock("m3") });
    expect(codesOf(issuesOf(quests))).toContain("NO_INITIAL_MAIN_QUEST");
  });

  it("存在多个 stage 1 主线任务时拒绝", () => {
    const quests = [...makeQuests(), mainQuest(1, { id: "m1b" })];
    expect(codesOf(issuesOf(quests))).toContain("MULTIPLE_INITIAL_MAIN_QUESTS");
  });
});

describe("validateQuestGraph：节点关闭路径（运行时防御）", () => {
  it("onSuccess 缺失时拒绝", () => {
    const quests = makeQuests();
    quests[3] = { ...sideQuest({ id: "s1" }), onSuccess: undefined } as unknown as QuestDefinitionCandidate;
    const issues = issuesOf(quests);
    expect(issues).toContainEqual({
      path: "quests[3].onSuccess",
      code: "INVALID_OUTCOME",
      params: { questId: "s1" }
    });
  });

  it("onFailure 是未知 kind 时拒绝", () => {
    const quests = makeQuests();
    quests[3] = {
      ...sideQuest({ id: "s1" }),
      onFailure: { kind: "retry_forever" }
    } as unknown as QuestDefinitionCandidate;
    expect(codesOf(issuesOf(quests))).toContain("INVALID_OUTCOME");
  });

  it("unlock_quests 列表为空时拒绝（无出边的死局）", () => {
    const quests = makeQuests();
    quests[3] = sideQuest({ id: "s1", onSuccess: unlock() });
    const issues = issuesOf(quests);
    expect(issues).toContainEqual({
      path: "quests[3].onSuccess",
      code: "INVALID_OUTCOME",
      params: { questId: "s1", reason: "empty_unlock_list" }
    });
  });
});

describe("validateQuestGraph：无限循环且无可达关闭", () => {
  it("拒绝无法到达任何结局或 closed 的闭环", () => {
    // m2 与 m3 互相解锁，成功失败都困在环里。
    const quests = [
      mainQuest(1, { id: "m1", onSuccess: unlock("m2") }),
      mainQuest(2, { id: "m2", onSuccess: unlock("m3"), onFailure: unlock("m3") }),
      mainQuest(3, { id: "m3", onSuccess: unlock("m2"), onFailure: unlock("m2") })
    ];
    const issues = issuesOf(quests);
    expect(issues).toContainEqual({
      path: "quests",
      code: "LOOP_WITHOUT_CLOSURE",
      params: { questIds: "m2,m3" }
    });
  });

  it("拒绝自我解锁且无关闭的任务", () => {
    const quests = makeQuests();
    quests[3] = sideQuest({ id: "s1", onSuccess: unlock("s1"), onFailure: unlock("s1") });
    const issues = issuesOf(quests);
    expect(issues).toContainEqual({
      path: "quests",
      code: "LOOP_WITHOUT_CLOSURE",
      params: { questIds: "s1" }
    });
  });
});

describe("validateQuestGraph：结局可达性", () => {
  it("拒绝无法从初始节点到达的结局", () => {
    const quests = makeQuests();
    quests[2] = mainQuest(3, { id: "m3", onSuccess: ending("e1"), onFailure: CLOSED });
    const issues = issuesOf(quests);
    expect(issues).toContainEqual({
      path: "endings[1]",
      code: "UNREACHABLE_ENDING",
      params: { endingId: "e2" }
    });
  });

  it("失败路径抵达的结局同样算可达", () => {
    const quests = makeQuests();
    quests[1] = mainQuest(2, { id: "m2", onSuccess: unlock("m3"), onFailure: ending("e2") });
    quests[2] = mainQuest(3, { id: "m3", onSuccess: ending("e1"), onFailure: CLOSED });
    expect(issuesOf(quests)).toEqual([]);
  });
});

describe("validateQuestGraph：结局数量必须为 2", () => {
  it("只有 1 个结局时拒绝", () => {
    const quests = makeQuests();
    quests[2] = mainQuest(3, { id: "m3", onSuccess: ending("e1"), onFailure: ending("e1") });
    const issues = issuesOf(quests, [makeEnding("e1")]);
    expect(issues).toContainEqual({
      path: "endings",
      code: "ENDING_COUNT_MISMATCH",
      params: { count: 1, expected: 2 }
    });
  });

  it("有 3 个结局时拒绝", () => {
    const issues = issuesOf(makeQuests(), [...makeEndings(), makeEnding("e3")]);
    expect(codesOf(issues)).toContain("ENDING_COUNT_MISMATCH");
  });
});

describe("validateQuestGraph：主线阶段与支线预算", () => {
  it("同一主线阶段出现多个任务时拒绝", () => {
    const quests = [...makeQuests(), mainQuest(2, { id: "m2b" })];
    quests[0] = mainQuest(1, { id: "m1", onSuccess: unlock("m2", "s1", "m2b") });
    const issues = issuesOf(quests);
    expect(issues).toContainEqual({
      path: "quests",
      code: "MAIN_STAGE_OVERBUDGET",
      params: { stage: 2, count: 2 }
    });
  });

  it("主线 stage 不是 1|2|3 时拒绝（候选来自 JSON，运行时防御）", () => {
    const quests = makeQuests();
    quests[2] = { ...mainQuest(3, { id: "m3", onSuccess: ending("e1"), onFailure: ending("e2") }), stage: 4 } as unknown as QuestDefinitionCandidate;
    expect(codesOf(issuesOf(quests))).toContain("INVALID_MAIN_STAGE");
  });

  it("支线数量超过预算 2 时拒绝", () => {
    const quests = [...makeQuests(), sideQuest({ id: "s2" }), sideQuest({ id: "s3" })];
    quests[0] = mainQuest(1, { id: "m1", onSuccess: unlock("m2", "s1", "s2", "s3") });
    const issues = issuesOf(quests);
    expect(issues).toContainEqual({
      path: "quests",
      code: "SIDE_QUEST_OVERBUDGET",
      params: { count: 3, max: 2 }
    });
  });

  it("主线缺少 stage 3 时拒绝", () => {
    const quests = [
      mainQuest(1, { id: "m1", onSuccess: unlock("m2", "s1") }),
      mainQuest(2, { id: "m2", onSuccess: ending("e1"), onFailure: ending("e2") }),
      sideQuest({ id: "s1" })
    ];
    const issues = issuesOf(quests);
    expect(issues).toContainEqual({
      path: "quests",
      code: "MISSING_MAIN_STAGE",
      params: { stage: 3 }
    });
  });

  it("单个 stage 1 主线直达两个结局也拒绝（主线必须三阶段）", () => {
    const quests = [mainQuest(1, { id: "m1", onSuccess: ending("e1"), onFailure: ending("e2") })];
    const issues = issuesOf(quests);
    expect(issues).toEqual([
      { path: "quests", code: "MISSING_MAIN_STAGE", params: { stage: 2 } },
      { path: "quests", code: "MISSING_MAIN_STAGE", params: { stage: 3 } }
    ]);
  });
});

describe("validateQuestGraph：可变主线幕数", () => {
  const BUDGET_5 = { mainActs: 5, sideQuestsMax: 2, endings: 2 };

  function make5ActQuests(): QuestDefinitionCandidate[] {
    return [
      mainQuest(1, { id: "m1", onSuccess: unlock("m2") }),
      mainQuest(2, { id: "m2", onSuccess: unlock("m3") }),
      mainQuest(3, { id: "m3", onSuccess: unlock("m4") }),
      mainQuest(4, { id: "m4", onSuccess: unlock("m5") }),
      mainQuest(5, { id: "m5", onSuccess: ending("e1"), onFailure: ending("e2") })
    ];
  }

  it("5 幕合法链无 issue", () => {
    expect(issuesOf(make5ActQuests(), makeEndings(), KNOWN_ENTITIES, BUDGET_5)).toEqual([]);
  });

  it("缺 stage 3（mainActs 5）→ MISSING_MAIN_STAGE", () => {
    const quests = make5ActQuests().filter((q) => q.id !== "m3");
    quests[1] = mainQuest(2, { id: "m2", onSuccess: unlock("m4") });
    const issues = issuesOf(quests, makeEndings(), KNOWN_ENTITIES, BUDGET_5);
    expect(issues).toContainEqual({ path: "quests", code: "MISSING_MAIN_STAGE", params: { stage: 3 } });
  });

  it("stage 6（mainActs 5）→ INVALID_MAIN_STAGE", () => {
    const quests = make5ActQuests();
    quests[4] = { ...mainQuest(5, { id: "m5" }), stage: 6 } as unknown as QuestDefinitionCandidate;
    const issues = issuesOf(quests, makeEndings(), KNOWN_ENTITIES, BUDGET_5);
    expect(codesOf(issues)).toContain("INVALID_MAIN_STAGE");
  });

  it("stage 2 出现两次 → MAIN_STAGE_OVERBUDGET", () => {
    const quests = [...make5ActQuests(), mainQuest(2, { id: "m2b" })];
    quests[0] = mainQuest(1, { id: "m1", onSuccess: unlock("m2", "m2b") });
    const issues = issuesOf(quests, makeEndings(), KNOWN_ENTITIES, BUDGET_5);
    expect(issues).toContainEqual({ path: "quests", code: "MAIN_STAGE_OVERBUDGET", params: { stage: 2, count: 2 } });
  });

  it("主线重复 kind+target → REPEATED_MAIN_OBJECTIVE", () => {
    const quests = make5ActQuests();
    quests[1] = mainQuest(2, {
      id: "m2",
      objectives: [{ kind: "visit_location", locationId: "loc_a" }],
      onSuccess: unlock("m3"),
    });
    const issues = issuesOf(quests, makeEndings(), KNOWN_ENTITIES, BUDGET_5);
    expect(issues).toContainEqual({
      path: "quests[1].objectives[0]",
      code: "REPEATED_MAIN_OBJECTIVE",
      params: { stage: 2, previousStage: 1, signature: "visit_location:loc_a" },
    });
  });
});

// ---------------------------------------------------------------------------
// analyzeQuestReachability
// ---------------------------------------------------------------------------

describe("analyzeQuestReachability", () => {
  it("合法任务图：全部节点可达，两个结局可达，无无关闭环", () => {
    const analysis = analyzeQuestReachability(makeQuests(), makeEndings());
    expect(analysis).toEqual({
      initialQuestId: "m1",
      reachableQuestIds: ["m1", "m2", "m3", "s1"],
      unreachableQuestIds: [],
      reachableEndingIds: ["e1", "e2"],
      loopsWithoutClosure: []
    });
  });

  it("未被任何任务解锁的任务列入不可达", () => {
    const quests = [...makeQuests(), sideQuest({ id: "s2" })];
    const analysis = analyzeQuestReachability(quests, makeEndings());
    expect(analysis.reachableQuestIds).toEqual(["m1", "m2", "m3", "s1"]);
    expect(analysis.unreachableQuestIds).toEqual(["s2"]);
  });

  it("检出无关闭的强连通区域", () => {
    const quests = [
      mainQuest(1, { id: "m1", onSuccess: unlock("m2") }),
      mainQuest(2, { id: "m2", onSuccess: unlock("m3"), onFailure: unlock("m3") }),
      mainQuest(3, { id: "m3", onSuccess: unlock("m2"), onFailure: unlock("m2") })
    ];
    const analysis = analyzeQuestReachability(quests, makeEndings());
    expect(analysis.loopsWithoutClosure).toEqual([["m2", "m3"]]);
    expect(analysis.reachableEndingIds).toEqual([]);
  });

  it("有出口的闭环不算无关闭区域", () => {
    const quests = makeQuests();
    quests[1] = mainQuest(2, { id: "m2", onSuccess: unlock("m3"), onFailure: unlock("m1") });
    const analysis = analyzeQuestReachability(quests, makeEndings());
    expect(analysis.loopsWithoutClosure).toEqual([]);
  });

  it("缺少唯一初始节点时所有节点不可达", () => {
    const quests = [...makeQuests(), mainQuest(1, { id: "m1b" })];
    const analysis = analyzeQuestReachability(quests, makeEndings());
    expect(analysis.initialQuestId).toBeNull();
    expect(analysis.reachableQuestIds).toEqual([]);
    expect(analysis.unreachableQuestIds).toEqual(["m1", "m2", "m3", "s1", "m1b"]);
    expect(analysis.reachableEndingIds).toEqual([]);
  });

  it("结果顺序稳定：多次调用输出完全一致", () => {
    const quests = makeQuests();
    const first = analyzeQuestReachability(quests, makeEndings());
    const second = analyzeQuestReachability(quests, makeEndings());
    expect(second).toEqual(first);
  });

  it("是纯函数：不修改输入数组", () => {
    const quests = makeQuests();
    const endings = makeEndings();
    const questsSnapshot = JSON.parse(JSON.stringify(quests));
    const endingsSnapshot = JSON.parse(JSON.stringify(endings));
    analyzeQuestReachability(quests, endings);
    expect(quests).toEqual(questsSnapshot);
    expect(endings).toEqual(endingsSnapshot);
  });
});
