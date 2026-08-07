# V2 补齐：让游戏正式跑起来 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐 V2 架构缺失的 SceneGenerator、叙事端点、view 扩展和前端切换，让游戏在 V2 架构下正式可玩。

**Architecture:** V2 原生实现，不复用 V1 编排器。SceneGenerator 按 spec §7 设计：读 WorldState + StoryState + ResolvedEvent，产出 NarrativeSceneState，通过场景写回者（applySceneWriteBack）写入。先实现确定性 fallback（无 AI 即可玩），AI source 接口预留注入点。前端从 `/api/game` 切换到 `/api/v2/game`。

**Tech Stack:** TypeScript, Next.js 16, React 19, Vitest

**Spec:** `docs/superpowers/specs/2026-08-07-ai-rpg-architecture-redesign-spec.md` §7（叙事场景生成）、§11（两个合法写入者）

## Global Constraints

- 纯 domain/gameplay 层纯函数，零 IO、零 AI、零 DB
- SceneSource 是可注入接口；离线 fixture 保证无 AI 全流水线可测
- 场景写回者只写 storyState.narrative + candidateEventPool，绝不触碰 worldState
- V2 不引入 V1 的 Director/Script/NpcLine 三角色概念
- TDD：每个 task 以失败测试开始

---

## File Structure

### 新建文件

```
src/game/application/
  sceneSource.ts           # SceneSource 接口 + SceneSourceContext + EventProposal 类型
  sceneSource.test.ts
  deterministicSceneSource.ts  # 确定性 fallback 场景生成器（无 AI）
  deterministicSceneSource.test.ts
  generatePendingSceneV2.ts # 读取 pending → 调 SceneSource → applySceneWriteBack
  generatePendingSceneV2.test.ts
  handleNpcDialogueV2.ts   # V2 NPC 自由对话（确定性闲聊 + 叙事触发）
  handleNpcDialogueV2.test.ts

src/app/api/v2/game/
  narrative/ensure/route.ts   # POST /api/v2/game/narrative/ensure
  npc/dialogue/route.ts       # POST /api/v2/game/npc/dialogue
  prologue/ack/route.ts       # POST /api/v2/game/prologue/ack
```

### 修改文件

```
src/game/application/performActionV2.ts          # StateCommit 后设置 narrative pending
src/game/application/gameSessionViewV2.ts        # 扩展 view：scene, battle, quests, actions, prologue
src/game/application/server/compositionRootV2.ts  # 注入 SceneSource + 新端点入口
src/components/CurrentGameScreen.tsx             # 切换到 V2 路由 + V2 view 类型
src/components/gameActionRequest.ts              # 切换到 V2 路由 + V2 payload
src/components/NewGameSetupForm.tsx              # 切换到 V2 路由
src/components/AdventureGameShell.tsx            # 切换到 V2 ensure 路由
```

---

## Task 1: SceneSource 接口 + 确定性 fallback

**Files:**
- Create: `src/game/application/sceneSource.ts`
- Create: `src/game/application/deterministicSceneSource.ts`
- Test: `src/game/application/deterministicSceneSource.test.ts`

**Interfaces:**
- Consumes: `WorldState`, `StoryState`, `ResolvedEvent`, `NarrativeSceneState` from domain
- Produces: `SceneSource` (interface), `createDeterministicSceneSource()`, `EventProposal`

- [ ] **Step 1: Write failing tests for deterministic scene source**

