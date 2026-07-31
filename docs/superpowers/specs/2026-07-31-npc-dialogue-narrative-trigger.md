# Spec：NPC 对话驱动的叙事场景触发

> 日期：2026-07-31 ｜ 状态：draft ｜ 关联 Plan：（待编写）

## 1. 背景

### 当前的两条独立路径

NPC 对话（`dialogue_choice`）和叙事场景（`narrative_choice`）是两条完全独立的路径：

**NPC 对话路径：**
```
玩家点击 NPC 热点 → NpcDialoguePanel
  → 固定选项（greet / ask_main_quest）
  → resolveAction → npc_met 事件 + met: true
  → reconcileQuests → resolveEnding
  → CAS 写入（一次）
  → composeNpcSpeech 生成确定性 NPC 台词
  → 对话面板显示 NPC 回应
  → 结束，无后续叙事场景
```

**叙事场景路径：**
```
玩家在 NarrativeScenePanel 点击 2 个选项之一
  → narrative_choice intent
  → resolveAction（解析为规则行动）
  → reconcileQuests → resolveEnding
  → 设置 generation.status = "pending"
  → CAS 写入（第一次）
  → [客户端轮询 /api/game/narrative/ensure]
  → 导演 → 审批 → 编剧 → 审批 → NPC 演员 → 审批
  → 场景保存为 ready → CAS 写入（第二次）
  → 客户端看到 NarrativeScenePanel（2 个新选项）
```

### 问题

1. **NPC 对话与剧情割裂**：玩家跟 NPC 交谈后，NPC 的回应不进入叙事场景。NPC 说了什么、玩家问了什么，导演完全不知道。
2. **NPC 对话太浅**：只有 greet/ask_main_quest 两种固定选择，NPC 台词是纯函数模板，没有角色感。
3. **剧情推进渠道单一**：只有 NarrativeScenePanel 的 2 个 choiceToken 能推动剧情。NPC 对话、观察、调查都不触发叙事场景。
4. **NPC 自由输入已预留但未启用**：NpcDialoguePanel 底部已有文本输入框，但只产生本地确定性回应"自由对话尚未开放"。

## 2. 目标

1. **NPC 对话触发叙事场景**：固定选项（greet/ask_main_quest）和自由输入都能触发 narrative pending，导演/编剧/NPC 流水线生成场景。
2. **NPC 自由输入启用**：玩家在 NPC 对话面板输入自由文本，经 AI 解析后决定是否触发叙事场景，或作为闲聊回应。
3. **统一剧情推进入口**：NPC 对话成为和 `narrative_choice` 并列的剧情推进方式，走同一套 pending + 三角色流水线。
4. **玩家输入影响导演上下文**：自由输入的内容作为上下文参数传递给导演，导演在生成场景时考虑。
5. **响应时间可控**：走现有 pending 机制（< 50ms 返回 + 750ms 轮询），不阻塞玩家操作。

## 3. 非目标

- 不修改规则行动系统（resolveAction、intents、validateIntent 不变）。
- 不修改 NarrativeScenePanel（2 个固定选项机制不变）。
- 不修改 SceneActionPanel（观察/交谈/调查按钮不变）。
- 不修改战斗、移动、物品拾取等规则行动。
- 不修改蓝图扩展机制（蓝图动态化是独立阶段）。
- 不引入 streaming、SSE 或实时通信。
- 不改动 composeNpcSpeech（确定性 NPC 台词保留，但仅用于场景未就绪时的占位）。

## 4. 核心设计决策

### 4.1 NPC 对话触发叙事场景

固定选项（greet/ask_main_quest）在现有 `resolveAction` 之后，增加排队 pending narrative scene 的逻辑，与 `narrative_choice` 分支一致。

```
dialogue_choice → resolveAction（npc_met 事件）
  → reconcileQuests → resolveEnding
  → 排队 pending narrative scene（新增）
  → CAS 写入（pending）
  → [客户端轮询] → 导演/编剧/NPC 生成场景 → ready
  → 客户端显示 NarrativeScenePanel
```

