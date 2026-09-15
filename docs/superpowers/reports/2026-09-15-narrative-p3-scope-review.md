# P3 范围与代码核查

## 结论与基准

P3 应优先补“取得证据→改变角色合作条件→改变后续行动→保留终局后果”，继续使用现有整场生成与记忆体系。当前主要缺口是已有资料和规则尚未持续驱动玩法，不是 Entity 种类少，也不是缺少另一套检索器。

核查基准：`codex/narrative-architecture` / `.worktrees/narrative-architecture`，`7ccfa57d`。开始核查时工作区干净。本次读取 P1/P2 Plan、收敛任务、最新验收及相关生产实现/测试，不运行新 live，不修改生产代码。实施入口见 [P3 Plan](../plans/2026-09-15-narrative-architecture-p3.md)。

## P1/P2 已经完成什么

- [P1 Plan](../plans/2026-09-12-narrative-architecture-p1.md)已由首版十项建设收敛为完整递送主线、真实 UI 和同初态退出对照。History、四种互动、Thread、角色私密判断、整场作者、条件终局、有限重试及 SQLite 恢复已存在；旧保密样本及六路线/main 对照没有被补成通过。
- [P2 Plan](../plans/2026-09-14-narrative-architecture-p2.md)的当前完成定义是工程范围。[工程验收](2026-09-15-narrative-p2-engineering-acceptance.md)已核对 M1–M7，包括实际请求、observer 权限、原文恢复、摘要独立缓存、固定记忆包、持久额度与正式 UI。
- [P2 三项收尾](2026-09-15-narrative-p2-closeout.md)记录了真实水位推进、两臂调用/回放与 UI 终局，也保留全文均分 3.4、可见选择后果 2 分的观察。工程通过不等于文学质量或优于 main 已通过；P3 不以重跑旧质量实验作为准入。

P3 继承当前 **EntityStore3 / World7 / Story12 / Bundle2** 和 Node 内置 SQLite，不再按旧 Plan 的 Entity3/Story10 或 libsql 接口设计。P2 的 50/10、带来源摘录、固定 observer 包和请求预算不作为本期重构对象。

## 代码发现与实际含义

下列路径相对仓库根。能力存在以生产入口和消费者为准，不能以类型枚举或 fixture 的存在推定已经可玩。

| 核查点 | 当前代码证据 | P3 处理 |
| --- | --- | --- |
| Entity 基础 | `src/game/domain/entity/entityRecord.ts` 有八类固定 record；NPC 已有 anchors/goals/knowledge/relationships/history/interactions，Fact 已有调查 label/approaches | 复用这些组件；增加调查准入、目标结算、引荐/核验固定条款及具体任务完成条件，不扩种类或通用组件平台 |
| NPC 目标 | `entityWorld/entityMutation.ts` 有 `set_npc_goal_status`；生产检索到的是定义、校验和上下文读取，没有正式规则调用者持续推进目标 | 增加有来源的目标结算，并让状态被互动/调查准入消费；不能只往 prompt 多写几个目标 |
| 当前互动 | `domain/storyInteraction.ts` 仅保密、引荐、核验、分享事实；`resolveStoryInteraction.ts` 能检查条件、知识/听众及承诺，但提案身份按 job 铸造 | 本期不新增操作枚举；引荐/核验必须受 NPC 内不可弱化的静态条款约束，防止下一轮换提案绕开条件 |
| 普通选择 | `narrativeBundle/descriptors.ts:choicesForNpc` 无互动时生成 support/challenge；有互动时使用已安装互动 ID | 候选集合应体现可执行调查与合作条件；旧两项态度不能绕过新条件完成任务 |
| 调查处于非生产入口 | `ruleEngine/resolveByType.ts:resolveFactDiscovery` 已产生 approachId/quality/张力与发现事件；`autoResolveCurrentInvestigation` 自动确认当前事实；descriptor 将 discover_fact 当零行动目标 | 显式区分自动观察与主动调查；后者必须由玩家选择方法，不能被自动发现、槽折叠或目标游标吞掉 |
| 调查的现有来源字段 | `events.ts:FactDiscoveredPayload` 已有可选 witnessNpcIds；现有玩家调查默认无 NPC 听众，没有玩家建筑内部的权威位置 | 复用事件字段；本期调查限独立 scene，公开方法仅让确实在场且明确列出的见证者知情，私下查阅不广播 |
| 任务推进 | `reconcileQuests.ts` 结合 `isObjectiveSatisfied` 与 dialogueSession；`worldEvolution/approveWorldDelta.ts:deriveActObjectives` 依种子形状拼线性目标 | 给需要真实合作的 talk objective 加可选完成条件；新 P3 切片按实际声明依赖排序，不按种子删掉关键调查或强制两次态度回应过关 |
| 自由输入 | `application/actionConverter.ts` 将焦点输入映射成 `talk/ask/utterance`；P2 已使追问不消耗正式回应计数 | 保留；作者从完整合法候选中呈现符合策略的选项，玩家点击后才结算，不新增 intent provider |
| 角色判断 | `prepareNpcNarrativeContext.ts` 只选择一个当前同场焦点；`response` 与互动提议经 outward 权限投影 | 保留单角色边界；私密动机用于反应，合作权限由已批准规则条款决定，不把模型一句 cooperate/refuse 当作改规则 |
| 生成边界 | `pendingNarrativeJob.ts:classifyProviderDecisionBoundary` 限初始化/正式选择/焦点自由输入；`performTurn` 对缺失线性续接拒绝写入 | 增加调查结果及变化回访两类受控入口，复用原 A/B、同 job 重试、固定记忆包；不加第二条 source |
| 记忆基础 | `prepareNarrativeMemory.ts`、`retrieveStoryEvidence.ts`、`projectObserverEvidence.ts`、`buildNarrativeMemoryContext.ts` 已完成 P2 闭环 | 新目标/调查证据作为现有查询和 mandatory 引用输入；不新增向量库、摘要器或递归检索层 |
| 终局 | `endingDecision.ts`、`performTurn`、获批 endingOutcomes 已绑定实际结局消费 | 沿用二主题表现；先前证据、目标、承诺及合作后果必须被结果投影保留，不重建结局树 |

