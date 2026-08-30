# AI 文本审计

## 定位

AI 文本审计日志是独立于普通诊断日志的 append-only JSONL 记录，完整保存游戏运行时的 AI 调用和最终玩家可见文本；游戏 API 交换按独立模式记录，支持文本质量审核并保留必要的游戏还原证据。

生产真实游戏的验收必须检查：所有 provider `story_text.source` 均为 `generated`，`mode="ai"` 的 ready 场景不得为 `fixture`，玩家可见/API 正文不得含 `【fallback】`；调用或内容失败只能留下 `provider_failed` 与同 job 手动重试证据。`source="rule"` 只用于规则型移动、物品和战斗反馈，不计作 AI 文本，也不得包含伪造的 AI 旁白或 NPC 台词。

## 默认开关

- 默认开启：`AI_TEXT_AUDIT` 缺失、空白或非 `off` 值均按 `full` 处理。
- 只有 `AI_TEXT_AUDIT=off`（trim 后等于 `off`）才关闭 AI 文本事件；若 `GAME_API_AUDIT` 未关闭，仍可能写入 compact API 事件。
- `GAME_API_AUDIT` 独立控制 `game_api` 事件：缺失、空白或其他值为 `compact`，显式 `full` 保存完整 API body，显式 `off` 不记录 API 事件。
- 客户端不能开启或读取审计内容。

## 文件位置

