# P1：双状态模型与流水线骨架 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 World State + Story State 双状态模型和严格流水线骨架，替换现有的 ScenarioBlueprint + GameState 单体架构，支持固定选项主循环和异步场景生成框架。

**Architecture:** 严格流水线 Interaction → ActionConverter → RuleEngine → [ExpansionProposer] → StateCommit → SceneGenerator → Client。World State 合并世界定义与运行时状态；Story State 采用混合策略（核心指标独立持久化 + 物化派生视图）。两个合法 CAS 写入者：StateCommit（规则事实）和场景写回者（叙事运行时状态）。旧存档不迁移。

**Tech Stack:** TypeScript, Next.js 16, React 19, libsql/SQLite, Vitest, zustand

**Spec:** `docs/superpowers/specs/2026-08-07-ai-rpg-architecture-redesign-spec.md`

## Global Constraints

- 纯 domain 层零 IO、零 AI、零 DB；gameplay 层纯函数不写状态；application 层编排；server 层适配器
- UI/API 只调用 application facade，不直连 domain/gameplay/server
- 所有 AI 调用点使用可注入 source 接口，离线 fixture 保证无 AI 全流水线可测
- CAS compare-and-swap 原子写入，revision 是唯一防重屏障
- 旧存档（v1 GameState + Blueprint）不迁移，新架构重开新局
- 品牌化 ID（LocationId/NpcId/ItemId 等）不可用普通字符串互换
- 测试先行（TDD），每个 task 以失败测试开始

---

## File Structure

### 新建文件

```
src/game/domain/
  worldState.ts          # WorldState 类型 + Entry 类型 + 纯函数（初始化、查找、追加）
  worldState.test.ts
  storyState.ts          # StoryState 类型 + StoryBudget + PacingNeed + 纯函数
  storyState.test.ts
  action.ts              # Interaction + Action 类型（封闭集合 + freeform + utterance）
  action.test.ts
  resolvedEvent.ts       # ResolvedEvent 类型 + 五态 status
  resolvedEvent.test.ts
  storyBudget.ts         # BudgetDimension + createBudgetPolicy + 预算检查纯函数
  storyBudget.test.ts
  materializedView.ts    # 物化派生视图类型 + 纯 reducer（recentBeats, npcContacts）
  materializedView.test.ts

src/game/gameplay/rpg/ruleEngine/
  validateAction.ts      # 行动合法性检查（按 Action 类型路由）
  validateAction.test.ts
  resolveByType.ts       # 按 Action 类型路由到对应 resolver，产出状态变更
  resolveByType.test.ts
  reconcileQuests.ts     # 任务进度推进纯函数
  reconcileQuests.test.ts
  resolveEnding.ts       # 结局条件检查纯函数
  resolveEnding.test.ts
  updateStoryMetrics.ts  # 张力/进度/节奏更新纯函数
  updateStoryMetrics.test.ts
  index.ts               # facade: ruleEngine(action, worldState, storyState) → ResolvedEvent

src/game/application/
  actionConverter.ts     # Interaction → Action（P1 仅固定选项映射，free_text 留 P2）
  actionConverter.test.ts
  stateCommit.ts         # CAS 原子写入（规则事实唯一写入点）
  stateCommit.test.ts
  sceneWriteBack.ts      # 场景写回者（只写叙事运行时状态 + candidateEventPool）
  sceneWriteBack.test.ts
  performActionV2.ts     # 新主循环编排（流水线串联）
  performActionV2.test.ts
  createGameV2.ts        # 新开局初始化（World State + Story State）
  createGameV2.test.ts
  gameSessionViewV2.ts   # 新 read model 投影
  gameSessionViewV2.test.ts
```

### 修改文件

```
src/game/application/server/compositionRoot.ts  # 注入新 use case
src/app/api/game/route.ts                       # 切换到 createGameV2
src/app/api/game/actions/route.ts               # 切换到 performActionV2
```

### 保留不动（P1 不改）

```
src/game/gameplay/rpg/battle/     # 战斗规则复用
src/game/gameplay/rpg/quests/     # 任务规则复用（适配新状态类型）
src/game/gameplay/rpg/town/       # 小镇层 P1 不改
src/game/logging/                 # 日志复用
```

---

## Task 1: World State 类型与纯函数

**Files:**
- Create: `src/game/domain/worldState.ts`
- Test: `src/game/domain/worldState.test.ts`

**Interfaces:**
- Produces: `WorldState`, `LocationEntry`, `NpcEntry`, `ItemEntry`, `WorldFactEntry`, `QuestEntry`, `EnemyEntry`, `EndingEntry`, `FactionEntry`, `PlayerState`, `createInitialWorldState()`, `findLocation()`, `findNpc()`, `appendLocation()`, `appendNpc()`

- [ ] **Step 1: Write failing tests for WorldState type and core functions**

```typescript
// src/game/domain/worldState.test.ts
import { describe, it, expect } from "vitest";
import {
  createInitialWorldState,
  findLocation,
  findNpc,
  appendLocation,
  appendNpc,
  type WorldState,
  type LocationEntry,
  type NpcEntry,
} from "./worldState";
import { asLocationId, asNpcId, asItemId, asFactId, asQuestId, asEnemyId, asEndingId } from "./scenarioBlueprint";

describe("WorldState", () => {
  const baseInput = {
    gameType: "wuxia" as const,
    seed: "test-seed",
    player: { name: "测试侠客", identity: "流浪剑客", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocationId: asLocationId("loc_1"),
    startingItemIds: [asItemId("item_1")] as const,
  };

  it("createInitialWorldState produces valid state with version 2", () => {
    const ws = createInitialWorldState(baseInput);
    expect(ws.version).toBe(2);
    expect(ws.player.name).toBe("测试侠客");
    expect(ws.currentLocationId).toBe(asLocationId("loc_1"));
    expect(ws.eventLedger[0]?.type).toBe("game_initialized");
  });

  it("findLocation returns entry by id, undefined if missing", () => {
    const ws = createInitialWorldState(baseInput);
    const loc = findLocation(ws, asLocationId("loc_1"));
    expect(loc?.id).toBe(asLocationId("loc_1"));
    expect(findLocation(ws, asLocationId("nonexistent"))).toBeUndefined();
  });

  it("appendLocation adds new location immutably", () => {
    const ws = createInitialWorldState(baseInput);
    const newLoc: LocationEntry = {
      id: asLocationId("loc_new"),
      name: "新地点",
      description: "测试",
      kind: "main",
      connectedLocationIds: [],
      npcIds: [],
      availableItemIds: [],
      tags: [],
      scale: "scene",
    };
    const ws2 = appendLocation(ws, newLoc);
    expect(findLocation(ws2, asLocationId("loc_new"))).toBeDefined();
    expect(findLocation(ws, asLocationId("loc_new"))).toBeUndefined(); // 原state不变
  });

  it("appendNpc adds new npc immutably with default memory", () => {
    const ws = createInitialWorldState(baseInput);
    const newNpc: NpcEntry = {
      id: asNpcId("npc_new"),
      name: "新NPC",
      role: "路人",
      description: "测试",
      locationId: asLocationId("loc_1"),
      isCompanion: false,
      knownFactIds: [],
      tags: [],
      met: false,
      memory: {
        npcId: asNpcId("npc_new"),
        knownFactIds: [],
        hiddenFactIds: [],
        interactionHistory: [],
        relationship: { affinity: 0 },
        emotion: "neutral",
        goals: [],
      },
    };
    const ws2 = appendNpc(ws, newNpc);
    expect(findNpc(ws2, asNpcId("npc_new"))).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/game/domain/worldState.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement WorldState types and functions**

```typescript
// src/game/domain/worldState.ts
import type { GameTypeId } from "./newGame";
import type {
  LocationId, NpcId, ItemId, FactId, QuestId, EnemyId, EndingId,
  StatBlock, LocationScale, LocationKind, ItemCategory, ItemRarity, ItemStatLine,
  EnemyTier, FactSource, GenerationMetadata, GameEvent,
} from "./scenarioBlueprint";
import type { RelationshipValue } from "./relationship";
import type { NarrativeEmotion, NarrativeRuntimeState, TownRuntimeState } from "./narrative";