场景的 2 个选项始终是当前 `projectAvailableActions()` 投影的规则行动（observe / move / take / talk / investigate 等），与 NPC 对话触发无关。

### 4.2 NPC 自由输入

NPC 对话面板底部输入框启用，提交后走新端点。

**两种结果：**

| 玩家输入 | 导演判断 | 行为 |
|---------|---------|------|
| "今天天气真好" | 无叙事意义 | NPC 闲聊回应，零 CAS 写入，即时返回 |
| "我想去废弃矿坑" | 有叙事意义 | 排队 pending narrative scene，导演收到 playerNpcChat 上下文 |

**判断标准**（由导演或轻量评估角色在生成场景时判断，非独立 AI 调用）：
- 玩家输入是否与当前主/支线任务相关
- 玩家输入是否指向已知或合理的新地点/NPC/物品
- 玩家输入是否表达了对当前场景的探索意图
- 以上皆否 → 闲聊

### 4.3 自由输入 → 导演上下文

当自由输入触发叙事场景时，`playerNpcChat` 字段作为额外上下文注入导演的 `DirectorContext`：

```ts
// DirectorContext 新增字段
readonly playerNpcChat?: {
  readonly npcId: string;
  readonly playerText: string;
  readonly npcName: string;
  readonly npcRole: string;
};
```

导演在生成 proposal 时考虑该上下文，但**不强制**采纳——导演仍独立判断剧情走向。

### 4.4 NPC 对话不偏离"最小权限"纪律

- 固定选项走 resolveAction：规则检查 `npcId` 是否在当前地点、`met` 状态等，不变。
- 自由输入不触发 resolveAction：不产生 `npc_met` 事件、不改变 `met` 状态。
- 自由输入触发场景时，NPC 的回应由导演/编剧/NPC 流水线生成，遵守现有知识边界（NPC 只看到自己的 fact cards）。

### 4.5 响应时间承诺

```
玩家点击 greet / 输入文字
  → < 50ms：resolveAction（自由输入跳过）+ pending + CAS 写入 → 返回
  → 客户端轮询 /api/game/current（750ms 间隔）
  → 10~30 秒（典型值）：导演 → 编剧 → NPC 演员 → 场景 ready
  → 客户端看到新场景
```

## 5. 数据流

### 5.1 固定选项触发场景

```
NPC 对话面板 → 玩家点击 greet
  → POST /api/game/actions → { intent: { type: "dialogue_choice", npcId, choiceId }, revision }
  → performAction：
      1. resolveAction（npc_met 事件）
      2. reconcileQuests
      3. resolveEnding
      4. 排队 pending（同 narrative_choice 分支逻辑）
      5. reconcileStoryMemory
      6. CAS 写入（pending 状态）
  → 返回 GameSessionView（narrativeGeneration.status === "pending"）
  → 客户端进入轮询

  → [轮询] generatePendingNarrativeScene → orchestrateNarrativeScene
      1. 导演生成 proposal（收到 NPC 对话上下文）
      2. 审批
      3. 编剧生成 script
      4. 审批
      5. NPC 演员生成台词
      6. 审批
      7. 组装 NarrativeSceneState
      8. CAS 写入（ready）
  → 客户端看到 NarrativeScenePanel（narration + NPC 台词 + 2 个选项）
```

### 5.2 自由输入触发场景

```
NPC 对话面板 → 玩家输入文字 → 点击发送
  → POST /api/game/npc/dialogue → { npcId, text, revision }
  → 服务端处理：
      1. 检查无 pending scene（复用 canQueueRuntimeNarrativeScene）
      2. 设置 generation.status = "pending"
      3. 在 state 中记录 playerNpcChat: { npcId, text }
      4. CAS 写入
  → 返回 GameSessionView（narrativeGeneration.status === "pending"）
  → 客户端进入轮询

  → [轮询] generatePendingNarrativeScene 读取 playerNpcChat
  → toDirectorContext 注入 playerNpcChat 到 DirectorContext
  → orchestrateNarrativeScene 正常流程（导演/编剧/NPC）
  → 场景 ready → 客户端显示 NarrativeScenePanel
```

