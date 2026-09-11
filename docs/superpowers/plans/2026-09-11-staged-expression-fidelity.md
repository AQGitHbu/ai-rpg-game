# Staged Expression Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复真实样本的说话身份错位、无依据细节和具体询问意图丢失，保留四模块与完整包发布。

**Architecture:** 在现有 SafeContext 内绑定玩家和对话对象，在既有 ExpressionTask 中添加有界询问维度；三个表达 prompt 共用事实边界。只沿用新增知识的 disclosure_review，不新增生成器或通用在线审核。

**Tech Stack:** TypeScript、Vitest、现有 RPG AI client、SafeContext/approveUnit。

**验收状态：** 下列实施与测试步骤已执行，结果见[验收报告](../reports/2026-09-11-staged-expression-fidelity.md)。复选框不代表完整语义保真通过：自然开局仍有无授权声响、读数与动作，NPC 固定样本仍有过度概括；保留为未闭环限制，不以自动测试通过掩盖。

## Global Constraints

- 以[最新 Spec](../specs/2026-09-09-staged-narrative-generation-design.md)为准；不恢复历史 Plan。
- “不同措辞的同义回应不算差异。”不同走向不要求新地点。
- “仅 pass 才授予下游认知；reject、uncertain、缺失审核能力和请求失败均不批准该单元或发布整包。”
- 不把自然语言启发式或 prompt 断言当作语义安全证明，不用确定性正文冒充生产生成。
- 本轮只修改目标 worktree。先提交既有修复，再优化并验收；不合并 main 或 push。
- 执行技能在本会话不可用，按用户已经给出的实施授权内联执行；不另派子智能体。
- 小范围真实测试独立目录、至多 40 次 provider 请求、15 分钟，包含传输重试；失败记录后停止该样本，不为获取期望 verdict 反复付费。

### Task 1: 说话身份绑定

**Files:** 修改 `src/game/application/narrativeGeneration/perspectiveContext.ts`、`approveUnit.ts`、`server/ai/staged/choicePrompt.ts` 及同目录测试。

**Interfaces:** SafeContext 新增可选 `dialogue:{speakerId,speakerName,addresseeId,addresseeName}`；生产 choices 从批准 decision.npcId 和当前快照构造。approveUnit 保留原接口，新增明确自我称呼拒绝。

- [x] 写红测试：玩家凯伦/NPC林澈，label “凯伦，你能确认吗？”返回 unit_output_self_address；“我叫凯伦”不误杀；普通/终幕均使用批准对象。

```ts
expect(approveUnit({ unit, context, output })).toMatchObject({
  ok: false, code: "unit_output_self_address",
});
```

- [x] 运行 `npx vitest run src/game/application/narrativeGeneration/approveUnit.test.ts` 确认失败。
- [x] 投影独立身份，prompt 明确第一人称为玩家、第二人称为指定 NPC，前文称呼不是本次说话身份。仅对明确称呼模式拒绝，不禁止玩家名字的所有出现，不改写 label。
- [x] 重跑审批/投影/prompt 测试，类型和边界通过后记录结果。

### Task 2: 表达事实边界

**Files:** 新建 `src/game/application/server/ai/staged/expressionBoundary.ts` 与测试，修改 narrationPrompt、characterPrompt、choicePrompt。

**Interfaces:** `expressionBoundary():string` 为固定安全规则，不读取全局剧情/秘密，三个 prompt 各自嵌入。

- [x] 先以真实样本建立边界回归，检查三个 prompt 包含同一安全约束，不包含新的事实正文。
- [x] 明确区分修辞与实质信息：不能由授权事实推演历史比较、目击细节、线索、设备运行状态、玩家动作或机构承诺；facts=[]/合法 ID 不免责。没有授权氛围素材时用事实本身组织紧凑叙述。

```ts
expect(buildNarrationPrompt(context)).toContain(expressionBoundary());
expect(buildCharacterPrompt(characterContext)).toContain(expressionBoundary());
expect(buildChoicePrompt(context)).toContain(expressionBoundary());
```

- [x] prompt 测试通过；实际是否避免补写留给 Task 4 的独立真实样本验收，不用关键词删改输出来伪造通过。

### Task 3: 结构化具体询问维度

**Files:** 修改 `src/game/domain/expressionTask.ts` 及测试、`application/narrativeGeneration/expressionTask.ts` 及新测试、planningPrompt，更新 Spec/运行时契约。

**Interfaces:** ExpressionTask 可选 `inquiries:readonly {factId:string;aspects:readonly InquiryAspect[]}[]`；InquiryAspect 为受控枚举 identity/location/direction/depth/time/cause/method/quantity/source/reliability/purpose。每项锚定 focusFactIds，最多4项、每项最多4维度、不重复，仅 ask/challenge 允许非空；不携带答案或任意文本。

- [x] 写红测试：parseUnit/parseBranchOption 保留方向与深浅；未知枚举/非focus引用/重复/非问询意图拒绝。
- [x] 解析与投影保留每个维度，输出受控中文任务“针对该已知事实询问走向、深浅；未知答案不能视为已知”。受众不可知 fact 继续返回 beat_authority_conflict，不能删维度或偷偷转发 publicIntent.text。

```ts
const task = { intent: "ask", focusFactIds: ["fact_1"], prerequisiteFactIds: [],
  inquiries: [{ factId: "fact_1", aspects: ["direction", "depth"] }] };
expect(projectExpressionTask(task, facts)).toMatchObject({ ok: true });
```

- [x] planningPrompt 列出枚举和示例，具体询问不得只放自由备注；候选 prompt 保留生成后的安全任务。重跑 domain、projection 和 prompt 测试。

### Task 4: 小范围真实验收及收尾

**Files:** 新建 `src/game/application/testing/stagedExpressionFidelity.live.test.ts`（默认跳过）、同目录受控测试样本文件；更新 disclosureReviewPrompt 分类说明与测试；报告存 `docs/superpowers/reports/2026-09-11-staged-expression-fidelity.md`。

**Interfaces:** 使用生产 createLiveStageSource/approveUnit/projectExpressionTask/reviewDisclosure，真实网络调用统一包装 fetch 计数和绝对截止时间。审核负例是明确标注的受控输入，不伪装成自然游戏剧情。

- [x] 固定真实失败场景：凯伦/林澈选项；边城目击；科幻供氧/脚印；都市电话；询问方向/深浅。真实输出保存审计，分别检查身份、格式、内容保真和任务具体性。
- [x] 审核固定正例/明确拒绝/上下文指代不明：分别期望 pass/reject/uncertain；每个样本一次逻辑调用，非期望结果如实判失败。明确拒绝优先 reject，缺失指代语境导致无法确定为 uncertain。
- [x] 以真实 reviewer 与受控上游 runJob 组合检查 reject/uncertain 不调用 choices、不发布；区分混合链测试和自然端到端游戏测试，预算包含原单元最多四次尝试。
- [x] 先运行离线定向测试、typecheck、test:boundaries、check:docs；env:check 成功后进程内启用 live 门禁，不输出密钥、不碰用户存档。
- [x] 运行全量离线测试与 build，报告真实通过/失败/未覆盖及最终提交信息，不扩大系统或反复调用直到绿灯。
