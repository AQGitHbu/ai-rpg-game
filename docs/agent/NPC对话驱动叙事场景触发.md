# NPC 对话驱动叙事场景触发

## 系统定位

让 NPC 对话成为叙事场景的入口之一：首次交谈、对白回应与玩家自由输入都能触发 pending + 三角色（导演/编剧/NPC 演员）场景生成流水线。对白回应不是规则行动，而是带 `dialogueIntent` 和玩家自然语言的下一轮 NPC 对话输入；玩家自由输入仍由服务端纯规则分类器判定叙事触发或确定性闲聊。

## 当前规则摘要

### 固定选项排队（performAction）

- 首次 `talk` 与 `narrative_choice` 的对白回应共用排队条件：`narrative.mode !== "offline"`、装配了 `runtimeNarrativeSources`、且 `canQueueRuntimeNarrativeScene`（无结局、战斗非 active、合法行动 ≥2）为真时，行动成功后把 `narrative.generation` 置为 `pending`。
- 当前 scene 的 `choiceKind === "dialogue_response"` 或存在 `dialogueIntent` 时，`performAction` 只写入 `narrative_dialogue_choice`，不调用 `resolveAction`，并把选项 label 作为 `playerText` 传给下一次导演/NPC 上下文。
- 防御性守卫：`greet` 只在首次结识时排队。重复 greet 判断必须用 `record.state`（`resolveAction` 之前）的 `met` 字段——`resolveAction` 对所有 `dialogue_choice` 都会设置 `met: true`。

### 自由输入分类（classifyFreeDialogue，spec §4.2）

顺序判定，全部命中失败则为 `chat`：

1. 短文本（trim 后 <4 字）或纯标点 → `chat`
2. NPC 不在玩家当前地点 → `chat`
3. 命中**激活中任务**的名称/描述关键词 → `narrative`
4. 命中蓝图实体名（地点/NPC/物品名）→ `narrative`
5. 命中探索动词（去/找/调查/探索/战斗/查看/搜索/进入）→ `narrative`

分类结果为 `narrative` 时还需通过 use case 层守卫（`mode !== "offline"` + sources 已装配 + `canQueueRuntimeNarrativeScene`），否则降级为闲聊。

### 确定性闲聊回应（composeNpcCasualReply，spec §5.3）

- 按 NPC `role` 查模板（铁匠/学者/卫兵/商人/村民/酒馆老板，未命中用默认「沉吟片刻，没有接话」）。
- 输入以问号结尾追加「我也不太清楚。」；<4 字追加「嗯？」。
- 纯函数：不写 state、不写 eventLedger、零 CAS。

### playerNpcChat 生命周期（单次消费）

- `narrative.generation` 的 `pending` 变体携带可选 `playerNpcChat` 快照：`{ npcId, playerText, npcName, npcRole }`（`src/game/domain/narrative.ts`）。对白回应与自由输入触发时写入；首次 talk 不带快照。
- `toDirectorContext` 仅在 `generation.status === "pending"` 时把快照投影给导演（`DirectorContext.playerNpcChat` 可选字段），编剧与 NPC 演员不直接接收。
- 场景 ready（或 fallback）时 `generation` 收窄为 `idle`/`ready` 变体，快照随类型自动丢弃——无需显式清除代码，由 Task 1 的类型设计保证。
- 快照绝不写入 eventLedger、不进入 storyMemory、不持久化到场景之外。

### HTTP 契约（POST /api/game/npc/dialogue，spec §6）

- 请求：`{ npcId: string, text: string, revision: number }`（白名单校验，多余字段 400）。
- 响应：200 `{ kind: "chat", npcSpeech, view }` / `{ kind: "narrative_trigger", view }` / `{ code: "ACTION_REJECTED", view, feedback }`；409 `STALE_GAME_REVISION`；404 `NO_ACTIVE_GAME`；400 校验失败；500 `CORRUPT_GAME`/内部错误；503 `INFRASTRUCTURE_FAILURE`。
- pending 期间再次提交自由输入返回 `ACTION_REJECTED`（「正在编排下一幕，请稍候。」）。

