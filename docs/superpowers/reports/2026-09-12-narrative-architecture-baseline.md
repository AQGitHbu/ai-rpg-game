# 剧情架构优化：基准现状与问题证据

## 1. 用途与证据边界

本文保存本次架构设计所依据的基准快照与历史实验结论，不定义当前生产契约，也不表示新架构已实施。目标与拟议修改见 [架构 Spec](../specs/2026-09-12-narrative-architecture-design.md)。

| 对象 | 固定基准 | 用途 |
| --- | --- | --- |
| main | `ca189eb12011d493f21bb50652fbfe1324387599` | 新分支起点 |
| main 生产代码参考 | `60f0e873` | `ca189eb1` 相对它只新增四类信息设想文档，生产代码相同 |
| staged-narrative-generation | `3edcee4d043e94f24ebcb47110f3890414edddfa` | 保留的实验分支，不整支合入 |
| staged 最后完整矩阵 | `526ddf2c` | r5 的冻结版本；不能把结果归给后续 compact 版本 |
| 新工作分支 | `codex/narrative-architecture` | 从 main 分出的独立设计与后续实施分支 |
| 新 worktree | `.worktrees/narrative-architecture/` | 相对主仓路径 |

staged 相对共同代码基线有 60 个提交，包含实现、修复、文档与验收；提交数不等于 60 次独立实验。此次仅阅读代码和已有证据，没有重跑真实 API、游戏旅程或 main 对照。

## 2. main 已有能力

| 方面 | 基准事实 | 主要源码入口（仓库根相对路径） |
| --- | --- | --- |
| 生产生成 | initialization、narrative_choice、npc_free_text 进入完整 narrative bundle；移动和战斗等消费已批准步骤 | `src/game/application/generatePendingNarrativeBundle.ts`、`src/game/application/server/ai/liveNarrativeBundleSource.ts` |
| 规则提交 | 玩家行动先由规则结算并 CAS；后续生成失败保留已提交结果和重试任务 | `src/game/application/performTurn.ts`、`src/game/application/stateCommit.ts` |
| Entity | 八类固定实体；EntityStore 为实体事实来源，兼容集合由投影生成；main 的 EntityStore/WorldState/StoryState 版本分别为 2/6/8 | `src/game/domain/entity/entityRecord.ts`、`src/game/domain/entity/entityProjection.ts` |
| NPC | 人格锚点、目标、知识来源、方向性关系、承诺、结构化交互已存在 | `src/game/domain/entity/npcComponents.ts` |
| 持有与生命周期 | 物品唯一 owner；受控 mutation；实体 lifecycle 已存在 | `src/game/domain/entity/entityComponents.ts`、`src/game/gameplay/rpg/entityWorld/entityMutation.ts` |
| 历史与检索 | canonical event ledger、episode、因果与实体引用；required/quest/fact/entity/cause/location/salience/recency 排序 | `src/game/domain/events.ts`、`src/game/gameplay/rpg/narrativeMemory/retrieveNarrativeMemory.ts` |
| 上下文编译 | 已有 slot、来源、权威级别、必选/可选、优先级、去重与裁剪 manifest | `src/game/application/server/ai/narrativeContext/contextBlock.ts`、`src/game/application/server/ai/narrativeContext/compileNarrativeContext.ts` |
| 产品范围 | 短篇三幕、中篇五幕；固定选择与自由输入入口；已有地图、物品、战斗和终幕 | `docs/策划文档/AI生成RPG_MVP.md` |

## 3. main 的主要缺口

1. **长期剧情控制尚不完整。** `StoryState.unresolvedThreads` 为字符串 ID 集合，未形成完整 Thread 创建、推进、关闭闭环；数值幕进度和任务游标不能代替悬念、因果和持续后果。
2. **完整事件不等于完整表达历史。** `narrative_scene_presented` 不保存正文，`npc_interaction_recorded` 不保存台词；玩家原文按现行契约仅供当前回应。审计日志不能充当正式游戏历史。
3. **已有 NPC 字段不等于行为系统。** goals 有状态字段，但当前实体 mutation 明确未开放目标更新通道；关系承诺已有能力，应补齐具体前提和兑现条件，而非重造第二份承诺。
4. **行动的语义承载偏粗。** 对话裁决主要依据 dialogueAct/topic、关系档位及知识；自由输入当前映射为中性 talk/ask。具体证据、交易条件、请求和承诺不能仅靠文本留下持久后果。
5. **实体现状与认知表示有扩展空间。** 玩家实体只有 identity/position；玩家发现状态主要由 fact.discovered 承担。组织组件基本只有 attitudeToPlayer；缺少通用别名/身份揭露表示。
6. **检索入口偏结构化。** 已有 ID、任务与因果召回，但缺少完整的称呼消歧、经历描述反查事件、持续交谈主题机制；不能将这些描述为已完成的 keyword retrieval。

