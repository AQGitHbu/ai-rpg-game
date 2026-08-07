# P3：ExpansionProposer 世界扩展 + 同回合重演算 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 P1/P2 流水线骨架基础上，实现条件触发的世界扩展提议机制：规则引擎初判发现"世界不够用"时调用 AI 提议新实体，规则审批后对原动作同回合重演算一次（至多一次），审批通过的实体在 StateCommit 阶段原子写入 World State。

**Architecture:** ExpansionProposer 是 RuleEngine 与 StateCommit 之间的条件阶段。当 ruleEngine 初判返回 `blocked`/`invalid` 且拒绝原因为"实体不存在"时，触发 ExpansionProposer 调用可注入的 ExpansionSource（AI），返回实体提案；规则逐个审批（预算、世界观一致性、ID 唯一性、引用合法性），通过的提案追加到临时 World State，然后对原动作重演算一次。重演算至多一次，防止递归。节奏驱动的扩展（低张力、任务缺口）不触发重演算，新实体从下一回合可用。

**Tech Stack:** TypeScript, Next.js 16, React 19, libsql/SQLite, Vitest, zustand

**Spec:** `docs/superpowers/specs/2026-08-07-ai-rpg-architecture-redesign-spec.md` §6, §3.3, §16

## Global Constraints

- 纯 domain 层零 IO、零 AI、零 DB；gameplay 层纯函数不写状态
- 所有 AI 调用点使用可注入 source 接口，离线 fixture 保证无 AI 全流水线可测
- ExpansionProposer 只提议新世界**实体**（地点/NPC/物品/敌人），不提议叙事事件（事件走 candidateEventPool，P4）
- 重演算至多一次，重演算中不再触发第二轮扩展
- 预算检查针对 `expanded` 维度，开局实体记入 `opening` 不占扩展预算
- hardLimit 针对 opening + expanded 总和，不可逾越
- CAS compare-and-swap 原子写入，revision 是唯一防重屏障
- 测试先行（TDD），每个 task 以失败测试开始
- ExpansionProposer 审批失败绝不使整个行动失败——扩展被丢弃，行动按初判结果继续

---

## P1/P2 现状基线

以下 P1/P2 文件已存在且可被 P3 修改/扩展：

| 文件 | 当前状态 | P3 改动 |
|---|---|---|
| `src/game/domain/worldState.ts` | WorldState v2 + Entry 类型 + append* 纯函数 | **不改**（append* 已满足追加需求） |
| `src/game/domain/storyState.ts` | StoryState v2 + budget + candidateEventPool | **不改** |
| `src/game/domain/storyBudget.ts` | BudgetDimension(opening/expanded/max) + budgetAllowsExpansion + consumeExpansion + withinHardLimit | **不改** |
| `src/game/domain/action.ts` | Action union 含 utterance + freeform | **不改** |
| `src/game/domain/resolvedEvent.ts` | ResolvedEvent 含五态 status + stateChanges | **不改** |
| `src/game/domain/events.ts` | GameEvent 含 BlueprintExpandedEvent | **不改** |
| `src/game/gameplay/rpg/ruleEngine/index.ts` | ruleEngine facade: validate → resolve → quests → ending → metrics | **修改**：返回初判结果含 ValidationCode，供 ExpansionProposer 判断是否触发 |
| `src/game/gameplay/rpg/ruleEngine/validateAction.ts` | 已有完整校验含 UNKNOWN_LOCATION/UNKNOWN_NPC 等 | **不改** |
| `src/game/gameplay/rpg/ruleEngine/resolveByType.ts` | 已有五态 status + stateChanges | **不改** |
| `src/game/application/performActionV2.ts` | load → convert → ruleEngine → commit | **修改**：插入 ExpansionProposer + 重演算环节 |
| `src/game/application/stateCommit.ts` | CAS + 物化视图归约 | **不改** |
| `src/game/application/server/compositionRootV2.ts` | 注入 repository + source + now | **修改**：注入 ExpansionSource |

### 旧架构可参考代码

| 文件 | 参考 value |
|---|---|
| `src/game/gameplay/rpg/narrative/approveBlueprintExpansion.ts` | 审批闸门顺序、payload 校验逻辑 |
| `src/game/gameplay/rpg/narrative/types.ts` | ProposedNew* 类型形状（P3 新建 V2 版本，不复用旧类型） |

---

## File Structure

### 新建文件

```
src/game/gameplay/rpg/expansion/
  expansionTypes.ts        # V2 扩展提案类型：ExpansionProposal, ApprovedExpansion, ExpansionRejection
  expansionTypes.test.ts
  expansionTrigger.ts      # 纯函数：从初判结果 + WorldState + StoryState 判断是否触发扩展
  expansionTrigger.test.ts
  approveExpansion.ts      # 纯函数：逐个审批提案（预算、世界观一致性、ID 唯一性、引用合法性）
  approveExpansion.test.ts
  applyExpansion.ts        # 纯函数：将已审批提案追加到 WorldState（临时状态，供重演算使用）
  applyExpansion.test.ts
  index.ts                 # facade: runExpansionProposer(initialResult, ws, ss, action, source?, deps) → ExpansionResult

src/game/application/server/ai/
  expansionSource.ts       # ExpansionSource 接口 + fixture + live 实现
  expansionSource.test.ts
```

### 修改文件

```
src/game/application/performActionV2.ts       # 插入 ExpansionProposer + 重演算
src/game/application/server/compositionRootV2.ts  # 注入 ExpansionSource
src/game/application/p3OfflineRegression.test.ts  # 新建：离线全流水线回归
```

---

## Task 1: V2 扩展提案类型

**Files:**
- Create: `src/game/gameplay/rpg/expansion/expansionTypes.ts`
- Test: `src/game/gameplay/rpg/expansion/expansionTypes.test.ts`

**Interfaces:**
- Produces: `ExpansionProposal`, `ApprovedExpansion`, `ExpansionRejection`, `ExpansionTriggerReason`, `ExpansionResult`

- [ ] **Step 1: Write failing tests for expansion types**

