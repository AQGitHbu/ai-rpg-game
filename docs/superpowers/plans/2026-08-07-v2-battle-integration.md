# V2 战斗接入实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 V1 战斗系统（startBattle + battleAction）适配到 V2 `WorldState` 类型，接入 V2 规则引擎的 `validateAction` 和 `resolveByType`，替换当前的 `BATTLE_NOT_AVAILABLE` 桩。

**Architecture:** V2 `WorldState` 已包含 `battle: BattleState`、`enemies: readonly EnemyEntry[]`、`defeatedEnemyIds: readonly EnemyId[]`、`player.stats`——无需扩展状态模型。V1 战斗逻辑是纯函数，适配工作主要是类型签名迁移和 V1 stage-3 目标检查的简化。战斗事件（`battle_started`/`battle_round_resolved`/`battle_resolved`/`enemy_defeated`）已在 `events.ts` 中定义，无需新增。

**Tech Stack:** TypeScript, Vitest

**Spec:** `docs/superpowers/specs/2026-08-07-ai-rpg-architecture-redesign-spec.md` §5.4（规则与 AI 职责边界——战斗）

## Global Constraints

- 纯 domain/gameplay 层纯函数，零 IO、零 AI、零 DB、零随机数
- V2 `WorldState` 已有战斗字段，不扩展状态模型
- V1 战斗文件（`src/game/gameplay/rpg/battle/`）保持不动——V2 在 `ruleEngine/` 内新建独立实现
- V2 Action 用 `"flee"`，V1 事件 outcome 用 `"withdraw"`——在 resolver 内映射
- TDD：每个 task 以失败测试开始

---

## File Structure

### 新建文件

```
src/game/gameplay/rpg/ruleEngine/
  battleResolver.ts       # V2 战斗纯函数：startBattleV2 + battleActionV2，操作 WorldState
  battleResolver.test.ts  # 完整覆盖：开始战斗、攻击/防御/逃跑、胜利/失败/撤退
```

### 修改文件

```
src/game/gameplay/rpg/ruleEngine/validateAction.ts    # attack/battle_action 从 BATTLE_NOT_AVAILABLE 改为真实校验
src/game/gameplay/rpg/ruleEngine/validateAction.test.ts  # 补充战斗校验测试
src/game/gameplay/rpg/ruleEngine/resolveByType.ts     # 新增 attack/battle_action 分支
src/game/gameplay/rpg/ruleEngine/resolveByType.test.ts   # 补充战斗 resolve 测试
```

---

## Task 1: V2 战斗纯函数（startBattleV2 + battleActionV2）

**Files:**
- Create: `src/game/gameplay/rpg/ruleEngine/battleResolver.ts`
- Test: `src/game/gameplay/rpg/ruleEngine/battleResolver.test.ts`

**Interfaces:**
- Consumes: `WorldState` from `@/game/domain/worldState`, `Action` from `@/game/domain/action`, `GameEvent` from `@/game/domain/events`, `ResolveDeps` from `./resolveByType`
- Produces: `startBattleV2()`, `battleActionV2()` — 返回与 `resolveByType` 的 `ResolveResult` 兼容的类型

- [ ] **Step 1: Write failing tests for startBattleV2**

