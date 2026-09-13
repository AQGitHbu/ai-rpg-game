# Narrative P1 验收记录

## 结论

本记录覆盖当前 worktree 的离线实现验收和已授权的两批 live 尝试。P1-C 未通过：两批均为 0/6 完成，不能填写未完成路线的质量分，也不能宣布 P1 通过。

## 已完成的离线证据

- P1-A 的五条正式规则旅程、SQLite reload、普通离场和中性自由输入见 [P1-A 验收报告](2026-09-13-narrative-architecture-p1-a.md)。
- Task 5 的实体/经历/活跃 thread 召回见 `storyEvidenceJourney`、`retrieveStoryEvidence` 相关测试。
- Task 6/7 的角色私密判断、整场候选联合修订和 reviewer 故障边界见 application/AI 测试。
- Task 8 的租约、候选版本、HTTP 预算、取消、并发 ensure 和旧 worker fencing 见 `narrativeRecoveryJourney`、SQLite persistence 和 RPG client 测试。
- Task 9 的固定输入、S1/S2 × 三路线分母、协议哈希/代码指纹、1000 次批次预算和 register/live/replay CLI 门禁见 [P1 旅程协议](2026-09-12-narrative-p1-protocol.md) 与 `narrativeP1LiveJourney` / `narrativeP1Journey.node-test`。
- live 结果保存在 `artifacts/narrative-p1/p1-01/p1-01/`（旧 runner 路径）和 `artifacts/narrative-p1/p1-02/`；这些产物被 `.gitignore` 忽略，不作为源码提交。

## 门禁结果

- `npm run accept`：通过；全量测试 211 个文件、2693 passed、1 skipped，typecheck、fast gates、build 均通过。
- `npm run test:narrative-p1-script`：通过。
- `npm run check:docs`、`git diff --check`：通过。
- `npm run env:check`：在用户补充 `.env.local` 后通过；脚本仅将配置注入当前进程，不把密钥写入协议或报告。

## A1–A10 范围

| 项目 | 当前证据 | live 状态 |
| --- | --- | --- |
| A1 | P1-A 私下/公开规则旅程 | 两批均未进入正式行动 |
| A2 | P1-A SQLite 重载与承诺状态 | 两批开局未提交，无 live 重载证据 |
| A3 | NPC continuity / knowledge boundary 离线测试 | 未完成 live 路线 |
| A4–A5 | story evidence 正式检索与长期证据测试 | 未完成 live 路线 |
| A6 | P1-A `verify_first` 合法核验后显式交付 | 未完成 live 路线 |
| A7 | 候选 review/修订与 stale hash 测试 | 仅有离线证据，live 未完成 |
| A8–A9 | Task 8 recovery、CAS、token/revision 隔离测试 | 仅有离线证据，live 未完成 |
| A10 | P1-A 交付/主动退出终局测试 | 未完成 live 路线 |

## Live 执行边界

两批 live 均先完成零网络 register，再执行同一固定 6-route 矩阵：

- `p1-01`：0/6，HTTP attempts 10；5 条记录为旧 runner 的 `ROUTE_RUNNER_CRASHED`，1 条为 `AI_GENERATION_FAILED`。该批产物保留在旧版重复目录中。
- `p1-02`：0/6，HTTP attempts 9；6 条均为修复收尾遮蔽后保留的 `PRODUCTION_ROUTE_CRASHED`，六个 SQLite 均为 0 条 `game_records`，所有路线均未进入正式行动。

可确认的失败边界是：live provider 已返回并被审计的作者响应，但路线在开局持久化前失败；审计中可见部分首次响应触发了结构修订，未形成可验收的完整故事轨迹。当前没有足够证据把失败归因到某个具体规则分支，也没有进行人工文本评分；下一批若要继续，必须另建协议 run，先增加不泄露正文的生产异常分类/诊断，再由操作者明确授权。