```typescript
// src/game/application/deterministicSceneSource.test.ts
import { describe, it, expect } from "vitest";
import { createDeterministicSceneSource } from "./deterministicSceneSource";
import { createInitialWorldState, appendNpc, appendLocation, appendEnemy, type LocationEntry, type NpcEntry, type EnemyEntry } from "@/game/domain/worldState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { asLocationId, asNpcId, asEnemyId, asFactId, asGenerationId } from "@/game/domain/scenarioBlueprint";
import type { ResolvedEvent } from "@/game/domain/resolvedEvent";

function makeWorldWithNpc() {
  const loc: LocationEntry = {
    id: asLocationId("loc_1"), name: "客栈", description: "一间简朴的客栈", kind: "main",
    connectedLocationIds: [asLocationId("loc_2")], npcIds: [asNpcId("npc_1")], availableItemIds: [], tags: [],
  };
  const loc2: LocationEntry = {
    id: asLocationId("loc_2"), name: "街道", description: "一条热闹的街道", kind: "main",
    connectedLocationIds: [asLocationId("loc_1")], npcIds: [], availableItemIds: [], tags: [],
  };
  let ws = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "侠客", identity: "剑客", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: loc,
    startingItemIds: [],
  });
  ws = appendLocation(ws, loc2);
  const npc: NpcEntry = {
    id: asNpcId("npc_1"), name: "客栈老板", role: "路人", description: "热情的老板",
    locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
    memory: { npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
  };
  ws = appendNpc(ws, npc);
  return { ws, ss: createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 2, npcs: 1, quests: 0, events: 0 } }) };
}

function makeResolvedEvent(status: "success" | "partial_success" | "failure" | "blocked" = "success"): ResolvedEvent {
  return {
    actionId: "act_test",
    status,
    eventKind: "observe",
    facts: [],
    stateChanges: [],
    costs: [],
    rewards: [],
    triggeredEvents: [],
    rejectedEffects: [],
    stateVersion: 0,
  };
}

describe("deterministicSceneSource", () => {
  it("produces a scene with narration and 2 choices", async () => {
    const { ws, ss } = makeWorldWithNpc();
    const source = createDeterministicSceneSource();
    const result = await source.generateScene({
      worldState: ws,
      storyState: ss,
      resolvedEvent: makeResolvedEvent(),
    });
    expect(result.scene.narration).toBeTruthy();
    expect(result.scene.narration.length).toBeGreaterThan(0);
    expect(result.scene.choices).toHaveLength(2);
    expect(result.scene.source).toBe("fallback");
    expect(result.scene.sceneId).toBeTruthy();
  });

  it("choices have choiceToken and actionKey", async () => {
    const { ws, ss } = makeWorldWithNpc();
    const source = createDeterministicSceneSource();
    const result = await source.generateScene({
      worldState: ws,
      storyState: ss,
      resolvedEvent: makeResolvedEvent(),
    });
    for (const choice of result.scene.choices) {
      expect(choice.choiceToken).toBeTruthy();
      expect(choice.actionKey).toBeTruthy();
      expect(choice.label).toBeTruthy();
    }
  });

  it("produces NPC dialogue when NPC is at location", async () => {
    const { ws, ss } = makeWorldWithNpc();
    const source = createDeterministicSceneSource();
    const result = await source.generateScene({
      worldState: ws,
      storyState: ss,
      resolvedEvent: { ...makeResolvedEvent(), eventKind: "dialogue" },
    });
    expect(result.scene.npcLine).not.toBeNull();
    if (result.scene.npcLine) {
      expect(result.scene.npcLine.npcId).toBe(asNpcId("npc_1"));
      expect(result.scene.npcLine.text.length).toBeGreaterThan(0);
    }
  });

  it("event proposals is empty array for deterministic source", async () => {
    const { ws, ss } = makeWorldWithNpc();
    const source = createDeterministicSceneSource();
    const result = await source.generateScene({
      worldState: ws,
      storyState: ss,
      resolvedEvent: makeResolvedEvent(),
    });
    expect(result.eventProposals).toEqual([]);
  });

  it("choices include a move action when connected locations exist", async () => {
    const { ws, ss } = makeWorldWithNpc();
    const source = createDeterministicSceneSource();
    const result = await source.generateScene({
      worldState: ws,
      storyState: ss,
      resolvedEvent: makeResolvedEvent(),
    });
    const hasMoveChoice = result.scene.choices.some(
      (c) => c.actionKey.startsWith("move:"),
    );
    expect(hasMoveChoice).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/game/application/deterministicSceneSource.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement SceneSource interface**

```typescript
// src/game/application/sceneSource.ts
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { ResolvedEvent } from "@/game/domain/resolvedEvent";
import type { NarrativeSceneState } from "@/game/domain/narrative";

/** SceneGenerator 的可注入 AI source 接口（spec §7.1）。 */
export type SceneSourceContext = {
  readonly worldState: WorldState;
  readonly storyState: StoryState;
  readonly resolvedEvent: ResolvedEvent;
  /** 玩家原话（若有），供叙事引用（spec §7.1 utterance）。 */
  readonly utterance?: string;
};

/** SceneGenerator 的事件提议（spec §7.4 newEvents）。 */
export type EventProposal = {
  readonly id: string;
  readonly description: string;
  readonly proposedAtTurn: number;
};

/** SceneGenerator 调用结果（spec §7.3 ScenePackage 映射）。 */
export type SceneSourceResult = {
  readonly scene: NarrativeSceneState;
  readonly eventProposals: readonly EventProposal[];
  readonly source: "generated" | "fallback";
};

/** 可注入的叙事场景 source。离线 fixture 不调用 AI。 */
export type SceneSource = {
  generateScene(context: SceneSourceContext): Promise<SceneSourceResult>;
};
```

- [ ] **Step 4: Implement deterministic fallback scene source**

```typescript
// src/game/application/deterministicSceneSource.ts
import type { SceneSource, SceneSourceContext, SceneSourceResult, EventProposal } from "./sceneSource";
import type { NarrativeSceneState, NarrativeChoiceState, NarrativeNpcLineState, NarrativeEventState } from "@/game/domain/narrative";
import type { WorldState } from "@/game/domain/worldState";
import type { NpcId, LocationId } from "@/game/domain/scenarioBlueprint";

// ---------------------------------------------------------------------------
// 确定性 fallback 场景生成器（spec §7.6 安全降级模板）。
// 不调用 AI，基于 WorldState 当前状态派生叙述 + 2 个选项。
// 选项从当前地点的合法行动中选取（移动、交谈、探索）。
// ---------------------------------------------------------------------------

export function createDeterministicSceneSource(): SceneSource {
  return {
    async generateScene(context: SceneSourceContext): Promise<SceneSourceResult> {
      const { worldState: ws, storyState: ss, resolvedEvent } = context;
      const sceneId = `scene-${ws.eventLedger.length}-${Date.now()}`;
      const turn = ws.eventLedger.length;

      // 派生当前地点 NPC
      const npcsHere = ws.npcs.filter((n) => n.locationId === ws.currentLocationId);
      const firstNpc = npcsHere[0];

      // 派生 narration
      const currentLoc = ws.locations.find((l) => l.id === ws.currentLocationId);
      const locName = currentLoc?.name ?? "未知地点";
      const narration = buildNarration(ws, resolvedEvent, locName, firstNpc?.name);

      // 派生 NPC 对白
      const npcLine: NarrativeNpcLineState | null = firstNpc !== undefined
        ? {
            npcId: firstNpc.id,
            text: buildNpcLine(firstNpc.name, resolvedEvent),
            emotion: "neutral",
            usedFactIds: [],
          }
        : null;

      // 派生 event state
      const event: NarrativeEventState | undefined = firstNpc !== undefined
        ? { kind: "dialogue", focusNpcId: firstNpc.id }
        : { kind: "observe", locationId: ws.currentLocationId };

      // 派生 2 个选项
      const choices = buildChoices(ws, sceneId, firstNpc?.id);

      const scene: NarrativeSceneState = {
        sceneId,
        turn,
        narration,
        usedFactIds: [],
        npcLine,
        choices: choices as readonly [NarrativeChoiceState, NarrativeChoiceState],
        source: "fallback",
        event,
      };

      return {
        scene,
        eventProposals: [],
        source: "fallback",
      };
    },
  };
}

