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
  - **自动清除**：`playerNpcChat` 挂在 `pending` 变体上，场景 ready 时 `generation` 被设为 `{ status: "idle" }`（见 [generatePendingNarrativeScene.ts:87-95](file:///f:/AI2/ai-rpg-game/src/game/application/generatePendingNarrativeScene.ts#L87-L95)），`playerNpcChat` 随类型收窄自动丢弃，**无需额外清除代码**。原 Task 7 已合并为此备注。
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
    - 注：`met === false` 检查为**防御性**。正常路径下 `greet` 只在未结识时由 `projectDialogueChoices` 投影（[dialogueChoices.ts:78](file:///f:/AI2/ai-rpg-game/src/game/gameplay/rpg/actions/dialogueChoices.ts#L78)），HTTP 客户端伪造的 choiceId 也会被 [validateIntent.ts:191](file:///f:/AI2/ai-rpg-game/src/game/gameplay/rpg/actions/validateIntent.ts#L191) 复核拒绝。此守卫防止上游契约变化时误触发场景。
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
- [ ] **Step 3: 实现**：**扩展现有 pending 条件块**（[performAction.ts:380-390](file:///f:/AI2/ai-rpg-game/src/game/application/performAction.ts#L380-L390)），在 `command.intent.type === "narrative_choice"` 同一条件中增加 `"dialogue_choice"` 分支，**不要新增独立 if 块**：

```ts
// performAction.ts line 380 附近，扩展条件：
if (
  (command.intent.type === "narrative_choice" || command.intent.type === "dialogue_choice") &&
  record.state.narrative.mode !== "offline" &&
  deps.runtimeNarrativeSources !== undefined &&
  canQueueRuntimeNarrativeScene(record.blueprint, nextState)
) {
  // 对 dialogue_choice 的 greet，需额外防御性检查 npcState.met === false
  // （ask_main_quest 与 narrative_choice 不需要此检查）
  const isGreetFirstMeet =
    command.intent.type === "dialogue_choice" &&
    parseDialogueChoiceKind(command.intent.npcId, command.intent.choiceId) === "greet";
  if (isGreetFirstMeet) {
    // 使用 record.state（resolveAction 前的原始状态）做防御性检查。
    // resolveAction 对所有 dialogue_choice 都会设置 met: true，所以 nextState 始终为 true。
    const npcState = record.state.npcs.find((n) => n.npcId === command.intent.npcId);
    if (npcState === undefined || npcState.met) {
      // 已结识 greet 不排队 pending（防御性，正常路径不会到这里）
    } else {
      nextState = {
        ...nextState,
        narrative: { currentScene: null, generation: { status: "pending", requestedAt: deps.now() }, mode: "ai" },
      };
    }
  } else {
    nextState = {
      ...nextState,
      narrative: { currentScene: null, generation: { status: "pending", requestedAt: deps.now() }, mode: "ai" },
    };
  }
}
```

  - `parseDialogueChoiceKind` 从 `@/game/gameplay/rpg/actions/dialogueChoices` 导入
  - `dialogue_choice` 的 `ask_main_quest` 直接走 else 分支排队 pending
- [ ] **Step 4:** `npx vitest run src/game/application/performAction.test.ts` → PASS
- [ ] **Step 5:** `git commit -am "feat(application): dialogue_choice 支持排队 pending narrative scene"`

---

### Task 5a: application — `handleNpcDialogue` use case

**Files:**
- Create: `src/game/application/handleNpcDialogue.ts`（业务编排：classify → pending/chat）
- Modify: `src/game/application/index.ts`（导出新类型与函数）
- Test: `src/game/application/handleNpcDialogue.test.ts`

**Architecture 纪律**：现有 HTTP adapter（[actionHandler.ts](file:///f:/AI2/ai-rpg-game/src/app/api/game/actions/actionHandler.ts)）是薄壳，只做参数解析→调 use case→响应映射，**零业务逻辑**。本任务把 classify/pending/CAS 编排放进 application use case，HTTP adapter 保持薄壳。

**Interfaces:**
- 请求体（use case command）：`{ npcId: NpcId; text: string; expectedRevision: number }`
- 响应：
  - `{ kind: "chat"; npcSpeech: string; view: GameSessionView }`（零 CAS 写入）
  - `{ kind: "narrative_trigger"; view: GameSessionView }`（pending 已写入）
  - 失败：复用现有 `{ ok: false; code: "STALE_GAME_REVISION" | "ACTION_REJECTED" | ... }` 形态
- 服务端处理流程（spec §5.2/5.3）：
  1. `repository.getCurrentGame()` 加载存档，检查 revision（与 `performAction` 一致）
  2. 检查 `canQueueRuntimeNarrativeScene`：返回 false 时闲聊路径照常、叙事路径降级为闲聊（spec §4.4 合法行动<2 降级）
  3. `classifyFreeDialogue(blueprint, state, npcId, text)` → `"chat" | "narrative"`
  4. `"chat"` → `composeNpcCasualReply` → 投影 view → 返回 `{ kind: "chat", npcSpeech, view }`（**不调 `applyResolvedAction`**，零 CAS 写入）
  5. `"narrative"` → 构造 `nextState`：`narrative.generation = { status: "pending", requestedAt: now, playerNpcChat: {...} }` → `repository.applyResolvedAction` CAS 写入 → 投影 view → 返回 `{ kind: "narrative_trigger", view }`
  6. `offline` 模式：叙事路径降级为闲聊（spec §4.4/§8.6），不调 AI
  7. 已有 pending：返回 `ACTION_REJECTED`（复用现有守卫语义）

- [ ] **Step 1: 写失败测试**（`handleNpcDialogue.test.ts`，注入内存 repository 与依赖）

```ts
describe("handleNpcDialogue", () => {
  it("闲聊输入 → 返回 chat，零 CAS 写入", async () => {
    // 构造：NPC 在当前地点、met=true、active 主线
    // 断言：result.kind === "chat"；mockRepository.applyResolvedAction 未被调用
  });
  it("叙事触发输入 → 返回 narrative_trigger，CAS 写入 pending + playerNpcChat", async () => {
    // 断言：result.kind === "narrative_trigger"；applyResolvedAction 被调用一次；
    //       写入的 nextState.narrative.generation.status === "pending"；
    //       写入的 nextState.narrative.generation.playerNpcChat.playerText === 输入文本
  });
  it("已有 pending → ACTION_REJECTED", async () => { /* ... */ });
  it("stale revision → STALE_GAME_REVISION", async () => { /* ... */ });
  it("offline 模式叙事输入降级为 chat", async () => { /* ... */ });
  it("canQueueRuntimeNarrativeScene=false 时叙事输入降级为 chat", async () => { /* ... */ });
});
```

- [ ] **Step 2:** `npx vitest run src/game/application/handleNpcDialogue.test.ts` → FAIL（模块不存在）
- [ ] **Step 3: 实现** `handleNpcDialogue.ts`：导出 `HandleNpcDialogueCommand`、`HandleNpcDialogueDependencies`（`{ repository, now, runtimeNarrativeSources? }`，与 `performAction` 依赖形态一致）、`HandleNpcDialogueResult`。函数体编排上述流程；view 投影复用 `projectCurrentView`（与 `performAction` 同一投影函数）。`playerNpcChat` 的 `npcName`/`npcRole` 从 `blueprint.npcs` 查表填充。
- [ ] **Step 4:** `npx vitest run src/game/application/handleNpcDialogue.test.ts` → PASS
- [ ] **Step 5:** `git add -A && git commit -m "feat(application): handleNpcDialogue use case"`

---

### Task 5b: application/server — `ServerGameEntryPoints` 装配 + HTTP adapter

**Files:**
- Modify: `src/game/application/server/compositionRoot.ts`（`ServerGameEntryPoints` 接口新增 `handleNpcDialogue`；`createServerGameEntryPoints` 装配 `handleNpcDialogueDependencies`）
- Create: `src/app/api/game/npc/dialogue/dialogueHandler.ts`（薄壳 HTTP adapter，与 `actionHandler.ts` 同构）
- Create: `src/app/api/game/npc/dialogue/route.ts`（注入生产单例，调 handler）
- Test: `src/app/api/game/npc/dialogue/dialogueHandler.test.ts`

**Interfaces:**
- HTTP 请求体：`{ npcId: string; text: string; revision: number }`（白名单校验，拒绝未知字段，与 `actionHandler.ts` 同纪律）
- HTTP 响应（与 use case 结果对应）：
  - 200 `{ kind: "chat", npcSpeech, view }`
  - 200 `{ kind: "narrative_trigger", view }`
  - 200 `{ code: "ACTION_REJECTED", view, feedback }`
  - 409 `{ code: "STALE_GAME_REVISION", view }`
  - 404 `{ code: "NO_ACTIVE_GAME" }`
  - 400 `{ code: "MALFORMED_JSON" | "UNEXPECTED_FIELDS" | "INVALID_INTENT", detail? }`
  - 500 `{ code: "INTERNAL_ERROR" }`

- [ ] **Step 1: 写失败测试**（`dialogueHandler.test.ts`，参考 `actionHandler.test.ts` 结构：mock `entryPoints.handleNpcDialogue`，断言状态码与 body 形态）
- [ ] **Step 2:** `npx vitest run src/app/api/game/npc/dialogue/dialogueHandler.test.ts` → FAIL
- [ ] **Step 3: 实现**：
  - `compositionRoot.ts`：`ServerGameEntryPoints` 接口加 `handleNpcDialogue(command: HandleNpcDialogueCommand): Promise<HandleNpcDialogueResult>`；在 `createServerGameEntryPoints` 装配 `handleNpcDialogueDeps = { repository, now, runtimeNarrativeSources }`（复用现有 `performDeps` 的同一 `repository`/`now`/`runtimeNarrativeSources` 引用），返回 `handleNpcDialogue: (command) => handleNpcDialogue(command, handleNpcDialogueDeps)`。
  - `dialogueHandler.ts`：实现 `handleNpcDialogueRequest(request, entryPoints)`，只做 JSON 解析→白名单校验→调 `entryPoints.handleNpcDialogue`→状态码/body 映射，**零业务逻辑**。
  - `route.ts`：`POST` handler 调 `getServerGameEntryPoints()` → `handleNpcDialogueRequest`。
- [ ] **Step 4:** `npx vitest run src/app/api/game/npc/dialogue/` → PASS
- [ ] **Step 5:** `git commit -am "feat(api): POST /api/game/npc/dialogue 端点（薄壳 adapter + compositionRoot 装配）"`

---

### Task 6: application — `DirectorContext` 从 state 读取 `playerNpcChat`

**设计决策**：`playerNpcChat` 已挂在 `state.narrative.generation.playerNpcChat`（Task 1 设计，仅 pending 变体存在）。`toDirectorContext` 已接收 `state` 参数，**直接从 state 读取即可，不扩展 `toDirectorContext` 入参，不修改任何调用点**（`orchestrateNarrativeScene`、`generatePendingNarrativeScene`、既有测试均无需改动签名）。

**Files:**
- Modify: `src/game/application/runtimeNarrativeContexts.ts`（`DirectorContext` 增 `playerNpcChat` 可选字段；`toDirectorContext` 内部从 `state.narrative.generation` 读取）
- Test: `src/game/application/runtimeNarrativeContexts.test.ts`（追加）

**Interfaces:**
- `DirectorContext` 新增 `readonly playerNpcChat?: PlayerNpcChatState`
- `toDirectorContext` 签名不变：仍为 `(input: { blueprint, state }) => DirectorContext`；内部读取逻辑：

```ts
// toDirectorContext 内部：
const playerNpcChat =
  state.narrative.generation.status === "pending"
    ? state.narrative.generation.playerNpcChat
    : undefined;
```

- `orchestrateNarrativeScene`、`generatePendingNarrativeScene` **无需改动**：前者已把 `state` 透传给 `toDirectorContext`（[generatePendingNarrativeScene.ts:65-71](file:///f:/AI2/ai-rpg-game/src/game/application/generatePendingNarrativeScene.ts#L65-L71) 传入 `record.state`），后者场景 ready 时 `generation` 置 idle 自动丢弃 `playerNpcChat`（见 Task 1 自动清除备注）。

- [ ] **Step 1: 写失败测试**

```ts
it("toDirectorContext 从 pending state 读取 playerNpcChat", () => {
  const state = buildStateWithPending({
    playerNpcChat: { npcId: "npc_1" as never, playerText: "我想去废弃矿坑", npcName: "铁匠", npcRole: "铁匠铺老板" }
  });
  const context = toDirectorContext({ blueprint, state });
  expect(context.playerNpcChat?.playerText).toBe("我想去废弃矿坑");
});
it("toDirectorContext 在 idle state 下 playerNpcChat 为 undefined", () => {
  const state = buildStateWithIdle();
  const context = toDirectorContext({ blueprint, state });
  expect(context.playerNpcChat).toBeUndefined();
});
```

- [ ] **Step 2:** `npx vitest run src/game/application/runtimeNarrativeContexts.test.ts` → FAIL（字段不存在）
- [ ] **Step 3: 实现**：`DirectorContext` 类型追加 `readonly playerNpcChat?: PlayerNpcChatState`；`toDirectorContext` 内部按上述逻辑从 `state.narrative.generation` 读取。**不改函数签名，不改其他调用点。**
- [ ] **Step 4:** `npx vitest run src/game/application/runtimeNarrativeContexts.test.ts` → PASS
- [ ] **Step 5:** `git commit -am "feat(application): DirectorContext 从 state 读取 playerNpcChat"`

---

### Task 7: 回归测试 — 场景 ready 后 `playerNpcChat` 不残留

**说明**：`playerNpcChat` 的清除已由 Task 1 的类型设计自动保证（场景 ready 时 `generation` 变为 `{ status: "idle" }`，pending 变体的 `playerNpcChat` 随类型收窄丢弃，[generatePendingNarrativeScene.ts:87-95](file:///f:/AI2/ai-rpg-game/src/game/application/generatePendingNarrativeScene.ts#L87-L95) 无需改动）。本任务**仅加固回归测试**，无实现改动，防止后续重构破坏 spec §8 纪律 3 / §10 验收 11。

**Files:**
- Test: `src/game/application/generatePendingNarrativeScene.test.ts`（追加）

- [ ] **Step 1: 写回归测试**

```ts
it("场景 ready 后 state.narrative.generation 不含 playerNpcChat", async () => {
  // 构造：state 含 pending + playerNpcChat
  // mock 导演/编剧/NPC source 返回固定场景
  // 执行 generatePendingNarrativeScene
  // 断言：保存后的 state.narrative.generation.status === "idle"
  //       且 (state.narrative.generation as any).playerNpcChat === undefined
  //       且下一次 toDirectorContext(state) 返回的 playerNpcChat 为 undefined
});
```

- [ ] **Step 2:** 运行 → 应直接 PASS（实现已由 Task 1 保证）。若 FAIL，说明 Task 1 类型或既有 ready 逻辑被破坏，停止并回查。
- [ ] **Step 3:** `git commit -am "test(application): 场景 ready 后 playerNpcChat 不残留回归"`

---

### Task 8: UI — `NpcDialoguePanel` 启用自由输入框

**架构纪律**：现有 `NpcDialoguePanel` 不调 fetch——`onChoice(npcId, choiceId): void` 回调由父组件 `AdventureGameShell.handleDialogueChoice`（[AdventureGameShell.tsx:169](file:///f:/AI2/ai-rpg-game/src/components/AdventureGameShell.tsx#L169)）负责 fetch + `onViewChange(outcome.view)`。本任务沿用此惯例：**面板不调 fetch，新增 `onFreeInput` 回调由父组件实现 fetch + view 更新**。

**关键澄清（轮询无需新写）**：叙事触发路径返回的 view 中 `narrativeGeneration.status === "pending"`，父组件调用 `onViewChange(view)` 更新全局 view 后，`CurrentGameScreen` 的 `useEffect`（[CurrentGameScreen.tsx:95-120](file:///f:/AI2/ai-rpg-game/src/components/CurrentGameScreen.tsx#L95-L120)）会**自动启动 `/api/game/narrative/ensure` + `/api/game/current` 轮询**，场景 ready 后自动切到 `NarrativeScenePanel`。**本任务不写任何轮询代码，不碰 `src/store/`。**

**Files:**
- Modify: `src/components/NpcDialoguePanel.tsx`（`handleSend` 改为调 `onFreeInput` 回调；`NpcDialoguePanelProps` 新增 `onFreeInput` 与 `onFreeInputBusy`）
- Modify: `src/components/AdventureGameShell.tsx`（实现 `handleFreeDialogue`：fetch `/api/game/npc/dialogue` → 闲聊返回文本 / 叙事触发 `onViewChange`）
- Test: `src/components/NpcDialoguePanel.test.tsx`（追加）
- Test: `src/components/AdventureGameShell.test.tsx`（追加 `handleFreeDialogue` 行为）

**Interfaces:**

```ts
// NpcDialoguePanelProps 新增：
type FreeInputResult =
  | { readonly kind: "chat"; readonly npcSpeech: string }
  | { readonly kind: "narrative_trigger" };

type NpcDialoguePanelProps = {
  // 既有字段...
  /** 自由输入提交：父组件负责 fetch，返回结果决定面板行为。 */
  readonly onFreeInput: (npcId: string, text: string) => Promise<FreeInputResult>;
  /** 自由输入进行中：禁用发送按钮与固定选项。 */
  readonly freeInputBusy?: boolean;
};
```

**面板行为**：
- `handleSend` 改为 `async`：调 `await onFreeInput(dialogue.npcId, draft)`
  - 返回 `kind: "chat"` → `setLocalReply(result.npcSpeech)`，面板停留在对话面板
  - 返回 `kind: "narrative_trigger"` → 不设 `localReply`（父组件已 `onViewChange`，全局 view 变为 pending，对话 overlay 会被卸载或被 NarrativeScenePanel 覆盖）
- 发送中 `freeInputBusy` 为 true 时禁用发送按钮与输入框

**父组件 `AdventureGameShell.handleFreeDialogue`**：

```ts
async function handleFreeDialogue(npcId: string, text: string): Promise<FreeInputResult> {
  setFeedback({ phase: "submitting" });
  onBusyChange(true);
  try {
    const response = await fetch("/api/game/npc/dialogue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ npcId, text, revision: view.revision }),
    });
    const body = await response.json().catch(() => null);
    if (body?.kind === "chat") {
      setFeedback({ phase: "idle" });
      return { kind: "chat", npcSpeech: body.npcSpeech };
    }
    if (body?.kind === "narrative_trigger" && body.view) {
      setFeedback({ phase: "idle" });
      onViewChange(body.view); // 触发 CurrentGameScreen 自动轮询
      return { kind: "narrative_trigger" };
    }
    // 错误/降级：当作闲聊兜底
    setFeedback({ phase: "idle" });
    return { kind: "chat", npcSpeech: "（对方似乎没听清。）" };
  } finally {
    onBusyChange(false);
  }
}
```

- [ ] **Step 1: 写失败测试**（`NpcDialoguePanel.test.tsx`：mock `onFreeInput` 返回 `{ kind: "chat", npcSpeech: "铁匠笑了笑" }`，断言 `localReply` 显示；mock 返回 `{ kind: "narrative_trigger" }`，断言不设 `localReply`。`AdventureGameShell.test.tsx`：mock fetch 返回 narrative_trigger，断言 `onViewChange` 被调用）
- [ ] **Step 2:** 运行 → FAIL
- [ ] **Step 3: 实现**：
  - `NpcDialoguePanel.tsx`：`NpcDialoguePanelProps` 加 `onFreeInput` + `freeInputBusy`；`handleSend` 改 async 调 `onFreeInput`，按 `kind` 分支处理；删除本地确定性回应占位文案。
  - `AdventureGameShell.tsx`：新增 `handleFreeDialogue` 函数；`NpcDialoguePanel` 调用处传入 `onFreeInput={handleFreeDialogue}` 与 `freeInputBusy`。
- [ ] **Step 4:** 运行 → PASS
- [ ] **Step 5:** `git commit -am "feat(ui): NpcDialoguePanel 自由输入经 onFreeInput 回调触发端点"`

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