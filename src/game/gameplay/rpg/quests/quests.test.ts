import { describe, expect, it } from "vitest";
import {
  asFactId,
  asItemId,
  asEnemyId,
  asLocationId,
  asNpcId,
  asQuestId,
  type GameState,
  type QuestObjectiveCandidate,
  type QuestOutcomeCandidate,
  type QuestStatus,
  type ScenarioBlueprint,
  type ScenarioBlueprintCandidate
} from "@/game/domain";
import { resolveAction, type PlayerIntent } from "../actions";
import {
  compileScenarioBlueprint,
  initializeGameState,
  validateScenarioBlueprintCandidate
} from "../scenario";
import { makeValidCandidate, TEST_PROFILE } from "../scenario/scenarioBlueprintFixture.testutil";
import { isQuestObjectiveSatisfied, reconcileQuests } from "./index";

// ---------------------------------------------------------------------------
// 测试走真实管线：候选 → validate → compile → initializeGameState → resolveAction，
// 保证 reconcileQuests 消费的正是行动 resolver 产出的 next state。
//
// fixture 任务图（scenarioBlueprintFixture.testutil.ts）：
//   m1(主线1, visit loc_b)              --成功--> 解锁 m2 + s1
//   m2(主线2, talk npc_c + obtain item) --成功--> 解锁 m3
//   m3(主线3, defeat enemy)             --成功--> e1
//   s1(支线, discover fact_b)           --成功--> closed
// ---------------------------------------------------------------------------

const FIXED_TIME = "2026-07-27T12:00:00Z";
const deps = { now: () => FIXED_TIME };

function compileFrom(candidate: ScenarioBlueprintCandidate): ScenarioBlueprint {
  const compiled = compileScenarioBlueprint(
    validateScenarioBlueprintCandidate(candidate, { profile: TEST_PROFILE })
  );
  if (!compiled.ok) {
    throw new Error(`fixture 蓝图应当合法：${JSON.stringify(compiled.issues)}`);
  }
  return compiled.blueprint;
}

function setup(candidate: ScenarioBlueprintCandidate = makeValidCandidate()): {
  blueprint: ScenarioBlueprint;
  state: GameState;
} {
  const blueprint = compileFrom(candidate);
  return { blueprint, state: initializeGameState(blueprint) };
}

/** 执行必须成功的行动，返回 next state（失败即测试前提被破坏）。 */
function performOk(blueprint: ScenarioBlueprint, state: GameState, intent: PlayerIntent): GameState {
  const result = resolveAction(blueprint, state, intent, deps);
  if (!result.ok) throw new Error(`行动应当成功，实际被拒绝：${result.code}`);
  return result.state;
}

function questStatus(state: GameState, questId: string): QuestStatus | undefined {
  return state.quests.find((quest) => quest.questId === questId)?.status;
}

/** 定向修改单个任务定义，其余候选内容保持不变。 */
function withQuest(
  candidate: ScenarioBlueprintCandidate,
  questId: string,
  patch: Partial<{
    objectives: readonly QuestObjectiveCandidate[];
    onSuccess: QuestOutcomeCandidate;
  }>
): ScenarioBlueprintCandidate {
  return {
    ...candidate,
    quests: candidate.quests.map((quest) =>
      quest.id === questId ? { ...quest, ...patch } : quest
    )
  };
}

const moveTo = (locationId: string): PlayerIntent => ({
  type: "move",
  locationId: asLocationId(locationId)
});
const talkTo = (npcId: string): PlayerIntent => ({ type: "talk", npcId: asNpcId(npcId) });
const investigate = (factId: string): PlayerIntent => ({
  type: "investigate",
  factId: asFactId(factId)
});
const takeItem = (itemId: string): PlayerIntent => ({
  type: "take_item",
  itemId: asItemId(itemId)
});

describe("reconcileQuests：初始状态与幂等基线", () => {
  it("初始状态：唯一 stage 1 主线 active，其余任务 locked", () => {
    const { state } = setup();
    expect(questStatus(state, "m1")).toBe("active");
    expect(questStatus(state, "m2")).toBe("locked");
    expect(questStatus(state, "m3")).toBe("locked");
    expect(questStatus(state, "s1")).toBe("locked");
  });

  it("objective 未满足时不产生事件并原样返回输入 state", () => {
    const { blueprint, state } = setup();
    const result = reconcileQuests(blueprint, state, deps);
    expect(result.events).toEqual([]);
    expect(result.state).toBe(state);
  });
});

