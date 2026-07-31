# Spec：AI 故事质量评估方案与基线（Story Quality Evaluation）

> 日期：2026-07-31 ｜ 状态：approved ｜ 关联 Plan：待创建（writing-plans 产出）

## 1. 背景

运行时叙事由三个受审批的 AI 角色接力生成（director → writer → NPC，见 `docs/策划文档/运行时AI角色职责与生成规则.md`），审批只保证**结构与权限合法**（字段、引用、知识边界、选项合法性），不保证**故事好看**。三角色当前的 system prompt（`src/game/application/server/ai/liveRuntimeNarrativeSources.ts`）几乎全部是 JSON 结构与 ID 复制约束，没有任何叙事质量指令（悬念、铺垫、人物声线）。

同时，现有安全契约规定 fixture 与日志**不保存 prompt 和模型原文**（`docs/agent/日志与追踪.md`、`docs/agent/运行时AI导演与场景表演.md`），因此现状下无法拿到完整生成素材做离线质量评估。

在开始 prompt 调优之前，必须先有可重复的评估标准和基线：否则每轮改动无法判定是变好还是变坏。本 spec 定义评估量表、评估专用采集通道、长故事评估旅程、客观指标与 LLM 评审管线，以及分阶段基线流程。

## 2. 目标

1. 建立版本化的 AI 内容质量评估标准（8 个故事级维度 + 4 个场景级维度 + 确定性客观指标），落为 `docs/策划文档/AI内容质量评估标准.md` v1，作为评审 prompt 的唯一事实源。
2. 新增评估专用采集通道：仅当 `STORY_EVAL_CAPTURE=1` 时在 composition 层以装饰器包裹 AI source，把完整 prompt、模型原文、解析候选、审批结果落到本地 `artifacts/story-eval/<run-id>/`；未设置开关时装配路径与现状完全一致。
3. 新增可复现的长故事评估旅程脚本：以 `gameLength=long`（8 幕主线）真实跑完整局，seed 驱动的确定性选择策略，产出玩家视角故事流水。
4. 新增零 AI 成本的客观指标分析脚本与 LLM-as-judge 评审脚本（评审模型默认复用 `AI_MODEL`，可用 `STORY_EVAL_JUDGE_MODEL` 覆盖），输出结构化分数、证据引用与人工抽查清单。
5. 分阶段建立描述性基线 v1：先 1 局试点验证管线并人工复核评审可靠性，稳定后补 2 局，3 局汇总均值/最差值 + 全部客观指标。
6. 全流程遵守既有安全红线：不改日志脱敏、fixture 格式、审批红线、journey 契约；真实计费调用一律显式 env 开关；日常回归零网络零计费。

## 3. 非目标

- 不做任何 prompt 调优改写——基线数据出来后另起 spec（已知靶点：三角色 system prompt 缺叙事质量指令、writer 选项文案被规则覆盖、导演 pacing 缺指导）。
- 不给开局蓝图单独量表（蓝图作为评审素材与上下文纳入，其质量通过 S7 结局兑现度、S3 铺垫回收间接反映）；不评估小镇语义规划。
- 不做评审结果可视化 UI、不做双模型交叉评审、不做评审结果自动门禁（基线是描述性快照，不是及格线）。
- 不修改 `@ai-game/*` foundation package。

## 4. 评估范围与角色对应

评估对象是玩家实际读到的故事，由以下 AI 产出（其余系统零 AI，不评）：

| 生成点 | 评估地位 |
| --- | --- |
| director（场景计划、pacing/tension、扩展提议） | 核心：S1/S2/S6/C3 的直接责任方 |
| writer（narration、选项包装、NPC 表演指令） | 核心：S3/S8/C2/C4 的直接责任方 |
| NPC 表演者（台词、情绪） | 核心：C1 的直接责任方 |
| 动态蓝图扩展（proposedNewLocations/Npcs + reason） | 核心：S5 的直接素材 |
| 开局蓝图生成器 | 素材：提供世界观/NPC 档案/任务结构/双结局作为评审对照，不单独打分 |
| 小镇语义规划 | 不纳入 |
| 战斗、结局、任务裁决 | 零 AI（确定性规则），只评战斗**前**的铺垫文本（S6） |

## 5. 评估量表（v1）

### 5.1 故事级维度（整局一次评分，1–5 分）

权重：S2、S4 为 1.5（悬念与不可预测性是当前最重的痛点），其余 1.0。故事级与场景级分数分开报告，不合并为单一总分。

