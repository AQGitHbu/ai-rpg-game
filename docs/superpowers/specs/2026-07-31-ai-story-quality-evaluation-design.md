# Spec：AI 故事质量评估方案与基线（Story Quality Evaluation）

> 日期：2026-07-31 ｜ 状态：approved（2026-08-01 评审修订） ｜ 关联 Plan：`docs/superpowers/plans/2026-07-31-ai-story-quality-evaluation.md`

## 1. 背景

运行时叙事由三个受审批的 AI 角色接力生成（director → writer → NPC，见 `docs/策划文档/运行时AI角色职责与生成规则.md`），审批只保证**结构与权限合法**（字段、引用、知识边界、选项合法性），不保证**故事好看**。三角色当前的 system prompt（`src/game/application/server/ai/liveRuntimeNarrativeSources.ts`）几乎全部是 JSON 结构与 ID 复制约束，没有显式的叙事质量引导指令（悬念、铺垫、人物声线）。

同时，现有安全契约规定 fixture 与日志**不保存 prompt 和模型原文**（`docs/agent/日志与追踪.md`、`docs/agent/运行时AI导演与场景表演.md`），因此现状下无法拿到完整生成素材做离线质量评估。

在开始 prompt 调优之前，必须先有可重复的评估标准和基线：否则每轮改动无法判定是变好还是变坏。本 spec 定义评估量表、评估专用采集通道、长故事评估旅程、客观指标与 LLM 评审管线，以及分阶段基线流程。

## 2. 目标

1. 建立版本化的 AI 内容质量评估标准（9 个故事级维度 + 4 个场景级维度 + 确定性客观指标），落为 `docs/archive/AI内容质量评估标准.md` v2，作为评审 prompt 的唯一事实源。
2. 新增评估专用采集通道：仅当 `STORY_EVAL_CAPTURE=1` 时由 composition 层向 AI source 工厂注入捕获回调、向编排层注入审批观察回调（prompt/模型原文只在 source 内部可见、审批结果只在编排层可见，外部装饰器拿不到，见 §6.1），落到本地 `artifacts/story-eval/<run-id>/`；未设置开关时装配与行为与现状完全一致。
3. 新增可复现的长故事评估旅程脚本：以 `gameLength=long`（8 幕主线）真实跑完整局，seed 驱动的确定性选择策略，产出玩家视角故事流水。
4. 新增零 AI 成本的客观指标分析脚本与 LLM-as-judge 评审脚本（评审模型严格复用配置的 `AI_MODEL`，不接受模型覆盖），输出结构化分数、证据引用与人工抽查清单。
5. 建立覆盖三种已支持题材、两种玩家策略和两类故事前提的版本化评测集；基线按案例、题材和策略分别报告，不能把单一武侠旅程或仅三次随机运行外推为整体质量。
6. 在首个真实试点后校准评审：两位人工评审独立复核预先抽取的证据包；只有证据可追溯、人工分歧可解释时，才将 LLM 分数用作比较依据。
7. 全流程遵守既有安全红线：不改日志脱敏、fixture 格式、审批红线、journey 契约；真实计费调用一律显式 env 开关；日常回归零网络零计费。

## 3. 非目标

- 不做任何 prompt 调优改写——基线数据出来后另起 spec（已知靶点：三角色 system prompt 缺叙事质量指令、writer 选项文案被规则覆盖、导演 pacing 缺指导）。
- 不给开局蓝图单独量表（蓝图作为评审素材与上下文纳入，其质量通过 S7 结局兑现度、S3 铺垫回收间接反映）；不评估小镇语义规划。
- 不做评审结果可视化 UI、不把分数自动设为发布门禁；试点所需的人工复核属于评估可信度验证，不是日常双模型评审。
- 不修改 `@ai-game/*` foundation package。

## 4. 评估范围与角色对应

评估对象是玩家实际读到的故事，由以下 AI 产出（其余系统零 AI，不评）：

