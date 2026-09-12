# Staged Semantic Delivery Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 修复真实复测暴露的对白审核角色/维度混淆、行动建议漏问询、规划无法有界自修复和 thinking 规划时间预算不匹配，再用原九任务与 main 历史基线比较。

**Architecture:** 保留生产 planning → 表达 → 审核路径和所有权限门禁。明确审核问题所属角色及维度语义，规划器与审核器使用一致说明；只对合法的当前规划语义拒绝提供每周期一次持久化修复，网络与 uncertain 不伪装为内容问题。

**Tech Stack:** TypeScript、Vitest、Node.js、SQLite、既有 RPG AI source/client。

## Global Constraints

- 在 `.worktrees/staged-narrative-generation` 工作；不修改 main，不合并或推送，不启动 current-phase.json 指向的其他阶段。
- 不修改 `.foundation`、`docs/共同规范/` 或 sibling foundation；不新增依赖、生产并行链、确定性剧情替代或关键词放行器。
- 生产失败显式重试；不得关闭审核、扩大知识权限、把未批准草稿当成发布、给失败样本编造质量分。
- 所有真实失败先留为有出处的离线样本；离线测试验证协议、投影和状态机，不能宣称它们证明模型语义质量。
- 每个实现任务先失败测试、后修复及回归，subagent 开发，root 进行规格和代码审查；任务独立提交，修复审查问题后再进入下一任务。
- 保留 job 请求、单元尝试、租约/fence、deadline、旧记录可读及同周期恢复的计数约束；手动重试才建立新周期。
- 真实 API 仅 root 在实现验收后执行；main 复用 `60f0e873` 历史九任务。测试输入、门槛、发送预算和代码哈希在调用前冻结。

## Task 1: 审核边界、问题维度与行动问询

**Files:**
- Create: `src/game/application/narrativeGeneration/dialogueReviewSemanticFailures.testutil.ts`、`dialogueReviewSemanticFailures.test.ts`
- Modify: `src/game/application/narrativeGeneration/dialogueReviewChecks.ts`、`dialogueConsistencyReview.ts`
- Modify: `src/game/application/server/ai/staged/dialogueConsistencyReviewPrompt.ts`、`planningPrompt.ts` 及对应测试
- Create if useful: `src/game/application/server/ai/staged/inquirySemantics.ts`，仅作为两个 RPG prompt 共用的语义说明。

**Interfaces:** 保持 `compileDialogueReviewChecks(subjects, phase)`、`validateDialogueReviewVerdict(value, request)` 和服务器路由公开签名。answer/plan_answer 的 inquiries 是玩家已经向 NPC 提出的问题，不是 NPC 问玩家的问题。规划阶段必须只输出 plan checks，即使传入 subject.text。

- [x] **Step 1: 固化原文与明确/不确定结论。** 从 `tmp/staged-final-retest-20260912/diagnostic-corpus.json`、`control-review.json`、`failure-review.json` 提取安全最小 DTO，标明来源；覆盖令牌辨认≠reliability、NPC“是不是也撞上了”≠cause、是否调查≠method、来源的“来自哪里”不必额外location、已给“这几夜”范围≠索取time，以及无船只应答≠无船只。前四项不能靠把所有相邻维度补进 inquiries 解决；不确定的样本记录歧义。
- [x] **Step 2: 编译/校验失败回归。** 增加如下行为断言，再运行 `npm test -- src/game/application/narrativeGeneration/dialogueReviewSemanticFailures.test.ts`，先保留失败证据：

```ts
const compiled = compileDialogueReviewChecks(subjectsWithText, "planning");
expect(compiled.request.checks.every(c => c.kind.startsWith("plan_"))).toBe(true);
expect(compiled.request.checks.every(c => c.text === undefined)).toBe(true);
// 对 answer/plan_answer，extra_inquiry 不能把 NPC 的主动提问算为玩家遗漏的问询。
expect(validateDialogueReviewVerdict(npcQuestionAsExtraInquiry, answerRequest).ok).toBe(false);
```

- [x] **Step 3: 最小实现。** 编译表达 checks 使用 `phase !== "planning" && subject.text !== undefined`。禁止 answer/plan_answer 的 extra_inquiry 路由；其新增未获批话语用 brief/intent 忠实度判断，missing_response/answer_mismatch 仍必须覆盖玩家已问维度，不能漏掉 NPC 回答审核。明确 source 问信息/信物的起源，location 问独立空间所在，identity 辨认，reliability 问事实真假，cause 问成因，method 问具体做法，time 问尚待提供的时间；共享语义说明进入规划和审核 prompt，禁止关键词判定和相邻维度穷举。
- [x] **Step 4: 约束规划内容。** `offer/support` 不携带新的事实问题；混合建议与问询必须改为 ask/challenge 并逐项登记，或只保留提议。prerequisite 仅能复核原事实本身，不能把“无应答”升级为“无船只”，不能新增条件结论。NPC 主动提问不转换成玩家回答义务；保持 brief 含义和表达忠实。更新审核 policy revision，使旧 pass 不可复用；增加角色边界、纯规划、权限隔离和 prompt 装配测试，不使用离线 fake reviewer 证明模型会答对。
- [x] **Step 5: 回归与提交。** 运行 `npm test -- src/game/application/narrativeGeneration/dialogueReview src/game/application/server/ai/staged/dialogueConsistencyReviewPrompt.test.ts src/game/application/server/ai/staged/planningPromptContract.test.ts`、`npm run typecheck`，review 后提交 `fix(narrative): clarify review roles and inquiry semantics`。

