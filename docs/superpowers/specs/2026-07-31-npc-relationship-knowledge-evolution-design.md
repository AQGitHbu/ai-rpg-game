# Spec：NPC 关系与知识演化

> 日期：2026-07-31 ｜ 状态：draft ｜ 关联阶段：Phase 13（NPC 对话触发叙事场景之后）

> **前置依赖：** Phase 12（NPC 对话驱动叙事场景触发）必须已实现。本 spec 依赖 Phase 12 的以下交付物：
> - `classifyFreeDialogue` 纯函数（`src/game/gameplay/rpg/actions/classifyFreeDialogue.ts`）
> - `handleNpcDialogue` use case（`src/game/application/handleNpcDialogue.ts`）
> - `POST /api/game/npc/dialogue` HTTP 端点
> - `playerNpcChat` 字段与 `DirectorContext` 注入

## 1. 背景与目标

### 1.1 当前现状

Phase 11 建立了结构化剧情记忆，NPC 拥有知识边界（`knownFactIds`）和最近接触记录（`npcContacts`），但：

- NPC 对玩家没有"态度"——所有 NPC 在叙事场景中表现一致，不论玩家之前帮过还是得罪过他们
- NPC 不记住玩家对自己的具体行为——只记录"最后接触时间"，不记录"接触性质"
- 玩家与 NPC 的交互（greet/ask_main_quest）不产生任何持久化的关系影响

### 1.2 目标

1. **好感度系统**：每个 NPC 对玩家有一个持久化的关系值，随对话选择变化
2. **NPC 台词反映关系**：NPC 演员在生成台词时知道自己的关系状态，据此调整语气
3. **NPC 记住交互历史**：NPC 记得玩家对自己做过的事（帮过/害过/完成过任务）
4. **架构预留扩展**：单维度好感度的类型设计支持未来扩展为多维度

### 1.3 非目标

- 不改变任务系统（reconcileQuests 不受关系影响）
- 不改变结局条件
- 不增加新的对话选项类型（保持现有 greet/ask_main_quest/review_clue）
- 不引入 NPC 间知识传播
- 不引入 NPC 自主日程/独立行为
- 不修改蓝图结构（初始关系预设延后）
- 不新增 `eventLedger` 事件类型；`npc_met` 事件扩展 `interactionKind` 可选字段（不改变旧存档解析）
- 不改动导演/编剧上下文（关系值仅对 NPC 演员可见）

## 2. 核心设计决策

### 2.1 关系值放在运行时状态，而非 StoryMemory

- **位置**：`NpcRuntimeState.relationship`（可选，旧存档兼容）
- **理由**：关系值是权威运行时状态，需要 CAS 写入保护。StoryMemory 是只读投影，不适合作为权威数据源
- **旧存档兼容**：`relationship` 可选，缺省回退到 `{ affinity: 0 }`（中立）

### 2.2 单维度好感度，类型预留多维度

```ts
export type RelationshipValue = {
  readonly affinity: number;  // -100 ~ +100
};
```

后续扩展为多维度时，在 `RelationshipValue` 中增加字段即可：

```ts
// 未来的扩展示例（Phase 13 不做）
export type RelationshipValue = {
  readonly affinity: number;
  readonly trust: number;  // 未来添加
  readonly fear: number;   // 未来添加
};
```

### 2.3 粗粒度阈值，固定变化幅度

- 5 个档位：hostile / cold / neutral / friendly / trusted
- 每次交互变化固定幅度，不动态计算

### 2.4 关系值仅对 NPC 演员可见

维持最小权限原则：导演和编剧不需要知道关系值。NPC 演员收到关系值后据此调整台词语气。

## 3. 数据类型

### 3.1 新增文件：`src/game/domain/relationship.ts`

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

### 3.2 `NpcRuntimeState` 扩展（`src/game/domain/gameState.ts`）

```ts
export type NpcRuntimeState = {
  readonly npcId: NpcId;
  readonly locationId: LocationId;
  readonly met: boolean;
  // Phase 13：可选关系值；旧存档缺省时回退到 { affinity: 0 }（中立）
  readonly relationship?: RelationshipValue;
};
```

### 3.3 `NpcMetEvent` 扩展（`src/game/domain/events.ts`）

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

### 3.4 `NpcContinuityMemory` 扩展（`src/game/domain/storyMemory.ts`）