| # | 维度 | 1 分锚点 | 3 分锚点 | 5 分锚点 |
| --- | --- | --- | --- | --- |
| S1 | 三幕式结构完整性 | pacing 标签与文本脱节，各幕平铺无递进 | 结构可辨但转折（turn）生硬或高潮仓促 | setup→develop→turn→climax→resolution 在文本中层层递进，幕间有明确升级 |
| S2 | 悬念持续性 | 多数幕结束时没有未解问题，tension 曲线平坦 | 有主悬念但中段松弛，个别幕无钩子 | 每幕留有钩子，主悬念持续加压且文本张力与 tensionLevel 一致 |
| S3 | 铺垫与回收（只评信息线索） | 前期线索多数成为孤儿，或结局依赖未铺垫的信息 | 主线线索有回收，支线线索约半数落空 | 前 1/3 引入的关键线索在后 2/3 几乎全部回收，回收自然不生硬 |
| S4 | 不可预测性（早期预测测试） | 评审只读前 25% 即高置信全中结局与关键反转 | 能预测大方向但细节与反转有偏差 | 早期预测置信度低或方向错误，实际展开合理但未被猜中 |
| S5 | 实体引入功能性（只评实体） | 新登场 NPC/地点/物品多为背景填充，与主线无关 | 实体有功能但部分扩展提议的 reason 未兑现 | 每个首次登场与动态扩展实体都推动剧情或兑现其提议理由 |
| S6 | 战斗铺垫合理性 | boss 战突兀出现，无动机建立与张力积累 | 有铺垫但张力积累不足或动机牵强 | boss 战前有清晰的动机链与逐幕升级的张力，战斗是剧情必然 |
| S7 | 结局兑现度 | 结局未回应主线冲突或与玩家行动矛盾 | 回应主线但部分悬念未闭合 | 结局回应主线冲突与主要悬念，与玩家行动逻辑自洽 |
| S8 | 选择后果感 | 选项选什么后续叙事都一样，选择无痕迹 | 部分选择被承接，部分被无视 | 上一幕的选择在下一幕叙事中被明确承接并体现差异 |

S4 评分规则：早期预测测试独立于完整评审之前执行（避免上下文污染）。评审模型只读前 25% 场景，预测结局走向、boss 身份、关键反转并自报置信度（1–5）；预测命中项越多且置信越高，S4 得分越低（全中且置信 5 → S4=1；方向错误或置信 ≤2 → S4≥4，由锚点裁量）。

### 5.2 场景级维度（逐场景/抽样评分，1–5 分）

| # | 维度 | 评分口径与边界 |
| --- | --- | --- |
| C1 | NPC 声线一致性 | 只评语气、用词、性格是否符合 manifest 中的 NPC 档案，以及不同 NPC 是否有区分度。知识越权已由规则审批硬性保证（引用未知事实会被驳回、mayLie 恒 false），不重复评。 |
| C2 | 场景衔接连续性 | 与前序场景及结构化记忆无矛盾；无凭空引用的事件、地点或人物关系。 |
| C3 | 选项抉择质量 | 实际评的是 director 挑选的两个行动是否构成有意义的策略差异。架构约束：writer 写的 label/strategy 会被规则文案覆盖后才展示，玩家看到的选项文字不是 AI 写的——若基线发现选项无聊，改 prompt 无效，需改规则文案或放开 writer 文案（记为发现，不在本 spec 内修）。 |
| C4 | 文本质量 | 重复感/流水账、辞藻堆砌、与 sceneGoal 的相关度；含文风与世界观一致性（跨场景不串腔、与开局蓝图设定不脱节）。 |

抽样：C1 对全部含 NPC 台词的场景逐条评；C2–C4 每幕抽 2 个场景（seed 确定性抽样）。幕边界从 `story.jsonl` 的规则事件确定性划分：以每个主线任务完成/失败事件（quest_completed / quest_failed）为幕切分点，末尾不足一幕的场景归入最后一幕。

### 5.3 客观指标（确定性计算，零 AI 成本）

- 整局 fallback 率；各角色重试率与 invalid_json 率；审批驳回分类分布。
- tensionLevel 曲线（完整序列 + 标准差作为平坦度）；pacing 分布与顺序合法性。
- 每幕事实揭示密度；相邻场景 narration 字符 3-gram 重复率；narration/台词长度分布。
- 扩展提议数与采纳率；场景总数与是否收敛到结局（60 场景内）。

