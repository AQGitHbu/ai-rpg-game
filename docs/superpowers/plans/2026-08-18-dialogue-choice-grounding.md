# 对话选项按本轮 NPC 台词锚定 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 防止 AI 复用上一轮或 deterministic fallback 的泛化选项，让两个玩家选项真正基于本轮 NPC 台词和结构化事实自然回应。

**Architecture:** 保留服务端对 candidateId、Action 和 fallback 的权威控制，但不再把 fallback 的自然语言 label 作为 AI 的候选示例。live prompt 只提供候选动作语义，AI 先完成本轮 NPC 台词后生成玩家实际对白；解析和审批继续用本轮 NPC 台词重建候选集合，并拒绝明显复用上一轮候选文案的结果，触发既有内容修复重试。所有锚定都依赖结构化 factId、dialogueAct、上一轮对白上下文，不增加关键词匹配。

**Tech Stack:** TypeScript、Vitest、Next.js server application、现有 `RpgAiClient` 和场景审批链。

## Global Constraints

- 不改变客户端 opaque choice token、Action 类型或现有两选项契约。
- 不把完整 World State、私密事实或模型原文写入日志。
- 不通过 NPC 名称、role 或对白关键词硬匹配推断剧情主题。
- fallback 只能使用服务端结构化目标/事实上下文，不能伪造未出现的地点、时间、物品或证物。
- 修改后必须通过目标测试、typecheck、lint 和完整测试套件。

---

### Task 1: 解耦 AI 候选动作与 fallback 可见文案

**Files:**
- Modify: `src/game/application/server/ai/liveScenePerformanceSource.ts`
- Modify: `src/game/application/server/ai/liveScenePerformanceSource.test.ts`

**Interfaces:**
- Consumes: `SceneChoiceCandidate` 的 `candidateId` 与 `action`。
- Produces: live prompt 中只出现 candidateId、动作类型、dialogueAct/topic 或实体目标，不出现 candidate label。

- [x] **Step 1: 更新失败回归测试**

在 prompt 测试中保留 `candidate_1`、`candidate_2` 和 NPC/事实上下文断言，但改为断言 prompt 不包含当前 deterministic 候选的自然语言 label；新增断言要求 prompt 明确说明选项必须回应“本轮刚生成的 npcLine”。

- [x] **Step 2: 运行目标测试确认旧行为失败**

运行：

```powershell
npx vitest run src/game/application/server/ai/liveScenePerformanceSource.test.ts --reporter=dot
```

预期：现有“prompt 包含目标 label”的断言失败，证明测试捕获了文案泄漏。

- [x] **Step 3: 实现候选语义描述器**

在 `liveScenePerformanceSource.ts` 增加纯函数，将 `SceneChoiceCandidate.action` 转为安全的语义描述：talk 输出 `talk/dialogueAct/topic`，move 输出目标 ID，investigate/take_item/attack 输出对应目标 ID，explore 输出 `explore`。`buildLiveScenePrompt` 改为使用该描述，不再拼接 `c.label`。

- [x] **Step 4: 强化 prompt 生成顺序约束**

在 choices 契约中明确：模型必须先完成 `npcLine`，再以该对象的文本和 `usedFactIds` 作为本轮唯一对白锚点；上一轮选择只能用于理解关系和承接，不得直接复用为当前可见选项；选项 label 必须是玩家实际对白或全角括号动作。

- [x] **Step 5: 运行目标测试确认通过**

运行同一条 Vitest 命令，预期 live scene 测试全部通过。

### Task 2: 让本轮结构化台词锚点覆盖旧的上一轮模板

**Files:**
- Modify: `src/game/application/deterministicSceneSource.ts`
- Modify: `src/game/application/server/ai/liveScenePerformanceSource.ts`
- Modify: `src/game/application/server/ai/liveScenePerformanceSource.test.ts`
- Modify: `src/game/application/approveAndWriteScene.ts`
- Modify: `src/game/application/approveAndWriteScene.test.ts`