- 路径恒为 `<rootDir>/<runId>/events.jsonl`。
- `rootDir` 取 `AI_TEXT_AUDIT_DIR`，缺省 `logs/ai-text-audit`。
- `runId` 取 `AI_TEXT_AUDIT_RUN_ID`，缺省由启动时间派生（ISO 时间戳中 `:` 替换为 `-`）。
- 显式 runId 必须是单一安全路径片段；空值、`.`、`..` 或含 `/`、`\` 的值改用自动 runId 并触发稳定配置告警。

## 事件类型

### ai_call

记录每次 provider transport 调用，包括重试的每次 attempt。

| 字段 | 说明 |
| --- | --- |
| `kind` | `"ai_call"` |
| `callId` | 同一逻辑调用的唯一 ID（重试共享） |
| `role` | `"intent"` / `"opening"` / `"scene"` / `"world"` / `"narrative_bundle"` |
| `attempt` | 本次重试序号 |
| `context` | `AiTextAuditContext`（见下） |
| `input.messages` | 完整 messages 数组 |
| `input.options` | 请求选项投影（timeoutMs/temperature/maxTokens/jsonMode/thinking） |
| `output` | 完整 `AiCompletionResult`（含 content/code/latencyMs/usage/finishReason） |

### game_api

记录六个 canonical API route 的请求/响应摘要或完整交换。`/api/game/current` 与 `/api/game/narrative/ensure` 属于前端轮询路由，在默认 `compact` 模式下不保存 body；创建、玩家行动、序幕确认和开发清档等业务/调试路由在 `compact` 模式仍保存完整 body。普通 ensure 轮询 body `{}` 的事件 `context.retry={origin:"normal",mechanism:"initial",attempt:0}`；仅 `{ "retry": true }` 手动重试同一 failed job 后在事件中标记 `origin="manual_failed_job"`（`compact` 不保存原始 body，只按布尔 `retry` 投影这个结构化标记）。

| 字段 | 说明 |
| --- | --- |
| `kind` | `"game_api"` |
| `detail` | `"compact"`（轮询摘要）或 `"full"`（完整交换） |
| `route` | 路由路径 |
| `method` | HTTP 方法 |
| `context` | `AiTextAuditContext`（trigger 为稳定路由触发值） |
| `request` / `response` | compact 仅含 `hasBody`；full 含 sanitized `rawBody`/`json`，异常时含稳定 `errorName` |
| `httpStatus` | HTTP 状态码 |
| `durationMs` | HTTP handler 总耗时 |

### story_text

记录场景审批后的最终玩家可见文本写回。

| 字段 | 说明 |
| --- | --- |
| `kind` | `"story_text"` |
| `context` | `AiTextAuditContext`（trigger 由动作类型派生） |
| `source` | `"generated"` / `"fixture"` / `"rule"` |
| `path` | `"normal"`（provider 场景编排写回）；prepared/rule/fixture 消费不产生新的 `story_text` provider 调用 |
| `scene` | 审批后的完整 `NarrativeSceneState` |
| `visibleText` | 投影的玩家可见文本（narration/npcLine/npcDialogues/choices） |

## 审计上下文（AiTextAuditContext）

所有事件共享的关联元数据：

| 字段 | 说明 |
| --- | --- |
| `purpose` | `opening_generation` / `intent_parsing` / `world_evolution` / `scene_performance` / `final_story_text` / `game_api` |
| `trigger` | 稳定触发值（如 `talk_choice`、`free_text_dialogue`、`create_game`、`move_action`、`battle_action`）；规则/prepared 消费不会新增 provider trigger |
| `gameId` | 游戏 ID |
| `traceId` | 请求追踪 ID |
| `jobId` | 待处理叙事任务 ID |
| `actionId` | 行动 ID |
| `turnNumber` | 回合编号 |
| `revision` | 存档 revision |
| `action` | 结构化行动摘要 |
| `retry` | 结构化重试元数据 `{origin, mechanism, attempt, reason}`（见下“context.retry”） |
| `repair` | **deprecated** 只读兼容：历史事件可能仅含此字段，新事件不再写入 |

### context.retry（重试元数据，2026-08-22）

`context.retry` 独立于顶层 `ai_call.attempt`，唯一区分四类调用来源与机制：

| 字段 | 说明 |
| --- | --- |
| `origin` | `normal`（普通产生/轮询）或 `manual_failed_job`（`{ "retry": true }` 手动恢复同一 failed job 后） |
| `mechanism` | `initial`（首次调用）/ `transport`（provider 传输超时/限流/5xx 重试）/ `content_repair`（结构化解析/审批失败的一次内容修复） |
| `attempt` | 该机制下的逻辑重试序号（`initial=0`、`content_repair=1`、`transport` 为 provider attempt 值） |
| `reason` | 稳定原因码（如 `invalid_json`、`approval_rejected:<WorldDeltaRejection>`、`network_error`） |

**`ai_call.attempt` 与内容修复 attempt 的区别**：顶层 `ai_call.attempt` 是每次真实 provider transport 调用的序号（首次为 1，传输重试为 2/…），同一个逻辑调用（共享 `callId`）的多次传输 attempt 都写同一事件系列；`context.retry.attempt` 是服务端逻辑重试分类内的序号，其中内容修复 attempt=1 表示同一 pending 回合第二次向 source 发起带修复原因的请求，两者含义不同、不可混淆。

`RpgAiClient` 负责把缺省上下文补成 `{origin:"normal",mechanism:"initial",attempt:0}`，再按 provider attempt>1 覆盖 `mechanism=transport`（保留 `origin`）；内容修复由 scene/world 源写入 `mechanism=content_repair, attempt=1`。历史 `repair` 字段只在 CLI `query`/`verify` 中做只读归一（`retry ?? repair`），仅有 `repair` 的旧事件派生为 `origin="legacy_unknown"`，绝不被臆测为 `manual_failed_job` 或 `normal`，也绝不改写 append-only JSONL。

## 五类 AI 角色

| 角色 | purpose | 说明 |
| --- | --- | --- |
| `opening` | `opening_generation` | 开局世界生成；2026-08-23 仍未迁入 narrative context compiler |
| `intent` | `intent_parsing` | 自由输入意图解析；2026-08-23 仍未迁入 narrative context compiler |
| `world` | `world_evolution` | 按需世界演化（幕推进/结局对/候选补足）；2026-08-23 起附带编译后的 `narrativeContext` manifest |
| `scene` | `scene_performance` | 每次 ready 场景表演；2026-08-23 起附带编译后的 `narrativeContext` manifest |
| `narrative_bundle` | `narrative_bundle_generation` | v7 生产生成角色；初始化 opening 分支不附 manifest，玩家决策分支由 `compileDecisionNarrativeContext` 附带无正文 manifest |

## Narrative Context Manifest（2026-08-23）

- `AiTextAuditContext.narrativeContext` 的类型是 `NarrativeContextManifest`，仅记录 `compilerVersion`、预算上限、selected/dropped token 统计，以及每个 block 的 `id/slot/sourceKind/sourceRefs/estimatedTokens`。
- 审计事件不会把 `renderNarrativeContext()` 产出的 Prompt 正文、副本化 schema 或 block `content` 存进 manifest；完整 Prompt 仍只出现在 `ai_call.input.messages` 的原始请求记录中。
- `scene`、`world` 及 `narrative_bundle` 的玩家决策分支会附带该 manifest；`opening`、`intent` 以及 `narrative_bundle` 的初始化 opening 分支仍无该字段，直到后续 Plan 明确迁移。

## 触发动作映射

| 场景类型 | trigger |
| --- | --- |
| 首场景（actionId 以 `start_` 开头） | `initial_opening` |
| 对话固定选项 | `talk_choice` |
| 对话自由输入 | `free_text_dialogue` |
| 探索 | `explore_action` |
| 调查 | `investigate_action` |
| 移动 | `move_action` |
| 拾取 | `take_item_action` |
| 给予 | `give_item_action` |
| 攻击 | `attack_action` |
| 战斗行动 | `battle_action` |
| 确认序幕 | `ack_prologue_action` |
| 自由形式 | `freeform_action` |

## 安全排除项

审计日志可以保存本游戏的完整语义文本、prompt、模型正文、玩家输入和 full 模式游戏 API body，但**不得**保存：

- API key
- Authorization
- Cookie
- 完整请求 URL

`RpgAiClient` 只从角色策略投影 `timeoutMs`/`temperature`/`maxTokens`/`jsonMode`/`thinking`，不记录 transport config、`extraBody` 原文、`AbortSignal` 或 API key。

## 关联字段

所有事件通过 `runId`/`gameId`/`traceId`/`jobId`/`turnNumber` 关联，支持完整游戏还原。后台叙事编排的 `traceId` 来自 `ensure(traceId)` 调用链。

## 查询与验证

```powershell
# 列出所有审计运行
npm run ai-text-audit -- list