```typescript
// src/game/gameplay/rpg/ruleEngine/battleResolver.test.ts
import { describe, it, expect } from "vitest";
import { startBattleV2, battleActionV2 } from "./battleResolver";
import { createInitialWorldState, appendEnemy, type WorldState, type EnemyEntry } from "@/game/domain/worldState";
import { asEnemyId, asLocationId, asGenerationId } from "@/game/domain/scenarioBlueprint";
import type { EnemyId } from "@/game/domain/scenarioBlueprint";

const FIXED_TIME = "2026-08-07T12:00:00Z";
const deps = { now: () => FIXED_TIME };

function makeWorldWithEnemy(): WorldState {
  const loc = asLocationId("loc_1");
  let ws = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "侠客", identity: "剑客", stats: { hp: 30, attack: 6, defense: 4 } },
    startingLocation: {
      id: loc, name: "荒野", description: "test", kind: "main",
      connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
    },
    startingItemIds: [],
  });
  const enemy: EnemyEntry = {
    id: asEnemyId("enemy_1"),
    name: "山贼",
    tier: "boss",
    stats: { hp: 20, attack: 5, defense: 2 },
    locationId: loc,
    tags: [],
  };
  return appendEnemy(ws, enemy);
}

describe("startBattleV2", () => {
  it("starts battle when enemy exists at player location and no active battle", () => {
    const ws = makeWorldWithEnemy();
    const result = startBattleV2(ws, asEnemyId("enemy_1"), deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextWorldState.battle.status).toBe("active");
      expect(result.nextWorldState.battle.enemyId).toBe(asEnemyId("enemy_1"));
      expect(result.nextWorldState.battle.playerHp).toBe(30);
      expect(result.nextWorldState.battle.enemyHp).toBe(20);
      expect(result.nextWorldState.battle.round).toBe(1);
      expect(result.events[0]?.type).toBe("battle_started");
      expect(result.status).toBe("success");
    }
  });

  it("rejects when enemy does not exist", () => {
    const ws = makeWorldWithEnemy();
    const result = startBattleV2(ws, asEnemyId("nonexistent"), deps);
    expect(result.ok).toBe(false);
  });

  it("rejects when player not at enemy location", () => {
    const ws = makeWorldWithEnemy();
    // Move player to a different location
    const ws2: WorldState = { ...ws, currentLocationId: asLocationId("loc_elsewhere") };
    const result = startBattleV2(ws2, asEnemyId("enemy_1"), deps);
    expect(result.ok).toBe(false);
  });

  it("rejects when battle already active", () => {
    const ws = makeWorldWithEnemy();
    const started = startBattleV2(ws, asEnemyId("enemy_1"), deps);
    if (!started.ok) throw new Error("setup failed");
    const result = startBattleV2(started.nextWorldState, asEnemyId("enemy_1"), deps);
    expect(result.ok).toBe(false);
  });

  it("rejects when enemy already defeated", () => {
    const ws = makeWorldWithEnemy();
    const ws2: WorldState = { ...ws, defeatedEnemyIds: [asEnemyId("enemy_1")] };
    const result = startBattleV2(ws2, asEnemyId("enemy_1"), deps);
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/game/gameplay/rpg/ruleEngine/battleResolver.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement startBattleV2 and battleActionV2**

```typescript
// src/game/gameplay/rpg/ruleEngine/battleResolver.ts
import type { WorldState, EnemyEntry } from "@/game/domain/worldState";
import type { EnemyId } from "@/game/domain/scenarioBlueprint";
import type { GameEvent } from "@/game/domain/events";
import type { ResolvedEventStatus, StateChange, FactChange } from "@/game/domain/resolvedEvent";
import type { ResolveDeps, ResolveResult } from "./resolveByType";

// ---------------------------------------------------------------------------
// V2 战斗纯函数：操作 WorldState，不依赖 ScenarioBlueprint。
// 逻辑移植自 V1 startBattle.ts + battleAction.ts，简化了 stage-3 目标检查
// （V2 不要求敌人是终幕目标，只要存在且在玩家地点即可开战）。
// 纯函数：不修改输入 state，不依赖 IO/Date/Math.random/AI。
// ---------------------------------------------------------------------------

export type BattleResolveDeps = ResolveDeps;

/** V2 startBattle：校验 + 初始化战斗状态。 */
export function startBattleV2(
  ws: WorldState,
  enemyId: EnemyId,
  deps: BattleResolveDeps,
): ResolveResult {
  // 已有 active battle
  if (ws.battle.status !== "idle") {
    return { ok: false, feedback: "已有进行中的战斗。" };
  }

  // 敌人存在
  const enemy = ws.enemies.find((e) => e.id === enemyId);
  if (enemy === undefined) {
    return { ok: false, feedback: "未知敌人。" };
  }

  // 玩家位于敌人地点
  if (ws.currentLocationId !== enemy.locationId) {
    return { ok: false, feedback: "你不在该敌人所在的地点。" };
  }

  // 敌人未被击败
  if (ws.defeatedEnemyIds.includes(enemyId)) {
    return { ok: false, feedback: "该敌人已被击败。" };
  }

  const occurredAt = deps.now();
  const event: GameEvent = { type: "battle_started", enemyId, occurredAt };

  const nextWs: WorldState = {
    ...ws,
    battle: {
      status: "active",
      enemyId,
      playerHp: ws.player.stats.hp,
      enemyHp: enemy.stats.hp,
      round: 1,
    },
    eventLedger: [...ws.eventLedger, event],
  };

  const stateChanges: StateChange[] = [
    { path: "battle", description: `与${enemy.name}展开战斗`, operation: "set" },
  ];

  return {
    ok: true,
    nextWorldState: nextWs,
    events: [event],
    feedback: `战斗开始：你与${enemy.name}展开了决斗！`,
    status: "success",
    stateChanges,
    facts: [],
  };
}

