# AI 文本审计

## 职责

AI 文本审计是独立的 append-only JSONL，服务于 prompt/模型正文/最终文本质量审核与游戏 API 还原。它与普通诊断日志有意分开，不能把两者的隐私策略混为一谈。

## 当前契约

- 文件为 `<AI_TEXT_AUDIT_DIR>/<runId>/events.jsonl`，默认 `logs/ai-text-audit`；runId 必须是单一路径片段。
- `AI_TEXT_AUDIT` 缺省、空白或非 `off` 均为 `full`，只有显式 `off` 关闭 AI 文本事件。full 保存 `ai_call` 的完整 messages 和安全请求选项、provider completion，以及 `story_text` 的审批后场景和 visible text。
- `GAME_API_AUDIT` 独立控制 `game_api`：默认 `compact`，轮询 route 只保留是否有 body；业务 route 在 compact 下保存完整 sanitized body；`full` 保存所有 route body，`off` 不写 API 事件。
- 唯一安全排除项是 API key、Authorization、cookie 和完整 URL。审计正文不经过普通日志的递归脱敏和 128 KiB 截断，因此开启 full 前必须把目录视为敏感运行产物；客户端不能读取或开启它。
- `ai_call.role` 为 `intent`、`opening`、`scene`、`world` 或 `narrative_bundle`。生产 decision path 的 bundle manifest 只含 compiler version、预算、block 元数据和裁剪统计，不含 prompt 正文副本。
- `context.retry` 区分 `normal`/`manual_failed_job` 与 `initial`/`transport`/`content_repair`；顶层 `ai_call.attempt` 是 transport 序号。历史 `repair` 只由 CLI 只读归一为 `legacy_unknown`，不改写原 JSONL。
- provider 失败记录调用和稳定错误证据；`story_text.source` 只有审批后的 `generated` 才代表生产 AI 文本，`fixture` 只表示离线，`rule` 只表示规则反馈。
- 摘要选择使用既有 `narrative_bundle` role，purpose 为 `narrative_memory_summary`，trigger 区分 `memory_summary_batch` 与 `memory_summary_overview`；selection 只能引用该次权限投影内的 History/Event ID。full 审计保存实际发送的来源原文与事件 payload，不能把选编结果伪装成新的 `story_text`。
- `ai_call.context.memory` 保存 observerId、sourceFingerprint，以及按请求提供的 preparedHash、coveredThroughSequence、historyIds、eventIds、rawCount、recallCount。摘要请求记录自身 observer 和输入来源；作者与 reviewer 记录固定 player 包；NPC 判断记录对应 NPC 的水位与引用，并保留共同固定包 hash。元数据仅含标识和统计，私密原文仍只在该 NPC 请求的 full messages 内，不复制到作者 messages 或普通诊断日志。
- 准备失败或输入超限可能在任何 HTTP 之前结束，此时没有对应 `ai_call` 不能解释为 provider 成功。结合正式 job 的稳定失败原因、固定包/预算状态和旅程执行产物判断；审计字段不代替真实 SQLite 来源校验。真实 API、离线 transport 和严格零网络 replay 的性质由各自登记协议与磁带区分，不能仅凭场景的 generated 标记宣称实机验收。

## 主要事件

| 事件 | 作用 |
| --- | --- |
| `ai_call` | 每次 provider transport attempt，含 role、retry context、messages、选项和 completion。 |
| `game_api` | 六个 canonical API route 的 compact/full 请求响应记录。 |
| `story_text` | 审批后最终可见文本及 source；prepared/rule/fixture 消费不产生新的 provider 调用。 |

## 文本质量审核

按同一 trace/job 对照 AI 输入、最终审批内容和玩家可见文本：检查 NPC 是否直接承接本轮话语、事实是否有来源、目标是否可执行、选项是否存在真实差异、移动/战斗是否产生了额外 provider 调用。完成整局才能声称通关；离线 fixture、单次调用成功或日志完整不能单独证明真实叙事质量。

审核结果和运行标识放验收报告，本文不保存历次分数或测试成绩。查询与完整性校验见 [日志运维](../operations/logging.md)。

## P2 终局审阅

`scripts/narrativeP2Quality.mjs` 接收固定 `narrative-p2-quality/v2` schema：顶层只能有 `schema`、`identity`、`reviewer`、`reviewedAt`、`dimensions`、`hardErrors`、`verdict`。identity 从终局 CLI 输出复制，绑定 routeAttemptId、完整协议/代码/输入/来源、实际终局状态、完整 History、全部磁带链与候选索引 hash。