| 生成点 | 评估地位 |
| --- | --- |
| director（场景计划、pacing/tension、扩展提议） | 核心：S1/S2/S6/C3 的直接责任方 |
| writer（narration、选项包装、NPC 表演指令） | 核心：S3/S8/C2/C4 的直接责任方 |
| NPC 表演者（台词、情绪） | 核心：C1 的直接责任方 |
| 动态蓝图扩展（proposedNewLocations 含 reason；proposedNewNpcs 无 reason 字段） | 核心：S5 的直接素材——reason 对照只适用于地点提议，NPC 提议以其 role/description 声明的定位为兑现对照 |
| 开局蓝图生成器 | 素材：提供世界观/NPC 档案/任务结构/双结局作为评审对照，不单独打分 |
| 小镇语义规划 | 不纳入 |
| 战斗、结局、任务裁决 | 零 AI（确定性规则），只评战斗**前**的铺垫文本（S6） |

## 5. 评估量表（v1）

### 5.1 故事级维度（整局一次评分，1–5 分）

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

### 5.2 场景级维度（逐场景/抽样评分，1–5 分）

| # | 维度 | 评分口径与边界 |
| --- | --- | --- |
| C1 | NPC 身份、声线与关系一致性 | 只评语气、用词、性格、关系阶段是否符合该 NPC 的姓名、role、description、已知事实与最近交互摘要；不同 NPC 应可区分。知识越权已由规则审批硬性保证，不重复评。 |
| C2 | 场景衔接连续性 | 与**紧邻前序场景**及当时结构化记忆无矛盾；无凭空引用的事件、地点或人物关系。 |
| C3 | 选项抉择质量 | 实际评的是 director 挑选的两个行动是否构成有意义的策略差异。架构约束：writer 写的 label 会被规则文案（candidate.publicLabel）替换后才展示、strategy 不进入持久化状态即被丢弃，玩家看到的选项文字不是 AI 写的——若基线发现选项无聊，改 prompt 无效，需改规则文案或放开 writer 文案（记为发现，不在本 spec 内修）。 |
| C4 | 文本质量 | 重复感/流水账、辞藻堆砌、与 sceneGoal 的相关度；含文风与世界观一致性（跨场景不串腔、与开局蓝图设定不脱节）。 |

抽样：C1 对全部含 NPC 台词的场景逐条评；C2–C4 每幕抽 2 个场景（seed 确定性抽样）。每个 C1 包必须带该 NPC profile/relationship/最近接触；每个 C2 包必须带紧邻前序场景与当时 memory 摘要，不能只交给 judge 孤立场景。幕边界与主线阶段对齐（不用任务事件切分——`quest_completed`/`quest_failed` 事件本身只带 questId，须关联蓝图 quest.kind 才能区分主线/支线，且正常通关不触发 `quest_failed`）：`story.jsonl` 每条场景记录当时的主线阶段序号（驱动侧经 §7 的评估专用 repository 读取 `GameRecord`，用 `deriveContentProgression({ blueprint, state })` 计算——entry points 公开视图不含该数据），同一阶段的场景为一幕；幕数上限即 BudgetPolicy 的 mainActs（long=8），实际幕数少于上限时按实际数评估并在报告中注明。

### 5.3 客观指标（确定性计算，零 AI 成本）

- 整局 fallback 率；各角色重试率与 invalid_json 率；审批驳回分类分布。
- tensionLevel 曲线（完整序列 + 标准差作为平坦度）；pacing 分布与顺序合法性。
- 每幕事实揭示密度（两种口径：**计划揭示** = `directorPlan.allowedRevealFactIds` 集合；**实际揭示** = `story.jsonl` 具 `factId` 的 `fact_discovered` 事件集合）。报告并列 `planned / actual / overlap / missed`，不以仅有事件类型的记录代替事实 ID；相邻场景 narration 字符 3-gram 重复率；narration/台词长度分布。
- 实体漏斗：初始及扩展实体的 `introduced → interacted/used → quest/relationship/fact/battle/ending contribution`，按 NPC、地点、物品分列；扩展提议的 approval rate 与 adoption rate 分开，后者只能表示实体已持久化且在故事中首次登场。
- 选择漏斗：每一对选项的 actionKey、规则状态差异、分支后两场的事件/叙事差异及可见后果；没有成对分支证据的 run 不得为 S8/S9 给出高于 3 分的结论。
- 场景总数与是否收敛到结局（场景上限内，见 §7）。

