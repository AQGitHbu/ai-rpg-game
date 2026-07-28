import { describe, expect, it } from "vitest";
import {
  asEnemyId,
  asItemId,
  asLocationId,
  asQuestId,
  type GameState,
  type ScenarioBlueprint,
  type ScenarioBlueprintCandidate,
} from "@/game/domain";
import {
  resolveAction,
  type PlayerIntent,
} from "../actions";
import {
  compileScenarioBlueprint,
  initializeGameState,
  validateScenarioBlueprintCandidate,
} from "../scenario";
import { makeValidCandidate, TEST_PROFILE } from "../scenario/scenarioBlueprintFixture.testutil";
import { reconcileQuests, failQuest, isQuestObjectiveSatisfied } from "../quests";
import { startBattle, battleAction } from "./index";

// ---------------------------------------------------------------------------
// 测试走真实管线：候选 → validate → compile → initializeGameState → resolveAction
//   → reconcileQuests，保证 battle facade 消费的正是真实管线产出的 state。
//
// fixture 任务图（scenarioBlueprintFixture.testutil.ts）：
//   m1(主线1, visit loc_b)              --成功--> 解锁 m2 + s1
//   m2(主线2, talk npc_c + obtain item) --成功--> 解锁 m3
//   m3(主线3, defeat enemy_b)           --成功--> e1 / --失败--> e2
//
// 玩家：hp 30, attack 6, defense 4
// Boss(enemy_b)：hp 20, attack 5, defense 2, locationId: loc_d
//
// 伤害计算：
//   attack → 玩家伤害 max(1, 6-2)=4；敌人反击 max(1, 5-4)=1
//   guard  → 不造成敌伤；反击 max(1, 5-4-2)=max(1,-1)=1
//   5 次 attack 可击杀 boss（20/4=5），玩家受 4 点反击伤害（第5回合无反击）
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

/** 执行必须成功的行动，返回 next state。 */
function performOk(blueprint: ScenarioBlueprint, state: GameState, intent: PlayerIntent): GameState {
  const result = resolveAction(blueprint, state, intent, deps);
  if (!result.ok) throw new Error(`行动应当成功，实际被拒绝：${result.code}`);
  return result.state;
}

const moveTo = (locationId: string): PlayerIntent => ({
  type: "move",
  locationId: asLocationId(locationId),
});
const talkTo = (npcId: string): PlayerIntent => ({ type: "talk", npcId: npcId as never });
const takeItem = (itemId: string): PlayerIntent => ({ type: "take_item", itemId: itemId as never });

// 前进到 stage 3 在 boss 地点（loc_d）的基准状态。
function setupAtBossLocation(): { blueprint: ScenarioBlueprint; state: GameState } {
  const { blueprint, state } = setup();
  // m1: move to loc_b → complete → unlock m2 + s1
  const moved1 = performOk(blueprint, state, moveTo("loc_b"));
  const unlocked = reconcileQuests(blueprint, moved1, deps);
  // m2: move to loc_c → talk npc_c → take item_b → complete → unlock m3
  const moved2 = performOk(blueprint, unlocked.state, moveTo("loc_c"));
  const talked = performOk(blueprint, moved2, talkTo("npc_c"));
  const taken = performOk(blueprint, talked, takeItem("item_b"));
  const unlocked2 = reconcileQuests(blueprint, taken, deps);
  // m3 active, move to loc_d (boss location)
  const moved3 = performOk(blueprint, unlocked2.state, moveTo("loc_d"));
  return { blueprint, state: moved3 };
}

const ENEMY_B = asEnemyId("enemy_b");

// ===========================================================================
// startBattle
// ===========================================================================

describe("startBattle：合法开始", () => {
  it("玩家在 boss 地点、stage 3 active、battle idle → 成功开始战斗", () => {
    const { blueprint, state } = setupAtBossLocation();
    const snapshot = JSON.stringify(state);
    const result = startBattle(blueprint, state, ENEMY_B, deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.battle.status).toBe("active");
      if (result.state.battle.status === "active") {
        expect(result.state.battle.enemyId).toBe(ENEMY_B);
        expect(result.state.battle.playerHp).toBe(30);
        expect(result.state.battle.enemyHp).toBe(20);
        expect(result.state.battle.round).toBe(1);
      }
      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toEqual({
        type: "battle_started",
        enemyId: ENEMY_B,
        occurredAt: FIXED_TIME,
      });
      expect(result.state.eventLedger).toHaveLength(state.eventLedger.length + 1);
      expect(result.state.eventLedger[state.eventLedger.length]).toEqual(result.events[0]);
      expect(result.feedback.message).toBeTruthy();
    }
    expect(JSON.stringify(state)).toBe(snapshot);
  });

  it("是纯函数：相同输入产出相同结果", () => {
    const { blueprint, state } = setupAtBossLocation();
    const r1 = startBattle(blueprint, state, ENEMY_B, deps);
    const r2 = startBattle(blueprint, state, ENEMY_B, deps);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });
});

