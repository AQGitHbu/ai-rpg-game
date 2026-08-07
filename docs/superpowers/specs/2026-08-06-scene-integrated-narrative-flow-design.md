# 场景一体化叙事循环设计 Spec

> 日期：2026-08-06
> 状态：设计已确认，待实现
> 修改仓库：仅 `ai-rpg-game`（`sharedInfrastructureChangeAllowed: false`，零 foundation 改动）
> 前置分支：`.worktrees/phase14-progressive-generation`（`feat/phase14-progressive-generation`）

## 背景与动机

Phase 14 已实现渐进式生成与剧情推演的核心机制（序幕、预生成对话分支、事件类型分类、多 NPC 对白、生成期间 UI 保留等），但仍存在以下问题：

1. **"剧情事件"弹层仍然存在**：当叙事场景的事件类型不是对话（investigate / item / battle / travel / observe）时，`AdventureGameShell` 仍以 `AdventureOverlay` 标题"剧情事件"弹出 `NarrativeScenePanel`。这个独立弹层割裂了场景探索体验，是不必要的 UI 中介。

2. **预生成对话流不自动续接**：`performAction.ts` 第 477 行 `shouldQueue` 包含 `!dialogueFollowupConsumed` 条件，导致玩家消费预生成 followup 后不会自动排队下一幕生成。循环断裂，玩家必须手动再点击 NPC 才能继续。

3. **生成状态投影不准确**：`projectNarrativeGenerationView` 在 `currentScene` 非空时返回 `"ready"`，即使 `generation.status === "pending"`。这导致 followup 播放期间客户端不轮询，下一幕永远无法就绪。

## 设计目标

- 完全移除"剧情事件"弹层，非对话事件按权重分级在场景内呈现
- 预生成对话流自动续接：followup 播放同时后台生成下一幕
- 生成状态投影反映真实 pending 状态，不受 currentScene 存在与否影响
- 保持预生成内容的零等待播放体验
- 向后兼容旧存档和 offline 模式

## 设计决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 非对话事件表现 | 分级：轻量事件场景内旁白条 + 重大事件全屏黑底白字 | 按叙事权重区分，与已有视觉语言一致 |
| followup 播放期间生成下一幕 | 是，后台 pending | 实现无缝循环 |
| followup 播放期间显示模态 | 否，对话面板内显示"准备中"提示 | 不阻塞阅读 |
| NarrativeScenePanel | 废弃主流程使用，保留文件 | 避免破坏现有测试 |
| choices 类型 | 改为可空（`readonly [...] | null`） | 视图侧需表达"无可展示选项"（followup 播放中被"准备中"替换、非对话事件无对白选项；domain 仍为固定二元组） |

## 架构概览

### 整体流程

```
填表单 → PrologueScreen（黑底白字序幕，已实现）
  → AdventureGameShell 启动（地图，已实现）
  → 进入地点 → LocationSceneScreen（场景常驻，已实现）

  【叙事循环】
  ├─ 对话事件 → NpcDialoguePanel 弹层（已实现）
  │   ├─ 2 个固定选项（choiceToken，已有预生成 followup）
  │   ├─ 1 个自定义输入框
  │   ├─ 选 dialogue_response → 预生成内容即时播放（已实现）
  │   │   → 自动排队下一幕（新增：移除 !dialogueFollowupConsumed）
  │   │   → 对话面板显示"正在准备下一幕…"（新增）
  │   │   → 生成完成 → 新选项到达 → 循环
  │   ├─ 选 world_action → 执行规则行动（已实现）
  │   │   → 旁白展示（场景内旁白条 / 全屏，新增）
  │   │   → NarrativeGenerationModal → 新场景 → 循环
  │   └─ 自定义输入 → AI 即时生成（已实现）
  │       → NarrativeGenerationModal → 新对话 → 循环
  │
  ├─ 轻量事件（observe/investigate/take_item）
  │   → 场景旁白条显示 AI 旁白（新增：SceneNarrationBar）
  │   → 热点即时更新，不阻塞探索
  │
  ├─ 重大事件（travel）
  │   → 全屏黑底白字旁白（新增：TravelNarrationScreen）
  │   → 点击后进入新场景
  │
  └─ 战斗事件 → BattlePanel（已实现，不变）
```