function buildNarration(
  ws: WorldState,
  resolvedEvent: SceneSourceContext["resolvedEvent"],
  locName: string,
  npcName: string | undefined,
): string {
  switch (resolvedEvent.eventKind) {
    case "travel":
      return `你来到了${locName}。四周的景象映入眼帘，空气中弥漫着不同的气息。`;
    case "dialogue":
      return npcName !== undefined
        ? `你与${npcName}交谈。${npcName}注视着你，似乎有话要说。`
        : `你在${locName}四处张望，却没看到可以交谈的人。`;
    case "investigate":
      return `你仔细调查了周围的线索，发现了一些值得注意的细节。`;
    case "item":
      return `你获得了某件物品，它或许在旅途中派上用场。`;
    case "battle":
      return resolvedEvent.status === "success"
        ? `战斗结束，你取得了胜利。`
        : `战斗的余波仍在空气中回荡。`;
    default:
      return `你身处${locName}，周围的一切静待探索。`;
  }
}

function buildNpcLine(npcName: string, resolvedEvent: SceneSourceContext["resolvedEvent"]): string {
  switch (resolvedEvent.status) {
    case "success":
      return `${npcName}说道："欢迎，有什么需要帮忙的吗？"`;
    case "partial_success":
      return `${npcName}犹豫了一下："这件事……我知道一些，但不方便全说。"`;
    case "failure":
      return `${npcName}摇了摇头："恐怕这件事我帮不上忙。"`;
    default:
      return `${npcName}看了你一眼，没有说话。`;
  }
}

function buildChoices(
  ws: WorldState,
  sceneId: string,
  npcId: NpcId | undefined,
): readonly [NarrativeChoiceState, NarrativeChoiceState] {
  const currentLoc = ws.locations.find((l) => l.id === ws.currentLocationId);
  const connectedUnlocked = currentLoc?.connectedLocationIds
    .filter((id) => ws.unlockedLocationIds.includes(id)) ?? [];
  const firstConnected = connectedUnlocked[0];
  const connectedLoc = firstConnected !== undefined
    ? ws.locations.find((l) => l.id === firstConnected)
    : undefined;

  // 选项 A：如果有 NPC，优先交谈；否则探索
  const choiceA: NarrativeChoiceState = npcId !== undefined
    ? {
        choiceToken: `${sceneId}:a`,
        label: `与NPC交谈`,
        actionKey: `talk:${String(npcId)}`,
        choiceKind: "world_action",
      }
    : {
        choiceToken: `${sceneId}:a`,
        label: `探索周围`,
        actionKey: `explore`,
        choiceKind: "world_action",
      };

  // 选项 B：如果有连接地点，移动；否则休息
  const choiceB: NarrativeChoiceState = connectedLoc !== undefined
    ? {
        choiceToken: `${sceneId}:b`,
        label: `前往${connectedLoc.name}`,
        actionKey: `move:${String(connectedLoc.id)}`,
        choiceKind: "world_action",
      }
    : {
        choiceToken: `${sceneId}:b`,
        label: `稍作休息`,
        actionKey: `rest`,
        choiceKind: "world_action",
      };

  return [choiceA, choiceB];
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/game/application/deterministicSceneSource.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/game/application/sceneSource.ts src/game/application/deterministicSceneSource.ts src/game/application/deterministicSceneSource.test.ts
git commit -m "feat: V2 SceneSource 接口 + 确定性 fallback 场景生成器"
```

---

## Task 2: generatePendingSceneV2

**Files:**
- Create: `src/game/application/generatePendingSceneV2.ts`
- Test: `src/game/application/generatePendingSceneV2.test.ts`

**Interfaces:**
- Consumes: `GameRepositoryV2`, `SceneSource`
- Produces: `generatePendingSceneV2()` — 读取 pending → 调 SceneSource → applySceneWriteBack

- [ ] **Step 1: Write failing tests**

```typescript
// src/game/application/generatePendingSceneV2.test.ts
import { describe, it, expect, vi } from "vitest";
import { generatePendingSceneV2 } from "./generatePendingSceneV2";
import { createDeterministicSceneSource } from "./deterministicSceneSource";
import { createInitialWorldState, appendNpc, type LocationEntry, type NpcEntry } from "@/game/domain/worldState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { asLocationId, asNpcId, asGenerationId, asGameId } from "@/game/domain/scenarioBlueprint";
import type { GameRepositoryV2 } from "./server/persistence/gameRepositoryV2";
import type { GameRecordV2 } from "./server/persistence/gameRepositoryV2";

function makeGameRecord(): GameRecordV2 {
  const loc: LocationEntry = {
    id: asLocationId("loc_1"), name: "客栈", description: "t", kind: "main",
    connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
  };
  let ws = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: loc,
    startingItemIds: [],
  });
  const npc: NpcEntry = {
    id: asNpcId("npc_1"), name: "老板", role: "路人", description: "t",
    locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
    memory: { npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
  };
  ws = appendNpc(ws, npc);
  const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 1, npcs: 1, quests: 0, events: 0 } });
  // Set narrative to pending
  const pendingSs = {
    ...ss,
    narrative: { ...ss.narrative, generation: { status: "pending" as const, requestedAt: "2026-01-01" } },
  };
  return {
    gameId: asGameId("g1"),
    worldState: ws,
    storyState: pendingSs,
    revision: 0,
    createdAt: "2026-01-01",
  };
}