describe("startBattle：拒绝与零写入", () => {
  it("已有 active battle 时拒绝 (BATTLE_ALREADY_ACTIVE)", () => {
    const { blueprint, state } = setupAtBossLocation();
    const started = startBattle(blueprint, state, ENEMY_B, deps);
    if (!started.ok) throw new Error("前置 startBattle 应当成功");
    const result = startBattle(blueprint, started.state, ENEMY_B, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("BATTLE_ALREADY_ACTIVE");
      expect(result.feedback.message).toBeTruthy();
    }
  });

  it("结局已抵达时拒绝 (ENDING_REACHED)", () => {
    const { blueprint, state } = setupAtBossLocation();
    const endedState: GameState = {
      ...state,
      ending: { endingId: "e1" as never, outcome: "success" },
    };
    const result = startBattle(blueprint, endedState, ENEMY_B, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("ENDING_REACHED");
    }
  });

  it("玩家不在敌人地点时拒绝 (ENEMY_NOT_AT_LOCATION)", () => {
    const { blueprint, state } = setupAtBossLocation();
    const movedAway: GameState = { ...state, currentLocationId: asLocationId("loc_c") };
    const result = startBattle(blueprint, movedAway, ENEMY_B, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("ENEMY_NOT_AT_LOCATION");
    }
  });

  it("未知敌人拒绝 (UNKNOWN_ENEMY)", () => {
    const { blueprint, state } = setupAtBossLocation();
    const result = startBattle(blueprint, state, asEnemyId("ghost"), deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("UNKNOWN_ENEMY");
    }
  });

  it("敌人不是 active stage 3 的 defeat_enemy 目标时拒绝 (ENEMY_NOT_STAGE3_TARGET)", () => {
    const { blueprint, state } = setup();
    // 移动到 loc_b（enemy_a 的位置），但 stage 3 仍为 locked
    const moved = performOk(blueprint, state, moveTo("loc_b"));
    const result = startBattle(blueprint, moved, asEnemyId("enemy_a"), deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("ENEMY_NOT_STAGE3_TARGET");
    }
  });

  it("敌人已被击败时拒绝 (ENEMY_ALREADY_DEFEATED)", () => {
    const { blueprint, state } = setupAtBossLocation();
    const defeatedState: GameState = {
      ...state,
      defeatedEnemyIds: [ENEMY_B],
    };
    const result = startBattle(blueprint, defeatedState, ENEMY_B, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("ENEMY_ALREADY_DEFEATED");
    }
  });

  it("所有拒绝码零状态变化、不产生事件", () => {
    const { blueprint, state } = setupAtBossLocation();
    const cases = [
      { state, enemyId: asEnemyId("ghost"), code: "UNKNOWN_ENEMY" },
      { state: { ...state, currentLocationId: asLocationId("loc_c") }, enemyId: ENEMY_B, code: "ENEMY_NOT_AT_LOCATION" },
      { state: { ...state, ending: { endingId: "e1" as never, outcome: "success" as const } }, enemyId: ENEMY_B, code: "ENDING_REACHED" },
      { state: { ...state, defeatedEnemyIds: [ENEMY_B] }, enemyId: ENEMY_B, code: "ENEMY_ALREADY_DEFEATED" },
    ];
    for (const { state: s, enemyId, code } of cases) {
      const snapshot = JSON.stringify(s);
      const result = startBattle(blueprint, s, enemyId, deps);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(code);
        expect("state" in result).toBe(false);
      }
      expect(JSON.stringify(s)).toBe(snapshot);
    }
  });
});

// ===========================================================================
// battleAction
// ===========================================================================