### 5.4 人工抽查清单

评审报告自动列出：所有任一维度 ≤2 分的场景 + 每局 seed 随机 3 个场景，附检查要点（声线、连续性、选项差异、证据引文），由人工复核评审模型的判断是否成立。人工结论用于校准量表锚点与评审 prompt（量表变化则文档升版本）。

## 6. 采集通道设计

### 6.1 模块

新建 `src/game/application/server/ai/storyEvalCapture.ts`：

- `StoryEvalSink` 接口 + `createFileStoryEvalSink`：同步追加写 JSONL；写失败（磁盘满、路径无效）静默降级，绝不抛错到游戏主流程（与日志 sink 同一容错哲学）。
- 装饰器 `withScenarioEvalCapture(source, sink)` 与 `withRuntimeNarrativeEvalCapture(source, sink)`：包裹现有 AI source，在调用前后截获数据；不改变被包裹 source 的任何行为（含重试、审批、fallback、诊断）。

### 6.2 装配

`src/game/application/server/compositionRoot.ts` 仅当 `STORY_EVAL_CAPTURE=1` 时套装饰器；未设置时装配代码路径与现状逐字节等价（零开销、零行为变化）。run-id 取 `<ISO时间戳>-<pid>`（沿用 phase10 惯例）。浏览器手玩局同样可通过该开关采集（服务端装配层统一生效）。

### 6.3 产物（`artifacts/story-eval/<run-id>/`）

| 文件 | 每条记录 | 用途 |
| --- | --- | --- |
| `calls.jsonl` | 角色（scenario/director/writer/npc）、全局序号、尝试序号、完整 prompt messages、模型原始输出、解析后候选、审批结果与驳回分类、延迟 ms | prompt 调优诊断 |
| `story.jsonl` | 场景序号、玩家可见 narration、NPC 台词与情绪、两个选项最终展示文案、导演计划摘要（sceneGoal/pacing/tensionLevel/focusNpcId/揭示事实数/扩展提议及裁决）、是否 fallback、玩家实际选择及策略理由、规则事件（任务/战斗/结局） | LLM 评审与人工阅读的唯一评估正文 |
| `manifest.json` | gameId、seed、gameLength、模型名、开局蓝图快照（世界观/NPC 档案/任务结构/双结局） | 评审对照上下文 + 复现信息 |

### 6.4 安全红线

- 不改动现有日志脱敏、fixture 录制格式、journey 脚本契约中的任何一项。
- `calls.jsonl` 含 prompt 原文：产物目录不进 git（沿用 `artifacts/` 现有 ignore 语义）；`AI_API_KEY` 等凭据永不落盘。
- 采集失败不影响游戏流程；`STORY_EVAL_CAPTURE` 未设置时不产生任何文件。

## 7. 评估旅程脚本

新建 `scripts/storyEvalJourney.mjs`（+ `storyEvalJourney.node-test.mjs`），进程内驱动方式参照 `scripts/phase11StoryContinuityJourney.mjs`。

- 开关：必须显式 `RUN_STORY_EVAL=1` 才发真实计费调用；未设置时打印提示 exit 0。脚本内部自动设置 `STORY_EVAL_CAPTURE=1` 并把采集目录指到本次 run-id。
- 单局流程：创建 `gameLength=long` 新局（开局 AI 不可用则本次运行判失败并如实报告，不评 fallback 开局）→ 循环 ensure → ready → 记录 → 按策略提交 choiceToken → 直至结局或 60 场景上限（超限如实记"未收敛"，本身是基线发现）→ 战斗阶段 attack 优先打完。
- 选择策略（可复现 + 覆盖面）：`STORY_EVAL_SEED` 驱动确定性 PRNG（mulberry32 级别）。探索优先：两选项中若有"前往未访问地点 / 与未见 NPC 交谈 / 调查新事实"类行动则优先选它；同类时 PRNG 掷硬币。seed 与每次选择理由记入 `story.jsonl`（S8 评审对照）。
- 失败处理：单局 fallback 率超 50% 时提前终止并标记 `aborted`，已采集数据保留。
- 多局：`--runs N`（seed 依次递增），每局独立 run-id、独立临时 SQLite（落 `tmp/`，按既有 journey 清扫实践结束即清）。

## 8. 分析与评审脚本

### 8.1 `scripts/storyEvalAnalyze.mjs`（+ node-test）

