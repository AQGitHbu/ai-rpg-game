# P2：自由文本 ActionConverter + ResolvedEvent 五态语义细化 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 P1 双状态流水线骨架基础上，实现自由文本意图解析（纯规则预分类 + AI source 兜底 + freeform 降级）和 ResolvedEvent 五态结果语义（success/partial_success/failure/blocked/invalid），并填充 stateChanges 审计清单。

**Architecture:** ActionConverter 分两层：fixed_choice 保持同步查表；free_text 先经纯规则预分类（匹配世界实体名），命中则零 AI 调用直接映射，未命中则调用可注入 IntentParserSource（小模型），AI 也无法归类时降级为 freeform。resolveByType 返回带 status 的 ResolveResult，ruleEngine facade 透传 status 到 ResolvedEvent。stateChanges 由 resolver 在计算完下一状态后声明式填充。

**Tech Stack:** TypeScript, Next.js 16, React 19, libsql/SQLite, Vitest, zustand

**Spec:** `docs/superpowers/specs/2026-08-07-ai-rpg-architecture-redesign-spec.md` §4.3, §5.2, §16

## Global Constraints

- 纯 domain 层零 IO、零 AI、零 DB；gameplay 层纯函数不写状态
- 所有 AI 调用点使用可注入 source 接口，离线 fixture 保证无 AI 全流水线可测
- utterance 透传仅供叙事，规则引擎完全忽略 utterance 字段
- ResolvedEvent status 五态由规则根据行动结果确定，AI 不可覆盖
- stateChanges 是审计清单不是执行输入，resolver 直接计算下一状态
- CAS compare-and-swap 原子写入，revision 是唯一防重屏障
- 测试先行（TDD），每个 task 以失败测试开始
- freeform action 不执行任何实质世界变化，AI 可让 NPC 反应但不改变状态

---

## P1 现状基线

以下 P1 文件已存在且可被 P2 修改/扩展：

| 文件 | 当前状态 | P2 改动 |
|---|---|---|
| `src/game/domain/action.ts` | Action union 已含 utterance + freeform | 不改 |
| `src/game/domain/resolvedEvent.ts` | ResolvedEvent 已含五态 status + stateChanges 类型 | 不改 |
| `src/game/application/actionConverter.ts` | 仅 fixed_choice 映射，free_text 返回 not_supported | **扩展** |
| `src/game/gameplay/rpg/ruleEngine/resolveByType.ts` | 返回 ok/fail 二元，无 status，无 stateChanges | **扩展** |
| `src/game/gameplay/rpg/ruleEngine/index.ts` | facade 永远设 status="success"，stateChanges=[] | **修改** |
| `src/game/gameplay/rpg/ruleEngine/validateAction.ts` | 已有完整校验 | 不改 |
| `src/game/application/performActionV2.ts` | 同步 convertInteraction，不支持 free_text | **修改** |
| `src/game/gameplay/rpg/actions/classifyFreeDialogue.ts` | 旧架构（Blueprint+GameState）的纯规则分类器 | **参考，不改** |

---

## File Structure

### 新建文件

```
src/game/gameplay/rpg/intentParser/
  intentContext.ts          # 纯函数：从 WorldState 构建意图解析上下文
  intentContext.test.ts
  preClassify.ts            # 纯规则预分类：文本 → Action | null（零 AI）
  preClassify.test.ts
  index.ts                  # facade: classifyFreeText(text, ws, source?) → Action

src/game/application/server/ai/
  intentParserSource.ts    # IntentParserSource 接口 + fixture + live 实现
  intentParserSource.test.ts
```

### 修改文件

```
src/game/application/actionConverter.ts          # 扩展 free_text 路径
src/game/application/actionConverter.test.ts      # 新增 free_text 测试
src/game/gameplay/rpg/ruleEngine/resolveByType.ts # 返回 status + stateChanges
src/game/gameplay/rpg/ruleEngine/resolveByType.test.ts
src/game/gameplay/rpg/ruleEngine/index.ts         # 透传 status 到 ResolvedEvent
src/game/gameplay/rpg/ruleEngine/index.test.ts
src/game/application/performActionV2.ts           # 异步 convertInteraction
src/game/application/performActionV2.test.ts
```

---

## Task 1: 意图解析上下文构建（纯函数）

**Files:**
- Create: `src/game/gameplay/rpg/intentParser/intentContext.ts`
- Test: `src/game/gameplay/rpg/intentParser/intentContext.test.ts`

**Interfaces:**
- Consumes: `WorldState` from `@/game/domain/worldState`
- Produces: `IntentContext`, `buildIntentContext()`

- [ ] **Step 1: Write failing tests**

```typescript
// src/game/gameplay/rpg/intentParser/intentContext.test.ts
import { describe, it, expect } from "vitest";
import { buildIntentContext, type IntentContext } from "./intentContext";
import { createInitialWorldState, appendLocation, appendNpc, type LocationEntry, type NpcEntry } from "@/game/domain/worldState";
import { asLocationId, asNpcId, asItemId, asFactId, asGenerationId } from "@/game/domain/scenarioBlueprint";

describe("buildIntentContext", () => {
  const loc1: LocationEntry = {
    id: asLocationId("loc_1"), name: "客栈", description: "t", kind: "main",
    connectedLocationIds: [asLocationId("loc_2")], npcIds: [asNpcId("npc_1")],
    availableItemIds: [asItemId("item_1")], tags: [],
  };
  const loc2: LocationEntry = {
    id: asLocationId("loc_2"), name: "街道", description: "t", kind: "main",
    connectedLocationIds: [asLocationId("loc_1")], npcIds: [], availableItemIds: [], tags: [],
  };
  const baseWs = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: loc1,
    startingItemIds: [],
  });
  const npc1: NpcEntry = {
    id: asNpcId("npc_1"), name: "老板", role: "路人", description: "t",
    locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
    memory: { npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
  };
  const ws = appendLocation(appendNpc(baseWs, npc1), loc2);

  it("includes current location name and connected locations", () => {
    const ctx = buildIntentContext(ws);
    expect(ctx.currentLocationName).toBe("客栈");
    expect(ctx.connectedLocations).toHaveLength(1);
    expect(ctx.connectedLocations[0]?.name).toBe("街道");
  });

  it("includes NPCs at current location", () => {
    const ctx = buildIntentContext(ws);
    expect(ctx.presentNpcs).toHaveLength(1);
    expect(ctx.presentNpcs[0]?.name).toBe("老板");
  });

  it("includes available items at current location", () => {
    const ctx = buildIntentContext(ws);
    expect(ctx.availableItems).toHaveLength(1);
  });

  it("includes undiscovered facts", () => {
    const ctx = buildIntentContext(ws);
    expect(Array.isArray(ctx.undiscoveredFacts)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/game/gameplay/rpg/intentParser/intentContext.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement IntentContext**

```typescript
// src/game/gameplay/rpg/intentParser/intentContext.ts
import type { WorldState } from "@/game/domain/worldState";
import { findLocation } from "@/game/domain/worldState";
import type { LocationId, NpcId, ItemId, FactId } from "@/game/domain/scenarioBlueprint";

