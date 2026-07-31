# Spec：NPC 对话驱动的叙事场景触发

> 日期：2026-07-31 ｜ 状态：draft ｜ 关联 Plan：`docs/superpowers/plans/2026-07-31-npc-dialogue-narrative-trigger.md`

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
- 不引入意图解析 AI 角色（自由输入不映射到 PlayerIntent，不触发 resolveAction）。
- 不改动 composeNpcSpeech（确定性 NPC 台词保留，仅用于场景未就绪时的占位与已结识 greet 回应）。
- **Phase 10 冻结设计显式解冻项**：本 spec 解冻 `docs/agent/运行时AI导演与场景表演.md` 中"不做自由输入"一项，仅限 NPC 对话面板的自由文本输入触发叙事场景；不解冻意图解析 AI、streaming、AI 图片/语音/视觉描述生成。

## 4. 核心设计决策

### 4.1 NPC 对话触发叙事场景

固定选项在现有 `resolveAction` 之后，按类型决定是否排队 pending narrative scene：

| 选项 | 触发条件 | 行为 |
|------|---------|------|
| `ask_main_quest` | 当有未满足的 active 主线 `talk_to_npc` 目标指向该 NPC 时 | resolveAction（npc_met 等）→ 排队 pending → CAS 写入 |
| `greet`（首次结识） | `npcState.met === false` | resolveAction（产生 npc_met 事件）→ 排队 pending → CAS 写入 |
| 已结识 NPC 对话面板打开 | `npcState.met === true` | 不提交 intent、不触发 resolveAction，`composeNpcSpeech` 返回确定性回应 → **不排队 pending** → 零 CAS 写入 |
| `review_clue` | 始终 | 纯客户端展开线索，不发起请求（现状不变） |

**已结识 NPC 分流理由**：已结识 NPC 的对话面板通过 `projectDialogueChoices` 投影 `[]`（无 greet/ask_main_quest 按钮），`composeNpcSpeech` 已有"又见面了，若有新的发现，随时可以来找我。"的轻量回应；强制触发 10~30 秒 pending 场景对"只是想打个招呼"过重。玩家若想推进剧情，使用自由输入（若被判定为叙事线索则触发场景）。

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

| 玩家输入 | 判断结果 | 行为 |
|---------|---------|------|
| "今天天气真好" | 无叙事线索 | NPC 闲聊回应（确定性模板），零 CAS 写入，即时返回 |
| "我想去废弃矿坑" | 有叙事线索 | 排队 pending narrative scene，导演收到 playerNpcChat 上下文 |

**判断方式：服务端确定性规则，非 AI 调用。**

服务端在 `POST /api/game/npc/dialogue` 同步执行 `classifyFreeDialogue`（纯函数，零 AI）：

1. 文本长度 < 4 或仅为标点/空白 → 闲聊
2. 命中当前 active 任务 `name`/`description` 中的关键词 → 叙事触发
3. 命中已知 blueprint `locations`/`npcs`/`items` 的 `name` 或 `displayName` → 叙事触发
4. 命中"去/找/调查/探索/战斗"等探索意图动词 + 任意名词 → 叙事触发
5. 以上皆否 → 闲聊

**误判兜底**：规则可能误判（如"今天天气真好"在天气相关剧情中应为叙事触发）。当规则判断为闲聊但玩家实际想推进剧情时，玩家可改用 `ask_main_quest` 固定选项或换一种表述。反过来，若规则误判为叙事触发，导演在生成场景时收到 `playerNpcChat` 后**独立判断**是否产生叙事内容；若导演判断无叙事意义，可生成"轻量场景"（NPC 闲聊台词 + 选项不变，无新事实/任务推进），由现有 fallback 与审批链路兜底。

