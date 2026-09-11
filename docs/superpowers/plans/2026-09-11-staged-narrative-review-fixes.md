# 四模块叙事交接与任务恢复修复 Implementation Plan

**Goal:** 修复披露认定、权限投影、选项依赖与合法性，以及现有初始化和租约流程，不新增玩法。

**Architecture:** 保留 planning → narration/character/choices → 完整包发布。只对新增知识传播的 NPC 对白增加独立语义审核，不增加生成职责；沿用 SQLite、job、lease、CAS 和显式重试。

**执行状态：** 实现与离线验证完成，证据见[验收报告](../reports/2026-09-11-staged-narrative-review-fixes.md)。当前会话未提供 executing-plans / subagent-driven-development 技能，按用户实施授权在当前会话执行。

## 全局约束

- 需求以[最新 Spec](../specs/2026-09-09-staged-narrative-generation-design.md)为准；[旧 Plan](2026-09-09-staged-narrative-generation.md)只作历史过程。
- 不同选项意味着不同剧情走向，不要求新地点、不同地点、新任务或两个不同未完成目标。
- 生产不使用固定对白、旧整包 source 或 fixture 兜底；失败沿用显式重试。
- 上游改变使依赖产物失效；无关已批准单元不重跑。
- 每内容单元最多四次尝试；额外审核计入原 job 额外额度 12 和周期 600000ms，不扩大预算。
- 只在目标 worktree 修改，不改 main、阶段指针或 foundation；不自动调用付费 API、提交、合并或推送。
- 本轮不扩建多角色展示；纯对白格式与复杂交错台词不混入范围。

## Task 1：权限与选项审批

**Files:** narrativeGeneration 的 perspectiveContext、realizeObservations；narrativePlanning 的 approvePlan、approvePlanDecision；ruleEngine 公开 validateAction 与相应测试。

- [x] 条件披露权限显式使用玩家受众关系，投影与兑现使用相同目标。
- [x] choices 晚于同场全部非 choices 单元，沿用自动依赖补齐。
- [x] 普通候选在决策快照上通过真实 validateAction，非法 quest/fact 引用在发布前拒绝；不执行动作。
- [x] 条件关系、同 order、非法候选和同地点分支回归通过。

## Task 2：新增知识的独立审核

**Files:** disclosureReview、disclosureReviewPrompt、runJob、stageSource、liveStageSource、rpgAiClient、StoredUnit/SQLite，以及初始化和决策发布入口。

- [x] 结构审批后，对新增知识的对白调用 reviewDisclosure，只传授权事实、确定程度、受众和实际正文。
- [x] pass 才批准；reject/uncertain 按原单元上限修复，服务失败或无端口明确失败。
- [x] 先持久扣额度再审核；串行写入内再次核验额度，计入 usedRequests。
- [x] 服务端凭据绑定单元、输出及审核请求；旧缓存无凭据或不匹配时撤销单元与下游，发布再验证。
- [x] 覆盖拒绝、不可判定、异常、缺失端口、非法 verdict、额度耗尽、缓存失效、正文篡改和 SQLite reload。
- [x] disclosure_review 单列审计 role，四类生成 role 不变。

## Task 3：初始化身份、恢复与重开

**Files:** initializationJob、compositionRoot、sqliteNarrativeJobs、NewGameSetupForm 与相应测试。

- [x] 新任务幂等摘要绑定用户配置与替换目标，不绑定服务端随机身份；重复请求复用首次 envelope。
- [x] pending/failed 初始化槽必须显式取消才能被新请求替换，发布事务再次验证槽归属。
- [x] GET pending 通过已有 coordinator 恢复执行；过期周期落为失败，不重置额度。
- [x] 表单忽略没有匹配请求标记的历史 published 初始化。
- [x] 真实 SQLite、重复请求、表单和组合根重启恢复测试通过。

## Task 4：租约与绝对截止时间

**Files:** generatePendingNarrativeBundle、compositionRoot、runJob、publishJob、jobBudget、rpgAiClient 与相应测试。

- [x] 独立执行使用唯一 owner，竞争/失租/取消不覆盖其他 worker 的 provider 状态。
- [x] 生成作用域按绝对截止时间取消并清理 timer；响应后和发布前复核时间。
- [x] 传输重试重新计算剩余时间，不重复获得完整 timeout。
- [x] 唯一 owner、竞争不写失败、晚到 choices、发布截止、传输预算及现有租约保活测试通过。

## Task 5：交付验证

- [x] 原位更新 Spec、运行时、NPC 认知和 AI 审计文档。
- [x] test:fast、全量 Vitest 单进程重跑、离线 smoke 脚本、build、lint、typecheck、check:docs 和 diff 检查完成；详细计数与警告见报告。
- [x] 核对 main 干净、未提交、未调用付费 API；不宣称语义审核绝对可靠或真实 API 质量已经验收。
