# AI 内容质量评估（实现事实）

> 对应 spec：docs/superpowers/specs/2026-07-31-ai-story-quality-evaluation-design.md
> 量表事实源：docs/策划文档/AI内容质量评估标准.md（v2）

## 采集通道（三采集点，各取其唯一可见的数据）

1. **source 工厂捕获回调**（`calls.jsonl` 主体）：`createLiveScenarioCandidateSource` 与
   `createLiveRuntimeNarrativeSources` 可选 `captureSink` 参数，在 transport 调用处一次拿齐
   角色/尝试序号/完整 prompt/模型原文/解析后候选/延迟。中间层
   `runtimeNarrativeSourceFactory.ts` 与 `scenarioCandidateSourceFactory.ts` 透传。
2. **编排层审批记录**（`calls.jsonl` 补充）：`OrchestrateNarrativeSceneInput.approvalObserver`
   可选字段，发出 role_approval / plan_approved / expansion_decision 三类事件。类型契约
   （StoryEvalCallRecord / StoryEvalApprovalRecord / StoryEvalRecord / StoryEvalSink /
   StoryEvalApprovalEvent）在 application 层 `src/game/application/storyEvalCaptureTypes.ts`
   （零 node:fs，analyze/judge 脚本与采集通道共享的契约来源）；
   `server/ai/storyEvalCapture.ts` 只保留 `createFileStoryEvalSink` /
   `createStoryEvalApprovalObserver` 两个 node:fs 实现。透传链：compositionRoot →
   `RuntimeNarrativeTaskCoordinator`（deps 类型即 GeneratePendingNarrativeSceneDependencies）→
   `generatePendingNarrativeScene` → `orchestrateNarrativeScene`。
3. **驱动侧故事流水**（`story.jsonl`）：`src/game/application/testing/storyEvalJourney.test.ts`
   的 `runStoryEvalJourney` 组装；导演计划摘要按 sceneId 前缀 traceId 关联 calls.jsonl。

装配：`compositionRoot.ts` 的 `resolveStoryEvalAssembly(env)`——`STORY_EVAL_CAPTURE=1` 才创建
sink（缺省目录 `artifacts/story-eval/run-<ISO 时间戳>-<pid>`，`STORY_EVAL_ARTIFACT_DIR` 覆盖）；
未设置时全部 undefined，装配与行为与现状完全一致。

## 产物（artifacts/story-eval/<run-id>/，不入 git）

| 文件 | 写入方 | 内容 |
| --- | --- | --- |
| calls.jsonl | source 捕获 + 审批回调 | ai_call / role_approval / plan_approved / expansion_decision |
| story.jsonl | 旅程驱动 | 场景序号/主线阶段/narration/NPC 台词/最终选项文案/导演计划摘要（allowedRevealFactIds/introducedEntities/扩展提议）/编剧与 NPC 实际使用事实 ID/fallback/玩家选择与策略理由/安全规则事件（factId/entityId/questId/endingId）/memory 摘要/焦点 NPC profile/关系摘要 |
| manifest.json | 旅程驱动 | gameId/世界 seed/策略 seed/gameLength/模型/profile/branchMode/maxScenes/temperature/timeoutMs/maxRoleAttempts/caseId/strategy/thinkingRoles/blueprintSource/gitCommit/prompt 与契约版本/S4 answerKey/开局蓝图快照/开局、叙事等待、分支、玩家行动、收尾、总耗时 timings |
| branches/stageN/&lt;choice&gt;/branch.json | 旅程驱动 | 成对分支证据：parent scene、所选 actionKey、两场后结构化事件、状态差异、玩家可读 narration；不足两个合法选项时写 not_applicable.json |
| metrics.json | analyze 脚本 | §3 全部客观指标（含 factsPerAct 双口径、实体/扩展漏斗、选择漏斗） |
| scores.json + report.md | judge 脚本 | 结构化分数 + 证据 + 人工抽查清单 |

**完整性约束（spec §7，Task 13）**：`incomplete` 产物（缺 calls、必要 manifest、S4 answer key，
或任一场景缺 previousScene/NPC 场景缺 memory+profile+关系摘要/规则事件缺安全 ID）不可进入分析
或评审，**不能产生基线分数**；journey 返回 `status: "incomplete"` 并以非零退出，judge 也不接受
未经完整性校验的 run。

## 脚本与命令

- `npm run journey:story-eval`：replay 模式（零网络离线用例）
- `STORY_EVAL_PROFILE=smoke|regression|baseline npm run smoke:ai:story-eval -- --case=<caseId>`：record 模式；profile 只控制评估运行参数，未设置时默认为 `baseline`。
- `smoke`：3 场景、1 次角色尝试、60 秒 timeout、不做分支，适合 PR 链路检查；不产生正式质量结论。
- `regression`：16 场景、2 次角色尝试、90 秒 timeout，只做 stage 2 分支，适合 prompt/代码趋势比较；16 幕是为 long 主线完成最终战斗与结局收尾预留的安全上限。
- `baseline`：60 场景、3 次角色尝试、120 秒 timeout，完整执行 stage 2/4/6 分支，适合正式质量评估。profile 的单项环境变量可覆盖默认值。
- record 模式可用 `--strategy=explore|objective` 只跑一种策略；单策略长测用于控制总耗时和隔离变量，未指定时仍跑两种策略。
- 可用 `--blueprint-artifact=<run>/calls.jsonl` 固定既有 scenario `parsedCandidate`，只比较 runtime narrative；候选仍经过 `createGame` 的完整校验/编译，manifest 只记录 `blueprintSource=captured_artifact`，不记录文件路径、prompt 或模型原文。
- `npm run analyze:story-eval -- <runDir>`：客观指标 → metrics.json（含实体/选择漏斗）
- `npm run judge:story-eval -- <runDir>`：三段评审（需 `RUN_REAL_AI_STORY_EVAL_JUDGE=1`）→ scores.json + report.md

Task 13 接线状态：record 模式已按 v2 case/strategy 确定性展开，childEnv 注入
`STORY_EVAL_CASE_ID`/`STORY_EVAL_STRATEGY`/递增 seed/独立 artifact 与 db；未知 case 以
`INVALID_CASE` 退出；judge 侧 C1/C2 证据包由 story 行自带（NPC profile/关系摘要/memory/前序场景），
绝不把 `calls.jsonl` 或原始 prompt 交给 judge；S8/S9 在无成对分支证据时强制 cap 为 3。评估模式可
独立降低角色尝试次数和 scenario/runtime provider 超时；Judge 每次请求有超时和稳定的
`judge_timeout` 失败码，C1–C4 并行发起以消除场景级串行等待。

