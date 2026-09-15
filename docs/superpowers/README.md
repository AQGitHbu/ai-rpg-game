# 规划与过程资料

`specs/` 保存设计，`plans/` 保存执行任务，`reports/` 保存验收证据。它们不定义生产实现事实；系统现状从 [Agent 索引](../Agent文档索引.md) 定位。

阶段执行只读取 [阶段配置](../agent/current-phase.json) 指向的 Plan。独立功能任务按用户指定的 Spec/Plan 执行，不更改阶段指针。

- 待执行 Plan：先读目标和全局约束，再读当前 Task 及其要求的 Spec 章节；无需预加载每个任务的全部系统资料。
- 实施完成：将有效契约原位更新到所属系统，Plan 保留任务和验收证据，不向索引追加成绩。
- 追溯决策：定向查阅对应历史文件，不按文件日期推定当前能力。

## 独立架构设计入口

- [持续局势、完整场景与长期信息架构](specs/2026-09-12-narrative-architecture-design.md)：main 起点的新设计，先验证完整小故事，再扩展长期记忆与角色/世界能力；现状及历史实验见其关联的基准报告。该入口不替代阶段配置中的执行 Plan。
- [P1 完整小故事实施 Plan](plans/2026-09-12-narrative-architecture-p1.md)：保留首期建设、收敛与最小收尾的执行证据，旧失败批次不再作为继续实施入口。
- [P2 较长经历召回与完整中篇 Plan](plans/2026-09-14-narrative-architecture-p2.md)：在现有代码上补齐旧事证据链、派生摘要和完整短/中篇验收；范围依据见 [P2 代码核查](reports/2026-09-14-narrative-p2-scope-review.md)。P3/P4 尚不展开实施任务。
- [P2 Plan 独立审阅](reports/2026-09-14-narrative-p2-plan-review.md)：固定记忆恢复、租约隔离和 NPC 私密传递的规划问题及修订依据。
- [P2 准入缺口修复 Plan](plans/2026-09-14-narrative-p2-readiness-fixes.md)：组织实现核查后的 R1–R6 修复；对应 [离线验收报告](reports/2026-09-14-narrative-p2-readiness-fixes.md) 与 [验证协议](reports/2026-09-14-narrative-p2-protocol.md)。
- [P2 真实 API 与剧情质量验收](reports/2026-09-14-narrative-p2-acceptance.md)：冻结批次的通关、严格回放、记忆覆盖与全文质量证据，区分实际执行和未覆盖项目。
- [P2 剧情修复 Plan](plans/2026-09-14-narrative-p2-story-repair.md)：行动核查、具体冲突推进、追问与正式回应分离、有限委托的真实收束；对应 [修复验收报告](reports/2026-09-14-narrative-p2-story-repair.md)。
- [P2 记忆覆盖重规划](plans/2026-09-14-narrative-p2-memory-coverage.md)：以有界议题验证摘要后的旧事恢复，独立安排真实记忆诊断、两臂与 UI；整体故事质量另保留门槛。
- [P2 三幕短篇实跑](reports/2026-09-14-narrative-p2-short-story.md)：p2-02 的实际正文范围、生成失败依据与后续收敛方向。
- [P2 时序边界修正实跑](reports/2026-09-14-narrative-p2-temporal-scope.md)：p2-03 的换幕证据、审阅阻断与实际剧情判断。
- [P2 完整短篇评审](reports/2026-09-14-narrative-p2-complete-story.md)：p2-04/05 的运行证据、完整三幕故事与选择后果缺口。

- [P2 独立真实记忆诊断](reports/2026-09-15-narrative-p2-memory-diagnostic.md)：摘要选择契约失配的实际请求、未发布证据及未覆盖边界。

- [P2 摘要契约修复与恢复验证](reports/2026-09-15-narrative-p2-summary-contract.md)：固定真实来源上的两批发布、原话恢复、严格回放及概览源预算边界。
- [P2 三项收尾证据](reports/2026-09-15-narrative-p2-closeout.md)：有限概览容量、同源摘要对照和实际 UI 接续；区分运行结果与质量收益。
- [P2 工程验收](reports/2026-09-15-narrative-p2-engineering-acceptance.md)：按规则、召回、上下文组装、调用和恢复核查；文学评分与旧实验判定单独保留。