describe("battleAction：attack", () => {
  it("attack 造成敌人伤害并承受反击，round 递增", () => {
    const { blueprint, state } = setupAtBossLocation();
    const started = startBattle(blueprint, state, ENEMY_B, deps);
    if (!started.ok) throw new Error("前置 startBattle 应当成功");

    const snapshot = JSON.stringify(started.state);
    const result = battleAction(blueprint, started.state, "attack", deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.battle.status).toBe("active");
      if (result.state.battle.status === "active") {
        expect(result.state.battle.enemyHp).toBe(16);
        expect(result.state.battle.playerHp).toBe(29);
        expect(result.state.battle.round).toBe(2);
      }
      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toMatchObject({
        type: "battle_round_resolved",
        enemyId: ENEMY_B,
        round: 1,
        playerHp: 29,
        enemyHp: 16,
        action: "attack",
        occurredAt: FIXED_TIME,
      });
    }
    expect(JSON.stringify(started.state)).toBe(snapshot);
  });

  it("attack 连续 5 回合击杀 boss → 胜利、无最终反击、enemy_defeated", () => {
    const { blueprint, state } = setupAtBossLocation();
    let st = startBattle(blueprint, state, ENEMY_B, deps);
    if (!st.ok) throw new Error("前置 startBattle 应当成功");
    let current = st.state;

    for (let i = 0; i < 4; i++) {
      const r = battleAction(blueprint, current, "attack", deps);
      if (!r.ok) throw new Error(`第 ${i + 1} 回合 attack 应当成功`);
      current = r.state;
    }

    const snapshot = JSON.stringify(current);
    const final = battleAction(blueprint, current, "attack", deps);
    expect(final.ok).toBe(true);
    if (final.ok) {
      expect(final.state.battle.status).toBe("resolved");
      if (final.state.battle.status === "resolved") {
        expect(final.state.battle.outcome).toBe("victory");
      }
      expect(final.events).toHaveLength(3);
      expect(final.events[0]).toMatchObject({ type: "battle_round_resolved", enemyHp: 0, playerHp: 26 });
      expect(final.events[1]).toMatchObject({ type: "battle_resolved", outcome: "victory" });
      expect(final.events[2]).toMatchObject({ type: "enemy_defeated", enemyId: ENEMY_B });
      expect(final.state.defeatedEnemyIds).toContain(ENEMY_B);
      expect(final.state.defeatedEnemyIds).toHaveLength(1);
    }
    expect(JSON.stringify(current)).toBe(snapshot);
  });
});

describe("battleAction：guard", () => {
  it("guard 不造成敌伤，反击伤害减 2（最低 1）", () => {
    const { blueprint, state } = setupAtBossLocation();
    const started = startBattle(blueprint, state, ENEMY_B, deps);
    if (!started.ok) throw new Error("前置 startBattle 应当成功");

    const result = battleAction(blueprint, started.state, "guard", deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.battle.status).toBe("active");
      if (result.state.battle.status === "active") {
        expect(result.state.battle.enemyHp).toBe(20);
        expect(result.state.battle.playerHp).toBe(29);
        expect(result.state.battle.round).toBe(2);
      }
      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toMatchObject({
        type: "battle_round_resolved",
        action: "guard",
        enemyHp: 20,
        playerHp: 29,
      });
    }
  });
});

describe("battleAction：withdraw", () => {
  it("withdraw 立即以失败结束战斗，无 round 事件", () => {
    const { blueprint, state } = setupAtBossLocation();
    const started = startBattle(blueprint, state, ENEMY_B, deps);
    if (!started.ok) throw new Error("前置 startBattle 应当成功");

    const snapshot = JSON.stringify(started.state);
    const result = battleAction(blueprint, started.state, "withdraw", deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.battle.status).toBe("resolved");
      if (result.state.battle.status === "resolved") {
        expect(result.state.battle.outcome).toBe("withdraw");
      }
      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toMatchObject({
        type: "battle_resolved",
        outcome: "withdraw",
      });
      expect(result.state.defeatedEnemyIds).not.toContain(ENEMY_B);
    }
    expect(JSON.stringify(started.state)).toBe(snapshot);
  });
});