## 基线流程（12 条主旅程 + 人工/异模型校准）

1. **试点（1 个 case）**：完整执行两种策略与三个成对分支（主线阶段检查点 2/4/6）→
   completeness 通过 → analyze → judge → **两位人工评审独立复核固定高/中/低分证据包**
   （spec §5.4：所有任一维度 ≤2 分的场景 + 每局 seed 随机 3 个场景），并用**不同模型系列**
   复评同一份 story/manifest（`STORY_EVAL_JUDGE_MODEL`）。分歧 >1 分、无证据或 artifact
   incomplete 时回到实现侧修正，不能补录分数；量表变化则升版本（v3…）。
2. **补齐（其余 5 个 case）**：完成 12 条主旅程 → 按 `caseId × strategy` 配对报告均值/中位数/
   最差值/空值率与模型配置，并汇总客观指标为**基线 v2**
   （`artifacts/story-eval/baseline-v2/report.md`，工作产物）；持久基线回填
   `docs/策划文档/AI内容质量评估标准.md` 的分数表、客观指标摘要和校准结果。报告只说明该评测集
   与模型配置下的质量，不作无依据的全局结论。基线是描述性快照，不是及格线。

## 环境变量（全部可选）

STORY_EVAL_CAPTURE（服务端装配开关，浏览器手玩采集需在启动 dev server 的 shell 中临时设置）、
STORY_EVAL_ARTIFACT_DIR（门禁脚本注入）、RUN_REAL_AI_STORY_EVAL、STORY_EVAL_SEED、
STORY_EVAL_PROFILE（smoke/regression/baseline，默认 baseline）、STORY_EVAL_MAX_SCENES、
STORY_EVAL_MAX_ROLE_ATTEMPTS、STORY_EVAL_RETRY_BACKOFF_MS（0~5000ms，指数退避，默认 1000ms）、
STORY_EVAL_AI_TIMEOUT_MS、STORY_EVAL_BRANCH_MODE（none/sample/full）、
STORY_EVAL_BLUEPRINT_ARTIFACT（可选，受控 A/B 重放 scenario 候选的 calls.jsonl 路径）、
AI_THINKING_ROLES（可选 `scenario,director,writer,npc`，默认空值/关闭；仅用于实验，manifest 记录归一化角色列表）、
RUN_REAL_AI_STORY_EVAL_JUDGE、STORY_EVAL_JUDGE_MODEL、STORY_EVAL_JUDGE_TIMEOUT_MS（默认 120000）。

## 已知发现（基线阶段只记录不修）

- writer 选项文案被规则文案替换后才展示：若 C3 基线分低，改 prompt 无效，需改规则文案或放开 writer 文案。
- 同模型评审自身产物存在自我偏袒风险：由人工抽查校准；偏袒明显时设 STORY_EVAL_JUDGE_MODEL 为独立模型。
- 短测的实际瓶颈在 provider 请求：本次 3 场景 explore 总耗时约 118 秒、objective 约 181 秒，
  本地收尾/动作开销均不足 1 秒；objective 中 director 约 110 秒，是总耗时约 61%。

## 当前回归事实（2026-08-02）

