# AI 内容质量评估标准（v2）

> 版本：v2 ｜ 日期：2026-07-31 ｜ 状态：approved（spec：docs/superpowers/specs/2026-07-31-ai-story-quality-evaluation-design.md）

本文件是 LLM 评审 prompt 与人工抽查的唯一事实源。量表变更时升版本号（v3…），
并同步更新 spec 与评审脚本读取逻辑。

## 1. 故事级维度（整局一次评分，1–5 分）

权重：S2、S4 为 1.5（悬念与不可预测性是当前最重的痛点），其余 1.0。故事级与场景级分数分开报告，不合并为单一总分。

**维度间区分说明**：S1（三幕式结构完整性）评 pacing 序列的递进性与幕间升级是否合理，关注的是"结构骨架"；S2（悬念持续性）评 tension 曲线与幕末钩子，关注的是"张力节奏"——二者在 1 分锚点都可能出现"平坦"描述，但 S1 的平坦指各幕叙事类型无变化（如全部是 setup 级推进），S2 的平坦指悬念与紧张感无波动（如全程无未解问题）。评审时须分别判断。

| # | 维度 | 1 分锚点 | 3 分锚点 | 5 分锚点 |
| --- | --- | --- | --- | --- |
| S1 | 三幕式结构完整性 | pacing 标签与文本脱节，各幕平铺无递进 | 结构可辨但转折（turn）生硬或高潮仓促 | setup→develop→turn→climax→resolution 在文本中层层递进，幕间有明确升级 |
| S2 | 悬念持续性 | 多数幕结束时没有未解问题，tension 曲线平坦 | 有主悬念但中段松弛，个别幕无钩子 | 每幕留有钩子，主悬念持续加压且文本张力与 tensionLevel 一致 |
| S3 | 铺垫与回收（只评信息线索） | 前期线索多数成为孤儿，或结局依赖未铺垫的信息 | 主线线索有回收，支线线索约半数落空 | 前 1/3 引入的关键线索在后 2/3 几乎全部回收，回收自然不生硬 |
| S4 | 不可预测性（早期预测测试） | 评审只读前 25% 即高置信全中结局与关键反转 | 能预测大方向但细节与反转有偏差 | 早期预测置信度低或方向错误，实际展开合理但未被猜中 |
| S5 | 实体引入功能性（只评实体） | 新登场 NPC/地点/物品多为背景填充，与主线无关 | 实体有功能但部分扩展提议的 reason 未兑现 | 每个首次登场与动态扩展实体都推动剧情或兑现其提议理由 |
> NPC 评估指引：NPC 提议以其 `role`/`description` 声明的定位为兑现对照。NPC 在登场场景中发挥了其 role 的预期功能即视为"已兑现"；仅登场后不再出现不视为缺陷，除非主线任务明确指向该 NPC 或该 NPC 承担了关键信息传递职责。`description` 作为辅助判断依据——NPC 在后续场景中提及了其 description 覆盖范围内的信息，即可认定有功能。 |
| S6 | 战斗铺垫合理性 | boss 战突兀出现，无动机建立与张力积累 | 有铺垫但张力积累不足或动机牵强 | boss 战前有清晰的动机链与逐幕升级的张力，战斗是剧情必然 |
| S7 | 结局兑现度 | 结局未回应主线冲突或与玩家行动矛盾 | 回应主线但部分悬念未闭合 | 结局回应主线冲突与主要悬念，与玩家行动逻辑自洽 |
| S8 | 选择后果感 | 选项选什么后续叙事都一样，选择无痕迹 | 部分选择被承接，部分被无视 | 上一幕的选择在下一幕叙事中被明确承接并体现差异 |
| S9 | 游戏性与玩家能动性 | 场景只换背景或复述信息，行动不改变可达信息、关系、资源、任务或风险 | 部分场景提供可理解的取舍，但中段常只剩形式选择 | 每幕至少有一种可读的取舍（信息、关系、资源、风险或路线），玩家行动持续改变可见局势并驱动下一幕 |