## Task 2: 规划语义拒绝的一次持久化修复

**Files:**
- Modify: `src/game/application/narrativeGeneration/planningDialogueReview.ts`、`runJob.ts`、相关 runner helper
- Modify: `src/game/application/server/persistence/narrativeJobRepository.ts`、对应 SQLite 存储验证/重试控制（按引用定位）
- Test: `src/game/application/narrativeGeneration/planningDialogueReview.test.ts`、新增 `planningSemanticRepair.test.ts`、存储恢复测试

**Interfaces:** 在现有 StoredJob 加可选的周期级 `planningSemanticRepair` 记录，含 cycle、已消耗次数（上限 1）、待修复/已重做/耗尽状态及服务器编译的 violations；缺省不授予有语义拒绝的旧记录新额度。实现可以拆为同目录 helper，但不得新建生产 source。反馈沿用 `StageExecution.repair`，reason/rejectionCode 标记 `dialogue_consistency_planning_contract`，detail 仅受控 ID/枚举/维度及原获批场景契约，不转发 reviewer 自由文本。

- [x] **Step 1: 失败回归。** 以 Task 1 科幻 offer 漏问询样本与真实协议纠正输出构造 injected source 序列：规划合法、预审 reject、规划修正、预审 pass、表达与最终审核通过。断言 planning 调用恰为 2、只有修正骨架表达能发布；现实现应失败。另记录永远 reject、协议错误后 reject、恢复时改 unit key 的情况。

```ts
expect(planningCalls).toHaveLength(2);
expect(planningCalls[1].execution.repair?.rejectionCode)
  .toBe("dialogue_consistency_planning_contract");
expect(publishedPlan).toEqual(repairedPlan);
expect(job.usedRequests).toBe(actualSourceCalls.length);
```

- [x] **Step 2: 原子状态变更。** 首次合法 planning reject 与耗用唯一语义修复额度、撤销旧骨架/全部依赖表达/发布凭据一起 fenced 保存；同周期恢复只能继续这一修复，不能再次拨额度。规划重做必须保留已经批准的 worldDelta/sceneContract，不重新造世界以逃避问题；重新经过所有结构/权限和规划预审。复审旧/新 unit key 都保留已使用的协议次数，不能通过改摘要或 key 恢复审核预算。计数不足或 deadline/fence 失败立即结束。
- [x] **Step 3: 有界结束与兼容。** 第二次语义拒绝进入原显式失败码；uncertain、provider失败、legacy mismatch 不启动规划改写。表达阶段延后预审拒绝也遵循同一周期额度，撤销已生成表达后才能重新规划。旧语义拒绝凭据缺新记录时保持失败；已记录待修复、规划请求进行中、复审进行中三个崩溃点分别恢复，均不增加次数。手动新 cycle 可按既有规则重置修复额度。
- [x] **Step 4: 针对回归。** 覆盖首次修复成功、永久拒绝只改一次、协议纠正额度保留、三处崩溃恢复、unit 重命名、权限冲突、预算/取消/失租、SQLite roundtrip/发布拒绝旧凭据；运行 `npm test -- src/game/application/narrativeGeneration src/game/application/server/persistence/narrativeJob` 与 `npm run typecheck`。root review 后提交 `fix(narrative): recover one semantic planning rejection`。

## Task 3: thinking 规划时间预算与全量验收

**Files:**
- Modify: `src/game/application/narrativeGeneration/runJob.ts` 或现有 timeout 常量入口、`src/game/application/server/ai/rpgAiClient.ts`及同目录测试
- Modify: `docs/agent/运行时AI导演与场景表演.md`、`docs/agent/AI环境.md`
- Evidence: `tmp/staged-semantic-repair/timeout-diagnosis.md`、本轮各任务报告

**Interfaces:** 保留 client 共用剩余 timeout 的 transport retry，单次 planning 与 job 绝对截止分别约束；不因重试再获取完整时间。不改共享 transport。90 秒超时只证明本地等待到期，不能声称已确定远端根因。

