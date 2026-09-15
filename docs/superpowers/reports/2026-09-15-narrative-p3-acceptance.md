# P3 故事验收

## 当前结论

截至本次 Task 8 实现，P3-A/P3-B 工程闭环和 P3-C 离线双路线证据已具备。真实批次 `p3-01` 已登记并实际运行，但 private/public 都以 `ROUTE_POLICY_UNSUPPORTED` blocked，未形成两种调查方法、合作分化、合法交付/终局；严格 replay 通过但不是故事通过。没有实际 UI 证据，因此 P3 整体不通过。

## 验收矩阵

| 项目 | 当前证据 | 状态 |
| --- | --- | --- |
| C1 主动调查 | Task 1/4/5/7 的正式规则、read model Action、唯一发现事件 | 工程通过，真实 UI 待执行 |
| C2 角色因果 | Task 2/6/7 的来源 Event、目标和合作门槛断言 | 工程通过，真实 NPC 产物待执行 |
| C3 合作分化 | Task 7 private/public 后续 Action 集合和两次后果行动 | 离线通过，真实对照待执行 |
| C4 自由策略 | Task 5/7 的自由输入只生成合法后续选择，不直接结算 | 工程通过，真实 UI 待执行 |
| C5 回访和记忆 | Task 4/6/7 的回访、固定包和作者请求断言 | 工程通过，真实请求待执行 |
| C6 恢复 | Task 4/6/7 SQLite reload、A/B/retry 和重复效果断言 | 工程通过 |
| C7 完成性 | Task 7 离线双路线；Task 8 runner 能保留两路状态及分母 | 真实 live/UI 未执行，不通过 |
| C8 可维护性 | 新协议仅复用 P1 replay/SQLite 基础，P1/P2 CLI 未变；另一题材证据见 Task 3 | 工程通过 |

## Task 8 工程检查

本 Task 的离线检查项：

- `npm run env:check` 通过且没有回显配置值；这只证明配置可读，不证明 provider 调用成功。
- `npm test -- --minWorkers=1 --maxWorkers=2`：241 个测试文件，3018 passed、1 skipped。
- `npx vitest run src/game/application/testing/narrativeP3LiveJourney.test.ts --minWorkers=1 --maxWorkers=2` 通过；`npm run test:narrative-p3-script` 通过（4 tests），包含显式 live 门禁、零 HTTP replay 和伪造 manifest 拒绝。
- P1 脚本 20 passed；P2 脚本 31 passed；`npm run typecheck`、`npm run lint -- --quiet`、`npm run test:boundaries`（135 passed）和 `git diff --check` 通过；`npm run check:docs` 0 errors、1 个既有篇幅提醒。

真实批次完成后必须在本页追加但不提交秘密：runId、protocolHash、实际两路状态、动作/HTTP/耗时、opening 分叉、调查方式、告知/核验、目标/知识/合作差异、History/Event/终局、reload/A-B/retry、UI 刷新证据、严格 replay 结果和人工 C1–C8 阅读。失败路线仍保留 `blocked`，未执行路线保留 `not_run`；不得通过补抽开局、无限 retry、改提示词或离线文本将其改成通过。

因此当前总判定仍为：P3 尚不能标记为整体完成，直到同一真实批次提供 C7 要求的 live/UI 证据，并确认没有程序性越权或缺少必要上下文。

## `p3-01` 实际结果

| 路线 | 状态 | 有效动作 | 失败码 | 真实证据 |
| --- | --- | ---: | --- | --- |
| private | blocked | 7 | `ROUTE_POLICY_UNSUPPORTED` | 独立 SQLite、steps、runtime tape |
| public | blocked | 11 | `ROUTE_POLICY_UNSUPPORTED` | 独立 SQLite、steps、runtime tape |

共同 opening 只初始化一次并复制为两路数据库；两路均未到 P3 调查/合作/终局验收点。对同一产物的零网络 replay 为两路相同 blocked、动作数/失败码一致，`strictReplayPassed=true`、HTTP=0。live 产物的旧 HTTP 计数器暴露了 adapter 绑定问题，已在最终 Task 8 代码中修正；这不改变该批两路 blocked 的玩法结论，也不把 live tape 误报为 C7 完成。