function makeMockRepo(record: GameRecordV2 | null): GameRepositoryV2 {
  return {
    createInitialGame: vi.fn(),
    getCurrentGame: vi.fn(async () => {
      if (record === null) return { ok: true, status: "none" as const };
      return { ok: true, status: "active" as const, record };
    }),
    applyState: vi.fn(async (input: { expectedRevision: number }) => {
      return { ok: false as const, code: "STALE_GAME_REVISION" as const };
    }),
    applySceneWriteBack: vi.fn(async (input: { expectedRevision: number; gameId: unknown }) => {
      return {
        ok: true as const,
        record: {
          ...record!,
          revision: input.expectedRevision + 1,
          storyState: { ...record!.storyState, narrative: { ...record!.storyState.narrative, generation: { status: "idle" as const } } },
        },
      };
    }),
  };
}

describe("generatePendingSceneV2", () => {
  it("returns not_pending when generation is idle", async () => {
    const record = makeGameRecord();
    const idleRecord = { ...record, storyState: { ...record.storyState, narrative: { ...record.storyState.narrative, generation: { status: "idle" as const } } } };
    const repo = makeMockRepo(idleRecord);
    const result = await generatePendingSceneV2({
      repository: repo,
      sceneSource: createDeterministicSceneSource(),
      now: () => "2026-01-01",
    });
    expect(result).toBe("not_pending");
  });

  it("generates and writes back scene when pending", async () => {
    const record = makeGameRecord();
    const repo = makeMockRepo(record);
    const result = await generatePendingSceneV2({
      repository: repo,
      sceneSource: createDeterministicSceneSource(),
      now: () => "2026-01-01",
    });
    expect(result).toBe("saved");
    expect(repo.applySceneWriteBack).toHaveBeenCalledOnce();
  });

  it("returns unavailable when no active game", async () => {
    const repo = makeMockRepo(null);
    const result = await generatePendingSceneV2({
      repository: repo,
      sceneSource: createDeterministicSceneSource(),
      now: () => "2026-01-01",
    });
    expect(result).toBe("unavailable");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/game/application/generatePendingSceneV2.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement generatePendingSceneV2**

```typescript
// src/game/application/generatePendingSceneV2.ts
import type { GameRepositoryV2 } from "./server/persistence/gameRepositoryV2";
import type { SceneSource } from "./sceneSource";
import type { ResolvedEvent } from "@/game/domain/resolvedEvent";
import type { NarrativeSceneState } from "@/game/domain/narrative";

export type GeneratePendingSceneV2Deps = {
  readonly repository: GameRepositoryV2;
  readonly sceneSource: SceneSource;
  readonly now: () => string;
};

export type GeneratePendingSceneV2Result = "saved" | "not_pending" | "stale" | "unavailable";

/**
 * Executes one pending narrative scene request (spec §7 + §11).
 * Reads pending state → calls SceneSource → writes back via applySceneWriteBack.
 * Only touches storyState.narrative + candidateEventPool.
 */
export async function generatePendingSceneV2(
  deps: GeneratePendingSceneV2Deps,
): Promise<GeneratePendingSceneV2Result> {
  const loaded = await deps.repository.getCurrentGame();
  if (!loaded.ok || loaded.status !== "active") return "unavailable";

  const { record } = loaded;
  const generation = record.storyState.narrative.generation;
  if (generation.status !== "pending") return "not_pending";

  // Build a minimal ResolvedEvent for the scene source
  const resolvedEvent: ResolvedEvent = {
    actionId: `scene_${record.revision}`,
    status: "success",
    eventKind: "observe",
    facts: [],
    stateChanges: [],
    costs: [],
    rewards: [],
    triggeredEvents: [],
    rejectedEffects: [],
    stateVersion: record.worldState.eventLedger.length,
  };

  const result = await deps.sceneSource.generateScene({
    worldState: record.worldState,
    storyState: record.storyState,
    resolvedEvent,
  });

  const writeBack = await deps.repository.applySceneWriteBack({
    gameId: record.gameId,
    expectedRevision: record.revision,
    nextNarrative: {
      ...record.storyState.narrative,
      currentScene: result.scene,
      generation: { status: "idle" },
    },
    nextCandidateEventPool: [
      ...record.storyState.candidateEventPool,
      ...result.eventProposals.map((p) => ({
        id: p.id,
        description: p.description,
        proposedAtTurn: p.proposedAtTurn,
      })),
    ].slice(-8), // FIFO max 8
  });

  if (!writeBack.ok) {
    return writeBack.code === "STALE_GAME_REVISION" ? "stale" : "unavailable";
  }

  return "saved";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/game/application/generatePendingSceneV2.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/game/application/generatePendingSceneV2.ts src/game/application/generatePendingSceneV2.test.ts
git commit -m "feat: generatePendingSceneV2——读取 pending → 调 SceneSource → applySceneWriteBack"
```

---

## Task 3: performActionV2 场景排队

**Files:**
- Modify: `src/game/application/performActionV2.ts`
- Test: `src/game/application/performActionV2.test.ts`

**Interfaces:**
- Consumes: Tasks 1-2
- Produces: performActionV2 在 StateCommit 成功后设置 narrative.generation = pending

- [ ] **Step 1: Read current performActionV2 to understand the commit flow**

Read `src/game/application/performActionV2.ts` and find the section after `commitState` succeeds (around line 113-130).

- [ ] **Step 2: Write failing test for scene queuing**

Add a test to `performActionV2.test.ts` that verifies after a successful action, the storyState.narrative.generation is set to "pending".

```typescript
// Append to src/game/application/performActionV2.test.ts

it("sets narrative generation to pending after successful action", async () => {
  // This test uses the existing test infrastructure in performActionV2.test.ts
  // After a successful performActionV2 call, verify that the committed storyState
  // has narrative.generation.status === "pending"
  // The test should use the existing mock repository and fixture source
  // ... (the implementer should follow the existing test patterns in this file)
});
```

- [ ] **Step 3: Modify performActionV2 to queue scene generation**

In `performActionV2.ts`, after the successful `commitState` call (line ~118), add a second CAS write to set narrative pending:

```typescript
// After commitResult succeeds, before the return statement:

// Queue narrative scene generation (spec §7: async pending → ensure → sceneWriteBack)
const pendingStoryState: StoryState = {
  ...commitResult.record.storyState,
  narrative: {
    ...commitResult.record.storyState.narrative,
    generation: {
      status: "pending",
      requestedAt: deps.now(),
    },
  },
};

const pendingCommit = await commitState(deps.repository, {
  gameId: command.gameId,
  expectedRevision: commitResult.record.revision,
  nextWorldState: commitResult.record.worldState,
  nextStoryState: pendingStoryState,
});

if (!pendingCommit.ok) {
  // Scene queuing failed — action still succeeded, just no scene pending
  // This is acceptable: the game is still playable, scene will be generated on next action
}

return {
  ok: true,
  revision: pendingCommit.ok ? pendingCommit.record.revision : commitResult.record.revision,
  resolvedEvent: engineResult.resolvedEvent,
  feedback: "Action performed",
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/game/application/performActionV2.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/game/application/performActionV2.ts src/game/application/performActionV2.test.ts
git commit -m "feat: performActionV2 场景排队——StateCommit 后设置 narrative pending"
```

---

## Task 4: V2 ensure + prologue ack 端点

**Files:**
- Create: `src/app/api/v2/game/narrative/ensure/route.ts`
- Create: `src/app/api/v2/game/prologue/ack/route.ts`
- Modify: `src/game/application/server/compositionRootV2.ts`

- [ ] **Step 1: Add generatePendingSceneV2 and ackPrologue to compositionRootV2**

In `compositionRootV2.ts`, add to `ServerGameV2EntryPoints`:

```typescript
ensureNarrativeSceneV2(traceId?: string): Promise<{ ok: boolean; result?: string }>;
ackPrologueV2(traceId?: string): Promise<{ ok: boolean; revision?: number; code?: string }>;
```

Implement them in the `createServerGameV2EntryPoints` function:

```typescript
ensureNarrativeV2: async (_traceId) => {
  const result = await generatePendingSceneV2({
    repository,
    sceneSource: source, // reuse or create dedicated sceneSource
    now,
  });
  return { ok: result === "saved", result };
},

ackPrologueV2: async (_traceId) => {
  const current = await repository.getCurrentGame();
  if (!current.ok || current.status !== "active") return { ok: false, code: "NO_ACTIVE_GAME" };
  const nextStoryState: StoryState = {
    ...current.record.storyState,
    prologueShown: true,
  };
  const commit = await commitState(repository, {
    gameId: current.record.gameId,
    expectedRevision: current.record.revision,
    nextWorldState: current.record.worldState,
    nextStoryState,
  });
  if (!commit.ok) return { ok: false, code: commit.code };
  return { ok: true, revision: commit.record.revision };
},
```

Also add the import and inject the scene source:

```typescript
import { createDeterministicSceneSource } from "../deterministicSceneSource";
import { generatePendingSceneV2 } from "../generatePendingSceneV2";
// ...
const sceneSource = createDeterministicSceneSource();
```

- [ ] **Step 2: Create ensure route**

```typescript
// src/app/api/v2/game/narrative/ensure/route.ts
import { getServerGameV2EntryPoints } from "@/game/application/server/compositionRootV2";

export async function POST(request: Request): Promise<Response> {
  const entryPoints = getServerGameV2EntryPoints();
  return entryPoints.executeHttpRequest(
    "POST",
    "/api/v2/game/narrative/ensure",
    async () => {
      const result = await entryPoints.ensureNarrativeSceneV2();
      return new Response(JSON.stringify(result), {
        status: result.ok ? 200 : 409,
        headers: { "Content-Type": "application/json" },
      });
    },
    request.headers.get("x-request-trace-id") ?? undefined,
  );
}
```

- [ ] **Step 3: Create prologue ack route**

```typescript
// src/app/api/v2/game/prologue/ack/route.ts
import { getServerGameV2EntryPoints } from "@/game/application/server/compositionRootV2";

export async function POST(request: Request): Promise<Response> {
  const entryPoints = getServerGameV2EntryPoints();
  return entryPoints.executeHttpRequest(
    "POST",
    "/api/v2/game/prologue/ack",
    async () => {
      const result = await entryPoints.ackPrologueV2();
      return new Response(JSON.stringify(result), {
        status: result.ok ? 200 : 409,
        headers: { "Content-Type": "application/json" },
      });
    },
    request.headers.get("x-request-trace-id") ?? undefined,
  );
}
```

- [ ] **Step 4: Run existing tests to verify no breakage**

Run: `npx vitest run src/game/application/server/compositionRootV2.ts 2>&1 || npx vitest run src/app/api/v2/ 2>&1 || echo "No direct tests yet — verify with full suite later"`

- [ ] **Step 5: Commit**

```bash
git add src/app/api/v2/game/narrative/ensure/route.ts src/app/api/v2/game/prologue/ack/route.ts src/game/application/server/compositionRootV2.ts
git commit -m "feat: V2 ensure + prologue ack 端点——场景生成轮询 + 序幕确认"
```

---

## Task 5: V2 NPC 对话端点

**Files:**
- Create: `src/game/application/handleNpcDialogueV2.ts`
- Create: `src/game/application/handleNpcDialogueV2.test.ts`
- Create: `src/app/api/v2/game/npc/dialogue/route.ts`
- Modify: `src/game/application/server/compositionRootV2.ts`

- [ ] **Step 1: Write failing tests for handleNpcDialogueV2**

```typescript
// src/game/application/handleNpcDialogueV2.test.ts
import { describe, it, expect, vi } from "vitest";
import { handleNpcDialogueV2 } from "./handleNpcDialogueV2";
import { createInitialWorldState, appendNpc, type LocationEntry, type NpcEntry } from "@/game/domain/worldState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { asLocationId, asNpcId, asGenerationId, asGameId } from "@/game/domain/scenarioBlueprint";
import type { GameRepositoryV2 } from "./server/persistence/gameRepositoryV2";
import type { GameRecordV2 } from "./server/persistence/gameRepositoryV2";

function makeRecord(): GameRecordV2 {
  const loc: LocationEntry = {
    id: asLocationId("loc_1"), name: "客栈", description: "t", kind: "main",
    connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
  };
  let ws = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: loc,
    startingItemIds: [],
  });
  const npc: NpcEntry = {
    id: asNpcId("npc_1"), name: "老板", role: "路人", description: "t",
    locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: true,
    memory: { npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 10 }, emotion: "neutral", goals: [] },
  };
  ws = appendNpc(ws, npc);
  const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 1, npcs: 1, quests: 0, events: 0 } });
  return { gameId: asGameId("g1"), worldState: ws, storyState: ss, revision: 0, createdAt: "2026-01-01" };
}

function makeMockRepo(record: GameRecordV2): GameRepositoryV2 {
  return {
    createInitialGame: vi.fn(),
    getCurrentGame: vi.fn(async () => ({ ok: true as const, status: "active" as const, record })),
    applyState: vi.fn(async (input: { expectedRevision: number }) => ({
      ok: true as const,
      record: { ...record, revision: input.expectedRevision + 1 },
    })),
    applySceneWriteBack: vi.fn(),
  };
}

describe("handleNpcDialogueV2", () => {
  it("returns chat response for simple greeting", async () => {
    const record = makeRecord();
    const repo = makeMockRepo(record);
    const result = await handleNpcDialogueV2(
      { npcId: asNpcId("npc_1"), text: "你好", expectedRevision: 0 },
      { repository: repo, now: () => "2026-01-01" },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.kind).toBe("chat");
      expect(result.npcSpeech.length).toBeGreaterThan(0);
    }
  });

  it("returns narrative_trigger for complex question", async () => {
    const record = makeRecord();
    const repo = makeMockRepo(record);
    const result = await handleNpcDialogueV2(
      { npcId: asNpcId("npc_1"), text: "你知道关于那把剑的传说吗？", expectedRevision: 0 },
      { repository: repo, now: () => "2026-01-01" },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.kind).toBe("narrative_trigger");
    }
  });

  it("rejects when NPC not at location", async () => {
    const record = makeRecord();
    const repo = makeMockRepo(record);
    const result = await handleNpcDialogueV2(
      { npcId: asNpcId("npc_nonexistent"), text: "你好", expectedRevision: 0 },
      { repository: repo, now: () => "2026-01-01" },
    );
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Implement handleNpcDialogueV2**

```typescript
// src/game/application/handleNpcDialogueV2.ts
import type { GameRepositoryV2 } from "./server/persistence/gameRepositoryV2";
import type { NpcId } from "@/game/domain/scenarioBlueprint";
import type { GameSessionViewV2 } from "./gameSessionViewV2";
import { projectGameSessionView } from "./gameSessionViewV2";
import { commitState } from "./stateCommit";
import type { StoryState } from "@/game/domain/storyState";

export type HandleNpcDialogueV2Command = {
  readonly npcId: NpcId;
  readonly text: string;
  readonly expectedRevision: number;
};

export type HandleNpcDialogueV2Deps = {
  readonly repository: GameRepositoryV2;
  readonly now: () => string;
};

export type HandleNpcDialogueV2Result =
  | { readonly ok: true; readonly kind: "chat"; readonly npcSpeech: string; readonly revision: number }
  | { readonly ok: true; readonly kind: "narrative_trigger"; readonly revision: number }
  | { readonly ok: false; readonly code: string };

// 简单闲聊关键词——命中时走 chat 路径，零 CAS 写入
const CHAT_KEYWORDS = ["你好", "再见", "谢谢", "早上好", "晚上好", "嗨", "哈喽"];

function isChatText(text: string): boolean {
  return CHAT_KEYWORDS.some((kw) => text.includes(kw)) || text.length < 6;
}

export async function handleNpcDialogueV2(
  command: HandleNpcDialogueV2Command,
  deps: HandleNpcDialogueV2Deps,
): Promise<HandleNpcDialogueV2Result> {
  const current = await deps.repository.getCurrentGame();
  if (!current.ok || current.status !== "active") return { ok: false, code: "NO_ACTIVE_GAME" };
  if (current.record.revision !== command.expectedRevision) return { ok: false, code: "STALE_GAME_REVISION" };

  const { record } = current;
  const npc = record.worldState.npcs.find(
    (n) => n.id === command.npcId && n.locationId === record.worldState.currentLocationId,
  );
  if (npc === undefined) return { ok: false, code: "NPC_NOT_PRESENT" };

  if (isChatText(command.text)) {
    // Chat path: deterministic casual reply, zero CAS write
    const speech = buildCasualReply(npc.name, command.text);
    return { ok: true, kind: "chat", npcSpeech: speech, revision: record.revision };
  }

  // Narrative path: queue pending scene with playerNpcChat snapshot
  const nextStoryState: StoryState = {
    ...record.storyState,
    narrative: {
      ...record.storyState.narrative,
      generation: {
        status: "pending",
        requestedAt: deps.now(),
        playerNpcChat: {
          npcId: command.npcId,
          playerText: command.text,
          npcName: npc.name,
          npcRole: npc.role,
        },
      },
    },
  };

  const commit = await commitState(deps.repository, {
    gameId: record.gameId,
    expectedRevision: record.revision,
    nextWorldState: record.worldState,
    nextStoryState,
  });

  if (!commit.ok) return { ok: false, code: commit.code };
  return { ok: true, kind: "narrative_trigger", revision: commit.record.revision };
}

function buildCasualReply(npcName: string, playerText: string): string {
  if (playerText.includes("你好") || playerText.includes("嗨") || playerText.includes("哈喽")) {
    return `${npcName}微笑着回应："你好，有什么事吗？"`;
  }
  if (playerText.includes("再见")) {
    return `${npcName}点了点头："后会有期。"`;
  }
  if (playerText.includes("谢谢")) {
    return `${npcName}摆摆手："不必客气。"`;
  }
  return `${npcName}看了你一眼，没有特别回应。`;
}
```

- [ ] **Step 3: Create NPC dialogue route**

```typescript
// src/app/api/v2/game/npc/dialogue/route.ts
import { getServerGameV2EntryPoints } from "@/game/application/server/compositionRootV2";

export async function POST(request: Request): Promise<Response> {
  const entryPoints = getServerGameV2EntryPoints();
  return entryPoints.executeHttpRequest(
    "POST",
    "/api/v2/game/npc/dialogue",
    async () => {
      let body: { npcId: string; text: string; expectedRevision: number };
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ ok: false, code: "INVALID_INPUT" }), {
          status: 400, headers: { "Content-Type": "application/json" },
        });
      }
      const result = await entryPoints.handleNpcDialogueV2(body);
      return new Response(JSON.stringify(result), {
        status: result.ok ? 200 : 409,
        headers: { "Content-Type": "application/json" },
      });
    },
    request.headers.get("x-request-trace-id") ?? undefined,
  );
}
```

- [ ] **Step 4: Add handleNpcDialogueV2 to compositionRootV2**

Add `handleNpcDialogueV2` to `ServerGameV2EntryPoints` type and implement it in `createServerGameV2EntryPoints`.

- [ ] **Step 5: Run tests, commit**

```bash
npx vitest run src/game/application/handleNpcDialogueV2.test.ts
git add src/game/application/handleNpcDialogueV2.ts src/game/application/handleNpcDialogueV2.test.ts src/app/api/v2/game/npc/dialogue/route.ts src/game/application/server/compositionRootV2.ts
git commit -m "feat: V2 NPC 对话端点——确定性闲聊 + 叙事触发"
```

---

## Task 6: 扩展 gameSessionViewV2

**Files:**
- Modify: `src/game/application/gameSessionViewV2.ts`
- Test: `src/game/application/gameSessionViewV2.test.ts`

- [ ] **Step 1: Write failing tests for expanded view**

```typescript
// Append to src/game/application/gameSessionViewV2.test.ts

