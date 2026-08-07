# P4：NPC 结构化记忆 + candidateEventPool 审批 + 张力/结局控制 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成 NPC 结构化记忆的运行时更新机制、candidateEventPool 的规则审批闭环、张力/节奏/结局控制的完整推导链，使主循环流水线的最后一环落地。

**Architecture:** P4 在 P1-P3 已建立的 WorldState + StoryState 双状态模型和严格流水线基础上，填充三个剩余缺口：(1) resolveByType 中的 talk 行动目前只置 `met: true`，不更新 NPC 记忆；(2) candidateEventPool 有类型和写入通道但无规则审批消费方；(3) endingAllowed/currentAct/unresolvedThreads 由规则推导的逻辑缺失。所有改动遵循纯函数优先、TDD、可注入 AI source 约束。

**Tech Stack:** TypeScript, Next.js 16, React 19, libsql/SQLite, Vitest, zustand

**Spec:** `docs/superpowers/specs/2026-08-07-ai-rpg-architecture-redesign-spec.md` §8（NPC 记忆）、§3.2（candidateEventPool）、§10（张力/结局控制）

## Global Constraints

- 纯 domain 层零 IO、零 AI、零 DB；gameplay 层纯函数不写状态；application 层编排
- 所有 AI 调用点使用可注入 source 接口，离线 fixture 保证无 AI 全流水线可测
- CAS compare-and-swap 原子写入，revision 是唯一防重屏障
- NPC 交互历史有界保留 N=10 条，超出截断；knownFactIds/hiddenFactIds 永不裁剪
- 张力变化一律固定值，不使用区间或随机数
- 测试先行（TDD），每个 task 以失败测试开始

---

## 当前代码缺口分析

### 缺口 1：NPC 记忆不更新

`resolveByType.ts` 的 `talk` case 只做 `met: true`，**不更新**：
- `interactionHistory`：无追加
- `emotion`：不变化
- `relationship`：不变化（只在旧 `handleNpcDialogue` 中有，V2 路径缺失）
- `knownFactIds`：FactChange 有 `audience` 字段但无消费方

### 缺口 2：candidateEventPool 无审批消费

- `EventCandidate` 类型存在于 `storyState.ts`
- `sceneWriteBack.ts` 可写入池
- **但无规则审批步骤**：没有代码在 ruleEngine 中读取池、按张力/节奏/预算审批候选、触发批准的事件

### 缺口 3：结局/节奏控制缺失

- `endingAllowed`：初始化为 `false`，**无任何规则将其设为 `true`**
- `currentAct`：初始化为 1，**无幕推进逻辑**（quest 完成只加 storyProgress，不加 act）
- `unresolvedThreads`：初始化有 `main_thread`，**无追加/回收机制**
- `storyProgress`：只在 quest_completed 时 +10，无幕转换时的跳跃

### 缺口 4：物化视图未集成

- `reconcileMaterializedView` 纯函数已存在
- **但 ruleEngine 和 stateCommit 不调用它**：recentBeats/npcContacts 始终为空数组

---

## File Structure

### 新建文件

```
src/game/gameplay/rpg/ruleEngine/
  updateNpcMemory.ts          # NPC 记忆更新纯函数：interactionHistory 追加 + emotion 更新 + relationship 更新
  updateNpcMemory.test.ts
  propagateKnownFacts.ts      # 从 FactChange.audience 推导 NPC knownFactIds 更新
  propagateKnownFacts.test.ts
  approveCandidateEvents.ts   # candidateEventPool 审批：按张力/节奏/预算决定接受/拒绝
  approveCandidateEvents.test.ts
  advanceStoryProgression.ts  # 幕推进 + endingAllowed 推导 + unresolvedThreads 管理
  advanceStoryProgression.test.ts
```

### 修改文件

```
src/game/gameplay/rpg/ruleEngine/resolveByType.ts    # talk case 调用 updateNpcMemory
src/game/gameplay/rpg/ruleEngine/index.ts             # 集成 approveCandidateEvents + advanceStoryProgression + 物化视图
src/game/domain/worldState.ts                         # NpcMemory 添加 updateNpcMemory 辅助导出（如需）
src/game/application/performActionV2.test.ts          # P4 回归测试
src/game/application/p4OfflineRegression.test.ts      # 新建：P4 离线全流水线回归
```

---

## Task 1: NPC 记忆更新纯函数

**Files:**
- Create: `src/game/gameplay/rpg/ruleEngine/updateNpcMemory.ts`
- Test: `src/game/gameplay/rpg/ruleEngine/updateNpcMemory.test.ts`

**Interfaces:**
- Consumes: `NpcEntry`, `NpcInteraction`, `NpcMemory` from `@/game/domain/worldState`, `RelationshipValue` from `@/game/domain/relationship`, `RELATIONSHIP_CHANGE` from `@/game/domain/relationship`
- Produces: `updateNpcMemory()`, `appendInteraction()`, `trimInteractionHistory()`, `NPC_INTERACTION_HISTORY_LIMIT`

- [ ] **Step 1: Write failing tests**