dimensions 只允许 `localContinuity`、`motivation`、`causalityAndSuspense`、`visibleChoiceConsequences`、`endingClosure`；每维含整数 `score`（1–5）、非空 `reason` 与非空 `historyQuotes`。每个引文必须含 `historyId`、逐字子串 `quote`、`candidateCallId`，并解析到当前路线 player 可见 History 和该 job 最后成功作者候选的实际原文。未经历的拒绝候选不能代替故事质量证据。hardErrors 为已确认错误数组，每项含 `kind`（fact/permission/action）、`reason`、同结构的 `historyQuotes`。verdict 为 pass/fail；通过要求无硬错误、五维均分至少 4 且单维至少 3，同时实际机器结果与全部 segment 严格回放通过。

人工审阅不增加模型 judge 调用。审阅文件排他创建并绑定 manifest，失败或中断不能改写解锁 B；终局状态和产物在审阅及 B 准入时重新读取核验。操作入口见 [AI 环境](AI环境.md#运行与测试入口)。

## P2 召回诊断审阅

`scripts/narrativeP2Recall.mjs` 在开局 ready 固定第一条玩家可见 NPC History，保存全文、hash、speaker/audience、turn 与开场幕。B 在本幕登记议题完成后的第一个合法窗口检查两个不同 player preparation job 的成功发布事件、当前同批来源指纹与 oracle 水位。驱动关闭磁带、保存数据库及来源 hash、累计预算、剩余议题和唯一保留 UUID 后进入 `awaiting_ui`，不提交主线召回。最后交付前窗口仍不足时保留 `P2_MEMORY_COVERAGE_FAILED`，继续有限正式路线采集终局质量；终局后的摘要不改变此失败。

`scripts/narrativeP2Diagnostic.mjs` 的 `inspectP2UiCheckpoint` 独立核验同路径 SQLite、manifest、闭合磁带、未消费 UUID、摘要证明及原始绝对 deadline。`runP2DiagnosticArms` 仅从该停点复制 enabled/disabled 两臂，各使用独立 manifest、1 job/50 HTTP/45 分钟。配对 UUID 和按 key 固定的 domain identity/time 相同，routeAttemptId、审计 callId、实际执行时间独立记录；失败仍占用该臂，不补跑，也不计完整路线。主线等待时间持续计入 B 原 deadline。

`inspectP2DiagnosticArm` 返回来源/请求/实际提交回答和审阅 identity。固定 `narrative-p2-recall-review/v2` 顶层字段为 `schema`、`identity`、`reviewer`、`reviewedAt`、`oracleAssessment`、`motivation`、`conditions`、`permissionErrors`、`claims`。oracleAssessment 为 evaluable/sample_limitation，不允许改换 oracle。每条 claim 含 `historyId`、逐字 `quote`、`candidateCallId`、实际请求内的 `evidenceIds`、`reason`；motivation/conditions 各含 faithful/damaged/not_evaluable 的 `verdict`、`reason`、`claimHistoryIds`；permissionErrors 每项含 `reason`、`historyId`。`reviewP2DiagnosticArm` 排他保存并封存审阅，enabled 额外要求覆盖后来源进入作者请求且人工判定保真。prepared 来源种类与实际请求出现分别记录，避免把准备后被裁剪的来源算作作者可见。原话命中与长度仅是测量，不能推断内容质量；未省略 oracle 的概览不能证明“省略后仍能召回”。

真实 UI adapter、浏览器提交/刷新/剩余议题与终局接续、B 最终质量准入仍未实现；诊断通过不能解锁 B 整条路线通过。

## 代码与测试入口

- 契约：`src/game/application/server/ai/textAuditTypes.ts`
- 记录：`src/game/application/server/ai/textAuditRecorder.ts`、`src/game/application/server/ai/rpgAiClient.ts`
- API/故事装配：`src/game/application/server/compositionRoot.ts`
- CLI：`scripts/aiTextAudit.mjs`
- 测试：`src/game/application/server/ai/textAuditRecorder.test.ts`、`src/game/application/server/compositionRoot.audit.test.ts`

## 条件关联阅读

修改 provider 失败和重试时读 [AI环境](./AI环境.md)；修改 prompt 上下文时读 [运行时AI导演与场景表演](./运行时AI导演与场景表演.md)；修改普通日志脱敏时读 [日志与追踪](./日志与追踪.md)。
