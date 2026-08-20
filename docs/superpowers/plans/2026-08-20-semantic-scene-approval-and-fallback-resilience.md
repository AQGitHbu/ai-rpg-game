# 语义场景审批与降级韧性重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将场景审批从“旁白必须包含某个精确字符串”重构为“规则结构硬校验、叙事语义软告警、局部问题局部修复”，避免正常的 AI 措辞变化触发整场 fallback，并防止一次场景失败级联污染后续线性调查/移动叙事。

**Architecture:** 服务端继续以 `objectiveLink`、候选 ID、NPC/事实引用和强制节拍 ID 作为不可绕过的结构化事实；旁白文本不再承担规则证明职责。场景 proposal 增加可选的稳定实体引用，审批器只校验这些引用是否属于服务端允许集合，缺少引用或文本没有复述目标只产生质量告警，不拒绝整场。场景核心结构确实非法时仍可 fallback，但已独立通过审批的 `linearActionNarratives` 可以随 fallback 场景保留，避免后续即时行动再次连环降级。

**Tech Stack:** TypeScript, Next.js, Vitest, SQLite CAS repository, JSONL/SQLite structured logging

## Global Constraints

- 规则负责裁决，AI 负责生成和表达；AI 不得通过自然语言修改任务、事实、关系、战斗或结局。
- 只有服务端结构化 ID、枚举、候选动作和 CAS revision 是硬契约；玩家可见旁白不得用精确自然语言字符串承担规则证明职责。
- 不新增 API route、版本化接口、并行 application 链或兼容存档迁移；继续使用现有 scene CAS 与 `/api/game/actions`。
- `source: "generated"` 只表示场景核心 proposal 通过结构化审批；质量告警或局部文本修复不得把整场伪装成 `fallback`，但真正使用确定性场景时必须保留 `source: "fallback"`。
- 预生成线性叙事只能引用 `SceneGenerationContext` 下发的权威事实/地点 ID；非法引用只能被丢弃或局部降级，不能进入存档。
- 所有新增行为必须有同目录测试；实现事实变化后同步 `docs/agent/运行时AI导演与场景表演.md`、相关索引和当前阶段 Plan 说明。

---

### Task 1: 用结构化实体引用替代旁白精确匹配

**Files:**
- Modify: `src/game/application/sceneSource.ts`
- Modify: `src/game/application/sceneGenerationContext.ts`
- Modify: `src/game/application/server/ai/liveScenePerformanceSource.ts`
- Test: `src/game/application/server/ai/liveScenePerformanceSource.test.ts`
- Test: `src/game/application/sceneGenerationContext.test.ts`

**Interfaces:**
- Produces: `ScenePerformanceSegment.referencedEntityIds?: readonly string[]`，只允许引用服务端下发的 `beatSubjects`、当前 `objectiveTarget` 和本轮合法事件实体。
- Produces: `SceneGenerationContext.narrativeReferenceIds: ReadonlySet<string>`，用于 parser/approval 共同限制 AI 可引用的稳定实体集合。
- Preserves: 现有没有 `referencedEntityIds` 的离线 fixture，缺失字段按空数组处理，不改变既有输入兼容性。

- [ ] **Step 1: 编写语义通过与非法引用测试**

在 `sceneGenerationContext.test.ts` 中覆盖：目标为 `discover_fact` 时上下文暴露事实 ID、下一地点 ID 和关联 quest ID；不暴露未释放实体。

在 `liveScenePerformanceSource.test.ts` 中添加：

```ts
it("accepts natural wording when objectiveLink is correct", async () => {
  // proposal 的 quest_advanced 文本写“车辙一路通向北巷旧道”，
  // 不出现“调查酒楼后巷的车轮印”完整标签；objectiveLink 正确时保留 generated。
});

it("does not let unknown referencedEntityIds enter the proposal", async () => {
  // unknown ID 只能被丢弃并产生解析告警，不能污染主场景或 linear queue。
});
```

- [ ] **Step 2: 运行测试确认当前契约失败**

Run: `npm test -- src/game/application/server/ai/liveScenePerformanceSource.test.ts src/game/application/sceneGenerationContext.test.ts`

Expected: 新增断言失败，当前 segment 类型与 prompt/parser 没有稳定引用字段。

- [ ] **Step 3: 扩展 proposal、上下文和 parser**

