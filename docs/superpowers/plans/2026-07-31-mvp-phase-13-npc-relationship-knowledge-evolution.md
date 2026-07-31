# NPC 关系与知识演化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 NPC 增加好感度系统，对话选择驱动关系变化，NPC 演员根据关系调整台词，NPC 记住交互历史。

**Architecture:** 四层扩展：domain 新增 `RelationshipValue` 类型与 `NpcRuntimeState.relationship` 可选字段；gameplay 新增 `classifyDialogueTone` 纯函数语气分类器与 `projectRelationshipSummary` 摘要投影器；application 扩展 `resolveAction`/`handleNpcDialogue` 写入关系变化、`NpcLineContext` 注入关系状态、`reconcileStoryMemory` 推导交互摘要；server 更新 NPC performer prompt 引用关系值。

**Tech Stack:** TypeScript strict / vitest / @libsql（sqlite）

**Spec:** `docs/superpowers/specs/2026-07-31-npc-relationship-knowledge-evolution-design.md`

## 前置条件

- **Phase 12（NPC 对话驱动叙事场景触发）必须已实现**。本计划依赖 Phase 12 的以下文件：
  - `src/game/gameplay/rpg/actions/classifyFreeDialogue.ts`
  - `src/game/application/handleNpcDialogue.ts`
  - `src/app/api/game/npc/dialogue/`（HTTP 端点）
  - `src/game/application/runtimeNarrativeContexts.ts` 中的 `playerNpcChat` 字段

## Global Constraints

- 工作分支放 `.worktrees/`（建议 `codex/phase13-npc-relationship`），禁止 `git checkout` 切主工作区
- Windows PowerShell 环境；测试命令 `npx vitest run <file>`；静态检查 `npx tsc --noEmit` 与 `npx eslint .`
- 依赖边界不可破坏：domain 禁止 import gameplay/application；gameplay 禁止 import application；UI 只经 `@/game/application` 门面
- 所有新纯函数禁止 IO/env/随机/时间；随机性只来自显式 seed
- `classifyDialogueTone` 是纯规则函数，零 AI 调用
- 关系变化不触发 `resolveEnding`、不改变 `reconcileQuests` 结果
- `npc_met` 事件的 `interactionKind` 是可选字段，旧存档缺省回退
- 所有新增字段可选，旧存档零迁移
- 注释风格与项目一致（中文、说明"为什么"）

---

## 文件结构

### 新增文件

| 文件 | 职责 |
|------|------|
| `src/game/domain/relationship.ts` | `RelationshipValue`、`RelationshipTier`、常量、`relationshipTierOf`、`clampAffinity` |
| `src/game/gameplay/rpg/actions/relationshipSummary.ts` | `projectRelationshipSummary` 纯函数 |

### 修改文件

| 文件 | 修改内容 |
|------|---------|
| `src/game/domain/gameState.ts` | `NpcRuntimeState` 增加 `relationship?: RelationshipValue` |
| `src/game/domain/events.ts` | `NpcMetEvent` 增加 `interactionKind?: "greet" \| "ask_main_quest"` |
| `src/game/domain/storyMemory.ts` | `NpcContinuityMemory` 增加 `lastInteractionSummary?: string` |
| `src/game/domain/index.ts` | 导出新类型 |
| `src/game/gameplay/rpg/actions/classifyFreeDialogue.ts` | 追加 `DialogueTone` 类型与 `classifyDialogueTone` 函数 |
| `src/game/gameplay/rpg/actions/resolveAction.ts` | `dialogue_choice` 分支增加关系变化计算与 `interactionKind` |
| `src/game/gameplay/rpg/actions/index.ts` | 导出新函数 |
| `src/game/gameplay/rpg/narrative/reconcileStoryMemory.ts` | `contactUpdateFromEvent` 中 `npc_met` 分支生成 `lastInteractionSummary` |
| `src/game/application/runtimeNarrativeContexts.ts` | `NpcLineContext` 增加关系字段；`toNpcLineContext` 读取关系值 |
| `src/game/application/handleNpcDialogue.ts` | 自由输入路径增加 `classifyDialogueTone` 与关系变化写入 |
| `src/game/application/server/ai/liveRuntimeNarrativeSources.ts` | NPC instruction 追加关系引用 |

### 测试文件

| 文件 | 类型 |
|------|------|
| `src/game/domain/relationship.test.ts` | 新建 |
| `src/game/gameplay/rpg/actions/classifyFreeDialogue.test.ts` | 追加（Phase 12 已有） |
| `src/game/gameplay/rpg/actions/relationshipSummary.test.ts` | 新建 |
| `src/game/gameplay/rpg/actions/resolveAction.test.ts` | 追加 |
| `src/game/gameplay/rpg/narrative/reconcileStoryMemory.test.ts` | 追加 |
| `src/game/application/runtimeNarrativeContexts.test.ts` | 追加 |
| `src/game/application/handleNpcDialogue.test.ts` | 追加（Phase 12 已有） |

---

### Task 1: domain — `RelationshipValue` 类型 + `NpcRuntimeState` / `NpcMetEvent` / `NpcContinuityMemory` 扩展