describe("reconcileQuests：visit objective 与解锁", () => {
  it("移动满足 visit 后完成 stage 1 并按 onSuccess 顺序解锁 stage 2 与支线", () => {
    const { blueprint, state } = setup();
    const moved = performOk(blueprint, state, moveTo("loc_b"));
    const result = reconcileQuests(blueprint, moved, deps);

    expect(questStatus(result.state, "m1")).toBe("completed");
    expect(questStatus(result.state, "m2")).toBe("active");
    expect(questStatus(result.state, "s1")).toBe("active");
    expect(questStatus(result.state, "m3")).toBe("locked");
    expect(result.events).toEqual([
      { type: "quest_completed", questId: asQuestId("m1"), occurredAt: FIXED_TIME },
      { type: "quest_unlocked", questId: asQuestId("m2"), occurredAt: FIXED_TIME },
      { type: "quest_unlocked", questId: asQuestId("s1"), occurredAt: FIXED_TIME }
    ]);
    // 事件同时追加进账本，且只追加这三条。
    expect(result.state.eventLedger.slice(moved.eventLedger.length)).toEqual(result.events);
  });

  it("不修改输入 state（不可变更新）", () => {
    const { blueprint, state } = setup();
    const moved = performOk(blueprint, state, moveTo("loc_b"));
    const snapshot = JSON.parse(JSON.stringify(moved));
    reconcileQuests(blueprint, moved, deps);
    expect(JSON.parse(JSON.stringify(moved))).toEqual(snapshot);
  });

  it("对 reconcile 结果再次 reconcile 幂等：零事件、原样返回", () => {
    const { blueprint, state } = setup();
    const moved = performOk(blueprint, state, moveTo("loc_b"));
    const first = reconcileQuests(blueprint, moved, deps);
    const second = reconcileQuests(blueprint, first.state, deps);
    expect(second.events).toEqual([]);
    expect(second.state).toBe(first.state);
  });

  it("重复移动不重复完成任务、不重复解锁", () => {
    const { blueprint, state } = setup();
    const first = reconcileQuests(blueprint, performOk(blueprint, state, moveTo("loc_b")), deps);
    const back = performOk(blueprint, first.state, moveTo("loc_a"));
    const again = performOk(blueprint, back, moveTo("loc_b"));
    const result = reconcileQuests(blueprint, again, deps);
    expect(result.events).toEqual([]);
    expect(questStatus(result.state, "m1")).toBe("completed");
    expect(questStatus(result.state, "m2")).toBe("active");
  });
});

describe("reconcileQuests：talk / discover objective", () => {
  it("talk objective 满足后任务完成并解锁后续", () => {
    // 变体：m2 只需与铁剑庄主交谈（去掉 Phase 4 未支持的 obtain_item）。
    const { blueprint, state } = setup(
      withQuest(makeValidCandidate(), "m2", {
        objectives: [{ kind: "talk_to_npc", npcId: "npc_c" }]
      })
    );
    const unlocked = reconcileQuests(
      blueprint,
      performOk(blueprint, state, moveTo("loc_b")),
      deps
    );
    const atLocC = performOk(blueprint, unlocked.state, moveTo("loc_c"));
    const talked = performOk(blueprint, atLocC, talkTo("npc_c"));
    const result = reconcileQuests(blueprint, talked, deps);

    expect(questStatus(result.state, "m2")).toBe("completed");
    expect(questStatus(result.state, "m3")).toBe("active");
    expect(result.events).toEqual([
      { type: "quest_completed", questId: asQuestId("m2"), occurredAt: FIXED_TIME },
      { type: "quest_unlocked", questId: asQuestId("m3"), occurredAt: FIXED_TIME }
    ]);

    // m3 仅含 defeat_enemy（未支持）：再次 reconcile 保持 active、零事件。
    const settled = reconcileQuests(blueprint, result.state, deps);
    expect(settled.events).toEqual([]);
    expect(questStatus(settled.state, "m3")).toBe("active");
  });

  it("discover objective 满足后支线完成；closed outcome 标记为 closed 且无解锁", () => {
    const { blueprint, state } = setup();
    const unlocked = reconcileQuests(
      blueprint,
      performOk(blueprint, state, moveTo("loc_b")),
      deps
    );
    const backHome = performOk(blueprint, unlocked.state, moveTo("loc_a"));
    const discovered = performOk(blueprint, backHome, investigate("fact_b"));
    const result = reconcileQuests(blueprint, discovered, deps);

    expect(questStatus(result.state, "s1")).toBe("closed");
    expect(result.events).toEqual([
      { type: "quest_completed", questId: asQuestId("s1"), occurredAt: FIXED_TIME }
    ]);
  });

  it("解锁时已发生的事实立即核验：同一次 reconcile 内级联完成", () => {
    // 先在开场地点调查出 fact_b（s1 仍 locked），再移动触发 m1 完成。
    const { blueprint, state } = setup();
    const discovered = performOk(blueprint, state, investigate("fact_b"));
    const moved = performOk(blueprint, discovered, moveTo("loc_b"));
    const result = reconcileQuests(blueprint, moved, deps);

    expect(questStatus(result.state, "m1")).toBe("completed");
    expect(questStatus(result.state, "m2")).toBe("active");
    expect(questStatus(result.state, "s1")).toBe("closed");
    expect(result.events).toEqual([
      { type: "quest_completed", questId: asQuestId("m1"), occurredAt: FIXED_TIME },
      { type: "quest_unlocked", questId: asQuestId("m2"), occurredAt: FIXED_TIME },
      { type: "quest_unlocked", questId: asQuestId("s1"), occurredAt: FIXED_TIME },
      { type: "quest_completed", questId: asQuestId("s1"), occurredAt: FIXED_TIME }
    ]);
  });
});