/** V2 battleAction：处理 attack/guard/flee。flee 映射到 V1 withdraw 语义。 */
export function battleActionV2(
  ws: WorldState,
  action: "attack" | "guard" | "flee",
  deps: BattleResolveDeps,
): ResolveResult {
  if (ws.battle.status !== "active") {
    return { ok: false, feedback: ws.battle.status === "idle" ? "当前没有进行中的战斗。" : "战斗已经结束。" };
  }

  const battle = ws.battle;
  const enemy = ws.enemies.find((e) => e.id === battle.enemyId);
  if (enemy === undefined) {
    return { ok: false, feedback: "战斗中的敌人不存在。" };
  }

  const occurredAt = deps.now();
  const events: GameEvent[] = [];
  const player = ws.player.stats;

  // flee → withdraw 语义
  if (action === "flee") {
    events.push({
      type: "battle_resolved",
      enemyId: battle.enemyId,
      outcome: "withdraw",
      occurredAt,
    });

    const nextWs: WorldState = {
      ...ws,
      battle: { status: "resolved", enemyId: battle.enemyId, outcome: "withdraw" },
      eventLedger: [...ws.eventLedger, ...events],
    };

    return {
      ok: true,
      nextWorldState: nextWs,
      events,
      feedback: "你选择了撤退，战斗以失败告终。",
      status: "success",
      stateChanges: [{ path: "battle", description: "撤退", operation: "set" }],
      facts: [],
    };
  }

  // attack 或 guard：计算伤害
  let enemyHp = battle.enemyHp;
  let playerHp = battle.playerHp;

  if (action === "attack") {
    const playerDamage = Math.max(1, player.attack - enemy.stats.defense);
    enemyHp = Math.max(0, enemyHp - playerDamage);
  }
  // guard: 不造成敌伤

  if (enemyHp <= 0) {
    // 胜利！不触发反击
    events.push({
      type: "battle_round_resolved",
      enemyId: battle.enemyId,
      round: battle.round,
      playerHp,
      enemyHp: 0,
      action,
      occurredAt,
    });
    events.push({
      type: "battle_resolved",
      enemyId: battle.enemyId,
      outcome: "victory",
      occurredAt,
    });
    events.push({
      type: "enemy_defeated",
      enemyId: battle.enemyId,
      occurredAt,
    });

    const nextWs: WorldState = {
      ...ws,
      battle: { status: "resolved", enemyId: battle.enemyId, outcome: "victory" },
      defeatedEnemyIds: [...ws.defeatedEnemyIds, battle.enemyId],
      eventLedger: [...ws.eventLedger, ...events],
    };

    return {
      ok: true,
      nextWorldState: nextWs,
      events,
      feedback: `你击败了${enemy.name}！`,
      status: "success",
      stateChanges: [
        { path: "battle", description: `击败${enemy.name}`, operation: "set" },
        { path: "defeatedEnemyIds", description: `记录击败`, operation: "add" },
      ],
      facts: [],
    };
  }

  // 敌人未倒下：反击
  let counterDamage: number;
  if (action === "guard") {
    counterDamage = Math.max(1, enemy.stats.attack - player.defense - 2);
  } else {
    counterDamage = Math.max(1, enemy.stats.attack - player.defense);
  }
  playerHp = Math.max(0, playerHp - counterDamage);

  if (playerHp <= 0) {
    // 失败
    events.push({
      type: "battle_round_resolved",
      enemyId: battle.enemyId,
      round: battle.round,
      playerHp: 0,
      enemyHp,
      action,
      occurredAt,
    });
    events.push({
      type: "battle_resolved",
      enemyId: battle.enemyId,
      outcome: "defeat",
      occurredAt,
    });

    const nextWs: WorldState = {
      ...ws,
      battle: { status: "resolved", enemyId: battle.enemyId, outcome: "defeat" },
      eventLedger: [...ws.eventLedger, ...events],
    };

    return {
      ok: true,
      nextWorldState: nextWs,
      events,
      feedback: `你被${enemy.name}击败了……`,
      status: "failure",
      stateChanges: [{ path: "battle", description: `被${enemy.name}击败`, operation: "set" }],
      facts: [],
    };
  }

  // 战斗继续
  events.push({
    type: "battle_round_resolved",
    enemyId: battle.enemyId,
    round: battle.round,
    playerHp,
    enemyHp,
    action,
    occurredAt,
  });

  const nextWs: WorldState = {
    ...ws,
    battle: {
      status: "active",
      enemyId: battle.enemyId,
      playerHp,
      enemyHp,
      round: battle.round + 1,
    },
    eventLedger: [...ws.eventLedger, ...events],
  };

  const playerDamage = action === "attack" ? Math.max(1, player.attack - enemy.stats.defense) : 0;

  return {
    ok: true,
    nextWorldState: nextWs,
    events,
    feedback: action === "attack"
      ? `你发起攻击，造成 ${playerDamage} 点伤害；敌人反击造成 ${counterDamage} 点伤害。`
      : `你摆出防御姿态；敌人反击造成 ${counterDamage} 点伤害。`,
    status: "success",
    stateChanges: [{ path: "battle", description: `回合 ${battle.round} 结算`, operation: "update" }],
    facts: [],
  };
}
```

- [ ] **Step 4: Run test to verify startBattleV2 tests pass**

Run: `npx vitest run src/game/gameplay/rpg/ruleEngine/battleResolver.test.ts`
Expected: PASS

- [ ] **Step 5: Add failing tests for battleActionV2**

```typescript
// Append to src/game/gameplay/rpg/ruleEngine/battleResolver.test.ts