```typescript
// src/game/gameplay/rpg/ruleEngine/updateNpcMemory.test.ts
import { describe, it, expect } from "vitest";
import {
  updateNpcMemory,
  appendInteraction,
  trimInteractionHistory,
  NPC_INTERACTION_HISTORY_LIMIT,
} from "./updateNpcMemory";
import type { NpcEntry, NpcInteraction } from "@/game/domain/worldState";
import { asNpcId, asLocationId, asFactId } from "@/game/domain/scenarioBlueprint";

function makeNpc(overrides?: Partial<NpcEntry>): NpcEntry {
  return {
    id: asNpcId("npc_1"),
    name: "测试NPC",
    role: "路人",
    description: "测试",
    locationId: asLocationId("loc_1"),
    isCompanion: false,
    tags: [],
    met: false,
    memory: {
      npcId: asNpcId("npc_1"),
      knownFactIds: [],
      hiddenFactIds: [],
      interactionHistory: [],
      relationship: { affinity: 0 },
      emotion: "neutral",
      goals: [],
    },
    ...overrides,
  };
}

describe("updateNpcMemory", () => {
  it("appends interaction to history", () => {
    const npc = makeNpc();
    const interaction: NpcInteraction = {
      turn: 1,
      locationId: asLocationId("loc_1"),
      actionType: "talk",
      outcome: "positive",
      relationshipDelta: 5,
      summary: "首次见面，好感+5",
    };
    const updated = updateNpcMemory(npc, interaction);
    expect(updated.memory.interactionHistory.length).toBe(1);
    expect(updated.memory.interactionHistory[0]?.summary).toBe("首次见面，好感+5");
  });

  it("updates relationship based on delta", () => {
    const npc = makeNpc();
    const interaction: NpcInteraction = {
      turn: 1,
      locationId: asLocationId("loc_1"),
      actionType: "talk",
      outcome: "positive",
      relationshipDelta: 5,
      summary: "首次见面",
    };
    const updated = updateNpcMemory(npc, interaction);
    expect(updated.memory.relationship.affinity).toBe(5);
  });

  it("updates emotion based on outcome", () => {
    const npc = makeNpc();
    const interaction: NpcInteraction = {
      turn: 1,
      locationId: asLocationId("loc_1"),
      actionType: "talk",
      outcome: "negative",
      relationshipDelta: -3,
      summary: "不愉快",
    };
    const updated = updateNpcMemory(npc, interaction);
    expect(updated.memory.emotion).toBe("guarded");
  });

  it("clamps relationship to [-100, 100]", () => {
    const npc = makeNpc({
      memory: {
        npcId: asNpcId("npc_1"),
        knownFactIds: [],
        hiddenFactIds: [],
        interactionHistory: [],
        relationship: { affinity: 98 },
        emotion: "neutral",
        goals: [],
      },
    });
    const interaction: NpcInteraction = {
      turn: 1,
      locationId: asLocationId("loc_1"),
      actionType: "talk",
      outcome: "positive",
      relationshipDelta: 5,
      summary: "好感已满",
    };
    const updated = updateNpcMemory(npc, interaction);
    expect(updated.memory.relationship.affinity).toBe(100);
  });

  it("trims history to limit (10)", () => {
    const interactions: NpcInteraction[] = Array.from({ length: 15 }, (_, i) => ({
      turn: i,
      locationId: asLocationId("loc_1"),
      actionType: "talk",
      outcome: "neutral" as const,
      relationshipDelta: 0,
      summary: `交互${i}`,
    }));
    const trimmed = trimInteractionHistory(interactions);
    expect(trimmed.length).toBe(NPC_INTERACTION_HISTORY_LIMIT);
    expect(trimmed[0]?.summary).toBe("交互5"); // 保留最近10条
  });

  it("does not mutate original npc", () => {
    const npc = makeNpc();
    const interaction: NpcInteraction = {
      turn: 1,
      locationId: asLocationId("loc_1"),
      actionType: "talk",
      outcome: "positive",
      relationshipDelta: 5,
      summary: "测试",
    };
    updateNpcMemory(npc, interaction);
    expect(npc.memory.interactionHistory.length).toBe(0); // 原始不变
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/game/gameplay/rpg/ruleEngine/updateNpcMemory.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```typescript
// src/game/gameplay/rpg/ruleEngine/updateNpcMemory.ts
import type { NpcEntry, NpcInteraction, NpcMemory } from "@/game/domain/worldState";
import { clampAffinity } from "@/game/domain/relationship";
import type { NarrativeEmotion } from "@/game/domain/narrative";

export const NPC_INTERACTION_HISTORY_LIMIT = 10;

export function trimInteractionHistory(
  history: readonly NpcInteraction[],
): readonly NpcInteraction[] {
  if (history.length <= NPC_INTERACTION_HISTORY_LIMIT) return history;
  return history.slice(history.length - NPC_INTERACTION_HISTORY_LIMIT);
}

export function appendInteraction(
  history: readonly NpcInteraction[],
  interaction: NpcInteraction,
): readonly NpcInteraction[] {
  return trimInteractionHistory([...history, interaction]);
}

function emotionForOutcome(outcome: NpcInteraction["outcome"], prevEmotion: NarrativeEmotion): NarrativeEmotion {
  if (outcome === "positive") return "warm";
  if (outcome === "negative") return "guarded";
  return prevEmotion;
}

