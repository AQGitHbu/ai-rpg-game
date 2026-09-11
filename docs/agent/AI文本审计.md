# AI 文本审计

## 职责

AI 文本审计是独立的 append-only JSONL，服务于 prompt/模型正文/最终文本质量审核与游戏 API 还原。它与普通诊断日志有意分开，不能把两者的隐私策略混为一谈。

## 当前契约

- 文件为 `<AI_TEXT_AUDIT_DIR>/<runId>/events.jsonl`，默认 `logs/ai-text-audit`；runId 必须是单一路径片段。
- `AI_TEXT_AUDIT` 缺省、空白或非 `off` 均为 `full`，只有显式 `off` 关闭 AI 文本事件。full 保存 `ai_call` 的完整 messages 和安全请求选项、provider completion，以及 `story_text` 的审批后场景和 visible text。
- `GAME_API_AUDIT` 独立控制 `game_api`：默认 `compact`，轮询 route 只保留是否有 body；业务 route 在 compact 下保存完整 sanitized body；`full` 保存所有 route body，`off` 不写 API 事件。
- 唯一安全排除项是 API key、Authorization、cookie 和完整 URL。审计正文不经过普通日志的递归脱敏和 128 KiB 截断，因此开启 full 前必须把目录视为敏感运行产物；客户端不能读取或开启它。
- `ai_call.role` 为 `planning`、`narration`、`character`、`choices`（分阶段叙事生产路径的四个 stage）、`disclosure_review`（新增知识对白的独立语义审核，非生成 stage），或 `intent`、`opening`、`scene`、`world`、`narrative_bundle`（旧路径，仅 fixture/审计兼容）。每条 ai_call 对应一次 provider transport attempt，逻辑请求可能有传输重试；同一请求用 `callId` 与 `context` 配对，审核请求另记且计入任务额度。
- `context.retry` 区分 `normal`/`manual_failed_job` 与 `initial`/`transport`/`content_repair`；顶层 `ai_call.attempt` 是 transport 序号，`context.retry.attempt` 是形成重试机制内的序号，两者不能混用。历史 `repair` 只由 CLI 只读归一为 `legacy_unknown`，不改写原 JSONL。
- provider 失败记录调用和稳定错误证据；`story_text.source` 只有审批后的 `generated` 才代表生产 AI 文本，`fixture` 只表示离线，`rule` 只表示规则反馈。

## 主要事件

| 事件 | 作用 |
| --- | --- |
| `ai_call` | 每次 provider transport attempt，含 role、retry context、messages、选项和 completion。 |
| `game_api` | 六个 canonical API route 的 compact/full 请求响应记录。 |
| `story_text` | 审批后最终可见文本及 source；prepared/rule/fixture 消费不产生新的 provider 调用。 |

## 文本质量审核

按同一 trace/job 对照 AI 输入、最终审批内容和玩家可见文本：检查 NPC 是否直接承接本轮话语、事实是否有来源（尤其本单元要求的观察是否写进 part 的 `facts` 且 certainty 未升级）、目标是否可执行、选项是否存在真实差异、移动/战斗是否产生了额外 provider 调用。分阶段链路须四阶段配对：planning 产出骨架后，narration/character/choices 各自的响应原文与骨架逐一比对。完成整局才能声称通关；离线 fixture、单次调用成功或日志完整不能单独证明真实叙事质量。

审核结果和运行标识放验收报告，本文不保存历次分数或测试成绩。查询与完整性校验见 [日志运维](../operations/logging.md)。

## 代码与测试入口

- 契约：`src/game/application/server/ai/textAuditTypes.ts`
- 记录：`src/game/application/server/ai/textAuditRecorder.ts`、`src/game/application/server/ai/rpgAiClient.ts`
- API/故事装配：`src/game/application/server/compositionRoot.ts`
- CLI：`scripts/aiTextAudit.mjs`
- 测试：`src/game/application/server/ai/textAuditRecorder.test.ts`、`src/game/application/server/compositionRoot.audit.test.ts`

## 条件关联阅读

修改 provider 失败和重试时读 [AI环境](./AI环境.md)；修改 prompt 上下文时读 [运行时AI导演与场景表演](./运行时AI导演与场景表演.md)；修改普通日志脱敏时读 [日志与追踪](./日志与追踪.md)。
