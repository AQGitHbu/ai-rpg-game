# NPC 对话驱动的叙事场景触发 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** NPC 对话（固定选项和自由输入）能触发叙事场景生成，走同一套 pending + 三角色流水线，玩家自由输入经服务端纯规则分类后决定是否触发场景或闲聊回应。

**Architecture:** 三段式扩展：domain 新增 `playerNpcChat` 可选字段；gameplay 新增 `classifyFreeDialogue` 纯规则分类器与 `composeNpcCasualReply` 确定性闲聊回应生成器；application 扩展 `performAction` pending 排队逻辑、新增 `POST /api/game/npc/dialogue` 端点、`DirectorContext` 注入 `playerNpcChat`；UI 启用 NpcDialoguePanel 底部输入框。

**Tech Stack:** TypeScript strict / Next.js / vitest / @libsql（sqlite）

**Spec:** `docs/superpowers/specs/2026-07-31-npc-dialogue-narrative-trigger.md`（核心设计决策、数据流、API 变更、关键纪律以 spec 为准）

## Global Constraints

- 工作分支放 `.worktrees/`（建议 `codex/npc-dialogue-narrative-trigger`），禁止 `git checkout` 切主工作区
- Windows PowerShell 环境；测试命令 `npx vitest run <file>`；静态检查 `npx tsc --noEmit` 与 `npx eslint .`
- 依赖边界不可破坏：domain 禁止 import gameplay/application；gameplay 禁止 import application；UI 只经 `@/game/application` 门面；`process.env` 只许 application/server 内读取；每个任务完成后跑 `npx vitest run src/dependencyBoundaries.test.ts`
- 所有新纯函数禁止 IO/env/随机/时间；随机性只来自显式 seed
- AI 产物进入状态前必须逐字段重建，绝不透传 AI 对象引用
- 注释风格与项目一致（中文、说明"为什么"）；TDD：先写失败测试再实现
- 自由输入不触发 `resolveAction`、不产生 `npc_met` 事件、不改变 `met` 状态
- `classifyFreeDialogue` 是纯规则函数，零 AI 调用
- `playerNpcChat` 单次消费，场景 ready 的同一 CAS 写入中清除

---

### Task 1: domain — `playerNpcChat` 可选字段 + `NarrativeGenerationState` 扩展

**Files:**
- Modify: `src/game/domain/narrative.ts`（`NarrativeGenerationState` 扩展 `pending` 变体携带 `playerNpcChat`；新增 `PlayerNpcChatState` 类型）
- Modify: `src/game/domain/gameState.ts`（`GameState` 无变化，`playerNpcChat` 挂载在 `narrative.generation` 下）
- Modify: `src/game/domain/index.ts`（导出新类型）
- Test: `src/game/domain/narrative.test.ts`（追加）

**Interfaces:**
- Produces:

```ts
// 新增类型（位置：narrative.ts，NarrativeGenerationState 之前）
export type PlayerNpcChatState = {
  readonly npcId: NpcId;
  readonly playerText: string;
  readonly npcName: string;
  readonly npcRole: string;
};

// NarrativeGenerationState 扩展 pending 变体
export type NarrativeGenerationState =
  | { readonly status: "idle" }
  | { readonly status: "pending"; readonly requestedAt: string; readonly playerNpcChat?: PlayerNpcChatState };
```

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import type { PlayerNpcChatState } from "./narrative";