**Files:**
- Create: `src/game/domain/relationship.ts`
- Modify: `src/game/domain/gameState.ts`（`NpcRuntimeState` 增加 `relationship?: RelationshipValue`）
- Modify: `src/game/domain/events.ts`（`NpcMetEvent` 增加 `interactionKind?: "greet" | "ask_main_quest"`）
- Modify: `src/game/domain/storyMemory.ts`（`NpcContinuityMemory` 增加 `lastInteractionSummary?: string`）
- Modify: `src/game/domain/index.ts`（导出新类型）
- Test: `src/game/domain/relationship.test.ts`

**Interfaces:**
- Produces:
  - `RelationshipValue`（`{ readonly affinity: number }`）
  - `RelationshipTier = "hostile" | "cold" | "neutral" | "friendly" | "trusted"`
  - `relationshipTierOf(value: RelationshipValue): RelationshipTier`
  - `clampAffinity(affinity: number): number`
  - `RELATIONSHIP_CHANGE` 常量
  - `RELATIONSHIP_MIN` / `RELATIONSHIP_MAX` 常量
  - `NpcRuntimeState.relationship?: RelationshipValue`
  - `NpcMetEvent.interactionKind?: "greet" | "ask_main_quest"`
  - `NpcContinuityMemory.lastInteractionSummary?: string`

- [ ] **Step 1: 创建 `relationship.ts` + 写失败测试**

`src/game/domain/relationship.ts`:

```ts
// ---------------------------------------------------------------------------
// Phase 13：NPC 关系值类型。
// 纯 domain 类型，零依赖。单维度好感度，类型预留多维度扩展。
// 旧存档缺省 relationship 字段时安全回退到中立。
// ---------------------------------------------------------------------------

export type RelationshipTier = "hostile" | "cold" | "neutral" | "friendly" | "trusted";

/** 关系值。单维度好感度，结构体预留未来扩展为多维度。 */
export type RelationshipValue = {
  readonly affinity: number;  // -100 ~ +100
};

// 常量
export const RELATIONSHIP_CHANGE = {
  GREET_FIRST_MEET: 5,
  ASK_MAIN_QUEST_COMPLETE: 10,
  FREE_INPUT_POSITIVE: 3,
  FREE_INPUT_NEGATIVE: -3,
} as const;

export const RELATIONSHIP_MIN = -100;
export const RELATIONSHIP_MAX = 100;

/** 关系值 → 档位（纯函数）。 */
export function relationshipTierOf(value: RelationshipValue): RelationshipTier {
  if (value.affinity <= -60) return "hostile";
  if (value.affinity <= -20) return "cold";
  if (value.affinity < 20) return "neutral";
  if (value.affinity < 60) return "friendly";
  return "trusted";
}

/** 安全 clamp 到 [-100, 100]。 */
export function clampAffinity(affinity: number): number {
  return Math.max(RELATIONSHIP_MIN, Math.min(RELATIONSHIP_MAX, affinity));
}
```