- 候选机械修复对超预算 NPC 使用引用感知裁剪：优先移除未被地点、开场场景或任务目标引用的非同伴冗余 NPC；没有安全移除项时仍返回不可修复并进入既有 retry/fallback。
- scenario prompt 明确锁定五种 objective kind，并特别要求获取物品使用 `obtain_item/itemId`，禁止模型输出 `collect_item` 等同义词；该漂移曾导致真实 explore 开场 fallback。
- follow-up smoke 的两个策略均生成完整 artifact；explore `fallbackRate=0`，objective `fallbackRate=0.333`。两者均为 3 幕 `max_scenes` 校准样本，不得替代 60 幕 baseline。
- 物品展示元数据出现新的契约漂移：真实产物中 `items[2].rarity=legendary` 使候选在最终校验失败；修复后由 application 层仅删除非法可选展示字段，保留物品 ID、名称和规则语义，并在 scenario prompt 中同步声明 category/rarity/level/statLines 的闭集合与边界。
- 物品修复后的 smoke 产物为 `artifacts/story-eval/wuxia-a-explore-0-2026-08-02T05-48-44-810Z-ee367cd3` 与 `artifacts/story-eval/wuxia-a-objective-1-2026-08-02T05-51-11-164Z-05d241cc`：两者均完整、`max_scenes=3`、`fallbackRate=0`；objective 发生 1 次 scenario 重试后恢复。两者张力均为 `2,2,2`，无成对分支证据；objective 仍漏掉计划的 `fact_identity`/`fact_premise` 揭示，因此不能据此宣称故事质量已改善或形成正式基线。
- 代码原先对 scenario、director、writer、npc 统一发送 `enable_thinking:false`。现已增加默认关闭的 `AI_THINKING_ROLES` 角色级实验开关；`director,writer` treatment 的配置会写入 manifest，但不会写入原始环境值、prompt 或模型响应。
- 思考 A/B 的完整 treatment 为 `artifacts/story-eval/wuxia-a-explore-0-2026-08-02T06-59-27-681Z-3816d4f6` 与 `artifacts/story-eval/wuxia-a-objective-1-2026-08-02T07-02-35-585Z-73f414d8`：两者均完整、`fallbackRate=0`；explore 张力仍为 `2,2,2`，objective 为 `1,2,2`。与 no-thinking 控制相比没有稳定、可归因的故事质量提升，且无 paired branch evidence；当前结论是“思考可能是次要增益，尚不足以改默认”，下一步应在 12 幕 regression 中验证。
- 12 幕 regression 的导演单角色对照进一步显示一个“结构信号”，但还不能算因果结论：`AI_THINKING_ROLES=director` 的 explore 产物 `artifacts/story-eval/wuxia-a-explore-0-2026-08-02T08-14-42-180Z-4248d344` 为 `fallbackRate=0`、张力 `1,2,2,2,2,2,1,2,5,5,4,4`、`tensionStddev=1.374`，节奏分布为 `setup=4/develop=4/climax=4`；no-thinking 对照 `artifacts/story-eval/wuxia-a-explore-0-2026-08-02T08-31-18-044Z-608e80e7` 同为 12 幕且 `fallbackRate=0`，但张力 `2,2,3,3,2,2,2,3,3,3,2,3`、`tensionStddev=0.500`，节奏主要落在 `develop=8`。这说明导演思考可能帮助形成更明显的后段升级，但两次开局由真实模型独立生成、world seed 不同，不能视为严格同剧本 A/B。
- 该长测也暴露质量的其他瓶颈：导演思考样本仍漏 `fact_premise`/`fact_identity`，没有 paired branch evidence，物品贡献仍为 0；no-thinking 对照反而有 1 个成对选择且状态/事件/叙事均不同，并有 3 个 NPC 贡献。因此不能把张力方差的改善等同于整体故事质量改善。导演样本总耗时约 9.17 分钟，对照约 12.47 分钟；对照出现 1 次 director retry/failure，说明 provider 随机性仍然显著。
- 当前决策：保持默认 `AI_THINKING_ROLES` 为空；优先把导演思考作为 dev/staging 的候选实验。若要改默认，至少需要固定同一 blueprint/world seed，或完成多 seed、每臂至少 3 次的 `explore` regression，并同时观察 fallback、事实采纳、实体贡献、选择分支和 judge 分数，而不是只看 `tensionStddev`。
- 为处理固定蓝图 A/B 中暴露的“导演思考诱发连续探索、主线不推进”问题，director prompt 已改为主线推进优先：已有合法主线行动可用时不得扩展；扩展是稀有兜底，近期已有 `blueprint_expanded` 时默认不再扩展。离线提示词测试与 typecheck 通过。
- 固定同一 `worldSeed=3110f434-791c-4286-a45b-d0cedf80223b` 的 pre-fix A/B：导演思考跑到 8 幕 `exhausted`，停在主线 stage 1，扩展 `persisted/adopted=3/3`；无思考对照跑满 12 幕并到达 stage 3。prompt 修复后的导演思考 regression 为 `artifacts/story-eval/wuxia-a-explore-0-2026-08-02T09-13-13-992Z-75fa3c74`：12 幕 `max_scenes`、`fallbackRate=0`、stage 序列 `1,1,1,1,1,3,8,8,8,8,8,8`、`tensionStddev=1.323`、节奏 `setup=1/develop=5/climax=6`，实际扩展 `approved/persisted/adopted=0/0/0`。这说明提示词收紧解决了扩展循环并恢复了主线推进，但仍不是 judge 评分或多 seed 结论。
- 为完成上述复测门槛，在同一 `worldSeed`、同一 captured blueprint 下补跑 3 个策略 seed（`20260731/20260732/20260733`），导演思考组产物为 `artifacts/story-eval/wuxia-a-explore-0-2026-08-02T09-13-13-992Z-75fa3c74`、`artifacts/story-eval/wuxia-a-explore-0-2026-08-02T11-10-24-533Z-976b20c4`、`artifacts/story-eval/wuxia-a-explore-1-2026-08-02T11-17-08-849Z-56564748`；关闭思考组产物为 `artifacts/story-eval/wuxia-a-explore-0-2026-08-02T09-39-20-265Z-6c4c11f3`、`artifacts/story-eval/wuxia-a-explore-0-2026-08-02T11-24-05-187Z-8afe74c8`、`artifacts/story-eval/wuxia-a-explore-1-2026-08-02T11-29-52-840Z-ec2d61f0`。六份均通过完整产物校验，`fallbackRate=0`。
- 三次聚合结果（均值/合计）如下：

  | 指标 | `director` thinking | no-thinking | 判断 |
  | --- | ---: | ---: | --- |
  | 平均场景数 | 11.67 | 11.00 | thinking 略高；仍均未收敛到 ending |
  | 跑满 `max_scenes` | 3/3 | 1/3 | thinking 的推进稳定性更好 |
  | 最终主线 stage | 8/8/8 | 3/8/4 | thinking 更容易进入后段升级，但不是完成度证明 |
  | `tensionStddev` 均值 | 1.216 | 0.773 | thinking 的张力弧更明显；不能单独等同故事质量 |
  | 事实召回 | 2/20 = 0.10 | 1/17 = 0.06 | thinking 略好但仍严重不足，关键事实仍大量 missed |
  | NPC/地点/物品贡献合计 | 3/6/0 | 2/6/0 | NPC 轻微改善，物品仍未进入故事功能 |
  | paired branch evidence | 0 | 0 | 两组都无法证明选择后果 |
  | expansion `approved/persisted/adopted` 合计 | 0/0/0 | 0/0/0 | prompt 修复避免扩展循环，但尚无有效扩展 |
  | 平均耗时 | 6.89 分钟 | 6.74 分钟 | 思考没有形成明显额外成本差异 |