describe("PlayerNpcChatState 类型", () => {
  it("正确构造", () => {
    const chat: PlayerNpcChatState = { npcId: "npc_1" as never, playerText: "你好", npcName: "铁匠", npcRole: "铁匠铺老板" };
    expect(chat.npcId).toBe("npc_1");
    expect(chat.playerText).toBe("你好");
  });
  it("pending 状态可携带 playerNpcChat", () => {
    const gen: { readonly status: "pending"; readonly requestedAt: string; readonly playerNpcChat?: PlayerNpcChatState } = {
      status: "pending", requestedAt: "2026-01-01T00:00:00Z",
      playerNpcChat: { npcId: "npc_1" as never, playerText: "测试", npcName: "铁匠", npcRole: "铁匠铺老板" }
    };
    expect(gen.status).toBe("pending");
    expect(gen.playerNpcChat?.playerText).toBe("测试");
  });
  it("pending 状态可不携带 playerNpcChat（兼容旧存档）", () => {
    const gen: { readonly status: "pending"; readonly requestedAt: string } = {
      status: "pending", requestedAt: "2026-01-01T00:00:00Z"
    };
    expect(gen.playerNpcChat).toBeUndefined();
  });
});
```

- [ ] **Step 2:** `npx vitest run src/game/domain/narrative.test.ts` → FAIL（类型不存在）
- [ ] **Step 3: 实现**：`narrative.ts` 新增 `PlayerNpcChatState` 类型；`NarrativeGenerationState` 的 `pending` 变体增加 `readonly playerNpcChat?: PlayerNpcChatState`。
- [ ] **Step 4:** `npx vitest run src/game/domain/narrative.test.ts` → PASS
- [ ] **Step 5:** `git add -A && git commit -m "feat(domain): 新增 PlayerNpcChatState 与 NarrativeGenerationState pending 扩展"`

---

### Task 2: gameplay — `classifyFreeDialogue` 纯规则分类器

**Files:**
- Create: `src/game/gameplay/rpg/actions/classifyFreeDialogue.ts`
- Test: `src/game/gameplay/rpg/actions/classifyFreeDialogue.test.ts`
- Modify: `src/game/gameplay/rpg/actions/index.ts`（导出新函数）

**Interfaces:**
- Consumes: `ScenarioBlueprint`、`GameState`、`NpcId`、`playerText: string`
- Produces: `"chat" | "narrative"`（纯函数，零 AI，零 IO）
- 核心规则（spec §4.2）：
  1. 文本长度 < 4 或仅为标点/空白 → `"chat"`
  2. 命中当前 active 任务 `name`/`description` 中的关键词 → `"narrative"`
  3. 命中已知 blueprint `locations`/`npcs`/`items` 的 `name` 或 `displayName` → `"narrative"`
  4. 命中"去/找/调查/探索/战斗"等探索意图动词 + 任意名词 → `"narrative"`
  5. 以上皆否 → `"chat"`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { classifyFreeDialogue } from "./classifyFreeDialogue";
import type { ScenarioBlueprint, GameState, NpcId } from "@/game/domain";

function buildMinimalBlueprint(overrides?: Partial<ScenarioBlueprint>): ScenarioBlueprint {
  return {
    schemaVersion: 1 as const,
    generationId: "gen-test" as never,
    seed: "test",
    templateVersion: "tpl-1",
    inputDigest: "digest",
    gameType: "wuxia",
    world: { name: "世界", summary: "", tone: "dark", themes: [], facts: [] },
    locations: [
      { id: "loc_1" as never, name: "废弃矿坑", description: "", kind: "main", connectedLocationIds: [] },
      { id: "loc_2" as never, name: "大石镇", description: "", kind: "main", connectedLocationIds: [] },
    ],
    npcs: [
      { id: "npc_1" as never, name: "铁匠", role: "铁匠", locationId: "loc_1" as never, knownFactIds: [] },
    ],
    quests: [
      { id: "q_main_1" as never, kind: "main" as const, stage: 1, name: "锈蚀的线索", description: "调查废弃矿坑", objectives: [], onSuccess: "unlock_next" as const, outcomes: [], endingCondition: null },
    ],
    enemies: [], items: [], endings: [],
    player: { name: "Player", identity: "Hero", startingItemIds: [], baseStats: { hp: 20, attack: 5, defense: 3 } },
    openingScene: { locationId: "loc_1" as never, narration: "", suggestedActions: [], presentNpcIds: [], investigableFactIds: [] },
    ...overrides,
  } as unknown as ScenarioBlueprint;
}

function buildState(overrides?: Partial<GameState>): GameState {
  return {
    stateVersion: 1 as const,
    generation: {} as never,
    player: { name: "Player", identity: "Hero", stats: { hp: 20, attack: 5, defense: 3 } },
    currentLocationId: "loc_1" as never,
    unlockedLocationIds: ["loc_1" as never],
    visitedLocationIds: ["loc_1" as never],
    npcs: [{ npcId: "npc_1" as never, locationId: "loc_1" as never, met: true }],
    quests: [{ questId: "q_main_1" as never, status: "active" }],
    inventory: [], worldFacts: [], defeatedEnemyIds: [],
    battle: { status: "idle" },
    ending: null,
    narrative: { currentScene: null, generation: { status: "idle" }, mode: "ai" },
    eventLedger: [{ type: "game_initialized", generation: {} as never, occurredAt: "" }],
    ...overrides,
  } as unknown as GameState;
}

describe("classifyFreeDialogue", () => {
  const blueprint = buildMinimalBlueprint();
  const state = buildState();

  it("空文本/短文本 → chat", () => {
    expect(classifyFreeDialogue(blueprint, state, "npc_1" as never, "")).toBe("chat");
    expect(classifyFreeDialogue(blueprint, state, "npc_1" as never, "  ")).toBe("chat");
    expect(classifyFreeDialogue(blueprint, state, "npc_1" as never, "嗨")).toBe("chat");
  });

  it("命中任务关键词 → narrative", () => {
    expect(classifyFreeDialogue(blueprint, state, "npc_1" as never, "我想去废弃矿坑")).toBe("narrative");
  });

  it("命中地点名称 → narrative", () => {
    expect(classifyFreeDialogue(blueprint, state, "npc_1" as never, "去大石镇看看")).toBe("narrative");
  });

  it("命中 NPC 名称 → narrative", () => {
    expect(classifyFreeDialogue(blueprint, state, "npc_1" as never, "铁匠在哪里")).toBe("narrative");
  });

  it("探索意图动词 → narrative", () => {
    expect(classifyFreeDialogue(blueprint, state, "npc_1" as never, "去调查一下")).toBe("narrative");
  });

  it("闲聊内容 → chat", () => {
    expect(classifyFreeDialogue(blueprint, state, "npc_1" as never, "今天天气真好")).toBe("chat");
  });

  it("NPC 不在当前地点 → chat", () => {
    const otherState = buildState({ npcs: [{ npcId: "npc_1" as never, locationId: "loc_2" as never, met: true }] });
    expect(classifyFreeDialogue(blueprint, otherState, "npc_1" as never, "我想去废弃矿坑")).toBe("chat");
  });

  it("无 active 任务时地点关键词仍触发 narrative", () => {
    const noQuestState = buildState({ quests: [] });
    expect(classifyFreeDialogue(blueprint, noQuestState, "npc_1" as never, "废弃矿坑")).toBe("narrative");
  });
});
```

