# Narrative Context Compiler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不迁移存档、不增加 AI 调用、不改变行动/战斗/结局规则的前提下，建立可测试的叙事上下文编译器，并让 scene/world Prompt 完整、稳定、按权威和预算组织当前已有信息。

**Architecture:** 新增纯 application 层 `narrativeContext` 模块，将安全投影转换为带 slot、authority、priority、retention、source 的上下文块；纯编译器负责冲突消解和预算，纯 renderer 负责稳定文本。`liveScenePerformanceSource` 与 `liveWorldEvolutionSource` 只负责调用对应 projection、将编译结果交给现有 AI client，并把不含正文的 manifest 写入审计上下文。现有 parser、approval、规则结算、一次生成/逐步消费和战斗失败回滚保持不变。

**Tech Stack:** TypeScript 5.8、Vitest 3、Next.js 16、现有 `@ai-game/ai-transport` 与 RPG AI client；不新增 npm 依赖或外部服务。

**Spec:** `docs/superpowers/specs/2026-08-23-long-form-narrative-entity-memory-architecture.md`（NAR-01、NAR-02、NAR-03、NAR-17）

## Global Constraints

- 实施前先完整读取 `docs/游戏开发规范.md`、`docs/Agent文档索引.md`、`docs/agent/剧情连续性与结构化记忆.md`、`docs/agent/运行时AI导演与场景表演.md`、`docs/agent/世界动态具象化.md`、`docs/agent/AI文本审计.md`、`docs/agent/当前开发阶段.md` 及其指向的唯一 Plan。
- 实施时先运行 `git status --short --branch`；如果存在与本 Plan 文件重叠的未提交用户改动，不得覆盖、stash 或丢弃，必须先让用户确认它们已合入可作为分支基线的 `main`。实现分支必须放在 `.worktrees/`，不用 `git checkout`。
- 不读取或修改共享 foundation 流程文件；本 Plan 不创建通用 package，也不改变 `@ai-game/*`。
- 不修改 `WorldState.version`、`StoryState.version` 或持久化 schema，不做数据迁移。
- 不新增模型调用，不改变 role 的 timeout/maxTokens/retry/json mode。
- 不改变 action resolution、mandatory beats、scene approval、world delta approval、战斗和结局语义。
- 战斗失败继续恢复战前快照；不得把失败尝试写入长期剧情事实。
- 不把完整 `WorldState`、`StoryState`、`eventLedger`、其他 NPC 私密记忆或 API 凭据放入 Prompt 或 manifest。
- `buildLiveScenePrompt` 保持导出兼容；现有调用方与测试无需改名。
- 每个任务结束先运行列出的 targeted tests，再提交；最后统一运行全量质量门禁和完整离线 journey。

---

## Target File Structure

```text
src/game/application/narrativeContext/
├── contextBlock.ts                 # IR、slot/authority 顺序、预算与 manifest 类型
├── estimateNarrativeTokens.ts      # 确定性的保守 token 估算
├── compileNarrativeContext.ts      # 去空、去重、冲突消解、预算选择
├── compileNarrativeContext.test.ts
├── renderNarrativeContext.ts       # 稳定标题/块顺序渲染
├── renderNarrativeContext.test.ts
├── sceneNarrativeContext.ts        # SceneGenerationContext → blocks → compilation
├── sceneNarrativeContext.test.ts
├── worldNarrativeContext.ts        # WorldEvolutionSourceContext → blocks → compilation
├── worldNarrativeContext.test.ts
└── index.ts                         # application 公共导出面
```

现有文件变更：

- `src/game/application/sceneGenerationContext.ts`：显式投影当前 `StoryContract`。
- `src/game/application/sceneGenerationContext.test.ts`：验证契约投影和最小权限。
- `src/game/application/server/ai/liveScenePerformanceSource.ts`：使用 scene compilation，保留 parser/approval 契约。
- `src/game/application/server/ai/liveScenePerformanceSource.test.ts`：Prompt 语义回归和 manifest 透传。
- `src/game/application/server/ai/liveWorldEvolutionSource.ts`：使用 world compilation，补齐输出 schema。
- `src/game/application/server/ai/worldEvolutionSource.test.ts`：World Prompt、最小权限和 manifest 回归。
- `src/game/application/server/ai/textAuditTypes.ts`：增加纯元数据 manifest 字段。
- `src/game/application/server/ai/textAuditTypes.test.ts`：如果该文件已存在则扩展；否则由两个 live source 测试验证结构，不单独新建测试。
- 所有直接构造 `SceneGenerationContext` 的 fixture：补上新增的 `story.contract`；以 `rg -l "SceneGenerationContext" src --glob '*.test.ts' --glob '*.testutil.ts'` 的结果为完整清单，至少包括当前八个文件。
- `docs/agent/剧情连续性与结构化记忆.md`
- `docs/agent/运行时AI导演与场景表演.md`
- `docs/agent/世界动态具象化.md`
- `docs/agent/AI文本审计.md`
- `docs/Agent文档索引.md`

---

### Task 1: 建立上下文块 IR、token 估算与确定性编译器

**Consumes:** 调用方提供的 `NarrativeContextBlock[]` 与 `maxEstimatedTokens`。  
**Produces:** `CompiledNarrativeContext`，包含 selected blocks、dropped blocks、预算统计和无正文 manifest。  
**Independent proof:** 纯函数测试，不需要 Scene/World fixture、数据库或 AI。

**Files:**