- 结论更新：`AI_THINKING_ROLES=director` 对主线阶段推进和张力曲线有较稳定的正向信号，支持继续作为 dev/staging 实验；但事实召回约 10%、物品贡献为 0、paired branch 为 0、所有样本未收敛，不能据此改 production 默认。当前 production 仍保持 `AI_THINKING_ROLES=`；下一优先级是把导演计划中的 `relevantFactIds/allowedRevealFactIds` 转化为实际安全规则事件，并生成可验证的成对选择，再复测 writer/npc 思考是否有增益。上述实验只证明请求配置已写入 manifest，不证明 provider 一定实际使用了内部思考 token。
- 本轮主线调试定位到一个比 thinking 开关更直接的结构缺陷：旧的共享 fallback 蓝图在 medium/long 中重复 `visit_location:loc_2`、`talk_to_npc:npc_2` 与 `discover_fact:fact_gen_1`。由于任务 reconciliation 会对“解锁时已经满足”的状态目标做固定点连锁完成，真实旅程因此出现 `1,1,1,1,1,3,8...` 的跳幕；这不是导演是否开启 thinking 单独造成的。
- 修复已将 fallback 模板升级为 `fallback-5`，medium/long 使用可达且不重复的目标链：`loc_2 → npc_2 → item_key → fact_gen_1 → fact_gen_2 → loc_4 → npc_4 → enemy_boss`；short 三幕兼容契约保持不变。scenario prompt 同步禁止重复 `kind+target`，并禁止新解锁目标在解锁前已满足；静态 validator 新增 `REPEATED_MAIN_OBJECTIVE`，避免同类蓝图再次进入运行时。
- 修复后的离线验证全部通过：fallback 回归 59/59，完整 `npm test` 为 149 files、1616 passed、4 skipped，`test:fast`、typecheck、lint（既有 5 warnings、0 errors）、production build 均通过。旧 captured blueprint 产物仍是修复前证据，不能用于修复后的正式 A/B；下一步必须重新捕获有效蓝图，再比较 thinking 与 no-thinking。
- 修复后重新捕获的真实蓝图 artifact 为 `artifacts/story-eval/wuxia-a-explore-0-2026-08-02T12-35-32-525Z-e667efda`。其主线目标已确认为不重复且可达的 `loc_2 → npc_2 → item_key → fact_gen_1 → fact_gen_2 → loc_4 → npc_4 → enemy_boss`，真实生成与完整旅程均通过，12 幕、`fallbackRate=0`；但导演 thinking 组仍未收敛，记录的主线 stage 序列为 `1,1,1,1,1,2,2,2,2,2,2,2`，张力标准差 `0.373`。
- 使用该新蓝图固定世界/结构后补跑 no-thinking 对照 `artifacts/story-eval/wuxia-a-explore-0-2026-08-02T12-46-16-902Z-8595d1da`：同为 12 幕、`fallbackRate=0`、有 1 个有效成对分支证据；其记录 stage 序列为 `1,1,1,1,2,3,3,3,5,5,5,5`，完成主线 2–4 并解锁 5，张力标准差 `0.624`。代价是 writer 出现 3 次 invalid JSON 重试，thinking 组为 0；两组都未到结局，且策略 seed 不同，因此只能说明本次主线推进信号，不能宣称 no-thinking 整体优于 thinking。
- 本次 A/B 将瓶颈从“重复蓝图造成跳幕”进一步缩小为“导演/探索策略是否选择当前主线目标”：thinking 组在 stage 2 多次选择 `npc_6/npc_3` 等合法但非目标 NPC，no-thinking 恰好选择了 `talk:npc_2` 并继续推进。下一优化优先级是把 active main objective 与可执行 action 的精确对应关系显式提供给导演，并新增目标命中率指标；不要仅靠 thinking 开关或自然语言描述推断。
- 已实现上述目标映射：导演上下文新增 `activeMainObjective`，投影当前未满足目标的 `kind/targetId/suggestedActionKey`；`repairRuntimeNarrativeReferences` 在该 action 合法时将其固定为第一推荐，branch coverage 的显式 target 仍优先。旧黄金 fixture 指纹忽略该可重建派生字段，避免新增上下文导致无意义 drift。
- 目标映射后的离线全量门禁通过：149 个测试文件、1618 passed、4 skipped；`test:fast`、typecheck、边界、build、offline story-eval replay、git diff check 通过，lint 仍为既有 5 warnings。下一次真实 regression 应复用 `fallback-5` 蓝图并观察主线目标命中率、stage 推进、writer 重试和 ending convergence。
- 目标映射后的真实 smoke 已确认接线生效：`artifacts/story-eval/wuxia-a-explore-0-2026-08-02T13-06-40-551Z-8fdb4870` 的 director 请求包含 `activeMainObjective={visit_location, loc_2, move:loc_2}`，首幕将 `move:loc_2` 置于第一推荐，3 幕均 `fallbackRate=0`。该产物是 smoke/max-scenes=3 校验，不是正式质量评分；下一步仍需复用同一 `fallback-5` blueprint 做更长、多 seed 的目标命中率与结局收敛回归。

## 当前结构审计与最新回归（2026-08-02，覆盖上文历史记录）

### 游戏质量表现的定义

本项目的“游戏质量”不是单一的 AI 文案分，而是以下六个维度的交集：

1. **可玩正确性**：合法行动、状态/事件/背包持久化、任务 reconciliation、结局或可诊断停止状态正确。
2. **推进与能动性**：当前目标存在合法路径；玩家选择能转成规则事件并推动阶段；偏离主线时仍可恢复，而不是无界重复。
3. **叙事结构**：有起承转合、张力升级、因果铺垫与回收、实体承担功能、冲突和结局有动机。
4. **连续性与角色分工**：导演只规划，编剧只在批准的动作/事实范围内组织场景，NPC 只使用自己的已知事实与关系上下文。
5. **世界与物品功能**：物品在正确地点可见，只有 `take_item` 规则事件写入背包并触发 `obtain_item`；不能由 prose 伪造。当前 `use_item`、交易、装备效果、随机奖励仍是明确未实现边界。
6. **证据可信度**：artifact 完整，规则事件只带安全 ID，目标快照、选择结果、选择后事件和成对分支证据能互相对齐。

因此报告必须分开呈现工程正确性、主线推进、叙事质量和证据完整性，不把短测或单一张力指标压成一个总分。

### Director / Writer / NPC 的结构问题

| 角色/边界 | 已定位的结构缺陷 | 为什么会导致正常推进出问题 | 当前修复 |
| --- | --- | --- | --- |
| Director | 原先只看动作候选和摘要，不知道当前主线的直接目标、到目标地点的下一跳、当前地点卡和可取得物品卡；fallback 蓝图还存在重复 objective/阶段描述。 | 模型会选择“合法但不推进当前任务”的 talk/move/investigate；任务固定点又可能把解锁时已满足的目标连锁完成，表现为跳幕、重复、停滞。 | fallback 升为 `fallback-7`；上下文加入 `activeMainObjective/currentLocationCard/availableItemCards`；合法下一跳由规则图计算；目标 action 机械置首；主线重复描述候选直接拒绝，扩展改为稀有回退。 |
| Writer | 原先缺少权威的地点/物品卡，容易用 prose 暗示物品已获得；NPC 事实授权没有同时约束 `allowedFactCards` 与 NPC 自己的 `knownFactIds`。 | 选项 key 虽合法，文案却可能与规则事实冲突；NPC 要么越权知道事实，要么被错误清空授权事实而失去功能。 | 编剧只复制导演批准的 action key；地点/物品卡作为权威输入；审批层对未执行 `take_item` 的物品占有句返回 `state_prose_mismatch`；事实授权取两集合交集，空请求回退到安全已知子集。 |
| NPC / 行动边界 | NPC 的最小权限本身基本正确，但普通 `talk` 曾绕过 Phase 13 关系/记忆写入；编剧到 NPC 的授权链断开，演员也缺少本幕目标和角色描述。 | 选择对话后 NPC 关系不变化，连续性读不到“初次见面”；同一角色的可说事实不稳定，台词容易变成泛泛警告。 | 普通 `talk` 统一写入 `npc_met + greet` 关系事件；NPC 只收到编剧明确交给它且自己已知的 fact cards，并追加 sceneGoal/playerName/currentLocationCard/description/requestedEmotion；演员同样拒绝提前宣称物品已取得。 |
| Item / 规则层 | 物品不是 AI 自由生成内容，只有预编译蓝图中的 `take_item`；系统本身没有 `use_item`、交易、装备效果或随机掉落。 | 旧链路没有稳定到达 `loc_3`/`take_item`，看起来像“没有物品”；若只改 prompt，仍不能让 prose 写背包。 | 主线链明确经过 `visit loc_3 → take item_key`，导演/编剧看到可取得物品卡；真实回归用 `actionEvents` 证明 `item_obtained`。未实现能力继续保持拒绝/不宣称。 |

