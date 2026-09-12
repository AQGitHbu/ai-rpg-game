# Staged Review Contract Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按真实失败逐项修复审核归属、规划契约、修复反馈和内容分工，使错误可定位、可有界修复，正确回答不因跨轮混淆被撤销。

**Architecture:** 服务端编译独立审核检查项与问题 ID，模型只判断该项的语义，服务端负责目标与修复范围。规划契约在表达前检查；协议失败与内容修复分开计数，并保留发布摘要、请求总账、权限及原子写入。

**Tech Stack:** TypeScript、Vitest、现有 StageSource、SQLite job repository。

## Global Constraints

- 仅在 `.worktrees/staged-narrative-generation` 工作，不合并 main，不修改当前阶段指针。
- 生产失败显式重试，不生成确定性剧情兜底；不扩大 NPC 知识，不将 reviewer 原文作为指令。
- 不修改 `.foundation`、sibling 或 `docs/共同规范/`；共享 API 仅消费现有契约。
- 每项先固化真实失败，运行失败测试，再实现、运行对应回归，review 后进入下一项。
- 实际样本来源为 ignored `tmp/staged-retest-20260912/`；提交的 fixture 只保留最小授权文本、契约、模型错误输出及来源标识，不包含数据库、凭据或完整私密世界。
- 离线回放证明协议、隔离与状态机，不等同模型语义正确；真实模型回归单独记录结果，不篡改固定样本。
- 保留全局请求预算、deadline、fence、CAS、恢复计数和发布凭证校验；不通过放宽解析器接受错误目标。

### Task 1: 独立审核检查项与服务端路由

**Files:** 修改 `src/game/application/narrativeGeneration/dialogueConsistencyReview.ts`、`runDialogueConsistencyReview.ts`、`stageSource.ts`、`src/game/application/server/ai/staged/dialogueConsistencyReviewPrompt.ts`、`liveStageSource.ts`；新增 `dialogueReviewChecks.ts`、`dialogueReviewRealFailures.testutil.ts`、`dialogueReviewRealFailures.test.ts`；更新同目录审核/source/持久化测试。

**Interfaces:** 服务端 `DialogueReviewCheck` 使用唯一 `checkId`、封闭 kind、该项必需文本/契约、以 factId/aspect 绑定的 `inquiryId`；请求仅发送 checks，内部映射保留 unitKey/candidateId/scope。模型响应 violations 使用 checkId、受控 type、inquiryId 或纯意图 null；旧持久化 violation 仍能读取，新通过凭证必须匹配新策略摘要。服务端将合法结果映射为现有内部 DialogueViolation，模型不选择修复层级。

- [x] 固化武侠双目标字段、对照错填 candidate ID、科幻 unknown 完整回答和未来 time/reliability 污染样本；另保留 genuinely missing source 反例。
- [x] 先测试新接口拒绝旧双字段、未知 checkId、跨项 inquiryId；NPC reply check 中没有 future options，两个相同 aspect 不同 fact 的 inquiryId 不混用。

```ts
expect(replyCheck).not.toHaveProperty('options');
expect(replyCheck.inquiries.map(q => q.aspect)).toEqual(['source', 'purpose']);
// 将另一个候选的问题 ID 写入当前回答结果必须是协议错误，不是剧情拒绝。
expect(result.ok).toBe(false);
```

- [x] 实现独立 plan/selected/answer/option checks；保留未知/拒绝语义验证而非看到 answers 就自动 pass。模型提供的定位只能匹配服务端白名单。
- [x] 运行 `npx vitest run src/game/application/narrativeGeneration/dialogueReviewRealFailures.test.ts src/game/application/narrativeGeneration/dialogueConsistencyReview.test.ts src/game/application/narrativeGeneration/dialogueConsistencyRetry.test.ts src/game/application/server/ai/staged/dialogueConsistencyReviewPrompt.test.ts` 及 `npm run typecheck`；适配旧测试保证真实业务语义未删减。
- [x] 记录红绿测试与 review，提交 `fix(narrative): isolate review checks and server-owned routing`。

### Task 2: 表达前规划契约检查

**Files:** 修改 `src/game/application/narrativeGeneration/runJob.ts`、`dialogueReviewChecks.ts`、`runDialogueConsistencyReview.ts`、`src/game/application/server/ai/staged/planningPrompt.ts`；按职责新增 `planningDialogueReview.ts` 及同目录测试，必要时更新 `src/game/application/server/persistence/narrativeJobRepository.ts` 和解析测试。