1. 在 `ScenePerformanceSegment` 增加可选 `referencedEntityIds`；只保存字符串 ID，不保存自然语言标签或可执行 action。
2. 在 `buildSceneGenerationContext` 中从 `beatSubjects`、`objectiveTarget`、当前已解决行动结果和合法目标集合建立 `narrativeReferenceIds`，不把完整 `WorldState` 传给 AI。
3. 在 `liveScenePerformanceSource.ts` 的 JSON parser 中逐段解析 `referencedEntityIds`：非字符串、重复或不在允许集合中的 ID 丢弃；该字段非法不能拒绝整场 proposal。
4. 重写场景 prompt：要求 AI 用自然语言表达幕交接；可选地在对应 segment 填稳定实体 ID；禁止要求旁白逐字复述 objective label。保留 `objectiveLink`、beatId、candidateId 等结构化字段的严格要求。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- src/game/application/server/ai/liveScenePerformanceSource.test.ts src/game/application/sceneGenerationContext.test.ts`

Expected: natural wording is accepted, unknown references are isolated, existing generated/fallback fixtures remain green。

- [ ] **Step 5: 提交独立变更**

```bash
git add src/game/application/sceneSource.ts src/game/application/sceneGenerationContext.ts src/game/application/server/ai/liveScenePerformanceSource.ts src/game/application/server/ai/liveScenePerformanceSource.test.ts src/game/application/sceneGenerationContext.test.ts
git commit -m "refactor(narrative): ground scene prose with structured entity references"
```

### Task 2: 拆分“结构硬拒绝”和“叙事质量告警”

**Files:**
- Modify: `src/game/application/approveAndWriteScene.ts`
- Modify: `src/game/application/generatePendingScene.ts`
- Modify: `src/game/application/server/ai/textAuditTypes.ts`
- Test: `src/game/application/approveAndWriteScene.test.ts`
- Test: `src/game/application/generatePendingScene.test.ts`

**Interfaces:**
- Produces: `SceneQualityWarningCode = "missing_objective_reference" | "invalid_objective_reference" | "missing_objective_surface"`。
- Produces: `ApprovedSceneWriteBack.qualityWarnings: readonly SceneQualityWarningCode[]`，只用于日志/审计，不进入客户端 view，也不改变规则状态。
- Removes: `quest_advanced_unnamed` 作为整场 rejection code；`objectiveLink` 不正确、mandatory beat 缺失、非法 choice/NPC/fact 仍是硬拒绝。

- [ ] **Step 1: 写出回归测试**

在 `approveAndWriteScene.test.ts` 中添加：

```ts
it("accepts a semantically grounded handoff without exact objective-label text", () => {
  // objectiveLink 命中 quest/objectiveIndex；旁白只说“车辙通向北巷旧道”。
  // 断言 ok=true、scene.source=generated、qualityWarnings 为空或仅为软告警。
});

it("rejects a stale objectiveLink even when prose mentions the right place", () => {
  // prose 再正确也不能绕过错误的 questId/objectiveIndex。
  // 断言仍返回 stale_objective_link。
});

it("reports missing grounding without falling back the whole scene", () => {
  // objectiveLink 正确、mandatory beat 完整，但 AI 没有 referencedEntityIds。
  // 断言场景成功写回并携带 quality warning，而不是 scene_generation_rejected。
});
```

- [ ] **Step 2: 运行测试确认旧实现失败**

Run: `npm test -- src/game/application/approveAndWriteScene.test.ts src/game/application/generatePendingScene.test.ts`

Expected: 旧实现会对没有完整字符串的幕推进场景返回 `quest_advanced_unnamed`。

- [ ] **Step 3: 重构审批边界**

1. 从 `SceneRejectionCode` 移除 `quest_advanced_unnamed`，新增 `SceneQualityWarningCode`。
2. 保留以下硬校验：mandatory beat 完整且有序、NPC/事实/交互引用合法、`player_utterance` 已应答、`objectiveLink` 精确命中 `ObjectiveTransition.after`、两个 choice 合法且语义不同、至少一个 choice 可推进目标。
3. 对 `advanced_act`：不检查 `segment.text.includes(objectiveTarget.entityName)`；改为检查 `referencedEntityIds` 是否包含允许的 objective entity。缺失时追加 `missing_objective_reference`，未知时过滤并追加 `invalid_objective_reference`。不做自然语言 substring、正则关键词或 NPC 名称推断。
4. 若 objectiveLink 存在但整个场景没有任何可读交接段，追加 `missing_objective_surface`；仍不直接 fallback，因为 HUD/read model 已有权威目标，场景可以继续展示。
5. `generatePendingScene.ts` 只在 `approveScenePerformance` 返回硬失败时进入一次内容修复和最终 fallback；质量 warning 直接保存 generated scene，并将 warning 写入普通日志和 `story_text` 审计事件。
6. 在 `textAuditTypes.ts` 为 `story_text` 增加可选 `qualityWarnings`，确保后续可以统计“生成成功但表达不完整”，而不是把它与 AI/API 失败混为一谈。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- src/game/application/approveAndWriteScene.test.ts src/game/application/generatePendingScene.test.ts`

