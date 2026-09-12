# Narrative P1 验收记录

## 结论

本记录只覆盖当前 worktree 的离线实现验收。P1-C live 批次未执行，因此不能声称六条路线完成、不能填写质量分，也不能宣布 P1 通过。

## 已完成的离线证据

- P1-A 的五条正式规则旅程、SQLite reload、普通离场和中性自由输入见 [P1-A 验收报告](2026-09-13-narrative-architecture-p1-a.md)。
- Task 5 的实体/经历/活跃 thread 召回见 `storyEvidenceJourney`、`retrieveStoryEvidence` 相关测试。
- Task 6/7 的角色私密判断、整场候选联合修订和 reviewer 故障边界见 application/AI 测试。
- Task 8 的租约、候选版本、HTTP 预算、取消、并发 ensure 和旧 worker fencing 见 `narrativeRecoveryJourney`、SQLite persistence 和 RPG client 测试。
- Task 9 的固定输入、S1/S2 × 三路线分母、协议哈希/代码指纹、1000 次批次预算和 register/live/replay CLI 门禁见 [P1 旅程协议](2026-09-12-narrative-p1-protocol.md) 与 `narrativeP1LiveJourney` / `narrativeP1Journey.node-test`。

## 门禁结果

- `npm run accept`：通过；全量测试 211 个文件、2693 passed、1 skipped，typecheck、fast gates、build 均通过。
- `npm run test:narrative-p1-script`：通过。
- `npm run check:docs`、`git diff --check`：通过。
- `npm run env:check`：未通过，原因是目标 worktree 没有 RPG 自有 `.env.local`。未运行 `env:bootstrap`，未读取或写入任何 API key，也未启动 live provider 请求。

## A1–A10 范围

| 项目 | 当前证据 | live 状态 |
| --- | --- | --- |
| A1 | P1-A 私下/公开规则旅程 | 未执行 |
| A2 | P1-A SQLite 重载与承诺状态 | 未执行 |
| A3 | NPC continuity / knowledge boundary 离线测试 | 未执行 |
| A4–A5 | story evidence 正式检索与长期证据测试 | 未执行 |
| A6 | P1-A `verify_first` 合法核验后显式交付 | 未执行 |
| A7 | 候选 review/修订与 stale hash 测试 | 未执行 |
| A8–A9 | Task 8 recovery、CAS、token/revision 隔离测试 | 未执行 |
| A10 | P1-A 交付/主动退出终局测试 | 未执行 |

## Live 执行边界

计划要求先 register 固定协议，再使用同一协议执行两次初始化并展开六条路线；这一步需要用户提供并明确启用非空的 `AI_MODEL`、API base 和 provider 配置。当前没有可安全执行的 live 配置，所以没有替换样本、没有自动补抽路线、没有填写首次/修订/人工重试成绩，也没有进行人工文本评分。

P1 的下一步是配置由操作者明确提供后，按 [P1 旅程协议](2026-09-12-narrative-p1-protocol.md) 执行 register/live，并把结果追加到独立 artifacts；本报告在此之前保持未通过结论。