```ts
export type NpcContinuityMemory = {
  readonly npcId: NpcId;
  readonly lastContactTurn: number;
  readonly lastLocationId: LocationId;
  // Phase 13：可选，旧存档兼容。由 reconcileStoryMemory 从 npc_met.interactionKind 推导生成。
  // 安全文本，不含对白/事实原文/原始 ID。
  readonly lastInteractionSummary?: string;
};
```

## 4. 关系变化规则

### 4.1 触发时机

关系变化在两条路径中分别处理：

**路径一：固定选项（dialogue_choice）— `resolveAction` 中**
```
resolveAction:
  1. 处理 dialogue_choice intent
  2. 产生 npc_met 事件（含 interactionKind 字段）
  3. 计算关系变化 → 写入 nextState.npcs[].relationship
  4. 返回 ResolvedAction
```

**路径二：自由输入（free input）— `handleNpcDialogue` 中**
```
handleNpcDialogue:
  1. classifyFreeDialogue → "narrative"（触发叙事场景）
  2. classifyDialogueTone → "positive" | "neutral" | "negative"
  3. 若为 positive +3，negative -3，neutral 不变
  4. 写入 nextState.npcs[].relationship（与 playerNpcChat 同一次 CAS 写入）
  5. 排队 pending narrative scene
```

自由输入不经过 `resolveAction`，不产生 `npc_met` 事件，因此也不更新 `lastInteractionSummary`。关系变化仅通过 `classifyDialogueTone` 语气判断触发。

### 4.2 变化幅度

| 触发条件 | 变化量 | 守卫 |
|---------|--------|------|
| `greet`（首次结识） | `+5` | 仅当 `met: false → true` 时 |
| `ask_main_quest`（完成主线目标） | `+10` | 仅当该 quest 此时转为 `completed` |
| 自由输入正面语气 | `+3` | 需额外语气分析 |
| 自由输入负面语气 | `-3` | 同上 |

### 4.3 `classifyDialogueTone` 新增纯函数

Phase 12 的 `classifyFreeDialogue` 只返回 `chat | narrative`。Phase 13 新增一个独立函数判断自由输入的语气：

```ts
// src/game/gameplay/rpg/actions/classifyFreeDialogue.ts（追加）
export type DialogueTone = "positive" | "neutral" | "negative";

export function classifyDialogueTone(text: string): DialogueTone {
  // 纯规则，零 AI：中文关键词匹配
  // 正面词：谢谢、帮忙、你好、佩服、感激、请...
  // 负面词：混蛋、滚、威胁、少管闲事、闭嘴...
  // 中性：以上皆否
}
```

### 4.4 关键纪律

- 关系变化不触发 `resolveEnding`、不改变 `reconcileQuests` 结果
- 关系变化不下发到 `narrative_choice` 选项（不改变可用行动）
- `npc_met` 事件的 `interactionKind` 是可选字段，旧存档解析时缺省回退，不改变已有事件序列化/反序列化
- `classifyDialogueTone` 是纯规则函数，零 AI 调用，响应时间 < 50ms

## 5. NPC 上下文注入

### 5.1 `NpcLineContext` 扩展

`src/game/application/runtimeNarrativeContexts.ts`：

```ts
export type NpcLineContext = {
  readonly npcDefinition: Record<string, unknown>;
  readonly factCards: readonly Record<string, unknown>[];
  readonly ownContinuity: { readonly lastContactTurn: number; readonly lastLocationName: string } | null;
  readonly speechAct: string;
  readonly mayLie: boolean;
  // Phase 13：
  readonly relationshipTier: string;          // 如 "friendly"
  readonly relationshipAffinity: number;      // 如 45
  readonly relationshipSummary: string;       // 如 "你曾帮助铁匠完成了委托"
};
```

### 5.2 `toNpcLineContext` 实现变更

```ts
// 在 toNpcLineContext 中追加
const npcState = state.npcs.find((n) => String(n.npcId) === npcId);
const relationship = npcState?.relationship ?? { affinity: 0 };
const tier = relationshipTierOf(relationship);
const summary = projectRelationshipSummary(state, blueprint, npcId);

// 返回的 context 增加上述字段
```

### 5.3 NPC performer prompt 更新

`src/game/application/server/ai/liveRuntimeNarrativeSources.ts` 的 NPC instruction 末尾追加：