`src/game/domain/relationship.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  relationshipTierOf,
  clampAffinity,
  RELATIONSHIP_CHANGE,
  RELATIONSHIP_MIN,
  RELATIONSHIP_MAX,
  type RelationshipTier,
  type RelationshipValue,
} from "./relationship";

describe("relationshipTierOf", () => {
  it("hostile: affinity <= -60", () => {
    expect(relationshipTierOf({ affinity: -100 })).toBe("hostile");
    expect(relationshipTierOf({ affinity: -60 })).toBe("hostile");
  });
  it("cold: -60 < affinity <= -20", () => {
    expect(relationshipTierOf({ affinity: -59 })).toBe("cold");
    expect(relationshipTierOf({ affinity: -20 })).toBe("cold");
  });
  it("neutral: -20 < affinity < 20", () => {
    expect(relationshipTierOf({ affinity: 0 })).toBe("neutral");
    expect(relationshipTierOf({ affinity: 19 })).toBe("neutral");
  });
  it("friendly: 20 <= affinity < 60", () => {
    expect(relationshipTierOf({ affinity: 20 })).toBe("friendly");
    expect(relationshipTierOf({ affinity: 59 })).toBe("friendly");
  });
  it("trusted: affinity >= 60", () => {
    expect(relationshipTierOf({ affinity: 60 })).toBe("trusted");
    expect(relationshipTierOf({ affinity: 100 })).toBe("trusted");
  });
});

describe("clampAffinity", () => {
  it("clamps to min", () => expect(clampAffinity(-200)).toBe(-100));
  it("clamps to max", () => expect(clampAffinity(200)).toBe(100));
  it("passes through within range", () => expect(clampAffinity(42)).toBe(42));
});

describe("constants", () => {
  it("RELATIONSHIP_CHANGE values are correct", () => {
    expect(RELATIONSHIP_CHANGE.GREET_FIRST_MEET).toBe(5);
    expect(RELATIONSHIP_CHANGE.ASK_MAIN_QUEST_COMPLETE).toBe(10);
    expect(RELATIONSHIP_CHANGE.FREE_INPUT_POSITIVE).toBe(3);
    expect(RELATIONSHIP_CHANGE.FREE_INPUT_NEGATIVE).toBe(-3);
  });
  it("bounds are correct", () => {
    expect(RELATIONSHIP_MIN).toBe(-100);
    expect(RELATIONSHIP_MAX).toBe(100);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

```powershell
npx vitest run src/game/domain/relationship.test.ts
```
Expected: FAIL（模块不存在）

- [ ] **Step 3: 创建 `relationship.ts`**（内容见 Step 1）

- [ ] **Step 4: 扩展 `NpcRuntimeState`（gameState.ts）**

在 `src/game/domain/gameState.ts` 中，`NpcRuntimeState` 末尾增加 `relationship`：

```ts
export type NpcRuntimeState = {
  readonly npcId: NpcId;
  readonly locationId: LocationId;
  readonly met: boolean;
  // Phase 13：可选关系值；旧存档缺省时回退到 { affinity: 0 }（中立）
  readonly relationship?: RelationshipValue;
};
```

并在文件头部 import 中加入 `RelationshipValue`：

```ts
import type { RelationshipValue } from "./relationship";
```

- [ ] **Step 5: 扩展 `NpcMetEvent`（events.ts）**

```ts
export type NpcMetEvent = {
  readonly type: "npc_met";
  readonly npcId: NpcId;
  readonly occurredAt: string;
  // Phase 13：可选交互类型，reconcileStoryMemory 据此生成 lastInteractionSummary。
  // 旧存档缺省时回退到 undefined，reducer 安全跳过。
  readonly interactionKind?: "greet" | "ask_main_quest";
};
```

- [ ] **Step 6: 扩展 `NpcContinuityMemory`（storyMemory.ts）**

```ts
export type NpcContinuityMemory = {
  readonly npcId: NpcId;
  readonly lastContactTurn: number;
  readonly lastLocationId: LocationId;
  // Phase 13：可选，旧存档兼容。由 reconcileStoryMemory 从 npc_met.interactionKind 推导生成。
  readonly lastInteractionSummary?: string;
};
```

- [ ] **Step 7: 更新 `index.ts` 导出**

在 `src/game/domain/index.ts` 中添加：

```ts
export { relationshipTierOf, clampAffinity } from "./relationship";
export type { RelationshipValue, RelationshipTier } from "./relationship";
```

- [ ] **Step 8: 运行测试验证通过**

```powershell
npx vitest run src/game/domain/relationship.test.ts
```
Expected: PASS

- [ ] **Step 9: 提交**

```powershell
git add -A
git commit -m "feat(domain): RelationshipValue 类型与 NpcRuntimeState/NpcMetEvent/NpcContinuityMemory 扩展"
```

---

### Task 2: gameplay — `classifyDialogueTone` 纯函数 + `projectRelationshipSummary`

**Files:**
- Create: `src/game/gameplay/rpg/actions/relationshipSummary.ts`
- Modify: `src/game/gameplay/rpg/actions/classifyFreeDialogue.ts`（追加 `classifyDialogueTone` 与 `DialogueTone` 类型）
- Modify: `src/game/gameplay/rpg/actions/index.ts`（导出新函数）
- Test: `src/game/gameplay/rpg/actions/classifyFreeDialogue.test.ts`（追加）
- Test: `src/game/gameplay/rpg/actions/relationshipSummary.test.ts`

**Interfaces:**
- Consumes: `GameState`、`ScenarioBlueprint`、`NpcId`（来自 domain）
- Produces:
  - `DialogueTone = "positive" | "neutral" | "negative"`
  - `classifyDialogueTone(text: string): DialogueTone`
  - `projectRelationshipSummary(state, blueprint, npcId): string`

- [ ] **Step 1: 追加 `classifyDialogueTone` 到 `classifyFreeDialogue.ts`**

在 `classifyFreeDialogue.ts` 末尾追加：

```ts
// ---------------------------------------------------------------------------
// Phase 13：自由输入语气分类器。纯规则，零 AI。
// 与 classifyFreeDialogue 并列，供 handleNpcDialogue 在关系变化中使用。
// ---------------------------------------------------------------------------

export type DialogueTone = "positive" | "neutral" | "negative";

/** 中文语气关键词表。纯规则匹配，不调 AI。 */
const POSITIVE_KEYWORDS = ["谢谢", "帮忙", "你好", "佩服", "感激", "请", "拜托", "劳驾", "请问", "感谢"];
const NEGATIVE_KEYWORDS = ["混蛋", "滚", "威胁", "少管闲事", "闭嘴", "该死", "可恶", "别烦", "滚开", "去死"];

