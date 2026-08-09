# NPC 对话驱动叙事场景触发

## 系统定位

让 NPC 对话成为叙事场景的入口之一：首次交谈与玩家自由输入可以触发 pending + 三角色（导演/编剧/NPC 演员）场景生成流水线。对白回应不是规则行动，而是当前原子对白场景内预生成的玩家自然语言分支；分支被消费后立即显示 NPC 下一句对白，下一次选择才触发新的原子场景生成。玩家自由输入仍由服务端纯规则分类器判定叙事触发或确定性闲聊。

## 当前规则摘要

### 固定选项排队（performAction）

- 首次 `talk` 与没有预生成分支的 `narrative_choice` 共用排队条件：`narrative.mode !== "offline"`、装配了 `runtimeNarrativeSources`、且 `canQueueRuntimeNarrativeScene`（无结局、战斗非 active、合法行动 ≥2）为真时，行动成功后把 `narrative.generation` 置为 `pending`。
- 当前 scene 的 `choiceKind === "dialogue_response"` 或存在 `dialogueIntent` 时，`performAction` 只写入 `narrative_dialogue_choice`，不调用 `resolveAction`。若场景带有 `dialogueFollowups`，立即消费与所选 `dialogueIntent` 对应的预生成分支，不进入 pending；否则才把玩家回应写入下一次导演上下文并排队新的原子场景。
- 对白选项统一使用玩家口吻：「请问一下目前状况是怎么样的？」、「是否可以告诉我事情的缘由？」；服务端按选项位置归一化旧 fallback/旧存档文案。
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
- 预生成对白分支就绪后，面板显示下一原子事件的安全提示；提示只说明已存在的合法世界行动，不把“剧情事件”伪装成对白回应，也不提前改变规则状态。

## 当前实现现状

已实现（2026-08-06，Phase 14）：domain 类型扩展、纯规则分类器、固定玩家口吻选项、对白回应事件模型、场景内双分支预生成与即时消费、无分支时的 `performAction` dialogue_response 排队、`DirectorContext.playerNpcChat` 投影、场景 ready 后快照不残留回归、UI 自由输入接线。不含：自由输入意图解析 AI、闲聊记忆、NPC 关系数值。

v2.1 生产链（2026-08-09）已进一步收敛：焦点 NPC 的两个固定选项与一个自定义输入都只 POST `/api/v2/game/actions`。浏览器每次提交生成独立 UUID actionId，free_text 必须携带 text、targetNpcId 与 expectedRevision；composition root 直接调用 `performTurn` 并返回统一 view。短问候也必须完成规则裁决、单次 CAS、NPC 记忆与 pending job，不再存在 `/api/v2/game/npc/dialogue` 或 `handleNpcDialogueV2` 旁路。上文 `/api/game/npc/dialogue` 与 `handleNpcDialogue` 仅描述 v1 历史参考链。

## 主要文件

- `src/game/domain/narrative.ts` — `PlayerNpcChatState`、pending 变体可选快照
- `src/game/gameplay/rpg/actions/classifyFreeDialogue.ts` — 纯规则分类器
- `src/game/gameplay/rpg/actions/npcCasualReply.ts` — 确定性闲聊回应
- `src/game/application/performAction.ts` — 预生成对白分支即时消费、无分支时 dialogue_choice pending 排队 + 重复 greet 守卫
- `src/game/domain/narrative.ts` — 固定玩家对白文案与 `dialogueFollowups` 类型
- `src/game/application/handleNpcDialogue.ts` — 自由输入 use case 编排
- `src/game/application/runtimeNarrativeContexts.ts` — 导演 context 读取 playerNpcChat
- `src/game/application/server/compositionRoot.ts` — `handleNpcDialogue` 入口装配
- `src/app/api/game/npc/dialogue/` — HTTP adapter 薄壳（`dialogueHandler.ts` + `route.ts`）
- `src/components/NpcDialoguePanel.tsx` / `src/components/AdventureGameShell.tsx` — UI 自由输入回调链

## 主要测试

- `src/game/domain/narrative.test.ts` — 类型契约
- `src/game/gameplay/rpg/actions/classifyFreeDialogue.test.ts` / `npcCasualReply.test.ts` — 规则分类与闲聊模板
- `src/game/application/performAction.test.ts` — 对白分支即时消费、无分支 dialogue_choice 排队与重复 greet 不排队
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
- 预生成分支必须只保存脱敏的 NPC 台词与安全提示，不向客户端暴露 `actionKey`、FactId 或导演输出；分支被消费后不得递归生成更多分支。

## 最近维护

- 2026-08-09：v2.1 删除独立 NPC dialogue route/use case；固定选择与自定义输入统一经 `/api/v2/game/actions` → `performTurn`，每次浏览器 UUID 防止同 NPC 连续输入被记忆去重。
- 2026-08-08：修复「点击 NPC 无任何对白」。V2 视图链路补齐每 NPC 对白：`gameSessionViewV2` 的 `narrative` 新增 `npcDialogues`（在场 NPC 逐条 speechPages，场景 `npcDialogues` 非空分页优先，否则焦点 `npcLine` 或确定性台词兜底，纯函数零 AI）；`viewAdapterV2` 改从 `npcDialogues` 按 npcId 取对白再回退 `npcLine`；确定性/AI 场景源为所有在场 NPC 填充 `npcDialogues`，AI `npcLine.npcId` 必须归属在场 NPC 且 emotion 收敛为合法枚举（`resolveLiveNpcLine`），无效回退确定性台词。
- 2026-07-31：系统首次实现（spec/plan：`docs/superpowers/{specs,plans}/2026-07-31-npc-dialogue-narrative-trigger.md`）。
- 2026-08-06：对白场景生成时确定性预生成两个 NPC 回复；点击任一固定玩家口吻选项后同一请求直接落库下一句对白与两个新的对白选项，不再显示“正在准备场景”。下一次对白选择才进入新的三角色原子场景生成；无预生成分支的旧存档仍走 pending 兼容路径。