表中 gameplay 路径省略的共同前缀为 `src/game/gameplay/rpg/`，domain/application 路径共同前缀为 `src/game/`。本核查没有把尚未进入生产链的旧 fixture 路径算作实现，也没有把已有字段重复列成新系统。

## 已确认的产品取舍

本轮用户已明确确认：

1. P3 以有后果的选择、主动证据调查、NPC 目标与合作条件为主，先验证一个小故事；完整谎言/错误信念、离场 NPC 自主模拟与开放世界暂缓。
2. 自由输入继续“提出策略→生成可执行选项→点击后结算”。
3. 调查结果已结算，或回访相关状态已变化且没有可复用获批场景时，可触发同一生成链；地图浏览和普通移动不额外生成。
4. 工程与玩法过关作为 P3 完成条件，文学质量单独报告，不以固定文学分数驱动反复修稿。

具体工程设计由 Plan 固定；若实现证明必须突破以上边界，应先回到用户确认，不能把复杂需求悄悄放入某个 Task。

## 三份参考的取舍

| 参考 | 已经吸收的部分 | P3 新增的使用点 | 暂不采用及原因 |
| --- | --- | --- | --- |
| [SillyTavern 分析](../../设想/SillyTavern_Architecture_Analysis_for_AI_RPG.md) §7–11、§21–23、§26–28 | 多来源查询、scope、Context Compiler、原文/摘要分层 | 当前目标、合作条件、调查来源进入业务槽；回访以当前 Entity 和原因 Event 为准；玩家与 NPC 仍分视角 | 不新造世界书、sticky/cooldown、概率激活、向量检索或 planner/renderer 多调用链；P2 已解决主要信息组织缺口 |
| [Entity/WorldState/Memory](../../设想/AI_RPG_Entity_WorldState_Memory_Architecture.md) §4–8、§11–12、§17–23、§33 | 固定组件、稳定 ID、别名、当前状态/历史分离、按需投影 | Fact 明确调查准入，NPC 目标有受控后果；只在实际具象化时补齐已有目标的具体证据绑定，复用原 Entity | 不为人物补完整人生、动态挂载任意组件、为每个装饰物建实体；不先展示后提取事实，不增通用实体合并器 |
| [四类长期信息](../../设想/AI_RPG_information_memory_context_spec.md) §2、§4、§6–10 | 唯一权威、原文长期保存、50/10 摘录、ID 双向召回、A/B 与权限 | 目标状态归 NPC，问题归 Thread，实际调查/选择归 History/Event；规划随合法选择调整；选项先有真实行动再表达；调查/回访继续原事务边界 | 不固定四个生成器，不引入全局私密摘要，不从拒答反推认知，不新增异步权威写回或生产剧情回退 |

这些参考没有要求一次实现所有模块。P3 的收益证据是“多取得了什么、谁实际知情、哪项合作改变、下一步因此不同”，不是多了多少字段、角色或请求。

## 明确后移

- 直接自然语言行动、谎言与相互矛盾信念、离场 NPC 时钟/行动模拟、多组织经济、装备交易、通用任务/分支图。
- 长篇、无限历史、数据库/索引服务扩容、第二轮摘要重构和额外审阅/润色角色。
- 只为提高单句评分的提示补丁、旧失败批次反复抽样、main 替代结论；main 同条件比较另行规划。

P3 工程与玩法验收要求真实路径和因果证据；文学表现单独阅读和报告，不能重启 P2 的无限质量收尾。