export function classifyDialogueTone(text: string): DialogueTone {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "neutral";

  for (const kw of NEGATIVE_KEYWORDS) {
    if (trimmed.includes(kw)) return "negative";
  }
  for (const kw of POSITIVE_KEYWORDS) {
    if (trimmed.includes(kw)) return "positive";
  }

  // 问句倾向中性（但"你吃饭了吗？"不触发关系变化）
  return "neutral";
}
```

- [ ] **Step 2: 追加测试到 `classifyFreeDialogue.test.ts`**

```ts
describe("classifyDialogueTone", () => {
  const { classifyDialogueTone } = await import("./classifyFreeDialogue");

  it("正面关键词 → positive", () => {
    expect(classifyDialogueTone("谢谢你帮忙")).toBe("positive");
    expect(classifyDialogueTone("佩服你的勇气")).toBe("positive");
    expect(classifyDialogueTone("请带我去矿坑")).toBe("positive");
  });

  it("负面关键词 → negative", () => {
    expect(classifyDialogueTone("混蛋，滚开")).toBe("negative");
    expect(classifyDialogueTone("少管闲事")).toBe("negative");
    expect(classifyDialogueTone("闭嘴")).toBe("negative");
  });

  it("中性文本 → neutral", () => {
    expect(classifyDialogueTone("今天天气真好")).toBe("neutral");
    expect(classifyDialogueTone("你吃饭了吗？")).toBe("neutral");
    expect(classifyDialogueTone("")).toBe("neutral");
  });
});
```

- [ ] **Step 3: 运行测试验证失败**

```powershell
npx vitest run src/game/gameplay/rpg/actions/classifyFreeDialogue.test.ts
```

- [ ] **Step 4: 创建 `relationshipSummary.ts`**

```ts
// ---------------------------------------------------------------------------
// Phase 13：NPC 关系摘要投影器。
// 从 StoryMemory 的 npcContacts 中提取最近交互摘要。
// 纯函数，零 AI、零 IO、零随机。
// ---------------------------------------------------------------------------

import type { GameState, ScenarioBlueprint } from "@/game/domain";
import { storyMemoryOf } from "@/game/domain";

export function projectRelationshipSummary(
  state: GameState,
  _blueprint: ScenarioBlueprint,
  npcId: string,
): string {
  const contact = storyMemoryOf(state).npcContacts.find(
    (c) => String(c.npcId) === npcId,
  );
  if (contact === undefined) return "";
  return contact.lastInteractionSummary ?? "";
}
```

- [ ] **Step 5: 写 `relationshipSummary.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { projectRelationshipSummary } from "./relationshipSummary";
import type { GameState, ScenarioBlueprint, NpcId } from "@/game/domain";

function buildState(overrides?: Partial<GameState>): GameState {
  return {
    stateVersion: 1 as const, generation: {} as never,
    player: { name: "P", identity: "H", stats: { hp: 20, attack: 5, defense: 3 } },
    currentLocationId: "loc_1" as never,
    unlockedLocationIds: ["loc_1" as never], visitedLocationIds: ["loc_1" as never],
    npcs: [{ npcId: "npc_1" as never, locationId: "loc_1" as never, met: true }],
    quests: [], inventory: [], worldFacts: [], defeatedEnemyIds: [],
    battle: { status: "idle" }, ending: null,
    narrative: { currentScene: null, generation: { status: "idle" }, mode: "ai" },
    eventLedger: [],
    storyMemory: {
      version: 1, reducedThroughEventCount: 1, recent: [],
      npcContacts: [
        { npcId: "npc_1" as never, lastContactTurn: 1, lastLocationId: "loc_1" as never, lastInteractionSummary: "你初次结识了这位NPC。" },
      ],
    },
    ...overrides,
  } as unknown as GameState;
}

