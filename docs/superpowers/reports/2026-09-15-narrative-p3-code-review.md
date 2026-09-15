# P3 规则与模块代码审阅

## 范围与结论

审阅 `codex/narrative-architecture` 的 P3 Plan 和实现，代码范围为 `8157011e..9d0a6a27`，包含 24 个提交。三个子智能体分别检查规则与来源、生成与恢复、正式旅程与验收；主智能体复核跨层接口、汇总修复及运行验证。本次聚焦规则、模块和程序性验收，不优化文学细节，不改 main，不调用真实 API。

已修复下列可复现问题；核心离线规则与恢复链已有证据，但 P3 仍有未完成能力，不能据此标记整个阶段完成。阶段判定见 [P3 验收](2026-09-15-narrative-p3-acceptance.md)，待执行范围见 [P3 Plan](../plans/2026-09-15-narrative-architecture-p3.md)。

## 发现与修复

| 严重性 | 原问题与影响 | 修复与回归入口 |
| --- | --- | --- |
| 高 | 条件型交谈目标仍受旧两轮会话门槛限制；目标来源只认可调查，同时允许无关后续事件触发旧证据，导致合法知识、物品、承诺不能稳定改变合作 | 统一条件求值和目标完成准入；NPC 仅消费本人、对应条件的实际新事件。`npcGoalResolution.test.ts`、`deriveObjectiveTransition.test.ts`、`reconcileStoryConsequences.test.ts` |
| 高 | 分享调查证据可引用与被分享事实不匹配的调查事件；同回合已持久化来源被误写为尚未提交的同批来源 | 分享必须同时匹配事实、实际观察者与原调查事件；目标以实际分享为因果依据，已提交来源使用 `event_id`。`resolveStoryInteraction.test.ts`、`npcGoalResolution.test.ts` |
| 高 | B 首次添加任务完成条件可追溯利用先前交谈，即使原审批仍为旧幕，最终存档已进入下一幕；已消费的 legacy 合作也可事后加门槛 | 拒绝追溯安装会立即完成既有交谈的条件；拒绝终态任务和已安装/消费合作事后首次绑定，保留相同绑定幂等。正式 create→talk A→B 回归验证场景与幕状态不分离 |
| 高 | 回访只看当前移动的事件，漏掉离场期间的历史变化；历史 proof 来源未进入固定记忆 | 从目标地点最后已呈现场景以后读取相关且可见的历史事件，proof 来源加入同一权限过滤的固定包。`resultBoundary.test.ts`、`prepareNarrativeMemory.test.ts` |
| 高 | 调查方式可形成事实自依赖、目标/调查循环或依赖无法达到的终态 | 对已物化片段做有限依赖检查，有可行替代方式可通过；不增加全世界规划器。`validateInvestigationDependencies.test.ts`、`approveStoryConsequenceBindings.test.ts` |
| 高 | 开局/bundle 只检查绑定 kind，畸形嵌套结构可在审批时抛异常；决策编译器拒绝合法顶层 consequenceBindings | 复用 domain 严格结构验证，开局、决策、world source 和绑定审批共用；编译器保留合法字段。`storyConsequenceBindings.test.ts`、`narrativeDraftProjection.test.ts` |
| 中 | 持久 job 可接受结果类型与 proof 不匹配、缺 proof 或错误目标，恢复时缺少可靠边界 | 校验生成类型、原始 Action、proof kind/target 的配对，并拒绝额外字段；允许回访引用历史来源。`pendingNarrativeJob.test.ts` |
| 中 | opening 包装器静默丢弃外部未知/冲突字段；生产存在由测试输入关键词触发的 P3 特例 | 包装只接受单一合法 opening；删除测试标记驱动的首幕限制与 prompt 特例。`liveNarrativeBundleSource.test.ts` |
| 中 | runner 在开局而非首个双方法调查点分叉，完成门槛不足；离线 fixture 事后绑定目标且把重载记作回访 | 正式公共前缀到首个双方法 ready 再复制 SQLite，公共 HTTP 计一次、动作计入各路线预算；要求真实策略确认、目标变化、精确交付与回访。fixture 首次物化时绑定，明确 `reloadAfterInvestigation`，断言没有实际回访。P3 script 与 `narrativeP3Journey.test.ts` |

源码入口均以仓库 `src/game/` 为根；规则实现和测试位于对应 gameplay 子系统，正式编排回归位于 `application/testing/`。表中问题已通过针对性失败用例定位，不以 AI 正文好坏作为规则判断。

## 正式恢复证据

`narrativeRecoveryJourney.test.ts` 使用独立 SQLite 和合法历史初态，经正式选项、`performTurn` 与生成用例触发 `changed_revisit`。历史变化不属于此次移动事件，但进入结果 proof 和作者固定记忆。B 候选耗尽后关闭并重开数据库，显式重试覆盖再次失败和成功 ready 两种结果。

成功分支经真实 descriptor、compiler/审批及 SQLite CAS 发布，没有模拟审批或直接改写结算结果；只新增一次场景事件，移动和玩家 History 不重复，固定记忆保持一致。ready 后再次 ensure 不调用 source、不修改存档。

## 验证

- 最终 `npm test -- --minWorkers=1 --maxWorkers=2`：244 个文件通过、1 个跳过；3074 项通过、1 项跳过，包含新增正式 SQLite 绑定与回访恢复回归。
- P1/P2/P3 的全部八个 journey/seed/manifest/segment/stage/recall 脚本测试文件合并执行：60 项通过、0 失败。
- 最终 `npm run typecheck`、`npm run lint -- --quiet` 通过；本轮 `npm run test:fast`、135 项依赖边界检查及 `npm run build` 通过。
- `npm run check:docs`：0 错误，运行时 AI 系统文档保留一个既有篇幅软阈值提醒；`git diff --check` 通过。
- 本地日志保存在忽略目录 `artifacts/narrative-p3-code-review/`；不纳入源码提交。真实 API 与 UI 本轮未执行，旧 `p3-01` 的 blocked 结果保留。

## 尚未完成的 P3 能力

- Task 6 的 B 本场披露尚没有完整的“持久化 NPC 知识事件→同候选编译/审阅前后果预览”生产链。当前审批中的场景内临时披露权限和发布前 reconciliation 不能替代这一能力。本次禁止追溯绑定消除了已复现的幕状态分离，没有伪造知识事件补齐计划。
- 双路线离线短篇已验证调查、告知、合作与显式交付；实际离场回访目前由独立恢复用例验证，尚未整合入同一完整故事。
- Task 3/7 的另一题材正式复用片段仍待验证。
- runner 已修复，但未重跑真实批次，也没有真实 UI 证据。后续先补上述模块与离线故事范围，再进入有界 live/UI 验收；文学质量继续单独报告。