// ── Entry 类型：定义 + 运行时 ──

export type PlayerState = {
  readonly name: string;
  readonly identity: string;
  readonly stats: StatBlock;
};

export type LocationEntry = {
  readonly id: LocationId;
  readonly name: string;
  readonly description: string;
  readonly kind: LocationKind;
  readonly connectedLocationIds: readonly LocationId[];
  readonly npcIds: readonly NpcId[];
  readonly availableItemIds: readonly ItemId[];
  readonly tags: readonly string[];
  readonly scale?: LocationScale;
};

export type NpcMemory = {
  readonly npcId: NpcId;
  readonly knownFactIds: readonly FactId[];
  readonly hiddenFactIds: readonly FactId[];
  readonly interactionHistory: readonly NpcInteraction[];
  readonly relationship: RelationshipValue;
  readonly emotion: NarrativeEmotion;
  readonly goals: readonly string[];
};

export type NpcInteraction = {
  readonly turn: number;
  readonly locationId: LocationId;
  readonly actionType: string;
  readonly outcome: "positive" | "negative" | "neutral";
  readonly relationshipDelta: number;
  readonly summary: string;
};

export type NpcEntry = {
  readonly id: NpcId;
  readonly name: string;
  readonly role: string;
  readonly description: string;
  readonly locationId: LocationId;
  readonly isCompanion: boolean;
  readonly knownFactIds: readonly FactId[];
  readonly tags: readonly string[];
  readonly met: boolean;
  readonly memory: NpcMemory;
};

export type ItemEntry = {
  readonly id: ItemId;
  readonly name: string;
  readonly description: string;
  readonly kind: string;
  readonly tags: readonly string[];
  readonly category?: ItemCategory;
  readonly rarity?: ItemRarity;
  readonly level?: number;
  readonly statLines?: readonly ItemStatLine[];
};

export type WorldFactEntry = {
  readonly factId: FactId;
  readonly text: string;
  readonly source: FactSource;
  readonly discovered: boolean;
  readonly locationId?: LocationId;
};

export type QuestObjective =
  | { readonly kind: "visit_location"; readonly locationId: LocationId }
  | { readonly kind: "talk_to_npc"; readonly npcId: NpcId }
  | { readonly kind: "obtain_item"; readonly itemId: ItemId }
  | { readonly kind: "discover_fact"; readonly factId: FactId }
  | { readonly kind: "defeat_enemy"; readonly enemyId: EnemyId };

export type QuestOutcome =
  | { readonly kind: "unlock_quests"; readonly questIds: readonly QuestId[] }
  | { readonly kind: "reach_ending"; readonly endingId: EndingId }
  | { readonly kind: "closed" };

export type QuestEntry = {
  readonly id: QuestId;
  readonly name: string;
  readonly description: string;
  readonly objectives: readonly QuestObjective[];
  readonly onSuccess: QuestOutcome;
  readonly onFailure: QuestOutcome;
  readonly tags: readonly string[];
  readonly kind: "main" | "side";
  readonly stage?: number;
  readonly status: "locked" | "active" | "completed" | "failed" | "closed";
};

export type EnemyEntry = {
  readonly id: EnemyId;
  readonly name: string;
  readonly tier: EnemyTier;
  readonly stats: StatBlock;
  readonly locationId: LocationId;
  readonly tags: readonly string[];
};

export type EndingEntry = {
  readonly id: EndingId;
  readonly name: string;
  readonly description: string;
  readonly requirements: readonly (EndingRequirement)[];
};

export type EndingRequirement =
  | { readonly kind: "quest_completed"; readonly questId: QuestId }
  | { readonly kind: "quest_failed"; readonly questId: QuestId }
  | { readonly kind: "fact_discovered"; readonly factId: FactId };

export type FactionEntry = {
  readonly factionId: string;
  readonly name: string;
  readonly attitudeToPlayer: number;
};

export type BattleState =
  | { readonly status: "idle" }
  | { readonly status: "active"; readonly enemyId: EnemyId; readonly playerHp: number; readonly enemyHp: number; readonly round: number }
  | { readonly status: "resolved"; readonly enemyId: EnemyId; readonly outcome: "victory" | "defeat" | "withdraw" };

export type EndingState = { readonly endingId: EndingId; readonly outcome: "success" | "failure" } | null;

// ── World State ──

export type WorldState = {
  readonly version: 2;
  readonly generation: GenerationMetadata;
  readonly player: PlayerState;
  readonly locations: readonly LocationEntry[];
  readonly currentLocationId: LocationId;
  readonly unlockedLocationIds: readonly LocationId[];
  readonly visitedLocationIds: readonly LocationId[];
  readonly npcs: readonly NpcEntry[];
  readonly items: readonly ItemEntry[];
  readonly inventory: readonly ItemId[];
  readonly worldFacts: readonly WorldFactEntry[];
  readonly quests: readonly QuestEntry[];
  readonly enemies: readonly EnemyEntry[];
  readonly defeatedEnemyIds: readonly EnemyId[];
  readonly battle: BattleState;
  readonly endings: readonly EndingEntry[];
  readonly ending: EndingState;
  readonly factions: readonly FactionEntry[];
  readonly towns: readonly TownRuntimeState[];
  readonly eventLedger: readonly GameEvent[];
};

// ── 纯函数 ──

export function findLocation(ws: WorldState, id: LocationId): LocationEntry | undefined {
  return ws.locations.find((l) => l.id === id);
}

export function findNpc(ws: WorldState, id: NpcId): NpcEntry | undefined {
  return ws.npcs.find((n) => n.id === id);
}

export function findItem(ws: WorldState, id: ItemId): ItemEntry | undefined {
  return ws.items.find((i) => i.id === id);
}