Expected: 自然措辞不会 fallback；错误 objectiveLink 仍被拒；质量问题只产生 warning。

- [ ] **Step 5: 提交独立变更**

```bash
git add src/game/application/approveAndWriteScene.ts src/game/application/generatePendingScene.ts src/game/application/server/ai/textAuditTypes.ts src/game/application/approveAndWriteScene.test.ts src/game/application/generatePendingScene.test.ts
git commit -m "refactor(narrative): separate structural approval from prose quality warnings"
```

### Task 3: 让线性叙事队列与场景核心审批解耦

**Files:**
- Modify: `src/game/application/approveAndWriteScene.ts`
- Modify: `src/game/application/generatePendingScene.ts`
- Modify: `src/game/domain/narrative.ts`（仅在持久化类型需要显式 warning/source 字段时修改）
- Test: `src/game/application/generatePendingScene.test.ts`
- Test: `src/game/application/testing/investigationFlowJourney.test.ts`

**Interfaces:**
- Produces: `approveLinearActionNarratives(...)` 可独立返回经过引用/元话术/非空校验的 queue 条目。
- Produces: 场景核心 generated proposal 被硬拒时，若其 linear narratives 独立通过审批，则 fallback 场景仍可写回这些 `source: "generated"` 条目。
- Preserves: queue 消费仍由 `actionKind + factId/locationId` 精确结构化匹配；不使用自然语言匹配。

- [ ] **Step 1: 编写级联 fallback 回归测试**

在 `generatePendingScene.test.ts` 中添加：

```ts
it("keeps independently approved linear narratives when the scene core falls back", async () => {
  // AI scene 故意让 choices 非法，但 linearActionNarratives 的 fact/location 引用合法。
  // 断言当前 scene.source=fallback；queue 仍包含 generated investigate/move 条目。
  // 后续 investigate/move 立即消费 queue，不再记录 linear_narrative_fallback。
});
```

在 `investigationFlowJourney.test.ts` 中添加同一真实流程：幕推进场景正文措辞变化 → 场景可能 fallback → 调查和移动仍消费已审批的 AI 线性叙事。

- [ ] **Step 2: 运行测试确认旧实现暴露级联问题**

Run: `npm test -- src/game/application/generatePendingScene.test.ts src/game/application/testing/investigationFlowJourney.test.ts`

Expected: 旧实现因 core rejection 返回空 `linearNarrativeQueue`，后续行动记录 `linear_narrative_fallback`。

- [ ] **Step 3: 实现独立 queue 审批与写回**