**Interfaces:** 复用 Task 1 check 协议，在表达请求前只提交安全投影的 plan checks；以规划摘要保存批准凭证。最终审核只复核表达/历史，不重复将未来问题当当前回答。缺少/无效前置凭证不能调对应表达或发布。普通无条件任务在任何表达前完成；依赖真实上游披露才可投影的任务允许延后到该单元执行前，必须逐项记账并在发布时确认全部覆盖，不伪造 approved outputs 或学习回执。

- [x] 武侠两个具体问询缺 inquiries 的固定 fixture，断言规划审核 reject 时 narration/character/choices 请求数均为零；保留征求意见、行动提议、prerequisite 核实条件的正确反例。

```ts
expect(expressionCalls).toEqual([]);
expect(job.failureCode).toBe('dialogue_consistency_planning_contract');
```

- [x] 将 planning prompt 的可选说明明确为：无事实问询可为空，有事实问询必须逐项编码；不可用 ask 非空或关键词正则冒充语义检查。若增加显式分类字段，必须同步新 live 必填与旧存档兼容，不能默认为已通过。
- [x] 接入前置审核、摘要与预算；计划失败继续显式失败，本轮不强行增加自动重规划。通过后的表达须沿用原契约，前置审核不得授予知识或输出剧情。
- [x] 每个 plan check 最多报告一个足以确认拒绝的维度，避免为了列全问题而过报；重复 plan checkId 是协议错误，不静默过滤。不同检查项可各报告一项，expression 检查仍允许多个真实漏答。规划重做后全部重新审核，不把单项反馈当全部问题清单。条件 choices 单元整体延后，不引入部分候选绕过权限的投影。
- [x] 条件观察回归：上游实际披露前不将新知识或私密 brief 发给审核器；披露后才检查下游规划，未完成的延后检查不能发布。优先复用现有视角权限投影，不能以空占位输出冒充真实生成。
- [x] 运行新增前置审核测试、`runJob.test.ts`、`jobBudget.test.ts`、Task 1 回归与 `npm run typecheck`。
- [x] 记录红绿测试与 review，提交 `fix(narrative): validate dialogue plans before expression`。

### Task 3: 可操作反馈及有界修复闭环

**Files:** 修改 `src/game/domain/narrativeUnit.ts`、`src/game/application/narrativeGeneration/runDialogueConsistencyReview.ts`、`dialogueConsistencyReview.ts`、`src/game/application/server/ai/staged/liveStageSource.ts`、`dialogueConsistencyReviewPrompt.ts`、现有 AiContentRepair 适配及对应测试；按需要更新 job receipt/persistence。

**Interfaces:** 复用既有 AiContentRepair.detail，输出安全字段路径、允许键和错误类型；协议修复传给下一次审核请求。审核首次、协议修复、表达修复后复审有独立受控状态；总请求预算不重置。纯审计 retry 不是模型反馈。

- [x] 固化都市 character 多余 `type` 输出，断言反馈包含字段路径和 `type`，不带原始私密文本；协议错误后重试输入含具体错误定位。

```ts
expect(repair.detail).toContain('type');
expect(secondReviewPrompt).toContain('checkId');
expect(saved.usedRequests).toBeGreaterThan(initial.usedRequests);
```

- [x] 协议纠正最多一次，内容修复后复审最多一次；各审核阶段最多三次实际请求（首次、协议纠正、内容复审），仍受 job 全局预算/deadline。无效结果不清表达；有效 expression reject 只清相关依赖，planning reject 显式失败。每次重试有具体受控反馈，不复制任意 reviewer 指令。
- [x] 测试第一次协议错、第二次有效拒绝、表达修复、第三次通过；同 cycle 重启不恢复额度，摘要变化不洗计数，耗尽/超时/取消均不能发布。格式错误与内容失败保持不同诊断分类。
- [x] 运行 `dialogueConsistencyRetry.test.ts`、真实失败回归、`jobBudget.test.ts`、source 反馈测试、persistence 测试及 `npm run typecheck`。
- [x] 记录红绿测试与 review，提交 `fix(narrative): make review recovery actionable and bounded`。

### Task 4: 规划内容分工与公开风格