- [ ] **Step 2:** `npx vitest run src/game/gameplay/rpg/actions/classifyFreeDialogue.test.ts` → FAIL（模块不存在）
- [ ] **Step 3: 实现** `classifyFreeDialogue.ts`：

```ts
import type { GameState, NpcId, ScenarioBlueprint } from "@/game/domain";

// ---------------------------------------------------------------------------
// 纯规则 NPC 自由输入分类器（spec §4.2）。
// 零 AI、零 IO、零随机；判断在 50ms 内完成。
// 不映射到 PlayerIntent，不触发 resolveAction。
// ---------------------------------------------------------------------------

const EXPLORATION_VERBS = ["去", "找", "调查", "探索", "战斗", "查看", "搜索", "进入"];

function isShortText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length < 4 || /^[，。！？、；：""''（）\s]+$/.test(trimmed);
}

function hitQuestKeywords(text: string, blueprint: ScenarioBlueprint, state: GameState): boolean {
  const activeQuestIds = new Set(
    state.quests.filter((q) => q.status === "active").map((q) => String(q.questId))
  );
  return blueprint.quests.some((quest) => {
    if (!activeQuestIds.has(String(quest.id))) return false;
    const keywords = [quest.name, quest.description].filter(Boolean);
    return keywords.some((kw) => text.includes(kw));
  });
}

function hitBlueprintEntityNames(text: string, blueprint: ScenarioBlueprint): boolean {
  const names = [
    ...blueprint.locations.map((loc) => loc.name),
    ...blueprint.npcs.map((npc) => npc.name),
    ...blueprint.items.map((item) => item.name),
  ];
  return names.some((name) => text.includes(name));
}

function hasExplorationIntent(text: string): boolean {
  return EXPLORATION_VERBS.some((verb) => text.includes(verb));
}

export function classifyFreeDialogue(
  blueprint: ScenarioBlueprint,
  state: GameState,
  npcId: NpcId,
  playerText: string,
): "chat" | "narrative" {
  const text = playerText.trim();
  if (isShortText(text)) return "chat";

  // NPC 不在当前地点时无法触发叙事场景
  const npcState = state.npcs.find((n) => n.npcId === npcId);
  if (npcState === undefined || npcState.locationId !== state.currentLocationId) return "chat";

  if (hitQuestKeywords(text, blueprint, state)) return "narrative";
  if (hitBlueprintEntityNames(text, blueprint)) return "narrative";
  if (hasExplorationIntent(text)) return "narrative";

  return "chat";
}
```