```
The NPC's relationship with the player is {relationshipTier} 
(affinity {relationshipAffinity}). 
{relationshipSummary}
Adjust your tone, willingness to help, and emotional expression 
according to this relationship tier.
```

### 5.4 导演/编剧上下文不受影响

- `DirectorContext` 和 `SceneScriptContext` 不新增关系字段
- 例外：`recentContinuity` 里程碑中如果包含 `npc` 条目，可显示"与 XX 的关系有所变化"的文本（只读，不传递数值）

## 6. 知识演化：交互记忆

### 6.1 `npc_met` 事件扩展

`resolveAction` 中 `dialogue_choice` 分支在生成 `npc_met` 事件时，根据 `parseDialogueChoiceKind` 的结果设置 `interactionKind`：

```ts
// 在 resolveAction.ts 的 dialogue_choice 分支中：
const kind = parseDialogueChoiceKind(intent.npcId, intent.choiceId);
const event: GameEvent = {
  type: "npc_met",
  npcId: intent.npcId,
  occurredAt,
  // Phase 13：携带交互类型供 reducer 推导摘要
  interactionKind: kind === "ask_main_quest" ? "ask_main_quest" : "greet",
};
```

### 6.2 `reconcileStoryMemory` 扩展

在 `reconcileStoryMemory` 的 `contactUpdateFromEvent` 函数中，处理 `npc_met` 时扩展 `lastInteractionSummary`：

```ts
// contactUpdateFromEvent 中 npc_met 分支：
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

### 6.3 `createEmptyStoryMemory` 更新

`createEmptyStoryMemory` 函数当前返回 `{ version, reducedThroughEventCount: 0, recent: [], npcContacts: [] }`。新增字段 `lastInteractionSummary` 是可选类型，`npcContacts: []` 空数组已经兼容，**无需额外修改**。旧存档的 `npcContacts` 条目全为 `{ npcId, lastContactTurn, lastLocationId }`，`lastInteractionSummary` 缺省为 `undefined`，`projectRelationshipSummary` 安全回退到空串。

### 6.4 `projectRelationshipSummary` 纯函数

```ts
// 新增：src/game/gameplay/rpg/actions/relationshipSummary.ts

export function projectRelationshipSummary(
  state: GameState,
  blueprint: ScenarioBlueprint,
  npcId: string,
): string {
  const contact = storyMemoryOf(state).npcContacts.find(
    (c) => String(c.npcId) === npcId,
  );
  if (contact === undefined) return "";
  return contact.lastInteractionSummary ?? "";
}
```

### 6.5 关键纪律

- `lastInteractionSummary` 是规则生成的**安全文本**，不是 AI 写的
- 不记录对白原文，不记录事实原文，只记录"交互类型"
- 旧存档缺省时回退到 `undefined`，`projectRelationshipSummary` 返回空串

## 7. 兼容性

- 旧存档：`NpcRuntimeState.relationship` 可选，缺省回退到 `{ affinity: 0 }`
- 旧存档：`NpcContinuityMemory.lastInteractionSummary` 可选，缺省回退到 `undefined`
- `GameState` 版本、`GAME_RECORD_VERSION`、`STORY_MEMORY_VERSION` 均不变
- 零迁移：新字段全部可选，旧存档读取时安全回退

## 8. 验收标准

1. 首次结识 NPC（greet）→ 该 NPC 好感度 +5，状态持久化
2. 完成指向 NPC 的主线目标（ask_main_quest）→ 好感度 +10
3. 自由输入正面语气 → 好感度 +3
4. 自由输入负面语气 → 好感度 -3
5. 好感度到达阈值 → NPC 档位变化（hostile/cold/neutral/friendly/trusted）
6. NPC 叙事场景台词随关系档位变化（NPC performer 接收到关系上下文）
7. `npc_met` 事件携带 `interactionKind` 字段（greet 或 ask_main_quest）
8. `reconcileStoryMemory` 从 `interactionKind` 派生 `lastInteractionSummary`
9. NPC 记住最近交互摘要（`lastInteractionSummary` 正确生成）
10. 旧存档加载后 NPC 关系值默认为中立，不报错
11. 关系变化不改变 `reconcileQuests` 结果（负向验收）
12. 关系变化不改变 `resolveEnding` 结果（负向验收）
13. 导演/编剧上下文不包含关系值（负向验收）
14. `classifyDialogueTone` 零 AI 调用，响应时间 < 50ms