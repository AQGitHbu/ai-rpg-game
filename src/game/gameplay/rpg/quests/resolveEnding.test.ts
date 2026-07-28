import { describe, expect, it } from "vitest";
import {
  asEndingId,
  asEnemyId,
  asQuestId,
  type GameState,
  type ScenarioBlueprint,
  type ScenarioBlueprintCandidate,
} from "@/game/domain";
import {
  compileScenarioBlueprint,
  initializeGameState,
  validateScenarioBlueprintCandidate,
} from "../scenario";
import { makeValidCandidate, TEST_PROFILE } from "../scenario/scenarioBlueprintFixture.testutil";
import { resolveEnding, failQuest, reconcileQuests } from "./index";

// ---------------------------------------------------------------------------
// Phase 6 Task 3a：ending resolver 纯函数测试。
//
// fixture 任务图（scenarioBlueprintFixture.testutil.ts）：
//   m3(主线3, defeat enemy_b) --成功--> reach_ending e1 / --失败--> reach_ending e2
//   e1: requirements [{ quest_completed, m3 }]
//   e2: requirements [{ quest_failed, m3 }]
//
// ending resolver 在 quest reconciliation/failure 之后运行：
//   - 检查所有结局的 requirements；
//   - quest_completed → quest status 为 completed 或 closed；
//   - quest_failed → quest status 为 failed；
//   - 全部满足时写入 ending runtime state + ending_reached 事件；
//   - ending 只能写入一次（幂等）。
// ---------------------------------------------------------------------------

const FIXED_TIME = "2026-07-27T12:00:00Z";
const deps = { now: () => FIXED_TIME };

function compileFrom(candidate: ScenarioBlueprintCandidate = makeValidCandidate()) {
  const compiled = compileScenarioBlueprint(
    validateScenarioBlueprintCandidate(candidate, { profile: TEST_PROFILE })
  );
  if (!compiled.ok) {
    throw new Error(`fixture 蓝图应当合法：${JSON.stringify(compiled.issues)}`);
  }
  return compiled.blueprint;
}

function setup() {
  const blueprint = compileFrom();
  return { blueprint, state: initializeGameState(blueprint) };
}

/** 构造 stage 3 active 且 boss 已被击败的状态：模拟胜利后的 state。 */
function setupVictoryState(): { blueprint: ScenarioBlueprint; state: GameState } {
  const { blueprint, state } = setup();
  // 手动构造 stage 3 active + boss defeated 的 state
  const m3Id = asQuestId("m3");
  const stage3ActiveState: GameState = {
    ...state,
    quests: state.quests.map((q) =>
      q.questId === m3Id ? { ...q, status: "active" } : q
    ),
    defeatedEnemyIds: [asEnemyId("enemy_b")],
  };
  // 用 reconcileQuests 让 m3 completed
  const reconciled = reconcileQuests(blueprint, stage3ActiveState, deps);
  return { blueprint, state: reconciled.state };
}

/** 构造 stage 3 failed 的状态：模拟失败后的 state。 */
function setupFailureState(): { blueprint: ScenarioBlueprint; state: GameState } {
  const { blueprint, state } = setup();
  const m3Id = asQuestId("m3");
  const stage3ActiveState: GameState = {
    ...state,
    quests: state.quests.map((q) =>
      q.questId === m3Id ? { ...q, status: "active" } : q
    ),
  };
  const failed = failQuest(blueprint, stage3ActiveState, m3Id, deps);
  if (!failed.ok) throw new Error("前置 failQuest 应当成功");
  return { blueprint, state: failed.state };
}

describe("resolveEnding：成功结局", () => {
  it("m3 completed → e1 结局写入 success outcome + ending_reached 事件", () => {
    const { blueprint, state } = setupVictoryState();

    const result = resolveEnding(blueprint, state, deps);

    expect(result.state.ending).toEqual({
      endingId: asEndingId("e1"),
      outcome: "success",
    });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toEqual({
      type: "ending_reached",
      endingId: asEndingId("e1"),
      outcome: "success",
      occurredAt: FIXED_TIME,
    });
    expect(result.state.eventLedger).toHaveLength(state.eventLedger.length + 1);
    expect(result.state.eventLedger[state.eventLedger.length]).toEqual(result.events[0]);
  });
});

describe("resolveEnding：失败结局", () => {
  it("m3 failed → e2 结局写入 failure outcome + ending_reached 事件", () => {
    const { blueprint, state } = setupFailureState();

    const result = resolveEnding(blueprint, state, deps);

    expect(result.state.ending).toEqual({
      endingId: asEndingId("e2"),
      outcome: "failure",
    });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toEqual({
      type: "ending_reached",
      endingId: asEndingId("e2"),
      outcome: "failure",
      occurredAt: FIXED_TIME,
    });
  });
});

describe("resolveEnding：幂等性", () => {
  it("已有 ending 时不重复写入（幂等）", () => {
    const { blueprint, state } = setupVictoryState();
    const first = resolveEnding(blueprint, state, deps);
    expect(first.state.ending).not.toBeNull();

    const second = resolveEnding(blueprint, first.state, deps);
    expect(second.state).toEqual(first.state);
    expect(second.events).toHaveLength(0);
  });

  it("无结局条件满足时返回原 state + 空事件", () => {
    const { blueprint, state } = setup();
    const result = resolveEnding(blueprint, state, deps);
    expect(result.state).toBe(state);
    expect(result.events).toHaveLength(0);
    expect(result.state.ending).toBeNull();
  });
});