- [ ] **Step 4:** `npx vitest run src/game/gameplay/rpg/actions/classifyFreeDialogue.test.ts` → PASS
- [ ] **Step 5:** `git commit -am "feat(gameplay): 纯规则 NPC 自由输入分类器 classifyFreeDialogue"`

---

### Task 3: gameplay — `composeNpcCasualReply` 确定性闲聊回应

**Files:**
- Create: `src/game/gameplay/rpg/actions/npcCasualReply.ts`
- Test: `src/game/gameplay/rpg/actions/npcCasualReply.test.ts`
- Modify: `src/game/gameplay/rpg/actions/index.ts`（导出新函数）

**Interfaces:**
- Consumes: `ScenarioBlueprint`、`GameState`、`NpcId`、`playerText: string`
- Produces: `string`（单句确定性回应，零 AI、零 IO）
- 组合规则（spec §5.3）：
  - NPC 不在当前地点 → 空串
  - 基底模板按 NPC `role` 选取
  - 玩家文本末尾为"？" → 追加"我也不太清楚。"
  - 玩家文本长度 < 4 → 追加"嗯？"

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { composeNpcCasualReply } from "./npcCasualReply";
import type { ScenarioBlueprint, GameState, NpcId } from "@/game/domain";

function buildMinimalState(): GameState {
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
  } as unknown as GameState;
}

describe("composeNpcCasualReply", () => {
  const blueprint = {
    npcs: [
      { id: "npc_1" as never, name: "铁匠", role: "铁匠", locationId: "loc_1" as never, knownFactIds: [] },
      { id: "npc_2" as never, name: "学者", role: "学者", locationId: "loc_1" as never, knownFactIds: [] },
      { id: "npc_3" as never, name: "卫兵", role: "卫兵", locationId: "loc_2" as never, knownFactIds: [] },
    ],
  } as unknown as ScenarioBlueprint;

  it("NPC 不在当前地点 → 空串", () => {
    const state = buildMinimalState();
    expect(composeNpcCasualReply(blueprint, state, "npc_3" as never, "你好")).toBe("");
  });

  it("铁匠角色 → 铁匠模板", () => {
    const state = buildMinimalState();
    const reply = composeNpcCasualReply(blueprint, state, "npc_1" as never, "今天天气真好");
    expect(reply).toContain("铁匠");
    expect(reply).toContain("笑了笑");
  });

  it("学者角色 → 学者模板", () => {
    const state = buildMinimalState();
    const reply = composeNpcCasualReply(blueprint, state, "npc_2" as never, "今天天气真好");
    expect(reply).toContain("学者");
    expect(reply).toContain("推了推眼镜");
  });

  it("问句末尾追加'我也不太清楚'", () => {
    const state = buildMinimalState();
    const reply = composeNpcCasualReply(blueprint, state, "npc_1" as never, "你吃饭了吗？");
    expect(reply).toContain("我也不太清楚");
  });

  it("短文本追加'嗯？'", () => {
    const state = buildMinimalState();
    const reply = composeNpcCasualReply(blueprint, state, "npc_1" as never, "嗨");
    expect(reply).toContain("嗯？");
  });
});
```

- [ ] **Step 2:** `npx vitest run src/game/gameplay/rpg/actions/npcCasualReply.test.ts` → FAIL
- [ ] **Step 3: 实现** `npcCasualReply.ts`：

```ts
import type { GameState, NpcId, ScenarioBlueprint } from "@/game/domain";

// ---------------------------------------------------------------------------
// 确定性 NPC 闲聊回应生成器（spec §5.3）。
// 纯函数、零 AI、零 IO、零随机；不写 state、不写 eventLedger。
// 与 composeNpcSpeech 并列，互不干扰。
// ---------------------------------------------------------------------------

const ROLE_TEMPLATES: Record<string, (name: string) => string> = {
  "铁匠": (name) => `${name}笑了笑，继续低头打铁。`,
  "学者": (name) => `${name}推了推眼镜，似乎没听清。`,
  "卫兵": (name) => `${name}握紧长矛，警惕地扫视四周。`,
  "商人": (name) => `${name}捋了捋胡须，没有回答。`,
  "村民": (name) => `${name}憨厚地笑了笑。`,
  "酒馆老板": (name) => `${name}擦了擦酒杯，继续忙活。`,
  "默认": (name) => `${name}沉吟片刻，没有接话。`,
};