describe("reconcileQuests：多 objective 与未支持 objective", () => {
  it("多 objective 未全部满足时保持 active，全部满足才完成", () => {
    // 变体：m2 需要交谈 + 到访断魂崖（两个已支持 objective）。
    const { blueprint, state } = setup(
      withQuest(makeValidCandidate(), "m2", {
        objectives: [
          { kind: "talk_to_npc", npcId: "npc_c" },
          { kind: "visit_location", locationId: "loc_d" }
        ]
      })
    );
    const unlocked = reconcileQuests(
      blueprint,
      performOk(blueprint, state, moveTo("loc_b")),
      deps
    );
    const atLocC = performOk(blueprint, unlocked.state, moveTo("loc_c"));
    const talked = performOk(blueprint, atLocC, talkTo("npc_c"));

    const partial = reconcileQuests(blueprint, talked, deps);
    expect(partial.events).toEqual([]);
    expect(questStatus(partial.state, "m2")).toBe("active");

    const atLocD = performOk(blueprint, partial.state, moveTo("loc_d"));
    const full = reconcileQuests(blueprint, atLocD, deps);
    expect(questStatus(full.state, "m2")).toBe("completed");
    expect(questStatus(full.state, "m3")).toBe("active");
  });

  it("含 obtain_item 的任务只完成交谈时保持 active（不得绕过未取得的物品）", () => {
    // 默认 fixture 的 m2 = talk npc_c + obtain item_b（后者尚未取得）。
    const { blueprint, state } = setup();
    const unlocked = reconcileQuests(
      blueprint,
      performOk(blueprint, state, moveTo("loc_b")),
      deps
    );
    const atLocC = performOk(blueprint, unlocked.state, moveTo("loc_c"));
    const talked = performOk(blueprint, atLocC, talkTo("npc_c"));
    const result = reconcileQuests(blueprint, talked, deps);

    expect(result.events).toEqual([]);
    expect(questStatus(result.state, "m2")).toBe("active");
    expect(result.state).toBe(talked);
  });
});