- Create: `src/game/application/narrativeContext/contextBlock.ts`
- Create: `src/game/application/narrativeContext/estimateNarrativeTokens.ts`
- Create: `src/game/application/narrativeContext/compileNarrativeContext.ts`
- Create: `src/game/application/narrativeContext/compileNarrativeContext.test.ts`
- Create: `src/game/application/narrativeContext/index.ts`

- [ ] **Step 1: 写失败测试，固定权威、预算和确定性语义**

在 `compileNarrativeContext.test.ts` 写出以下五个测试：

```ts
it("同一 conflictKey 由较高 authority 胜出，当前 state 覆盖旧 memory", () => {
  const result = compileNarrativeContext({
    maxEstimatedTokens: 200,
    blocks: [
      block({ id: "old-location", authority: "memory", conflictKey: "npc:1:location", content: "旧地点" }),
      block({ id: "current-location", authority: "state", conflictKey: "npc:1:location", content: "当前地点" }),
    ],
  });
  expect(result.selected.map((entry) => entry.id)).toEqual(["current-location"]);
  expect(result.dropped).toContainEqual(expect.objectContaining({ id: "old-location", reason: "conflict" }));
});

it("mandatory 超出预算仍保留并报告 overflow", () => {
  const result = compileNarrativeContext({
    maxEstimatedTokens: 1,
    blocks: [block({ id: "rules", retention: "mandatory", authority: "rule", content: "不可改写已结算结果" })],
  });
  expect(result.selected.map((entry) => entry.id)).toEqual(["rules"]);
  expect(result.overflowEstimatedTokens).toBeGreaterThan(0);
});

it("optional 预算不足时保留高优先级并给低优先级 budget 原因", () => {
  const high = block({ id: "high", priority: 100, content: "甲".repeat(20) });
  const low = block({ id: "low", priority: 10, content: "乙".repeat(20) });
  const result = compileNarrativeContext({ maxEstimatedTokens: 20, blocks: [low, high] });
  expect(result.selected.map((entry) => entry.id)).toEqual(["high"]);
  expect(result.dropped).toContainEqual(expect.objectContaining({ id: "low", reason: "budget" }));
});

it("输入倒序不会改变 selected 的渲染顺序和 manifest", () => {
  const blocks = [
    block({ id: "state", slot: "current_state", authority: "state", priority: 50 }),
    block({ id: "rules", slot: "system_rules", authority: "rule", retention: "mandatory", priority: 100 }),
  ];
  expect(compileNarrativeContext({ maxEstimatedTokens: 200, blocks }))
    .toEqual(compileNarrativeContext({ maxEstimatedTokens: 200, blocks: [...blocks].reverse() }));
});

it("manifest 只有元数据，不出现 block content", () => {
  const result = compileNarrativeContext({
    maxEstimatedTokens: 200,
    blocks: [block({ id: "secret", content: "私密正文" })],
  });
  expect(JSON.stringify(result.manifest)).not.toContain("私密正文");
});
```

`block()` 是测试内的完整默认工厂，不使用 `as any`。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- src/game/application/narrativeContext/compileNarrativeContext.test.ts`  
Expected: FAIL，模块尚不存在。

- [ ] **Step 3: 实现精确类型**

`contextBlock.ts` 定义并导出：

```ts
export type NarrativeContextAuthority = "rule" | "state" | "event" | "plan" | "memory" | "lore";
export type NarrativeContextRetention = "mandatory" | "optional";
export type NarrativeContextSlot =
  | "system_rules" | "world_canon" | "story_contract" | "current_state"
  | "current_resolution" | "current_location" | "focus_character"
  | "relationships" | "relevant_events" | "recent_scenes"
  | "director_guidance" | "player_action" | "legal_actions" | "output_contract";

export type NarrativeContextBlock = Readonly<{
  id: string;
  slot: NarrativeContextSlot;
  title: string;
  content: string;
  authority: NarrativeContextAuthority;
  retention: NarrativeContextRetention;
  priority: number;
  conflictKey?: string;
  source: Readonly<{ kind: string; refs: readonly string[] }>;
}>;

export type NarrativeContextDropReason = "empty" | "duplicate" | "conflict" | "budget";

export type CompiledNarrativeContextBlock = NarrativeContextBlock & Readonly<{
  estimatedTokens: number;
}>;

export type DroppedNarrativeContextBlock = Readonly<{
  id: string;
  slot: NarrativeContextSlot;
  sourceKind: string;
  sourceRefs: readonly string[];
  estimatedTokens: number;
  reason: NarrativeContextDropReason;
}>;

export type NarrativeContextManifest = Readonly<{
  compilerVersion: 1;
  maxEstimatedTokens: number;
  selectedEstimatedTokens: number;
  overflowEstimatedTokens: number;
  selected: readonly Omit<DroppedNarrativeContextBlock, "reason">[];
  dropped: readonly DroppedNarrativeContextBlock[];
}>;