正常推进的故障边界是：`Director plan → Writer choices → narrative choice → resolver → quest reconciliation`。之前只有最后两层是规则可靠的，前面缺少“当前目标到合法 action”的投影，所以“合法”不等于“可推进”。这比是否开启 thinking 更直接。

### 最新真实回归

命令使用固定 `case=wuxia-a / strategy=objective / seed=20260801 / profile=regression / AI_THINKING_ROLES=`，并固定 runner 为单 fork；最终门禁输出 `REAL_AI_JOURNEY_OK`。产物：

`artifacts/story-eval/wuxia-a-objective-0-2026-08-02T14-52-37-704Z-77b9febf`

客观结果：

- 12 幕，`status=max_scenes`，未在 12 幕内进入结局；这不是 formal baseline，也不是“结局失败”的全局结论。
- runtime `fallbackRate=0`；scenario/director/writer/npc 均无 retry、invalid JSON 或 failure。
- 主线目标：下一跳呈现 `12/12`、下一跳选择 `12/12`；直接目标呈现/选择 `7/12`，实际目标事件命中 `7/12`，规则推进幕 `12/12`。
- 物品目标：`obtain_item` 机会 `1`，下一跳/直接目标呈现与选择 `1/1`，`item_obtained` `1/1`，物品实体贡献 `1`。这证明“物品没有”已从主线可达性/证据错位中修复，不代表已经实现使用物品。
- 成对分支 `1` 组，状态/事件/叙事均有差异；这是选择后果的最小正证据。
- 事实召回仍是主要短板：本次 `fact_identity/fact_premise` 多幕计划存在但实际均未揭示；实体漏斗为 NPC `3/3`、地点 `3/4`、物品 `1/1` 贡献，扩展提案 `12` 但批准/持久化/采用均为 `0`。
- 张力标准差 `0.640`，节奏 `setup=1/develop=8/turn=3`，仍有 `illegalOrderCount=2`；这是叙事结构优化问题，不是规则推进问题。

本次新增 `story.jsonl.actionEvents`，专门记录当前场景所选 action 产生的安全规则事件；旧 artifact 仍回退使用 `newEvents`。这修正了此前真实跑测中明明发生 `item_obtained` 却统计为 0 的评估器错位。

## 修复批次（2026-08-03）

- NPC 交接上下文现在显式携带 `sceneGoal`、`playerName`、当前地点卡、NPC `description` 与 Writer 请求的 `requestedEmotion`；演员提示词要求按本幕目标和关系状态回应，避免只有泛化角色名/警告。
- 编剧与 NPC 审批均检查未执行 `take_item` 时的物品占有句，返回 `state_prose_mismatch` 并触发有界重试/fallback；否定句（“尚未拾起”）仍允许。
- 主线蓝图新增 `REPEATED_MAIN_QUEST_DESCRIPTION` 语义闸门；fallback 升为 `fallback-7`，每幕描述指向具体地点、NPC 或物品目标。
- 评估器新增事实的 `newFactIds/repeatedFactIds`、蓝图事实宇宙覆盖率、`none_proposed` 排除，以及固定分支窗口的 `reconvergedCheckpoints`；manifest 同步保存事实、地点、物品、敌人、目标明细，结局行保存玩家可见标题/描述。

### 修复后真实 regression 复测（2026-08-03）

使用 `.env.local` 发起真实 provider 请求，`case=wuxia-a`、`profile=regression`、`AI_THINKING_ROLES=`，同一命令分别记录 `explore` 与 `objective` 两条旅程；runner 最终输出 `REAL_AI_JOURNEY_OK`。

- `explore`：`artifacts/story-eval/wuxia-a-explore-0-2026-08-02T17-37-50-954Z-9ab61d12`。11 幕、`status=exhausted`、`fallbackRate=0`，未到结局；主线目标呈现/选择/事件命中为 `4/2/2`（总机会 11），NPC 贡献 `1/3`，物品贡献 `0`，事实实际叙事覆盖 `4/5`、规则调查 `3/5`。有 1 组有效成对分支，状态/事件/叙事均不同但未重新收敛。该策略仍会在合法探索选择下停滞，不能宣称 explore 已完成收敛修复。
- `objective`：`artifacts/story-eval/wuxia-a-objective-1-2026-08-02T17-45-08-475Z-166c0601`。13 幕、`status=converged`，结局行记录 `ending_1/沉冤得雪/success`，`fallbackRate=0`；主线下一跳呈现/选择为 `13/13`，直接目标呈现/选择与事件命中为 `8/8/8`，规则推进 `13/13`；NPC `4/4`、地点 `3/4`、物品 `1/1` 均有贡献；分支同样为 `1` 组且三类差异均成立。
- 主要残留：objective 的事实蓝图为 4 条，实际叙事只使用 `fact_identity/fact_premise`（使用覆盖 `2/4=0.50`），规则调查为 `0/4`；生成蓝图中第 2–7 幕仍共享“深入铁剑山庄求证并取回关键信物”的重复尾句，说明仅做整句去重不足以保证语义覆盖。objective 的 pacing 为 `setup=1/develop=10/turn=1/climax=1`，分析器记录 1 次顺序回退（turn 后回到 develop），需区分跨幕合法重置与真正结构退化。
- 随后的结构门禁已补上两层：候选校验会按去掉幕号后的长语义片段拒绝重复主线描述（`REPEATED_MAIN_QUEST_DESCRIPTION_FRAGMENT`），分析器则按 `mainStage` 计算 `stageWindowViolations/turnStages/hasSetup/hasClimax/hasResolutionEvidence`。因此 `turn → next-stage develop` 不再被全局顺序指标误判，但同一主线阶段内的非法回退仍会暴露。
- 这次复测确认本批修复的可归因收益是：目标映射在 objective 策略中保持 `13/13` 推进并稳定到达结局；NPC 演员获得本幕目标/角色描述后贡献达到 `4/4`；两条旅程均 `fallbackRate=0`，新的状态—prose 审批未产生越权结果。它没有证明自由探索收敛、事实覆盖或三幕结构已达标；下一轮应优先处理探索停滞与事实进入实际叙事/调查的路径，并在 pacing 指标中按主线幕切分顺序。