### 5.4 人工抽查清单

评审报告自动列出：所有任一维度 ≤2 分的场景 + 每局 seed 随机 3 个场景，附检查要点（身份/声线、连续性、选项差异、实体功能、证据引文），由人工复核评审模型的判断是否成立。试点另从高、中、低分各抽取固定证据包，交由两位人工评审独立标注；分歧 >1 分或证据不支持结论时必须记录原因并修正量表/prompt。量表变化则升版本。

## 6. 采集通道设计

### 6.1 采集点（三处，各取其唯一可见的数据）

架构事实（决定本设计）：prompt messages 与模型原文只在 live source **内部**可见——source 对外只返回解析后候选，现有脱敏录制装饰器只能保存 context hash 正因如此；审批结果只在应用编排层可见（`orchestrateNarrativeScene` 调用 gameplay 审批门面，source 只做审批前机械归一）；玩家选择与规则事件只在驱动侧可见。因此采集不是单一装饰器，而是三个采集点写同一 run 目录：

1. **source 工厂捕获回调（`calls.jsonl` 主体）**：`createLiveScenarioCandidateSource` 与 `createLiveRuntimeNarrativeSources` 新增可选 `captureSink` 参数，在内部 transport 调用处一次拿齐：角色、尝试序号、完整 prompt messages、模型原始输出、解析后候选、延迟 ms。两个工厂中间层需同步新增该可选参数并透传到 live source——`runtimeNarrativeSourceFactory.ts` 的 `createRuntimeNarrativeSources` 与 scenario 侧的 `createScenarioCandidateSource`（二者当前均在工厂内部硬编码 transport 创建）；未传入时行为与现状完全一致。
2. **编排层审批记录（`calls.jsonl` 补充）**：`OrchestrateNarrativeSceneInput` 新增可选 `approvalObserver` 字段（该函数是平面 input 类型，不是 deps 模式），把每个角色的审批通过/驳回分类与**已批准导演计划摘要**（sceneGoal/pacing/tensionLevel/focusNpcId/扩展裁决）按 traceId+角色+尝试序号写入，与第 1 点记录关联。回调从 composition root 沿现有调用链透传：`RuntimeNarrativeTaskCoordinator` → `generatePendingNarrativeScene` → `orchestrateNarrativeScene`（各层新增可选字段，未传时行为不变）。审批结果与 tensionLevel 当前在编排函数内部消费后即丢弃、不持久化到事件与视图，此回调是外部获取它们的唯一途径。
3. **驱动侧故事流水（`story.jsonl`）**：由评估旅程脚本组装写入——只有驱动侧同时看得到场景视图、玩家选择与规则事件。浏览器手玩局 v1 只产出 `calls.jsonl`（服务端装配层生效），不产出 `story.jsonl`（无驱动方）。

### 6.2 模块与装配

新建 `src/game/application/server/ai/storyEvalCapture.ts`：`StoryEvalSink` 接口 + `createFileStoryEvalSink`（同步追加写 JSONL；写失败静默降级，绝不抛错到游戏主流程，与日志 sink 同一容错哲学）。

`src/game/application/server/compositionRoot.ts` 仅当 `STORY_EVAL_CAPTURE=1` 时创建 sink 并注入捕获回调与审批观察回调；未设置时全部为 undefined，装配与行为与现状完全一致（零开销、零行为变化）。run-id 取 `<ISO时间戳>-<pid>`（沿用 phase10 惯例）。

### 6.3 产物（`artifacts/story-eval/<run-id>/`）

