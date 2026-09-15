# P2 记忆与上下文工程验收

## 范围

**结论：P2 工程验收通过。** M1–M7 已有相应实现、可重复回归或真实运行证据，本轮检查全部完成，没有已知阻断工程缺陷。此结论仅适用于本报告定义的工程范围。

按用户确认的边界，本次核查规则约束、旧事召回、上下文组装、调用与恢复。文学评分、重复表达、模型对材料的充分利用及优于 main 的比较不是工程通过条件。旧批次的质量失败、协议限制和原始产物保持原结论。

核查基准为 `codex/narrative-architecture` 的 `94d85256`。本次没有修改生产代码、测试实现、模型参数、冻结 CLI 或阶段配置；没有新增真实 API 调用。工程矩阵见[P2 Plan Task 7](../plans/2026-09-14-narrative-architecture-p2.md#task-7工程封板与-p2-判定当前执行入口)。

## 代码与断言核查

| 项目 | 已核对的行为与证据 | 判断 |
| --- | --- | --- |
| M1 召回 | `retrieveStoryEvidence.test.ts` 覆盖别名、无姓名经历描述、持久对话指代、同名与歧义；五幕 `narrativeP2Journey.integration.test.ts` 在两次发布、旧话被概览省略、SQLite 重开之后，检查 recalled 来源的完整原话和 ID 均进入最终作者请求 | 有程序证据，不依赖模型随机遗漏原话 |
| M2 权限 | `projectObserverEvidence` 先检查 speaker/audience 与事实权限；`retrieveStoryEvidence` 不以未选选项或隐藏名称授知；`projectNpcDeliberation.test.ts` 区分选择标签与口述，并隔离非当前 NPC；五幕实际请求断言未亲历 NPC 不收到原话 | 有投影与消费者证据 |
| M3 摘要 | `planMemorySummary` 使用有效 History 与独立 sequence；`prepareNarrativeMemory` 保留当前 job 原文、校验来源预算、叶和概览同时成功才发布；非法引用、取消或概览失败保留旧水位及全部未覆盖来源；选择器校验实际 4/4、8/8 上限 | 失败处理符合契约；无需保证模型永不写错 ID |
| M4 请求 | `compileNarrativeContext.test.ts` 断言当前 state 优先于旧 memory、必要内容保留并报告 overflow、可选内容有界裁剪；`liveNarrativeBundleSource.test.ts` 检查旧话、独立 Event payload 出现在最终请求，并验证完整预算溢出时零 provider 调用；统一 request client 对 author/NPC/review/summary 执行预算和逐次发送预留 | 有最终请求及发送前拒绝证据 |
| M5 持久化 | `sqliteNarrativeMemorySummaryRepository.test.ts` 覆盖独立 revision/CAS、原文同序号改写、损坏缓存重建、倒退水位、跨 observer、来源变化及实际 SQLite 重开；发布在事务中重新校验来源，不写权威 gameplay 状态 | 缓存不能覆盖游戏行动或串史 |
| M6 调用恢复 | `generatePendingNarrativeBundle` 从持久固定包恢复；已有候选但缺包、来源失效、过期租约或仓储不可用显式失败；只有摘要预算耗尽可走原文路径；SQLite attempt 与 `narrativeRecoveryJourney` 覆盖额度跨重启、租约接管、旧 worker 拒绝；P2 脚本回放覆盖维护请求与状态 | 使用既有恢复契约，不增建平台 |
| M7 正式闭环 | 已有真实连续水位29→47→61，概览来源6,628/8,530跨过旧预算；两臂实际调用及严格回放；实际 UI 8行动/25 HTTP、刷新一致、唯一 item_given、revision52合法成功终局，旧 History 逐字保留 | 沿用已核实的真实证据 |

M1 的测试不是仅检查检索中间值：fixture provider 收到最终 messages 后，同时核对原话与 ID；`inRecalledSourcesAndRequest`还要求原话确实来自 prepared context 的 recalled。模型答复来自 fixture，因此不声称真实模型回答质量已验证。M7 原始证据见[三项收尾报告](2026-09-15-narrative-p2-closeout.md)。

上述测试名分别归属 `src/game/gameplay/rpg/narrativeMemory/`、`src/game/application/`、`src/game/application/testing/`、`src/game/application/server/ai/` 及 `src/game/application/server/persistence/`。本轮逐项核对实现与关键断言，未发现需要新增修复的 P2 阻断工程缺陷，没有为封板制造功能或镜像测试。

## 本轮验证

- `npm test -- --minWorkers=1 --maxWorkers=2`：231文件、2,956项通过；1项显式 live 开局质量测试跳过。已包含128项依赖边界和3项日志边界，未重复运行。日志在`artifacts/narrative-p2/p2-engineering-tests.log`。
- `npm run typecheck`：通过。
- `npm run lint`：0错误、50条现有未使用符号警告；本轮没有修改代码，不以无关清理扩大范围。
- `npm run test:narrative-p2-script`：31项通过，0失败，包含五幕完整生产 fixture、摘要/两臂严格回放、SQLite分段接续及v3独立诊断。
- `npm run check:docs`：0错误、1条现有运行时AI文档篇幅提醒。人工复核本轮文档归属与链接，`git diff --check`通过。

没有 production build 或调用链变更，因此不重复 build 或重新实跑随机故事。工程验证不等于证明模型永不违反提示，也不等于通过旧质量协议。

## 结论边界

全部本轮检查完成，按工程矩阵判定 P2 工程通过；不再用旧3.4分或真实概览未自然省略 oracle 阻塞。任何后续确认的漏送必要上下文、知识越权、接受非法引用、重复结算、状态污染或恢复缺陷仍须修复，不能归因模型而豁免。

冻结旧样本继续保持原质量及实验结论。此工程范围不要求严格两臂因果实验或整条 UI transport 回放；相关未执行事实保留，不冒充完成。后续叙事质量、玩法分化和 main 比较需独立明确范围，不回流为 P2 无限细节修正。