### 评测器修复（2026-08-03，生成级计划 Task 1–2）

- `storyEvalJourney.mjs` 现在按 `case × replicate` 建立 paired run：两种策略共享同一 `seed`、`pairId` 与首个策略产生的 `calls.jsonl` 蓝图快照；第二条旅程不再被另一份随机开局混淆。manifest 追加 `pairingVersion/pairId/gameType/blueprintPairSource`，paired 产物缺少这些字段时会被完整性校验拒绝。
- 评测驱动器遇到规则层只剩一个合法的非战斗行动时，会执行一次带稳定 `actionKey` 的 `single_legal_action` continuation bridge；该规则动作不占叙事幕数，也不伪造第二个 AI 选项。只有零合法行动才计入 `trueDeadEnds`，重复续行超过上限才计入 `recoveryLoops`。分析器将三者单列为 `metrics.continuation`。
- 因此此前 explore 的 `status=exhausted` 不能直接当作真实死局：需要用新 runner 重新采集，查看 `trueDeadEnds/recoveryLoops` 后再判断是探索策略停滞还是蓝图/规则不可玩。当前离线门禁、续行测试与 TypeScript 检查已通过；新 paired runner 已发起一次计费 regression，但该次在 explore 第 5 幕因 3/5 场景使用 fallback（director/writer 多次 `service_error`）触发 `status=aborted`，Vitest worker 随后异常退出，未形成可比的 objective artifact，因此这次不计入通过证据。

本次失败产物为 `artifacts/story-eval/wuxia-a-explore-0-2026-08-03T02-57-50-741Z-92535b7d`：`fallbackRate=0.600`、`trueDeadEnds=0`、`recoveryLoops=0`。这说明新评测器已经能把“服务错误导致的 fallback 过半”单独暴露出来，不能用续行桥接或文本质量掩盖。下一次真实回归必须先解决 provider/service_error 的稳定性或明确重试预算，再重新完成同一 pair；在此之前不能声称生成级真实门禁通过。

随后使用 `seed=20260803` 重跑同一 `wuxia-a` paired regression，runner 输出 `REAL_AI_JOURNEY_OK`。explore 与 objective 都完成 16 幕；explore 为 `fallbackRate=0.0625`，objective 为 `0`。objective 在第 16 幕已经选择并执行 `start_battle:enemy_boss`，但旧版评测循环把战斗后的 ending 检查推到了 `maxScenes` 之外，产生了一个评测器误报；现已修复为战斗动作回到同一叙事幕检查结局，focused journey 与 typecheck 均通过。该次真实 artifact 是修复前产物，不能直接当作修复后的收敛证据，仍需后续重跑确认。

在修复前 artifact 上运行 pilot gate 的失败码为：`OBJECTIVE_NOT_CONVERGED`（含上述边界误报）、`FALLBACK_RATE_HIGH`（explore 6.25% 超过 5%）、`PACING_ARC_INCOMPLETE`（没有 ending resolution evidence）、`GENERATED_FACT_COVERAGE_LOW`（generated used/discovered 均 0.50，目标分别为 0.70/0.50，前者不足）。这轮没有 true dead end 或 recovery loop；因此下一步应先重跑修复后的 pair，再针对 fallback、结局收敛和 generated fact 叙事覆盖继续优化，暂不进入七题材 release matrix。

### 战斗收尾与事实主线修复后的验证（2026-08-03）

- 用同一 captured blueprint 重跑 objective，修复后的 artifact 为 `artifacts/story-eval/wuxia-a-objective-0-2026-08-03T04-15-46-704Z-56ae92fd`：`status=converged`、16 幕、`fallbackRate=0`，ending 行为 `ending_1/沉冤得雪/success`；`hasResolutionEvidence=true`，无 true dead end/recovery loop。它证明战斗启动发生在最后一个叙事幕时，评测器仍能在同一幕记录 battle 与 ending，而不是误报 `max_scenes`。
- 该 pair（与同 seed 的 explore artifact 合并）pilot gate 目前只剩 `FALLBACK_RATE_HIGH` 与 `GENERATED_FACT_COVERAGE_LOW`：explore 的 fallback 为 `1/16`，生成事实使用/发现覆盖为 `1/2`、`1/2`。objective 的主线推进和结局收敛已不再是阻断项。
- 事实契约已进一步收紧：medium/long 蓝图必须为每条 `source=generated` 事实配置主线 `discover_fact` objective；fallback-7 的第 2 幕现在依次调查 `fact_gen_1` 与 `fact_gen_2`，regression profile 上限从 16 调整为 18 以容纳额外调查与终局收尾。相关场景校验、fallback、prompt、runner node tests 与 typecheck 已通过。

### Thinking 结论

thinking 可能改善导演的多步规划和约束遵循，尤其适合实验 `AI_THINKING_ROLES=director`；但它不能补上缺失的目标路线、物品卡、规则事件或角色权限边界。已有多 seed A/B 只显示阶段推进/张力弧的信号，未稳定改善事实召回、物品功能、分支证据或 ending convergence。因此 production 默认仍关闭 thinking；下一次 A/B 必须固定同一 blueprint/world seed，并比较 fallback、目标命中、`actionEvents`、事实召回、分支和结局，而不是只比较 prose 或 tension。