S4 评分规则：早期预测与故事级评审使用**独立的 callJudge 调用**（不共享对话状态）。评审模型只读前 25% 场景 + 非剧透 manifest（只含世界观与 NPC 档案，**不含**双结局、任务结构与后续场景），预测结局走向、boss 身份、关键反转并自报置信度（1–5）。评估器再把预测逐项同 run 的结构化 answer key 比对：高置信精确命中 2 分、低置信精确命中 1 分、仅方向命中 0.5 分、未命中 0 分；总命中率 `h = min(1, sum / 6)`，S4 为 `max(1, min(5, 5 - round(4h)))`。answer key 由开局蓝图的结局/敌人/任务结构和已收敛的事件结果生成，绝不传入预测 prompt。

**上下文隔离要点**：早期预测与故事级评审之间的顺序隔离（先评质量再测预测能力）防止了"评审模型在早期预测中已看到答案，在故事级评审中偏袒与自己预测一致的故事走向"的自我验证偏差。两个阶段的 prompt 内容互不重叠——早期预测的 manifest 不含结局与任务结构，故事级评审的 prompt 不引用早期预测结果。

## 2. 场景级维度（逐场景/抽样评分，1–5 分）

| # | 维度 | 评分口径与边界 |
| --- | --- | --- |
| C1 | NPC 身份、声线与关系一致性 | 只评语气、用词、性格、关系阶段是否符合该 NPC 的姓名、role、description、已知事实与最近交互摘要；不同 NPC 应可区分。知识越权已由规则审批硬性保证，不重复评。 |
| C2 | 场景衔接连续性 | 与**紧邻前序场景**及当时结构化记忆无矛盾；无凭空引用的事件、地点或人物关系。 |
| C3 | 选项抉择质量 | 实际评的是 director 挑选的两个行动是否构成有意义的策略差异。架构约束：writer 写的 label 会被规则文案（candidate.publicLabel）替换后才展示、strategy 不进入持久化状态即被丢弃，玩家看到的选项文字不是 AI 写的——若基线发现选项无聊，改 prompt 无效，需改规则文案或放开 writer 文案（记为发现，不在本 spec 内修）。 |
| C4 | 文本质量 | 重复感/流水账、辞藻堆砌、与 sceneGoal 的相关度；含文风与世界观一致性（跨场景不串腔、与开局蓝图设定不脱节）。 |

抽样：C1 对全部含 NPC 台词的场景逐条评；C2–C4 每幕抽 2 个场景（seed 确定性抽样）。每个 C1 包必须带该 NPC profile/relationship/最近接触；每个 C2 包必须带紧邻前序场景与当时 memory 摘要，不能只交给 judge 孤立场景。幕边界与主线阶段对齐（不用任务事件切分——`quest_completed`/`quest_failed` 事件本身只带 questId，须关联蓝图 quest.kind 才能区分主线/支线，且正常通关不触发 `quest_failed`）：`story.jsonl` 每条场景记录当时的主线阶段序号（驱动侧经 §7 的评估专用 repository 读取 `GameRecord`，用 `deriveContentProgression({ blueprint, state })` 计算——entry points 公开视图不含该数据），同一阶段的场景为一幕；幕数上限即 BudgetPolicy 的 mainActs（long=8），实际幕数少于上限时按实际数评估并在报告中注明。

**C1 证据包要求（身份/关系口径）**：每条 NPC 台词必须附带该 NPC 的姓名、role、description、关系 tier/affinity 与最近接触摘要（`relationshipSummary`，文本形式）及当时 memory 摘要。C1 只评语气、用词、性格、关系阶段是否符合该 NPC 的姓名、role、description、已知事实与最近交互摘要；不同 NPC 应可区分。知识越权已由规则审批硬性保证，不重复评。缺任一字段的 C1 输入不得送评——产物完整性校验（§7）已保证 NPC 场景携带该证据包，judge 侧同样拒绝缺包输入（`C1_EVIDENCE_INCOMPLETE`）。