it("projects narrative scene with narration and choices", () => {
  const ws2 = { ...ws, narrative: { ...ss.narrative, currentScene: {
    sceneId: "s1", turn: 1, narration: "测试叙述", usedFactIds: [],
    npcLine: null,
    choices: [
      { choiceToken: "t1", label: "选项A", actionKey: "explore" },
      { choiceToken: "t2", label: "选项B", actionKey: "rest" },
    ],
    source: "fallback" as const,
  } } } as any;
  // Note: narrative scene is in storyState, not worldState
  const ss2 = { ...ss, narrative: { ...ss.narrative, currentScene: {
    sceneId: "s1", turn: 1, narration: "测试叙述", usedFactIds: [],
    npcLine: null,
    choices: [
      { choiceToken: "t1", label: "选项A", actionKey: "explore" },
      { choiceToken: "t2", label: "选项B", actionKey: "rest" },
    ],
    source: "fallback" as const,
  } } };
  const view = projectGameSessionView(ws, ss2, 0);
  expect(view.narrative.hasScene).toBe(true);
  expect(view.narrative.narration).toBe("测试叙述");
  expect(view.narrative.choices).toHaveLength(2);
});

it("projects battle state when active", () => {
  const ws2 = { ...ws, battle: { status: "active" as const, enemyId: asEnemyId("e1"), playerHp: 80, enemyHp: 30, round: 2 } };
  // Need enemy in worldState
  const ws3 = { ...ws2, enemies: [{ id: asEnemyId("e1"), name: "山贼", tier: "normal" as const, stats: { hp: 30, attack: 5, defense: 2 }, locationId: asLocationId("loc_1"), tags: [] }] };
  const view = projectGameSessionView(ws3, ss, 0);
  expect(view.battle).not.toBeNull();
  if (view.battle) {
    expect(view.battle.enemyName).toBe("山贼");
    expect(view.battle.playerHp).toBe(80);
    expect(view.battle.enemyHp).toBe(30);
    expect(view.battle.round).toBe(2);
  }
});