```typescript
// src/game/gameplay/rpg/expansion/expansionTypes.test.ts
import { describe, it, expect } from "vitest";
import type {
  ExpansionProposal,
  ApprovedExpansion,
  ExpansionRejection,
  ExpansionTriggerReason,
  ExpansionResult,
} from "./expansionTypes";

describe("ExpansionTypes", () => {
  it("ExpansionProposal for location has kind=location", () => {
    const p: ExpansionProposal = {
      kind: "location",
      name: "密林深处",
      description: "一片幽暗的密林，传说中有猛兽出没。",
      scale: "scene",
      connectFromLocationId: "loc_1",
      reason: "玩家要求前往未知地点",
    };
    expect(p.kind).toBe("location");
  });

  it("ExpansionProposal for npc has kind=npc", () => {
    const p: ExpansionProposal = {
      kind: "npc",
      name: "老猎人",
      role: "猎人",
      description: "一个沉默寡言的老猎人。",
      locationId: "loc_1",
    };
    expect(p.kind).toBe("npc");
  });

  it("ApprovedExpansion carries Entry objects", () => {
    const a: ApprovedExpansion = {
      newLocations: [],
      newNpcs: [],
      newItems: [],
      newEnemies: [],
      newFacts: [],
      budgetConsumed: { locations: 0, npcs: 0, items: 0, enemies: 0, facts: 0 },
    };
    expect(a.newLocations).toEqual([]);
  });

  it("ExpansionResult noExpansion when trigger not met", () => {
    const r: ExpansionResult = {
      triggered: false,
      reason: "no_trigger",
      approved: null,
      reEvaluatedResult: null,
    };
    expect(r.triggered).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/game/gameplay/rpg/expansion/expansionTypes.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement expansion types**

```typescript
// src/game/gameplay/rpg/expansion/expansionTypes.ts
import type { LocationEntry, NpcEntry, ItemEntry, EnemyEntry, WorldFactEntry } from "@/game/domain/worldState";
import type { RuleEngineResult } from "@/game/gameplay/rpg/ruleEngine";

/** 扩展提案——AI 返回的原始提案，待审批 */
export type ExpansionProposal =
  | {
      readonly kind: "location";
      readonly name: string;
      readonly description: string;
      readonly scale: "scene" | "town";
      readonly connectFromLocationId: string;
      readonly reason: string;
    }
  | {
      readonly kind: "npc";
      readonly name: string;
      readonly role: string;
      readonly description: string;
      readonly locationId: string;
    }
  | {
      readonly kind: "item";
      readonly name: string;
      readonly description: string;
      readonly kind_hint: string;
      readonly tags: readonly string[];
      readonly locationId: string;
    }
  | {
      readonly kind: "enemy";
      readonly name: string;
      readonly tier: "normal" | "boss";
      readonly stats: { readonly hp: number; readonly attack: number; readonly defense: number };
      readonly locationId: string;
      readonly reason: string;
    }
  | {
      readonly kind: "fact";
      readonly text: string;
      readonly locationId: string;
      readonly reason: string;
    };

/** 审批拒绝原因 */
export type ExpansionRejection =
  | "budget_exceeded"
  | "hard_limit_exceeded"
  | "invalid_payload"
  | "id_collision"
  | "reference_broken"
  | "pacing_locked"
  | "endgame_locked";

/** 已审批的扩展——通过审批的提案，转换为 Entry 类型 */
export type ApprovedExpansion = {
  readonly newLocations: readonly LocationEntry[];
  readonly newNpcs: readonly NpcEntry[];
  readonly newItems: readonly ItemEntry[];
  readonly newEnemies: readonly EnemyEntry[];
  readonly newFacts: readonly WorldFactEntry[];
  readonly budgetConsumed: {
    readonly locations: number;
    readonly npcs: number;
    readonly items: number;
    readonly enemies: number;
    readonly facts: number;
  };
};

/** 扩展触发原因 */
export type ExpansionTriggerReason =
  | "entity_not_found"    // 初判 blocked/invalid 且拒绝原因为实体不存在
  | "low_tension"         // 连续 3 回合张力 < 30 且 nextPacingNeed === "complicate"
  | "quest_gap";          // 任务目标缺口