### 生成级 paired regression 复测（2026-08-03，修复后）

本轮先用真实 provider 请求记录 objective 旅程，再复用该旅程的蓝图快照记录 explore 旅程，保证两条旅程只比较选择策略而不是比较两个随机蓝图。首次 explore 开局暴露 provider 返回的 CRLF fenced JSON 被严格解析器拒绝的问题；`extractFencedJson` 已改为接受 CRLF 与 fence 行水平空白，并增加了回归测试。

- objective：`artifacts/story-eval/wuxia-a-objective-1-2026-08-03T04-57-41-101Z-6ea2ec62`，17 幕、`status=converged`、`ending_1/沉冤得雪/success`、`fallbackRate=0`。主线建议/选择/推进为 `17/17/17`，目标动作呈现/选择/事件命中为 `10/10/10`；两条 generated facts 均实际叙事使用并由规则调查发现（使用/调查覆盖 `1.00/1.00`）。节奏为 `setup=1/develop=13/turn=2/climax=1`，无阶段窗口违规；分支检查点状态、事件、叙事均有差异且未重新收敛。
- explore：`artifacts/story-eval/wuxia-a-explore-0-2026-08-03T05-13-52-605Z-a925d36c`，10 幕、`status=generation_failed`、`fallbackRate=0`，随机探索在达到结局前停止；它没有真死局或恢复循环，且 generated facts 使用/调查覆盖仍为 `1.00/1.00`。复盘发现这不是随机选择或 provider fallback：评估器的 single-legal-action continuation bridge 执行直接规则行动后，若重新出现两个以上合法行动，`performAction` 原先不会为直接行动排队下一幕，导致空 narrative 被误报为 generation_failed。
- 对上述同一 `pairId=wuxia-a-20260803-1` 运行 `node scripts/storyEvalQualityGate.mjs ...`，结果为 `GENERATION_GRADE_OK`。本轮可归因收益是：真实蓝图满足每条 generated fact 的主线调查锚点，objective 可靠收敛，分支后果可观测，且 provider 的 CRLF JSON 不再触发开局 fallback。

### continuation bridge 后续场景修复（2026-08-03）

`performAction` 现对 AI 模式下所有成功规则行动统一使用同一 narrative queue 边界：只要结算后仍有至少两个合法行动，就持久化 `narrative.generation=pending`，不仅限于 `narrative_choice/dialogue_choice`。这样评估器的直接 `move/talk/investigate/observe/take_item` bridge 不会把游戏留在“可继续但没有场景”的空状态。新增 direct-action pending 回归测试；应用套件 65 个文件、509 项测试通过。此前真实 explore artifact 是修复前产物，不能用来判断修复后的 explore 收敛率，需在后续 baseline 中重新采集。

修复后使用同一 captured blueprint 重跑真实 explore：`artifacts/story-eval/wuxia-a-explore-0-2026-08-03T06-13-48-158Z-1050839c`，13 幕、`status=converged`、`fallbackRate=0`、`trueDeadEnds=0`、`recoveryLoops=0`。`hasResolutionEvidence=true`、`stageWindowViolations=0`，generated facts 使用/调查覆盖均为 `1.00`；paired checkpoint 的 state/event/narration 三类差异均成立。与 objective artifact 一起重跑 pilot gate，结果仍为 `GENERATION_GRADE_OK`。这才是 continuation 修复后的有效 explore 证据；七题材 release matrix 仍未执行。

### 中段转折约束与跨题材复测（2026-08-03）

- 真实 `xianxia-a` objective baseline（修复前 pacing 约束的代码版本）为 `artifacts/story-eval/xianxia-a-objective-0-2026-08-03T07-35-03-775Z-2e3fc108`：22 幕、`status=converged`、`fallbackRate=0`、主线目标与规则推进 `22/22`，generated facts 叙事/调查覆盖均为 `1.00`，3 组分支检查点均有状态/事件/叙事差异；但节奏为 `setup=1/develop=20/climax=1`，没有 `turn`，所以会被门禁判为 `PACING_ARC_INCOMPLETE`。这证明“结局收敛”不能替代中段转折，且该缺口跨出武侠题材。
- 同一题材的 regression 请求 `artifacts/story-eval/xianxia-a-objective-0-2026-08-03T07-20-14-891Z-17492a42` 受 provider 瞬时 `rate_limited/service_error/empty_response/invalid_json` 影响，18 幕中 3 幕 fallback、`status=max_scenes`；它没有暴露主线或事实契约错误，说明 regression 预算仍应与 provider 稳定性分开记录，不能把一次服务波动当成玩法结构结论。
- `deriveContentProgression` 现读取结构化剧情记忆：`budgetPolicy.gameLength=long` 的首幕且无近期记忆时只允许 `setup`；长蓝图中段已产生至少两场叙事且近期尚无 `turn` 时，下一场只允许 `turn`；已有转折后恢复 `develop/turn`。首幕锁定不作用于 short/medium、城镇流程或旧存档，避免结构约束误伤既有回放；Phase 10/11 黄金 fixture 的零网络回放仍通过。
- 修复后的真实 xianxia regression 为 `artifacts/story-eval/xianxia-a-objective-0-2026-08-03T08-15-49-900Z-fae353c4`（git `2e329e0`）：18 幕、`status=max_scenes`、fallback `5/18=27.8%`，`trueDeadEnds=0`、`recoveryLoops=0`。节奏约束确实生效：`setup=1/develop=13/turn=3`、`turnStages=[2,3]`、`stageWindowViolations=0`；但 provider 的 `service_error/rate_limited/timeout/invalid_json` 使旅程没有进入 climax/ending，主线只完成到 stage 4，故仍不能宣称跨题材 release 通过。
- 本次 post-fix 结果把问题边界收窄为两层：中段转折不再依赖模型自觉，剩余阻断项是 provider 可靠性与长旅程在失败预算下的收敛；下一步应先做同一蓝图的可靠性重跑/重试预算实验，再决定是否扩展七题材 baseline matrix。
- 对该单 run 运行 `node scripts/storyEvalQualityGate.mjs` 的稳定失败码为 `OBJECTIVE_NOT_CONVERGED, MAINLINE_PROGRESS_INCOMPLETE, FALLBACK_RATE_HIGH, PACING_ARC_INCOMPLETE`；这是一条有效的负证据，不应与通过的武侠 paired pilot 混合平均。
- 同一 captured blueprint 的 post-fix `baseline` 对照为 `artifacts/story-eval/xianxia-a-objective-0-2026-08-03T08-39-42-794Z-52e9dfd5`（git `46d1b23`）：首幕后即 `status=aborted`，writer 依次出现 `rate_limited → invalid_json → invalid_json`，`fallbackRate=1.00`。高 retry 预算没有把 provider 输出异常转化为可玩的长旅程，故当前 release blocker 明确是 provider/协议可靠性。
- `f619cf3` 增加了严格范围内的 escaped fenced JSON 恢复（runtime writer/NPC/director 与 scenario parser），并用真实 rawResponse 形状补了离线测试。随后真实 regression `artifacts/story-eval/xianxia-a-objective-0-2026-08-03T08-43-53-846Z-e4b0f85d` 的 `invalid_json` 已降为 0、fallback 降至 `2/18=11.1%`，但仍 `status=max_scenes`、未到 climax/ending；节奏已有 `turnStages=[2,3,6]`，说明协议修复有效但 provider timeout/rate limit 仍阻断长程收敛。
- 新增的 setup 约束（新长蓝图空 story memory 第一场只允许 `setup`）目前由纯函数测试证明；随后真实尝试 `artifacts/story-eval/xianxia-a-objective-0-2026-08-03T09-02-14-214Z-bfb5a848` 在首幕即遇到 `director rate_limited + service_error` 而 `aborted`，所以仍没有可用于验证完整 pacing 弧的 post-fix 样本，不能把离线约束当成跨题材实测通过。
- 当前提交 `97e22ff` 后补做了同一 xianxia objective smoke（均为 3 幕、无分支，不能作正式质量结论）：`artifacts/story-eval/xianxia-a-objective-0-2026-08-03T09-09-09-081Z-0eb91573` 使用 1 次角色尝试，蓝图生成成功但第 3 幕导演两次约 34 秒 `service_error`，`fallbackRate=2/3=66.7%`；将 `STORY_EVAL_MAX_ROLE_ATTEMPTS` 提到 2 后，`artifacts/story-eval/xianxia-a-objective-0-2026-08-03T09-12-37-179Z-f00b46b0` 完成 3 幕且导演失败降为 `0`，但编剧仍有 `3/5` 次失败、`fallbackRate=1/3=33.3%`。这说明角色级重试确实能恢复部分瞬时故障，却仍远高于生成级门禁 `5%`，下一步应做 provider 可靠性/退避实验，而不是继续放宽结构门槛。

