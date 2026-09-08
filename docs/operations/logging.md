# RPG 日志运维手册

## 存储与边界

普通诊断日志默认写入独立 SQLite `data/logs.db`，游戏状态库默认是 `db/rpg.sqlite`。可用 `GAME_LOG_DB_PATH` 指定日志库，SQLite 不可用时写 `GAME_LOG_FALLBACK_DIR`（默认 `logs/`）下的 JSONL。日志不是游戏事实源，写入故障不回滚游戏事务。

普通日志只保存白名单诊断字段：事件名、稳定分类、状态码、耗时、revision、数量和安全 `traceId`。不保存玩家原文、完整存档、prompt、模型输入输出、密钥或异常正文。AI 文本审计是另一套 append-only JSONL，完整策略见 [AI文本审计](../agent/AI文本审计.md)。

## 健康检查与查询

```
npm run logs:health
npm run logs:query -- --trace <traceId>
npm run logs:query -- --event http_request_failed
npm run logs:query -- --from 2026-09-01T00:00:00+08:00 --to 2026-09-01T23:59:59+08:00 --limit 200
```

查询其他环境时显式指定数据库：

```
node scripts/logs.mjs query --db <path-to-logs.db> --trace <traceId>
```

先用响应头 `X-Request-Trace-Id` 关联 HTTP、use case、后台叙事任务和 AI 审计。普通日志中的 `http_request_started`、`http_request_completed`、`http_request_failed` 用于判断入口、状态和耗时；具体 provider prompt 和正文只能查审计 JSONL。

## 保留与清理

默认普通日志保留 30 天，audit 类事件保留 365 天：

```
npm run logs:retention
npm run logs:retention -- --standard-days 30 --audit-days 365 --vacuum
```

`GAME_LOG_STANDARD_RETENTION_DAYS`、`GAME_LOG_AUDIT_RETENTION_DAYS` 和 `GAME_LOG_RETENTION_MAX_RUN_MS` 可提供默认策略。清理前确认 `GAME_LOG_DB_PATH`，保留命令输出作为运维记录；不要手工改迁移表或删除日志库。

## 故障定位

| 现象 | 先查 | 处理方向 |
| --- | --- | --- |
| HTTP 4xx/5xx | 同一 trace 的 HTTP 事件和稳定 result code | 区分输入拒绝、版本冲突、存档冲突和服务异常。 |
| 规则已成功但后台内容失败 | narrative job 状态、稳定 failure、同一 trace 的审计事件 | 确认是 unavailable、transport、解析或审批失败；生产失败保持 failed，使用显式 job retry。 |
| 查询为空 | `logs:health`、实际 `GAME_LOG_DB_PATH`、fallback 目录 | 确认查询的是当前环境；检查 JSONL fallback。 |
| 日志写入异常 | stderr 的稳定 `log_write_failed` 或 sink 初始化事件 | 修复磁盘、权限或 SQLite 锁，再重新健康检查；不要修改游戏状态。 |

不要把完整 prompt、请求体、模型输出或异常 message 复制到工单；使用 trace、事件名、稳定分类、状态码、耗时和 game ID。

## 审计操作

```
npm run ai-text-audit -- list
npm run ai-text-audit -- query --run <runId> --kind ai_call
npm run ai-text-audit -- query --run <runId> --kind game_api
npm run ai-text-audit -- query --run <runId> --kind story_text
npm run ai-text-audit -- verify --run <runId>
npm run ai-text-audit -- export --run <runId> --out <file>
```

审计目录和开关由 `AI_TEXT_AUDIT_DIR`、`AI_TEXT_AUDIT_RUN_ID`、`AI_TEXT_AUDIT`、`GAME_API_AUDIT` 控制。full 审计含敏感语义内容，目录应按敏感运行产物管理；唯一安全排除项仍是 API key、Authorization、cookie 和完整 URL。

## 实现入口

- 普通日志：`src/game/logging/`
- server 装配：`src/game/application/server/compositionRoot.ts`
- 审计 CLI：`scripts/aiTextAudit.mjs`
- 共享运维说明：foundation 的 `@ai-game/logging`