1. 将 `approveLinearActionNarratives` 的纯校验结果从场景 core approval 中分离出来；保留现有引用命中 `upcomingLinearObjectives`、正文非空和无系统元话术规则。
2. `generatePendingScene` 在第一次 generated proposal 到达后先计算 `approvedLinearNarratives`；若 scene core approval 失败且 content repair 也失败，使用 fallback scene 时仍把这批独立通过的条目带入 write-back。
3. 若修复 proposal 的 queue 条目通过审批，使用修复 proposal 的条目覆盖第一次 proposal 的同键条目；同一个 `actionKind + entityId` 只保留一条，避免重复消费歧义。
4. 不允许 fallback proposal 自己携带或伪造 generated queue；只有来自真实 generated AI proposal 且通过结构化引用校验的条目可以保留。
5. 继续记录 `scene_generation_fallback` 与 `linear_narrative_fallback` 的不同事件：前者表示当前场景 fallback，后者只表示未来某个即时行动没有可消费的 generated queue。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- src/game/application/generatePendingScene.test.ts src/game/application/testing/investigationFlowJourney.test.ts`

Expected: 场景 core fallback 不再自动清空后续已批准线性叙事；调查/移动消费 generated queue 时不记录 `linear_narrative_fallback`。

- [ ] **Step 5: 提交独立变更**

```bash
git add src/game/application/approveAndWriteScene.ts src/game/application/generatePendingScene.ts src/game/domain/narrative.ts src/game/application/generatePendingScene.test.ts src/game/application/testing/investigationFlowJourney.test.ts
git commit -m "fix(narrative): isolate linear action queue from scene core fallback"
```

### Task 4: 更新日志、运行时文档与回归门禁

**Files:**
- Modify: `docs/agent/运行时AI导演与场景表演.md`
- Modify: `docs/Agent文档索引.md`
- Modify: `docs/agent/当前开发阶段.md`（只记录 canonical 行为变化）
- Test: `src/game/application/server/ai/liveScenePerformanceSource.test.ts`
- Test: `src/game/application/testing/foundationJourney.test.ts`
- Test: `src/game/application/testing/storyDivergenceJourney.test.ts`

**Interfaces:**
- Produces: 可审计的 rejection/quality-warning/fallback 三类稳定事件，日志不会把“表达质量不足”误报为“AI 调用失败”。
- Produces: 旅程门禁证明同一 seed 下，使用自然措辞的 AI 场景仍能完成至少调查、移动和后续 NPC 对话。

- [ ] **Step 1: 增加真实问题回放 fixture**

使用本次存档中的语义文本作为 fixture：

```ts
const handoffText = "他指向后巷留下的车辙，痕迹一路通向北巷旧道。";
```

fixture 必须不包含“调查酒楼后巷的车轮印”完整字符串，但携带正确 `objectiveLink` 和可选 `referencedEntityIds`。

- [ ] **Step 2: 增加日志分类断言**

断言：

- 该 fixture 不产生 `scene_generation_rejected`；
- 若缺少结构化引用，只产生 `scene_quality_warning`；
- 只有非法 objectiveLink、非法 choice 或缺 mandatory beat 才产生 `scene_generation_rejected`；
- 后续 queue 命中时不产生 `linear_narrative_fallback`。

- [ ] **Step 3: 更新 agent 文档和索引**

在运行时 AI 文档中明确：自然语言目标名是展示内容，不是审批键；`objectiveLink` 与稳定实体引用是硬约束，旁白缺少某个标签只产生质量告警。同步当前阶段文档中的 fallback 触发条件和测试入口，并在索引记录 canonical 文件。

- [ ] **Step 4: 运行变更感知与完整门禁**

Run:

```text
npm run test:game-application
npm run test:components
npm run test:app
npm run test:fast
npm test
npm run typecheck
npm run test:foundation-journey
```

Expected: 现有离线 fallback 可玩性、AI 失败可恢复性、NPC 双选项、自定义输入、CAS/reload 和结局分叉测试全部通过。

- [ ] **Step 5: 提交文档和门禁变更**

```bash
git add docs/agent/运行时AI导演与场景表演.md docs/Agent文档索引.md docs/agent/当前开发阶段.md src/game/application/server/ai/liveScenePerformanceSource.test.ts src/game/application/testing/foundationJourney.test.ts src/game/application/testing/storyDivergenceJourney.test.ts
git commit -m "docs(test): document semantic scene approval and fallback resilience"
```

## 验收标准

1. AI 输出“车辙通向北巷旧道”而没有逐字复述 UI 目标标签时，场景保持 `source: "generated"`，不触发整场 fallback。
2. 错误 `objectiveLink`、非法 NPC/fact/action 引用、缺 mandatory beat 仍然硬拒绝，规则安全边界不放松。
3. 质量问题只产生结构化 warning，可从普通日志和 AI 文本审计中区分；不把质量告警伪装成 API 失败。
4. 即使 scene core 因真正结构错误 fallback，独立通过审批的 investigate/move 预生成叙事仍能写入 queue 并被后续即时行动消费。
5. 全部自然语言匹配只保留在质量诊断/展示层；规则审批不再使用 `includes(objectiveTarget.entityName)`、NPC 名称关键词或固定剧情文案正则来决定是否 fallback。

## Non-goals

- 不引入第二次 live LLM 作为审批裁判；审批仍是确定性的结构化逻辑。
- 不允许 AI 通过实体引用决定任务完成、地点移动、事实发现或关系变化；这些仍由规则回合裁决。
- 不改变当前短篇/中篇范围、single CAS write-back、opaque choice token、NPC 双选择和自定义输入契约。