### UI 行为

- `NpcDialoguePanel` 不 fetch：自由输入经 `onFreeInput(npcId, text): Promise<FreeInputResult>` 回调提交；`chat` 结果就地显示 NPC 回应，`narrative_trigger` 不设本地回应；`freeInputBusy` 时禁用输入框与发送按钮。
- `AdventureGameShell.handleFreeDialogue` 负责 fetch 端点：闲聊只回传文本；叙事触发 `onViewChange(pending view)`，`CurrentGameScreen` 既有 `/api/game/narrative/ensure` 轮询自动接管，本系统未新增任何轮询代码。
- 错误/降级（含 ACTION_REJECTED、网络异常）兜底为闲聊回应「（对方似乎没听清。）」，绝不伪造叙事触发。

## 当前实现现状

已实现（2026-08-06，Phase 14）：domain 类型扩展、纯规则分类器、对白回应事件模型、`performAction` dialogue_response 排队、`DirectorContext.playerNpcChat` 投影、场景 ready 后快照不残留回归、UI 自由输入接线。不含：自由输入意图解析 AI、闲聊记忆、NPC 关系数值。

## 主要文件

- `src/game/domain/narrative.ts` — `PlayerNpcChatState`、pending 变体可选快照
- `src/game/gameplay/rpg/actions/classifyFreeDialogue.ts` — 纯规则分类器
- `src/game/gameplay/rpg/actions/npcCasualReply.ts` — 确定性闲聊回应
- `src/game/application/performAction.ts` — dialogue_choice pending 排队 + 重复 greet 守卫
- `src/game/application/handleNpcDialogue.ts` — 自由输入 use case 编排
- `src/game/application/runtimeNarrativeContexts.ts` — 导演 context 读取 playerNpcChat
- `src/game/application/server/compositionRoot.ts` — `handleNpcDialogue` 入口装配
- `src/app/api/game/npc/dialogue/` — HTTP adapter 薄壳（`dialogueHandler.ts` + `route.ts`）
- `src/components/NpcDialoguePanel.tsx` / `src/components/AdventureGameShell.tsx` — UI 自由输入回调链

## 主要测试

- `src/game/domain/narrative.test.ts` — 类型契约
- `src/game/gameplay/rpg/actions/classifyFreeDialogue.test.ts` / `npcCasualReply.test.ts` — 规则分类与闲聊模板
- `src/game/application/performAction.test.ts` — dialogue_choice 排队与重复 greet 不排队
- `src/game/application/handleNpcDialogue.test.ts` — chat/narrative/降级/pending 守卫/revision 冲突
- `src/app/api/game/npc/dialogue/dialogueHandler.test.ts` — 契约校验与状态码映射
- `src/game/application/runtimeNarrativeContexts.test.ts` — 导演快照投影
- `src/game/application/generatePendingNarrativeScene.test.ts` — 场景 ready 后快照单次消费
- `src/components/NpcDialoguePanel.test.tsx` / `AdventureGameShell.test.tsx` — UI 回调与端点接线

## 修改注意事项

- 分类器与闲聊回应必须保持纯函数（零 AI、零 IO、零随机）；新增分类规则先补测试。
- application 层只能经 `@/game/gameplay/rpg/actions` facade 导入 gameplay（`dependencyBoundaries.test.ts` 守护）。
- 自由输入路径不得调用 `resolveAction` 或产生规则事件；闲聊路径不得出现任何 repository 写入。
- 修改 pending 变体结构时注意：`playerNpcChat` 的丢弃依赖类型收窄，不要引入在 ready 后仍保留快照的旁路存储。
- 重复 greet 守卫必须继续基于 `resolveAction` 前的 state 判断 `met`。

## 最近维护

- 2026-07-31：系统首次实现（spec/plan：`docs/superpowers/{specs,plans}/2026-07-31-npc-dialogue-narrative-trigger.md`）。