### 下一轮优化顺序

1. 先按“叙事引用”和“规则调查”两条事实链复测：`usedFactIds/npcUsedFactIds` 统计编剧/NPC 是否实际引用，`actionEvents.fact_discovered` 统计玩家是否执行调查；不再把二者直接相除。
2. 用 `regression` 18 幕先确认固定 long 蓝图的 stage 8、boss、ending convergence；再用 `baseline` 60 幕或多蓝图长测确认跨结构稳定性。
3. 保持 `actionEvents` 与目标快照配对，继续监控 writer schema retry、pacing illegal order 和 NPC contribution。
4. 完成上述结构修复的多 seed A/B 后，再决定是否把 director thinking 提升为 dev/staging 默认；不提前改 production 默认。

### 生成级门禁与题材矩阵（2026-08-03）

已加入 `scripts/storyEvalQualityGate.mjs` / `npm run gate:story-eval`。它只消费 `manifest.json + metrics.json + 可选 scores.json`，按 `pairId` 聚合事实和分支，不把独立蓝图混作 A/B；缺 pairing、continuation、generated-fact 或 pacing 字段直接报 `EVIDENCE_INCOMPLETE`。默认 pilot 门禁要求 objective 收敛、主线推进、零真死局/恢复循环、fallback≤5%、事实覆盖、分支后果与阶段节奏；`--release` 再要求七种 gameType 全覆盖和 judge 证据。当前 gate 已有 pass/fail/coverage 缺失的离线测试，尚未把旧真实 artifact 伪装成新证据。

## 事实覆盖口径修正（2026-08-02）

复核发现，旧报告把 `directorPlan.allowedRevealFactIds`（编剧可引用的已发现事实许可）与 `fact_discovered`（玩家执行 `investigate` 后产生的规则事件）当成同一条“计划→实际揭示”链，因而“`fact_identity/fact_premise` 未实际揭示”的结论不成立。`allowedRevealFactIds` 按审批规则本来就不能包含未发现事实，也不会触发调查事件。

现已修正：导演上下文新增已发现事实卡片；编剧上下文保留导演 `relevantFactIds` 意图；运行时修复器在同一 discovered-only 集合内补齐 relevant→allowed 的交接；故事产物新增 `usedFactIds` 与 `npcUsedFactIds`。分析器现在将 `factsPerAct.actualFactIds` 定义为实际叙事引用，并另列 `discoveredFactIds`；旧产物仍兼容回退，但不能与新产物混作同一统计口径。下一次真实 regression 必须重新采集，重点观察叙事引用率、规则调查率、NPC/物品贡献与分支证据。

## 16 幕收敛回归（2026-08-02）

同一 captured blueprint、strategy seed `20260801`、`objective`、`AI_THINKING_ROLES=`、`branchMode=none` 的 no-thinking 回归使用 `maxScenes=16` 后，产物为 `artifacts/story-eval/wuxia-a-objective-0-2026-08-02T15-51-24-935Z-c88065e9`：13 个场景后 `status=converged`，`fallbackRate=0`，导演/编剧/NPC 均无 retry、invalid JSON 或 failure；物品 `item_obtained=1/1`，事实叙事引用在 8 个 act 均覆盖 `fact_identity/fact_premise`，最终战斗启动并进入结局。

分析器同时修正了终局目标口径：`defeat_enemy` 的直接 narrative action 是 `start_battle`，所以 `battle_started` 计入目标动作命中；战斗胜负仍由 `enemy_defeated` 与 ending 证据证明。修正后主线直接目标呈现/选择 `8/13`、目标事件命中 `8/13`、规则推进幕 `13/13`；这不等价于 prose 质量满分，`pacing.illegalOrderCount=2` 仍是后续叙事结构优化项。回归上限已从 12 调整为 16，避免将原本需要第 13 幕的正常终局误报为不收敛。