**Files:** 修改 `src/game/application/server/ai/staged/planningPrompt.ts`、`narrationPrompt.ts`、`characterPrompt.ts` 与 `stagedPrompts.test.ts`、`expressionBoundary.test.ts`；如调整安全 delivery 则修改 `src/game/application/narrativeGeneration/perspectiveContext.ts` 及对应测试。

**Interfaces:** 不新增世界权限；规划为旁白/NPC 指定互补内容，公开受控 delivery 继续独立于主角标签。表达只能润色获批 brief，不能自行删掉必须内容。

- [x] 固化科幻仪表/定位/第二跳在旁白与 NPC 重复的素材，作为真实模型风格回归输入；离线测试只证明职责和安全提示投影，不假称证明自然语言去重。
- [x] 规划规则明确可观察变化归旁白、回答/态度归 NPC；同一事实重复仅用于有目的的强调或争论。规划器不得先给双方完整重复 brief 再让表达器删改。无公开人格锚点时用受控职业/语气，不能泄露隐藏目标或把主角性格套给 NPC。
- [x] 原位替换 `PLANNING_CONTENT_RULES` 中强制“你……”复述玩家问题的规则及冲突示例：无新状态时只做极短对话衔接，不展开问题细节，不杜撰环境、动作或进展。保留 mandatory beats/contentFactIds 的必需覆盖，不以去重删除权威规则结果。

```ts
expect(characterPrompt).not.toContain(secretSentinel);
expect(narrationPrompt).toContain('旁白');
```

- [x] 运行表达职责、style 安全、Task 1–3 全部回归；真实成稿差异留待真实模型验证，不以提示快照作质量证明。
- [x] 记录测试与 review，提交 `fix(narrative): separate planned narration and dialogue content`。

### Task 5: 集成回归与交付

**Files:** 更新 `docs/agent/运行时AI导演与场景表演.md` 的失效契约；按引用需要更新既有系统文档。报告保存在 ignored tmp，计划保留任务验证结果。

- [x] 逐项审阅完整 diff，修复可复现问题；运行 `npm run accept`，不以定向测试代替集成验收。
- [x] 沿用真实失败的最小对照并增加未用于调试的反例，真实 API 回归预算最多 30 HTTP，调用前固定样本与配置，失败不重抽。原 24 次额度内发现“认识令牌”被附加 reliability 的诊断错误，增加 4 次固定识别/可信度配对回归；该批仍有多报 location，因此仅再增加 2 次验证单项充分拒绝契约。各批证据独立保留，不改成绩。记录协议有效率、逐维误报/漏报与路由；真实模型失败继续定位，未解决则如实记录，不宣称质量通过。
- [x] 对齐系统文档，运行 `npm run check:docs`、`git diff --check`，报告逐项修复、验证与仍需九包复测的质量限制，不合并 main。

## 验收证据

- Task 1：`961b79ba`；真实错误路由夹具与独立检查项完成，主审和独立 review 通过。
- Task 2：`f4fd9f3b`；规划前置审核、条件权限与发布凭据完成，独立 review 通过。
- Task 3：`4c46ee9a`；review 复现规划拒绝写入后中断会再次规划，`8e25136a` 修复并通过红绿与复核；同周期零新增请求，显式新周期可重试。
- Task 4：`2655ac91`；真实重复素材保留，完整连续对话提示中的残留复述规则修复，主审和独立 review 通过。
- 完整 `npm run accept` 在 `4a32c9db` exit 0：3282 测试通过、4 个 live 测试按环境门控跳过；lint/typecheck/test:fast/shared/boundaries/build/phase:status 全部完成。54 条 lint 提醒均来自未修改文件；文档检查 0 错误、既有篇幅软提醒。
- 最终独立跨项 review 的 133 项测试通过，无 P0–P2 发现。`2c7f6633` 仅清除夹具尾部空行，基线 `19af3daa` 到最终代码的 diff-check 通过。
- 30 次真实审核调用按四批原样保留，逐项结果与限制记录于 `tmp/staged-contract-recovery/真实回归记录.md`；修复和验证汇总见同目录 `逐项修复报告.md`。不同策略批次不汇总为最终准确率；最后令牌样本为网络失败，无模型结论。本次未重跑 main 或九剧情包，不据离线验收宣称可以替换 main。
- 保留 `staged-narrative-generation` 分支及现有 worktree，不合并、不推送、不修改阶段指针。