export type CompiledNarrativeContext = Readonly<{
  selected: readonly CompiledNarrativeContextBlock[];
  dropped: readonly DroppedNarrativeContextBlock[];
  selectedEstimatedTokens: number;
  overflowEstimatedTokens: number;
  manifest: NarrativeContextManifest;
}>;
```

同时导出固定顺序常量：

```ts
export const NARRATIVE_CONTEXT_COMPILER_VERSION = 1 as const;
export const NARRATIVE_CONTEXT_AUTHORITY_ORDER: readonly NarrativeContextAuthority[] = [
  "rule", "state", "event", "plan", "memory", "lore",
];
export const NARRATIVE_CONTEXT_SLOT_ORDER: readonly NarrativeContextSlot[] = [
  "system_rules", "world_canon", "story_contract", "current_state",
  "current_resolution", "current_location", "focus_character", "relationships",
  "relevant_events", "recent_scenes", "director_guidance", "player_action",
  "legal_actions", "output_contract",
];
```

manifest 的 selected/dropped 项只含 `id`、`slot`、`sourceKind`、`sourceRefs`、`estimatedTokens`；dropped 额外含 `reason`。绝不含 `title` 或 `content`。

- [ ] **Step 4: 实现保守 token 估算**

`estimateNarrativeTokens.ts` 必须确定性、零依赖：按 Unicode code point 遍历；ASCII 字符累计 `0.25`，非 ASCII 累计 `1`，最后 `Math.max(1, Math.ceil(total))`。空白正文由编译器在估算前丢弃，不调用估算器。

- [ ] **Step 5: 实现编译算法**

`compileNarrativeContext()` 严格按以下顺序处理：

1. `content.trim()` 为空的块以 `empty` 丢弃。
2. 相同 `id` 保留按 authority rank、priority、slot rank、ID 排序后的第一项，其余为 `duplicate`。
3. 相同 `conflictKey` 保留 authority 较高者；同 authority 取 priority 较高者；仍相同取 ID 字典序较小者，其余为 `conflict`。
4. 所有 mandatory 入选，不受预算裁剪。
5. optional 按 priority 降序、authority 降序、slot 顺序、ID 字典序逐个尝试；放不下的标为 `budget`。
6. selected 最终按 slot 顺序、priority 降序、ID 字典序排列。
7. `overflowEstimatedTokens = Math.max(0, selectedEstimatedTokens - maxEstimatedTokens)`。

对非法预算（非有限数或小于 1）抛 `RangeError`；不静默改写调用方错误。

- [ ] **Step 6: 运行测试并做类型检查**

Run: `npm test -- src/game/application/narrativeContext/compileNarrativeContext.test.ts`  
Expected: PASS，5 tests。  
Run: `npm run typecheck`  
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add src/game/application/narrativeContext/contextBlock.ts src/game/application/narrativeContext/estimateNarrativeTokens.ts src/game/application/narrativeContext/compileNarrativeContext.ts src/game/application/narrativeContext/compileNarrativeContext.test.ts src/game/application/narrativeContext/index.ts
git commit -m "feat(narrative): add deterministic context compiler"
```

---

### Task 2: 建立稳定 renderer 与 Prompt compilation 契约

**Consumes:** `CompiledNarrativeContext`。  
**Produces:** `NarrativePromptCompilation { prompt, context, manifest }`；同一输入得到逐字相同 Prompt。  
**Independent proof:** renderer 纯函数测试。

**Files:**

- Create: `src/game/application/narrativeContext/renderNarrativeContext.ts`
- Create: `src/game/application/narrativeContext/renderNarrativeContext.test.ts`
- Modify: `src/game/application/narrativeContext/contextBlock.ts`
- Modify: `src/game/application/narrativeContext/index.ts`

- [ ] **Step 1: 写失败测试**

覆盖：

```ts
it("无论输入顺序如何都按 slot 顺序渲染，output_contract 最后", () => {
  const compiled = compileNarrativeContext({
    maxEstimatedTokens: 200,
    blocks: [
      block({ id: "output", slot: "output_contract", title: "输出契约", content: "只输出 JSON" }),
      block({ id: "rules", slot: "system_rules", title: "规则", content: "不可改写规则结果" }),
    ],
  });
  const prompt = renderNarrativeContext(compiled);
  expect(prompt.indexOf("## [system_rules] 规则")).toBeLessThan(prompt.indexOf("## [output_contract] 输出契约"));
});

it("只渲染 selected，不渲染 dropped 正文", () => {
  const compiled = compileNarrativeContext({
    maxEstimatedTokens: 20,
    blocks: [
      block({ id: "current", slot: "current_location", priority: 100, content: "当前地点" }),
      block({ id: "old", slot: "recent_scenes", priority: 1, content: "已丢弃的旧地点".repeat(20) }),
    ],
  });
  const prompt = renderNarrativeContext(compiled);
  expect(prompt).toContain("当前地点");
  expect(prompt).not.toContain("已丢弃的旧地点");
});

it("标题与正文使用固定格式且末尾只有一个换行", () => {
  const compiled = compileNarrativeContext({
    maxEstimatedTokens: 200,
    blocks: [block({ id: "rules", slot: "system_rules", title: "规则", content: "不可改写规则结果" })],
  });
  const prompt = renderNarrativeContext(compiled);
  expect(prompt).toBe("[NARRATIVE_CONTEXT v1]\n\n## [system_rules] 规则\n不可改写规则结果\n");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- src/game/application/narrativeContext/renderNarrativeContext.test.ts`  
Expected: FAIL，renderer 尚不存在。

- [ ] **Step 3: 最小实现 renderer**

renderer 不二次排序、不解释业务语义，只按已编译 selected 顺序输出：固定版本头、空行、`## [slot] title`、正文。正文只做首尾 trim，不做压缩或改写。

在 `contextBlock.ts` 增加：

```ts
export type NarrativePromptCompilation = Readonly<{
  prompt: string;
  context: CompiledNarrativeContext;
  manifest: NarrativeContextManifest;
}>;
```

- [ ] **Step 4: 运行测试**