describe("battleAction：拒绝与零写入", () => {
  it("无 active battle 时拒绝 (NO_ACTIVE_BATTLE)", () => {
    const { blueprint, state } = setupAtBossLocation();
    const result = battleAction(blueprint, state, "attack", deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("NO_ACTIVE_BATTLE");
      expect(result.feedback.message).toBeTruthy();
    }
  });

  it("resolved battle 后再操作拒绝 (NO_ACTIVE_BATTLE)", () => {
    const { blueprint, state } = setupAtBossLocation();
    const started = startBattle(blueprint, state, ENEMY_B, deps);
    if (!started.ok) throw new Error("前置 startBattle 应当成功");
    const resolved = battleAction(blueprint, started.state, "withdraw", deps);
    if (!resolved.ok) throw new Error("前置 withdraw 应当成功");

    const result = battleAction(blueprint, resolved.state, "attack", deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("NO_ACTIVE_BATTLE");
    }
  });

  it("所有拒绝码零状态变化、不产生事件", () => {
    const { blueprint, state } = setupAtBossLocation();
    const snapshot = JSON.stringify(state);
    const result = battleAction(blueprint, state, "attack", deps);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(state)).toBe(snapshot);
  });
});

describe("battle 不可变性", () => {
  it("startBattle 不修改输入蓝图和状态", () => {
    const { blueprint, state } = setupAtBossLocation();
    const bpSnapshot = JSON.stringify(blueprint);
    const stSnapshot = JSON.stringify(state);
    startBattle(blueprint, state, ENEMY_B, deps);
    expect(JSON.stringify(blueprint)).toBe(bpSnapshot);
    expect(JSON.stringify(state)).toBe(stSnapshot);
  });

  it("battleAction 不修改输入蓝图和状态", () => {
    const { blueprint, state } = setupAtBossLocation();
    const started = startBattle(blueprint, state, ENEMY_B, deps);
    if (!started.ok) throw new Error("前置 startBattle 应当成功");
    const bpSnapshot = JSON.stringify(blueprint);
    const stSnapshot = JSON.stringify(started.state);
    battleAction(blueprint, started.state, "attack", deps);
    expect(JSON.stringify(blueprint)).toBe(bpSnapshot);
    expect(JSON.stringify(started.state)).toBe(stSnapshot);
  });
});

describe("isQuestObjectiveSatisfied: defeat_enemy", () => {
  it("敌人未在 defeatedEnemyIds 中时返回 false", () => {
    const { state } = setup();
    expect(
      isQuestObjectiveSatisfied(state, { kind: "defeat_enemy", enemyId: ENEMY_B })
    ).toBe(false);
  });

  it("敌人在 defeatedEnemyIds 中时返回 true", () => {
    const { state } = setup();
    const defeatedState: GameState = {
      ...state,
      defeatedEnemyIds: [ENEMY_B],
    };
    expect(
      isQuestObjectiveSatisfied(defeatedState, { kind: "defeat_enemy", enemyId: ENEMY_B })
    ).toBe(true);
  });

  it("战斗胜利后 reconcileQuests 完成 stage 3", () => {
    const { blueprint, state } = setupAtBossLocation();
    let st = startBattle(blueprint, state, ENEMY_B, deps);
    if (!st.ok) throw new Error("前置 startBattle 应当成功");
    let current = st.state;
    for (let i = 0; i < 5; i++) {
      const r = battleAction(blueprint, current, "attack", deps);
      if (!r.ok) throw new Error(`第 ${i + 1} 回合 attack 应当成功`);
      current = r.state;
    }
    expect(current.battle.status).toBe("resolved");
    expect(current.defeatedEnemyIds).toContain(ENEMY_B);

    const result = reconcileQuests(blueprint, current, deps);
    const m3Status = result.state.quests.find((q) => q.questId === asQuestId("m3"))?.status;
    expect(m3Status).toBe("completed");
    expect(result.events).toContainEqual({
      type: "quest_completed",
      questId: asQuestId("m3"),
      occurredAt: FIXED_TIME,
    });
  });
});

describe("failQuest：stage 3 失败", () => {
  it("将 active quest 标记为 failed 并追加 quest_failed 事件", () => {
    const { blueprint, state } = setupAtBossLocation();
    const snapshot = JSON.stringify(state);

    const result = failQuest(blueprint, state, asQuestId("m3"), deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const m3Status = result.state.quests.find((q) => q.questId === asQuestId("m3"))?.status;
      expect(m3Status).toBe("failed");
      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toEqual({
        type: "quest_failed",
        questId: asQuestId("m3"),
        occurredAt: FIXED_TIME,
      });
      expect(result.state.eventLedger).toHaveLength(state.eventLedger.length + 1);
    }
    expect(JSON.stringify(state)).toBe(snapshot);
  });

  it("不修改输入状态（不可变更新）", () => {
    const { blueprint, state } = setupAtBossLocation();
    const snapshot = JSON.parse(JSON.stringify(state));
    failQuest(blueprint, state, asQuestId("m3"), deps);
    expect(JSON.parse(JSON.stringify(state))).toEqual(snapshot);
  });

  it("是纯函数：相同输入产出相同结果", () => {
    const { blueprint, state } = setupAtBossLocation();
    const r1 = failQuest(blueprint, state, asQuestId("m3"), deps);
    const r2 = failQuest(blueprint, state, asQuestId("m3"), deps);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });
});