# 查询事件
npm run ai-text-audit -- query --run <runId>
# 文本质量审核通常只看 AI 输入输出和最终文本
npm run ai-text-audit -- query --run <runId> --kind ai_call
npm run ai-text-audit -- query --run <runId> --kind game_api
npm run ai-text-audit -- query --run <runId> --kind story_text
npm run ai-text-audit -- query --run <runId> --game <gameId>

# 完整性检查（序列连续性、合法 JSONL、必填 context、无机密字段）
npm run ai-text-audit -- verify --run <runId>

# 导出（不修改原始文件）
npm run ai-text-audit -- export --run <runId> --out <file>
```

## 主要文件

- `src/game/application/server/ai/textAuditTypes.ts` — 审计事件契约（纯类型端口）
- `src/game/application/server/ai/textAuditRecorder.ts` — append-only JSONL 记录器
- `src/game/application/server/ai/rpgAiClient.ts` — AI 调用审计注入点
- `src/game/application/server/compositionRoot.ts` — API 交换审计与 story_text 审计装配
- `src/game/application/generatePendingScene.ts` — 历史 scene/fixture 链的 story_text 审计记录；v7 生产决策编排位于 `generatePendingNarrativeBundle.ts`
- `scripts/aiTextAudit.mjs` — CLI 查询/验证/导出工具

## 主要测试

- `npm run test:ai-text-audit`
- `npx vitest run src/game/application/server/ai/textAuditRecorder.test.ts`
- `npx vitest run src/game/application/server/compositionRoot.audit.test.ts`