function getRoleTemplate(role: string): (name: string) => string {
  return ROLE_TEMPLATES[role] ?? ROLE_TEMPLATES["默认"];
}

export function composeNpcCasualReply(
  blueprint: ScenarioBlueprint,
  state: GameState,
  npcId: NpcId,
  playerText: string,
): string {
  const npc = blueprint.npcs.find((n) => n.id === npcId);
  const npcState = state.npcs.find((n) => n.npcId === npcId);
  if (npc === undefined || npcState === undefined) return "";
  if (npcState.locationId !== state.currentLocationId) return "";

  const template = getRoleTemplate(npc.role);
  let reply = template(npc.name);

  const text = playerText.trim();
  if (text.endsWith("？") || text.endsWith("?")) {
    reply += "我也不太清楚。";
  }
  if (text.length < 4) {
    reply += "嗯？";
  }

  return reply;
}
```

- [ ] **Step 4:** `npx vitest run src/game/gameplay/rpg/actions/npcCasualReply.test.ts` → PASS
- [ ] **Step 5:** `git commit -am "feat(gameplay): 确定性 NPC 闲聊回应 composeNpcCasualReply"`

---

### Task 4: application — `performAction` 新增 `dialogue_choice` pending 排队

**Files:**
- Modify: `src/game/application/performAction.ts`（`dialogue_choice` 分支在 resolveAction 成功后按条件排队 pending）
- Test: `src/game/application/performAction.test.ts`（追加 `dialogue_choice` 触发 pending 的用例）
- Modify: 可选——`src/game/application/runtimeNarrativeEligibility.ts`（若需端点复用，确认 `canQueueRuntimeNarrativeScene` 签名兼容）

**Interfaces:**
- 行为（spec §4.1 表格）：
  - `ask_main_quest` 且 `canQueueRuntimeNarrativeScene` → 排队 pending
  - `greet` 且 `npcState.met === false` 且 `canQueueRuntimeNarrativeScene` → 排队 pending
  - 已结识 NPC（`projectDialogueChoices` 投影 `[]`，不提交 intent）→ 不排队
- 守卫（spec §4.4）：
  - `narrative.mode === "offline"` → 不排队 pending
  - 已有 pending → 拒绝（既有守卫 line 364 已覆盖）
  - `canQueueRuntimeNarrativeScene` 返回 `false` → 不排队（但 resolveAction 结果仍写入）

- [ ] **Step 1: 写失败测试**（追加到 `performAction.test.ts`）

```ts
describe("dialogue_choice 触发 pending", () => {
  it("ask_main_quest 且 canQueueRuntimeNarrativeScene → 排队 pending", async () => {
    // 构造：NPC 未结识、有 active 主线 talk_to_npc 目标
    // 断言：返回 view 中 narrativeGeneration.status === "pending"
  });
  it("greet（首次）且 canQueueRuntimeNarrativeScene → 排队 pending", async () => {
    // 断言：返回 view 中 narrativeGeneration.status === "pending"
  });
  it("greet（首次）但 canQueueRuntimeNarrativeScene 为 false → 不排队 pending", async () => {
    // 设 ending 已抵达，断言 status 不为 "pending"
  });
  it("offline 模式不排队 pending", async () => {
    // 设 narrative.mode === "offline"，断言 status 不为 "pending"
  });
});
```

- [ ] **Step 2:** `npx vitest run src/game/application/performAction.test.ts` → FAIL（pending 未实现）
- [ ] **Step 3: 实现**：在 `performAction.ts` 的 `resolveAction` 成功后（`dialogue_choice` 分支走 default 路线的 case），在 `resolveEnding` 之后、`reconcileStoryMemory` 之前，增加与 `narrative_choice` 分支相同的 pending 排队逻辑（条件：`command.intent.type === "dialogue_choice"`、`narrative.mode !== "offline"`、`deps.runtimeNarrativeSources !== undefined`、`canQueueRuntimeNarrativeScene(blueprint, nextState)`）。
- [ ] **Step 4:** `npx vitest run src/game/application/performAction.test.ts` → PASS
- [ ] **Step 5:** `git commit -am "feat(application): dialogue_choice 支持排队 pending narrative scene"`

---

### Task 5: application — 新增 `POST /api/game/npc/dialogue` 端点

**Files:**
- Create: `src/app/api/game/npc/dialogue/route.ts`
- Create: `src/app/api/game/npc/dialogue/dialogueHandler.ts`（HTTP adapter）
- Modify: `src/game/application/server/compositionRoot.ts`（注入新端口）
- Modify: `src/game/application/index.ts`（导出新类型）
- Test: `src/app/api/game/npc/dialogue/dialogueHandler.test.ts`

**Interfaces:**
- 请求体：`{ npcId: string; text: string; revision: number }`
- 响应（叙事触发）：`{ kind: "narrative_trigger"; view: GameSessionView }`
- 响应（闲聊）：`{ kind: "chat"; npcSpeech: string; view: GameSessionView }`
- 服务端处理流程（spec §5.2/5.3）：
  1. 加载当前游戏，检查 revision
  2. 检查无 pending scene（`canQueueRuntimeNarrativeScene`）
  3. `classifyFreeDialogue` → `"chat"` 或 `"narrative"`
  4. `"chat"` → `composeNpcCasualReply` → 返回闲聊回应（零 CAS 写入）
  5. `"narrative"` → 设置 pending + `playerNpcChat` → CAS 写入 → 返回叙事触发

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it, vi } from "vitest";
import { handleNpcDialogueRequest } from "./dialogueHandler";

describe("POST /api/game/npc/dialogue", () => {
  it("闲聊输入 → 返回 chat 响应（零 CAS 写入）", async () => { /* ... */ });
  it("叙事触发输入 → 返回 narrative_trigger 响应（pending）", async () => { /* ... */ });
  it("已有 pending → 拒绝", async () => { /* ... */ });
  it("stale revision → 409", async () => { /* ... */ });
  it("非法字段 → 400", async () => { /* ... */ });
});
```