| 文件 | 写入方 | 每条记录 | 用途 |
| --- | --- | --- | --- |
| `calls.jsonl` | source 捕获回调 + 编排层审批回调 | 角色（scenario/director/writer/npc）、traceId、尝试序号、完整 prompt messages、模型原始输出、解析后候选、延迟 ms；审批记录（通过/驳回分类）按 traceId+角色+尝试序号关联 | prompt 调优诊断 |
| `story.jsonl` | 旅程驱动脚本 | 场景序号、当时主线阶段序号、玩家可见 narration、NPC 台词与情绪、两个选项最终展示文案、导演计划摘要（含 allowedRevealFactIds、introducedEntityIds、扩展提议及裁决）、是否 fallback、玩家实际选择及策略理由、带安全 ID 的规则事件（factId/entityId/questId/endingId）、当时 memory 摘要、NPC relationship/最近接触摘要 | LLM 评审与人工阅读的评估正文；字段不足时相应维度不得评分 |
| `manifest.json` | 旅程驱动脚本 | gameId、世界 seed、策略 seed、评测 caseId、代码提交、prompt/契约版本、模型及推理参数、开局蓝图快照（世界观、事实、地点、NPC 档案、物品、敌人、任务结构、双结局）、S4 answer key | 评审对照上下文 + 可比较的复现信息 |

### 6.4 安全红线

- 不改动现有日志脱敏、fixture 录制格式、journey 脚本契约中的任何一项。
- `calls.jsonl` 含 prompt 原文：产物目录不进 git（`artifacts/` 已在 .gitignore）；`AI_API_KEY` 等凭据永不落盘。
- 采集失败不影响游戏流程；`STORY_EVAL_CAPTURE` 未设置时不产生任何文件、不改变任何装配。

## 7. 评估旅程脚本

新建 `scripts/storyEvalJourney.mjs`（env 门禁 + spawnSync vitest 子进程，沿用 `scripts/phase11StoryContinuityJourney.mjs` 的门禁模式，配 `storyEvalJourney.node-test.mjs`）与旅程本体 `src/game/application/testing/storyEvalJourney.test.ts`。

- 驱动路径：旅程本体经 `createServerGameEntryPoints`（composition root）驱动——这是唯一能命中 §6.2 装配点、且与浏览器局同一条服务端路径的方式（phase11 旅程测试绕开 composition root 手工构造 deps，本旅程不沿用该内部模式）。entry points 的 ensure 不等待 provider，驱动循环轮询场景直至 ready（带超时：单场景等待上限 `STORY_EVAL_SCENE_WAIT_MS`，见 §10；真实运行由门禁脚本注入 420s，覆盖三角色各至多 120s 的最坏情形——60s 固定值在真实延迟下会让旅程在后台任务完成前退出，测试进程退出即掐死飞行中的 AI 调用，pending 永不清理）。entry points 刻意不暴露 repository/actionKey/seed/蓝图（安全红线不动、不新增公开 API）：驱动侧另以 `createSqliteGameRepository` + 同一 `GAME_DB_PATH` 打开一个**评估专用 repository**（server-only 测试进程内、只读使用），从 `GameRecord` 读取 actionKey、主线阶段、世界 seed、蓝图、memory、关系和结构化事件，不经过任何客户端投影。
- 开关与环境穿透：必须显式 `RUN_REAL_AI_STORY_EVAL=1` 才发真实计费调用；未设置时打印提示 exit 0。门禁脚本向子进程 childEnv 显式传递 `STORY_EVAL_CAPTURE=1`、run 目录、`STORY_EVAL_SEED` 与指向 `tmp/` 临时 SQLite 的 `GAME_DB_PATH`（参照 phase11 传递 artifact 目录的方式）。
- 单局流程：创建 `gameLength=long` 新局（开局 AI 不可用则本次运行判失败并如实报告，不评 fallback 开局）→ 轮询 ready → 记录 → 按策略提交选择 → 直至结局或场景上限（默认 60：按 8 幕 × 约 6–8 场景/幕 ≈ 48–64 的上界取整，启发式安全阀而非领域预算，`STORY_EVAL_MAX_SCENES` 可配；超限如实记"未收敛"，本身是基线发现）→ 战斗阶段 attack 优先打完（`battle_action` 为独立 intent，与 phase11 现有实践一致）。每局结束先做 artifact completeness 校验；缺 `calls.jsonl`、必要 manifest、S4 answer key 或任一场的评估字段时标为 `incomplete`，不可进入分析或评审。
- 选择策略（可复现 + 覆盖面）：每个评测 case 至少运行探索优先和目标优先两种策略。对选项对比，驱动在预设的三个主线检查点从同一 ready `GameRecord` 快照复制两个隔离评估库，各执行两个 choiceToken 并继续两场；该成对 branch artifact 是 S8/S9 的唯一反事实证据。行动分类需要 actionKey，而客户端视图刻意不含 actionKey（安全红线），驱动侧经上述评估专用 repository 读取场景状态获得 actionKey——不经过客户端投影，不破坏红线。策略 seed、检查点与每次选择理由记入 `story.jsonl`。
- 评测集与复现边界：`data/story-eval/cases/v2.json` 定义 6 个固定 long case：wuxia、science_fiction、urban 各两种不同主线前提；每 case 运行两种策略，共 12 条主旅程。`STORY_EVAL_SEED` 只保证选择策略、分支检查点与抽样确定；世界 seed 和 AI 输出本身不可复现。每条 manifest 记录 caseId、worldSeed、代码提交、prompt/契约版本、模型/参数；跨版本比较只能在相同 caseId + 策略下做配对汇总，并把模型或参数变化单列。
- 失败处理：单局 fallback 率超 50% 时提前终止并标记 `aborted`，已采集数据保留。
- 多局：`--runs N`（策略 seed 依次递增），每局独立 run-id、独立临时 SQLite（落 `tmp/`，按既有 journey 清扫实践结束即清）。