Run: `npm test -- src/game/application/narrativeContext/renderNarrativeContext.test.ts src/game/application/narrativeContext/compileNarrativeContext.test.ts`  
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/game/application/narrativeContext/contextBlock.ts src/game/application/narrativeContext/renderNarrativeContext.ts src/game/application/narrativeContext/renderNarrativeContext.test.ts src/game/application/narrativeContext/index.ts
git commit -m "feat(narrative): render compiled context blocks"
```

---

### Task 3: 把 Story Contract 投影进 SceneGenerationContext

**Consumes:** `GameRecord.storyState.contract`。  
**Produces:** scene 安全 DTO 中必需的 `story.contract`；不暴露未来实体或完整 StoryState。  
**Independent proof:** `sceneGenerationContext.test.ts` 精确验证字段和隐私边界。

**Files:**

- Modify: `src/game/application/sceneGenerationContext.ts`
- Modify: `src/game/application/sceneGenerationContext.test.ts`
- Modify fixtures returned by:
  `rg -l "SceneGenerationContext" src --glob '*.test.ts' --glob '*.testutil.ts'`

- [ ] **Step 1: 写失败测试**

在 `sceneGenerationContext.test.ts` 构造带非空契约的 record，并断言：

```ts
expect(context.story.contract).toEqual({
  centralConflict: "镖银失踪牵出门派内应",
  endingDirections: [
    { key: "trust", theme: "与旧友共同揭露真相" },
    { key: "doubt", theme: "独自追查并承担代价" },
  ],
});
expect(JSON.stringify(context.story.contract)).not.toMatch(/futureEntity|eventLedger|hiddenFactIds/);
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- src/game/application/sceneGenerationContext.test.ts`  
Expected: FAIL，`story.contract` 尚未投影。

- [ ] **Step 3: 增加必需的最小契约类型与投影**

在 `SceneGenerationContext["story"]` 中增加只读必需字段：

```ts
readonly contract: Pick<StoryContract, "centralConflict" | "endingDirections">;
```

`buildSceneGenerationContext()` 逐字段复制 `ss.contract`，不传递整个 `StoryState` 对象。

- [ ] **Step 4: 更新所有手工 fixture**

当前直接构造完整 DTO 的测试文件是 `src/game/application/deterministicSceneSource.test.ts`、`src/game/application/approveAndWriteScene.test.ts` 和 `src/game/application/server/ai/liveScenePerformanceSource.test.ts`。它们的共享/局部 fixture 使用明确值，不使用 `as any`：

```ts
contract: {
  centralConflict: "商队失踪案背后的内应",
  endingDirections: [
    { key: "trust", theme: "共同揭露" },
    { key: "doubt", theme: "独自追查" },
  ],
},
```

先运行 `rg -n "SceneGenerationContext\\s*=|satisfies SceneGenerationContext" src --glob '*.ts'` 复核直接构造点，再由 `npm run typecheck` 证明无遗漏。如果实施基线新增了直接构造文件，只补该文件的契约 fixture，不改变其测试语义。

- [ ] **Step 5: 运行测试和类型检查**

Run: `npm test -- src/game/application/sceneGenerationContext.test.ts`  
Expected: PASS。  
Run: `npm run typecheck`  
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/game/application/sceneGenerationContext.ts src/game/application/sceneGenerationContext.test.ts src/game/application/deterministicSceneSource.test.ts src/game/application/approveAndWriteScene.test.ts src/game/application/server/ai/liveScenePerformanceSource.test.ts
git commit -m "feat(narrative): expose story contract to scene context"
```

提交前用 `git diff --cached --name-only` 检查：不得意外加入用户原有未提交文件或无关领域改动。

---

### Task 4: 构建 Scene 上下文块并迁移 live scene Prompt

**Consumes:** `SceneGenerationContext`、`SceneChoiceCandidate[]`。  
**Produces:** `compileSceneNarrativeContext()` 的 Prompt + manifest；现有 scene JSON schema 和审批语义不变。  
**Independent proof:** block projection 测试 + 现有 live scene parser/prompt 回归。

**Files:**

- Create: `src/game/application/narrativeContext/sceneNarrativeContext.ts`
- Create: `src/game/application/narrativeContext/sceneNarrativeContext.test.ts`
- Modify: `src/game/application/narrativeContext/index.ts`
- Modify: `src/game/application/server/ai/liveScenePerformanceSource.ts`
- Modify: `src/game/application/server/ai/liveScenePerformanceSource.test.ts`

- [ ] **Step 1: 写 scene block 失败测试**

使用与 `liveScenePerformanceSource.test.ts` 相同语义的最小 fixture，断言编译结果包含以下块且来源正确：

- `scene:rules` / `system_rules` / mandatory / rule；
- `scene:world-canon`，包含 game type、world premise、story opening；
- `scene:story-contract`，包含 central conflict 和两个 ending direction，但不重复 `StoryContract.targetActs`；实际幕数只取权威性更高的 `story.currentAct/targetActs`，避免当前 `long` 兼容档的 8 幕运行状态与 3/5 幕旧契约冲突；
- `scene:current-state`，包含 `currentAct/targetActs/tension/nextPacingNeed/remainingBudget/activeQuest/unresolvedThreads`；
- `scene:resolution`，包含 mandatory beats、objective transition、resolved investigation；
- `scene:location`；
- `scene:focus-npc`，包含人格公开档案、回应政策、目标、情绪、thisTurn、可说事实，并包含最近 **5** 条结构化交互的 `actionId/dialogueAct/topicSummary/outcome/summary`；
- `scene:recent-events`，包含现有 `recentBeats`；
- `scene:previous-dialogue`；
- `scene:player-action` / mandatory；
- `scene:legal-actions` / mandatory；
- `scene:output-contract` / mandatory / rule，包含现有 segments、npcLine、npcDialogues、objectiveLink、choices、linearActionNarratives 和全部 ID 复核规则。