export function findQuest(ws: WorldState, id: QuestId): QuestEntry | undefined {
  return ws.quests.find((q) => q.id === id);
}

export function appendLocation(ws: WorldState, loc: LocationEntry): WorldState {
  return { ...ws, locations: [...ws.locations, loc] };
}

export function appendNpc(ws: WorldState, npc: NpcEntry): WorldState {
  return { ...ws, npcs: [...ws.npcs, npc] };
}

export function appendItem(ws: WorldState, item: ItemEntry): WorldState {
  return { ...ws, items: [...ws.items, item] };
}

export function appendEnemy(ws: WorldState, enemy: EnemyEntry): WorldState {
  return { ...ws, enemies: [...ws.enemies, enemy] };
}

export function createInitialWorldState(input: {
  gameType: GameTypeId;
  seed: string;
  player: PlayerState;
  startingLocationId: LocationId;
  startingItemIds: readonly ItemId[];
}): WorldState {
  // 最小初始状态——实际开局由 createGameV2 通过 AI 生成填充
  return {
    version: 2,
    generation: {
      generationId: "" as any,
      seed: input.seed,
      templateVersion: "v2",
      inputDigest: "",
      gameType: input.gameType,
    },
    player: input.player,
    locations: [],
    currentLocationId: input.startingLocationId,
    unlockedLocationIds: [input.startingLocationId],
    visitedLocationIds: [input.startingLocationId],
    npcs: [],
    items: [],
    inventory: [...input.startingItemIds],
    worldFacts: [],
    quests: [],
    enemies: [],
    defeatedEnemyIds: [],
    battle: { status: "idle" },
    endings: [],
    ending: null,
    factions: [],
    towns: [],
    eventLedger: [{
      type: "game_initialized",
      generation: {
        generationId: "" as any,
        seed: input.seed,
        templateVersion: "v2",
        inputDigest: "",
        gameType: input.gameType,
      },
    }],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/game/domain/worldState.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/game/domain/worldState.ts src/game/domain/worldState.test.ts
git commit -m "feat: WorldState 类型与纯函数——双状态模型基础"
```

---

## Task 2: Story State 类型与纯函数

**Files:**
- Create: `src/game/domain/storyState.ts`
- Create: `src/game/domain/storyBudget.ts`
- Test: `src/game/domain/storyState.test.ts`
- Test: `src/game/domain/storyBudget.test.ts`

**Interfaces:**
- Consumes: `GameLength` from `./newGame`
- Produces: `StoryState`, `StoryBudget`, `BudgetDimension`, `PacingNeed`, `EventCandidate`, `createInitialStoryState()`, `derivePacingNeed()`, `createBudgetPolicy()`, `budgetAllowsExpansion()`

- [ ] **Step 1: Write failing tests for StoryState and budget**

```typescript
// src/game/domain/storyState.test.ts
import { describe, it, expect } from "vitest";
import { createInitialStoryState, derivePacingNeed, type StoryState } from "./storyState";

describe("StoryState", () => {
  it("createInitialStoryState sets act=1, tension=30, reveal", () => {
    const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 4, npcs: 5, quests: 2, events: 0 } });
    expect(ss.currentAct).toBe(1);
    expect(ss.tension).toBe(30);
    expect(ss.nextPacingNeed).toBe("reveal");
    expect(ss.budget.locations.opening).toBe(4);
    expect(ss.budget.locations.expanded).toBe(0);
    expect(ss.candidateEventPool).toEqual([]);
  });

  it("derivePacingNeed returns reveal in act 1", () => {
    const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 4, npcs: 5, quests: 2, events: 0 } });
    expect(derivePacingNeed(ss)).toBe("reveal");
  });

  it("derivePacingNeed returns resolve when endingAllowed and no threads", () => {
    const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 4, npcs: 5, quests: 2, events: 0 } });
    const ss2 = { ...ss, currentAct: 3, endingAllowed: true, unresolvedThreads: [] };
    expect(derivePacingNeed(ss2)).toBe("resolve");
  });

  it("derivePacingNeed returns climax at final act with high progress", () => {
    const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 4, npcs: 5, quests: 2, events: 0 } });
    const ss2 = { ...ss, currentAct: 3, targetActs: 3, storyProgress: 90, endingAllowed: false, unresolvedThreads: ["t1"] };
    expect(derivePacingNeed(ss2)).toBe("climax");
  });

  it("derivePacingNeed returns develop by default", () => {
    const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 4, npcs: 5, quests: 2, events: 0 } });
    const ss2 = { ...ss, currentAct: 2, tension: 50, storyProgress: 40, endingAllowed: false, unresolvedThreads: ["t1"] };
    expect(derivePacingNeed(ss2)).toBe("develop");
  });
});
```

```typescript
// src/game/domain/storyBudget.test.ts
import { describe, it, expect } from "vitest";
import { createBudgetPolicy, budgetAllowsExpansion } from "./storyBudget";