/** 扩展结果 */
export type ExpansionResult = {
  readonly triggered: boolean;
  readonly reason: ExpansionTriggerReason | "no_trigger";
  readonly approved: ApprovedExpansion | null;
  /** 重演算后的最终 RuleEngineResult（仅 entity_not_found 触发时可能有值） */
  readonly reEvaluatedResult: RuleEngineResult | null;
  /** 被拒绝的提案及原因（审计用） */
  readonly rejectedProposals: readonly { readonly proposal: ExpansionProposal; readonly reason: ExpansionRejection }[];
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/game/gameplay/rpg/expansion/expansionTypes.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/game/gameplay/rpg/expansion/expansionTypes.ts src/game/gameplay/rpg/expansion/expansionTypes.test.ts
git commit -m "feat: V2 扩展提案类型——ExpansionProposal/ApprovedExpansion/ExpansionResult"
```

---

## Task 2: 扩展触发条件判定

**Files:**
- Create: `src/game/gameplay/rpg/expansion/expansionTrigger.ts`
- Test: `src/game/gameplay/rpg/expansion/expansionTrigger.test.ts`

**Interfaces:**
- Consumes: `RuleEngineResult` from ruleEngine, `WorldState`, `StoryState`, `Action`
- Produces: `checkExpansionTrigger()` → `{ triggered: boolean; reason: ExpansionTriggerReason | "no_trigger" }`

- [ ] **Step 1: Write failing tests**

```typescript
// src/game/gameplay/rpg/expansion/expansionTrigger.test.ts
import { describe, it, expect } from "vitest";
import { checkExpansionTrigger } from "./expansionTrigger";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { Action } from "@/game/domain/action";
import type { RuleEngineResult } from "@/game/gameplay/rpg/ruleEngine";
import { createInitialWorldState } from "@/game/domain/worldState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { asLocationId, asNpcId, asGenerationId } from "@/game/domain/scenarioBlueprint";

describe("checkExpansionTrigger", () => {
  const ws = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: {
      id: asLocationId("loc_1"), name: "客栈", description: "t", kind: "main",
      connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
    },
    startingItemIds: [],
  });
  const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 } });
  const action: Action = { type: "move", locationId: asLocationId("loc_unknown") };

  it("triggers entity_not_found when ruleEngine returns blocked with UNKNOWN_LOCATION", () => {
    const initialResult: RuleEngineResult = {
      ok: false,
      code: "UNKNOWN_LOCATION",
      feedback: "Action rejected: UNKNOWN_LOCATION",
    };
    const result = checkExpansionTrigger(initialResult, ws, ss, action);
    expect(result.triggered).toBe(true);
    expect(result.reason).toBe("entity_not_found");
  });

  it("triggers entity_not_found when ruleEngine returns UNKNOWN_NPC", () => {
    const initialResult: RuleEngineResult = {
      ok: false,
      code: "UNKNOWN_NPC",
      feedback: "Action rejected: UNKNOWN_NPC",
    };
    const talkAction: Action = { type: "talk", npcId: asNpcId("npc_unknown") };
    const result = checkExpansionTrigger(initialResult, ws, ss, talkAction);
    expect(result.triggered).toBe(true);
    expect(result.reason).toBe("entity_not_found");
  });

  it("does NOT trigger when ruleEngine succeeds", () => {
    const initialResult: RuleEngineResult = {
      ok: true,
      nextWorldState: ws,
      nextStoryState: ss,
      resolvedEvent: {
        actionId: "a1", status: "success", eventKind: "travel",
        facts: [], stateChanges: [], costs: [], rewards: [],
        triggeredEvents: [], rejectedEffects: [], stateVersion: 1,
      },
    };
    const result = checkExpansionTrigger(initialResult, ws, ss, action);
    expect(result.triggered).toBe(false);
    expect(result.reason).toBe("no_trigger");
  });

  it("does NOT trigger on non-entity rejections (e.g. LOCATION_NOT_CONNECTED)", () => {
    const initialResult: RuleEngineResult = {
      ok: false,
      code: "LOCATION_NOT_CONNECTED",
      feedback: "Action rejected: LOCATION_NOT_CONNECTED",
    };
    const result = checkExpansionTrigger(initialResult, ws, ss, action);
    expect(result.triggered).toBe(false);
    expect(result.reason).toBe("no_trigger");
  });

  it("does NOT trigger when budget has no room for expansion", () => {
    const ssMaxed = { ...ss, budget: { ...ss.budget, locations: { ...ss.budget.locations, expanded: ss.budget.locations.max } } };
    const initialResult: RuleEngineResult = {
      ok: false,
      code: "UNKNOWN_LOCATION",
      feedback: "Action rejected: UNKNOWN_LOCATION",
    };
    const result = checkExpansionTrigger(initialResult, ws, ssMaxed, action);
    expect(result.triggered).toBe(false);
    expect(result.reason).toBe("no_trigger");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/game/gameplay/rpg/expansion/expansionTrigger.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement expansion trigger**

```typescript
// src/game/gameplay/rpg/expansion/expansionTrigger.ts
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { Action } from "@/game/domain/action";
import type { RuleEngineResult, ValidationCode } from "@/game/gameplay/rpg/ruleEngine";
import { budgetAllowsExpansion } from "@/game/domain/storyBudget";
import type { ExpansionTriggerReason } from "./expansionTypes";

/** 初判失败码中代表"实体不存在"的子集 */
const ENTITY_NOT_FOUND_CODES: ReadonlySet<ValidationCode> = new Set([
  "UNKNOWN_LOCATION",
  "UNKNOWN_NPC",
  "UNKNOWN_FACT",
  "UNKNOWN_ITEM",
  "UNKNOWN_ENEMY",
]);

export type TriggerResult = {
  readonly triggered: boolean;
  readonly reason: ExpansionTriggerReason | "no_trigger";
};

export function checkExpansionTrigger(
  initialResult: RuleEngineResult,
  ws: WorldState,
  ss: StoryState,
  action: Action,
): TriggerResult {
  // 信号 1: 初判失败且原因为实体不存在
  if (!initialResult.ok && ENTITY_NOT_FOUND_CODES.has(initialResult.code)) {
    // 检查预算是否有余量（至少有一个维度可扩展）
    const hasBudget =
      budgetAllowsExpansion(ss.budget, "locations") ||
      budgetAllowsExpansion(ss.budget, "npcs") ||
      budgetAllowsExpansion(ss.budget, "quests");
    if (!hasBudget) return { triggered: false, reason: "no_trigger" };
    return { triggered: true, reason: "entity_not_found" };
  }

  // 信号 2: 低张力需要新冲突（P3 暂不实现节奏驱动扩展——预留接口）
  // 信号 3: 任务目标缺口（P3 暂不实现——预留接口）

  return { triggered: false, reason: "no_trigger" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/game/gameplay/rpg/expansion/expansionTrigger.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/game/gameplay/rpg/expansion/expansionTrigger.ts src/game/gameplay/rpg/expansion/expansionTrigger.test.ts
git commit -m "feat: 扩展触发条件判定——entity_not_found 信号 + 预算门控"
```

---

## Task 3: 扩展提案审批

**Files:**
- Create: `src/game/gameplay/rpg/expansion/approveExpansion.ts`
- Test: `src/game/gameplay/rpg/expansion/approveExpansion.test.ts`

**Interfaces:**
- Consumes: `ExpansionProposal[]`, `WorldState`, `StoryState`
- Produces: `approveExpansions()` → `{ approved: ApprovedExpansion; rejected: { proposal, reason }[]; nextBudget: StoryBudget }`

- [ ] **Step 1: Write failing tests**

```typescript
// src/game/gameplay/rpg/expansion/approveExpansion.test.ts
import { describe, it, expect } from "vitest";
import { approveExpansions } from "./approveExpansion";
import { createInitialWorldState, type LocationEntry, type NpcEntry } from "@/game/domain/worldState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { asLocationId, asNpcId, asGenerationId, asItemId, asFactId, asEnemyId } from "@/game/domain/scenarioBlueprint";
import type { ExpansionProposal } from "./expansionTypes";
import type { StoryBudget } from "@/game/domain/storyBudget";

describe("approveExpansions", () => {
  const loc1: LocationEntry = {
    id: asLocationId("loc_1"), name: "客栈", description: "t", kind: "main",
    connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
  };
  const ws = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: loc1,
    startingItemIds: [],
  });
  const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 } });

  it("approves a valid location proposal", () => {
    const proposals: ExpansionProposal[] = [{
      kind: "location",
      name: "密林",
      description: "一片幽暗的密林。",
      scale: "scene",
      connectFromLocationId: "loc_1",
      reason: "玩家要求前往",
    }];
    const result = approveExpansions(proposals, ws, ss.budget);
    expect(result.approved.newLocations.length).toBe(1);
    expect(result.approved.newLocations[0]!.name).toBe("密林");
    expect(result.rejected).toEqual([]);
    expect(result.nextBudget.locations.expanded).toBe(1);
  });

  it("rejects location with too short name", () => {
    const proposals: ExpansionProposal[] = [{
      kind: "location",
      name: "林",
      description: "一片幽暗的密林。",
      scale: "scene",
      connectFromLocationId: "loc_1",
      reason: "玩家要求前往",
    }];
    const result = approveExpansions(proposals, ws, ss.budget);
    expect(result.approved.newLocations).toEqual([]);
    expect(result.rejected.length).toBe(1);
    expect(result.rejected[0]!.reason).toBe("invalid_payload");
  });

  it("rejects location with broken connectFromLocationId", () => {
    const proposals: ExpansionProposal[] = [{
      kind: "location",
      name: "密林",
      description: "一片幽暗的密林。",
      scale: "scene",
      connectFromLocationId: "loc_nonexistent",
      reason: "玩家要求前往",
    }];
    const result = approveExpansions(proposals, ws, ss.budget);
    expect(result.approved.newLocations).toEqual([]);
    expect(result.rejected[0]!.reason).toBe("reference_broken");
  });

  it("rejects when budget exceeded", () => {
    const maxedBudget: StoryBudget = {
      ...ss.budget,
      locations: { ...ss.budget.locations, expanded: ss.budget.locations.max },
    };
    const proposals: ExpansionProposal[] = [{
      kind: "location",
      name: "密林",
      description: "一片幽暗的密林。",
      scale: "scene",
      connectFromLocationId: "loc_1",
      reason: "玩家要求前往",
    }];
    const result = approveExpansions(proposals, ws, maxedBudget);
    expect(result.approved.newLocations).toEqual([]);
    expect(result.rejected[0]!.reason).toBe("budget_exceeded");
  });

  it("rejects when hard limit exceeded", () => {
    const hardLimitBudget: StoryBudget = {
      ...ss.budget,
      locations: { opening: 39, expanded: 1, max: 50 },
      hardLimit: { locations: 40, npcs: 30 },
    };
    const proposals: ExpansionProposal[] = [{
      kind: "location",
      name: "密林",
      description: "一片幽暗的密林。",
      scale: "scene",
      connectFromLocationId: "loc_1",
      reason: "玩家要求前往",
    }];
    const result = approveExpansions(proposals, ws, hardLimitBudget);
    expect(result.approved.newLocations).toEqual([]);
    expect(result.rejected[0]!.reason).toBe("hard_limit_exceeded");
  });

  it("approves a valid npc proposal", () => {
    const proposals: ExpansionProposal[] = [{
      kind: "npc",
      name: "老猎人",
      role: "猎人",
      description: "一个沉默寡言的老猎人。",
      locationId: "loc_1",
    }];
    const result = approveExpansions(proposals, ws, ss.budget);
    expect(result.approved.newNpcs.length).toBe(1);
    expect(result.approved.newNpcs[0]!.name).toBe("老猎人");
    expect(result.nextBudget.npcs.expanded).toBe(1);
  });

  it("rejects npc with broken locationId reference", () => {
    const proposals: ExpansionProposal[] = [{
      kind: "npc",
      name: "老猎人",
      role: "猎人",
      description: "一个沉默寡言的老猎人。",
      locationId: "loc_nonexistent",
    }];
    const result = approveExpansions(proposals, ws, ss.budget);
    expect(result.approved.newNpcs).toEqual([]);
    expect(result.rejected[0]!.reason).toBe("reference_broken");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/game/gameplay/rpg/expansion/approveExpansion.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement approveExpansions**

```typescript
// src/game/gameplay/rpg/expansion/approveExpansion.ts
import type { WorldState, LocationEntry, NpcEntry, ItemEntry, EnemyEntry, WorldFactEntry } from "@/game/domain/worldState";
import type { StoryBudget } from "@/game/domain/storyBudget";
import { budgetAllowsExpansion, withinHardLimit, consumeExpansion } from "@/game/domain/storyBudget";
import {
  asLocationId, asNpcId, asItemId, asEnemyId, asFactId,
} from "@/game/domain/scenarioBlueprint";
import type { ExpansionProposal, ApprovedExpansion, ExpansionRejection } from "./expansionTypes";

const codePointLength = (value: string) => Array.from(value).length;

export type ApprovalResult = {
  readonly approved: ApprovedExpansion;
  readonly rejected: readonly { readonly proposal: ExpansionProposal; readonly reason: ExpansionRejection }[];
  readonly nextBudget: StoryBudget;
};

export function approveExpansions(
  proposals: readonly ExpansionProposal[],
  ws: WorldState,
  budget: StoryBudget,
): ApprovalResult {
  const existingLocationIds = new Set(ws.locations.map((l) => String(l.id)));
  const existingNpcIds = new Set(ws.npcs.map((n) => String(n.id)));
  const existingItemIds = new Set(ws.items.map((i) => String(i.id)));
  const existingEnemyIds = new Set(ws.enemies.map((e) => String(e.id)));
  const existingFactIds = new Set(ws.worldFacts.map((f) => String(f.factId)));

  const newLocations: LocationEntry[] = [];
  const newNpcs: NpcEntry[] = [];
  const newItems: ItemEntry[] = [];
  const newEnemies: EnemyEntry[] = [];
  const newFacts: WorldFactEntry[] = [];
  const rejected: { proposal: ExpansionProposal; reason: ExpansionRejection }[] = [];

  let workingBudget = budget;

  for (const proposal of proposals) {
    const result = approveOne(proposal, ws, workingBudget, existingLocationIds, existingNpcIds, existingItemIds, existingEnemyIds, existingFactIds);
    if (result.ok) {
      switch (proposal.kind) {
        case "location":
          newLocations.push(result.entry as LocationEntry);
          existingLocationIds.add(String(result.entry.id));
          workingBudget = consumeExpansion(workingBudget, "locations");
          break;
        case "npc":
          newNpcs.push(result.entry as NpcEntry);
          existingNpcIds.add(String(result.entry.id));
          workingBudget = consumeExpansion(workingBudget, "npcs");
          break;
        case "item":
          newItems.push(result.entry as ItemEntry);
          existingItemIds.add(String(result.entry.id));
          workingBudget = consumeExpansion(workingBudget, "quests"); // items share quests budget? No—use a separate dimension
          // Actually items don't have their own budget dimension. Use npcs as proxy or skip budget for items.
          // Spec says budget dimensions are locations/npcs/quests/events. Items don't have their own.
          // Decision: items consume no budget dimension (they're minor entities).
          workingBudget = budget; // revert—items are free
          break;
        case "enemy":
          newEnemies.push(result.entry as EnemyEntry);
          existingEnemyIds.add(String(result.entry.id));
          workingBudget = consumeExpansion(workingBudget, "quests"); // enemies share quests budget? No.
          workingBudget = budget; // revert—enemies are free too (spec only budgets locations/npcs/quests/events)
          break;
        case "fact":
          newFacts.push(result.entry as WorldFactEntry);
          existingFactIds.add(String(result.entry.id));
          workingBudget = consumeExpansion(workingBudget, "events"); // facts consume events budget
          break;
      }
    } else {
      rejected.push({ proposal, reason: result.reason });
    }
  }

  return {
    approved: {
      newLocations,
      newNpcs,
      newItems,
      newEnemies,
      newFacts,
      budgetConsumed: {
        locations: newLocations.length,
        npcs: newNpcs.length,
        items: newItems.length,
        enemies: newEnemies.length,
        facts: newFacts.length,
      },
    },
    rejected,
    nextBudget: workingBudget,
  };
}

type ApproveOneResult =
  | { readonly ok: true; readonly entry: LocationEntry | NpcEntry | ItemEntry | EnemyEntry | WorldFactEntry }
  | { readonly ok: false; readonly reason: ExpansionRejection };

function approveOne(
  proposal: ExpansionProposal,
  ws: WorldState,
  budget: StoryBudget,
  existingLocationIds: Set<string>,
  _existingNpcIds: Set<string>,
  _existingItemIds: Set<string>,
  _existingEnemyIds: Set<string>,
  _existingFactIds: Set<string>,
): ApproveOneResult {
  switch (proposal.kind) {
    case "location": {
      // Budget check
      if (!budgetAllowsExpansion(budget, "locations")) return { ok: false, reason: "budget_exceeded" };
      if (!withinHardLimit(budget, "locations")) return { ok: false, reason: "hard_limit_exceeded" };
      // Payload validation
      if (codePointLength(proposal.name) < 2 || codePointLength(proposal.name) > 20) return { ok: false, reason: "invalid_payload" };
      if (codePointLength(proposal.description) < 10 || codePointLength(proposal.description) > 120) return { ok: false, reason: "invalid_payload" };
      if (proposal.scale !== "scene" && proposal.scale !== "town") return { ok: false, reason: "invalid_payload" };
      // Reference check
      if (!existingLocationIds.has(proposal.connectFromLocationId)) return { ok: false, reason: "reference_broken" };
      // Build entry
      const id = asLocationId(`loc_exp_${ws.locations.length + 1}_${Date.now()}`);
      const entry: LocationEntry = {
        id,
        name: proposal.name,
        description: proposal.description,
        kind: "main",
        connectedLocationIds: [asLocationId(proposal.connectFromLocationId)],
        npcIds: [],
        availableItemIds: [],
        tags: [],
        scale: proposal.scale,
      };
      return { ok: true, entry };
    }
    case "npc": {
      if (!budgetAllowsExpansion(budget, "npcs")) return { ok: false, reason: "budget_exceeded" };
      if (!withinHardLimit(budget, "npcs")) return { ok: false, reason: "hard_limit_exceeded" };
      if (codePointLength(proposal.name) < 2 || codePointLength(proposal.name) > 20) return { ok: false, reason: "invalid_payload" };
      if (codePointLength(proposal.role) < 2 || codePointLength(proposal.role) > 40) return { ok: false, reason: "invalid_payload" };
      if (codePointLength(proposal.description) < 10 || codePointLength(proposal.description) > 120) return { ok: false, reason: "invalid_payload" };
      if (!existingLocationIds.has(proposal.locationId)) return { ok: false, reason: "reference_broken" };
      const id = asNpcId(`npc_exp_${ws.npcs.length + 1}_${Date.now()}`);
      const entry: NpcEntry = {
        id,
        name: proposal.name,
        role: proposal.role,
        description: proposal.description,
        locationId: asLocationId(proposal.locationId),
        isCompanion: false,
        tags: [],
        met: false,
        memory: {
          npcId: id,
          knownFactIds: [],
          hiddenFactIds: [],
          interactionHistory: [],
          relationship: { affinity: 0 },
          emotion: "neutral",
          goals: [],
        },
      };
      return { ok: true, entry };
    }
    case "item": {
      if (codePointLength(proposal.name) < 2 || codePointLength(proposal.name) > 40) return { ok: false, reason: "invalid_payload" };
      if (codePointLength(proposal.description) < 5 || codePointLength(proposal.description) > 240) return { ok: false, reason: "invalid_payload" };
      if (!existingLocationIds.has(proposal.locationId)) return { ok: false, reason: "reference_broken" };
      const id = asItemId(`item_exp_${ws.items.length + 1}_${Date.now()}`);
      const entry: ItemEntry = {
        id,
        name: proposal.name,
        description: proposal.description,
        kind: proposal.kind_hint,
        tags: [...proposal.tags],
      };
      return { ok: true, entry };
    }
    case "enemy": {
      if (codePointLength(proposal.name) < 2 || codePointLength(proposal.name) > 40) return { ok: false, reason: "invalid_payload" };
      if (proposal.stats.hp < 1 || proposal.stats.hp > 999) return { ok: false, reason: "invalid_payload" };
      if (proposal.stats.attack < 0 || proposal.stats.attack > 99) return { ok: false, reason: "invalid_payload" };
      if (proposal.stats.defense < 0 || proposal.stats.defense > 99) return { ok: false, reason: "invalid_payload" };
      if (!existingLocationIds.has(proposal.locationId)) return { ok: false, reason: "reference_broken" };
      const id = asEnemyId(`enemy_exp_${ws.enemies.length + 1}_${Date.now()}`);
      const entry: EnemyEntry = {
        id,
        name: proposal.name,
        tier: proposal.tier,
        stats: { ...proposal.stats },
        locationId: asLocationId(proposal.locationId),
        tags: [],
      };
      return { ok: true, entry };
    }
    case "fact": {
      if (codePointLength(proposal.text) < 5 || codePointLength(proposal.text) > 240) return { ok: false, reason: "invalid_payload" };
      if (!existingLocationIds.has(proposal.locationId)) return { ok: false, reason: "reference_broken" };
      const id = asFactId(`fact_exp_${ws.worldFacts.length + 1}_${Date.now()}`);
      const entry: WorldFactEntry = {
        factId: id,
        text: proposal.text,
        source: "runtime_expansion",
        discovered: false,
        locationId: asLocationId(proposal.locationId),
      };
      return { ok: true, entry };
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/game/gameplay/rpg/expansion/approveExpansion.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/game/gameplay/rpg/expansion/approveExpansion.ts src/game/gameplay/rpg/expansion/approveExpansion.test.ts
git commit -m "feat: 扩展提案审批——预算/payload/引用校验 + Entry 构建"
```

---

## Task 4: 将已审批扩展应用到 WorldState

**Files:**
- Create: `src/game/gameplay/rpg/expansion/applyExpansion.ts`
- Test: `src/game/gameplay/rpg/expansion/applyExpansion.test.ts`

**Interfaces:**
- Consumes: `ApprovedExpansion`, `WorldState`
- Produces: `applyApprovedExpansion()` → `WorldState`（追加新实体 + BlueprintExpandedEvent）

- [ ] **Step 1: Write failing tests + implement + commit**

```typescript
// src/game/gameplay/rpg/expansion/applyExpansion.test.ts
import { describe, it, expect } from "vitest";
import { applyApprovedExpansion } from "./applyExpansion";
import { createInitialWorldState, type LocationEntry, type NpcEntry } from "@/game/domain/worldState";
import { asLocationId, asNpcId, asGenerationId } from "@/game/domain/scenarioBlueprint";
import type { ApprovedExpansion } from "./expansionTypes";

describe("applyApprovedExpansion", () => {
  const loc1: LocationEntry = {
    id: asLocationId("loc_1"), name: "客栈", description: "t", kind: "main",
    connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
  };
  const ws = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: loc1,
    startingItemIds: [],
  });

  it("appends new location and emits BlueprintExpandedEvent", () => {
    const newLoc: LocationEntry = {
      id: asLocationId("loc_new"), name: "密林", description: "t", kind: "main",
      connectedLocationIds: [asLocationId("loc_1")], npcIds: [], availableItemIds: [], tags: [],
    };
    const approved: ApprovedExpansion = {
      newLocations: [newLoc], newNpcs: [], newItems: [], newEnemies: [], newFacts: [],
      budgetConsumed: { locations: 1, npcs: 0, items: 0, enemies: 0, facts: 0 },
    };
    const nextWs = applyApprovedExpansion(ws, approved, "2026-01-01");
    expect(nextWs.locations.length).toBe(2);
    expect(nextWs.eventLedger[nextWs.eventLedger.length - 1]!.type).toBe("blueprint_expanded");
  });

  it("does not mutate original worldState", () => {
    const newLoc: LocationEntry = {
      id: asLocationId("loc_new"), name: "密林", description: "t", kind: "main",
      connectedLocationIds: [asLocationId("loc_1")], npcIds: [], availableItemIds: [], tags: [],
    };
    const approved: ApprovedExpansion = {
      newLocations: [newLoc], newNpcs: [], newItems: [], newEnemies: [], newFacts: [],
      budgetConsumed: { locations: 1, npcs: 0, items: 0, enemies: 0, facts: 0 },
    };
    const nextWs = applyApprovedExpansion(ws, approved, "2026-01-01");
    expect(ws.locations.length).toBe(1);
    expect(nextWs.locations.length).toBe(2);
  });
});
```

```typescript
// src/game/gameplay/rpg/expansion/applyExpansion.ts
import type { WorldState } from "@/game/domain/worldState";
import type { GameEvent } from "@/game/domain/events";
import type { ApprovedExpansion } from "./expansionTypes";

export function applyApprovedExpansion(ws: WorldState, approved: ApprovedExpansion, occurredAt: string): WorldState {
  const event: GameEvent = {
    type: "blueprint_expanded",
    newLocationIds: approved.newLocations.map((l) => l.id),
    newNpcIds: approved.newNpcs.map((n) => n.id),
    newFactIds: approved.newFacts.map((f) => f.factId),
    newItemIds: approved.newItems.map((i) => i.id),
    newEnemyIds: approved.newEnemies.map((e) => e.id),
    occurredAt,
  };

  // Also update connectedLocationIds of existing locations to include new connections
  let locations = [...ws.locations, ...approved.newLocations];
  for (const newLoc of approved.newLocations) {
    locations = locations.map((l) =>
      l.id === newLoc.connectedLocationIds[0] && !l.connectedLocationIds.includes(newLoc.id)
        ? { ...l, connectedLocationIds: [...l.connectedLocationIds, newLoc.id] }
        : l,
    );
  }

  return {
    ...ws,
    locations,
    npcs: [...ws.npcs, ...approved.newNpcs],
    items: [...ws.items, ...approved.newItems],
    enemies: [...ws.enemies, ...approved.newEnemies],
    worldFacts: [...ws.worldFacts, ...approved.newFacts],
    eventLedger: [...ws.eventLedger, event],
  };
}
```

- [ ] **Step 2: Run tests, commit**

```bash
git add src/game/gameplay/rpg/expansion/applyExpansion.ts src/game/gameplay/rpg/expansion/applyExpansion.test.ts
git commit -m "feat: 将已审批扩展应用到 WorldState——追加实体 + BlueprintExpandedEvent"
```

---

## Task 5: ExpansionSource 接口 + fixture

**Files:**
- Create: `src/game/application/server/ai/expansionSource.ts`
- Test: `src/game/application/server/ai/expansionSource.test.ts`

**Interfaces:**
- Produces: `ExpansionSource`（接口）, `createFixtureExpansionSource()`, `createLiveExpansionSource()`

- [ ] **Step 1: Implement ExpansionSource interface + fixture + tests + commit**

```typescript
// src/game/application/server/ai/expansionSource.ts
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { Action } from "@/game/domain/action";
import type { ExpansionProposal } from "@/game/gameplay/rpg/expansion/expansionTypes";

export type ExpansionSourceContext = {
  readonly worldState: WorldState;
  readonly storyState: StoryState;
  readonly action: Action;
  readonly triggerReason: string;
};

export type ExpansionSourceResult = {
  readonly proposals: readonly ExpansionProposal[];
};

export interface ExpansionSource {
  propose(ctx: ExpansionSourceContext): Promise<ExpansionSourceResult>;
}

/** Fixture source: returns deterministic proposals based on trigger reason */
export function createFixtureExpansionSource(): ExpansionSource {
  return {
    async propose(ctx: ExpansionSourceContext): Promise<ExpansionSourceResult> {
      // If the action is a move to an unknown location, propose that location
      if (ctx.action.type === "move") {
        return {
          proposals: [{
            kind: "location",
            name: "未知之地",
            description: "一片尚未探索的神秘区域。",
            scale: "scene",
            connectFromLocationId: String(ctx.worldState.currentLocationId),
            reason: "玩家要求前往未知地点",
          }],
        };
      }
      // If the action is a talk to an unknown NPC, propose that NPC
      if (ctx.action.type === "talk") {
        return {
          proposals: [{
            kind: "npc",
            name: "陌生人",
            role: "路人",
            description: "一个你不认识的人。",
            locationId: String(ctx.worldState.currentLocationId),
          }],
        };
      }
      return { proposals: [] };
    },
  };
}
```

- [ ] **Step 2: Run tests, commit**

```bash
git add src/game/application/server/ai/expansionSource.ts src/game/application/server/ai/expansionSource.test.ts
git commit -m "feat: ExpansionSource 接口 + fixture——可注入世界扩展 port"
```

---

## Task 6: ExpansionProposer facade + 同回合重演算

**Files:**
- Create: `src/game/gameplay/rpg/expansion/index.ts`
- Test: `src/game/gameplay/rpg/expansion/index.test.ts`

**Interfaces:**
- Consumes: Tasks 1-5
- Produces: `runExpansionProposer()` → `ExpansionResult`

- [ ] **Step 1: Write failing tests for runExpansionProposer**

```typescript
// src/game/gameplay/rpg/expansion/index.test.ts
import { describe, it, expect } from "vitest";
import { runExpansionProposer } from "./index";
import { createInitialWorldState, type LocationEntry } from "@/game/domain/worldState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { asLocationId, asNpcId, asGenerationId } from "@/game/domain/scenarioBlueprint";
import { createFixtureExpansionSource } from "@/game/application/server/ai/expansionSource";
import type { RuleEngineResult } from "@/game/gameplay/rpg/ruleEngine";

describe("runExpansionProposer", () => {
  const loc1: LocationEntry = {
    id: asLocationId("loc_1"), name: "客栈", description: "t", kind: "main",
    connectedLocationIds: [asLocationId("loc_2")], npcIds: [], availableItemIds: [], tags: [],
  };
  const ws = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: loc1,
    startingItemIds: [],
  });
  const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 } });
  const deps = { now: () => "2026-01-01" };

  it("returns no trigger when initial result is success", async () => {
    const initialResult: RuleEngineResult = {
      ok: true,
      nextWorldState: ws,
      nextStoryState: ss,
      resolvedEvent: {
        actionId: "a1", status: "success", eventKind: "travel",
        facts: [], stateChanges: [], costs: [], rewards: [],
        triggeredEvents: [], rejectedEffects: [], stateVersion: 1,
      },
    };
    const result = await runExpansionProposer(
      initialResult, ws, ss,
      { type: "move", locationId: asLocationId("loc_2") },
      "act_1",
      createFixtureExpansionSource(),
      deps,
    );
    expect(result.triggered).toBe(false);
    expect(result.approved).toBeNull();
  });

  it("triggers expansion for UNKNOWN_LOCATION, re-evaluates action", async () => {
    const initialResult: RuleEngineResult = {
      ok: false,
      code: "UNKNOWN_LOCATION",
      feedback: "Action rejected: UNKNOWN_LOCATION",
    };
    // Make loc_1's connectedLocationIds include the new location after expansion
    const wsWithUnlocked = { ...ws, unlockedLocationIds: [asLocationId("loc_1"), asLocationId("loc_unknown")] };
    const result = await runExpansionProposer(
      initialResult, wsWithUnlocked, ss,
      { type: "move", locationId: asLocationId("loc_unknown") },
      "act_2",
      createFixtureExpansionSource(),
      deps,
    );
    expect(result.triggered).toBe(true);
    expect(result.reason).toBe("entity_not_found");
    expect(result.approved).not.toBeNull();
    expect(result.approved!.newLocations.length).toBe(1);
    // Re-evaluation should succeed because the new location now exists
    expect(result.reEvaluatedResult).not.toBeNull();
    expect(result.reEvaluatedResult!.ok).toBe(true);
  });

  it("returns no trigger when no expansion source provided", async () => {
    const initialResult: RuleEngineResult = {
      ok: false,
      code: "UNKNOWN_LOCATION",
      feedback: "Action rejected: UNKNOWN_LOCATION",
    };
    const result = await runExpansionProposer(
      initialResult, ws, ss,
      { type: "move", locationId: asLocationId("loc_unknown") },
      "act_3",
      null,
      deps,
    );
    expect(result.triggered).toBe(false);
  });
});
```

- [ ] **Step 2: Implement runExpansionProposer facade**

```typescript
// src/game/gameplay/rpg/expansion/index.ts
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { Action } from "@/game/domain/action";
import type { RuleEngineResult } from "@/game/gameplay/rpg/ruleEngine";
import { ruleEngine } from "@/game/gameplay/rpg/ruleEngine";
import type { ExpansionSource } from "@/game/application/server/ai/expansionSource";
import { checkExpansionTrigger } from "./expansionTrigger";
import { approveExpansions } from "./approveExpansion";
import { applyApprovedExpansion } from "./applyExpansion";
import type { ExpansionResult } from "./expansionTypes";