旧 Plan5 仍由阶段配置登记为 planned/not_started。其层级大纲方案可参考，但不能当成现有能力或自动成为本次实施计划。

## 4. staged 的实际架构及收敛过程

早期方案将规划、旁白、NPC、选项拆开；之后围绕知识、观察、节拍、表达任务、审批、恢复反复调整。`d00bb643` 收敛为规划器生成完整初稿，三个表达器只润色；`c01c564d` 又压缩 fresh planner 契约。

当前仍保留单元 DAG、场景快照、观察与披露依赖、逐单元批准、最终保真检查及持久任务恢复。`planningPrompt.ts` 明确规划器是完整场景作者；`polishPrompt.ts` 禁止润色器增删实质内容。主要入口：

- `src/game/application/server/ai/staged/planningPrompt.ts`
- `src/game/application/server/ai/staged/polishPrompt.ts`
- `src/game/application/narrativeGeneration/perspectiveContext.ts`
- `src/game/application/server/persistence/sqliteNarrativeJobs.ts`

`perspectiveContext.ts` 的 persona 投影把 anchors/goals 正文清空，保留公开身份和有限 delivery。此事实说明下游角色表达受限，不证明全局规划器完全看不到人格。

## 5. 实验事实与不能推出的结论

### 5.1 最后完整矩阵 r5

| 指标 | staged r5 | 历史 main |
| --- | --- | --- |
| 预定发布 | 12/18 | 9/9 |
| 首试发布 | 10/18，另 2 项传输重试后成功 | 8/9，另 1 项结构修复后成功 |
| 已发布样本配对文案均分 | 88.85/100 | 59.17/100 |
| staged 已发布明确事实错误 | 3/12，均来自初稿 | 没有按 r5 标准重新审阅 main |

18 项是两批题材开局及两条首轮分支，不是 18 个完整故事。6 项未发布没有文案评分；12 份新样本配对 9 份历史独立样本，部分历史样本复用。模型 thinking/请求策略不同，main 未重跑，因此不构成公平的架构因果实验或长期玩法证明。

已发布初稿的三类错误：把官面查问无效写成确定信息；增加唯一应急总线读取能力；把未知货种写成盐铁。润色保留了错误，最终检查通过。

科幻开局另有声明披露“储备接近枯竭”而正文未充分表达的失败；相同初稿经四次角色润色/披露检查仍失败。都市开局的另一次失败是最终 review 网络错误，不能归为叙事语义缺陷。两个开局失败还阻止了其四条后续分支启动。

### 5.2 compact planner 对照

固定诊断案例每臂 8 次：旧/compact 结构批准均为 7/8，联合干净样本为 6/8 对 4/8。该实验未获得预注册的正面改进证据；样本量和选样方式也不足以证明总体退步。它只比较 planner，不代表完整生成链或 main 替代验收。

### 5.3 可移植证据位置

已提交事实来源可在保留分支中读取，文件名相对该 worktree：

- `docs/superpowers/plans/2026-09-12-staged-draft-convergence.md`：r1–r5、约束与最终边界。
- `docs/superpowers/plans/2026-09-12-compact-planner-contract.md`：compact 注册标准与实际结果。
- `docs/agent/运行时AI导演与场景表演.md`：该分支运行契约。

更细原文在该 worktree 的被忽略产物中：`tmp/staged-draft-live-20260912-r5/复测报告.md`、`tmp/staged-draft-convergence/main-planner-reference.md`、`tmp/compact-planner-20260912/对照报告.md`。这些不是新分支的运行依赖；原始产物缺失时只能引用本报告及已提交记录，不能声称已复核原始样本。

## 6. 架构判断与保留策略

| 判断 | 证据力度 | 对新设计的约束 |
| --- | --- | --- |
| 原稿错误不能靠禁止改内容的润色器稳定修复 | 有实际失败样本及契约支持 | 未发布候选必须允许回到内容责任环节联合修订 |
| 合法 ID 与声明不证明正文含义正确 | 有实际漏检与披露失败 | 分开规则校验与语义审阅，不承诺绝对语义安全 |
| 长期信息缺口不是全部开局失败的原因 | 多项错误发生在开局 | 补记忆同时需要调整创作与批准边界 |
| 切分可能损伤场景连贯性、增加协议负担 | 架构推断，非受控因果结论 | 整场创作作为新假设，用完整旅程验证 |
| main 更适合作为重构起点 | 已有共享基础且生成链较少耦合 | 从 main 增量建设，不从 staged 拆除全套协议 |

staged 保留为证据和可选实现来源。实际选择原文保留、玩家/NPC 知识分离、持久任务与 SQLite 生命周期修复应按新接口分别评估；不整支合并，不照搬最终润色审查链，也不未经复核批量 cherry-pick。