隐私断言：Prompt 不含 `eventLedger`、其他 NPC hidden fact 正文、relationship 裸数值、generation seed。

- [ ] **Step 2: 运行新测试确认失败**

Run: `npm test -- src/game/application/narrativeContext/sceneNarrativeContext.test.ts`  
Expected: FAIL，模块尚不存在。

- [ ] **Step 3: 实现 scene projection**

导出：

```ts
export const SCENE_CONTEXT_MAX_ESTIMATED_TOKENS = 8_000;
export function buildSceneNarrativeContextBlocks(
  context: SceneGenerationContext,
  selectable: readonly SceneChoiceCandidate[],
): readonly NarrativeContextBlock[];
export function compileSceneNarrativeContext(
  context: SceneGenerationContext,
  selectable: readonly SceneChoiceCandidate[],
): NarrativePromptCompilation;
```

实现要求：

- 先把现有 `buildLiveScenePrompt` 的每条硬约束原样迁入对应 block，再补充缺失字段；不要在同一任务中改写文风规则。
- 现有 `allowedFactIds`、`allowedInteractionIds`、mandatory beat、atmosphere、objective handoff、investigation、non-focus dialogue、linear prefetch、genre guard、repair instruction 全部保留。
- `recentInteractions` 使用现有最多五条，不再 `.slice(-2)`。
- `recentBeats` 按 turn/kind/summary 渲染；空数组输出“无”，不省略整个当前状态块。
- `unresolvedThreadSummaries` 作为现有字符串引用显示，不假装它们已经是完整 Thread 实体。
- scene block builder 只读取 `SceneGenerationContext`，不接收 `GameRecord` 或 `WorldState`。

- [ ] **Step 4: 迁移 live scene source，保留兼容函数**

在 `liveScenePerformanceSource.ts` 导出：

```ts
export function compileLiveScenePrompt(
  context: SceneGenerationContext,
  selectable: readonly SceneChoiceCandidate[],
): NarrativePromptCompilation;

export function buildLiveScenePrompt(
  context: SceneGenerationContext,
  selectable: readonly SceneChoiceCandidate[],
): string {
  return compileLiveScenePrompt(context, selectable).prompt;
}
```

生产调用点只编译一次：把 `compilation.prompt` 发送给 `aiClient.complete()`，保留现有 user message、重试、解析和 typed failure 行为。

- [ ] **Step 5: 把原 prompt 回归断言迁移到块标题后的正文**

现有测试中依赖 `候选动作=...` 单行正则的断言，改为定位 `## [legal_actions] 合法候选动作` 块；其余关键语义断言必须继续通过。新增断言：central conflict、act/tension/pacing、recent beats、五条 focus interactions 都出现在 Prompt 中。

- [ ] **Step 6: 运行 targeted tests**

Run:

```bash
npm test -- src/game/application/narrativeContext/sceneNarrativeContext.test.ts src/game/application/server/ai/liveScenePerformanceSource.test.ts src/game/application/sceneGenerationContext.test.ts
```

Expected: PASS；现有 parser、ID 过滤、对白、调查、移动预生成和内容修复测试无回归。

- [ ] **Step 7: 提交**

```bash
git add src/game/application/narrativeContext/sceneNarrativeContext.ts src/game/application/narrativeContext/sceneNarrativeContext.test.ts src/game/application/narrativeContext/index.ts src/game/application/server/ai/liveScenePerformanceSource.ts src/game/application/server/ai/liveScenePerformanceSource.test.ts
git commit -m "refactor(narrative): compile live scene context"
```

---

### Task 5: 构建 World 上下文块并补齐完整 WorldDelta 输出契约

**Consumes:** `WorldEvolutionSourceContext`。  
**Produces:** need-aware world Prompt + manifest；仍只返回现有 `WorldDeltaProposal`。  
**Independent proof:** 对每种 EvolutionNeed 验证允许/禁止字段和信息最小化。

**Files:**

- Create: `src/game/application/narrativeContext/worldNarrativeContext.ts`
- Create: `src/game/application/narrativeContext/worldNarrativeContext.test.ts`
- Modify: `src/game/application/narrativeContext/index.ts`

- [ ] **Step 1: 写失败测试，覆盖当前 parser 已支持的全部分支**

测试至少包含：

```ts
it("next_act Prompt 包含 story contract、节奏、近期事件、活动任务和已存在实体摘要", () => {});
it("next_act 输出契约声明 newLocation/newNpc/newItem/newEnemy/newFact/nextMainQuest 并禁止 endingPair", () => {});
it("ending_pair 要求恰好 trust/doubt，禁止 nextMainQuest", () => {});
it("pacing 只允许一个必要实体或事实并禁止任务和结局", () => {});
it("事实 schema 包含 investigationLabel 与 2-3 条 investigationApproaches 的合法字段", () => {});
it("Prompt 不含 eventLedger、NPC 私密事实正文、交互历史或裸关系值", () => {});
it("现有地点与 NPC 摘要使用稳定 ID，避免重名和 locationRef 冲突", () => {});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- src/game/application/narrativeContext/worldNarrativeContext.test.ts`  
Expected: FAIL，模块尚不存在。

- [ ] **Step 3: 实现 world projection**

导出：

```ts
export const WORLD_CONTEXT_MAX_ESTIMATED_TOKENS = 8_000;
export function buildWorldNarrativeContextBlocks(
  context: WorldEvolutionSourceContext,
): readonly NarrativeContextBlock[];
export function compileWorldNarrativeContext(
  context: WorldEvolutionSourceContext,
): NarrativePromptCompilation;
```

