# RPG 日志运维手册

## 日志位置与边界

游戏状态库和日志库分离：默认状态库为 `db/rpg.sqlite`，默认结构化日志库为 `data/logs.db`。可通过 `GAME_LOG_DB_PATH` 覆盖日志库路径；SQLite 不可用时，服务会降级写入 `GAME_LOG_FALLBACK_DIR`（默认 `logs/`）中的 JSONL。

日志库只保存稳定诊断字段，不保存玩家原文、prompt、模型原文、密钥或完整存档。接口请求会返回 `X-Request-Trace-Id`，该值可贯穿 HTTP、use case、AI 后台任务和生成审计日志。

## 快速检查

```powershell
npm run logs:health
```

健康检查能打开日志库并读取 schema 即返回 `ok: true`，同时显示事件总数和最近事件时间。日志库为空不代表游戏异常；应结合应用进程状态和请求查询判断。

## 查找一次请求

优先使用客户端或响应头中的 trace ID：

```powershell
npm run logs:query -- --trace <traceId>
```

也可以按事件或时间范围查询：

```powershell
npm run logs:query -- --event http_request_failed
npm run logs:query -- --from 2026-08-01T00:00:00+08:00 --to 2026-08-01T23:59:59+08:00 --limit 200
```

需要访问其他环境的日志库时显式传路径，避免误查本机默认库：

```powershell
node scripts/logs.mjs query --db D:\rpg\data\logs.db --trace <traceId>
```

查询结果中的 `http_request_started`、`http_request_completed`/`http_request_failed` 用于判断入口和耗时；`use_case_*` 用于判断规则层结果；`runtime_narrative_generation`、`town_plan_generation`、`scenario_generation_audit` 用于判断 AI 生成与 fallback。失败分类和 `resultCode` 是稳定的排障入口，不应依赖异常文本。

## 保留与清理

默认普通日志保留 30 天，`audit.*` 事件保留 365 天：

```powershell
npm run logs:retention
```

可临时覆盖天数，并在清理后执行 SQLite vacuum：

```powershell
npm run logs:retention -- --standard-days 30 --audit-days 365 --vacuum
```

也可通过 `GAME_LOG_STANDARD_RETENTION_DAYS`、`GAME_LOG_AUDIT_RETENTION_DAYS` 和 `GAME_LOG_RETENTION_MAX_RUN_MS` 配置默认策略。`audit` 保留天数不能小于普通日志保留天数。清理命令输出 `deleted`、`auditProtected`、`stoppedByTimeLimit`，应保留输出作为运维记录。

## 备份、fallback 与告警

- 日志库是独立 SQLite 文件，应与 `db/rpg.sqlite` 分开做每日备份；备份前先确认复制的是 `GAME_LOG_DB_PATH` 指向的实际文件。
- 监控日志库所在磁盘空间、`npm run logs:health` 的退出码和 fallback 目录增长。SQLite 打不开或迁移失败时，健康检查非零；应用仍按既有约束尝试 JSONL fallback，不应因此回滚游戏事务。
- 共享有界队列在持续拥塞时可能丢弃低优先级诊断事件； error 事件优先写 fallback，但 fallback 也可能因磁盘/权限失败。日志不是游戏事实源，故障单必须同时带 trace、HTTP 状态、稳定结果码和玩家可见结果。
- 遇到 future schema 错误时不要手工改 `schema_migrations` 或删除日志库；先升级兼容的 `@ai-game/logging`，确认健康检查通过后再运行 retention。删除日志库会丢失排障证据，必须先完成备份并获得运维批准。

## 常见故障定位

| 现象 | 先看什么 | 处理方向 |
| --- | --- | --- |
| 请求返回 4xx/5xx | `http_request_completed` 的 `httpStatus`、`resultCode`；必要时查同一 trace | 先区分输入拒绝、版本冲突、存档冲突和服务异常 |
| 请求成功但后台内容未生成 | 同一 trace 下的 `runtime_narrative_task`、`town_plan_task`、`runtime_narrative_generation` 或 `town_plan_generation` | 看 `pending`、`already_running`、`stale`、`unavailable` 和稳定失败分类；后台任务不应阻塞规则结果 |
| AI 失败或回退 | `scenario_generation_audit`、provider 诊断事件 | 检查配置/限流/超时/解析失败；确认 deterministic fallback 是否成功 |
| 日志查询为空 | `npm run logs:health`、`GAME_LOG_DB_PATH`、fallback 目录 | 确认查的是当前环境路径；检查 JSONL fallback 是否在写入 |
| 日志写入异常 | 进程 stderr 的稳定事件 `log_write_failed` 或 `sqlite_log_sink_initialization_failed` | 不因日志故障回滚游戏；修复磁盘、权限或 SQLite 锁后重新检查 |

不要把完整异常 message、prompt、请求体或模型输出复制到工单；使用 trace ID、事件名、稳定分类、状态码、耗时和 game ID 进行关联。