**关键纪律**：判断逻辑是纯规则，不调用 AI，可在 50ms 内完成；不引入意图解析 AI 角色；不把自由输入映射到 PlayerIntent。

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
- **合法行动 < 2 时降级**：`canQueueRuntimeNarrativeScene` 返回 `false` 时（结局已到、战斗 active、合法规则行动 < 2），自由输入叙事触发路径降级为闲聊回应，不排队 pending；固定选项仍完成 resolveAction 与 reconcileQuests，但不排队 pending（与现有 `narrative_choice` 行为一致）。
- **offline 模式**：`state.narrative.mode === "offline"` 时（Phase 10 离线 fixture 局），固定选项不排队 pending（与现有 `narrative_choice` 一致，见 [performAction.ts:382](file:///f:/AI2/ai-rpg-game/src/game/application/performAction.ts#L382)）；自由输入不走 AI，`classifyFreeDialogue` 仍执行，但叙事触发路径在 offline 下降级为闲聊回应（不调导演），保证 `journey:phase10` 离线 fixture 回归不受影响。

### 4.5 响应时间承诺

```
玩家点击固定选项 / 输入文字
  → < 50ms：
      固定选项：resolveAction + reconcileQuests + resolveEnding + （条件）排队 pending + CAS 写入 → 返回
      自由输入（闲聊）：classifyFreeDialogue + composeNpcCasualReply → 返回（零 CAS 写入）
      自由输入（叙事触发）：classifyFreeDialogue + 排队 pending + CAS 写入 → 返回
  → 客户端轮询 /api/game/current（750ms 间隔，仅 pending 路径）
  → 10~30 秒（典型值，仅 pending 路径）：导演 → 编剧 → NPC 演员 → 场景 ready
  → 客户端看到新场景
```

## 5. 数据流

### 5.1 固定选项触发场景

```
NPC 对话面板 → 玩家点击 greet（首次）/ ask_main_quest
  → POST /api/game/actions → { intent: { type: "dialogue_choice", npcId, choiceId }, revision }
  → performAction：
      1. resolveAction（npc_met 事件等）
      2. reconcileQuests
      3. resolveEnding
      4. 检查是否排队 pending：
         - ask_main_quest 且 canQueueRuntimeNarrativeScene → 排队 pending
         - greet 且 npcState.met === false 且 canQueueRuntimeNarrativeScene → 排队 pending
         - 已结识 NPC（projectDialogueChoices 投影 []，不提交 intent）→ 不排队 pending（composeNpcSpeech 确定性回应）
      5. reconcileStoryMemory
      6. CAS 写入
  → 返回 GameSessionView：
      - 已结识 NPC：narrativeGeneration.status !== "pending"，NPC 回应来自 composeNpcSpeech
      - 其他：narrativeGeneration.status === "pending"，客户端进入轮询

  → [轮询] generatePendingNarrativeScene → orchestrateNarrativeScene
      1. 导演生成 proposal（收到 NPC 对话上下文）
      2. 审批
      3. 编剧生成 script
      4. 审批
      5. NPC 演员生成台词
      6. 审批
      7. 组装 NarrativeSceneState
      8. CAS 写入（ready，清除 playerNpcChat 若存在）
  → 客户端看到 NarrativeScenePanel（narration + NPC 台词 + 2 个选项）
```

### 5.2 自由输入触发场景

```
NPC 对话面板 → 玩家输入文字 → 点击发送
  → POST /api/game/npc/dialogue → { npcId, text, revision }
  → 服务端处理：
      1. 检查无 pending scene（复用 canQueueRuntimeNarrativeScene）
      2. classifyFreeDialogue(blueprint, state, npcId, text) → "narrative"
      3. 设置 generation.status = "pending"
      4. 在 state 中记录 playerNpcChat: { npcId, text, npcName, npcRole }
      5. CAS 写入
  → 返回 GameSessionView（narrativeGeneration.status === "pending"）
  → 客户端进入轮询

  → [轮询] generatePendingNarrativeScene 读取 playerNpcChat
  → toDirectorContext 注入 playerNpcChat 到 DirectorContext
  → orchestrateNarrativeScene 正常流程（导演/编剧/NPC）
  → 场景 ready → CAS 写入（ready）
     **同一 CAS 写入中清除 state.playerNpcChat（单次消费，防止污染下一轮场景）**
  → 客户端显示 NarrativeScenePanel
```

**playerNpcChat 生命周期**：
- 写入：仅自由输入叙事触发路径在排队 pending 时写入 state
- 消费：`generatePendingNarrativeScene` 读取后注入 `DirectorContext`
- 清除：场景 ready 的同一 CAS 写入中清除（设为 `undefined`）
- 不跨场景残留：下一次 `narrative_choice` 或固定选项触发的场景不会读到上一次自由输入的 `playerNpcChat`

### 5.3 自由输入闲聊（无叙事线索）

```
NPC 对话面板 → 玩家输入文字 → 点击发送
  → POST /api/game/npc/dialogue → { npcId, text, revision }
  → 服务端处理：
      1. classifyFreeDialogue(blueprint, state, npcId, text) → "chat"
      2. composeNpcCasualReply(blueprint, state, npcId, text) → 确定性闲聊回应
      3. 零 CAS 写入（不写 state、不写 eventLedger、不排队 pending）
  → 返回 { kind: "chat", npcSpeech: "<确定性回应>", view: <当前 GameSessionView 不变> }
  → NPC 对话面板显示回应文本
  → 玩家继续对话
```

**闲聊回应生成主体：`composeNpcCasualReply`（新增，纯函数）**

- 位置：`src/game/gameplay/rpg/actions/npcCasualReply.ts`（与 `npcSpeech.ts` 并列）
- 输入：`blueprint`、`state`、`npcId`、`playerText`
- 输出：单句确定性回应字符串
- 组合规则（封闭，不调 AI、不读 IO/Date/随机）：
  - NPC 不在当前地点 → 空串（与 `composeNpcSpeech` 一致）
  - 基底模板按 NPC `role` 选取（如铁匠 → "{name}笑了笑，继续低头打铁。"/ 学者 → "{name}推了推眼镜，似乎没听清。"）
  - 玩家文本末尾为"？" → 追加"我也不太清楚。"
  - 玩家文本长度 < 4 → 追加"嗯？"
- **不动 `composeNpcSpeech`**：`composeNpcSpeech` 仍用于首次/已结识 greet 的确定性占位；闲聊路径走独立函数。
- **不写状态**：闲聊路径零 CAS 写入，`eventLedger` 不记录玩家输入与 NPC 回应。

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

1. **自由输入不绕过规则系统**：自由输入不触发 resolveAction，不产生 `npc_met` 事件，不改变 `met` 状态。NPC 结识状态仍由固定选项的 `dialogue_choice` 管理。
2. **自由输入不直接创建内容**：`playerNpcChat` 只是导演的上下文线索，导演独立判断是否使用。
3. **playerNpcChat 单次消费**：场景 ready 的同一 CAS 写入中清除 `state.playerNpcChat`，不跨场景残留。下一次 `narrative_choice` 或固定选项触发的场景不会读到上一次自由输入的上下文。
4. **pending 守卫不变**：已有 pending 时拒绝新的 NPC 对话触发（固定选项与自由输入均拒绝），防止并发。
5. **合法行动 < 2 降级**：`canQueueRuntimeNarrativeScene` 返回 `false` 时，NPC 对话触发路径不排队 pending；自由输入降级为闲聊回应，固定选项仍完成规则裁决但不排队场景。
6. **offline 模式不调 AI**：`narrative.mode === "offline"` 时，NPC 对话触发路径不排队 pending（固定选项）或降级为闲聊（自由输入），不调用导演/编剧/NPC，保证离线 fixture 回归稳定。
7. **闲聊路径零写入**：自由输入闲聊路径不写 state、不写 eventLedger、不排队 pending，仅返回确定性回应字符串。
8. **AI 调用失败**：自由输入叙事触发路径的 AI 调用失败时降级为闲聊回应（"NPC 似乎走神了"），不阻塞游戏。
9. **固定选项的确定性**：固定选项的 resolveAction 结果（npc_met、quest 推进）与叙事场景生成解耦——即使场景生成失败，规则结果已写入。
10. **闲聊判断不调 AI**：`classifyFreeDialogue` 是纯函数，不调用 AI，可在 50ms 内完成；不引入意图解析 AI 角色。

## 9. 兼容性

- 旧存档：新的 `playerNpcChat` 字段可选，旧存档缺少时不影响 pending 判断。
- 现有 `gameSessionView`、`NarrativeSceneView`、`NpcDialogueView` 类型不变。
- 现有 `dialogue_choice` 的 resolveAction 行为不变，仅增加 pending 排队。
- 现有 `narrative_choice` 的 pending 机制不变，自由输入复用同一套逻辑。

## 10. 验收标准

1. 点击 NPC 固定选项 greet（首次结识）→ NPC 回应 + 排队 pending → 10~30 秒后场景 ready。
2. 打开已结识 NPC 的对话面板 → 显示 `composeNpcSpeech` 确定性回应，无 greet 按钮，不排队 pending，无 10~30 秒等待。
3. 点击 NPC 固定选项 ask_main_quest → 排队 pending → 10~30 秒后场景 ready。
4. 自由输入有叙事线索的内容（命中任务/地点/NPC/物品关键词或探索意图）→ 触发 pending → 场景 ready 后显示在 NarrativeScenePanel。
5. 自由输入闲聊内容（不命中叙事线索）→ NPC 即时确定性回应，不写状态，不触发场景。
6. 已有 pending 时拒绝新的 NPC 对话输入（固定选项与自由输入均拒绝）。
7. 自由输入叙事触发路径 AI 调用失败 → 降级闲聊回应，不阻塞。
8. 固定选项的 resolveAction 结果（npc_met）在叙事场景生成前已持久化。
9. 场景的 2 个选项始终是当前合法的规则行动，不是 AI 编造的。
10. **自由输入不产生 `npc_met` 事件，不改变 `met` 状态**（负向验收：对比自由输入前后 `state.npcs[].met` 与 `eventLedger` 中 `npc_met` 计数）。
11. **playerNpcChat 单次消费**：场景 ready 后 `state.playerNpcChat` 被清除；下一次场景生成（无论触发源）的 `DirectorContext` 不包含上一次自由输入的 `playerNpcChat`。
12. **合法行动 < 2 降级**：当 `projectAvailableActions` 返回 < 2 个行动时，自由输入叙事触发路径降级为闲聊回应，不排队 pending。
13. **offline 模式**：`narrative.mode === "offline"` 时，NPC 对话触发不排队 pending，不调用 AI；`journey:phase10` 离线 fixture 回归通过。
14. **闲聊判断不调 AI**：`classifyFreeDialogue` 执行期间无 AI provider 调用，响应时间 < 50ms。