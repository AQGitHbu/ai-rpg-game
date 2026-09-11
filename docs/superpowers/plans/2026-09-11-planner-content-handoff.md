# Planner Content Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 从指定 SHA 重新修复：规划器决定完整内容，其他三个角色只润色，真实连续对话三轮以上。

**Architecture:** 现有 ExpressionTask 增加专属 brief 和必须正文的 contentFactIds；保持原 planning → narration/character/choices 链路。完整历史先按权限投影，再限制当前输出事实。同场同 NPC 的完整回应只规划一个 unit，不增加逐单元模型审核。

**Tech Stack:** TypeScript、Vitest、现有 staged source 与 SQLite。

## Global Constraints

- 基线 79c41172ae7b305339af90ab4783b3967f043c8f，工作目录 .worktrees/staged-narrative-generation；不提交、合并或清理 worktree。
- 原修复已归档 tmp/abandoned-dialogue-repair-37cd2995-712c-49fe-99bd-3addc4f3047a，不复用其生产补丁。
- 不修改用户数据库、.env.local、logs、.foundation 或受保护 sibling。
- brief 只包含本角色/候选内容，其引用经过可知/可披露检查；不转发全局备注或其他角色私密内容，brief 不授予额外事实权限。
- 新生产任务必须有 brief/content；旧存档可读，旧生产缓存缺内容时沿已有预算有界重新规划。
- 不处理待确认的 UI 整页重复，不新增 expression_review、合并器、背景归一化器或确定性正文。

### Task 1: 完整内容契约与单次 NPC 回应

**Files:** src/game/domain/expressionTask.ts 及测试；application/narrativeGeneration 的 expressionTask、approveUnit、stageSource、runJob、dialogueContinuity 及测试；server/ai/staged 的 liveStageSource、planningPrompt 及测试。

**Interfaces:** ExpressionTask 增加 brief?: string（1–1200字符）和 contentFactIds?: readonly string[]（focus 子集）。StageSource.requiresTaskBrief?: boolean 只在 live 源启用。projectExpressionTask 在引用权限检查通过后原样保留 brief。

- [x] 添加回归：留意刀客、告示发布衙门的完整意思进入表达任务；未知回答不强制重讲背景；越权引用拒绝，字段解析与旧缓存恢复兼容。
- [x] parser 增加两个可选字段；新 live 必须提供。必须引用计算改为以下函数并由 approveUnit 消费：
```ts
const required = [...(task.contentFactIds ?? task.focusFactIds), ...task.prerequisiteFactIds,
  ...(task.answers ?? []).flatMap(answer => answer.answerFactIds)];
```
- [x] planning 明确一次完整 NPC 回应一个 unit，brief 只写本轮回答/问题对象、未知范围、态度与协助对象/方式及必要条件，不夹带背景摘要。生产新请求与缓存检查缺 brief/content、同场同NPC重复，沿已有规划修复，不自动改写规划。
- [x] 运行 expressionTask、approveUnit、singlePlanner、liveStageSource 和缓存恢复相关测试，提交任务审查结果。

### Task 2: 完整上下文与纯润色

**Files:** src/game/application/narrativeGeneration/perspectiveContext.ts 及测试；src/game/application/server/ai/staged/characterPrompt.ts、choicePrompt.ts、narrationPrompt.ts 及必要测试。

**Interfaces:** 沿用 SafeContext；choices 的 dialogue 补公开 addresseeRole。Task 1 的完整说明经 taskInstruction 传递。

- [x] 回归前文含两个公开事实、本轮只有一个时仍保留完整回应；含越权事实整段不传，不留下孤立尾句；跨NPC/未来隔离保持。
- [x] 收窄 visibleFacts 之前保存 historyFacts，用于 priorText 与 previousReply 完整权限检查。NPC 不读未选候选，choices 不把旧选项当模板。
- [x] 三个表达 prompt 以完整 brief 决定说什么，事实表只约束可说范围；只调整语气/句式，不重新决定回答、问题对象或帮助方式，不为篇幅复述背景。
- [x] 运行 perspectiveContext、staged prompt 与角色隔离测试，审查 diff。

### Task 3: 真实对话与收尾

**Files:** src/game/application/testing/dialogueCoherence.live.test.ts；docs/agent/运行时AI导演与场景表演.md；docs/superpowers/reports/2026-09-11-planner-content-handoff.md。

- [x] 原失败存档快照复制到独立数据库，重放原问题加三次真实选择；只在测试副本延长同NPC对话期，原数据保持不动。
- [x] 将授权事实和内容决策要求放在规划提示的输出位置，明确未知不补经历、不复述背景。通过现有 SQLite 任务表的最小只读查询，给规划器最近最多六项同游戏、同 NPC、当前 revision 之前已发布的选择与当时对白；总量最多 12,000 字符，整项取舍。只在本次执行中使用，不改存档 schema，不增加模型调用。
- [x] 保存 API 审计和逐轮输入、NPC、选项；人工检查内容与 brief 一致、无整段复述/重问/态度协助变形。失败如实记录，不继续叠加审核。
- [x] 运行 typecheck、test:boundaries、完整 npm test、check:docs、修改文件 ESLint、git diff --check；系统事实原位更新。
- [x] 发现任务含义或上下文问题时直接修传递契约，不增加针对某一句故事的规则堆叠。

- [x] 本次问题的真实语义验收：最终 21603a1a 样本重放原问题加三轮选择，通过整段重复、完整回应、态度/条件及选项承接检查。前期失败与性能代价全部保留在同名报告，不表示所有未来对白必然通过。

### Task 4: 收敛现有提示的内容职责

范围限 staged 的 planning、character、narration、choice 提示和 live source 的角色消息，以及对应测试与验收记录。数据结构、历史查询、审批和调用链不变。

- [x] 规划内容职责收口到系统消息，brief 只写本轮内容；上一轮已选和未选候选单列比较。
- [x] 润色输入先提供上下文、最后提供唯一内容稿；事实表只核对引用，不作正文提纲。
- [x] 普通对白省略本轮不需要的世界增量说明，删除重复场景骨架；开局和幕间仍保留所需契约。
- [x] 固定选择的 label 作为当前玩家原话；仅含可选 atmosphere 时不制造必选旁白任务。取消未改善语义的专用格式模板实验，继续使用原 PlanProposal 契约。
- [x] 同一冻结存档副本重放原问题加至少三轮，逐项核对规划与最终对白；记录所有失败和剩余问题。

### Task 5: 现有规划思考策略

真实对照：相同模型与内容提示，关闭思考时仍复述背景并重复选项；仅 planning 开启既有思考开关后，原问题加三次连续选择的主要对白问题未再出现。保留全部失败，不继续增加提示规则或审核角色。

- [x] 仅调整 RPG 的 planning 默认 thinking 为 on，其他角色、预算和重试不变；显式环境列表仍覆盖默认，显式空值仍关闭全部。不修改 `.env.local` 或共享 transport。
- [x] 测试默认装配和显式关闭；更新唯一 AI 环境契约及 `.env.example`。
- [x] 按实际默认配置再完成原问题加至少三轮真实选择，核对 NPC、两条候选、旁白及每轮调用次序；最终 17 次 provider 调用含一次既有规划截断重试，角色各 4 次，约 292 秒。
- [x] 最终工程检查与报告：3107 项全量测试及最后提示改动的 112 项定向回归、类型/边界/ESLint/文档/diff 检查通过；保留规划思考变慢与预算截断重试的限制。
