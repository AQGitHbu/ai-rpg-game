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
| story.jsonl | 旅程驱动 | 场景序号/主线阶段/narration/NPC 台词/最终选项文案/导演计划摘要/fallback/玩家选择/规则事件 |
| manifest.json | 旅程驱动 | gameId/世界 seed/策略 seed/gameLength/模型/开局蓝图快照 |
| metrics.json | analyze 脚本 | §3 全部客观指标 |
| scores.json + report.md | judge 脚本 | 结构化分数 + 证据 + 人工抽查清单 |

## 脚本与命令

- `npm run journey:story-eval`：replay 模式（零网络离线用例）
- `npm run smoke:ai:story-eval -- --case=<caseId> --runs 12 --seed <n>`：record 模式（需 `RUN_REAL_AI_STORY_EVAL=1`，按 v2 case/strategy 矩阵运行；试点只传一个 `--case`）
- `npm run analyze:story-eval -- <runDir>`：客观指标 → metrics.json
- `npm run judge:story-eval -- <runDir>`：三段评审（需 `RUN_REAL_AI_STORY_EVAL_JUDGE=1`）→ scores.json + report.md

> 前向引用（Task 13 接线）：当前门禁脚本已实现 `--case` 解析（`resolveCaseId`），但 record 模式
> 尚未按 case 过滤或注入 `STORY_EVAL_CASE_ID`/`STORY_EVAL_STRATEGY`——v2 case 集
> （`data/story-eval/cases/v2.json`）、双策略矩阵与 `--case` 生效由 Task 13 完成。

## 基线流程

先选 1 个固定 case 跑两种策略与成对分支，完成 completeness、analyze、judge 及人工/异模型校准 → 校准通过后完成其余 5 个 case 的两种策略（共 12 条主旅程）→
汇总为基线 v2（`artifacts/story-eval/baseline-v2/report.md`，工作产物）；持久基线回填
`docs/策划文档/AI内容质量评估标准.md` 的分数表、客观指标摘要和校准结果。基线是描述性快照，不是及格线。

## 环境变量（全部可选）

STORY_EVAL_CAPTURE（服务端装配开关，浏览器手玩采集需在启动 dev server 的 shell 中临时设置）、
STORY_EVAL_ARTIFACT_DIR（门禁脚本注入）、RUN_REAL_AI_STORY_EVAL、STORY_EVAL_SEED、
STORY_EVAL_MAX_SCENES（默认 60）、RUN_REAL_AI_STORY_EVAL_JUDGE、STORY_EVAL_JUDGE_MODEL。

## 已知发现（基线阶段只记录不修）

- writer 选项文案被规则文案替换后才展示：若 C3 基线分低，改 prompt 无效，需改规则文案或放开 writer 文案。
- 同模型评审自身产物存在自我偏袒风险：由人工抽查校准；偏袒明显时设 STORY_EVAL_JUDGE_MODEL 为独立模型。