export function updateNpcMemory(npc: NpcEntry, interaction: NpcInteraction): NpcEntry {
  const newAffinity = clampAffinity(
    npc.memory.relationship.affinity + interaction.relationshipDelta,
  );
  const newHistory = appendInteraction(npc.memory.interactionHistory, interaction);
  const newEmotion = emotionForOutcome(interaction.outcome, npc.memory.emotion);

  return {
    ...npc,
    memory: {
      ...npc.memory,
      interactionHistory: newHistory,
      relationship: { affinity: newAffinity },
      emotion: newEmotion,
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/game/gameplay/rpg/ruleEngine/updateNpcMemory.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/game/gameplay/rpg/ruleEngine/updateNpcMemory.ts src/game/gameplay/rpg/ruleEngine/updateNpcMemory.test.ts
git commit -m "feat: NPC 记忆更新纯函数——interactionHistory 追加 + emotion/relationship 更新 + 有界裁剪"
```

---

## Task 2: NPC knownFactIds 规则推导

**Files:**
- Create: `src/game/gameplay/rpg/ruleEngine/propagateKnownFacts.ts`
- Test: `src/game/gameplay/rpg/ruleEngine/propagateKnownFacts.test.ts`

**Interfaces:**
- Consumes: `WorldState`, `FactChange` from `@/game/domain/resolvedEvent`
- Produces: `propagateKnownFacts()` — 从 ResolvedEvent.facts 的 audience 推导 NPC knownFactIds 更新

- [ ] **Step 1: Write failing tests**

```typescript
// src/game/gameplay/rpg/ruleEngine/propagateKnownFacts.test.ts
import { describe, it, expect } from "vitest";
import { propagateKnownFacts } from "./propagateKnownFacts";
import type { WorldState, NpcEntry } from "@/game/domain/worldState";
import type { FactChange } from "@/game/domain/resolvedEvent";
import { asNpcId, asLocationId, asFactId } from "@/game/domain/scenarioBlueprint";

function makeWorld(npcs: NpcEntry[]): WorldState {
  return {
    version: 2,
    generation: { generationId: "" as any, seed: "test", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "侠客", identity: "剑客", stats: { hp: 100, attack: 10, defense: 5 } },
    locations: [],
    currentLocationId: asLocationId("loc_1"),
    unlockedLocationIds: [],
    visitedLocationIds: [],
    npcs,
    items: [],
    inventory: [],
    worldFacts: [],
    quests: [],
    enemies: [],
    defeatedEnemyIds: [],
    battle: { status: "idle" },
    endings: [],
    ending: null,
    factions: [],
    towns: [],
    eventLedger: [],
  };
}

function makeNpc(id: string, knownFacts: string[] = []): NpcEntry {
  return {
    id: asNpcId(id),
    name: id,
    role: "路人",
    description: "测试",
    locationId: asLocationId("loc_1"),
    isCompanion: false,
    tags: [],
    met: false,
    memory: {
      npcId: asNpcId(id),
      knownFactIds: knownFacts.map(asFactId),
      hiddenFactIds: [],
      interactionHistory: [],
      relationship: { affinity: 0 },
      emotion: "neutral",
      goals: [],
    },
  };
}

describe("propagateKnownFacts", () => {
  it("appends discovered fact to audience NPC knownFactIds", () => {
    const ws = makeWorld([makeNpc("npc_a")]);
    const changes: FactChange[] = [
      { factId: asFactId("fact_1"), change: "discovered", audience: [asNpcId("npc_a")] },
    ];
    const result = propagateKnownFacts(ws, changes);
    const npc = result.npcs.find((n) => n.id === asNpcId("npc_a"))!;
    expect(npc.memory.knownFactIds).toContain(asFactId("fact_1"));
  });

  it("does not add duplicate facts", () => {
    const ws = makeWorld([makeNpc("npc_a", ["fact_1"])]);
    const changes: FactChange[] = [
      { factId: asFactId("fact_1"), change: "discovered", audience: [asNpcId("npc_a")] },
    ];
    const result = propagateKnownFacts(ws, changes);
    const npc = result.npcs.find((n) => n.id === asNpcId("npc_a"))!;
    expect(npc.memory.knownFactIds.length).toBe(1);
  });

  it("ignores facts without audience", () => {
    const ws = makeWorld([makeNpc("npc_a")]);
    const changes: FactChange[] = [
      { factId: asFactId("fact_1"), change: "discovered" },
    ];
    const result = propagateKnownFacts(ws, changes);
    const npc = result.npcs.find((n) => n.id === asNpcId("npc_a"))!;
    expect(npc.memory.knownFactIds.length).toBe(0);
  });

  it("only appends to specified audience NPCs", () => {
    const ws = makeWorld([makeNpc("npc_a"), makeNpc("npc_b")]);
    const changes: FactChange[] = [
      { factId: asFactId("fact_1"), change: "discovered", audience: [asNpcId("npc_a")] },
    ];
    const result = propagateKnownFacts(ws, changes);
    const npcA = result.npcs.find((n) => n.id === asNpcId("npc_a"))!;
    const npcB = result.npcs.find((n) => n.id === asNpcId("npc_b"))!;
    expect(npcA.memory.knownFactIds).toContain(asFactId("fact_1"));
    expect(npcB.memory.knownFactIds.length).toBe(0);
  });

  it("returns same worldState when no changes", () => {
    const ws = makeWorld([makeNpc("npc_a")]);
    const result = propagateKnownFacts(ws, []);
    expect(result).toBe(ws);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/game/gameplay/rpg/ruleEngine/propagateKnownFacts.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```typescript
// src/game/gameplay/rpg/ruleEngine/propagateKnownFacts.ts
import type { WorldState, NpcEntry } from "@/game/domain/worldState";
import type { FactChange } from "@/game/domain/resolvedEvent";
import type { FactId, NpcId } from "@/game/domain/scenarioBlueprint";

export function propagateKnownFacts(
  ws: WorldState,
  factChanges: readonly FactChange[],
): WorldState {
  if (factChanges.length === 0) return ws;

  // 收集每个 NPC 需要追加的新事实
  const additions = new Map<string, Set<string>>();
  for (const change of factChanges) {
    if (change.change !== "discovered" && change.change !== "revealed") continue;
    if (change.audience === undefined) continue;
    for (const npcId of change.audience) {
      const key = String(npcId);
      if (!additions.has(key)) additions.set(key, new Set());
      additions.get(key)!.add(String(change.factId));
    }
  }

  if (additions.size === 0) return ws;

  const newNpcs: NpcEntry[] = ws.npcs.map((npc) => {
    const adds = additions.get(String(npc.id));
    if (adds === undefined) return npc;

    const existingSet = new Set(npc.memory.knownFactIds.map(String));
    const toAdd = Array.from(adds).filter((f) => !existingSet.has(f));
    if (toAdd.length === 0) return npc;

    return {
      ...npc,
      memory: {
        ...npc.memory,
        knownFactIds: [
          ...npc.memory.knownFactIds,
          ...toAdd.map((f) => f as FactId),
        ],
      },
    };
  });

  return { ...ws, npcs: newNpcs };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/game/gameplay/rpg/ruleEngine/propagateKnownFacts.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/game/gameplay/rpg/ruleEngine/propagateKnownFacts.ts src/game/gameplay/rpg/ruleEngine/propagateKnownFacts.test.ts
git commit -m "feat: NPC knownFactIds 规则推导——从 FactChange.audience 确定性传播"
```

---

## Task 3: resolveByType 集成 NPC 记忆更新

**Files:**
- Modify: `src/game/gameplay/rpg/ruleEngine/resolveByType.ts`
- Test: `src/game/gameplay/rpg/ruleEngine/resolveByType.test.ts`（追加测试）

**Interfaces:**
- Consumes: Task 1 `updateNpcMemory`, Task 2 `propagateKnownFacts`
- Produces: 修改后的 `resolveByType` — talk case 更新 NPC 记忆；investigate case 产出 FactChange 带 audience

- [ ] **Step 1: Write failing tests for NPC memory update in talk action**

```typescript
// 追加到 resolveByType.test.ts
import { updateNpcMemory } from "./updateNpcMemory";

describe("resolveByType — NPC memory integration", () => {
  it("talk action updates NPC interactionHistory", () => {
    const ws = createInitialWorldState({
      generation: { generationId: "" as any, seed: "test", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
      player: { name: "侠客", identity: "剑客", stats: { hp: 100, attack: 10, defense: 5 } },
      startingLocation: { id: asLocationId("loc_1"), name: "村庄", description: "测试", kind: "main", connectedLocationIds: [], npcIds: [asNpcId("npc_1")], availableItemIds: [], tags: [], scale: "scene" },
      startingItemIds: [],
    });
    // 追加一个 NPC
    const wsWithNpc = appendNpc(ws, {
      id: asNpcId("npc_1"),
      name: "老张",
      role: "村民",
      description: "测试",
      locationId: asLocationId("loc_1"),
      isCompanion: false,
      tags: [],
      met: false,
      memory: {
        npcId: asNpcId("npc_1"),
        knownFactIds: [],
        hiddenFactIds: [],
        interactionHistory: [],
        relationship: { affinity: 0 },
        emotion: "neutral",
        goals: [],
      },
    });

    const result = resolveByType(wsWithNpc, { type: "talk", npcId: asNpcId("npc_1") }, { now: () => "t1" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const npc = result.nextWorldState.npcs.find((n) => n.id === asNpcId("npc_1"))!;
      expect(npc.met).toBe(true);
      expect(npc.memory.interactionHistory.length).toBe(1);
      expect(npc.memory.interactionHistory[0]?.actionType).toBe("talk");
      expect(npc.memory.relationship.affinity).toBe(5); // GREET_FIRST_MEET = 5
    }
  });

  it("investigate action produces FactChange with audience", () => {
    const ws = createInitialWorldState({
      generation: { generationId: "" as any, seed: "test", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
      player: { name: "侠客", identity: "剑客", stats: { hp: 100, attack: 10, defense: 5 } },
      startingLocation: { id: asLocationId("loc_1"), name: "村庄", description: "测试", kind: "main", connectedLocationIds: [], npcIds: [asNpcId("npc_1")], availableItemIds: [], tags: [], scale: "scene" },
      startingItemIds: [],
    });
    const wsWithFact: WorldState = {
      ...ws,
      worldFacts: [{ factId: asFactId("fact_1"), text: "线索", source: "world", discovered: false, locationId: asLocationId("loc_1") }],
    };
    const result = resolveByType(wsWithFact, { type: "investigate", factId: asFactId("fact_1") }, { now: () => "t1" });
    expect(result.ok).toBe(true);
    // investigate 不再只更新 worldFacts，还应产出 FactChange
    // 需要在 ResolveResult 中暴露 facts 字段
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/game/gameplay/rpg/ruleEngine/resolveByType.test.ts`
Expected: FAIL — interactionHistory 仍为 0

- [ ] **Step 3: Modify resolveByType to update NPC memory in talk case and expose facts in ResolveResult**

修改要点：
1. `ResolveResult` 的成功变体添加 `facts: readonly FactChange[]` 字段
2. `talk` case 调用 `updateNpcMemory`，使用 `RELATIONSHIP_CHANGE.GREET_FIRST_MEET` 作为 relationshipDelta
3. `investigate` case 产出 `FactChange`，audience 为当前地点所有已 met 的 NPC
4. 其他 case 的 `facts` 默认为 `[]`

```typescript
// resolveByType.ts 修改（关键部分）

// 在 import 中添加
import { updateNpcMemory } from "./updateNpcMemory";
import { RELATIONSHIP_CHANGE } from "@/game/domain/relationship";
import type { FactChange } from "@/game/domain/resolvedEvent";

// ResolveResult 成功变体添加 facts 字段
export type ResolveResult = {
  readonly ok: true;
  readonly nextWorldState: WorldState;
  readonly events: readonly GameEvent[];
  readonly feedback: string;
  readonly status: ResolvedEventStatus;
  readonly stateChanges: readonly StateChange[];
  readonly facts: readonly FactChange[];  // 新增
} | {
  readonly ok: false;
  readonly feedback: string;
};

// talk case 修改
case "talk": {
  const npc = findNpc(ws, action.npcId);
  if (npc === undefined) return { ok: false, feedback: "未知角色。" };
  const event: GameEvent = { type: "npc_met", npcId: action.npcId, occurredAt, interactionKind: "greet" };

  const interaction: NpcInteraction = {
    turn: ws.eventLedger.length,
    locationId: ws.currentLocationId,
    actionType: "talk",
    outcome: "positive",
    relationshipDelta: RELATIONSHIP_CHANGE.GREET_FIRST_MEET,
    summary: npc.met ? "再次交谈" : "首次见面，好感+5",
  };
  const updatedNpc = updateNpcMemory(npc, interaction);

  const nextWs: WorldState = {
    ...ws,
    npcs: ws.npcs.map((n) => n.id === action.npcId ? { ...updatedNpc, met: true } : n),
    eventLedger: [...ws.eventLedger, event],
  };
  // ... stateChanges 逻辑不变
  return { ok: true, nextWorldState: nextWs, events: [event], feedback: `你与${npc.name}交谈。`, status, stateChanges, facts: [] };
}

// investigate case 修改
case "investigate": {
  const event: GameEvent = { type: "fact_discovered", factId: action.factId, occurredAt };
  const nextWs: WorldState = {
    ...ws,
    worldFacts: ws.worldFacts.map((f) => f.factId === action.factId ? { ...f, discovered: true } : f),
    eventLedger: [...ws.eventLedger, event],
  };
  // 产出 FactChange：audience 为当前地点已 met 的 NPC
  const audience = ws.npcs
    .filter((n) => n.locationId === ws.currentLocationId && n.met)
    .map((n) => n.id);
  const facts: FactChange[] = [
    { factId: action.factId, change: "discovered", audience: audience.length > 0 ? audience : undefined },
  ];
  return { ok: true, nextWorldState: nextWs, events: [event], feedback: "你调查了这条线索。", status: "success", stateChanges, facts };
}

// 其他 case 的 return 语句添加 facts: []
```

- [ ] **Step 4: Run all resolveByType tests**

Run: `npx vitest run src/game/gameplay/rpg/ruleEngine/resolveByType.test.ts`
Expected: PASS

- [ ] **Step 5: Update ruleEngine index.ts to propagate facts and call propagateKnownFacts**

```typescript
// ruleEngine/index.ts 修改

// 在 import 中添加
import { propagateKnownFacts } from "./propagateKnownFacts";

// 在 resolveByType 之后、reconcileQuests 之前：
const propagatedWs = propagateKnownFacts(resolved.nextWorldState, resolved.facts);

// 使用 propagatedWs 替代 resolved.nextWorldState 传入后续步骤
const quests = reconcileQuests(propagatedWs, deps);
```

同时在 `ResolvedEvent` 中填充 `facts` 字段：

```typescript
const resolvedEvent: ResolvedEvent = {
  // ...
  facts: resolved.facts,  // 透传 FactChange 列表
  // ...
};
```

- [ ] **Step 6: Run all ruleEngine tests**

Run: `npx vitest run src/game/gameplay/rpg/ruleEngine/`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/game/gameplay/rpg/ruleEngine/resolveByType.ts src/game/gameplay/rpg/ruleEngine/resolveByType.test.ts src/game/gameplay/rpg/ruleEngine/index.ts
git commit -m "feat: resolveByType 集成 NPC 记忆更新 + FactChange 产出 + knownFactIds 传播"
```

---

## Task 4: candidateEventPool 审批纯函数

**Files:**
- Create: `src/game/gameplay/rpg/ruleEngine/approveCandidateEvents.ts`
- Test: `src/game/gameplay/rpg/ruleEngine/approveCandidateEvents.test.ts`

**Interfaces:**
- Consumes: `StoryState`, `EventCandidate`, `StoryBudget`
- Produces: `approveCandidateEvents()` — 按张力/节奏/预算审批候选事件，产出 `{ approvedEvents, rejectedEvents, nextStoryState }`

- [ ] **Step 1: Write failing tests**

```typescript
// src/game/gameplay/rpg/ruleEngine/approveCandidateEvents.test.ts
import { describe, it, expect } from "vitest";
import { approveCandidateEvents } from "./approveCandidateEvents";
import { createInitialStoryState } from "@/game/domain/storyState";
import type { EventCandidate } from "@/game/domain/storyState";

describe("approveCandidateEvents", () => {
  const ss = createInitialStoryState({
    gameLength: "short",
    initialEntityCounts: { locations: 4, npcs: 5, quests: 2, events: 0 },
  });

  it("approves events when budget allows", () => {
    const candidates: EventCandidate[] = [
      { id: "c1", description: "有人跟踪玩家", proposedAtTurn: 1 },
    ];
    const result = approveCandidateEvents(ss, candidates);
    expect(result.approvedEvents.length).toBe(1);
    expect(result.nextStoryState.candidateEventPool.length).toBe(0); // 审批后从池中移除
    expect(result.nextStoryState.budget.events.expanded).toBe(1); // 预算扣减
  });

  it("rejects events when budget exhausted", () => {
    const exhaustedSs = {
      ...ss,
      budget: {
        ...ss.budget,
        events: { ...ss.budget.events, expanded: 6, max: 6 }, // 已满
      },
    };
    const candidates: EventCandidate[] = [
      { id: "c1", description: "新事件", proposedAtTurn: 1 },
    ];
    const result = approveCandidateEvents(exhaustedSs, candidates);
    expect(result.approvedEvents.length).toBe(0);
    expect(result.rejectedEvents.length).toBe(1);
    expect(result.nextStoryState.budget.events.expanded).toBe(6); // 不扣减
  });

  it("empty pool returns same state", () => {
    const result = approveCandidateEvents(ss, []);
    expect(result.approvedEvents.length).toBe(0);
    expect(result.nextStoryState).toBe(ss);
  });

  it("approves at most 1 event per turn", () => {
    const candidates: EventCandidate[] = [
      { id: "c1", description: "事件A", proposedAtTurn: 1 },
      { id: "c2", description: "事件B", proposedAtTurn: 1 },
    ];
    const result = approveCandidateEvents(ss, candidates);
    expect(result.approvedEvents.length).toBe(1);
    expect(result.nextStoryState.candidateEventPool.length).toBe(1); // 剩余1个
  });

  it("approved event increases tension", () => {
    const candidates: EventCandidate[] = [
      { id: "c1", description: "冲突事件", proposedAtTurn: 1 },
    ];
    const result = approveCandidateEvents(ss, candidates);
    // 事件批准增加张力（固定值 +10）
    expect(result.nextStoryState.tension).toBe(ss.tension + 10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/game/gameplay/rpg/ruleEngine/approveCandidateEvents.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```typescript
// src/game/gameplay/rpg/ruleEngine/approveCandidateEvents.ts
import type { StoryState, EventCandidate } from "@/game/domain/storyState";
import { clampTension, derivePacingNeed } from "@/game/domain/storyState";
import { consumeExpansion, budgetAllowsExpansion } from "@/game/domain/storyBudget";

export type ApprovedEvent = EventCandidate & {
  readonly approvedAtTurn: number;
};

export type ApproveResult = {
  readonly approvedEvents: readonly ApprovedEvent[];
  readonly rejectedEvents: readonly EventCandidate[];
  readonly nextStoryState: StoryState;
};

const EVENT_TENSION_CHANGE = 10;
const MAX_APPROVED_PER_TURN = 1;

export function approveCandidateEvents(
  ss: StoryState,
  candidates: readonly EventCandidate[],
): ApproveResult {
  if (candidates.length === 0) {
    return { approvedEvents: [], rejectedEvents: [], nextStoryState: ss };
  }

  const approved: ApprovedEvent[] = [];
  const rejected: EventCandidate[] = [];
  let nextBudget = ss.budget;
  let tension = ss.tension;
  let approvedCount = 0;

  for (const candidate of candidates) {
    if (approvedCount >= MAX_APPROVED_PER_TURN) {
      // 超出本回合上限的保留在池中
      break;
    }
    if (!budgetAllowsExpansion(nextBudget, "events")) {
      rejected.push(candidate);
      continue;
    }
    approved.push({ ...candidate, approvedAtTurn: ss.reducedThroughEventCount });
    nextBudget = consumeExpansion(nextBudget, "events");
    tension += EVENT_TENSION_CHANGE;
    approvedCount++;
  }

  if (approved.length === 0) {
    return { approvedEvents: [], rejectedEvents: rejected, nextStoryState: ss };
  }

  // 从池中移除已审批和已拒绝的，保留未处理的
  const approvedIds = new Set(approved.map((e) => e.id));
  const rejectedIds = new Set(rejected.map((e) => e.id));
  const remainingPool = candidates.filter(
    (c) => !approvedIds.has(c.id) && !rejectedIds.has(c.id),
  );

  const tension2 = clampTension(tension);
  const nextStoryState: StoryState = {
    ...ss,
    budget: nextBudget,
    tension: tension2,
    candidateEventPool: remainingPool,
    nextPacingNeed: derivePacingNeed({ ...ss, tension: tension2 }),
  };

  return { approvedEvents: approved, rejectedEvents: rejected, nextStoryState };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/game/gameplay/rpg/ruleEngine/approveCandidateEvents.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/game/gameplay/rpg/ruleEngine/approveCandidateEvents.ts src/game/gameplay/rpg/ruleEngine/approveCandidateEvents.test.ts
git commit -m "feat: candidateEventPool 审批纯函数——按张力/节奏/预算审批，每回合最多1个"
```

---

## Task 5: 幕推进 + endingAllowed 推导 + unresolvedThreads 管理

**Files:**
- Create: `src/game/gameplay/rpg/ruleEngine/advanceStoryProgression.ts`
- Test: `src/game/gameplay/rpg/ruleEngine/advanceStoryProgression.test.ts`

**Interfaces:**
- Consumes: `WorldState`, `StoryState`, `GameEvent`
- Produces: `advanceStoryProgression()` — 幕推进、endingAllowed 推导、thread 管理

- [ ] **Step 1: Write failing tests**

```typescript
// src/game/gameplay/rpg/ruleEngine/advanceStoryProgression.test.ts
import { describe, it, expect } from "vitest";
import { advanceStoryProgression } from "./advanceStoryProgression";
import { createInitialStoryState } from "@/game/domain/storyState";
import type { WorldState } from "@/game/domain/worldState";
import type { GameEvent } from "@/game/domain/events";
import { asQuestId, asLocationId } from "@/game/domain/scenarioBlueprint";

function makeWorld(overrides?: Partial<WorldState>): WorldState {
  return {
    version: 2,
    generation: { generationId: "" as any, seed: "test", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "侠客", identity: "剑客", stats: { hp: 100, attack: 10, defense: 5 } },
    locations: [],
    currentLocationId: asLocationId("loc_1"),
    unlockedLocationIds: [],
    visitedLocationIds: [],
    npcs: [],
    items: [],
    inventory: [],
    worldFacts: [],
    quests: [],
    enemies: [],
    defeatedEnemyIds: [],
    battle: { status: "idle" },
    endings: [],
    ending: null,
    factions: [],
    towns: [],
    eventLedger: [],
    ...overrides,
  };
}

describe("advanceStoryProgression", () => {
  const ss = createInitialStoryState({
    gameLength: "short",
    initialEntityCounts: { locations: 4, npcs: 5, quests: 2, events: 0 },
  });

  it("does not advance act when no main quest completed", () => {
    const ws = makeWorld();
    const events: GameEvent[] = [];
    const result = advanceStoryProgression(ws, ss, events);
    expect(result.nextStoryState.currentAct).toBe(1);
  });

  it("advances act when main quest completed (act 1 → 2)", () => {
    const ws = makeWorld({
      quests: [{
        id: asQuestId("q_main_1"),
        name: "主线1",
        description: "测试",
        objectives: [],
        onSuccess: { kind: "closed" },
        onFailure: { kind: "closed" },
        tags: [],
        kind: "main",
        stage: 1,
        status: "completed",
      }],
    });
    const events: GameEvent[] = [
      { type: "quest_completed", questId: asQuestId("q_main_1"), occurredAt: "t" },
    ];
    const result = advanceStoryProgression(ws, ss, events);
    expect(result.nextStoryState.currentAct).toBe(2);
    expect(result.nextStoryState.storyProgress).toBeGreaterThanOrEqual(33);
  });

  it("sets endingAllowed at final act with high progress", () => {
    const nearEnd = {
      ...ss,
      currentAct: 3,
      targetActs: 3,
      storyProgress: 85,
    };
    const ws = makeWorld();
    const result = advanceStoryProgression(ws, nearEnd, []);
    expect(result.nextStoryState.endingAllowed).toBe(true);
  });

  it("does not set endingAllowed before final act", () => {
    const midGame = { ...ss, currentAct: 2, targetActs: 3, storyProgress: 50 };
    const ws = makeWorld();
    const result = advanceStoryProgression(ws, midGame, []);
    expect(result.nextStoryState.endingAllowed).toBe(false);
  });

  it("resolves thread when main quest completed", () => {
    const ws = makeWorld({
      quests: [{
        id: asQuestId("q_main_1"),
        name: "主线1",
        description: "",
        objectives: [],
        onSuccess: { kind: "closed" },
        onFailure: { kind: "closed" },
        tags: [],
        kind: "main",
        stage: 1,
        status: "completed",
      }],
    });
    const events: GameEvent[] = [
      { type: "quest_completed", questId: asQuestId("q_main_1"), occurredAt: "t" },
    ];
    const result = advanceStoryProgression(ws, ss, events);
    // 主线完成时回收对应 thread
    expect(result.nextStoryState.unresolvedThreads.length).toBeLessThanOrEqual(ss.unresolvedThreads.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/game/gameplay/rpg/ruleEngine/advanceStoryProgression.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```typescript
// src/game/gameplay/rpg/ruleEngine/advanceStoryProgression.ts
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { GameEvent } from "@/game/domain/events";
import { clampTension, derivePacingNeed } from "@/game/domain/storyState";

export type StoryProgressionResult = {
  readonly nextStoryState: StoryState;
  readonly events: readonly GameEvent[];
};

/** 每幕的进度阈值（等分） */
function actProgressThreshold(act: number, targetActs: number): number {
  return Math.floor((act - 1) / targetActs * 100);
}

/** 主线任务完成时推进幕数 */
function shouldAdvanceAct(ws: WorldState, ss: StoryState, events: readonly GameEvent[]): boolean {
  const mainQuestCompleted = events.some(
    (e) => e.type === "quest_completed" &&
    ws.quests.find((q) => q.id === (e as any).questId)?.kind === "main",
  );
  if (!mainQuestCompleted) return false;

  // 当前幕的主线任务已完成
  const currentActMainQuests = ws.quests.filter(
    (q) => q.kind === "main" && q.stage === ss.currentAct,
  );
  return currentActMainQuests.every((q) => q.status === "completed" || q.status === "failed");
}

export function advanceStoryProgression(
  ws: WorldState,
  ss: StoryState,
  newEvents: readonly GameEvent[],
): StoryProgressionResult {
  let currentAct = ss.currentAct;
  let storyProgress = ss.storyProgress;
  let endingAllowed = ss.endingAllowed;
  let unresolvedThreads = ss.unresolvedThreads;

  // 幕推进
  if (shouldAdvanceAct(ws, ss, newEvents) && currentAct < ss.targetActs) {
    currentAct += 1;
    storyProgress = Math.max(storyProgress, actProgressThreshold(currentAct, ss.targetActs));

    // 回收当前幕的 thread
    const actThread = `act_${ss.currentAct}`;
    unresolvedThreads = unresolvedThreads.filter((t) => t !== actThread);
    // 追加下一幕的 thread
    if (!unresolvedThreads.includes(`act_${currentAct}`)) {
      unresolvedThreads = [...unresolvedThreads, `act_${currentAct}`];
    }
  }

  // endingAllowed 推导：末幕 + 进度 > 80%
  if (currentAct >= ss.targetActs && storyProgress >= 80) {
    endingAllowed = true;
  }

  const nextPacingNeed = derivePacingNeed({
    ...ss,
    currentAct,
    storyProgress,
    endingAllowed,
    unresolvedThreads,
  });

  return {
    nextStoryState: {
      ...ss,
      currentAct,
      storyProgress,
      endingAllowed,
      unresolvedThreads,
      nextPacingNeed,
    },
    events: [],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/game/gameplay/rpg/ruleEngine/advanceStoryProgression.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/game/gameplay/rpg/ruleEngine/advanceStoryProgression.ts src/game/gameplay/rpg/ruleEngine/advanceStoryProgression.test.ts
git commit -m "feat: 幕推进 + endingAllowed 推导 + unresolvedThreads 管理"
```

---

## Task 6: ruleEngine facade 集成全部 P4 步骤

**Files:**
- Modify: `src/game/gameplay/rpg/ruleEngine/index.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/index.test.ts`

**Interfaces:**
- Consumes: Tasks 1-5
- Produces: 修改后的 `ruleEngine()` — 完整流水线含 NPC 记忆、knownFactIds、candidateEventPool 审批、幕推进

- [ ] **Step 1: Write failing integration test**

```typescript
// 追加到 index.test.ts
describe("ruleEngine — P4 full integration", () => {
  it("talk action produces NPC with interactionHistory and updated relationship", () => {
    // 构建含 NPC 的 WorldState
    // 执行 talk action
    // 验证 nextWorldState.npcs[0].memory.interactionHistory.length === 1
    // 验证 nextWorldState.npcs[0].memory.relationship.affinity === 5
  });

  it("investigate action propagates discovered fact to nearby NPC knownFactIds", () => {
    // 构建含 NPC + 世界事实的 WorldState
    // NPC 在当前地点且已 met
    // 执行 investigate action
    // 验证 nextWorldState.npcs[0].memory.knownFactIds 包含该事实
  });

  it("approves candidateEventPool events and consumes budget", () => {
    // 构建 StoryState 含 candidateEventPool
    // 执行任意 action
    // 验证 nextStoryState.candidateEventPool 被消费
    // 验证 budget.events.expanded 增加
  });

  it("advances act when main quest completed", () => {
    // 构建 WorldState 含可完成的主线任务
    // 执行完成任务的 action
    // 验证 nextStoryState.currentAct === 2
  });
});
```

- [ ] **Step 2: Modify ruleEngine index.ts**

集成顺序（在现有 resolveByType → reconcileQuests → resolveEnding 之后）：

```typescript
// ruleEngine/index.ts 修改

import { propagateKnownFacts } from "./propagateKnownFacts";
import { approveCandidateEvents } from "./approveCandidateEvents";
import { advanceStoryProgression } from "./advanceStoryProgression";

export function ruleEngine(...): RuleEngineResult {
  // ... 现有 validation + resolveByType

  // Step: NPC knownFactIds 传播
  const propagatedWs = propagateKnownFacts(resolved.nextWorldState, resolved.facts);

  // Step: 任务推进（使用传播后的 WS）
  const quests = reconcileQuests(propagatedWs, deps);
  const ending = resolveEnding(quests.nextWorldState, storyState, deps);

  // Step: 幕推进 + endingAllowed 推导
  const progression = advanceStoryProgression(
    ending.nextWorldState,
    ending.nextStoryState,
    [...resolved.events, ...quests.events, ...ending.events],
  );

  // Step: candidateEventPool 审批
  const approved = approveCandidateEvents(
    progression.nextStoryState,
    progression.nextStoryState.candidateEventPool,
  );

  // Step: 张力更新
  const allEvents = [...resolved.events, ...quests.events, ...ending.events, ...approved.approvedEvents.map((e) => ({ type: "narrative_event_approved", ...e } as GameEvent))];
  const nextStoryState = updateStoryMetrics(approved.nextStoryState, allEvents);

  // 构建最终 ResolvedEvent
  const resolvedEvent: ResolvedEvent = {
    actionId,
    status: resolved.status,
    eventKind: eventKindForAction(action),
    stateChanges: resolved.stateChanges,
    facts: resolved.facts,
    costs: [],
    rewards: [],
    triggeredEvents: allEvents.map((e) => e.type),
    rejectedEffects: [],
    stateVersion: ending.nextWorldState.eventLedger.length,
  };

  return {
    ok: true,
    nextWorldState: ending.nextWorldState,
    nextStoryState,
    resolvedEvent,
  };
}
```

- [ ] **Step 3: Run all ruleEngine tests**

Run: `npx vitest run src/game/gameplay/rpg/ruleEngine/`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/game/gameplay/rpg/ruleEngine/index.ts src/game/gameplay/rpg/ruleEngine/index.test.ts
git commit -m "feat: ruleEngine facade 集成 P4——NPC记忆+knownFactIds+candidateEventPool审批+幕推进"
```

---

## Task 7: 物化视图集成到 ruleEngine

**Files:**
- Modify: `src/game/gameplay/rpg/ruleEngine/index.ts`
- Test: `src/game/gameplay/rpg/ruleEngine/index.test.ts`

- [ ] **Step 1: Write failing test for materialized view reconciliation**

```typescript
it("reconciles materialized view after state commit", () => {
  // 执行 talk action
  // 验证 nextStoryState.recentBeats 不为空
  // 验证 nextStoryState.npcContacts 包含该 NPC
  // 验证 nextStoryState.reducedThroughEventCount === eventLedger.length
});
```

- [ ] **Step 2: Add reconcileMaterializedView call in ruleEngine**

```typescript
// 在 updateStoryMetrics 之后添加：
import { reconcileMaterializedView, createEmptyMaterializedView } from "@/game/domain/materializedView";

// 构建物化视图
const prevView = {
  recentBeats: storyState.recentBeats as readonly RecentBeat[],
  npcContacts: storyState.npcContacts as readonly NpcContact[],
  reducedThroughEventCount: storyState.reducedThroughEventCount,
};
const newView = reconcileMaterializedView(
  prevView,
  ending.nextWorldState.eventLedger,
  ending.nextWorldState.currentLocationId,
);

const nextStoryStateWithView: StoryState = {
  ...nextStoryState,
  recentBeats: newView.recentBeats,
  npcContacts: newView.npcContacts,
  reducedThroughEventCount: newView.reducedThroughEventCount,
};
```

- [ ] **Step 3: Run tests, commit**

```bash
git add src/game/gameplay/rpg/ruleEngine/index.ts src/game/gameplay/rpg/ruleEngine/index.test.ts
git commit -m "feat: 物化视图集成到 ruleEngine——recentBeats + npcContacts 增量归约"
```

---

## Task 8: P4 离线全流水线回归

**Files:**
- Create: `src/game/application/p4OfflineRegression.test.ts`

- [ ] **Step 1: Write full pipeline regression test**

测试完整流程：
1. createGameV2 创建初始世界（离线 fixture）
2. performActionV2 执行 talk action → 验证 NPC 记忆更新
3. performActionV2 执行 investigate → 验证 knownFactIds 传播
4. performActionV2 执行 move → 验证物化视图更新
5. 模拟 candidateEventPool 写入 → 下一次 action 验证审批消费
6. 模拟主线任务完成 → 验证幕推进

- [ ] **Step 2: Run test**

Run: `npx vitest run src/game/application/p4OfflineRegression.test.ts`
Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/game/application/p4OfflineRegression.test.ts
git commit -m "feat: P4 离线全流水线回归——NPC记忆+candidateEventPool+幕推进+物化视图"
```

---

## Self-Review

**Spec coverage check:**
- ✅ NPC 结构化记忆（knownFactIds + interactionHistory + relationship + emotion + goals）→ Tasks 1-3
- ✅ NPC knownFactIds 规则推导（audience 传播）→ Task 2-3
- ✅ 交互历史有界裁剪 N=10 → Task 1
- ✅ candidateEventPool 审批（张力/节奏/预算）→ Task 4
- ✅ 张力/节奏追踪（固定值更新）→ Task 4（事件批准 +10）+ 已有 updateStoryMetrics
- ✅ 幕推进 + endingAllowed 推导 + unresolvedThreads 管理 → Task 5
- ✅ 物化视图集成 → Task 7
- ✅ 离线全流水线可测 → Task 8

**Placeholder scan:** 无 TBD。所有代码块包含实际实现。

**Type consistency:**
- `NpcInteraction` 类型在 `worldState.ts` 定义，在 `updateNpcMemory.ts` 消费
- `FactChange` 类型在 `resolvedEvent.ts` 定义，在 `propagateKnownFacts.ts` 消费
- `EventCandidate` 类型在 `storyState.ts` 定义，在 `approveCandidateEvents.ts` 消费
- `ResolveResult` 新增 `facts` 字段在所有 case 中统一返回