块内容和最小权限边界：

- `world:rules`：题材、不得改写当前事实、不得引用未知 ID。
- `world:canon`：game type、world premise、story opening。
- `world:story-contract`：centralConflict、endingDirections；不渲染旧 `StoryContract.targetActs`，实际幕数只取 `StoryState.targetActs`。
- `world:current-state`：act/targetActs/progress/tension/pacing/budget、活动主线摘要、unresolved thread 引用。
- `world:current-location`：ID/name/scale/placement 规则。
- `world:existing-entities`：地点 ID/name/scale、NPC ID/name/role/location/goals、物品 ID/name/所在集合、敌人 ID/name/location/defeated、任务 ID/name/status/current objective。不得包含 NPC `knownFactIds/hiddenFactIds/interactionHistory/relationship`。
- `world:relevant-events`：最多现有 `storyState.recentBeats` 投影中的条目；不读取 `eventLedger`。
- `world:evolution-need`：kind、reason、结构化 action、content repair。
- `world:output-contract`：根据 need 生成精确 schema 和允许字段。

`newFact` schema 必须写出：`text`、`visibility`、可选 `investigationLabel`，以及可选且只能 2–3 条的 `investigationApproaches[{approachId,label,hint?,evidenceQuality:"clean"|"noisy",tensionDelta:-5..20}]`。

`newItem` 与 `newEnemy` 必须声明当前 parser 的精确字段；所有未使用字段要求省略而不是写 `null`。外层继续要求 `{"proposal":{...}}`。

- [ ] **Step 4: 运行测试**

Run: `npm test -- src/game/application/narrativeContext/worldNarrativeContext.test.ts`  
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/game/application/narrativeContext/worldNarrativeContext.ts src/game/application/narrativeContext/worldNarrativeContext.test.ts src/game/application/narrativeContext/index.ts
git commit -m "feat(narrative): compile world evolution context"
```

---

### Task 6: 迁移 live world source，并把编译 manifest 接入 AI 文本审计

**Consumes:** scene/world `NarrativePromptCompilation.manifest`。  
**Produces:** 每个 scene/world AI call 的 `context.narrativeContext` 安全审计元数据。  
**Independent proof:** fake AI client 捕获第三参数；审计 manifest 中无 Prompt 正文。

**Files:**

- Modify: `src/game/application/server/ai/textAuditTypes.ts`
- Modify: `src/game/application/server/ai/liveScenePerformanceSource.ts`
- Modify: `src/game/application/server/ai/liveScenePerformanceSource.test.ts`
- Modify: `src/game/application/server/ai/liveWorldEvolutionSource.ts`
- Modify: `src/game/application/server/ai/worldEvolutionSource.test.ts`

- [ ] **Step 1: 写审计失败测试**

在两个 live source 测试中分别使用 fake `RpgAiClient` 捕获 `complete()` 第三个参数：

```ts
expect(auditContext.narrativeContext).toEqual(expect.objectContaining({
  compilerVersion: 1,
  maxEstimatedTokens: 8_000,
  selectedEstimatedTokens: expect.any(Number),
  overflowEstimatedTokens: expect.any(Number),
  selected: expect.arrayContaining([expect.objectContaining({ id: "scene:rules" })]),
  dropped: expect.any(Array),
}));
expect(JSON.stringify(auditContext.narrativeContext)).not.toContain("私密正文");
```

world 断言 ID 为 `world:rules` 和 `world:output-contract`。

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
npm test -- src/game/application/server/ai/liveScenePerformanceSource.test.ts src/game/application/server/ai/worldEvolutionSource.test.ts
```

Expected: FAIL，审计上下文尚无 manifest，world source 尚未使用 compiler。

- [ ] **Step 3: 扩展审计纯类型**

`textAuditTypes.ts` 使用 `import type` 引入 `NarrativeContextManifest`，在 `AiTextAuditContext` 增加：

```ts
readonly narrativeContext?: NarrativeContextManifest;
```

不修改 recorder 文件格式、脱敏逻辑或 `RpgAiClient.complete` 签名；现有 `context` 会自然落盘。

- [ ] **Step 4: 接入 scene manifest**

Task 4 的生产调用点将 `narrativeContext: compilation.manifest` 放入 scene audit context。内容修复每次重新编译，manifest 与实际发送 Prompt 一一对应。

- [ ] **Step 5: 迁移 world source**

导出兼容测试入口：

```ts
export function compileLiveWorldEvolutionPrompt(ctx: WorldEvolutionSourceContext): NarrativePromptCompilation;
export function buildWorldEvolutionPrompt(ctx: WorldEvolutionSourceContext): string {
  return compileLiveWorldEvolutionPrompt(ctx).prompt;
}
```

生产调用只编译一次并发送 `compilation.prompt`，同时把 manifest 放入 audit context。删除旧私有 `buildWorldEvolutionPrompt` 内的字符串拼装；保留 `kindText`/repair 语义时可移动到 `worldNarrativeContext.ts`，但不得在两处保留输出 schema 双源。

- [ ] **Step 6: 保持现有 world 回归并新增完整契约断言**

现有以下断言必须继续通过：next_act/ending_pair 区分、placement、town_building、`new_location`、duplicate name repair、content repair、JSON mode、typed failures。

新增对生产 `buildWorldEvolutionPrompt()` 的断言：包含 central conflict、current pacing、recent beats、active quest、newItem/newEnemy/newFact 完整 schema；不含 eventLedger/hidden facts/interaction history。