describe("projectRelationshipSummary", () => {
  const blueprint = {} as unknown as ScenarioBlueprint;

  it("有 lastInteractionSummary 时返回它", () => {
    const state = buildState();
    expect(projectRelationshipSummary(state, blueprint, "npc_1")).toBe("你初次结识了这位NPC。");
  });

  it("无 contact 时返回空串", () => {
    const state = buildState();
    expect(projectRelationshipSummary(state, blueprint, "npc_999")).toBe("");
  });

  it("无 lastInteractionSummary 时返回空串", () => {
    const state = buildState({
      storyMemory: {
        version: 1, reducedThroughEventCount: 1, recent: [],
        npcContacts: [{ npcId: "npc_1" as never, lastContactTurn: 1, lastLocationId: "loc_1" as never }],
      },
    });
    expect(projectRelationshipSummary(state, blueprint, "npc_1")).toBe("");
  });
});
```

- [ ] **Step 6: 运行测试验证失败**

```powershell
npx vitest run src/game/gameplay/rpg/actions/relationshipSummary.test.ts
```
Expected: FAIL（模块不存在）

- [ ] **Step 7: 更新 `index.ts` 导出**

在 `src/game/gameplay/rpg/actions/index.ts` 中追加：

```ts
export { classifyDialogueTone } from "./classifyFreeDialogue";
export type { DialogueTone } from "./classifyFreeDialogue";
export { projectRelationshipSummary } from "./relationshipSummary";
```

- [ ] **Step 8: 运行测试验证通过**

```powershell
npx vitest run src/game/gameplay/rpg/actions/classifyFreeDialogue.test.ts src/game/gameplay/rpg/actions/relationshipSummary.test.ts
```
Expected: PASS

- [ ] **Step 9: 提交**

```powershell
git add -A
git commit -m "feat(gameplay): classifyDialogueTone 语气分类器 + projectRelationshipSummary 摘要投影"
```

---

### Task 3: application — `resolveAction` 增加关系变化计算

**Files:**
- Modify: `src/game/application/performAction.ts`（`dialogue_choice` 的 pending 条件块处理关系变化，或由 `resolveAction` 直接返回关系值）
- Modify: `src/game/gameplay/rpg/actions/resolveAction.ts`（`dialogue_choice` 分支计算关系变化 + 设置 `interactionKind`）
- Test: 追加 `resolveAction.test.ts` 测试用例

**设计决策：** 关系变化应该在 `resolveAction` 中计算，因为 `resolveAction` 已经负责 `npc_met` 事件的生成。`performAction` 只消费 `resolveAction` 返回的结果，不额外计算关系。

- [ ] **Step 1: 修改 `resolveAction.ts` 的 `dialogue_choice` 分支**

```ts
// resolveAction.ts 中 dialogue_choice 分支，在生成 event 后计算关系变化：
case "dialogue_choice": {
  const kind = parseDialogueChoiceKind(intent.npcId, intent.choiceId);

  // Phase 13：计算关系变化量
  const delta =
    kind === "ask_main_quest"
      ? RELATIONSHIP_CHANGE.ASK_MAIN_QUEST_COMPLETE
      : RELATIONSHIP_CHANGE.GREET_FIRST_MEET;

  const currentRelationship = state.npcs.find(
    (n) => n.npcId === intent.npcId,
  )?.relationship ?? { affinity: 0 };
  const newAffinity = clampAffinity(currentRelationship.affinity + delta);

  const event: GameEvent = {
    type: "npc_met",
    npcId: intent.npcId,
    occurredAt,
    // Phase 13：携带交互类型供 reducer 推导摘要
    interactionKind: kind === "ask_main_quest" ? "ask_main_quest" : "greet",
  };
  const newState: GameState = {
    ...state,
    npcs: replaceInArray(
      state.npcs,
      (n) => n.npcId === intent.npcId,
      (n) => ({
        ...n,
        met: true,
        // Phase 13：写入关系值（首次结识时设置初始值）
        relationship: { affinity: newAffinity },
      }),
    ),
    eventLedger: [...state.eventLedger, event],
  };
  return {
    ok: true,
    state: newState,
    events: [event],
    feedback: {
      message:
        kind === "ask_main_quest"
          ? `你向${npcName(blueprint, intent.npcId)}询问当前线索。`
          : `你与${npcName(blueprint, intent.npcId)}交谈，初次见面。`,
    },
  };
}
```

并在文件头部 import 中加入：

```ts
import { RELATIONSHIP_CHANGE, clampAffinity } from "@/game/domain";
```

注意：`RELATIONSHIP_CHANGE` 和 `clampAffinity` 已在 Task 1 Step 7 中从 `@/game/domain` barrel 导出，与 `resolveAction.ts` 既有 import 风格一致（`import type { GameEvent, GameState, ScenarioBlueprint } from "@/game/domain"`）。

- [ ] **Step 2: 追加 `resolveAction.test.ts` 测试**

```ts
describe("resolveAction dialogue_choice 关系变化", () => {
  it("greet（首次结识）→ 好感度 +5", () => {
    const state = buildStateWith({ npcs: [{ npcId: "npc_1", locationId: "loc_1", met: false }] });
    const result = resolveAction(blueprint, state, {
      type: "dialogue_choice", npcId: "npc_1", choiceId: "greet"
    } as never);
    assert(result.ok);
    const npc = result.state.npcs.find((n) => n.npcId === "npc_1");
    expect(npc?.relationship?.affinity).toBe(5);
  });

  it("ask_main_quest → 好感度 +10", () => {
    const state = buildStateWith({ npcs: [{ npcId: "npc_1", locationId: "loc_1", met: true }] });
    const result = resolveAction(blueprint, state, {
      type: "dialogue_choice", npcId: "npc_1", choiceId: "ask_main_quest"
    } as never);
    assert(result.ok);
    const npc = result.state.npcs.find((n) => n.npcId === "npc_1");
    expect(npc?.relationship?.affinity).toBe(10);
  });

  it("npc_met 事件携带 interactionKind", () => {
    const state = buildStateWith({ npcs: [{ npcId: "npc_1", locationId: "loc_1", met: false }] });
    const result = resolveAction(blueprint, state, {
      type: "dialogue_choice", npcId: "npc_1", choiceId: "greet"
    } as never);
    assert(result.ok);
    const event = result.events.find((e) => e.type === "npc_met");
    expect(event?.interactionKind).toBe("greet");
  });
});
```

- [ ] **Step 3: 运行测试验证通过**

```powershell
npx vitest run src/game/gameplay/rpg/actions/resolveAction.test.ts
```
Expected: PASS

- [ ] **Step 4: 提交**

```powershell
git add -A
git commit -m "feat(application): resolveAction dialogue_choice 分支增加关系变化计算与 interactionKind"
```

---

### Task 4: gameplay — `reconcileStoryMemory` 扩展 `lastInteractionSummary`

**Files:**
- Modify: `src/game/gameplay/rpg/narrative/reconcileStoryMemory.ts`（`contactUpdateFromEvent` 中 `npc_met` 分支生成 `lastInteractionSummary`）
- Test: 追加 `reconcileStoryMemory.test.ts` 测试用例

- [ ] **Step 1: 修改 `contactUpdateFromEvent` 中的 `npc_met` 分支**

```ts
// reconcileStoryMemory.ts 中 contactUpdateFromEvent 函数：
case "npc_met": {
  const locationId = resolveNpcLocation(state, event.npcId);
  if (locationId === null) return null;
  // Phase 13：按 interactionKind 生成安全摘要
  let summary: string | undefined;
  if (event.interactionKind === "ask_main_quest") {
    summary = "你向NPC询问了重要线索。";
  } else if (event.interactionKind === "greet") {
    summary = "你初次结识了这位NPC。";
  }
  return {
    npcId: event.npcId,
    lastContactTurn: turn,
    lastLocationId: locationId,
    ...(summary !== undefined ? { lastInteractionSummary: summary } : {}),
  };
}
```

- [ ] **Step 2: 追加测试到 `reconcileStoryMemory.test.ts`**

```ts
describe("reconcileStoryMemory npc_met interactionKind", () => {
  it("greet 事件生成 lastInteractionSummary", () => {
    const state = buildStateWithLedger([
      { type: "npc_met", npcId: "npc_1" as never, occurredAt: "", interactionKind: "greet" },
    ]);
    const memory = reconcileStoryMemory({ state });
    const contact = memory.npcContacts.find((c) => c.npcId === "npc_1");
    expect(contact?.lastInteractionSummary).toBe("你初次结识了这位NPC。");
  });

  it("ask_main_quest 事件生成对应摘要", () => {
    const state = buildStateWithLedger([
      { type: "npc_met", npcId: "npc_1" as never, occurredAt: "", interactionKind: "ask_main_quest" },
    ]);
    const memory = reconcileStoryMemory({ state });
    const contact = memory.npcContacts.find((c) => c.npcId === "npc_1");
    expect(contact?.lastInteractionSummary).toBe("你向NPC询问了重要线索。");
  });

  it("旧存档无 interactionKind 时不生成摘要", () => {
    const state = buildStateWithLedger([
      { type: "npc_met", npcId: "npc_1" as never, occurredAt: "" },
    ]);
    const memory = reconcileStoryMemory({ state });
    const contact = memory.npcContacts.find((c) => c.npcId === "npc_1");
    expect(contact?.lastInteractionSummary).toBeUndefined();
  });
});
```

- [ ] **Step 3: 运行测试验证通过**

```powershell
npx vitest run src/game/gameplay/rpg/narrative/reconcileStoryMemory.test.ts
```
Expected: PASS

- [ ] **Step 4: 提交**

```powershell
git add -A
git commit -m "feat(gameplay): reconcileStoryMemory 从 npc_met.interactionKind 推导 lastInteractionSummary"
```

---

### Task 5: application — `NpcLineContext` 扩展 + `toNpcLineContext` 注入关系值

**Files:**
- Modify: `src/game/application/runtimeNarrativeContexts.ts`（`NpcLineContext` 增加关系字段；`toNpcLineContext` 读取关系值并调用 `projectRelationshipSummary`）
- Test: 追加 `runtimeNarrativeContexts.test.ts` 测试用例

- [ ] **Step 1: 扩展 `NpcLineContext` 类型**

```ts
export type NpcLineContext = {
  readonly npcDefinition: Record<string, unknown>;
  readonly factCards: readonly Record<string, unknown>[];
  readonly ownContinuity: { readonly lastContactTurn: number; readonly lastLocationName: string } | null;
  readonly speechAct: string;
  readonly mayLie: boolean;
  // Phase 13：
  readonly relationshipTier: string;
  readonly relationshipAffinity: number;
  readonly relationshipSummary: string;
};
```

- [ ] **Step 2: 修改 `toNpcLineContext` 函数**

在函数末尾、`return` 之前追加：

```ts
// Phase 13：读取关系值
const npcState = state.npcs.find((n) => String(n.npcId) === npcId);
const relationship = npcState?.relationship ?? { affinity: 0 };
const tier = relationshipTierOf(relationship);
const summary = projectRelationshipSummary(state, blueprint, npcId);
```

修改 `return` 语句，在 `context` 对象中增加关系字段：

```ts
const context: NpcLineContext = {
  npcDefinition: npcDef !== undefined ? { ... } : { ... },
  factCards,
  ownContinuity: projectOwnContinuity(state, blueprint, npcId),
  speechAct: input.speechAct,
  mayLie: input.mayLie,
  // Phase 13：
  relationshipTier: tier,
  relationshipAffinity: relationship.affinity,
  relationshipSummary: summary,
};
```

文件头部 import 追加：

```ts
import { relationshipTierOf } from "@/game/domain";
import { projectRelationshipSummary } from "@/game/gameplay/rpg/actions/relationshipSummary";
```

注意：`relationshipTierOf` 与 `clampAffinity` 已在 Task 1 Step 7 中从 `@/game/domain` barrel 导出，可用 barrel 导入。`projectRelationshipSummary` 从 actions barrel 导入。`RELATIONSHIP_CHANGE` 和 `clampAffinity` 在 `resolveAction.ts`（Task 3）中直接使用 `@/game/domain` 导入已包含。`runtimeNarrativeContexts.ts` 不直接使用 `RELATIONSHIP_CHANGE`，只使用 `relationshipTierOf`。

- [ ] **Step 3: 追加测试到 `runtimeNarrativeContexts.test.ts`**

```ts
describe("toNpcLineContext 关系值", () => {
  it("注入 relationshipTier 与 relationshipAffinity", () => {
    const state = buildStateWithNpc({ npcId: "npc_1", relationship: { affinity: 45 } });
    const context = toNpcLineContext({ blueprint, state, npcId: "npc_1", speechAct: "inform", allowedFactIds: [], mayLie: false });
    expect(context.relationshipTier).toBe("friendly");
    expect(context.relationshipAffinity).toBe(45);
  });

  it("无关系值时默认为 neutral / 0", () => {
    const state = buildStateWithNpc({ npcId: "npc_1" }); // 无 relationship
    const context = toNpcLineContext({ blueprint, state, npcId: "npc_1", speechAct: "inform", allowedFactIds: [], mayLie: false });
    expect(context.relationshipTier).toBe("neutral");
    expect(context.relationshipAffinity).toBe(0);
  });

  it("注入 relationshipSummary", () => {
    const state = buildStateWithNpc({ npcId: "npc_1" });
    // 同时设置 storyMemory 中的 npcContacts
    const context = toNpcLineContext({ blueprint, state, npcId: "npc_1", speechAct: "inform", allowedFactIds: [], mayLie: false });
    expect(typeof context.relationshipSummary).toBe("string");
  });
});
```

- [ ] **Step 4: 运行测试验证通过**

```powershell
npx vitest run src/game/application/runtimeNarrativeContexts.test.ts
```
Expected: PASS

- [ ] **Step 5: 提交**

```powershell
git add -A
git commit -m "feat(application): NpcLineContext 注入关系值（relationshipTier/Affinity/Summary）"
```

---

### Task 6: application — `handleNpcDialogue` 增加自由输入关系变化

**Files:**
- Modify: `src/game/application/handleNpcDialogue.ts`（叙事触发路径中增加 `classifyDialogueTone` 与关系变化写入）
- Test: 追加 `handleNpcDialogue.test.ts` 测试用例

- [ ] **Step 1: 修改 `handleNpcDialogue.ts`**

在叙事触发路径中，构造 `nextState` 前追加关系变化逻辑。需要先定义 `replaceInArray` 辅助函数（与 `resolveAction.ts` 中的同名函数同构），并从 blueprint 解析 NPC 名称：

```ts
// 在文件顶部（或现有工具函数区域）追加：
/** 不可变更新：替换数组中匹配元素。 */
function replaceInArray<T>(array: readonly T[], predicate: (item: T) => boolean, replacement: (item: T) => T): T[] {
  return array.map((item) => (predicate(item) ? replacement(item) : item));
}