describe("battleActionV2", () => {
  it("attack deals damage and enemy counters", () => {
    const ws = makeWorldWithEnemy();
    const started = startBattleV2(ws, asEnemyId("enemy_1"), deps);
    if (!started.ok) throw new Error("setup failed");
    // player attack=6, enemy defense=2 → damage=4; enemy attack=5, player defense=4 → counter=1
    const result = battleActionV2(started.nextWorldState, "attack", deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextWorldState.battle.status).toBe("active");
      if (result.nextWorldState.battle.status === "active") {
        expect(result.nextWorldState.battle.enemyHp).toBe(16); // 20 - 4
        expect(result.nextWorldState.battle.playerHp).toBe(29); // 30 - 1
        expect(result.nextWorldState.battle.round).toBe(2);
      }
    }
  });

  it("guard reduces counter damage", () => {
    const ws = makeWorldWithEnemy();
    const started = startBattleV2(ws, asEnemyId("enemy_1"), deps);
    if (!started.ok) throw new Error("setup failed");
    // guard: no damage to enemy; counter = max(1, 5-4-2) = max(1,-1) = 1
    const result = battleActionV2(started.nextWorldState, "guard", deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      if (result.nextWorldState.battle.status === "active") {
        expect(result.nextWorldState.battle.enemyHp).toBe(20); // no damage
        expect(result.nextWorldState.battle.playerHp).toBe(29); // 30 - 1
      }
    }
  });

  it("flee ends battle as withdraw", () => {
    const ws = makeWorldWithEnemy();
    const started = startBattleV2(ws, asEnemyId("enemy_1"), deps);
    if (!started.ok) throw new Error("setup failed");
    const result = battleActionV2(started.nextWorldState, "flee", deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextWorldState.battle.status).toBe("resolved");
      if (result.nextWorldState.battle.status === "resolved") {
        expect(result.nextWorldState.battle.outcome).toBe("withdraw");
      }
    }
  });

  it("victory when enemyHp reaches 0", () => {
    const ws = makeWorldWithEnemy();
    // Set enemy HP to 4 so one attack kills (damage=4)
    let started = startBattleV2(ws, asEnemyId("enemy_1"), deps);
    if (!started.ok) throw new Error("setup failed");
    const wsLowHp: WorldState = {
      ...started.nextWorldState,
      battle: { ...started.nextWorldState.battle, enemyHp: 4 },
    };
    const result = battleActionV2(wsLowHp, "attack", deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextWorldState.battle.status).toBe("resolved");
      if (result.nextWorldState.battle.status === "resolved") {
        expect(result.nextWorldState.battle.outcome).toBe("victory");
      }
      expect(result.nextWorldState.defeatedEnemyIds).toContain(asEnemyId("enemy_1"));
    }
  });

  it("defeat when playerHp reaches 0", () => {
    const ws = makeWorldWithEnemy();
    let started = startBattleV2(ws, asEnemyId("enemy_1"), deps);
    if (!started.ok) throw new Error("setup failed");
    const wsLowHp: WorldState = {
      ...started.nextWorldState,
      battle: { ...started.nextWorldState.battle, playerHp: 1 },
    };
    const result = battleActionV2(wsLowHp, "attack", deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextWorldState.battle.status).toBe("resolved");
      if (result.nextWorldState.battle.status === "resolved") {
        expect(result.nextWorldState.battle.outcome).toBe("defeat");
      }
    }
  });

  it("rejects when no active battle", () => {
    const ws = makeWorldWithEnemy();
    // battle.status is "idle" by default
    const result = battleActionV2(ws, "attack", deps);
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 6: Run all battleResolver tests**

Run: `npx vitest run src/game/gameplay/rpg/ruleEngine/battleResolver.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/game/gameplay/rpg/ruleEngine/battleResolver.ts src/game/gameplay/rpg/ruleEngine/battleResolver.test.ts
git commit -m "feat: V2 战斗纯函数 startBattleV2 + battleActionV2——操作 WorldState"
```

---

## Task 2: 接入 validateAction

**Files:**
- Modify: `src/game/gameplay/rpg/ruleEngine/validateAction.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/validateAction.test.ts`

**Interfaces:**
- Consumes: `startBattleV2` validation logic from Task 1
- Produces: `validateAction` now accepts `attack` and `battle_action` instead of returning `BATTLE_NOT_AVAILABLE`

- [ ] **Step 1: Write failing tests for attack and battle_action validation**

```typescript
// In src/game/gameplay/rpg/ruleEngine/validateAction.test.ts
// FIRST: Remove the existing test "rejects battle actions in P1" (lines 51-54)
//        since attack/battle_action will now be validated for real.
// THEN: Add these new test suites at the end of the file.
//
// Also add these imports at the top (alongside existing imports):
//   import { appendEnemy, type EnemyEntry } from "@/game/domain/worldState";
//   import { asEnemyId, asGenerationId } from "@/game/domain/scenarioBlueprint";
//   (asEnemyId and asGenerationId may already be imported — check first)

describe("validateAction — attack", () => {
  function makeWorldWithEnemy() {
    const startingLocation: LocationEntry = {
      id: asLocationId("loc_1"), name: "荒野", description: "test", kind: "main",
      connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
    };
    let ws = createInitialWorldState({
      generation: { generationId: asGenerationId("gen_test"), seed: "test", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
      player: { name: "侠客", identity: "剑客", stats: { hp: 100, attack: 10, defense: 5 } },
      startingLocation,
      startingItemIds: [],
    });
    const enemy: EnemyEntry = {
      id: asEnemyId("enemy_1"), name: "山贼", tier: "normal",
      stats: { hp: 20, attack: 5, defense: 2 },
      locationId: asLocationId("loc_1"), tags: [],
    };
    return appendEnemy(ws, enemy);
  }

  it("rejects attack on unknown enemy", () => {
    const ws = makeWorldWithEnemy();
    const result = validateAction(ws, { type: "attack", enemyId: asEnemyId("unknown") });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("UNKNOWN_ENEMY");
  });

  it("rejects attack when player not at enemy location", () => {
    const ws = makeWorldWithEnemy();
    const ws2 = { ...ws, currentLocationId: asLocationId("loc_2") };
    const result = validateAction(ws2, { type: "attack", enemyId: asEnemyId("enemy_1") });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("ENEMY_NOT_AT_LOCATION");
  });

  it("rejects attack when enemy already defeated", () => {
    const ws = makeWorldWithEnemy();
    const ws2 = { ...ws, defeatedEnemyIds: [asEnemyId("enemy_1")] };
    const result = validateAction(ws2, { type: "attack", enemyId: asEnemyId("enemy_1") });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("ENEMY_ALREADY_DEFEATED");
  });

  it("rejects attack when battle already active", () => {
    const ws = makeWorldWithEnemy();
    const ws2 = { ...ws, battle: { status: "active", enemyId: asEnemyId("enemy_1"), playerHp: 30, enemyHp: 20, round: 1 } };
    const result = validateAction(ws2, { type: "attack", enemyId: asEnemyId("enemy_1") });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("BATTLE_ALREADY_ACTIVE");
  });

  it("accepts attack on valid enemy at location with idle battle", () => {
    const ws = makeWorldWithEnemy();
    const result = validateAction(ws, { type: "attack", enemyId: asEnemyId("enemy_1") });
    expect(result.ok).toBe(true);
  });
});

describe("validateAction — battle_action", () => {
  it("rejects battle_action when no active battle", () => {
    const startingLocation: LocationEntry = {
      id: asLocationId("loc_1"), name: "荒野", description: "test", kind: "main",
      connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
    };
    const ws = createInitialWorldState({
      generation: { generationId: asGenerationId("gen_test"), seed: "test", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
      player: { name: "侠客", identity: "剑客", stats: { hp: 100, attack: 10, defense: 5 } },
      startingLocation,
      startingItemIds: [],
    });
    const result = validateAction(ws, { type: "battle_action", action: "attack" });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("NO_ACTIVE_BATTLE");
  });

  it("accepts battle_action when battle is active", () => {
    const startingLocation: LocationEntry = {
      id: asLocationId("loc_1"), name: "荒野", description: "test", kind: "main",
      connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
    };
    let ws = createInitialWorldState({
      generation: { generationId: asGenerationId("gen_test"), seed: "test", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
      player: { name: "侠客", identity: "剑客", stats: { hp: 100, attack: 10, defense: 5 } },
      startingLocation,
      startingItemIds: [],
    });
    ws = { ...ws, battle: { status: "active", enemyId: asEnemyId("e1"), playerHp: 100, enemyHp: 50, round: 1 } };
    const result = validateAction(ws, { type: "battle_action", action: "attack" });
    expect(result.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/game/gameplay/rpg/ruleEngine/validateAction.test.ts`
Expected: FAIL — attack returns BATTLE_NOT_AVAILABLE instead of UNKNOWN_ENEMY etc.

- [ ] **Step 3: Update validateAction to handle attack and battle_action**

Replace the `attack`/`battle_action` case in `validateAction.ts`:

```typescript
// In validateAction.ts, replace:
//   case "attack":
//   case "battle_action":
//     return { ok: false, code: "BATTLE_NOT_AVAILABLE", params: {} };
// With:

    case "attack": {
      const enemy = ws.enemies.find((e) => e.id === action.enemyId);
      if (enemy === undefined) return { ok: false, code: "UNKNOWN_ENEMY", params: { enemyId: String(action.enemyId) } };
      if (ws.battle.status !== "idle") return { ok: false, code: "BATTLE_ALREADY_ACTIVE", params: {} };
      if (ws.currentLocationId !== enemy.locationId) return { ok: false, code: "ENEMY_NOT_AT_LOCATION", params: {} };
      if (ws.defeatedEnemyIds.includes(action.enemyId)) return { ok: false, code: "ENEMY_ALREADY_DEFEATED", params: {} };
      return { ok: true };
    }
    case "battle_action": {
      if (ws.battle.status !== "active") return { ok: false, code: "NO_ACTIVE_BATTLE", params: {} };
      return { ok: true };
    }
```

Also update the `ValidationCode` type: remove `"BATTLE_NOT_AVAILABLE"` and add `"ENEMY_NOT_AT_LOCATION" | "BATTLE_ALREADY_ACTIVE" | "ENEMY_ALREADY_DEFEATED" | "NO_ACTIVE_BATTLE"`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/game/gameplay/rpg/ruleEngine/validateAction.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/game/gameplay/rpg/ruleEngine/validateAction.ts src/game/gameplay/rpg/ruleEngine/validateAction.test.ts
git commit -m "feat: validateAction 接入 attack/battle_action——替换 BATTLE_NOT_AVAILABLE 桩"
```

---

## Task 3: 接入 resolveByType

**Files:**
- Modify: `src/game/gameplay/rpg/ruleEngine/resolveByType.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/resolveByType.test.ts`

**Interfaces:**
- Consumes: `startBattleV2`, `battleActionV2` from Task 1
- Produces: `resolveByType` now handles `attack` and `battle_action` actions

- [ ] **Step 1: Write failing tests for attack and battle_action in resolveByType**

```typescript
// Append to src/game/gameplay/rpg/ruleEngine/resolveByType.test.ts
// Add these imports at the top (alongside existing imports):
//   import { appendEnemy, type EnemyEntry, type LocationEntry } from "@/game/domain/worldState";
//   import { asEnemyId, asGenerationId } from "@/game/domain/scenarioBlueprint";

describe("resolveByType — attack", () => {
  function makeWorldWithEnemy() {
    const startingLocation: LocationEntry = {
      id: asLocationId("loc_1"), name: "荒野", description: "test", kind: "main",
      connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
    };
    let ws = createInitialWorldState({
      generation: { generationId: asGenerationId("gen_test"), seed: "test", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
      player: { name: "侠客", identity: "剑客", stats: { hp: 30, attack: 6, defense: 4 } },
      startingLocation,
      startingItemIds: [],
    });
    const enemy: EnemyEntry = {
      id: asEnemyId("enemy_1"), name: "山贼", tier: "normal",
      stats: { hp: 20, attack: 5, defense: 2 },
      locationId: asLocationId("loc_1"), tags: [],
    };
    return appendEnemy(ws, enemy);
  }

  it("attack starts battle and returns active battle state", () => {
    const ws = makeWorldWithEnemy();
    const result = resolveByType(ws, { type: "attack", enemyId: asEnemyId("enemy_1") }, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextWorldState.battle.status).toBe("active");
      expect(result.events.some((e) => e.type === "battle_started")).toBe(true);
      expect(result.status).toBe("success");
    }
  });

  it("battle_action attack resolves a round", () => {
    const ws = makeWorldWithEnemy();
    // First start the battle
    const started = resolveByType(ws, { type: "attack", enemyId: asEnemyId("enemy_1") }, deps);
    if (!started.ok) throw new Error("setup failed");
    // Now do a battle action
    const result = resolveByType(started.nextWorldState, { type: "battle_action", action: "attack" }, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.events.some((e) => e.type === "battle_round_resolved")).toBe(true);
    }
  });

  it("battle_action flee ends battle", () => {
    const ws = makeWorldWithEnemy();
    const started = resolveByType(ws, { type: "attack", enemyId: asEnemyId("enemy_1") }, deps);
    if (!started.ok) throw new Error("setup failed");
    const result = resolveByType(started.nextWorldState, { type: "battle_action", action: "flee" }, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextWorldState.battle.status).toBe("resolved");
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/game/gameplay/rpg/ruleEngine/resolveByType.test.ts`
Expected: FAIL — attack falls through to default

- [ ] **Step 3: Add attack and battle_action cases to resolveByType**

In `resolveByType.ts`, add before the `default:` case:

```typescript
// In resolveByType.ts, add these cases before default:

    case "attack": {
      return startBattleV2(ws, action.enemyId, deps);
    }
    case "battle_action": {
      return battleActionV2(ws, action.action, deps);
    }
```

Also add the import at the top:

```typescript
import { startBattleV2, battleActionV2 } from "./battleResolver";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/game/gameplay/rpg/ruleEngine/resolveByType.test.ts src/game/gameplay/rpg/ruleEngine/battleResolver.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/game/gameplay/rpg/ruleEngine/resolveByType.ts src/game/gameplay/rpg/ruleEngine/resolveByType.test.ts
git commit -m "feat: resolveByType 接入 attack/battle_action——调用 battleResolver"
```

---

## Task 4: 全量回归测试

**Files:**
- No new files — run existing test suite

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 2: If any tests fail, fix them**

Common issues to watch for:
- `ValidationCode` type changes may break consumers that reference `"BATTLE_NOT_AVAILABLE"`
- `index.ts` (ruleEngine facade) may need updates if it references the removed code

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix: 回归测试修复——战斗接入后全量通过"
```

---

## Self-Review

**Spec coverage:**
- ✅ attack action starts battle (spec §5.4: 规则负责回合顺序、命中伤害、技能消耗、敌人死亡、战利品)
- ✅ battle_action handles attack/guard/flee (spec §4.2 Action 类型定义)
- ✅ flee maps to withdraw outcome (V2 Action "flee" → V1 event outcome "withdraw")
- ✅ Victory adds to defeatedEnemyIds (V1 logic preserved)
- ✅ Defeat sets battle to resolved with "defeat" outcome
- ✅ Battle blocks non-battle actions (already in resolveByType line 42-52)

**Placeholder scan:** No TBDs. All code blocks contain actual implementation.

**Type consistency:**
- `ResolveResult` type matches between `resolveByType.ts` and `battleResolver.ts`
- `BattleState` fields match `worldState.ts` definition
- `EnemyEntry` fields match `worldState.ts` definition
- `ValidationCode` updated to include new codes, `BATTLE_NOT_AVAILABLE` removed