### 不变的部分

- `PrologueScreen`（黑底白字序幕）保持不变
- `NarrativeGenerationModal`（生成期间模态）保持不变，但显示条件调整
- `NpcDialoguePanel` 的基本结构保持不变（立绘+对白+选项+自由输入）
- 地图→小镇→场景三层导航保持不变
- 服务端三角色（导演/编剧/NPC演员）生成流水线保持不变
- 预生成的 domain 类型（`dialogueFollowups`、`NarrativeDialogueFollowupState`）保持不变
- `performAction` 中 `dialogue_response` 的即时消费逻辑保持不变

## 详细设计

### 1. 非对话事件分级表现

#### 1.1 轻量事件（observe / investigate / take_item）

新增 `SceneNarrationBar` 组件，集成到 `LocationSceneScreen`：

- **触发条件**：`view.narrative !== null` 且 `view.narrative.eventKind` 为 `observe` / `investigate` / `item`
- **位置**：场景描述（`location-scene-caption`）下方，热点层上方
- **内容**：显示 `view.narrative.narration`（AI 生成的旁白文本）
- **动画**：淡入
- **交互**：旁白条显示期间场景热点仍可点击（不阻塞探索）
- **互动可用性（需配套调整）**：当前 `locationAdventureView.ts` 的 `atomicEventActive = currentScene !== null || generation pending` 会把 `locationScene.interactions` 置空，导致轻量事件场景下热点层为空、与"热点仍可点击"矛盾。本阶段需放宽该抑制：仅当 `generation.status === "pending"`（无可读场景）或当前场景为 `travel` / `battle`（全屏/战斗呈现）时置空 `interactions`；`observe` / `investigate` / `item` 等轻量事件场景保留 `interactions`（dialogue 场景由对话弹层覆盖，保留互动不影响画面）。
- **关闭**：手动点击关闭按钮
- **视觉**：半透明深色背景 + 米色文字（与整体主题一致）

#### 1.2 重大事件（travel）

新增 `TravelNarrationScreen` 组件：

- **触发条件**：`view.narrative !== null` 且 `view.narrative.eventKind` 为 `travel`
- **表现**：全屏黑底白字，逐字淡入（复用 `PrologueScreen` 的视觉风格）
- **交互**：点击/按键后进入新场景的 `LocationSceneScreen`
- **不显示选项**（旅行是单向的）

#### 1.3 战斗事件

保持现有 `BattlePanel` 不变。当 `narrative_choice` 中的 `world_action` 选项触发 `start_battle` 时，进入战斗面板。

### 2. 预生成对话流自动续接

#### 2.1 移除 `!dialogueFollowupConsumed` 限制

`performAction.ts` 第 477 行：

```typescript
// 修改前
const shouldQueue = intent.type !== "ack_prologue" && !isRepeatTalk && !dialogueFollowupConsumed;

// 修改后
const shouldQueue = intent.type !== "ack_prologue" && !isRepeatTalk;
```

#### 2.2 保留 followup 场景作为桥接内容

排队 pending 时，如果 `dialogueFollowupConsumed` 为 true，不清除 `currentScene`：

```typescript
if (shouldQueue) {
  nextState = {
    ...nextState,
    narrative: {
      currentScene: dialogueFollowupConsumed
        ? nextState.narrative.currentScene  // 保留 followup 供玩家阅读
        : null,                              // 非 followup 路径照旧清除
      generation: {
        status: "pending",
        requestedAt: deps.now(),
        triggerContext: dialogueResponse?.triggerContext ?? narrativeChoiceTriggerContext ?? ...,
        playerNpcChat: dialogueResponse?.playerNpcChat,
      }
    }
  };
}
```

#### 2.3 调整生成状态投影

`gameSessionView.ts` — `projectNarrativeGenerationView`：

```typescript
// 修改前：currentScene 非空时返回 "ready"
function projectNarrativeGenerationView(state: GameState): NarrativeGenerationView {
  return {
    status: state.narrative.currentScene !== null
      ? "ready"
      : state.narrative.generation.status === "pending" ? "pending" : "ready",
  };
}

// 修改后：generation pending 时返回 "pending"，不论 currentScene
function projectNarrativeGenerationView(state: GameState): NarrativeGenerationView {
  return {
    status: state.narrative.generation.status === "pending" ? "pending" : "ready",
  };
}
```

