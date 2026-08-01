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
| story.jsonl | 旅程驱动 | 场景序号/主线阶段/narration/NPC 台词/最终选项文案/导演计划摘要（allowedRevealFactIds/introducedEntities/扩展提议）/fallback/玩家选择与策略理由/安全规则事件（factId/entityId/questId/endingId）/memory 摘要/焦点 NPC profile/关系摘要 |
| manifest.json | 旅程驱动 | gameId/世界 seed/策略 seed/gameLength/模型/temperature/timeoutMs/caseId/strategy/gitCommit/prompt 与契约版本/S4 answerKey/开局蓝图快照 |
| branches/stageN/&lt;choice&gt;/branch.json | 旅程驱动 | 成对分支证据：parent scene、所选 actionKey、两场后结构化事件、状态差异、玩家可读 narration；不足两个合法选项时写 not_applicable.json |
| metrics.json | analyze 脚本 | §3 全部客观指标（含 factsPerAct 双口径、实体/扩展漏斗、选择漏斗） |
| scores.json + report.md | judge 脚本 | 结构化分数 + 证据 + 人工抽查清单 |

**完整性约束（spec §7，Task 13）**：`incomplete` 产物（缺 calls、必要 manifest、S4 answer key，
或任一场景缺 previousScene/NPC 场景缺 memory+profile+关系摘要/规则事件缺安全 ID）不可进入分析
或评审，**不能产生基线分数**；journey 返回 `status: "incomplete"` 并以非零退出，judge 也不接受
未经完整性校验的 run。

## 脚本与命令

- `npm run journey:story-eval`：replay 模式（零网络离线用例）
- `npm run smoke:ai:story-eval -- --case=<caseId> --runs 12 --seed <n>`：record 模式（需 `RUN_REAL_AI_STORY_EVAL=1`；缺省按 v2 case 集展开 6 case × 2 策略 = **12 条主旅程**，试点只传一个 `--case`；`--runs` 只能在 `--case` 内复制并标记 replicate，不得当作新 case）
- `npm run analyze:story-eval -- <runDir>`：客观指标 → metrics.json（含实体/选择漏斗）
- `npm run judge:story-eval -- <runDir>`：三段评审（需 `RUN_REAL_AI_STORY_EVAL_JUDGE=1`）→ scores.json + report.md

Task 13 接线状态：record 模式已按 v2 case/strategy 确定性展开，childEnv 注入
`STORY_EVAL_CASE_ID`/`STORY_EVAL_STRATEGY`/递增 seed/独立 artifact 与 db；未知 case 以
`INVALID_CASE` 退出；judge 侧 C1/C2 证据包由 story 行自带（NPC profile/关系摘要/memory/前序场景），
绝不把 `calls.jsonl` 或原始 prompt 交给 judge；S8/S9 在无成对分支证据时强制 cap 为 3。

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
STORY_EVAL_MAX_SCENES（默认 60）、RUN_REAL_AI_STORY_EVAL_JUDGE、STORY_EVAL_JUDGE_MODEL。

## 已知发现（基线阶段只记录不修）

- writer 选项文案被规则文案替换后才展示：若 C3 基线分低，改 prompt 无效，需改规则文案或放开 writer 文案。
- 同模型评审自身产物存在自我偏袒风险：由人工抽查校准；偏袒明显时设 STORY_EVAL_JUDGE_MODEL 为独立模型。