**Interfaces:**
- Consumes: `CurrentNpcLineContext { text, usedFactIds }`、`SceneGenerationContext.previousDialogue`。
- Produces: 当前台词存在时，服务端 fallback label 和候选校验不再优先套用 `previousDialogue.selectedChoice.dialogueAct` 的泛化模板；live 返回上一轮候选 fallback label 时进入内容修复。

- [x] **Step 1: 添加当前台词优先的确定性候选测试**

构造上一轮 `support`、本轮 NPC 使用 `fact_a` 的 context，断言 `buildSelectableSceneCandidates(context, { text: "...", usedFactIds: ["fact_a"] })` 产出的 talk label 不等于 support 分支的“既然你愿意继续说……”和“我可以继续听……”，并且仍保留两个不同的 talk action。

- [x] **Step 2: 添加 live 旧模板拒绝/修复测试**

让第一次 AI JSON 返回当前 NPC 台词以及与 `buildSelectableSceneCandidates(context)` 完全相同的两个旧 fallback label，第二次返回针对当前台词的自然对白；断言 transport 调用两次、最终 `source="generated"`、最终 label 不等于旧模板，并记录 `scene_generation_content_retry`。

- [x] **Step 3: 调整确定性 label 选择顺序**

在 `dialogueChoiceLabels` 中，当 `currentNpcLine` 有 `usedFactIds` 且能解析到可说事实时，先走事实锚定分支，再考虑上一轮 dialogueAct；上一轮状态只在没有当前事实锚点时决定承接方向。该逻辑只消费 factId，不扫描文本关键词。

- [x] **Step 4: 增加服务端 stale-label 校验**

增加纯函数比较规范化后的 live label 与当前 context 候选的 fallback label；两个 talk label 若都复用了当前候选 fallback 文案，返回新的 `choices_stale_template` 解析失败原因。该拒绝只针对结构化候选文案精确复用，不对自然语言做关键词匹配。

- [x] **Step 5: 让审批保持相同保护**

在 `approveScenePerformance` 中对最终 proposal 使用本轮 `npcLine` 重建出的 candidate fallback labels 做同一项 stale-template 检查；失败返回新的 `stale_choice_template`，由 pending 编排进入既有一次内容修复，而不是静默写入 generated。

- [x] **Step 6: 运行相关测试**

运行：

```powershell
npx vitest run src/game/application/server/ai/liveScenePerformanceSource.test.ts src/game/application/approveAndWriteScene.test.ts src/game/application/deterministicSceneSource.test.ts --reporter=dot
```

预期：相关测试全部通过，旧模板被识别为待修复内容。

### Task 3: 更新文档并完成全量验证

**Files:**
- Modify: `docs/agent/运行时AI导演与场景表演.md`
- Modify: `docs/agent/NPC对话驱动叙事场景触发.md`

**Interfaces:**
- Consumes: Task 1/2 的 prompt、解析和审批行为。
- Produces: 实现事实文档，说明 fallback 文案不再作为 live prompt 示例，以及 stale-template 会触发内容修复。

- [x] **Step 1: 更新运行时 AI 文档**

补充：candidateId/action 是服务端权威；自然语言 fallback label 不能进入 live prompt；当前 NPC 台词的结构化事实引用是本轮选项锚点；精确复用候选 fallback 文案视为内容契约失败并最多修复一次。

- [x] **Step 2: 更新 NPC 对话文档**

说明上一轮 dialogueAct 只用于关系/承接，不直接决定本轮选项措辞；本轮选项必须围绕本轮 NPC 直接回应，且不使用关键词分类。

- [x] **Step 3: 运行质量门禁**

依次运行：

```powershell
npx vitest run --reporter=dot
npm run typecheck -- --pretty false
npm run lint
git diff --check
```

预期：全量测试、类型检查、lint 和 diff 检查全部通过。

- [x] **Step 4: 检查当前存档不被修改**

只确认 `db/rpg.sqlite` 未被代码测试或验证命令改写；新行为需要新一轮生成才能体现，旧 revision 3 存档不做自动重写。