- [ ] **Step 2:** `npx vitest run src/app/api/game/npc/dialogue/dialogueHandler.test.ts` → FAIL
- [ ] **Step 3: 实现**：`dialogueHandler.ts` 实现 `handleNpcDialogueRequest`，编排 `repository.getCurrentGame` → `classifyFreeDialogue` → `composeNpcCasualReply` / 设置 pending → `repository.applyResolvedAction` → 投影 view。`route.ts` 调用 handler。
- [ ] **Step 4:** `npx vitest run src/app/api/game/npc/dialogue/` → PASS
- [ ] **Step 5:** `git commit -am "feat(api): POST /api/game/npc/dialogue 端点"`

---

### Task 6: application — `DirectorContext` 注入 `playerNpcChat`

**Files:**
- Modify: `src/game/application/runtimeNarrativeContexts.ts`（`DirectorContext` 增 `playerNpcChat` 可选字段；`toDirectorContext` 参数扩展接受 `playerNpcChat`）
- Test: `src/game/application/runtimeNarrativeContexts.test.ts`（追加）
- Modify: `src/game/application/orchestrateNarrativeScene.ts`（传递 `playerNpcChat`）
- Modify: `src/game/application/generatePendingNarrativeScene.ts`（读取 `playerNpcChat` 传入编排器）

**Interfaces:**
- `DirectorContext` 新增 `readonly playerNpcChat?: PlayerNpcChatState`
- `toDirectorContext` 入参扩展 `{ readonly blueprint: ScenarioBlueprint; readonly state: GameState; readonly playerNpcChat?: PlayerNpcChatState }`
- `orchestrateNarrativeScene` 入参扩展 `readonly playerNpcChat?: PlayerNpcChatState`
- `generatePendingNarrativeScene` 从 `record.state.narrative.generation` 读取 `playerNpcChat`

- [ ] **Step 1: 写失败测试**

```ts
it("toDirectorContext 注入 playerNpcChat", () => {
  const chat = { npcId: "npc_1" as never, playerText: "我想去废弃矿坑", npcName: "铁匠", npcRole: "铁匠铺老板" };
  const context = toDirectorContext({ blueprint, state, playerNpcChat: chat });
  expect(context.playerNpcChat).toEqual(chat);
});
it("toDirectorContext 无 playerNpcChat 时缺省", () => {
  const context = toDirectorContext({ blueprint, state });
  expect(context.playerNpcChat).toBeUndefined();
});
```