#### 2.4 调整模态显示条件

`AdventureGameShell.tsx`：

```typescript
// 修改前
{narrativePending && view.battle === null && view.ending === null ? (
  <NarrativeGenerationModal ... />
) : null}

// 修改后：仅在有 narrative 内容可读时不显示模态
{narrativePending && view.narrative === null && view.battle === null && view.ending === null ? (
  <NarrativeGenerationModal ... />
) : null}
```

#### 2.5 对话面板"准备中"指示

`NpcDialoguePanel` — 当 `preparingNextScene` 为 true 时，底部选项区替换为"正在准备下一幕…"提示：

```typescript
// NpcDialogueView 新增字段
export type NpcDialogueView = {
  // ... 现有字段
  readonly preparingNextScene: boolean;
};

// NpcDialoguePanel 渲染
{dialogue.preparingNextScene ? (
  <p className="npc-dialogue-preparing" role="status" aria-live="polite">
    正在准备下一幕…
  </p>
) : (
  <div className="npc-dialogue-choices">
    {dialogue.choices.map(...)}
  </div>
)}
```

`locationAdventureView.ts` — `preparingNextScene` 投影：

```typescript
// preparingNextScene 为 true 时：followup 内容正在播放，下一幕在后台生成中。
// 此时选项区替换为"正在准备下一幕…"提示，不展示 followup 场景的 choices。
preparingNextScene: !readOnly
  && scene !== null
  && scene.event?.kind === "dialogue"
  && generationStatus === "pending",
```

其中 `generationStatus` 从 `NarrativeRuntimeState.generation.status` 读取（而非从 `NpcDialogueView` 内部推导），确保 followup 播放期间投影准确。

### 3. 删除"剧情事件"弹层

`AdventureGameShell.tsx` 中删除以下代码：

- `atomicWorldEventReady` 变量
- `narrativeEventKey` 变量
- `dismissedNarrativeEvent` 状态
- `showNarrativeEvent` 变量
- `activeDialogue` 的 `!atomicWorldEventReady` 条件改写为：`const activeDialogue = (narrativePending && view.narrative === null) || (view.narrative !== null && view.narrative.eventKind !== "dialogue") ? null : selectedDialogue;`。**注意不能简化为 `narrativePending ? null : selectedDialogue`**：followup 播放期间 `generation.status === "pending"`（移除 `!dialogueFollowupConsumed` 后），但 `currentScene` 仍保留 followup 场景（kind=dialogue），此时必须保持对话面板打开以展示"正在准备下一幕…"；只有「pending 且无可读场景」或「当前为非对话事件（由 SceneNarrationBar / TravelNarrationScreen 呈现）」时才关闭。
- `showNarrativeEvent && view.narrative !== null` 的 `AdventureOverlay` + `NarrativeScenePanel` 整段 JSX

### 4. NarrativeSceneView 和 choices 类型调整

#### 4.1 NarrativeSceneView 保留已存在的 eventKind 投影

`eventKind` 已在 `gameSessionView.ts` 的 `NarrativeSceneView` 中定义并投影（`gameSessionView.ts:113` / `:371`，已被 `AdventureGameShell.atomicWorldEventReady` 消费），本阶段直接保留、无需新增。调整后的类型如下（已合并 4.2 的 choices 可空，并保留现有 `nextEventHint`、`npcDialogues` 字段；`NarrativeSceneState.choices` 仍为固定二元组，仅视图侧可空）：

```typescript
export type NarrativeSceneView = {
  readonly narration: string;
  readonly npcLine: { readonly text: string; readonly emotion: string } | null;
  readonly nextEventHint?: string;
  readonly choices: readonly { readonly label: string; readonly choiceToken: string }[] | null;
  readonly eventKind?: NarrativeEventKind;  // 已存在，保留
  readonly npcDialogues: readonly {
    readonly npcId: string;
    readonly npcName: string;
    readonly npcRole: string;
    readonly speechPages: readonly string[];
  }[];
} | null;
```

#### 4.2 choices 改为可空