- [ ] **Step 7: 运行 targeted tests 与类型检查**

Run:

```bash
npm test -- src/game/application/narrativeContext src/game/application/server/ai/liveScenePerformanceSource.test.ts src/game/application/server/ai/worldEvolutionSource.test.ts
npm run typecheck
```

Expected: PASS。

- [ ] **Step 8: 提交**

```bash
git add src/game/application/server/ai/textAuditTypes.ts src/game/application/server/ai/liveScenePerformanceSource.ts src/game/application/server/ai/liveScenePerformanceSource.test.ts src/game/application/server/ai/liveWorldEvolutionSource.ts src/game/application/server/ai/worldEvolutionSource.test.ts
git commit -m "refactor(narrative): audit compiled scene and world prompts"
```

---

### Task 7: 增加跨层回归，证明规则权威和一次生成语义未改变

**Consumes:** 已迁移的两个 live source。  
**Produces:** 防止编译器误把低权威文本放到规则之前、重复调用 AI 或破坏战斗/目标链的回归证明。  
**Independent proof:** application tests，不访问网络。

**Files:**

- Modify: `src/game/application/generatePendingScene.test.ts`
- Modify: `src/game/application/server/ai/liveScenePerformanceSource.test.ts`
- Modify: `src/game/application/server/ai/worldEvolutionSource.test.ts`
- Modify only if an uncovered assertion is needed: `src/game/application/testing/investigationFlowJourney.test.ts`
- Modify only if an uncovered assertion is needed: `src/game/application/testing/linearMovePrefetchRegression.test.ts`

- [ ] **Step 1: 写规则权威顺序测试**

构造包含相互冲突文本的 scene fixture：旧 `recentBeats` 声称玩家仍未获得物品，而当前 mandatory beat 声明已经获得。断言：

- `current_resolution` 块在 `relevant_events` 之前；
- Prompt 明确要求以当前已结算节拍为准；
- parser/approval 仍只接受 mandatory beat ID。

- [ ] **Step 2: 写一次调用测试**

对成功 scene generation 和 world evolution 各断言 `aiClient.complete` 调用一次。内容修复路径仍由现有 application 层显式发起第二次 job/attempt，不在 compiler 或 source 内新增递归调用。

- [ ] **Step 3: 写战斗语义回归**

复用现有 battle fixture，断言：

- battle resolved mandatory beat 在 `current_resolution`；
- AI Prompt 只表演服务端已结算 outcome/HP；
- 编译器和 scene source 不写 `BattleStartSnapshot`，不改变失败回滚代码路径。

本任务只补测试；若测试暴露非编译器引入的现有战斗问题，停止并单独报告，不把战斗重构扩大进 Plan 1。

- [ ] **Step 4: 运行跨层 tests**

Run:

```bash
npm test -- src/game/application/generatePendingScene.test.ts src/game/application/server/ai/liveScenePerformanceSource.test.ts src/game/application/server/ai/worldEvolutionSource.test.ts src/game/application/testing/investigationFlowJourney.test.ts src/game/application/testing/linearMovePrefetchRegression.test.ts
```

Expected: PASS；scene/world 正常路径每次仍只有一次 AI 调用。

- [ ] **Step 5: 提交**

```bash
git add src/game/application/generatePendingScene.test.ts src/game/application/server/ai/liveScenePerformanceSource.test.ts src/game/application/server/ai/worldEvolutionSource.test.ts src/game/application/testing/investigationFlowJourney.test.ts src/game/application/testing/linearMovePrefetchRegression.test.ts
git commit -m "test(narrative): protect compiled prompt authority and turn flow"
```

---

### Task 8: 更新实现事实文档

**Consumes:** 实际通过测试的代码和最终导出接口。  
**Produces:** `docs/agent/` 与索引中的实现事实，不提前声称 Plan 2–8 已存在。  
**Independent proof:** 文档命令、路径、接口名与代码可由 `rg` 对应。

**Files:**

- Modify: `docs/agent/剧情连续性与结构化记忆.md`
- Modify: `docs/agent/运行时AI导演与场景表演.md`
- Modify: `docs/agent/世界动态具象化.md`
- Modify: `docs/agent/AI文本审计.md`
- Modify: `docs/Agent文档索引.md`

- [ ] **Step 1: 记录 compiler 实现事实**

文档必须明确：

- IR 字段、authority 顺序、mandatory overflow、optional budget 和稳定 slot 顺序；
- scene/world 分别投影哪些字段和明确不投影哪些私密数据；
- scene/world Prompt 的唯一 schema 来源文件；
- manifest 只保存元数据，不保存额外 Prompt 副本；
- opening/intent 尚未迁移，Entity/Episode/Living Outline 尚属后续 Plan；
- 本阶段没有存档迁移、没有额外 AI 调用、没有改变战斗失败回滚。

- [ ] **Step 2: 更新 Agent 索引摘要**

在相关系统行增加 2026-08-23 的 Context Compiler 事实，链接现有 agent 文档；不把 `docs/superpowers/specs/` 当成实现事实入口。

- [ ] **Step 3: 校验文档引用和 placeholder**

Run:

```bash
rg -n "NarrativeContextBlock|compileSceneNarrativeContext|compileWorldNarrativeContext|narrativeContext" docs/agent docs/Agent文档索引.md
rg -n "TODO|TBD|待补|占位" src/game/application/narrativeContext
```

Expected: 第一条能定位所有实现入口；第二条无命中。

- [ ] **Step 4: 提交**