describe("reconcileQuests：obtain_item objective 与 stage 2（Phase 5）", () => {
  /** 推进到 m2 已解锁且人在铁剑山庄（item_b 预置地）的基准状态。 */
  function setupAtLocC(): { blueprint: ScenarioBlueprint; state: GameState } {
    const { blueprint, state } = setup();
    const unlocked = reconcileQuests(
      blueprint,
      performOk(blueprint, state, moveTo("loc_b")),
      deps
    );
    return { blueprint, state: performOk(blueprint, unlocked.state, moveTo("loc_c")) };
  }

  it("isQuestObjectiveSatisfied：obtain_item 读背包 ID，defeat_enemy 仍不支持", () => {
    const { state } = setup();
    // 初始背包含 item_a（startingItemIds），不含 item_b。
    expect(
      isQuestObjectiveSatisfied(state, { kind: "obtain_item", itemId: asItemId("item_a") })
    ).toBe(true);
    expect(
      isQuestObjectiveSatisfied(state, { kind: "obtain_item", itemId: asItemId("item_b") })
    ).toBe(false);
    expect(
      isQuestObjectiveSatisfied(state, { kind: "defeat_enemy", enemyId: asEnemyId("enemy_b") })
    ).toBe(false);
  });

  it("先交谈后取得：m2 完成并解锁 m3，事件恰好各一条", () => {
    const { blueprint, state } = setupAtLocC();
    const talked = performOk(blueprint, state, talkTo("npc_c"));
    const taken = performOk(blueprint, talked, takeItem("item_b"));
    const result = reconcileQuests(blueprint, taken, deps);

    expect(questStatus(result.state, "m2")).toBe("completed");
    expect(questStatus(result.state, "m3")).toBe("active");
    expect(result.events).toEqual([
      { type: "quest_completed", questId: asQuestId("m2"), occurredAt: FIXED_TIME },
      { type: "quest_unlocked", questId: asQuestId("m3"), occurredAt: FIXED_TIME }
    ]);
  });

  it("先取得后交谈：任意顺序均完成 stage 2", () => {
    const { blueprint, state } = setupAtLocC();
    const taken = performOk(blueprint, state, takeItem("item_b"));
    // 只取得未交谈：m2 保持 active，零事件、原样返回。
    const partial = reconcileQuests(blueprint, taken, deps);
    expect(partial.events).toEqual([]);
    expect(questStatus(partial.state, "m2")).toBe("active");
    expect(partial.state).toBe(taken);

    const talked = performOk(blueprint, partial.state, talkTo("npc_c"));
    const result = reconcileQuests(blueprint, talked, deps);
    expect(questStatus(result.state, "m2")).toBe("completed");
    expect(questStatus(result.state, "m3")).toBe("active");
    expect(result.events).toEqual([
      { type: "quest_completed", questId: asQuestId("m2"), occurredAt: FIXED_TIME },
      { type: "quest_unlocked", questId: asQuestId("m3"), occurredAt: FIXED_TIME }
    ]);
  });

  it("完成与解锁只发生一次：重复 reconcile 幂等", () => {
    const { blueprint, state } = setupAtLocC();
    const talked = performOk(blueprint, state, talkTo("npc_c"));
    const taken = performOk(blueprint, talked, takeItem("item_b"));
    const first = reconcileQuests(blueprint, taken, deps);
    const second = reconcileQuests(blueprint, first.state, deps);

    expect(second.events).toEqual([]);
    expect(second.state).toBe(first.state);
    expect(
      first.state.eventLedger.filter(
        (e) => e.type === "quest_completed" && e.questId === asQuestId("m2")
      )
    ).toHaveLength(1);
    expect(
      first.state.eventLedger.filter(
        (e) => e.type === "quest_unlocked" && e.questId === asQuestId("m3")
      )
    ).toHaveLength(1);
  });
});

describe("非法/不可达蓝图仍被 Phase 1 图校验拒绝（quests 模块只接受已编译蓝图）", () => {
  it("悬空解锁目标在 validate 阶段即被拒绝，永远到不了 reconcile", () => {
    const candidate = withQuest(makeValidCandidate(), "m1", {
      onSuccess: { kind: "unlock_quests", questIds: ["m2", "s1", "ghost"] }
    });
    const validation = validateScenarioBlueprintCandidate(candidate, { profile: TEST_PROFILE });
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.issues.map((issue) => issue.code)).toContain("DANGLING_QUEST_REF");
    }
  });

  it("使结局不可达的任务图在 validate 阶段即被拒绝", () => {
    // m2 直接 closed：m3 不可达 → 两个结局全部不可达。
    const candidate = withQuest(makeValidCandidate(), "m2", {
      onSuccess: { kind: "closed" }
    });
    const validation = validateScenarioBlueprintCandidate(candidate, { profile: TEST_PROFILE });
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.issues.map((issue) => issue.code)).toContain("UNREACHABLE_ENDING");
    }
  });

  it("类型层面：未编译候选不能直接传入 reconcileQuests", () => {
    const { state } = setup();
    const candidate = makeValidCandidate();
    const call = (): unknown =>
      // @ts-expect-error 只有编译品牌化后的 ScenarioBlueprint 才能进入任务 reconciliation
      reconcileQuests(candidate, state, deps);
    expect(call).toBeDefined();
  });
});