**C2 证据包要求（前序/memory）**：每个 C2 包必须带紧邻前序场景的原文与当时 memory 摘要，不能只交给 judge 孤立场景；无紧邻前序场景的开局场景不参与 C2 抽样。C2 评该场景与紧邻前序场景及当时结构化记忆无矛盾；无凭空引用的事件、地点或人物关系。

## 3. 客观指标（确定性计算，零 AI 成本）

- 整局 fallback 率；各角色重试率与 invalid_json 率；审批驳回分类分布。
- tensionLevel 曲线（完整序列 + 标准差作为平坦度）；pacing 分布与顺序合法性。
- 每幕事实覆盖分两条链记录：**计划叙事引用** = `directorPlan.allowedRevealFactIds` 集合；**实际叙事引用** = 新产物 `story.jsonl` 的 `usedFactIds + npcUsedFactIds`；**规则调查** = `fact_discovered.factId` 事件集合，另列为 `discoveredFactIds`。报告并列 `planned / actual / overlap / missed / discovered`（`factsPerAct`：`plannedFactIds`/`actualFactIds`/`overlapFactIds`/`missedFactIds`/`discoveredFactIds`）。`allowedRevealFactIds` 只允许已发现事实，不能与 `fact_discovered` 直接做计划→发现的命中率；旧产物缺少使用字段时，分析器为兼容回退到规则发现事件并注明版本差异。相邻场景 narration 字符 3-gram 重复率；narration/台词长度分布。
- **实体漏斗**（按 NPC、地点、物品分列；`entities.npc/location/item`）：
  - `introduced`：`directorPlan.introducedEntities` 中该种类实体 ID 的去重集合大小；
  - `interacted`（interacted/used）：交互事件携带的该种类 `entityId` 去重集合大小——NPC=`npc_met`、地点=`location_observed`/`location_visited`、物品=`item_obtained`；
  - `contributed`：在含贡献事件（`fact_discovered`/`quest_*`/`battle_*`/`enemy_defeated`/`ending_reached`）的场景行中登场（introduced 或 interacted）的该种类实体去重集合大小。
  - **扩展实体漏斗**（`entities.expansion`）：`proposed`（`expansion_decision` 提案记录数）→ `approved`（ok=true 数）→ `persisted`（动态铸 ID `loc_dyn_*`/`npc_dyn_*` 在故事数据中可观测的实体数——编译铸 ID 同步于审批，登场即证明已持久化）→ `adopted`（已持久化且实际首次登场的扩展实体数）。adoption rate 与 approval rate 分开，`adopted` 只能统计已持久化且实际首次登场的扩展实体，绝不复用 `approved`；当前产物口径下任何登场即首次登场，`adopted` 与 `persisted` 数值一致，但语义上只统计"实际首次登场"。
- **选择漏斗**（`choices`，成对分支证据）：`pairedCheckpoints`（两个合法选项且各产出 branch.json 的检查点数）、`stateDifferent`/`eventDifferent`/`narrationDifferent`（状态差异=地点/事实/任务/关系/物品/战斗/ending 的 after 侧比较、分支后两场的事件差异、玩家可读文本差异，只统计实际存在差异的成对检查点——仅 actionKey 不同但状态/事件/文本均相同不得计为后果差异）、`notApplicable`（不足两个合法选项的检查点数，不伪造比较）。没有成对分支证据（`pairedCheckpoints === 0`）的 run 不得为 S8/S9 给出高于 3 分的结论：judge 侧在 `validateStoryLevelResult` 强制 cap 为 3 并注明 `"capped: no paired branch evidence"`，report 相应行标注"（上限约束：无分支证据）"。
- 场景总数与是否收敛到结局（场景上限内，见 §7）。

## 4. 人工抽查清单

评审报告自动列出：所有任一维度 ≤2 分的场景 + 每局 seed 随机 3 个场景，附检查要点（身份/声线、连续性、选项差异、实体功能、证据引文），由人工复核评审模型的判断是否成立。试点另从高、中、低分各抽取固定证据包，交由两位人工评审独立标注；分歧 >1 分或证据不支持结论时必须记录原因并修正量表/prompt。量表变化则升版本。