纯离线：输入任意 run 目录，输出 `metrics.json`（§5.3 全部指标）。可对历史 run 重复执行，是每轮调优后的免费第一道体检。

### 8.2 `scripts/storyEvalJudge.mjs`

- 开关：`RUN_STORY_EVAL_JUDGE=1` 才调用；模型默认 `AI_MODEL`，`STORY_EVAL_JUDGE_MODEL` 可覆盖；复用 `AI_API_BASE_URL`/`AI_API_KEY`。
- 输入只有 `story.jsonl` + `manifest.json`；不喂 `calls.jsonl`（评审只看玩家视角，避免被内部计划带偏）。
- 三段评审（约 10–20 次调用/局）：① 早期预测测试（S4，独立先行）；② 故事级评审（S1–S3、S5–S8，逐维打分且每个分数必须附场景序号 + 引文证据，无证据重评一次）；③ 场景级评审（C1 全量、C2–C4 每幕抽 2）。
- 输出强制 JSON，本地解析 + 一次重试，仍失败则该维度记 `null` 并如实呈现，不编分。
- 产物：`scores.json`（结构化分数 + 证据）+ `report.md`（人类可读，含 §5.4 人工抽查清单）。
- 量表事实源：judge 内嵌量表文本必须与 `docs/策划文档/AI内容质量评估标准.md` 一致，引用时标注文档版本号。

## 9. 基线流程

分两步，每步发真实调用前需用户确认：

1. **试点**：1 局 `long`（约 80–130 次生成调用 + 10–20 次评审调用）→ 跑通采集/分析/评审全管线 → 人工抽查复核评审模型判断 → 修正管线或量表（量表变化升 v2）。
2. **补齐**：管线稳定后再跑 2 局（seed 递增）→ 3 局各维度均值/最差值 + 全部客观指标汇总为**基线 v1**，产出 `artifacts/story-eval/baseline-v1/report.md`。

基线定位：描述性快照，不是及格线。报告附建议门槛（如 fallback 率上限、C2 均分下限）供用户裁定。后续每轮 prompt 调优用相同 seed 策略复测对比。

文档归档：基线数值回填 `docs/策划文档/AI内容质量评估标准.md`；实现事实新建 `docs/agent/AI内容质量评估.md` 并更新 `docs/Agent文档索引.md`。

## 10. 环境变量（全部可选，未设置零影响）

| 变量 | 作用 |
| --- | --- |
| `STORY_EVAL_CAPTURE` | `1` 时 composition 层装配采集装饰器 |
| `RUN_STORY_EVAL` | `1` 时评估旅程脚本才发真实计费调用 |
| `STORY_EVAL_SEED` | 选择策略与抽样的确定性种子 |
| `RUN_STORY_EVAL_JUDGE` | `1` 时评审脚本才发真实计费调用 |
| `STORY_EVAL_JUDGE_MODEL` | 覆盖评审模型（默认 `AI_MODEL`） |

`.env.example` 补注释说明（不含默认值，遵循 RUN_REAL_AI_* 惯例：不持久化到 .env.local）。

## 11. 测试与验收（离线，零网络零计费）

- TDD：sink 单测；装饰器透明性测试（包裹前后 source 行为等价）；compositionRoot 开关装配测试（env 未设置时不产生文件）；三个脚本各配 node-test（journey 的策略函数、analyze 的指标计算、judge 用注入假 transport 验证评审编排与输出结构）。
- `npm run lint`、`npm run typecheck`、`npm test`、`npm run test:boundaries` 全绿；`STORY_EVAL_CAPTURE` 未设置时 `npm run journey:phase10` 行为不变。
- analyze/judge 对手工构造的假 run 目录产出正确结构。
- 真实基线执行结果按事实记录（真实调用是否发生、几局收敛、几局 aborted），不把 fixture/假 transport 通过写成真实调用成功。

## 12. 风险与开放问题

- `gameLength=long` 8 幕主线能否在 60 场景内收敛未经验证——试点局的首要观测点，若不能收敛如实记录为基线发现。
- 同模型评审自身产物存在自我偏袒风险——由人工抽查校准；如偏袒明显，改设 `STORY_EVAL_JUDGE_MODEL` 为独立模型（改环境变量即可，无代码变更）。
- writer 选项文案被规则覆盖限制了 C3 的调优空间——基线阶段只记录，是否放开 writer 文案另行决策。