describe("failQuest：拒绝与零写入", () => {
  it("locked quest 拒绝 (QUEST_NOT_ACTIVE)", () => {
    const { blueprint, state } = setup();
    const result = failQuest(blueprint, state, asQuestId("m3"), deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("QUEST_NOT_ACTIVE");
    }
  });

  it("已 failed 的 quest 再次失败拒绝 (QUEST_NOT_ACTIVE)", () => {
    const { blueprint, state } = setupAtBossLocation();
    const first = failQuest(blueprint, state, asQuestId("m3"), deps);
    if (!first.ok) throw new Error("前置 failQuest 应当成功");
    const second = failQuest(blueprint, first.state, asQuestId("m3"), deps);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.code).toBe("QUEST_NOT_ACTIVE");
    }
  });

  it("未知 quest 拒绝 (QUEST_NOT_FOUND)", () => {
    const { blueprint, state } = setupAtBossLocation();
    const result = failQuest(blueprint, state, asQuestId("ghost"), deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("QUEST_NOT_FOUND");
    }
  });

  it("所有拒绝码零状态变化、不产生事件", () => {
    const { blueprint, state } = setup();
    const snapshot = JSON.stringify(state);
    const result = failQuest(blueprint, state, asQuestId("m3"), deps);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(state)).toBe(snapshot);
  });
});

describe("failQuest：onFailure reach_ending 不伪造结局", () => {
  it("失败后只标记 failed，不写入 ending state", () => {
    const { blueprint, state } = setupAtBossLocation();
    const result = failQuest(blueprint, state, asQuestId("m3"), deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.ending).toBeNull();
      expect(result.events).toHaveLength(1);
      expect(result.events[0].type).toBe("quest_failed");
    }
  });
});

describe("完整战斗→胜利→任务完成流程", () => {
  it("startBattle → 5×attack → 胜利 → reconcileQuests 完成 m3", () => {
    const { blueprint, state } = setupAtBossLocation();

    let st = startBattle(blueprint, state, ENEMY_B, deps);
    if (!st.ok) throw new Error("startBattle 应当成功");
    let current = st.state;

    for (let i = 0; i < 5; i++) {
      const r = battleAction(blueprint, current, "attack", deps);
      if (!r.ok) throw new Error(`第 ${i + 1} 回合 attack 应当成功`);
      current = r.state;
    }

    expect(current.battle.status).toBe("resolved");
    if (current.battle.status === "resolved") {
      expect(current.battle.outcome).toBe("victory");
    }
    expect(current.defeatedEnemyIds).toContain(ENEMY_B);

    const result = reconcileQuests(blueprint, current, deps);
    const m3Status = result.state.quests.find((q) => q.questId === asQuestId("m3"))?.status;
    expect(m3Status).toBe("completed");
  });
});

describe("完整战斗→撤退→任务失败流程", () => {
  it("startBattle → withdraw → failQuest 标记 m3 failed", () => {
    const { blueprint, state } = setupAtBossLocation();

    const st = startBattle(blueprint, state, ENEMY_B, deps);
    if (!st.ok) throw new Error("startBattle 应当成功");

    const wd = battleAction(blueprint, st.state, "withdraw", deps);
    if (!wd.ok) throw new Error("withdraw 应当成功");
    expect(wd.state.battle.status).toBe("resolved");
    if (wd.state.battle.status === "resolved") {
      expect(wd.state.battle.outcome).toBe("withdraw");
    }
    expect(wd.state.defeatedEnemyIds).not.toContain(ENEMY_B);

    const fq = failQuest(blueprint, wd.state, asQuestId("m3"), deps);
    if (!fq.ok) throw new Error("failQuest 应当成功");
    const m3Status = fq.state.quests.find((q) => q.questId === asQuestId("m3"))?.status;
    expect(m3Status).toBe("failed");
    expect(fq.state.ending).toBeNull();
  });
});