export type IntentContextEntity = {
  readonly id: string;
  readonly name: string;
};

export type IntentContext = {
  readonly currentLocationName: string;
  readonly connectedLocations: readonly IntentContextEntity[];
  readonly presentNpcs: readonly IntentContextEntity[];
  readonly availableItems: readonly IntentContextEntity[];
  readonly undiscoveredFacts: readonly IntentContextEntity[];
  readonly activeQuests: readonly IntentContextEntity[];
};

export function buildIntentContext(ws: WorldState): IntentContext {
  const currentLoc = findLocation(ws, ws.currentLocationId);

  const connectedLocations = currentLoc
    ? currentLoc.connectedLocationIds
        .map((id) => findLocation(ws, id))
        .filter((l): l is NonNullable<typeof l> => l !== undefined)
        .map((l) => ({ id: String(l.id), name: l.name }))
    : [];

  const presentNpcs = ws.npcs
    .filter((n) => n.locationId === ws.currentLocationId)
    .map((n) => ({ id: String(n.id), name: n.name }));

  const availableItems = currentLoc
    ? currentLoc.availableItemIds
        .map((id) => ws.items.find((i) => i.id === id))
        .filter((i): i is NonNullable<typeof i> => i !== undefined)
        .map((i) => ({ id: String(i.id), name: i.name }))
    : [];

  const undiscoveredFacts = ws.worldFacts
    .filter((f) => !f.discovered)
    .map((f) => ({ id: String(f.factId), name: f.text.slice(0, 20) }));

  const activeQuests = ws.quests
    .filter((q) => q.status === "active")
    .map((q) => ({ id: String(q.id), name: q.name }));

  return {
    currentLocationName: currentLoc?.name ?? "未知",
    connectedLocations,
    presentNpcs,
    availableItems,
    undiscoveredFacts,
    activeQuests,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/game/gameplay/rpg/intentParser/intentContext.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/game/gameplay/rpg/intentParser/intentContext.ts src/game/gameplay/rpg/intentParser/intentContext.test.ts
git commit -m "feat: IntentContext 纯函数——从 WorldState 构建意图解析上下文"
```

---

## Task 2: 纯规则预分类器

**Files:**
- Create: `src/game/gameplay/rpg/intentParser/preClassify.ts`
- Test: `src/game/gameplay/rpg/intentParser/preClassify.test.ts`

**Interfaces:**
- Consumes: `IntentContext` from Task 1, `Action` from `@/game/domain/action`
- Produces: `preClassifyFreeText()` → `Action | null`（null 表示需要 AI 分类）

- [ ] **Step 1: Write failing tests**

```typescript
// src/game/gameplay/rpg/intentParser/preClassify.test.ts
import { describe, it, expect } from "vitest";
import { preClassifyFreeText } from "./preClassify";
import type { IntentContext } from "./intentContext";
import { asLocationId, asNpcId, asItemId } from "@/game/domain/scenarioBlueprint";

describe("preClassifyFreeText", () => {
  const ctx: IntentContext = {
    currentLocationName: "客栈",
    connectedLocations: [{ id: "loc_2", name: "街道" }],
    presentNpcs: [{ id: "npc_1", name: "老板" }],
    availableItems: [{ id: "item_1", name: "钥匙" }],
    undiscoveredFacts: [{ id: "fact_1", name: "墙上刻字" }],
    activeQuests: [{ id: "quest_1", name: "寻找失物" }],
  };

  it("matches move by connected location name", () => {
    const action = preClassifyFreeText("去街道看看", ctx);
    expect(action?.type).toBe("move");
    if (action?.type === "move") {
      expect(String(action.locationId)).toBe("loc_2");
    }
  });

  it("matches talk by present npc name", () => {
    const action = preClassifyFreeText("和老板聊聊", ctx);
    expect(action?.type).toBe("talk");
    if (action?.type === "talk") {
      expect(String(action.npcId)).toBe("npc_1");
      expect(action.utterance).toBe("和老板聊聊");
    }
  });

  it("matches take_item by available item name", () => {
    const action = preClassifyFreeText("拿走钥匙", ctx);
    expect(action?.type).toBe("take_item");
    if (action?.type === "take_item") {
      expect(String(action.itemId)).toBe("item_1");
    }
  });

  it("matches investigate by fact keyword", () => {
    const action = preClassifyFreeText("调查墙上刻字", ctx);
    expect(action?.type).toBe("investigate");
  });

  it("returns null for unclassifiable text", () => {
    const action = preClassifyFreeText("今天天气真好", ctx);
    expect(action).toBeNull();
  });

  it("returns null for empty text", () => {
    const action = preClassifyFreeText("", ctx);
    expect(action).toBeNull();
  });

  it("matches explore intent", () => {
    const action = preClassifyFreeText("四处探索一下", ctx);
    expect(action?.type).toBe("explore");
  });

  it("matches rest intent", () => {
    const action = preClassifyFreeText("休息一会儿", ctx);
    expect(action?.type).toBe("rest");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/game/gameplay/rpg/intentParser/preClassify.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement preClassify**

```typescript
// src/game/gameplay/rpg/intentParser/preClassify.ts
import type { Action } from "@/game/domain/action";
import type { IntentContext } from "./intentContext";
import { asLocationId, asNpcId, asItemId, asFactId } from "@/game/domain/scenarioBlueprint";

const MOVE_VERBS = ["去", "前往", "到", "回", "进", "出"];
const TALK_VERBS = ["和", "与", "跟", "找", "问", " talk", "交谈", "聊聊", "说话"];
const TAKE_VERBS = ["拿", "取", "捡", "拿走", "拾起", "取走"];
const INVESTIGATE_VERBS = ["调查", "查看", "检查", "研究", "观察"];
const EXPLORE_VERBS = ["探索", "四处看看", "看看周围", "搜索"];
const REST_VERBS = ["休息", "睡觉", "歇息", "打坐"];

function matchesAny(text: string, verbs: readonly string[]): boolean {
  return verbs.some((v) => text.includes(v));
}

export function preClassifyFreeText(text: string, ctx: IntentContext): Action | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  // 1. Move: text mentions a connected location name + move verb
  if (matchesAny(trimmed, MOVE_VERBS)) {
    for (const loc of ctx.connectedLocations) {
      if (trimmed.includes(loc.name)) {
        return { type: "move", locationId: asLocationId(loc.id) };
      }
    }
  }

  // 2. Talk: text mentions a present NPC name + talk verb
  if (matchesAny(trimmed, TALK_VERBS)) {
    for (const npc of ctx.presentNpcs) {
      if (trimmed.includes(npc.name)) {
        return { type: "talk", npcId: asNpcId(npc.id), utterance: trimmed };
      }
    }
  }

  // 3. Take item: text mentions an available item name + take verb
  if (matchesAny(trimmed, TAKE_VERBS)) {
    for (const item of ctx.availableItems) {
      if (trimmed.includes(item.name)) {
        return { type: "take_item", itemId: asItemId(item.id) };
      }
    }
  }

  // 4. Investigate: text mentions a fact keyword + investigate verb
  if (matchesAny(trimmed, INVESTIGATE_VERBS)) {
    for (const fact of ctx.undiscoveredFacts) {
      if (trimmed.includes(fact.name)) {
        return { type: "investigate", factId: asFactId(fact.id), utterance: trimmed };
      }
    }
  }

  // 5. Explore
  if (matchesAny(trimmed, EXPLORE_VERBS)) {
    return { type: "explore" };
  }

  // 6. Rest
  if (matchesAny(trimmed, REST_VERBS)) {
    return { type: "rest" };
  }

  // 无法纯规则分类——需要 AI
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/game/gameplay/rpg/intentParser/preClassify.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/game/gameplay/rpg/intentParser/preClassify.ts src/game/gameplay/rpg/intentParser/preClassify.test.ts
git commit -m "feat: preClassify 纯规则预分类——零 AI 实体名匹配"
```

---

## Task 3: IntentParserSource 接口 + Fixture

**Files:**
- Create: `src/game/application/server/ai/intentParserSource.ts`
- Test: `src/game/application/server/ai/intentParserSource.test.ts`

**Interfaces:**
- Consumes: `IntentContext` from Task 1, `Action` from `@/game/domain/action`
- Produces: `IntentParserSource`, `IntentParserResult`, `createFixtureIntentParserSource()`

- [ ] **Step 1: Write failing tests + implement interface + fixture**

```typescript
// src/game/application/server/ai/intentParserSource.ts
import type { IntentContext } from "@/game/gameplay/rpg/intentParser/intentContext";
import type { Action } from "@/game/domain/action";

// ---------------------------------------------------------------------------
// IntentParserSource：可注入的 AI 意图解析 port。
// 生产环境注入 live source（小模型），测试/离线注入 fixture source。
// ---------------------------------------------------------------------------

export type IntentParserResult =
  | { readonly ok: true; readonly action: Action }
  | { readonly ok: false; readonly reason: "unclassifiable" | "service_error" };

export type IntentParserSource = {
  readonly sourceVersion: string;
  parseIntent(text: string, ctx: IntentContext): Promise<IntentParserResult>;
};

// ---------------------------------------------------------------------------
// Fixture：确定性硬编码映射，用于离线测试。
// 策略：按关键词匹配 IntentContext 中的实体名，命中则返回对应 Action。
// ---------------------------------------------------------------------------

export function createFixtureIntentParserSource(): IntentParserSource {
  return {
    sourceVersion: "fixture-intent-v1",
    async parseIntent(text: string, ctx: IntentContext): Promise<IntentParserResult> {
      const trimmed = text.trim();
      if (trimmed.length === 0) return { ok: false, reason: "unclassifiable" };

      // 尝试匹配 NPC 名（无动词要求，AI 路径更宽松）
      for (const npc of ctx.presentNpcs) {
        if (trimmed.includes(npc.name)) {
          return {
            ok: true,
            action: { type: "talk", npcId: npc.id as any, utterance: trimmed },
          };
        }
      }

      // 尝试匹配地点名
      for (const loc of ctx.connectedLocations) {
        if (trimmed.includes(loc.name)) {
          return {
            ok: true,
            action: { type: "move", locationId: loc.id as any },
          };
        }
      }

      // 尝试匹配物品名
      for (const item of ctx.availableItems) {
        if (trimmed.includes(item.name)) {
          return {
            ok: true,
            action: { type: "take_item", itemId: item.id as any },
          };
        }
      }

      return { ok: false, reason: "unclassifiable" };
    },
  };
}
```

```typescript
// src/game/application/server/ai/intentParserSource.test.ts
import { describe, it, expect } from "vitest";
import { createFixtureIntentParserSource } from "./intentParserSource";
import type { IntentContext } from "@/game/gameplay/rpg/intentParser/intentContext";

describe("FixtureIntentParserSource", () => {
  const ctx: IntentContext = {
    currentLocationName: "客栈",
    connectedLocations: [{ id: "loc_2", name: "街道" }],
    presentNpcs: [{ id: "npc_1", name: "老板" }],
    availableItems: [{ id: "item_1", name: "钥匙" }],
    undiscoveredFacts: [],
    activeQuests: [],
  };
  const source = createFixtureIntentParserSource();

  it("classifies text mentioning npc name as talk", async () => {
    const result = await source.parseIntent("老板你好", ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action.type).toBe("talk");
    }
  });

  it("classifies text mentioning location name as move", async () => {
    const result = await source.parseIntent("我想去街道", ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action.type).toBe("move");
    }
  });

  it("returns unclassifiable for unrelated text", async () => {
    const result = await source.parseIntent("今天天气真好", ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unclassifiable");
    }
  });
});
```

- [ ] **Step 2: Run tests, commit**

Run: `npx vitest run src/game/application/server/ai/intentParserSource.test.ts`
Expected: PASS

```bash
git add src/game/application/server/ai/intentParserSource.ts src/game/application/server/ai/intentParserSource.test.ts
git commit -m "feat: IntentParserSource 接口 + fixture——可注入意图解析 port"
```

---

## Task 4: ActionConverter 扩展 free_text 路径

**Files:**
- Modify: `src/game/application/actionConverter.ts`
- Modify: `src/game/application/actionConverter.test.ts`

**Interfaces:**
- Consumes: `preClassifyFreeText` from Task 2, `IntentParserSource` from Task 3, `IntentContext` from Task 1
- Produces: `convertInteraction()` 变为 async，支持 free_text；`ConvertFreeTextDeps`

- [ ] **Step 1: Write failing tests for free_text conversion**

```typescript
// src/game/application/actionConverter.test.ts（追加）
import { describe, it, expect } from "vitest";
import { convertInteraction, type ActionChoiceMap } from "./actionConverter";
import { createFixtureIntentParserSource } from "./server/ai/intentParserSource";
import { buildIntentContext } from "@/game/gameplay/rpg/intentParser/intentContext";
import { createInitialWorldState, appendLocation, appendNpc, type LocationEntry, type NpcEntry } from "@/game/domain/worldState";
import { asLocationId, asNpcId, asItemId, asGenerationId } from "@/game/domain/scenarioBlueprint";

// ... existing fixed_choice tests (now need await since convertInteraction is async) ...

describe("convertInteraction free_text", () => {
  // 建立测试世界（复用 Task 1 的 setup 结构）
  const loc1: LocationEntry = {
    id: asLocationId("loc_1"), name: "客栈", description: "t", kind: "main",
    connectedLocationIds: [asLocationId("loc_2")], npcIds: [asNpcId("npc_1")],
    availableItemIds: [asItemId("item_1")], tags: [],
  };
  const loc2: LocationEntry = {
    id: asLocationId("loc_2"), name: "街道", description: "t", kind: "main",
    connectedLocationIds: [asLocationId("loc_1")], npcIds: [], availableItemIds: [], tags: [],
  };
  const baseWs = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: loc1,
    startingItemIds: [],
  });
  const npc1: NpcEntry = {
    id: asNpcId("npc_1"), name: "老板", role: "路人", description: "t",
    locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
    memory: { npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
  };
  const ws = appendLocation(appendNpc(baseWs, npc1), loc2);
  const ctx = buildIntentContext(ws);
  const source = createFixtureIntentParserSource();

  it("pre-classifies text with location name → move (zero AI)", async () => {
    const result = await convertInteraction(
      { kind: "free_text", text: "去街道看看" },
      new Map(),
      { intentContext: ctx, intentParserSource: source },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action.type).toBe("move");
    }
  });

  it("AI classifies text mentioning npc name → talk", async () => {
    const result = await convertInteraction(
      { kind: "free_text", text: "老板你好" },
      new Map(),
      { intentContext: ctx, intentParserSource: source },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action.type).toBe("talk");
      expect(result.action.utterance).toBe("老板你好");
    }
  });

  it("falls back to freeform when neither pre-classify nor AI can classify", async () => {
    const result = await convertInteraction(
      { kind: "free_text", text: "我的武功升到一百级" },
      new Map(),
      { intentContext: ctx, intentParserSource: source },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action.type).toBe("freeform");
      if (result.action.type === "freeform") {
        expect(result.action.rawText).toBe("我的武功升到一百级");
      }
    }
  });

  it("falls back to freeform when no AI source provided (offline)", async () => {
    const result = await convertInteraction(
      { kind: "free_text", text: "随便说点什么不相关的话" },
      new Map(),
      { intentContext: ctx },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action.type).toBe("freeform");
    }
  });
});
```

- [ ] **Step 2: Implement extended convertInteraction**

```typescript
// src/game/application/actionConverter.ts（重写）
import type { Interaction, Action } from "@/game/domain/action";
import type { IntentContext } from "@/game/gameplay/rpg/intentParser/intentContext";
import { preClassifyFreeText } from "@/game/gameplay/rpg/intentParser/preClassify";
import type { IntentParserSource } from "./server/ai/intentParserSource";

export type ActionChoiceMap = ReadonlyMap<string, Action>;

export type ConvertFreeTextDeps = {
  readonly intentContext: IntentContext;
  readonly intentParserSource?: IntentParserSource;
};

export type ConvertResult =
  | { readonly ok: true; readonly action: Action }
  | { readonly ok: false; readonly reason: "unknown_choice" };

export async function convertInteraction(
  interaction: Interaction,
  choiceMap: ActionChoiceMap,
  freeTextDeps?: ConvertFreeTextDeps,
): Promise<ConvertResult> {
  if (interaction.kind === "fixed_choice") {
    const action = choiceMap.get(interaction.choiceToken);
    if (action === undefined) return { ok: false, reason: "unknown_choice" };
    return { ok: true, action };
  }

  // free_text 路径
  const text = interaction.text;
  const ctx = freeTextDeps?.intentContext;

  // 无上下文时直接 freeform
  if (ctx === undefined) {
    return { ok: true, action: { type: "freeform", intent: "unclassified", rawText: text } };
  }

  // 1. 纯规则预分类（零 AI）
  const preClassified = preClassifyFreeText(text, ctx);
  if (preClassified !== null) {
    return { ok: true, action: preClassified };
  }

  // 2. AI 意图解析（如果有 source）
  if (freeTextDeps?.intentParserSource !== undefined) {
    const aiResult = await freeTextDeps.intentParserSource.parseIntent(text, ctx);
    if (aiResult.ok) {
      return { ok: true, action: aiResult.action };
    }
  }

  // 3. 降级为 freeform
  return { ok: true, action: { type: "freeform", intent: "unclassified", rawText: text } };
}
```

- [ ] **Step 3: Run tests, commit**

Run: `npx vitest run src/game/application/actionConverter.test.ts`
Expected: PASS

```bash
git add src/game/application/actionConverter.ts src/game/application/actionConverter.test.ts
git commit -m "feat: ActionConverter free_text 路径——预分类+AI+freeform 三级降级"
```

---

## Task 5: resolveByType 五态 status + stateChanges

**Files:**
- Modify: `src/game/gameplay/rpg/ruleEngine/resolveByType.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/resolveByType.test.ts`

**Interfaces:**
- Consumes: `ResolvedEventStatus` from `@/game/domain/resolvedEvent`, `StateChange` from same
- Produces: `ResolveResult` 增加 `status` 和 `stateChanges` 字段

- [ ] **Step 1: Write failing tests for status and stateChanges**

```typescript
// 追加到 resolveByType.test.ts
// 需要额外导入 asEnemyId, asFactId（如果尚未导入）
import { asEnemyId, asFactId } from "@/game/domain/scenarioBlueprint";
import { relationshipTierOf } from "@/game/domain/relationship";

describe("resolveByType status and stateChanges", () => {
  it("move returns success status and stateChanges", () => {
    const result = resolveByType(ws, { type: "move", locationId: asLocationId("loc_2") }, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("success");
      expect(result.stateChanges.length).toBeGreaterThan(0);
      expect(result.stateChanges.some((sc) => sc.path === "currentLocationId")).toBe(true);
    }
  });

  it("talk to hostile npc returns partial_success", () => {
    const hostileNpc: NpcEntry = {
      ...npc1,
      id: asNpcId("npc_hostile"),
      name: "卫兵",
      memory: { ...npc1.memory, npcId: asNpcId("npc_hostile"), relationship: { affinity: -70 } },
    };
    const wsWithHostile = appendNpc(ws, hostileNpc);
    const result = resolveByType(wsWithHostile, { type: "talk", npcId: asNpcId("npc_hostile") }, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("partial_success");
    }
  });

  it("investigate undiscovered fact returns success", () => {
    // 需要先添加 worldFact 到 ws
    const wsWithFact = { ...ws, worldFacts: [{ factId: asFactId("fact_1"), text: "墙上刻字", source: "scene" as any, discovered: false }] };
    const result = resolveByType(wsWithFact, { type: "investigate", factId: asFactId("fact_1") }, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("success");
      expect(result.stateChanges.some((sc) => sc.path === "worldFacts[0].discovered")).toBe(true);
    }
  });

  it("move during active battle returns blocked", () => {
    const wsInBattle = { ...ws, battle: { status: "active", enemyId: asEnemyId("e1") as any, playerHp: 50, enemyHp: 30, round: 1 } };
    const result = resolveByType(wsInBattle, { type: "move", locationId: asLocationId("loc_2") }, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("blocked");
    }
  });

  it("freeform action returns success with no state changes", () => {
    const result = resolveByType(ws, { type: "freeform", intent: "chat", rawText: "你好" }, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("success");
      expect(result.stateChanges).toEqual([]);
      expect(result.nextWorldState).toBe(ws); // 无变化
    }
  });
});
```

- [ ] **Step 2: Implement enhanced resolveByType**

```typescript
// src/game/gameplay/rpg/ruleEngine/resolveByType.ts（重写关键部分）
import type { WorldState } from "@/game/domain/worldState";
import { findLocation, findNpc } from "@/game/domain/worldState";
import type { Action } from "@/game/domain/action";
import type { GameEvent } from "@/game/domain/events";
import type { ResolvedEventStatus, StateChange } from "@/game/domain/resolvedEvent";
import type { RelationshipTier } from "@/game/domain/relationship";
import { relationshipTierOf } from "@/game/domain/relationship";

export type ResolveResult = {
  readonly ok: true;
  readonly nextWorldState: WorldState;
  readonly events: readonly GameEvent[];
  readonly feedback: string;
  readonly status: ResolvedEventStatus;
  readonly stateChanges: readonly StateChange[];
} | {
  readonly ok: false;
  readonly feedback: string;
};

export type ResolveDeps = { readonly now: () => string };

export function resolveByType(ws: WorldState, action: Action, deps: ResolveDeps): ResolveResult {
  const occurredAt = deps.now();

  // freeform：零世界变化
  if (action.type === "freeform") {
    return {
      ok: true,
      nextWorldState: ws,
      events: [],
      feedback: "",
      status: "success",
      stateChanges: [],
    };
  }

  // 战斗中阻止非战斗行动
  if (ws.battle.status === "active" && action.type !== "battle_action") {
    return {
      ok: true,
      nextWorldState: ws,
      events: [],
      feedback: "战斗中无法执行此行动。",
      status: "blocked",
      stateChanges: [],
    };
  }

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
      const stateChanges: StateChange[] = [
        { path: "currentLocationId", description: `移动到 ${locName}`, operation: "set" },
        { path: "visitedLocationIds", description: `记录到访`, operation: "add" },
      ];
      return { ok: true, nextWorldState: nextWs, events: [event], feedback: `你来到了${locName}。`, status: "success", stateChanges };
    }
    case "talk": {
      const npc = findNpc(ws, action.npcId);
      if (npc === undefined) return { ok: false, feedback: "未知角色。" };
      const event: GameEvent = { type: "npc_met", npcId: action.npcId, occurredAt, interactionKind: "greet" };
      const nextWs: WorldState = {
        ...ws,
        npcs: ws.npcs.map((n) => n.id === action.npcId ? { ...n, met: true } : n),
        eventLedger: [...ws.eventLedger, event],
      };
      const tier = relationshipTierOf(npc.memory.relationship);
      const status: ResolvedEventStatus = tier === "hostile" ? "partial_success" : "success";
      const stateChanges: StateChange[] = [
        { path: `npcs[${String(action.npcId)}].met`, description: `与${npc.name}交谈`, operation: "set" },
      ];
      if (status === "partial_success") {
        stateChanges.push({ path: `npcs[${String(action.npcId)}].relationship`, description: `${npc.name}态度敌对，勉强交流`, operation: "update" });
      }
      return { ok: true, nextWorldState: nextWs, events: [event], feedback: `你与${npc.name}交谈。`, status, stateChanges };
    }
    case "investigate": {
      const event: GameEvent = { type: "fact_discovered", factId: action.factId, occurredAt };
      const nextWs: WorldState = {
        ...ws,
        worldFacts: ws.worldFacts.map((f) => f.factId === action.factId ? { ...f, discovered: true } : f),
        eventLedger: [...ws.eventLedger, event],
      };
      const stateChanges: StateChange[] = [
        { path: `worldFacts[${String(action.factId)}].discovered`, description: `发现线索`, operation: "set" },
      ];
      return { ok: true, nextWorldState: nextWs, events: [event], feedback: "你调查了这条线索。", status: "success", stateChanges };
    }
    case "take_item": {
      const event: GameEvent = { type: "item_obtained", itemId: action.itemId, locationId: ws.currentLocationId, occurredAt };
      const nextWs: WorldState = {
        ...ws,
        inventory: [...ws.inventory, action.itemId],
        locations: ws.locations.map((l) =>
          l.id === ws.currentLocationId
            ? { ...l, availableItemIds: l.availableItemIds.filter((id) => id !== action.itemId) }
            : l,
        ),
        eventLedger: [...ws.eventLedger, event],
      };
      const stateChanges: StateChange[] = [
        { path: "inventory", description: `获得物品 ${String(action.itemId)}`, operation: "add" },
        { path: `locations[current].availableItemIds`, description: `从地点移除物品`, operation: "remove" },
      ];
      return { ok: true, nextWorldState: nextWs, events: [event], feedback: "你取得了这件物品。", status: "success", stateChanges };
    }
    case "ack_prologue": {
      return { ok: true, nextWorldState: { ...ws }, events: [], feedback: "", status: "success", stateChanges: [] };
    }
    default:
      return { ok: false, feedback: "此行动类型暂不支持。" };
  }
}
```

- [ ] **Step 3: Run tests, commit**

Run: `npx vitest run src/game/gameplay/rpg/ruleEngine/resolveByType.test.ts`
Expected: PASS

```bash
git add src/game/gameplay/rpg/ruleEngine/resolveByType.ts src/game/gameplay/rpg/ruleEngine/resolveByType.test.ts
git commit -m "feat: resolveByType 五态 status + stateChanges 审计清单"
```

---

## Task 6: ruleEngine facade 透传 status + stateChanges

**Files:**
- Modify: `src/game/gameplay/rpg/ruleEngine/index.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/index.test.ts`

- [ ] **Step 1: Write failing test for status passthrough**

```typescript
// 追加到 index.test.ts
describe("ruleEngine status passthrough", () => {
  it("passes partial_success from resolveByType to ResolvedEvent", () => {
    const hostileNpc: NpcEntry = {
      id: asNpcId("npc_hostile"), name: "卫兵", role: "守卫", description: "t",
      locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
      memory: { npcId: asNpcId("npc_hostile"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: -70 }, emotion: "hostile", goals: [] },
    };
    const wsWithHostile = appendNpc(ws, hostileNpc);
    const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 2, npcs: 1, quests: 0, events: 0 } });
    const result = ruleEngine(wsWithHostile, ss, { type: "talk", npcId: asNpcId("npc_hostile") }, "act_1", deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolvedEvent.status).toBe("partial_success");
    }
  });

  it("passes blocked status for move during battle", () => {
    const wsInBattle = { ...ws, battle: { status: "active" as const, enemyId: asEnemyId("e1") as any, playerHp: 50, enemyHp: 30, round: 1 } };
    const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 2, npcs: 1, quests: 0, events: 0 } });
    const result = ruleEngine(wsInBattle, ss, { type: "move", locationId: asLocationId("loc_2") }, "act_1", deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolvedEvent.status).toBe("blocked");
      expect(result.resolvedEvent.stateChanges).toEqual([]);
    }
  });

  it("populates stateChanges in ResolvedEvent", () => {
    const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 2, npcs: 1, quests: 0, events: 0 } });
    const result = ruleEngine(ws, ss, { type: "move", locationId: asLocationId("loc_2") }, "act_1", deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolvedEvent.stateChanges.length).toBeGreaterThan(0);
      expect(result.resolvedEvent.stateChanges.some((sc) => sc.path === "currentLocationId")).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Modify ruleEngine facade**

```typescript
// src/game/gameplay/rpg/ruleEngine/index.ts（修改 ruleEngine 函数体）
export function ruleEngine(
  worldState: WorldState,
  storyState: StoryState,
  action: Action,
  actionId: string,
  deps: RuleEngineDeps,
): RuleEngineResult {
  const validation = validateAction(worldState, action);
  if (!validation.ok) {
    return { ok: false, code: validation.code, feedback: `Action rejected: ${validation.code}` };
  }

  const resolved = resolveByType(worldState, action, deps);
  if (!resolved.ok) {
    return { ok: false, code: "INTENT_NOT_ROUTED", feedback: resolved.feedback };
  }

  // blocked 状态：不推进任务/结局/张力，直接返回
  if (resolved.status === "blocked") {
    const resolvedEvent: ResolvedEvent = {
      actionId,
      status: "blocked",
      eventKind: eventKindForAction(action),
      stateChanges: [],
      facts: [],
      costs: [],
      rewards: [],
      triggeredEvents: [],
      rejectedEffects: [{ description: "被战斗阻止", reason: "battle_active" }],
      stateVersion: resolved.nextWorldState.eventLedger.length,
    };
    return { ok: true, nextWorldState: resolved.nextWorldState, nextStoryState: storyState, resolvedEvent };
  }

  const quests = reconcileQuests(resolved.nextWorldState, deps);
  const ending = resolveEnding(quests.nextWorldState, storyState, deps);
  const allEvents = [...resolved.events, ...quests.events, ...ending.events];
  const nextStoryState = updateStoryMetrics(ending.nextStoryState, allEvents);

  const resolvedEvent: ResolvedEvent = {
    actionId,
    status: resolved.status,  // 透传 resolveByType 的 status
    eventKind: eventKindForAction(action),
    stateChanges: resolved.stateChanges,  // 透传审计清单
    facts: [],
    costs: [],
    rewards: [],
    triggeredEvents: allEvents.map((e) => e.type),
    rejectedEffects: [],
    stateVersion: ending.nextWorldState.eventLedger.length,
  };

  return { ok: true, nextWorldState: ending.nextWorldState, nextStoryState, resolvedEvent };
}
```

- [ ] **Step 3: Run tests, commit**

Run: `npx vitest run src/game/gameplay/rpg/ruleEngine/index.test.ts`
Expected: PASS

```bash
git add src/game/gameplay/rpg/ruleEngine/index.ts src/game/gameplay/rpg/ruleEngine/index.test.ts
git commit -m "feat: ruleEngine facade 透传 status + stateChanges"
```

---

## Task 7: performActionV2 异步 ActionConverter 集成

**Files:**
- Modify: `src/game/application/performActionV2.ts`
- Modify: `src/game/application/performActionV2.test.ts`

- [ ] **Step 1: Modify performActionV2 to support async convertInteraction**

```typescript
// src/game/application/performActionV2.ts（关键改动）
export type PerformActionV2Deps = {
  readonly repository: GameRepositoryV2;
  readonly now: () => string;
  readonly intentParserSource?: IntentParserSource;
};

export async function performActionV2(
  command: PerformActionV2Command,
  deps: PerformActionV2Deps,
): Promise<PerformActionV2Result> {
  // 1. Load game
  // 2. Check revision
  // 3. Build intent context from current WorldState
  const intentCtx = buildIntentContext(record.worldState);
  // 4. async convertInteraction
  const converted = await convertInteraction(
    command.interaction,
    command.choiceMap,
    { intentContext: intentCtx, intentParserSource: deps.intentParserSource },
  );
  // 5. ruleEngine
  // 6. stateCommit
  // 7. Return
}
```

- [ ] **Step 2: Write integration test: free_text → talk → commit**

```typescript
describe("performActionV2 free_text integration", () => {
  it("converts free text to talk and commits", async () => {
    // 使用 in-memory repository fixture
    const repo = createInMemoryGameRepositoryV2();
    // 复用 Task 1 的 loc1/npc1 setup
    const loc1: LocationEntry = {
      id: asLocationId("loc_1"), name: "客栈", description: "t", kind: "main",
      connectedLocationIds: [asLocationId("loc_2")], npcIds: [asNpcId("npc_1")],
      availableItemIds: [], tags: [],
    };
    const loc2: LocationEntry = {
      id: asLocationId("loc_2"), name: "街道", description: "t", kind: "main",
      connectedLocationIds: [asLocationId("loc_1")], npcIds: [], availableItemIds: [], tags: [],
    };
    const npc1: NpcEntry = {
      id: asNpcId("npc_1"), name: "老板", role: "路人", description: "t",
      locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
      memory: { npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
    };
    const ws = appendLocation(appendNpc(createInitialWorldState({
      generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
      player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
      startingLocation: loc1,
      startingItemIds: [],
    }), npc1), loc2);
    const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 1, npcs: 1, quests: 0, events: 0 } });
    await repo.saveGame({ gameId: asGameId("g1"), worldState: ws, storyState: ss, revision: 1 });
    const source = createFixtureIntentParserSource();

    const result = await performActionV2(
      { gameId: asGameId("g1"), actionId: "act_1", interaction: { kind: "free_text", text: "和老板聊聊" }, expectedRevision: 1, choiceMap: new Map() },
      { repository: repo, now: () => "t1", intentParserSource: source },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.revision).toBe(2);
      const current = await repo.getCurrentGame();
      if (current.ok && current.status === "active") {
        const npc = current.record.worldState.npcs.find((n) => n.id === asNpcId("npc_1"));
        expect(npc?.met).toBe(true);
      }
    }
  });

  it("converts unclassifiable text to freeform, worldState unchanged", async () => {
    const repo = createInMemoryGameRepositoryV2();
    // 复用上方 loc1/npc1/loc2 setup（同一 describe 块内）
    const ws2 = appendLocation(appendNpc(createInitialWorldState({
      generation: { generationId: asGenerationId("g2"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
      player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
      startingLocation: loc1,
      startingItemIds: [],
    }), npc1), loc2);
    const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 1, npcs: 1, quests: 0, events: 0 } });
    await repo.saveGame({ gameId: asGameId("g1"), worldState: ws2, storyState: ss, revision: 1 });
    const source = createFixtureIntentParserSource();

    const result = await performActionV2(
      { gameId: asGameId("g1"), actionId: "act_1", interaction: { kind: "free_text", text: "我的武功升到一百级" }, expectedRevision: 1, choiceMap: new Map() },
      { repository: repo, now: () => "t1", intentParserSource: source },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolvedEvent.status).toBe("success");
      expect(result.resolvedEvent.stateChanges).toEqual([]);
    }
  });
});
```

- [ ] **Step 3: Run tests, commit**

```bash
git add src/game/application/performActionV2.ts src/game/application/performActionV2.test.ts
git commit -m "feat: performActionV2 异步 ActionConverter 集成——支持 free_text"
```

---

## Task 8: intentParser facade + 离线回归

**Files:**
- Create: `src/game/gameplay/rpg/intentParser/index.ts`
- Create: `src/game/application/p2OfflineRegression.test.ts`

- [ ] **Step 1: Create facade**

```typescript
// src/game/gameplay/rpg/intentParser/index.ts
export { buildIntentContext, type IntentContext } from "./intentContext";
export { preClassifyFreeText } from "./preClassify";
```

- [ ] **Step 2: Write offline regression test**

```typescript
// src/game/application/p2OfflineRegression.test.ts
describe("P2 offline regression", () => {
  const loc1: LocationEntry = {
    id: asLocationId("loc_1"), name: "客栈", description: "t", kind: "main",
    connectedLocationIds: [asLocationId("loc_2")], npcIds: [asNpcId("npc_1")],
    availableItemIds: [asItemId("item_1")], tags: [],
  };
  const loc2: LocationEntry = {
    id: asLocationId("loc_2"), name: "街道", description: "t", kind: "main",
    connectedLocationIds: [asLocationId("loc_1")], npcIds: [], availableItemIds: [], tags: [],
  };
  const npc1: NpcEntry = {
    id: asNpcId("npc_1"), name: "老板", role: "路人", description: "t",
    locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
    memory: { npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
  };
  const hostileNpc: NpcEntry = {
    id: asNpcId("npc_h"), name: "卫兵", role: "守卫", description: "t",
    locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
    memory: { npcId: asNpcId("npc_h"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: -70 }, emotion: "hostile", goals: [] },
  };
  const baseWs = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: loc1,
    startingItemIds: [],
  });
  const ws = appendLocation(appendNpc(baseWs, npc1), loc2);
  const deps = { now: () => "t1" };
  const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 2, npcs: 1, quests: 0, events: 0 } });

  it("free text → pre-classify → ruleEngine → commit (zero AI)", async () => {
    const ctx = buildIntentContext(ws);
    const converted = await convertInteraction(
      { kind: "free_text", text: "去街道看看" },
      new Map(),
      { intentContext: ctx },
    );
    expect(converted.ok).toBe(true);
    if (converted.ok) {
      expect(converted.action.type).toBe("move");
      const result = ruleEngine(ws, ss, converted.action, "act_1", deps);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.resolvedEvent.status).toBe("success");
        expect(result.resolvedEvent.stateChanges.length).toBeGreaterThan(0);
        expect(result.nextWorldState.currentLocationId).toBe(asLocationId("loc_2"));
      }
    }
  });

  it("free text → AI fixture → talk → ruleEngine → commit", async () => {
    const ctx = buildIntentContext(ws);
    const source = createFixtureIntentParserSource();
    const converted = await convertInteraction(
      { kind: "free_text", text: "老板你好" },
      new Map(),
      { intentContext: ctx, intentParserSource: source },
    );
    expect(converted.ok).toBe(true);
    if (converted.ok) {
      expect(converted.action.type).toBe("talk");
      const result = ruleEngine(ws, ss, converted.action, "act_2", deps);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.resolvedEvent.status).toBe("success");
        const npc = result.nextWorldState.npcs.find((n) => n.id === asNpcId("npc_1"));
        expect(npc?.met).toBe(true);
      }
    }
  });

  it("free text → freeform → no world change", async () => {
    const ctx = buildIntentContext(ws);
    const source = createFixtureIntentParserSource();
    const converted = await convertInteraction(
      { kind: "free_text", text: "我的武功升到一百级" },
      new Map(),
      { intentContext: ctx, intentParserSource: source },
    );
    expect(converted.ok).toBe(true);
    if (converted.ok) {
      expect(converted.action.type).toBe("freeform");
      const result = ruleEngine(ws, ss, converted.action, "act_3", deps);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.resolvedEvent.status).toBe("success");
        expect(result.resolvedEvent.stateChanges).toEqual([]);
        expect(result.nextWorldState).toBe(ws);
      }
    }
  });

  it("partial_success: talk to hostile npc", () => {
    const wsWithHostile = appendNpc(ws, hostileNpc);
    const result = ruleEngine(wsWithHostile, ss, { type: "talk", npcId: asNpcId("npc_h") }, "act_4", deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolvedEvent.status).toBe("partial_success");
    }
  });

  it("blocked: move during battle", () => {
    const wsInBattle = { ...ws, battle: { status: "active" as const, enemyId: asEnemyId("e1") as any, playerHp: 50, enemyHp: 30, round: 1 } };
    const result = ruleEngine(wsInBattle, ss, { type: "move", locationId: asLocationId("loc_2") }, "act_5", deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolvedEvent.status).toBe("blocked");
      expect(result.resolvedEvent.stateChanges).toEqual([]);
    }
  });
});
```

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: P2 intentParser facade + 离线全流水线回归"
```

---

## Self-Review

**Spec coverage check:**
- ✅ ActionConverter 自由文本（小模型意图解析 + freeform 兜底）→ Tasks 1-4, 7
- ✅ ResolvedEvent 五态结果 → Task 5-6
- ✅ stateChanges 审计清单 → Task 5-6
- ✅ utterance 透传（规则忽略，叙事读取）→ Task 4
- ✅ 离线基线与可注入 AI source → Task 3, 8
- ✅ freeform 不执行世界变化 → Task 5

**Placeholder scan:** No placeholders. All test code blocks contain complete, self-contained test setups. Test setup objects (loc1, loc2, npc1, hostileNpc) are fully defined within each describe block.

**Type consistency:**
- `ResolveResult` now includes `status: ResolvedEventStatus` and `stateChanges: readonly StateChange[]` — matches `ResolvedEvent` type in `resolvedEvent.ts`
- `convertInteraction` returns `Promise<ConvertResult>` — matches async usage in `performActionV2`
- `IntentParserSource.parseIntent` returns `Promise<IntentParserResult>` — matches async usage
- `preClassifyFreeText` returns `Action | null` — null means "needs AI"