## 8. 分析与评审脚本

### 8.1 `scripts/storyEvalAnalyze.mjs`（+ node-test）

纯离线：输入任意 run 目录，输出 `metrics.json`（§5.3 全部指标）。可对历史 run 重复执行，是每轮调优后的免费第一道体检。

### 8.2 `scripts/storyEvalJudge.mjs`

- 开关：`RUN_REAL_AI_STORY_EVAL_JUDGE=1` 才调用；模型严格使用 `AI_MODEL`；复用 `AI_API_BASE_URL`/`AI_API_KEY`。
- 输入只有经 completeness 校验的 `story.jsonl` + `manifest.json`；不喂 `calls.jsonl`（评审只看玩家视角，避免被内部计划带偏）。C1/C2 使用从这两份评估产物中裁出的身份、关系、前序和 memory 证据包，而非读取内部 prompt。
- 三段评审（约 10–20 次调用/局）：① 早期预测测试（S4，独立先行，**输入隔离**：只喂前 25% 场景 + manifest 中的非剧透部分——世界观与 NPC 档案，明确排除双结局、任务结构与后 75% 场景，防止答案泄漏）；② 故事级评审（S1–S3、S5–S9，此段才允许完整 manifest 与全部场景，逐维打分且每个分数必须附场景序号 + 引文证据，无证据重评一次）；③ 场景级评审（C1 全量、C2–C4 每幕抽 2）。
- 输出强制 JSON，本地 schema 校验：所有要求维度齐全、分数只能为 1–5、sceneIndex 必须存在、引文必须是相应证据包的原文子串。缺字段、越界或证据不成立即重试一次；仍失败则该维度记 `null` 并如实呈现，不编分。S4 不由 judge 自报分数，而由预测 JSON 与 manifest answer key 的确定性匹配器计算。
- 产物：`scores.json`（结构化分数 + 证据）+ `report.md`（人类可读，含 §5.4 人工抽查清单）。
- 量表事实源：judge 内嵌量表文本必须与 `docs/archive/AI内容质量评估标准.md` 一致，引用时标注文档版本号。

## 9. 基线流程

分两步，每步发真实调用前需用户确认：

1. **试点**：从 6 个固定 case 中选一个，完整执行两种策略和三个成对分支（调用量按实际记录）→ completeness 通过后跑采集/分析/评审 → 两位人工评审独立复核固定的高/中/低分证据包。分歧必须写入校准记录；修正管线或量表时升 v3。
2. **补齐**：校准通过后完成剩余 5 个 case 的两种策略（共 12 条主旅程）→ 按 case、题材、策略报告均值/中位数/最差值/空值率，并汇总客观指标为**基线 v2**，产出 `artifacts/story-eval/baseline-v2/report.md`。