// 在 classifyFreeDialogue → "narrative" 分支中，构造 nextState 之前：
const npcDef = blueprint.npcs.find((n) => n.id === npcId);
const npcName = npcDef?.name ?? "未知";
const npcRole = npcDef?.role ?? "未知";

const tone = classifyDialogueTone(text);
const delta =
  tone === "positive" ? RELATIONSHIP_CHANGE.FREE_INPUT_POSITIVE :
  tone === "negative" ? RELATIONSHIP_CHANGE.FREE_INPUT_NEGATIVE :
  0;

const currentRelationship = state.npcs.find(
  (n) => n.npcId === npcId,
)?.relationship ?? { affinity: 0 };
const newAffinity = clampAffinity(currentRelationship.affinity + delta);

const nextState: GameState = {
  ...state,
  npcs: replaceInArray(
    state.npcs,
    (n) => n.npcId === npcId,
    (n) => ({
      ...n,
      relationship: delta !== 0 ? { affinity: newAffinity } : n.relationship,
    }),
  ),
  narrative: {
    currentScene: null,
    generation: {
      status: "pending",
      requestedAt: deps.now(),
      playerNpcChat: { npcId, playerText: text, npcName, npcRole },
    },
    mode: "ai",
  },
};
```

文件头部 import 追加：

```ts
import { classifyDialogueTone } from "@/game/gameplay/rpg/actions/classifyFreeDialogue";
import { RELATIONSHIP_CHANGE, clampAffinity } from "@/game/domain";
```

- [ ] **Step 2: 追加测试到 `handleNpcDialogue.test.ts`**

**注意**：`handleNpcDialogue.test.ts` 在 Phase 12 中创建，其中应定义 `createTestDeps` 辅助函数，用于构造 `HandleNpcDialogueDependencies`（含内存 repository）。若 Phase 12 未定义该函数，本步骤需先创建它。以下测试代码假定 `createTestDeps` 接受一个覆盖参数，返回包含 `repository` 的完整依赖对象。

```ts
describe("handleNpcDialogue 关系变化", () => {
  it("正面语气 → 好感度 +3", async () => {
    const deps = createTestDeps(/* 注入内存 repository */);
    const result = await handleNpcDialogue({ npcId: "npc_1" as never, text: "谢谢你帮忙", expectedRevision: 1 }, deps);
    if (result.kind === "narrative_trigger") {
      // 从 repository 读取持久化后的 state
      const saved = await deps.repository.getCurrentGame();
      if (saved.ok) {
        const npc = saved.state.npcs.find((n) => n.npcId === "npc_1");
        expect(npc?.relationship?.affinity).toBe(3);
      }
    }
  });

  it("负面语气 → 好感度 -3", async () => {
    const deps = createTestDeps(/* 注入内存 repository */);
    const result = await handleNpcDialogue({ npcId: "npc_1" as never, text: "混蛋，滚开", expectedRevision: 1 }, deps);
    if (result.kind === "narrative_trigger") {
      const saved = await deps.repository.getCurrentGame();
      if (saved.ok) {
        const npc = saved.state.npcs.find((n) => n.npcId === "npc_1");
        expect(npc?.relationship?.affinity).toBe(-3);
      }
    }
  });

  it("中性语气 → 好感度不变", async () => {
    const deps = createTestDeps(/* 注入内存 repository，NPC 初始 affinity=10 */);
    const result = await handleNpcDialogue({ npcId: "npc_1" as never, text: "今天天气真好", expectedRevision: 1 }, deps);
    if (result.kind === "narrative_trigger") {
      const saved = await deps.repository.getCurrentGame();
      if (saved.ok) {
        const npc = saved.state.npcs.find((n) => n.npcId === "npc_1");
        expect(npc?.relationship?.affinity).toBe(10); // 不变
      }
    }
  });
});
```

- [ ] **Step 3: 运行测试验证通过**

```powershell
npx vitest run src/game/application/handleNpcDialogue.test.ts
```
Expected: PASS

- [ ] **Step 4: 提交**

```powershell
git add -A
git commit -m "feat(application): handleNpcDialogue 自由输入路径增加 classifyDialogueTone 与关系变化"
```

---

### Task 7: server — NPC performer prompt 更新

**Files:**
- Modify: `src/game/application/server/ai/liveRuntimeNarrativeSources.ts`（NPC instruction 末尾追加关系引用）

- [ ] **Step 1: 修改 NPC instruction**

在 `liveRuntimeNarrativeSources.ts` 的 `messages` 函数中，NPC role 的 instruction 末尾追加：

```
The NPC's relationship with the player is {relationshipTier} 
(affinity {relationshipAffinity}). 
{relationshipSummary}
Adjust your tone, willingness to help, and emotional expression 
according to this relationship tier.
```

注意：`relationshipTier`、`relationshipAffinity`、`relationshipSummary` 已由 `NpcLineContext` 注入到 `request.context` 中，AI 模型会从 context 中读取这些字段。instruction 只是告诉模型去使用它们。

- [ ] **Step 2: 运行静态检查**

```powershell
npx tsc --noEmit
```
Expected: 零错误

- [ ] **Step 3: 提交**

```powershell
git add -A
git commit -m "feat(server): NPC performer prompt 引用关系值（relationshipTier/Affinity/Summary）"
```

---

### Task 8: 全量回归测试

- [ ] **Step 1: 运行全量测试**

```powershell
npx vitest run
```
Expected: 全部 PASS（除已知显式跳过的测试外）

- [ ] **Step 2: 运行静态检查**

```powershell
npx tsc --noEmit
npx eslint .
```
Expected: 零错误

- [ ] **Step 3: 运行依赖边界测试**

```powershell
npx vitest run src/dependencyBoundaries.test.ts
```
Expected: PASS

---

### Task 9: 文档更新

**Files:**
- Create: `docs/agent/NPC关系与知识演化.md`（实现事实）
- Modify: `docs/Agent文档索引.md`（登记新文档）
- Modify: `docs/agent/当前开发阶段.md`（更新阶段状态为 Phase 13）

- [ ] **Step 1: 创建 `docs/agent/NPC关系与知识演化.md`**

按 `docs/agent/` 既有文档的结构惯例撰写，覆盖：
- 系统定位：NPC 好感度 + 交互记忆
- 当前状态：implemented
- 关键设计：关系值在 NpcRuntimeState、interactionKind 事件扩展、classifyDialogueTone 纯规则
- 修改注意事项：旧存档兼容、最小权限、纯规则纪律

- [ ] **Step 2: 更新 `docs/Agent文档索引.md`**

登记新文档，状态为 Phase 13 已实现。

- [ ] **Step 3: 更新 `docs/agent/当前开发阶段.md`**

设置阶段为 Phase 13，状态为 implemented。

- [ ] **Step 4: 提交**

```powershell
git add -A
git commit -m "docs: NPC 关系与知识演化实现记录与索引登记"
```

---

## Final Verification

- [ ] `npx vitest run` 全量 PASS
- [ ] `npx tsc --noEmit` / `npx eslint .` 零错误
- [ ] 对照 spec §8 验收标准 1~14 逐条自查
- [ ] 分支收尾按 `superpowers:finishing-a-development-branch`；worktree 清理遵守 AGENTS.md 的 `.foundation` junction 禁令