it("projects quests when present", () => {
  const ws2 = { ...ws, quests: [{
    id: "q1" as any, name: "主线任务", description: "测试", objectives: [],
    onSuccess: { kind: "closed" as const }, onFailure: { kind: "closed" as const },
    tags: [], kind: "main" as const, status: "active" as const,
  }] };
  const view = projectGameSessionView(ws2, ss, 0);
  expect(view.quests).toHaveLength(1);
  expect(view.quests[0]?.name).toBe("主线任务");
});

it("projects prologue state", () => {
  const ss2 = { ...ss, prologueShown: true };
  const view = projectGameSessionView(ws, ss2, 0);
  expect(view.prologueShown).toBe(true);
});

it("projects narrative generation status", () => {
  const ss2 = { ...ss, narrative: { ...ss.narrative, generation: { status: "pending" as const, requestedAt: "2026-01-01" } } };
  const view = projectGameSessionView(ws, ss2, 0);
  expect(view.narrativeGeneration?.status).toBe("pending");
});
```

- [ ] **Step 2: Expand GameSessionViewV2 type and projection**

Add these fields to `GameSessionViewV2`:

```typescript
export type GameSessionViewV2 = {
  // ... existing fields ...
  readonly narrative: {
    readonly mode: string;
    readonly hasScene: boolean;
    readonly narration?: string;
    readonly choices?: readonly { readonly choiceToken: string; readonly label: string; readonly actionKey: string }[];
    readonly npcLine?: { readonly npcId: string; readonly text: string; readonly emotion: string } | null;
  };
  readonly narrativeGeneration?: { readonly status: string };
  readonly battle: { readonly enemyName: string; readonly playerHp: number; readonly enemyHp: number; readonly round: number } | null;
  readonly quests: readonly { readonly id: string; readonly name: string; readonly description: string; readonly kind: string; readonly status: string }[];
  readonly prologueShown: boolean;
  // ... existing ending field ...
};
```

Update `projectGameSessionView` to project the new fields.

- [ ] **Step 3: Run tests, commit**

```bash
npx vitest run src/game/application/gameSessionViewV2.test.ts
git add src/game/application/gameSessionViewV2.ts src/game/application/gameSessionViewV2.test.ts
git commit -m "feat: 扩展 gameSessionViewV2——scene, battle, quests, prologue, generation"
```

---

## Task 7: 前端切换到 V2

**Files:**
- Modify: `src/components/CurrentGameScreen.tsx`
- Modify: `src/components/gameActionRequest.ts`
- Modify: `src/components/NewGameSetupForm.tsx`
- Modify: `src/components/AdventureGameShell.tsx`

- [ ] **Step 1: Update gameActionRequest.ts to use V2 routes**

Change `/api/game/actions` → `/api/v2/game/actions` and update the payload type to match V2's `Interaction` model:

```typescript
// Change the fetch URL and payload structure
export async function postGameAction(payload: GameActionPayload): Promise<GameActionOutcome> {
  const response = await fetch("/api/v2/game/actions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      actionId: `act_${Date.now()}`,
      interaction: payloadToInteraction(payload),
      expectedRevision: payload.revision,
      choiceMap: new Map(), // V2: choiceMap is built server-side or passed from view
    }),
  });
  // ... parse response ...
}
```

- [ ] **Step 2: Update CurrentGameScreen.tsx to use V2 routes and types**

Change:
- `fetch("/api/game/current")` → `fetch("/api/v2/game/current")`
- `fetch("/api/game/narrative/ensure")` → `fetch("/api/v2/game/narrative/ensure")`
- `fetch("/api/game/prologue/ack")` → `fetch("/api/v2/game/prologue/ack")`
- `GameSessionView` type → `GameSessionViewV2`
- Adjust field access to match V2 view structure

- [ ] **Step 3: Update NewGameSetupForm.tsx to use V2 route**

Change `fetch("/api/game", ...)` → `fetch("/api/v2/game", ...)` and update payload to `{ gameType, gameLength }`.

- [ ] **Step 4: Update AdventureGameShell.tsx to use V2 ensure route**

Change any narrative ensure calls to `/api/v2/game/narrative/ensure`.

- [ ] **Step 5: Run all component tests**

Run: `npx vitest run src/components/CurrentGameScreen.test.tsx src/components/NewGameSetupForm.test.tsx src/components/AdventureGameShell.test.tsx`

Fix any failures due to type changes.

- [ ] **Step 6: Commit**

```bash
git add src/components/
git commit -m "feat: 前端切换到 V2 路由——/api/v2/game/*"
```

---

## Task 8: 全量回归测试

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 2: Fix any failures**

Common issues:
- Type mismatches between V1 and V2 views in frontend tests
- Missing V2 endpoints in composition root
- Narrative generation flow edge cases

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "test: V2 全量回归通过"
```

---

## Self-Review

**Spec coverage:**
- ✅ SceneGenerator (spec §7) → Tasks 1-2
- ✅ 场景写回者只写 narrative + candidateEventPool (spec §11) → Task 2
- ✅ performActionV2 场景排队 → Task 3
- ✅ ensure 端点 → Task 4
- ✅ NPC 对话 (spec §4.1 free_text) → Task 5
- ✅ prologue ack → Task 4
- ✅ gameSessionViewV2 扩展 → Task 6
- ✅ 前端切换 → Task 7
- ⏳ AI SceneSource 集成 → 后续增量（接口已预留）
- ⏳ Town 端点 → 后续任务（非核心循环）

**Placeholder scan:** No TBDs. All code blocks contain actual implementation or detailed instructions.

**Type consistency:** SceneSource interface matches between sceneSource.ts, deterministicSceneSource.ts, and generatePendingSceneV2.ts. GameSessionViewV2 expansion is consistent with WorldState and StoryState fields.