基线定位：描述性快照，不是及格线。报告附建议门槛（如 fallback 率上限、C2 均分下限）供用户裁定。后续每轮 prompt 调优用相同 caseId、策略和分支检查点复测对比；若模型/参数变化，只能说明“该配置”的差异。`artifacts/` 不入 git，`report.md` 只是工作产物：持久基线以回填到 `docs/archive/AI内容质量评估标准.md` 的各维度分数表、客观指标摘要、校准结果与关键发现为准。

文档归档：基线数值回填 `docs/archive/AI内容质量评估标准.md`；实现事实新建 `docs/archive/AI内容质量评估.md` 并更新 `docs/Agent文档索引.md`。

## 10. 环境变量（全部可选，未设置零影响）

| 变量 | 作用 |
| --- | --- |
| `STORY_EVAL_CAPTURE` | `1` 时 composition 层装配采集回调 |
| `STORY_EVAL_ARTIFACT_DIR` | 覆盖产物目录（门禁脚本逐局注入 `artifacts/story-eval/<run-id>/`；缺省派生 `<ISO 时间戳>-<pid>`） |
| `RUN_REAL_AI_STORY_EVAL` | `1` 时评估旅程脚本才发真实计费调用 |
| `STORY_EVAL_SEED` | 选择策略与抽样的确定性种子 |
| `STORY_EVAL_MAX_SCENES` | 单局场景上限（默认 60，安全阀） |
| `STORY_EVAL_SCENE_WAIT_MS` | 单场景生成等待上限（默认 60000，仅离线 mock 量级；真实 provider 单次调用最长 `timeoutMs=120000`、一场景至多 3 次角色调用，门禁脚本注入 `3*120000+60000`=420000，覆盖最坏情形） |
| `STORY_EVAL_TOTAL_BUDGET_MS` | 单局旅程总预算（默认 90 分钟，门禁脚本注入同值；超预算时旅程优雅收尾并如实记 `status=time_budget`，产物仍完整可分析——避免被 vitest 测试超时直接掐死导致 manifest 丢失；vitest 超时=预算+10 分钟安全余量） |
| `RUN_REAL_AI_STORY_EVAL_JUDGE` | `1` 时评审脚本才发真实计费调用 |

`.env.example` 补注释说明（全部注释掉、不含默认值），并区分两类设置惯例：`RUN_REAL_AI_*` 沿用现有惯例只在 shell 中为单次脚本运行设置、不持久化；`STORY_EVAL_CAPTURE` 是服务端装配开关——评估旅程由门禁脚本自动传给子进程，浏览器手玩采集则需在启动 dev server 的 shell 中临时设置（同样不持久化到 .env.local，避免忘关后 prompt 原文长期落盘）。

## 11. 测试与验收（离线，零网络零计费）

- TDD：sink 单测；source 工厂捕获回调测试（注入假 sink 断言记录完整且不改变 source 返回值与重试行为）；编排层审批回调测试；compositionRoot 开关装配测试（env 未设置时不产生文件、装配与现状一致）；旅程本体测试用注入假 transport 全链路验证；analyze 的指标计算与 judge 的评审编排/输出结构各配离线测试。
- `npm run lint`、`npm run typecheck`、`npm test`、`npm run test:boundaries` 全绿；`STORY_EVAL_CAPTURE` 未设置时 `npm run journey:phase10` 行为不变。
- analyze/judge 对手工构造的假 run 目录产出正确结构。
- 真实基线执行结果按事实记录（真实调用是否发生、几局收敛、几局 aborted），不把 fixture/假 transport 通过写成真实调用成功。

## 12. 风险与开放问题

- `gameLength=long` 8 幕主线能否在默认 60 场景上限内收敛未经验证——试点局的首要观测点，若不能收敛如实记录为基线发现。
- 同模型评审自身产物存在自我偏袒风险——由人工抽查校准；评审仍固定使用配置模型，不通过环境变量切换模型。
- **人工交叉校准**：试点局（1 局 long）完成后，由两位人工评审对同一份 `story.jsonl` + `manifest.json` 做独立复核。分歧（均值差 > 0.5 或任一维度差 ≥ 2 分）由人工裁定并记录在基线报告中。
- writer 选项文案被规则覆盖限制了 C3 的调优空间——基线阶段只记录，是否放开 writer 文案另行决策。