- [x] **Step 1: 按诊断冻结最小修复值。** 核对 `timeout-diagnosis.md` 与 runJob、runtime policy 的重复 90 秒上限、现有 job deadline。把 thinking planning 单次上限对齐现有 opening 的 240,000 ms，并保持调用前 `min(planningLimit, remainingJobMs)`；未开启 thinking 的策略保持原有上限。若 runner 不感知 thinking，runner 只做 240,000 ms 外层上限，client 仍按角色实际策略截断。不得扩大每 job 请求数或取消 deadline。
- [x] **Step 2: 先写 fake-clock 回归再实现。** 检查 planning thinking 开启/关闭策略、传给 transport 的最终 timeout、job 剩余时间不足时仍取较小值、超时/取消零发布、不重试空响应、不重置 transport 剩余预算。不在离线测试等待真实 90 秒。

```ts
expect(thinkingPlanning.timeoutMs).toBe(240_000);
expect(nonThinkingPlanning.timeoutMs).toBe(90_000);
expect(capturedRequest.timeoutMs).toBeLessThanOrEqual(remainingJobMs);
```

- [x] **Step 3: 原位同步系统契约。** 写清角色边界、一次语义规划修复/计数恢复和超时约束；旧“语义拒绝不自动规划”事实原位替换，过程证据只在 Plan/报告。运行针对回归，root review 后提交 `fix(narrative): align thinking planning timeout budget`。
- [x] **Step 4: 完整验收。** 运行 `npm run accept`（含 typecheck、boundaries、所有离线测试、docs、lint、build），`git diff --check`；独立最终 reviewer 审阅本 Plan 全部改动，root 修完发现的问题后冻结提交。main 和当前阶段不变。

## Task 4: 原九任务真实复测与独立评分

**Files:** Create ignored `tmp/staged-semantic-retest-20260912/` 中的预案、运行器、预注册、审计、结果与报告；沿用 `tmp/staged-final-retest-20260912/` 的 main 基线、输入和原门槛。

**Interfaces:** 使用 production composition 的 smoke 开局+同快照两个选项，共九任务；固定对照用正确 planning/expression phase；Task 1 真实语义样本作为独立新增 controls，不能替换原 20 条来提高成绩。

- [ ] **Step 1: 调用前冻结。** 保留原五维权重 25/25/20/20/10 与四维修复标准；9/9、无确认串台/越权/合同漂移、四维各均值≥4且单项≥3。原 20 控制加 Task 1 最小真实语义对照，逐条预定允许的 verdict/fact/aspect 与歧义口径，纯规划不含表达；真实剧情最多90次HTTP，对照上限按冻结条数、总时长45分钟。写文件 SHA256、输入、role 策略和发送前扣账。
- [ ] **Step 2: 一次真实运行。** root 执行已授权 API；不重跑 main，不失败重抽，不关闭门禁。输出不足则保留失败/未启动分母，网络、协议、语义修复次数和已上报 token 分列。
- [ ] **Step 3: 独立审核成稿与失败。** reviewer 只对 published 样本按原方案评分；root 配对同名 main 原分，并用原审计检查误报和权限。零成稿时质量为 N/A；控制通过不抵消生产失败。给出能否替换 main 的明确结论，保存报告与样本，不在评估中途继续调代码。

## 验收证据

实现与逐项 review 记录在本 Plan 对应 SDD ledger。真实评估报告独立保存，计划本身不证明模型语义修复成功。

- Task 1：`61a8d8a4`。三个预期 RED 后 targeted 54 项通过，追加既有集成回归 85 项、boundaries 127 项与 typecheck 通过；root 修正角色范围说明后批准。
- Task 2：`d29dbe0f`、`ba2724c7`。语义修复与存储相关回归 394 项通过；真实科幻已登记 inquiryId 被误报 extra 的协议纠正序列 18 项通过。root 审查修复了锚点发布验证、损坏记录读取、实际重规划反馈和初始锚点更新问题。
- Task 3：`fe8949e4`。targeted 85 项、boundaries 127 项、typecheck、docs 及 diff-check 通过。root 纠正了草稿中的超时窗口续期，使 planning 重试共用 240/90 秒完整调用窗口。
- 全量验收：在 `fe8949e4` 执行 `npm run accept`，3325 tests passed、4 gated live skipped，lint 0 errors（54 warnings），typecheck、test:fast、docs、build 通过。日志：`tmp/staged-semantic-repair/accept.log`。当前阶段仍为原 planned/not_started。
- 独立最终代码审查：范围 `9f5e9b56..fe8949e4`，未发现确认的严重生产缺陷；指出 SQLite 发布测试可能因缺少 current_game 而假绿，以及一处事实来源措辞不一致。`f4cc3527` 增加可成功发布的真实 SQLite 对照、精确 JOB_CONFLICT 和无部分写入断言并修正文案；针对回归 62 项与 typecheck 通过，root 和原独立 reviewer 均确认两项关闭。仅测试改动后没有重复全量验收。审查和修复报告保留在 `.superpowers/sdd/2026-09-12-staged-semantic-delivery-repair/`。