现状核实：followup 场景由 `createPreGeneratedDialogueScene`（`performAction.ts:593-607`）**恒**生成 2 个 `dialogue_response` 选项，并非"可能没有选项"。但新设计中 followup 的选项区被 `preparingNextScene` 的"正在准备下一幕…"替换，非对话事件（如 `travel`）无可展示的对白选项，故 `NarrativeSceneView.choices` 需可空以表达"无可展示选项"：

- `NarrativeSceneView.choices` 从 `readonly [Choice, Choice]` 改为 `readonly Choice[] | null`（domain 的 `NarrativeSceneState.choices` 保持固定二元组不变，仅视图侧可空）。
- 投影侧必须同时处理空值（否则崩溃）：`projectNarrativeSceneView`（`gameSessionView.ts:377`）当前直接 `scene.choices.map(...)`，需在 `scene.choices === null` 时输出 `choices: null`；`NpcDialogueView.choices` 在 `choices === null` 时返回空数组（`locationAdventureView.ts` 现有 `scene?.choices ?? []` 已天然空值安全）。

## 组件变更汇总

### 新增

| 组件 | 文件 | 用途 |
|------|------|------|
| `SceneNarrationBar` | `src/components/SceneNarrationBar.tsx` | 轻量事件旁白条 |
| `TravelNarrationScreen` | `src/components/TravelNarrationScreen.tsx` | 旅行事件全屏旁白 |

### 修改

| 组件/文件 | 变更 |
|-----------|------|
| `AdventureGameShell.tsx` | 删除"剧情事件"弹层逻辑；调整 `NarrativeGenerationModal` 条件；旅行事件渲染 `TravelNarrationScreen` |
| `LocationSceneScreen.tsx` | 集成 `SceneNarrationBar` |
| `NpcDialoguePanel.tsx` | `preparingNextScene` 时显示"准备中"提示 |
| `CurrentGameScreen.tsx` | 无需修改（轮询条件已由 `narrativeGeneration.status` 驱动） |
| `gameSessionView.ts` | `projectNarrativeGenerationView` 调整；`projectNarrativeSceneView` 投影 `eventKind` 和可空 `choices` |
| `locationAdventureView.ts` | `NpcDialogueView` 新增 `preparingNextScene` 字段；放宽 `atomicEventActive` 对 `locationScene.interactions` 的抑制（轻量事件场景保留互动，见 §1.1） |
| `performAction.ts` | `shouldQueue` 移除 `!dialogueFollowupConsumed`；保留 followup `currentScene` |

### 废弃

| 组件 | 处理 |
|------|------|
| `NarrativeScenePanel` | 不再在主流程中使用，保留文件和测试 |

## 边界情况与错误处理

### 预生成内容不可用

`scene.dialogueFollowups` 为 `undefined`（旧存档 / AI 未生成）时，`followupScene` 为 `null`，`dialogueFollowupConsumed` 为 `false`。代码回退到 `world_action` 路径：清除 `currentScene`，排队 pending，显示 `NarrativeGenerationModal`。玩家仍能正常推进。

### followup 播放期间 AI 生成失败

`NarrativeGenerationModal` 的 `unavailable` 机制处理持续失败。followup 内容仍可阅读。玩家刷新页面后可恢复。

### 玩家关闭对话面板时 pending 仍在进行

`dialogueNpcId` 清除，面板关闭。后台生成继续。生成完成后 `currentScene` 更新。玩家再次点击 NPC 时新对话内容已就绪。不强制玩家等待。

### Offline 模式

offline 模式的 fallback 蓝图不生成 `dialogueFollowups`。`choices` 不含 `choiceKind: "dialogue_response"`。所有选项走 `world_action` 路径，现有确定性流程不受影响。

### 旧存档兼容

- `NarrativeSceneView.eventKind` 为可选字段，缺失时不触发旁白条/旅行画面
- `dialogueFollowups` 缺失时走回退路径
- `projectNarrativeGenerationView` 的修改是向后兼容的
- 无需存档迁移

## 不在本次范围内

- AI 生图 / 语音 / streaming
- 战斗系统重制
- NPC 关系数值可视化
- 蓝图动态扩展的新闸门类型
- 共享 foundation 修改
- `NarrativeScenePanel` 组件的物理删除（保留以避免破坏测试）