describe("resolveEnding：不可变性", () => {
  it("不修改输入蓝图和状态", () => {
    const { blueprint, state } = setupVictoryState();
    const bpSnapshot = JSON.stringify(blueprint);
    const stSnapshot = JSON.stringify(state);
    resolveEnding(blueprint, state, deps);
    expect(JSON.stringify(blueprint)).toBe(bpSnapshot);
    expect(JSON.stringify(state)).toBe(stSnapshot);
  });

  it("是纯函数：相同输入产出相同结果", () => {
    const { blueprint, state } = setupVictoryState();
    const r1 = resolveEnding(blueprint, state, deps);
    const r2 = resolveEnding(blueprint, state, deps);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });
});

describe("resolveEnding：requirement 类型覆盖", () => {
  it("quest_completed 对 closed 状态也满足", () => {
    const { blueprint, state } = setup();
    // 手动构造 m3 closed 状态
    const m3Id = asQuestId("m3");
    const closedState: GameState = {
      ...state,
      quests: state.quests.map((q) =>
        q.questId === m3Id ? { ...q, status: "closed" } : q
      ),
    };

    const result = resolveEnding(blueprint, closedState, deps);
    // e1 requires quest_completed m3 → closed 也满足
    expect(result.state.ending?.endingId).toBe(asEndingId("e1"));
    expect(result.state.ending?.outcome).toBe("success");
  });

  it("fact_discovered requirement 也被检查", () => {
    // 构造一个自定义蓝图：结局依赖 fact_discovered
    const baseCandidate = makeValidCandidate();
    const candidate: ScenarioBlueprintCandidate = {
      ...baseCandidate,
      endings: [
        {
          id: "e1",
          name: "线索结局",
          description: "通过发现线索达成的结局。",
          requirements: [{ kind: "fact_discovered", factId: "fact_b" }],
        },
        {
          id: "e2",
          name: "另一个结局",
          description: "另一个结局。",
          requirements: [{ kind: "quest_completed", questId: "m3" }],
        },
      ],
    };
    const blueprint = compileFrom(candidate);
    const state = initializeGameState(blueprint);

    // fact_b 在初始状态中是 undiscovered（生成型事实）
    const result = resolveEnding(blueprint, state, deps);
    expect(result.state.ending).toBeNull();

    // 发现 fact_b 后触发结局
    const discoveredState: GameState = {
      ...state,
      worldFacts: state.worldFacts.map((f) =>
        f.factId === ("fact_b" as never) ? { ...f, discovered: true } : f
      ),
    };
    const result2 = resolveEnding(blueprint, discoveredState, deps);
    expect(result2.state.ending?.endingId).toBe(asEndingId("e1"));
  });

  it("多个 requirement 需全部满足", () => {
    // 构造一个结局需要 m3 completed + fact_b discovered
    const baseCandidate = makeValidCandidate();
    const candidate: ScenarioBlueprintCandidate = {
      ...baseCandidate,
      endings: [
        {
          id: "e1",
          name: "复合结局",
          description: "需要任务完成和线索发现。",
          requirements: [
            { kind: "quest_completed", questId: "m3" },
            { kind: "fact_discovered", factId: "fact_b" },
          ],
        },
        {
          id: "e2",
          name: "另一个结局",
          description: "另一个结局。",
          requirements: [{ kind: "quest_failed", questId: "m3" }],
        },
      ],
    };
    const blueprint = compileFrom(candidate);
    const state = initializeGameState(blueprint);

    // 只有 m3 completed，fact_b 未发现 → 不触发
    const m3Id = asQuestId("m3");
    const completedState: GameState = {
      ...state,
      quests: state.quests.map((q) =>
        q.questId === m3Id ? { ...q, status: "completed" } : q
      ),
    };
    const result1 = resolveEnding(blueprint, completedState, deps);
    expect(result1.state.ending).toBeNull();

    // 同时满足两个 requirement → 触发
    const bothState: GameState = {
      ...completedState,
      worldFacts: completedState.worldFacts.map((f) =>
        f.factId === ("fact_b" as never) ? { ...f, discovered: true } : f
      ),
    };
    const result2 = resolveEnding(blueprint, bothState, deps);
    expect(result2.state.ending?.endingId).toBe(asEndingId("e1"));
  });
});

describe("resolveEnding：结局优先级", () => {
  it("按蓝图 endings 顺序，第一个满足条件的结局被写入", () => {
    // 构造两个结局都能满足的状态
    const baseCandidate = makeValidCandidate();
    const candidate: ScenarioBlueprintCandidate = {
      ...baseCandidate,
      endings: [
        {
          id: "e1",
          name: "结局一",
          description: "需要 m3 completed。",
          requirements: [{ kind: "quest_completed", questId: "m3" }],
        },
        {
          id: "e2",
          name: "结局二",
          description: "也需要 m3 completed。",
          requirements: [{ kind: "quest_completed", questId: "m3" }],
        },
      ],
    };
    const blueprint = compileFrom(candidate);
    const state = initializeGameState(blueprint);

    const m3Id = asQuestId("m3");
    const completedState: GameState = {
      ...state,
      quests: state.quests.map((q) =>
        q.questId === m3Id ? { ...q, status: "completed" } : q
      ),
    };

    const result = resolveEnding(blueprint, completedState, deps);
    expect(result.state.ending?.endingId).toBe(asEndingId("e1"));
  });
});