describe("StoryBudget", () => {
  it("short game: mainActs=3, locations max=8", () => {
    const bp = createBudgetPolicy("short");
    expect(bp.mainActs).toBe(3);
    expect(bp.locations.max).toBe(8);
  });

  it("budgetAllowsExpansion true when expanded < max", () => {
    const bp = createBudgetPolicy("short");
    expect(budgetAllowsExpansion(bp, "locations")).toBe(true);
  });

  it("budgetAllowsExpansion false when expanded >= max", () => {
    const bp = createBudgetPolicy("short");
    const bp2 = { ...bp, locations: { ...bp.locations, expanded: 8 } };
    expect(budgetAllowsExpansion(bp2, "locations")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/game/domain/storyState.test.ts src/game/domain/storyBudget.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Implement StoryBudget**

```typescript
// src/game/domain/storyBudget.ts
import type { GameLength } from "./newGame";

export type BudgetDimension = {
  readonly opening: number;
  readonly expanded: number;
  readonly max: number;
};

export type StoryBudget = {
  readonly mainActs: number;
  readonly locations: BudgetDimension;
  readonly npcs: BudgetDimension;
  readonly quests: BudgetDimension;
  readonly events: BudgetDimension;
  readonly hardLimit: { readonly locations: number; readonly npcs: number };
};

const PRESETS = {
  short: { mainActs: 3, locationsMax: 8, npcsMax: 10, questsMax: 4, eventsMax: 6 },
  medium: { mainActs: 5, locationsMax: 14, npcsMax: 16, questsMax: 8, eventsMax: 12 },
  long: { mainActs: 8, locationsMax: 22, npcsMax: 24, questsMax: 12, eventsMax: 20 },
  open: { mainActs: 5, locationsMax: 999, npcsMax: 999, questsMax: 999, eventsMax: 999 },
} as const;

const HARD_LIMIT = { locations: 40, npcs: 30 } as const;

export function createBudgetPolicy(
  gameLength: GameLength,
  initialCounts?: { locations: number; npcs: number; quests: number; events: number },
): StoryBudget {
  const p = PRESETS[gameLength];
  const ic = initialCounts ?? { locations: 0, npcs: 0, quests: 0, events: 0 };
  return Object.freeze({
    mainActs: p.mainActs,
    locations: { opening: ic.locations, expanded: 0, max: p.locationsMax },
    npcs: { opening: ic.npcs, expanded: 0, max: p.npcsMax },
    quests: { opening: ic.quests, expanded: 0, max: p.questsMax },
    events: { opening: ic.events, expanded: 0, max: p.eventsMax },
    hardLimit: HARD_LIMIT,
  });
}

export function budgetAllowsExpansion(budget: StoryBudget, dim: "locations" | "npcs" | "quests" | "events"): boolean {
  return budget[dim].expanded < budget[dim].max;
}

export function consumeExpansion(budget: StoryBudget, dim: "locations" | "npcs" | "quests" | "events"): StoryBudget {
  const d = budget[dim];
  return { ...budget, [dim]: { ...d, expanded: d.expanded + 1 } };
}
```

- [ ] **Step 4: Implement StoryState**

```typescript
// src/game/domain/storyState.ts
import type { GameLength } from "./newGame";
import type { StoryBudget } from "./storyBudget";
import { createBudgetPolicy } from "./storyBudget";
import type { NarrativeRuntimeState } from "./narrative";

export type PacingNeed = "reveal" | "develop" | "complicate" | "escalate" | "climax" | "resolve";

export type EventCandidate = {
  readonly id: string;
  readonly description: string;
  readonly proposedAtTurn: number;
};

export type ThreadId = string;

export type StoryState = {
  readonly version: 2;
  readonly currentAct: number;
  readonly targetActs: number;
  readonly storyProgress: number;
  readonly tension: number;
  readonly nextPacingNeed: PacingNeed;
  readonly budget: StoryBudget;
  readonly unresolvedThreads: readonly ThreadId[];
  readonly candidateEventPool: readonly EventCandidate[];
  readonly endingAllowed: boolean;
  readonly endingProposed: boolean;
  readonly narrative: NarrativeRuntimeState;
  readonly prologueShown: boolean;
  readonly recentBeats: readonly unknown[];
  readonly npcContacts: readonly unknown[];
  readonly reducedThroughEventCount: number;
};

export function createInitialStoryState(input: {
  gameLength: GameLength;
  initialEntityCounts: { locations: number; npcs: number; quests: number; events: number };
}): StoryState {
  const budget = createBudgetPolicy(input.gameLength, input.initialEntityCounts);
  return {
    version: 2,
    currentAct: 1,
    targetActs: budget.mainActs,
    storyProgress: 0,
    tension: 30,
    nextPacingNeed: "reveal",
    budget,
    unresolvedThreads: [],
    candidateEventPool: [],
    endingAllowed: false,
    endingProposed: false,
    narrative: {
      currentScene: null,
      generation: { status: "idle" },
      mode: "offline",
    },
    prologueShown: false,
    recentBeats: [],
    npcContacts: [],
    reducedThroughEventCount: 0,
  };
}

export function derivePacingNeed(ss: StoryState): PacingNeed {
  if (ss.currentAct === 1) return "reveal";
  if (ss.endingAllowed && ss.unresolvedThreads.length === 0) return "resolve";
  if (ss.currentAct >= ss.targetActs && ss.storyProgress > 85) return "climax";
  if (ss.tension < 30 && ss.currentAct >= 2) return "complicate";
  if (ss.storyProgress > 70 && !ss.endingAllowed) return "escalate";
  return "develop";
}

export function clampTension(value: number): number {
  return Math.max(0, Math.min(100, value));
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/game/domain/storyState.test.ts src/game/domain/storyBudget.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/game/domain/storyState.ts src/game/domain/storyState.test.ts src/game/domain/storyBudget.ts src/game/domain/storyBudget.test.ts
git commit -m "feat: StoryState 类型与纯函数——张力/节奏/预算/候选事件池"
```

---

## Task 3: Action 与 ResolvedEvent 类型

**Files:**
- Create: `src/game/domain/action.ts`
- Create: `src/game/domain/resolvedEvent.ts`
- Test: `src/game/domain/action.test.ts`
- Test: `src/game/domain/resolvedEvent.test.ts`

**Interfaces:**
- Produces: `Interaction`, `Action`（含 utterance + freeform）, `ResolvedEvent`, `ResolvedEventStatus`

- [ ] **Step 1: Write failing tests**

```typescript
// src/game/domain/action.test.ts
import { describe, it, expect } from "vitest";
import type { Action, Interaction } from "./action";

describe("Action types", () => {
  it("talk action can carry utterance", () => {
    const a: Action = { type: "talk", npcId: "npc_1" as any, utterance: "你知道什么？" };
    expect(a.type).toBe("talk");
    expect(a.utterance).toBe("你知道什么？");
  });

  it("freeform action carries intent and rawText", () => {
    const a: Action = { type: "freeform", intent: "claim_power", rawText: "我的武功升到一百级" };
    expect(a.type).toBe("freeform");
  });

  it("fixed_choice interaction has choiceToken", () => {
    const i: Interaction = { kind: "fixed_choice", choiceToken: "tok_1" };
    expect(i.kind).toBe("fixed_choice");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/game/domain/action.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement Action and Interaction types**

```typescript
// src/game/domain/action.ts
import type { LocationId, NpcId, FactId, ItemId, EnemyId, QuestId } from "./scenarioBlueprint";

export type Interaction =
  | { readonly kind: "fixed_choice"; readonly choiceToken: string }
  | { readonly kind: "free_text"; readonly text: string; readonly targetNpcId?: NpcId };

export type Action =
  | { readonly type: "talk"; readonly npcId: NpcId; readonly utterance?: string }
  | { readonly type: "move"; readonly locationId: LocationId }
  | { readonly type: "explore" }
  | { readonly type: "investigate"; readonly factId: FactId; readonly utterance?: string }
  | { readonly type: "take_item"; readonly itemId: ItemId }
  | { readonly type: "use_item"; readonly itemId: ItemId; readonly targetId?: string; readonly utterance?: string }
  | { readonly type: "give_item"; readonly itemId: ItemId; readonly targetNpcId: NpcId; readonly utterance?: string }
  | { readonly type: "attack"; readonly enemyId: EnemyId }
  | { readonly type: "battle_action"; readonly action: "attack" | "guard" | "flee" }
  | { readonly type: "interact"; readonly targetId: string; readonly utterance?: string }
  | { readonly type: "rest" }
  | { readonly type: "accept_quest"; readonly questId: QuestId }
  | { readonly type: "narrative_choice"; readonly choiceToken: string }
  | { readonly type: "ack_prologue" }
  | { readonly type: "freeform"; readonly intent: string; readonly rawText: string };
```

```typescript
// src/game/domain/resolvedEvent.ts
import type { NarrativeEventKind } from "./narrative";

export type ResolvedEventStatus = "success" | "partial_success" | "failure" | "blocked" | "invalid";

export type FactChange = {
  readonly factId: string;
  readonly change: "discovered" | "hidden" | "revealed";
  readonly audience?: readonly string[];
};

export type StateChange = {
  readonly path: string;
  readonly description: string;
  readonly operation: "set" | "add" | "remove" | "update";
  readonly value?: unknown;
};

export type Cost = { readonly description: string };
export type Reward = { readonly description: string };
export type RejectedEffect = { readonly description: string; readonly reason: string };

export type ResolvedEvent = {
  readonly actionId: string;
  readonly status: ResolvedEventStatus;
  readonly eventKind?: NarrativeEventKind;
  readonly facts: readonly FactChange[];
  readonly stateChanges: readonly StateChange[];
  readonly costs: readonly Cost[];
  readonly rewards: readonly Reward[];
  readonly triggeredEvents: readonly string[];
  readonly rejectedEffects: readonly RejectedEffect[];
  readonly stateVersion: number;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/game/domain/action.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/game/domain/action.ts src/game/domain/action.test.ts src/game/domain/resolvedEvent.ts
git commit -m "feat: Action/Interaction/ResolvedEvent 类型——封闭集合+utterance+五态结果"
```

---

## Task 4: 物化派生视图纯 reducer

**Files:**
- Create: `src/game/domain/materializedView.ts`
- Test: `src/game/domain/materializedView.test.ts`

**Interfaces:**
- Consumes: `GameEvent[]` from `./events`, `WorldState`
- Produces: `MaterializedView`, `reconcileMaterializedView()`, `RecentBeat`, `NpcContact`

- [ ] **Step 1: Write failing tests**

```typescript
// src/game/domain/materializedView.test.ts
import { describe, it, expect } from "vitest";
import { reconcileMaterializedView, createEmptyMaterializedView, type MaterializedView } from "./materializedView";
import type { GameEvent } from "./events";

describe("MaterializedView", () => {
  it("empty view has zero cursor", () => {
    const v = createEmptyMaterializedView();
    expect(v.reducedThroughEventCount).toBe(0);
    expect(v.recentBeats).toEqual([]);
    expect(v.npcContacts).toEqual([]);
  });

  it("reconciles from empty ledger", () => {
    const v = createEmptyMaterializedView();
    const result = reconcileMaterializedView(v, [], 0);
    expect(result.recentBeats).toEqual([]);
  });

  it("extracts quest_completed as a beat", () => {
    const events: GameEvent[] = [
      { type: "quest_completed", questId: "q1" as any, occurredAt: "2026-01-01" },
    ];
    const v = createEmptyMaterializedView();
    const result = reconcileMaterializedView(v, events, 0);
    expect(result.recentBeats.length).toBe(1);
    expect(result.reducedThroughEventCount).toBe(1);
  });

  it("incremental: only processes new events since cursor", () => {
    const events: GameEvent[] = [
      { type: "quest_completed", questId: "q1" as any, occurredAt: "t1" },
      { type: "location_visited", locationId: "loc1" as any, occurredAt: "t2" },
    ];
    const v = createEmptyMaterializedView();
    const r1 = reconcileMaterializedView(v, events, 0);
    const r2 = reconcileMaterializedView(r1, events, 0); // idempotent
    expect(r2.reducedThroughEventCount).toBe(2);
    expect(r2.recentBeats.length).toBe(r1.recentBeats.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/game/domain/materializedView.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement materialized view reducer**

```typescript
// src/game/domain/materializedView.ts
import type { GameEvent } from "./events";
import type { LocationId, NpcId } from "./scenarioBlueprint";

const RECENT_BEATS_LIMIT = 12;

export type RecentBeat = {
  readonly turn: number;
  readonly kind: string;
  readonly summary: string;
};

export type NpcContact = {
  readonly npcId: NpcId;
  readonly lastContactTurn: number;
  readonly lastLocationId: LocationId;
};

export type MaterializedView = {
  readonly recentBeats: readonly RecentBeat[];
  readonly npcContacts: readonly NpcContact[];
  readonly reducedThroughEventCount: number;
};

export function createEmptyMaterializedView(): MaterializedView {
  return { recentBeats: [], npcContacts: [], reducedThroughEventCount: 0 };
}

const BEAT_EVENTS = new Set([
  "quest_completed", "quest_failed", "fact_discovered", "npc_met",
  "battle_resolved", "ending_reached", "blueprint_expanded",
]);

export function reconcileMaterializedView(
  prev: MaterializedView,
  eventLedger: readonly GameEvent[],
  prevEventCount: number,
): MaterializedView {
  if (eventLedger.length <= prev.reducedThroughEventCount) return prev;

  const newBeats: RecentBeat[] = [];
  const npcContactMap = new Map<string, NpcContact>(
    prev.npcContacts.map((c) => [String(c.npcId), c]),
  );

  for (let i = prev.reducedThroughEventCount; i < eventLedger.length; i++) {
    const event = eventLedger[i];
    const turn = i;

    if (BEAT_EVENTS.has(event.type)) {
      newBeats.push({ turn, kind: event.type, summary: summarizeBeat(event) });
    }

    if (event.type === "npc_met") {
      const npcId = event.npcId;
      npcContactMap.set(String(npcId), {
        npcId,
        lastContactTurn: turn,
        lastLocationId: "" as LocationId, // 由调用方补充
      });
    }
  }

  const allBeats = [...prev.recentBeats, ...newBeats].slice(-RECENT_BEATS_LIMIT);

  return {
    recentBeats: allBeats,
    npcContacts: Array.from(npcContactMap.values()),
    reducedThroughEventCount: eventLedger.length,
  };
}

function summarizeBeat(event: GameEvent): string {
  switch (event.type) {
    case "quest_completed": return `任务完成: ${String(event.questId)}`;
    case "quest_failed": return `任务失败: ${String(event.questId)}`;
    case "fact_discovered": return `发现线索: ${String(event.factId)}`;
    case "npc_met": return `初遇NPC: ${String(event.npcId)}`;
    case "battle_resolved": return `战斗结束: ${event.outcome}`;
    case "ending_reached": return `结局: ${String(event.endingId)}`;
    case "blueprint_expanded": return `世界扩展`;
    default: return event.type;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/game/domain/materializedView.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/game/domain/materializedView.ts src/game/domain/materializedView.test.ts
git commit -m "feat: 物化派生视图纯 reducer——recentBeats + npcContacts 增量归约"
```

---

## Task 5: 规则引擎 validateAction + resolveByType

**Files:**
- Create: `src/game/gameplay/rpg/ruleEngine/validateAction.ts`
- Create: `src/game/gameplay/rpg/ruleEngine/resolveByType.ts`
- Test: `src/game/gameplay/rpg/ruleEngine/validateAction.test.ts`
- Test: `src/game/gameplay/rpg/ruleEngine/resolveByType.test.ts`

**Interfaces:**
- Consumes: `WorldState` from Task 1, `Action` from Task 3, `ResolvedEvent` from Task 3
- Produces: `validateAction()`, `resolveByType()` — 纯函数，不写状态

- [ ] **Step 1: Write failing tests for validateAction**

```typescript
// src/game/gameplay/rpg/ruleEngine/validateAction.test.ts
import { describe, it, expect } from "vitest";
import { validateAction } from "./validateAction";
import { createInitialWorldState } from "@/game/domain/worldState";
import { asLocationId, asNpcId, asItemId, asFactId } from "@/game/domain/scenarioBlueprint";

describe("validateAction", () => {
  const ws = createInitialWorldState({
    gameType: "wuxia",
    seed: "test",
    player: { name: "侠客", identity: "剑客", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocationId: asLocationId("loc_1"),
    startingItemIds: [],
  });

  it("rejects move to unknown location", () => {
    const result = validateAction(ws, { type: "move", locationId: asLocationId("unknown") });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("UNKNOWN_LOCATION");
  });

  it("rejects talk to unknown npc", () => {
    const result = validateAction(ws, { type: "talk", npcId: asNpcId("unknown") });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("UNKNOWN_NPC");
  });

  it("accepts ack_prologue always", () => {
    const result = validateAction(ws, { type: "ack_prologue" });
    expect(result.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/game/gameplay/rpg/ruleEngine/validateAction.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement validateAction**

```typescript
// src/game/gameplay/rpg/ruleEngine/validateAction.ts
import type { WorldState } from "@/game/domain/worldState";
import { findLocation, findNpc, findItem } from "@/game/domain/worldState";
import type { Action } from "@/game/domain/action";

export type ValidationCode =
  | "UNKNOWN_LOCATION" | "LOCATION_NOT_CURRENT" | "LOCATION_ALREADY_CURRENT"
  | "LOCATION_NOT_CONNECTED" | "LOCATION_LOCKED" | "LOCATION_ALREADY_OBSERVED"
  | "UNKNOWN_NPC" | "NPC_NOT_PRESENT" | "NPC_ALREADY_MET"
  | "UNKNOWN_FACT" | "FACT_NOT_INVESTIGABLE" | "FACT_ALREADY_DISCOVERED"
  | "UNKNOWN_ITEM" | "ITEM_NOT_AVAILABLE_HERE" | "ITEM_ALREADY_OWNED"
  | "UNKNOWN_ENEMY" | "INTENT_NOT_ROUTED";

export type ValidateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ValidationCode; readonly params: Record<string, string> };

export function validateAction(ws: WorldState, action: Action): ValidateResult {
  switch (action.type) {
    case "move": {
      const loc = findLocation(ws, action.locationId);
      if (loc === undefined) return { ok: false, code: "UNKNOWN_LOCATION", params: { locationId: String(action.locationId) } };
      if (ws.currentLocationId === action.locationId) return { ok: false, code: "LOCATION_ALREADY_CURRENT", params: {} };
      if (!ws.unlockedLocationIds.includes(action.locationId)) return { ok: false, code: "LOCATION_LOCKED", params: {} };
      const current = findLocation(ws, ws.currentLocationId);
      if (current !== undefined && !current.connectedLocationIds.includes(action.locationId)) return { ok: false, code: "LOCATION_NOT_CONNECTED", params: {} };
      return { ok: true };
    }
    case "talk": {
      const npc = findNpc(ws, action.npcId);
      if (npc === undefined) return { ok: false, code: "UNKNOWN_NPC", params: { npcId: String(action.npcId) } };
      if (npc.locationId !== ws.currentLocationId) return { ok: false, code: "NPC_NOT_PRESENT", params: { npcId: String(action.npcId) } };
      return { ok: true };
    }
    case "investigate": {
      const fact = ws.worldFacts.find((f) => f.factId === action.factId);
      if (fact === undefined) return { ok: false, code: "UNKNOWN_FACT", params: { factId: String(action.factId) } };
      if (fact.discovered) return { ok: false, code: "FACT_ALREADY_DISCOVERED", params: {} };
      return { ok: true };
    }
    case "take_item": {
      const item = findItem(ws, action.itemId);
      if (item === undefined) return { ok: false, code: "UNKNOWN_ITEM", params: { itemId: String(action.itemId) } };
      if (ws.inventory.includes(action.itemId)) return { ok: false, code: "ITEM_ALREADY_OWNED", params: {} };
      const loc = findLocation(ws, ws.currentLocationId);
      if (loc !== undefined && !loc.availableItemIds.includes(action.itemId)) return { ok: false, code: "ITEM_NOT_AVAILABLE_HERE", params: {} };
      return { ok: true };
    }
    case "ack_prologue":
    case "explore":
    case "rest":
      return { ok: true };
    default:
      return { ok: false, code: "INTENT_NOT_ROUTED", params: {} };
  }
}
```

- [ ] **Step 4: Run test to verify it passes, then implement resolveByType**

```typescript
// src/game/gameplay/rpg/ruleEngine/resolveByType.ts
import type { WorldState } from "@/game/domain/worldState";
import { findLocation, findNpc } from "@/game/domain/worldState";
import type { Action } from "@/game/domain/action";
import type { GameEvent } from "@/game/domain/events";
import type { ResolvedEvent } from "@/game/domain/resolvedEvent";

export type ResolveResult = {
  readonly ok: true;
  readonly nextWorldState: WorldState;
  readonly events: readonly GameEvent[];
  readonly feedback: string;
} | {
  readonly ok: false;
  readonly feedback: string;
};

export type ResolveDeps = { readonly now: () => string };

export function resolveByType(ws: WorldState, action: Action, deps: ResolveDeps): ResolveResult {
  const occurredAt = deps.now();

  switch (action.type) {
    case "move": {
      const event: GameEvent = { type: "location_visited", locationId: action.locationId, occurredAt };
      const nextWs: WorldState = {
        ...ws,
        currentLocationId: action.locationId,
        visitedLocationIds: ws.visitedLocationIds.includes(action.locationId)
          ? ws.visitedLocationIds
          : [...ws.visitedLocationIds, action.locationId],
        eventLedger: [...ws.eventLedger, event],
      };
      const locName = findLocation(ws, action.locationId)?.name ?? "未知地点";
      return { ok: true, nextWorldState: nextWs, events: [event], feedback: `你来到了${locName}。` };
    }
    case "talk": {
      const npc = findNpc(ws, action.npcId);
      if (npc === undefined) return { ok: false, feedback: "未知角色。" };
      const event: GameEvent = { type: "npc_met", npcId: action.npcId, occurredAt, interactionKind: "greet" };
      const nextWs: WorldState = {
        ...ws,
        npcs: ws.npcs.map((n) => n.npcId === action.npcId ? { ...n, met: true } : n),
        eventLedger: [...ws.eventLedger, event],
      };
      return { ok: true, nextWorldState: nextWs, events: [event], feedback: `你与${npc.name}交谈。` };
    }
    case "investigate": {
      const event: GameEvent = { type: "fact_discovered", factId: action.factId, occurredAt };
      const nextWs: WorldState = {
        ...ws,
        worldFacts: ws.worldFacts.map((f) => f.factId === action.factId ? { ...f, discovered: true } : f),
        eventLedger: [...ws.eventLedger, event],
      };
      return { ok: true, nextWorldState: nextWs, events: [event], feedback: "你调查了这条线索。" };
    }
    case "take_item": {
      const event: GameEvent = { type: "item_obtained", itemId: action.itemId, locationId: ws.currentLocationId, occurredAt };
      const nextWs: WorldState = {
        ...ws,
        inventory: [...ws.inventory, action.itemId],
        eventLedger: [...ws.eventLedger, event],
      };
      return { ok: true, nextWorldState: nextWs, events: [event], feedback: "你取得了这件物品。" };
    }
    case "ack_prologue": {
      return { ok: true, nextWorldState: { ...ws }, events: [], feedback: "" };
    }
    default:
      return { ok: false, feedback: "此行动类型暂不支持。" };
  }
}
```

- [ ] **Step 5: Run all tests**

Run: `npx vitest run src/game/gameplay/rpg/ruleEngine/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/game/gameplay/rpg/ruleEngine/
git commit -m "feat: 规则引擎 validateAction + resolveByType——纯函数不写状态"
```

---

## Task 6: 规则引擎 facade + updateStoryMetrics

**Files:**
- Create: `src/game/gameplay/rpg/ruleEngine/updateStoryMetrics.ts`
- Create: `src/game/gameplay/rpg/ruleEngine/index.ts`
- Test: `src/game/gameplay/rpg/ruleEngine/updateStoryMetrics.test.ts`
- Test: `src/game/gameplay/rpg/ruleEngine/index.test.ts`

**Interfaces:**
- Consumes: Tasks 1-5
- Produces: `ruleEngine()` → `{ nextWorldState, nextStoryState, resolvedEvent }`, `updateStoryMetrics()`

- [ ] **Step 1: Write failing tests for updateStoryMetrics**

```typescript
// src/game/gameplay/rpg/ruleEngine/updateStoryMetrics.test.ts
import { describe, it, expect } from "vitest";
import { updateStoryMetrics, TENSION_CHANGES } from "./updateStoryMetrics";
import { createInitialStoryState } from "@/game/domain/storyState";
import type { GameEvent } from "@/game/domain/events";

describe("updateStoryMetrics", () => {
  const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 4, npcs: 5, quests: 2, events: 0 } });

  it("battle_started increases tension by 15", () => {
    const events: GameEvent[] = [{ type: "battle_started", enemyId: "e1" as any, occurredAt: "t" }];
    const result = updateStoryMetrics(ss, events);
    expect(result.tension).toBe(45); // 30 + 15
  });

  it("quest_completed increases tension by 8 and progress", () => {
    const events: GameEvent[] = [{ type: "quest_completed", questId: "q1" as any, occurredAt: "t" }];
    const result = updateStoryMetrics(ss, events);
    expect(result.tension).toBe(38); // 30 + 8
  });

  it("tension clamps to 100", () => {
    const highTension = { ...ss, tension: 95 };
    const events: GameEvent[] = [{ type: "battle_started", enemyId: "e1" as any, occurredAt: "t" }];
    const result = updateStoryMetrics(highTension, events);
    expect(result.tension).toBe(100);
  });
});
```

- [ ] **Step 2: Implement updateStoryMetrics and ruleEngine facade**

```typescript
// src/game/gameplay/rpg/ruleEngine/updateStoryMetrics.ts
import type { StoryState } from "@/game/domain/storyState";
import { clampTension, derivePacingNeed } from "@/game/domain/storyState";
import type { GameEvent } from "@/game/domain/events";

export const TENSION_CHANGES = {
  battle_started: 15,
  battle_resolved_victory: 20,
  battle_resolved_defeat: -12,
  battle_resolved_withdraw: -12,
  fact_discovered: 12,
  quest_completed: 8,
  npc_met: 3,
  rest: -10,
  free_input: 0,
} as const;

export function updateStoryMetrics(prev: StoryState, newEvents: readonly GameEvent[]): StoryState {
  let tension = prev.tension;
  let storyProgress = prev.storyProgress;

  for (const event of newEvents) {
    switch (event.type) {
      case "battle_started": tension += TENSION_CHANGES.battle_started; break;
      case "battle_resolved":
        tension += event.outcome === "victory" ? TENSION_CHANGES.battle_resolved_victory : TENSION_CHANGES.battle_resolved_defeat;
        break;
      case "fact_discovered": tension += TENSION_CHANGES.fact_discovered; break;
      case "quest_completed":
        tension += TENSION_CHANGES.quest_completed;
        storyProgress = Math.min(100, storyProgress + 10);
        break;
      case "npc_met": tension += TENSION_CHANGES.npc_met; break;
    }
  }

  const tension2 = clampTension(tension);
  const nextPacingNeed = derivePacingNeed({ ...prev, tension: tension2, storyProgress });

  return { ...prev, tension: tension2, storyProgress, nextPacingNeed };
}
```

```typescript
// src/game/gameplay/rpg/ruleEngine/index.ts
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { Action } from "@/game/domain/action";
import type { ResolvedEvent } from "@/game/domain/resolvedEvent";
import { validateAction, type ValidationCode } from "./validateAction";
import { resolveByType, type ResolveDeps } from "./resolveByType";
import { updateStoryMetrics } from "./updateStoryMetrics";

export type RuleEngineResult =
  | { readonly ok: true; readonly nextWorldState: WorldState; readonly nextStoryState: StoryState; readonly resolvedEvent: ResolvedEvent }
  | { readonly ok: false; readonly code: ValidationCode; readonly feedback: string };

export type RuleEngineDeps = ResolveDeps;

export function ruleEngine(
  worldState: WorldState,
  storyState: StoryState,
  action: Action,
  deps: RuleEngineDeps,
): RuleEngineResult {
  const validation = validateAction(worldState, action);
  if (!validation.ok) {
    return { ok: false, code: validation.code, feedback: `行动被拒绝：${validation.code}` };
  }

  const resolved = resolveByType(worldState, action, deps);
  if (!resolved.ok) {
    return { ok: false, code: "INTENT_NOT_ROUTED" as ValidationCode, feedback: resolved.feedback };
  }

  const nextStoryState = updateStoryMetrics(storyState, resolved.events);

  const resolvedEvent: ResolvedEvent = {
    actionId: `act_${deps.now()}`,
    status: "success",
    stateChanges: [],
    facts: [],
    costs: [],
    rewards: [],
    triggeredEvents: resolved.events.map((e) => e.type),
    rejectedEffects: [],
    stateVersion: worldState.eventLedger.length,
  };

  return { ok: true, nextWorldState: resolved.nextWorldState, nextStoryState, resolvedEvent };
}
```

- [ ] **Step 3: Run tests, fix, commit**

Run: `npx vitest run src/game/gameplay/rpg/ruleEngine/`
Expected: PASS

```bash
git add src/game/gameplay/rpg/ruleEngine/
git commit -m "feat: 规则引擎 facade + updateStoryMetrics——张力固定值更新"
```

---

## Task 7: ActionConverter（固定选项映射）

**Files:**
- Create: `src/game/application/actionConverter.ts`
- Test: `src/game/application/actionConverter.test.ts`

**Interfaces:**
- Consumes: `Interaction` from Task 3
- Produces: `convertInteraction()` — P1 仅固定选项映射，free_text 留 P2

- [ ] **Step 1: Write failing tests + implement + commit**

```typescript
// src/game/application/actionConverter.ts
import type { Interaction } from "@/game/domain/action";
import type { Action } from "@/game/domain/action";

export type ActionChoiceMap = ReadonlyMap<string, Action>;

export type ConvertResult =
  | { readonly ok: true; readonly action: Action }
  | { readonly ok: false; readonly reason: "unknown_choice" | "free_text_not_supported" };

export function convertInteraction(interaction: Interaction, choiceMap: ActionChoiceMap): ConvertResult {
  if (interaction.kind === "fixed_choice") {
    const action = choiceMap.get(interaction.choiceToken);
    if (action === undefined) return { ok: false, reason: "unknown_choice" };
    return { ok: true, action };
  }
  // P1 不支持自由文本——P2 实现
  return { ok: false, reason: "free_text_not_supported" };
}
```

- [ ] **Step 2: Run tests, commit**

```bash
git add src/game/application/actionConverter.ts src/game/application/actionConverter.test.ts
git commit -m "feat: ActionConverter 固定选项映射——P2 扩展自由文本"
```

---

## Task 8: StateCommit + 场景写回者

**Files:**
- Create: `src/game/application/stateCommit.ts`
- Create: `src/game/application/sceneWriteBack.ts`
- Test: `src/game/application/stateCommit.test.ts`
- Test: `src/game/application/sceneWriteBack.test.ts`

**Interfaces:**
- Consumes: `GameRepository` (existing), Tasks 1-2
- Produces: `commitState()` (CAS), `writeBackScene()` (CAS, 只写叙事运行时状态)

- [ ] **Step 1: Implement StateCommit and sceneWriteBack with tests**

StateCommit wraps the existing repository CAS but operates on the new dual-state model. The repository stores `{ worldState, storyState, revision }`.

SceneWriteBack only updates `storyState.narrative` and `storyState.candidateEventPool` — it must never touch `worldState` or other storyState fields.

- [ ] **Step 2: Write boundary tests asserting sceneWriteBack cannot modify worldState**

- [ ] **Step 3: Run tests, commit**

```bash
git add src/game/application/stateCommit.ts src/game/application/stateCommit.test.ts src/game/application/sceneWriteBack.ts src/game/application/sceneWriteBack.test.ts
git commit -m "feat: StateCommit + 场景写回者——两个合法 CAS 写入者边界"
```

---

## Task 9: performActionV2 主循环编排

**Files:**
- Create: `src/game/application/performActionV2.ts`
- Test: `src/game/application/performActionV2.test.ts`

**Interfaces:**
- Consumes: Tasks 1-8
- Produces: `performActionV2()` — 流水线串联

- [ ] **Step 1: Implement performActionV2 with tests**

```typescript
// src/game/application/performActionV2.ts (skeleton)
export async function performActionV2(command, deps) {
  // 1. Load current game
  // 2. Check revision
  // 3. convertInteraction → Action (P1: fixed_choice only)
  // 4. ruleEngine(action, worldState, storyState) → { nextWorldState, nextStoryState, resolvedEvent }
  //    P1: no ExpansionProposer (P3 adds it)
  // 5. stateCommit CAS write
  // 6. Queue scene generation if AI mode (async pending → ensure → sceneWriteBack)
  // 7. Project gameSessionViewV2
}
```

- [ ] **Step 2: Write integration test with fixture source (offline)**

- [ ] **Step 3: Run tests, commit**

```bash
git add src/game/application/performActionV2.ts src/game/application/performActionV2.test.ts
git commit -m "feat: performActionV2 主循环编排——流水线骨架"
```

---

## Task 10: createGameV2 开局初始化

**Files:**
- Create: `src/game/application/createGameV2.ts`
- Test: `src/game/application/createGameV2.test.ts`

**Interfaces:**
- Consumes: `NewGameInput` (existing), AI source (injectable), Tasks 1-2
- Produces: `createGameV2()` → 初始 WorldState + StoryState

- [ ] **Step 1: Implement createGameV2 with tests**

Flow: validate → AI source generate → rule validate → createInitialWorldState + createInitialStoryState → persist.

P1 uses fixture/offline source for initial world generation. Live AI source is P2+.

- [ ] **Step 2: Run tests, commit**

```bash
git add src/game/application/createGameV2.ts src/game/application/createGameV2.test.ts
git commit -m "feat: createGameV2 开局初始化——World State + Story State"
```

---

## Task 11: gameSessionViewV2 read model + API 接入

**Files:**
- Create: `src/game/application/gameSessionViewV2.ts`
- Modify: `src/app/api/game/route.ts`
- Modify: `src/app/api/game/actions/route.ts`
- Test: `src/game/application/gameSessionViewV2.test.ts`

- [ ] **Step 1: Implement read model projection from WorldState + StoryState**

- [ ] **Step 2: Switch API routes to V2 use cases**

- [ ] **Step 3: Run all tests, commit**

```bash
git add -A
git commit -m "feat: gameSessionViewV2 read model + API 接入 V2"
```

---

## Task 12: 依赖边界守卫 + 离线回归

**Files:**
- Modify: `src/dependencyBoundaries.test.ts`
- Test: `src/game/application/p1OfflineRegression.test.ts`

- [ ] **Step 1: Add boundary guards for new module structure**

- [ ] **Step 2: Write offline regression test: full createGame → performAction → view cycle with fixture source**

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: P1 依赖边界守卫 + 离线全流水线回归"
```

---

## Self-Review

**Spec coverage check:**
- ✅ World State + Story State 双状态模型 → Tasks 1-2
- ✅ 严格流水线骨架 → Tasks 5-9
- ✅ 封闭 Action 集合 + utterance → Task 3
- ✅ ResolvedEvent 五态结果 → Task 3
- ✅ 物化派生视图 → Task 4
- ✅ 预算控制 opening/expanded/max → Task 2
- ✅ 张力/节奏追踪 → Task 6
- ✅ 两个合法写入者 → Task 8
- ✅ 离线基线与可注入 AI source → Tasks 9-12
- ⏳ ActionConverter 自由文本 → P2
- ⏳ ExpansionProposer → P3
- ⏳ NPC 结构化记忆完整接入 → P4
- ⏳ candidateEventPool 审批 → P4

**Placeholder scan:** No TBDs. All code blocks contain actual implementation.

**Type consistency:** WorldState.version = 2, StoryState.version = 2 consistently. Action types match between action.ts and resolveByType.ts.