### 5.3 自由输入闲聊（无叙事意义）

```
NPC 对话面板 → 玩家输入文字 → 点击发送
  → POST /api/game/npc/dialogue → { npcId, text, revision }
  → 服务端处理：
      1. 调 AI 轻量评估：是否有叙事意义？
      2. 无叙事意义 → 生成 NPC 闲聊回应
      3. 零 CAS 写入
  → 返回 { kind: "chat", npcSpeech: "铁匠笑了笑，继续低头打铁。" }
  → NPC 对话面板显示回应文本
  → 玩家继续对话
```

## 6. API 变更

### 6.1 新增端点：`POST /api/game/npc/dialogue`

**请求体：**
```json
{
  "npcId": "npc_1",
  "text": "我想去废弃矿坑",
  "revision": 5
}
```

**响应（触发叙事场景）：**
```json
{
  "kind": "narrative_trigger",
  "view": { /* GameSessionView with narrativeGeneration.status === "pending" */ }
}
```

**响应（闲聊）：**
```json
{
  "kind": "chat",
  "npcSpeech": "铁匠笑了笑，继续低头打铁。",
  "view": { /* GameSessionView unchanged */ }
}
```

### 6.2 现有端点 `POST /api/game/actions` 不变

`dialogue_choice` intent 的处理逻辑中，在 resolveAction 成功后增加 pending 排队（与 `narrative_choice` 分支相同）。

## 7. UI 变更

### 7.1 NpcDialoguePanel

- 固定选项按钮区域保留不变（greet / ask_main_quest / review_clue）
- 底部输入框的 `handleSend` 从本地确定性回应改为调用 `POST /api/game/npc/dialogue`
- 返回闲聊回应时显示在 `localReply` 区域
- 返回叙事触发时，客户端进入轮询，等待场景 ready 后显示 NarrativeScenePanel

### 7.2 场景就绪后 UI 流转

- 叙事触发场景 ready 后，客户端自动切换到 `NarrativeScenePanel` 显示新场景
- NarrativeScenePanel 显示 narration + NPC 台词 + 2 个规则选项
- 玩家可通过"返回地图"回到世界地图

## 8. 关键纪律

1. **自由输入不绕过规则系统**：自由输入不触发 resolveAction，不产生 `npc_met` 事件。NPC 结识状态仍由固定选项的 `dialogue_choice` 管理。
2. **自由输入不直接创建内容**：`playerNpcChat` 只是导演的上下文线索，导演独立判断是否使用。
3. **pending 守卫不变**：已有 pending 时拒绝新的 NPC 对话触发，防止并发。
4. **AI 调用失败**：自由输入 AI 调用失败时降级为闲聊回应（"NPC 似乎走神了"），不阻塞游戏。
5. **固定选项的确定性**：固定选项的 resolveAction 结果（npc_met、quest 推进）与叙事场景生成解耦——即使场景生成失败，规则结果已写入。

## 9. 兼容性

- 旧存档：新的 `playerNpcChat` 字段可选，旧存档缺少时不影响 pending 判断。
- 现有 `gameSessionView`、`NarrativeSceneView`、`NpcDialogueView` 类型不变。
- 现有 `dialogue_choice` 的 resolveAction 行为不变，仅增加 pending 排队。
- 现有 `narrative_choice` 的 pending 机制不变，自由输入复用同一套逻辑。

## 10. 验收标准

1. 点击 NPC 固定选项 greet → NPC 回应 + 排队 pending → 10~30 秒后场景 ready。
2. 自由输入有叙事意义的内容 → 触发 pending → 场景 ready 后显示在 NarrativeScenePanel。
3. 自由输入闲聊内容 → NPC 即时回应，不写状态，不触发场景。
4. 已有 pending 时拒绝新的 NPC 对话输入。
5. 自由输入 AI 调用失败 → 降级闲聊回应，不阻塞。
6. 固定选项的 resolveAction 结果（npc_met）在叙事场景生成前已持久化。
7. 场景的 2 个选项始终是当前合法的规则行动，不是 AI 编造的。