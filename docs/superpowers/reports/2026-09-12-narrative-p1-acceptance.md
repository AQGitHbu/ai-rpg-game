# Narrative P1 验收记录

## 结论

P1-A 与 P1-B 的离线实现和门禁通过；P1-C 仍未通过。最新完整固定矩阵 `p1-07` 为 0/6，HTTP 44 次，六条路线均未到达终局。此次批次没有再出现 `context_budget_exceeded`：本地叙事包上下文预算闸门已在 `85ca21af` 移除，thinking provider 的实际上下文交给 provider 处理。

最新完整批次的剩余失败属于 provider 超时和候选语义审阅/修订耗尽。`S1-private` 已持久化到第 5 个有效行动，随后因 `approval_rejected` 结束；其他路线在开局或候选审阅阶段结束。随后执行的 `p1-08` 使用 DeepSeek `reasoning_effort=low` 与 240 秒审阅超时，但因 provider 请求长时间无返回而中止，没有生成 summary，不能作为正式通过率。没有完整 live 轨迹，因此不填写人工质量分，也不能宣布 P1 通过或开始 P2。

## 已完成的离线证据

- P1-A 的五条正式规则旅程、SQLite reload、普通离场和中性自由输入见 [P1-A 验收报告](2026-09-13-narrative-architecture-p1-a.md)。
- Task 5 的实体/经历/活跃 thread 召回见 `storyEvidenceJourney`、`retrieveStoryEvidence` 相关测试。
- Task 6/7 的角色私密判断、整场候选联合修订和 reviewer 故障边界见 application/AI 测试。
- Task 8 的租约、候选版本、HTTP 预算、取消、并发 ensure 和旧 worker fencing 见 `narrativeRecoveryJourney`、SQLite persistence 和 RPG client 测试。
- Task 9 的固定输入、S1/S2 × 三路线分母、协议哈希/代码指纹、1000 次批次预算和 register/live/replay CLI 门禁见 [P1 旅程协议](2026-09-12-narrative-p1-protocol.md) 与 `narrativeP1LiveJourney` / `narrativeP1Journey.node-test`。
- live 结果保存在 `artifacts/narrative-p1/p1-01/p1-01/`（旧 runner 路径）和 `artifacts/narrative-p1/p1-02/`；这些产物被 `.gitignore` 忽略，不作为源码提交。

## 门禁结果

- `npm run accept`：通过；lint 0 errors/50 existing warnings，211 个测试文件中 2696 passed、1 skipped，typecheck、fast gates、build 均通过。
- `npm run test:narrative-p1-script`：通过；7 passed。
- `npm run check:docs`、`npm run test:docs`、`git diff --check`：通过。
- `npm run env:check`：通过；`.env.local` 仅注入当前进程，密钥未写入协议、审计摘要或报告。

## A1–A10 范围

| 项目 | 当前证据 | live 状态 |
| --- | --- | --- |
| A1 | P1-A 私下/公开规则旅程 | `p1-07` 未完成正式终局 |
| A2 | P1-A SQLite 重载与承诺状态 | `p1-07` 仅有 `S1-private` 中途存档，无 live 重载终局 |
| A3 | NPC continuity / knowledge boundary 离线测试 | 未完成 live 路线 |
| A4–A5 | story evidence 正式检索与长期证据测试 | 未完成 live 路线 |
| A6 | P1-A `verify_first` 合法核验后显式交付 | `p1-07` 未完成路线 |
| A7 | 候选 review/修订与 stale hash 测试 | 离线通过；live 出现审阅修订耗尽 |
| A8–A9 | Task 8 recovery、CAS、token/revision 隔离测试 | 离线通过；live 未走到对应完整轨迹 |
| A10 | P1-A 交付/主动退出终局测试 | 离线通过；live 未完成终局 |

## Live 执行边界

所有批次均使用固定的 S1/S2 × private/public/verify_first 六路线分母；未完成路线未从分母删除。

| 批次 | 结果 | 主要边界 |
| --- | --- | --- |
| `p1-01` | 0/6，HTTP 10 | 旧 runner 产物路径重复；5 条 `ROUTE_RUNNER_CRASHED`，1 条 `AI_GENERATION_FAILED` |
| `p1-02` | 0/6，HTTP 9 | 生产路由 setup 合同不匹配，六条 `PRODUCTION_ROUTE_CRASHED`，SQLite 均无 `game_records` |
| `p1-03` | 0/6，HTTP 12 | reviewer 兼容词未归一化，候选进入 `AI_GENERATION_FAILED` |
| `p1-04` | 0/6，HTTP 34 | reviewer 兼容词已修复；后台生成仍被 runner 当作有效行动反复轮询，出现 `ROUTE_ACTION_BUDGET_EXHAUSTED` |
| `p1-05` | 未完成 | 使用上下文闸门修复前版本；观察到历史增长导致 `context_budget_exceeded`，随后为切换新策略而停止，不作为完整批次结论 |
| `p1-06` | 未生成 summary | 使用无本地预算闸门版本启动；首条路线运行期间会话中断，保留局部审计产物，不作为完整批次结论 |
| `p1-07` | 0/6，HTTP 44 | 无 `context_budget_exceeded`；剩余为 provider timeout、语义审阅修订耗尽和 `approval_rejected` |
| `p1-08` | 未完成，无 summary | 显式 `reasoning_effort=low`、author/review 240 秒；前两条路线各完成 3 次开局生成但未落盘，`S1-verify_first` 推进到 revision 25 后因 provider 长时间无返回而中止，不计入正式矩阵 |

已落地的代码级修复如下：

- `abc531be`：把 runner 的验证输入投影为正式 `GameSetup`，修复生产入口 setup 合同。
- `b282f42a`：为观察到的 reviewer scope/code 兼容词建立受控归一化，未知值仍 fail closed。
- `bdc60a9d`：runner 等待后台叙事生成完成后才计有效行动，避免 pending poll 消耗行动预算。
- `85ca21af`：移除叙事包本地 8,000 estimated-token 拒绝闸门，并更新 TDD 覆盖；provider 失败仍走既有失败协议。
- `4970e11e`：审阅单次超时调整为 240 秒，并按 DeepSeek 官方字段显式发送 `thinking.type=enabled` 与 `reasoning_effort=low`；参数透传和协议冻结均有 TDD 覆盖。

`p1-07` 的 0/6 不是 P1 通过证据：AI provider 的调用和审计链已经实际运行，但候选质量/超时尚未稳定达到六条完整终局的门槛。后续若继续 live，应另建 protocol run，并针对 provider 超时与语义审阅失败单独收集证据；不能用再次扩大局部修补轮次替代 P1-C 的完整矩阵和人工评分。