```bash
git add docs/agent/剧情连续性与结构化记忆.md docs/agent/运行时AI导演与场景表演.md docs/agent/世界动态具象化.md docs/agent/AI文本审计.md docs/Agent文档索引.md
git commit -m "docs(narrative): document context compiler"
```

---

### Task 9: 全量门禁与完整游戏 journey

**Consumes:** Plan 1 全部提交。  
**Produces:** 可合并证据：短/中篇现有闭环无回归，代码/文档无双源和 placeholder。  
**Independent proof:** 全量自动化命令和最终 diff 审查。

**Files:**

- No planned production changes.
- Modify only the exact failing Plan 1 file if a gate reveals a regression;修复后重跑该 gate 及后续全部 gate。

- [ ] **Step 1: 运行 narrative targeted suite**

Run:

```bash
npm test -- src/game/application/narrativeContext src/game/application/sceneGenerationContext.test.ts src/game/application/generatePendingScene.test.ts src/game/application/server/ai/liveScenePerformanceSource.test.ts src/game/application/server/ai/worldEvolutionSource.test.ts
```

Expected: PASS。

- [ ] **Step 2: 运行完整离线游戏 journey**

Run: `npm run test:foundation-journey`  
Expected: PASS；至少 15 个成功回合，跨 reload，覆盖固定 NPC 选择、自定义输入、旅行、拾取、探索、战斗和结局。  
Run: `npm run journey:foundation`  
Expected: PASS；与上一步相同的零网络 replay 入口可从命令行完整运行。
Run: `npm test -- src/game/application/testing/mediumActJourney.test.ts`  
Expected: PASS；中篇 5 幕经真实幕链推进至结局，`currentAct == targetActs`，结局具象化并解析，预算未越界。

- [ ] **Step 3: 运行全量工程门禁**

Run: `npm test`  
Expected: PASS。  
Run: `npm run typecheck`  
Expected: PASS。  
Run: `npm run lint`  
Expected: PASS。  
Run: `npm run build`  
Expected: PASS。

- [ ] **Step 4: 做架构与隐私扫描**

Run:

```bash
rg -n "eventLedger|hiddenFactIds|interactionHistory|apiKey|Authorization" src/game/application/narrativeContext
rg -n "buildLiveScenePrompt|buildWorldEvolutionPrompt|outputSchema|JSON=|外层必须" src/game/application/server/ai src/game/application/narrativeContext
rg -n "TODO|TBD|待补|占位" src/game/application/narrativeContext
```

Expected:

- 第一条只命中明确的禁止性注释/测试断言，production builder 不读取或渲染这些字段；
- 第二条证明 scene/world schema 各自只有一个 projection/contract 实现，compat wrapper 不复制正文；
- 第三条无命中。

- [ ] **Step 5: 检查 diff 和提交历史**

Run: `git status --short`  
Expected: 只显示实施前已确认保留的用户改动，或完全干净；不得出现未知生成文件。  
Run: `git diff main...HEAD --stat`  
Expected: 变更范围只覆盖本 Plan 列出的 application、server AI tests/types 和 agent docs。  
Run: `git log --oneline main..HEAD`  
Expected: 每个 Task 有对应小提交。

- [ ] **Step 6: 处理门禁修复（仅在产生变更时）**

如果门禁暴露回归，返回引入该回归的 Task，使用该 Task 已列出的精确 `git add` 和提交命令提交修复，然后从 Task 9 Step 1 重新执行。不要使用目录级或通配 `git add`，也不新增一个无法追溯到原任务的泛化收尾提交。

---

## Acceptance Checklist

- [ ] `SceneGenerationContext` 可看到当前 Story Contract，但仍是最小 DTO。
- [ ] scene Prompt 包含 act、tension、pacing、active quest、unresolved thread 引用、recent beats 和焦点 NPC 最近五条结构化交互。
- [ ] world Prompt 包含 Story Contract、当前节奏/任务/近期事件和现有实体安全摘要。
- [ ] WorldDelta 的 newLocation/newNpc/newItem/newEnemy/newFact/nextMainQuest/endingPair schema 与 parser 一致，并按 EvolutionNeed 精确限制。
- [ ] rule/state/event/plan/memory/lore 冲突按固定权威顺序解决。
- [ ] mandatory 不因预算被丢弃，optional 丢弃可审计。
- [ ] 同一输入产生逐字相同 Prompt 和 manifest。
- [ ] manifest 不含 Prompt 正文、玩家原文或 NPC 私密事实正文。
- [ ] scene/world 每条正常生成路径仍只调用一次 AI。
- [ ] parser、approval、规则结算和持久化 schema 未改变。
- [ ] 战斗失败恢复战前状态的代码和行为未改变。
- [ ] opening 与 intent 明确保持现状，没有形成第二套半迁移协议。
- [ ] 完整离线 journey、全量 tests、typecheck、lint、build 全部通过。
- [ ] 短篇和中篇仍能从新游戏完整玩到结局。

---

## Out of Scope / Next Plans

- Entity/Component 持久化、受限 Entity Command：Plan 2。
- NPC 人格锚点、知识来源、NPC-to-NPC 关系图、关系阶段限速：Plan 3。
- 结构化 NarrativeEvent、Episode 与长期检索：Plan 4。
- Living Outline、嵌套 Arc、Story Thread 和滚动规划：Plan 5。
- Arc-aware scene intent、高潮/转折导演和战斗叙事功能：Plan 6。
- 事件分段、快照、索引、上下文指纹：Plan 7。
- 十小时以上 long campaign 入口与验收：Plan 8。