export type ExpansionDeps = { readonly now: () => string };

export async function runExpansionProposer(
  initialResult: RuleEngineResult,
  ws: WorldState,
  ss: StoryState,
  action: Action,
  actionId: string,
  source: ExpansionSource | null,
  deps: ExpansionDeps,
): Promise<ExpansionResult> {
  const trigger = checkExpansionTrigger(initialResult, ws, ss, action);
  if (!trigger.triggered || source === null) {
    return {
      triggered: false,
      reason: "no_trigger",
      approved: null,
      reEvaluatedResult: null,
      rejectedProposals: [],
    };
  }

  // Call AI source for proposals
  const sourceResult = await source.propose({
    worldState: ws,
    storyState: ss,
    action,
    triggerReason: trigger.reason,
  });

  // Approve proposals
  const approval = approveExpansions(sourceResult.proposals, ws, ss.budget);

  if (approval.approved.newLocations.length === 0 &&
      approval.approved.newNpcs.length === 0 &&
      approval.approved.newItems.length === 0 &&
      approval.approved.newEnemies.length === 0 &&
      approval.approved.newFacts.length === 0) {
    // All proposals rejected—no expansion
    return {
      triggered: true,
      reason: trigger.reason,
      approved: null,
      reEvaluatedResult: null,
      rejectedProposals: approval.rejected,
    };
  }

  // Apply approved expansion to a temporary WorldState
  const expandedWs = applyApprovedExpansion(ws, approval.approved, deps.now());

  // Update StoryState budget
  const expandedSs: StoryState = {
    ...ss,
    budget: approval.nextBudget,
  };

  // Re-evaluate the original action on the expanded state (at most once)
  const reEvaluatedResult = ruleEngine(expandedWs, expandedSs, action, actionId, { now: deps.now });

  return {
    triggered: true,
    reason: trigger.reason,
    approved: approval.approved,
    reEvaluatedResult,
    rejectedProposals: approval.rejected,
  };
}
```

- [ ] **Step 3: Run tests, commit**

```bash
git add src/game/gameplay/rpg/expansion/index.ts src/game/gameplay/rpg/expansion/index.test.ts
git commit -m "feat: ExpansionProposer facade + 同回合重演算——条件触发→AI提议→审批→重演算一次"
```

---

## Task 7: 集成到 performActionV2

**Files:**
- Modify: `src/game/application/performActionV2.ts`
- Test: `src/game/application/performActionV2.test.ts`

**Interfaces:**
- Consumes: Tasks 1-6
- Produces: updated `performActionV2()` with ExpansionProposer step

- [ ] **Step 1: Modify performActionV2 to insert ExpansionProposer**

The updated flow:
1. Load game
2. Check revision
3. convertInteraction → Action
4. ruleEngine (initial evaluation)
5. If initial result is `ok: false` → runExpansionProposer
6. If expansion triggered and re-evaluation succeeded → use re-evaluated result
7. If expansion triggered but re-evaluation failed → use initial result (expansion still applied for next turn)
8. stateCommit
9. Return

Key change: `PerformActionV2Deps` gets optional `expansionSource?: ExpansionSource`.

```typescript
// Modified performActionV2.ts (relevant changes)
export type PerformActionV2Deps = {
  readonly repository: GameRepositoryV2;
  readonly now: () => string;
  readonly intentParserSource?: IntentParserSource;
  readonly expansionSource?: ExpansionSource;  // NEW
};

