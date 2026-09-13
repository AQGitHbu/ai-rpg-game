# Narrative P1 验收记录

## 结论

P1 仍未通过。规则闭环、条件披露与真实响应重放机制已实现并经过独立复审，但尚无一条完整 live 小故事。最新冻结版本 `ebf4a85b` 的 `p1-diag-04` 在开局失败：0/1、4 HTTP、289699 ms、零行动；其全部 4 次响应及开局最终状态已零网络严格重放，仍得到相同失败码。成功复现失败不等于故事通过。

本轮四项工作的状态如下。首要目标“完整小故事”未达成，正式六矩阵和创建到终局的实机 UI 验收没有执行，不记为通过，也不进入 P2。历史 `p1-07` 的 0/6 来自六次独立开局，不是新协议矩阵。根因与后续架构方向见 [失败分析](2026-09-13-narrative-p1-failure-analysis.md)。

| 工作 | 结果 | 未关闭边界 |
| --- | --- | --- |
| 保密、引荐、交付与退出规则 | 已完成；正式 SQLite 旅程及独立复审通过 | 不代表 live 作者可稳定使用这些能力 |
| 原始响应生产链重放 | 已完成机制与集成验证；diag02 开局成功路径、diag04 整次失败初始化实际重放一致 | 尚无完整 live 故事可用于端到端重放；diag03 旧磁带缺失败收尾清单，未补造 |
| 单故事、六矩阵、实机 UI | 已执行四次独立诊断，均未得到完整故事 | 六矩阵及实际 UI 创建→中途重载→终局仍待验收；UI harness 代码不算实机证据 |
| 原文审核与验收结论 | 已读诊断原文、复现拒绝并记录 P1 不通过 | 未完成路线不评分，不能评定完整叙事质量或优于 main |

历史 `p1-07` 的 `S1-private` 已持久化到第 5 个有效行动，随后因 `approval_rejected` 结束；其他路线在开局或审阅阶段结束。审阅耗尽背后存在作者/reviewer 契约冲突、缺少上一稿的修订，以及互动未接入作者等本地根因，不能仅归因于模型质量。`p1-08` 使用 DeepSeek `reasoning_effort=low` 与 240 秒审阅超时，长时间等待后中止且没有 summary；现存完成请求审计不足以判断中断时卡在哪一层。没有完整 live 轨迹，不填写人工质量分，也不能开始 P2。

## 已完成的离线证据

- P1-A 的五路线、泄密后 reload 与交付、普通离场和中性自由输入共八条正式规则旅程见 [P1-A 验收报告](2026-09-13-narrative-architecture-p1-a.md)。
- Task 5 的实体/经历/活跃 thread 召回见 `storyEvidenceJourney`、`retrieveStoryEvidence` 相关测试。
- Task 6/7 的角色私密判断、整场候选联合修订和 reviewer 故障边界见 application/AI 测试。
- Task 8 的租约、候选版本、HTTP 预算、取消、并发 ensure 和旧 worker fencing 见 `narrativeRecoveryJourney`、SQLite persistence 和 RPG client 测试。
- Task 9 的固定输入、S1/S2 × 三路线分母、协议哈希/代码指纹、1000 次批次预算和 register/live/replay CLI 门禁见 [P1 旅程协议](2026-09-12-narrative-p1-protocol.md) 与 `narrativeP1LiveJourney` / `narrativeP1Journey.node-test`。
- live 结果保存在 `artifacts/narrative-p1/p1-01/p1-01/`（旧 runner 路径）和 `artifacts/narrative-p1/p1-02/`；这些产物被 `.gitignore` 忽略，不作为源码提交。

## 门禁结果

- `npm run accept`：通过；lint 0 errors，216 个测试文件通过，2749 tests passed、1 skipped，typecheck、fast gates、build 均通过。
- `npm run test:narrative-p1-script`：通过；14 passed。
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

历史批次保留 S1/S2 × private/public/verify_first 六路线分母，未完成路线未从分母删除；旧实现未共享同 scenario 开局快照。这些是诊断样本，协议 v3 的新矩阵须重新登记运行。

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

具体保密条件、真实引荐、真实归还及送达后禁止弃约的规则闭环已补齐；真实响应重放机制与独立诊断也已执行，正式矩阵尚未执行。修复后的离线门禁见 [失败分析](2026-09-13-narrative-p1-failure-analysis.md)；本报告门禁数字为本次修复后的工程检查，输出见本地 artifacts/p1-diag04-accept.log；不代表已完成 live 验收。响应 replay 已实现：新 SQLite 重走原始响应解析、NPC 判断、审阅、审批和规则写入，严格比对请求与逻辑存档；协议绑定、原始审计哈希和零网络集成测试通过。实际重放范围见本报告结论；没有完整故事或六矩阵的重放证据。


## 当前诊断样本

- p1-diag-01（575354ca）：0/1，8 HTTP，1 个行动，226916 ms。开局首次结构错误经修订后通过；随后 NPC 输入列出 npc_met，outward 却拒绝该 ID，消耗两次候选机会。第三版作者补造接应人识别方式，被审阅正确拒绝。未完成路线不评分。
- 诊断同时暴露 runner 漏读 NPC 面板选择，只点到地点通用交谈；对应完整读模型及最终显式交付回归已补齐。NPC 证据、真实当前表达、互动 schema 和开局核验依据契约已统一，独立审核通过；后续批次结果分别列于下文。
- p1-diag-02（cc0fecbe）：开局 author/reviewer 两次响应成功，首个保密动作落盘到 revision 1；后续预留 1 次 HTTP 后进程异常中断，没有正常结束摘要。启动快照中的 HTTP 0 不是最终计数。未见续租或请求超时审计，现有证据不足以区分宿主中断与事件循环阻塞。其完整开局已在新 SQLite 中零网络重放，匹配 2 次原始响应与 opening 全状态；仅为开局证据。
- p1-diag-03（cc0fecbe）：独立隐藏后台进程正常结束，0/1，8 HTTP，1 个行动，418962 ms。开局给出了暗语与半枚铜钱短痕的核验方法；首个实际选择是私下请求引荐，尚非正式承诺。NPC 第 1 版因把 secret 放入普通 factIds 被拒，第 2 版因听众自指被拒，第 3 版通过；作者未把保密条件绑定成可执行 interaction，且提前透露部分线索，审阅正确要求修订，但候选额度已耗尽。该未完成路线不评分。
- diag03 同时定位到条件披露的权限缺口：privateFactKeys 编成 secret，而既有规则没有“真实保密承诺后可引荐告知”的路径。另有正常失败退出未封存 replay 审计清单的问题；原始响应仍完整保留，但该失败磁带不可声称已严格重放。修复已随 ebf4a85b 冻结，使用新样本验证，没有修改旧审计补造通过。
- p1-diag-04（ebf4a85b）：0/1，4 HTTP，289699 ms，零行动。前两版分别把 item 及整组 location/npc/quest/situation/item 放错嵌套层；生产 source 复现均为 opening_unknown_keys，反馈没有给出具体 JSON 路径。第三版通过结构校验，但把私密 courier_pursuers 中客栈追查者线索写进公开正文，被 reviewer 以 DISCLOSURE 拒绝。`replay/S1-opening.comparison.json` 确认最终状态匹配，replay summary 为 HTTP 0、replayedTransportAttempts 4、同一 AI_GENERATION_FAILED；无行动、无终局，不评分。