- [ ] **Step 2:** `npx vitest run src/game/application/runtimeNarrativeContexts.test.ts` → FAIL
- [ ] **Step 3: 实现**：`DirectorContext` 类型追加字段；`toDirectorContext` 签名扩展；`orchestrateNarrativeScene` 转发 `playerNpcChat` 到 `toDirectorContext`；`generatePendingNarrativeScene` 从 `record.state.narrative.generation` 读取并在调用 `orchestrateNarrativeScene` 时传入。
- [ ] **Step 4:** `npx vitest run src/game/application/runtimeNarrativeContexts.test.ts` → PASS
- [ ] **Step 5:** `git commit -am "feat(application): DirectorContext 注入 playerNpcChat"`

---

### Task 7: application — `generatePendingNarrativeScene` 清除 `playerNpcChat`

**Files:**
- Modify: `src/game/application/generatePendingNarrativeScene.ts`（场景 ready 的同一 CAS 写入中清除 `playerNpcChat`）
- Test: `src/game/application/generatePendingNarrativeScene.test.ts`（追加）

**Interfaces:**
- 场景 ready 时，`narrative.generation` 设为 `{ status: "idle" }`（不含 `playerNpcChat`）
- `playerNpcChat` 不跨场景残留（spec §8 纪律 3）

- [ ] **Step 1: 写失败测试**

```ts
it("场景 ready 后清除 playerNpcChat", async () => {
  // 构造 state 含 pending + playerNpcChat
  // 执行 generatePendingNarrativeScene
  // 断言：保存后的 state.narrative.generation 不含 playerNpcChat
});
```

- [ ] **Step 2:** 运行 → FAIL（当前代码不处理清除）
- [ ] **Step 3: 实现**：`generatePendingNarrativeScene.ts` 中构建 `nextState.narrative` 时，`generation: { status: "idle" }`（不保留 `playerNpcChat`）。
- [ ] **Step 4:** 运行 → PASS
- [ ] **Step 5:** `git commit -am "fix(application): 场景 ready 时清除 playerNpcChat"`

---

### Task 8: UI — `NpcDialoguePanel` 启用自由输入框

**Files:**
- Modify: `src/components/NpcDialoguePanel.tsx`（`handleSend` 从本地确定性回应改为调用 `POST /api/game/npc/dialogue`）
- Test: `src/components/NpcDialoguePanel.test.tsx`（追加）
- Modify: 可选——`src/store/` 或调用方（添加轮询逻辑）

**Interfaces:**
- `handleSend` 调用 `POST /api/game/npc/dialogue` 而不是本地回应
- 返回 `kind: "chat"` → `setLocalReply(npcSpeech)`
- 返回 `kind: "narrative_trigger"` → 客户端进入轮询，等待场景 ready 后显示 `NarrativeScenePanel`

- [ ] **Step 1: 写失败测试**（组件测试模拟 fetch 响应）
- [ ] **Step 2:** 运行 → FAIL
- [ ] **Step 3: 实现**：`NpcDialoguePanel` 的 `handleSend` 改为异步函数，调用 fetch + 解析响应；`NpcDialoguePanelProps` 可能需要新增 `onNarrativeTrigger` 回调让父组件处理轮询/场景切换。
- [ ] **Step 4:** 运行 → PASS
- [ ] **Step 5:** `git commit -am "feat(ui): NpcDialoguePanel 自由输入调用新端点"`

---

### Task 9: 文档更新

**Files:**
- Create: `docs/agent/NPC对话驱动叙事场景触发.md`（实现事实：自由输入分类规则、闲聊回应模板、pending 排队逻辑、playerNpcChat 生命周期）
- Modify: `docs/Agent文档索引.md`（登记新文档）
- Modify: `docs/agent/当前开发阶段.md`（更新阶段状态为 Phase 12）

- [ ] **Step 1:** 新文档按 `docs/agent/` 既有文档的结构惯例撰写
- [ ] **Step 2:** 更新索引与阶段文档
- [ ] **Step 3:** `git commit -am "docs: NPC 对话触发叙事场景实现记录与索引登记"`

---

## Final Verification

- [ ] `npx vitest run` 全量 PASS
- [ ] `npx tsc --noEmit` / `npx eslint .` 零错误
- [ ] 对照 spec §10 验收标准 1~14 逐条自查（每条在上述任务测试中有对应断言）
- [ ] 分支收尾按 `superpowers:finishing-a-development-branch`；worktree 清理遵守 AGENTS.md 的 `.foundation` junction 禁令（从 main 运行 `cleanupConsumerWorktree.mjs`，禁止直接 `git worktree remove`）