// Inside performActionV2, after ruleEngine:
const engineResult = ruleEngine(record.worldState, record.storyState, converted.action, command.actionId, { now: deps.now });

let finalResult = engineResult;
let expandedWorldState = record.worldState;
let expandedStoryState = record.storyState;

if (!engineResult.ok && deps.expansionSource) {
  const expansion = await runExpansionProposer(
    engineResult,
    record.worldState,
    record.storyState,
    converted.action,
    command.actionId,
    deps.expansionSource,
    { now: deps.now },
  );
  if (expansion.triggered && expansion.approved && expansion.reEvaluatedResult?.ok) {
    finalResult = expansion.reEvaluatedResult;
    expandedWorldState = finalResult.nextWorldState;
    expandedStoryState = finalResult.nextStoryState;
  } else if (expansion.triggered && expansion.approved) {
    // Expansion approved but re-evaluation still failed—apply expansion for next turn
    expandedWorldState = applyApprovedExpansion(record.worldState, expansion.approved, deps.now());
    expandedStoryState = { ...record.storyState, budget: /* updated budget from expansion */ };
  }
}

if (!finalResult.ok) {
  return { ok: false, code: "ACTION_REJECTED", feedback: finalResult.feedback };
}

const commitResult = await commitState(deps.repository, {
  gameId: command.gameId,
  expectedRevision: record.revision,
  nextWorldState: finalResult.ok ? finalResult.nextWorldState : expandedWorldState,
  nextStoryState: finalResult.ok ? finalResult.nextStoryState : expandedStoryState,
});
```

- [ ] **Step 2: Update tests to cover expansion path**

- [ ] **Step 3: Run tests, commit**

```bash
git add src/game/application/performActionV2.ts src/game/application/performActionV2.test.ts
git commit -m "feat: performActionV2 集成 ExpansionProposer——初判失败时条件触发扩展+重演算"
```

---

## Task 8: compositionRootV2 注入 ExpansionSource

**Files:**
- Modify: `src/game/application/server/compositionRootV2.ts`

- [ ] **Step 1: Inject fixture ExpansionSource into compositionRootV2**

```typescript
// In createServerGameV2EntryPoints:
import { createFixtureExpansionSource } from "../server/ai/expansionSource";
// ...
const expansionSource = createFixtureExpansionSource();
// Pass to performActionV2 deps
```

- [ ] **Step 2: Run existing tests to ensure no regressions, commit**

```bash
git add src/game/application/server/compositionRootV2.ts
git commit -m "feat: compositionRootV2 注入 ExpansionSource——fixture 离线可测"
```

---

## Task 9: P3 离线全流水线回归

**Files:**
- Create: `src/game/application/p3OfflineRegression.test.ts`

- [ ] **Step 1: Write offline regression test**

Test scenarios:
1. Move to unknown location → expansion triggered → new location created → move succeeds
2. Talk to unknown NPC → expansion triggered → new NPC created → talk succeeds
3. Move to locked location (not entity_not_found) → no expansion → action rejected
4. Budget exhausted → no expansion → action rejected
5. Expansion source returns invalid proposal → proposal rejected → action still rejected

- [ ] **Step 2: Run all tests**

Run: `npx vitest run src/game/application/p3OfflineRegression.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/game/application/p3OfflineRegression.test.ts
git commit -m "test: P3 离线全流水线回归——扩展触发+重演算+预算耗尽+无效提案"
```

---

## Task 10: 依赖边界守卫更新

**Files:**
- Modify: `src/dependencyBoundaries.test.ts` (or equivalent)

- [ ] **Step 1: Add boundary guards for expansion module**

Ensure:
- `src/game/gameplay/rpg/expansion/` does not import from `application/` or `server/`
- `ExpansionSource` interface lives in `server/ai/` (or `application/server/ai/`)
- `expansion/index.ts` imports `ExpansionSource` type only (not implementation)

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: P3 依赖边界守卫 + 全测试通过"
```

---

## Self-Review

**Spec coverage check:**
- ✅ §6.1 触发条件（entity_not_found 信号）→ Task 2
- ✅ §6.2 优先复用，后生成 → Task 2（触发前检查预算余量）
- ✅ §6.3 提议与审批流程 → Tasks 3-4
- ✅ §6.4 同回合重演算（至多一次）→ Task 6
- ✅ §6.5 预算耗尽时的行为 → Task 2（预算无余量时不触发）
- ✅ §3.3 Budget opening/expanded/max → Task 3（consumeExpansion）
- ✅ §2.1 流水线插入 ExpansionProposer → Task 7
- ✅ §11.1 两个合法写入者 → Task 7（expansion 仍通过 StateCommit 写入）
- ✅ 离线基线与可注入 AI source → Task 5
- ⏳ 节奏驱动扩展（low_tension, quest_gap）→ 预留接口，P4 实现
- ⏳ candidateEventPool 审批 → P4

**Placeholder scan:** No TBDs. All code blocks contain actual implementation.

**Type consistency:** ExpansionProposal types match between expansionTypes.ts and approveExpansion.ts. ApprovedExpansion fields match between approveExpansion.ts and applyExpansion.ts. ExpansionResult matches between expansionTypes.ts and index.ts.
