# 线性调查流程优化与叙事反馈增强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让单线无分支行动（`investigate` / 单一 `move`）的剧情正文由 AI 在上一分支点（NPC 对话回合）一并预生成，点击时零 API 调用、即时展示；消除调查后的 API 阻塞等待与"无剧情交代"体验；修复建筑场景内静态描述遮盖动态调查叙事的 UI Bug；并把确定性 fallback 降级为"API 实在失败时"的兜底（覆盖全部题材的动线因果质量）。

**核心设计决策（2026-08-19 评审修订）:**
- **剧情正文必须来自 AI**：玩家可见的调查/移动叙事优先消费 AI 预生成文本（`source: "generated"`）；确定性文本仅当 AI 未产出、解析失败、审批拒绝或 API 调用出错时兜底，并记录稳定失败码。
- **AI 生成点 = 剧情分支点**：NPC 对话（两选项/自定义输入）是唯一的实时 AI 生成点。从对话结束到下一个对话点之间的单线链（调查线索 → 前往新地点）的叙事，在对话回合的同一次场景表演调用中一并生成，与 `dialogueFollowups` 预生成分支机制同构。

**Architecture:**
1. **扩展场景表演契约**：`ScenePerformanceProposal` 新增可选字段 `linearActionNarratives`（单线行动预生成叙事，支持 `investigate` 与 `move`）。live prompt 在当前权威目标链即将进入单线调查/移动时，要求 AI 按服务端下发的权威事实（`factText`）与后续目标实体名，生成"调查发现了什么、为何指向下一地点"的叙事正文。
2. **审批与持久化**：`approveScenePerformance` 校验 `linearActionNarratives` 的实体引用合法性（factId/locationId 必须属于当前权威目标链的后续目标）与文本契约；审批通过后随同一次 scene write-back CAS 持久化到 `storyState.narrative.linearNarrativeQueue`（写回覆盖式更新，消费即除）。
3. **即时消费 fast path**：`investigate` 纳入 `generatePendingScene` 的 `immediateAction`（与 `move` / `take_item` 一致），毫秒级完成场景写回；`immediateAction` 场景优先消费 `linearNarrativeQueue` 中精确匹配的 AI 预生成叙事；无匹配时走确定性兜底并记录失败码。演化状态防护：`needs_next_act` / `needs_ending_pair` 时不得走 fast path。
4. **UI 修复**：建筑场景内由调查/拾取/移动产生的新动态叙事优先展示，不被静态 `describeBuildingScene` 遮盖；判定依据 `view.narrative.eventKind`（动态事件 vs 初始进入）。
5. **fallback 质量兜底**：全部 7 个题材 + generic 的 Act 2 `factText` 补全"线索 → 新地点"的物理动线因果，并让调查 fallback 旁白附带结构化下一目标提示——仅在 AI 失败链路上被玩家看到，但必须可用。
6. **端到端回归**：离线 mock live source 验证"预生成 → 持久化 → 即时消费"全链，以及纯 fallback 兜底链；journey 验证"NPC 对话 → 调查（即时、有剧情交代与动线引导）→ 前往新地点 → 新 NPC 交谈"闭环。

**Tech Stack:** TypeScript, React, Next.js, Vitest

## Global Constraints

- 不新增并行接口或版本化路由，统一使用 `/api/game/actions` 与 `performTurn`；
- 遵循单次 CAS 状态提交与安全 write-back 机制；预生成叙事的写入与消费各自独立 CAS；
- 不破坏现有 NPC 双选项与自定义输入规则；
- 剧情正文 AI 优先：live 生产路径（`allowDeterministicFallback === false`）下，调查/移动场景消费的叙事若非 AI 预生成，必须记录稳定失败码，且场景 `source` 标记 `fallback`，不得伪装成 AI 成功（沿用现有真机验收契约）；
- 预生成叙事不得越权：AI 只能演绎服务端下发的权威事实与已批准实体，不得捏造新事实/新实体；审批器按此校验；
- 保持离线确定性可玩基线（无 AI 也能完整游玩）与真实 AI 导演模式的契约一致性。

---

### Task 1: 扩展场景表演契约与 live prompt——AI 预生成单线行动叙事

**Files:**
- Modify: `src/game/application/sceneSource.ts`
- Modify: `src/game/application/sceneGenerationContext.ts`
- Modify: `src/game/application/server/ai/liveScenePerformanceSource.ts`
- Test: `src/game/application/server/ai/liveScenePerformanceSource.test.ts`

**Interfaces:**
- Produces: `LinearActionNarrative = { actionKind: "investigate"; factId: string; narration: string } | { actionKind: "move"; locationId: string; narration: string }`
- Produces: `ScenePerformanceProposal.linearActionNarratives?: readonly LinearActionNarrative[]`（live 提案可选携带；fallback 提案不携带）
- Produces: `SceneGenerationContext.upcomingLinearObjectives: readonly UpcomingObjectiveRef[]`（当前目标之后的单线目标投影：`discover_fact` → factId/investigationLabel/factText；`visit_location` → locationId/locationName；过滤掉 `talk_to_npc` 等分支点之后的实体，只取连续单线前缀）

- [ ] **Step 1: 编写失败测试——live 提案携带并解析 linearActionNarratives**

在 `liveScenePerformanceSource.test.ts` 中添加：
```ts
it("parses linearActionNarratives for upcoming investigate/move objectives", () => {
  // 构造 context：upcomingLinearObjectives 含 discover_fact（车轮印，factText 权威正文）
  // 与 visit_location（北巷旧道）
  // 验证 parseScenePerformanceJson 接受合法 linearActionNarratives（factId/locationId 匹配）
  // 并拒绝非法引用（捏造的 factId → 该字段整体丢弃或解析失败，主场景不受污染）
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test src/game/application/server/ai/liveScenePerformanceSource.test.ts`
Expected: FAIL（类型与解析尚不存在）

- [ ] **Step 3: 扩展类型、上下文投影与 prompt**

1. `sceneSource.ts`：新增 `LinearActionNarrative` 类型与 `ScenePerformanceProposal.linearActionNarratives?` 可选字段（注释说明：仅 live 提案携带，随审批持久化后由 fast path 消费）。
2. `sceneGenerationContext.ts`：`buildSceneGenerationContext` 从当前权威 quest 的 objectives 中投影 `upcomingLinearObjectives`——当前目标之后的连续单线目标前缀（`discover_fact` → `visit_location` 止于下一个 `talk_to_npc` / `defeat_enemy` 等分支点），每项含实体 ID、玩家可见标签、权威正文（factText）与下一目标实体名。
3. `liveScenePerformanceSource.ts`：
   - `parseScenePerformanceJson` 解析 `raw.linearActionNarratives`：`actionKind`/`factId`/`locationId`/`narration` 逐字段校验；引用必须命中 `context.upcomingLinearObjectives`；非法条目整字段丢弃（不阻塞主场景解析）。
   - `buildLiveScenePrompt` 增加单线叙事段：当 `upcomingLinearObjectives` 非空时，输出契约要求 AI 额外生成 `linearActionNarratives` 数组；prompt 明确约束——叙事必须演绎给定的 `factText` 权威事实、必须解释"为何前往下一地点（实体名照抄服务端下发）"、不得捏造新事实/实体/时间、不得输出系统元话术；无 `upcomingLinearObjectives` 时明确要求省略该字段。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test src/game/application/server/ai/liveScenePerformanceSource.test.ts`
Expected: PASS

- [ ] **Step 5: 提交更改**

```bash
git add src/game/application/sceneSource.ts src/game/application/sceneGenerationContext.ts src/game/application/server/ai/liveScenePerformanceSource.ts src/game/application/server/ai/liveScenePerformanceSource.test.ts
git commit -m "feat(narrative): scene proposal contract carries AI pre-generated linear action narratives"
```

---

### Task 2: 审批 linearActionNarratives 并持久化到 linearNarrativeQueue

**Files:**
- Modify: `src/game/application/approveAndWriteScene.ts`
- Modify: `src/game/domain/narrative.ts`
- Modify: `src/game/application/generatePendingScene.ts`
- Modify: `src/game/application/server/persistence/sqliteGameRepository.ts`（若 `with*Default` 组合链需为新字段补默认值，`applyResolvedAction` / `applyBlueprintExpansion` / `interpretGameRow` 三处口径必须一致）
- Test: `src/game/application/generatePendingScene.test.ts`

**Interfaces:**
- Consumes: `ScenePerformanceProposal.linearActionNarratives`
- Produces: `NarrativeRuntimeState.linearNarrativeQueue?: readonly LinearActionNarrativeState[]`（持久化形态：`{ actionKind, factId?/locationId?, narration, source: "generated" }`）
- Produces: `ApprovedSceneWriteBack.linearNarrativeQueue`（随同一次 scene write-back CAS 持久化）

- [ ] **Step 1: 编写失败测试——审批通过后 queue 持久化，非法引用被拒**

在 `generatePendingScene.test.ts` 中添加：
```ts
it("persists approved linearActionNarratives into linearNarrativeQueue on scene write-back", async () => {
  // 注入 fake live sceneSource：提案携带合法 investigate/move 叙事
  // 验证 applySceneWriteBack 后 storyState.narrative.linearNarrativeQueue 含两条
  // 且 source 均为 "generated"
});

it("drops linearActionNarratives referencing entities outside the authoritative objective chain", async () => {
  // fake live source 返回捏造 factId 的叙事
  // 验证整字段被审批丢弃，主场景仍正常写回（不因该字段拒绝整场）
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test src/game/application/generatePendingScene.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现审批与持久化**

1. `narrative.ts`：`NarrativeRuntimeState` 新增 `linearNarrativeQueue?: readonly LinearActionNarrativeState[]`（函数级注释：写回覆盖式更新，仅 fast path 消费时读取，消费即除；残留条目仅在实体 ID 精确匹配时生效，无越权风险）。
2. `approveAndWriteScene.ts`：`approveScenePerformance` 对 `linearActionNarratives` 逐条校验——factId/locationId 必须命中 `context.upcomingLinearObjectives`、narration 非空且不含"主线推进/当前目标"等系统元话术；非法条目整字段丢弃（记 logger warn，不拒整场）；`ApprovedSceneWriteBack` 携带过滤后的 queue。
3. `generatePendingScene.ts`：写回 `nextStoryState.narrative` 时合并 `linearNarrativeQueue`（非 immediateAction 路径同样持久化——对话回合正是生成时机）。
4. `sqliteGameRepository.ts`：如 `interpretGameRow` / `applyResolvedAction` / `applyBlueprintExpansion` 使用 `with*Default` 组合链，为 `linearNarrativeQueue` 补默认值（旧存档缺失时视为空 queue，零迁移）。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test src/game/application/generatePendingScene.test.ts`
Expected: PASS

- [ ] **Step 5: 提交更改**

```bash
git add src/game/application/approveAndWriteScene.ts src/game/domain/narrative.ts src/game/application/generatePendingScene.ts src/game/application/server/persistence/sqliteGameRepository.ts src/game/application/generatePendingScene.test.ts
git commit -m "feat(narrative): approve and persist AI pre-generated linear narratives via scene CAS"
```

---

### Task 3: investigate 纳入即时消费 fast path（含演化状态防护）

**Files:**
- Modify: `src/game/application/generatePendingScene.ts`
- Modify: `src/game/application/deterministicSceneSource.ts`
- Test: `src/game/application/generatePendingScene.test.ts`
- Test: `src/game/application/deterministicSceneSource.test.ts`

**Interfaces:**
- Consumes: `PendingNarrativeJob` 的 `actionSummary: { kind: "investigate", factId }`；`storyState.narrative.linearNarrativeQueue`
- Produces: investigate 的 ready 场景毫秒级写回；`narration` 优先为 AI 预生成文本（`source: "generated"`），否则确定性兜底（`source: "fallback"` + 稳定失败码）

- [ ] **Step 1: 编写失败测试**

在 `generatePendingScene.test.ts` 中添加三个用例：
```ts
it("resolves investigate immediately by consuming pre-generated AI narrative without remote AI call", async () => {
  // 前置：linearNarrativeQueue 已含匹配 factId 的 generated 叙事
  // 验证：不调用注入的 live sceneSource（计数为 0），即时返回 saved
  // 场景 narration === 预生成文本，source === "generated"，queue 消费后清空该条目
});

it("falls back to deterministic investigate scene when queue has no matching entry", async () => {
  // 前置：queue 为空（模拟 AI 失败链）
  // 验证：即时返回 saved，narration 含调查发现叙事与下一目标动线提示
  // source === "fallback" 且 logger 记录稳定失败码
});

it("does not use fast path when evolution demands next act or ending pair", async () => {
  // 前置：investigate 完成触发幕推进，evolution.status === "needs_next_act"
  // 验证：走完整演化 + 场景编排链（worldEvolutionSource 被调用），不被 immediateAction 短路
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test src/game/application/generatePendingScene.test.ts`
Expected: FAIL（目前 investigate 未归入 `immediateAction`）

- [ ] **Step 3: 实现 fast path 与防护**

1. `generatePendingScene.ts`：
```ts
// 单线调查与移动/拾取同为规则已完全确定的即时反馈；但幕推进/结局对
// 挂起时必须保留完整演化编排，不能被 fast path 短路。
const immediateAction = (generation.job.actionSummary.kind === "move"
  || generation.job.actionSummary.kind === "take_item"
  || generation.job.actionSummary.kind === "investigate")
  && record.storyState.evolution.status !== "needs_next_act"
  && record.storyState.evolution.status !== "needs_ending_pair";
```
2. immediateAction 分支下，从 `scenarioSs.narrative.linearNarrativeQueue` 查找与 `job.actionSummary`（factId/locationId）精确匹配的条目：命中则以其 `narration` 组装场景（`source: "generated"`），并在写回的 nextStoryState 中移除该条目；未命中则用 `createDeterministicSceneSource()`（现状）并 `logger.warn("linear_narrative_fallback", { actionKind, entityId })`。
3. `deterministicSceneSource.ts`：investigate 的 fallback 旁白在 fact 文本（beat instruction）之后，追加从 `objectiveTarget` 派生的下一目标动线提示（复用 `objectiveHandoffLine` 的结构化派生，不扫描文本猜主题），保证兜底也回答"为什么去下一地点"。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test src/game/application/generatePendingScene.test.ts src/game/application/deterministicSceneSource.test.ts`
Expected: PASS

- [ ] **Step 5: 提交更改**

```bash
git add src/game/application/generatePendingScene.ts src/game/application/deterministicSceneSource.ts src/game/application/generatePendingScene.test.ts src/game/application/deterministicSceneSource.test.ts
git commit -m "feat(narrative): immediate investigate fast path consuming AI pre-generated narratives"
```

---

### Task 4: 修复建筑场景旁注遮盖动态调查叙事的 UI 缺陷

**Files:**
- Modify: `src/components/LocationSceneScreen.tsx`
- Test: `src/components/sharedUiContract.test.tsx`（`LocationSceneScreen.test.tsx` 不存在，测试落在既有契约文件中）

**Interfaces:**
- Consumes: `GameSessionView.narrative.narration`、`GameSessionView.narrative.eventKind`、`buildingSideNote`
- Produces: 呈现给玩家的 `displayNarration`：动态行动叙事（eventKind 为 `investigate` / `item` / `travel` 时）优先；初始进入或无动态叙事（`dialogue` / `observe`）时展示建筑氛围描述

- [ ] **Step 1: 编写失败测试——建筑内动态叙事不被静态描述遮盖**

在 `sharedUiContract.test.tsx` 中添加：
```tsx
it("shows investigation narration over static building description inside a building scene", () => {
  // 构造 view：town scale + 建筑 context（initialFocusNpcId/sceneBuildingId）
  // narrative.eventKind === "investigate"，narration 为调查发现文本
  // 验证地点旁注包含调查叙事正文，不包含 describeBuildingScene 的静态模板句
});

it("keeps static building description when entering the building without a fresh action narrative", () => {
  // 构造 view：eventKind === "observe"（初始进入），narration 为空或残留
  // 验证旁注展示建筑氛围描述
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test src/components/sharedUiContract.test.tsx`
Expected: FAIL（`buildingSideNote || cleanLocationSideNote(...)` 导致 buildingSideNote 永远抢占）

- [ ] **Step 3: 优化旁注合成逻辑**

修改 `src/components/LocationSceneScreen.tsx`：
```tsx
// 动态行动场景（调查/拾取/移动）的旁注是玩家刚触发的剧情反馈，必须
// 优先于静态建筑氛围；初始进入或纯对话/观察场景才展示建筑描述。
const dynamicNarration = cleanLocationSideNote(normalizeDisplayText(view.narrative.narration ?? ""));
const hasDynamicActionNarration = dynamicNarration !== ""
  && (view.narrative.eventKind === "investigate"
    || view.narrative.eventKind === "item"
    || view.narrative.eventKind === "travel");
const displayNarration = hasDynamicActionNarration
  ? dynamicNarration
  : (buildingSideNote || dynamicNarration);
```
同时复核 `cleanLocationSideNote` 的正则，确保不会把合法的线索描述与动线引导文本清洗为空（现有规则只剥离系统元话术，保留剧情正文）。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test src/components/sharedUiContract.test.tsx`
Expected: PASS

- [ ] **Step 5: 提交更改**

```bash
git add src/components/LocationSceneScreen.tsx src/components/sharedUiContract.test.tsx
git commit -m "fix(ui): prioritize dynamic action narration over static building description"
```

---

### Task 5: 增强全部题材 fallback 剧本中"线索事实 → 新地点动线"的因果衔接

**Files:**
- Modify: `src/game/application/deterministicEvolutionBeats.ts`
- Test: `src/game/application/deterministicEvolutionBeats.test.ts`

**Interfaces:**
- Consumes: `EvolutionActBeat` 中的 `factText`、`investigationLabel`、`newLocation`
- Produces: 富含物理动线指引的事实文本；覆盖武侠、仙侠、奇幻、科幻、都市、架空历史、废土共 7 个题材函数 + `genericBeat` 的 Act 2（其余幕次顺带复核，发现同样问题一并修正）

> 定位说明：本 Task 是 AI 失败兜底链的质量保障（Task 3 Step 1 的 fallback 用例依赖此处文本）；live 预生成叙事由 Task 1 的 prompt 约束保证同等因果性。

- [ ] **Step 1: 编写检查线索事实动线因果的测试**

在 `deterministicEvolutionBeats.test.ts` 中增加断言：遍历全部 `GameTypeId` 题材的 Act 2 beat，验证 `factText` 同时包含 `investigationLabel` 的核心意象与 `newLocation.name`（或其可辨识简称），即"调查发现了什么 + 指向哪里"两类信息齐备。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test src/game/application/deterministicEvolutionBeats.test.ts`
Expected: FAIL（现有 4 个题材的 Act 2 factText 缺少动线因果）

- [ ] **Step 3: 丰富各题材 Act 2 的线索与动线因果描述**

更新 `deterministicEvolutionBeats.ts`（每条 factText 必须交代"线索如何延伸至 newLocation"），示例：
```ts
// 武侠 Act 2：车轮印的走向直接解释为何去北巷旧道
factText: "车轮印在后巷泥水中断续向北延伸，指向北巷旧道深处的旧镖局废墟；腰牌上的暗纹与缉凶告示源自同一旧案。",
investigationLabel: "酒楼后巷的车轮印",
// 仙侠 Act 2：雾中足迹的去向解释为何去断炉涧
factText: "山门外的雾中足迹一路蔓延向断炉涧，残留的丹气证实失窃灵砂被带往废丹房方向。",
// 科幻 Act 2：抓痕的延伸解释为何去货舱回廊
// 都市 Act 2：撬痕与路线的关联解释为何去旧仓库码头
// 架空历史 Act 2：井盖刮痕的指向解释为何去沉舟闸
// ……按同构规则补全 7 题材 + generic
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test src/game/application/deterministicEvolutionBeats.test.ts`
Expected: PASS

- [ ] **Step 5: 提交更改**

```bash
git add src/game/application/deterministicEvolutionBeats.ts src/game/application/deterministicEvolutionBeats.test.ts
git commit -m "feat(story): strengthen spatial causality between clues and target locations across all genres"
```

---

### Task 6: 端到端完整流程与旅程回归验证

**Files:**
- Add: `src/game/application/testing/investigationFlowJourney.test.ts`
- Test: `src/game/application/testing/foundationJourney.test.ts`
- Test: `src/game/application/testing/storyDivergenceJourney.test.ts`

**Interfaces:**
- Consumes: 全套游戏编排与 UI 投影流程（离线 fake live source 注入）
- Produces: 自动化验证两条链路——A（AI 预生成主链）：NPC 对话回合产出 `linearActionNarratives` → 调查即时消费 AI 叙事（零 live 调用）→ 剧情交代与动线引导 → 前往新地点 → 新 NPC 交谈；B（纯 fallback 兜底链）：AI 未提供叙事时调查仍即时、仍有动线交代

- [ ] **Step 1: 编写完整的调查流端到端测试**

在 `investigationFlowJourney.test.ts` 中：
1. 创建武侠新游戏并完成序幕；
2. 在酒楼与韩七完成两轮对话（注入 fake live sceneSource，其提案携带"调查车轮印 + 前往北巷旧道"两段 `linearActionNarratives`），触发 Act 2 演化；
3. 验证当前目标更新为"调查酒楼后巷的车轮印"，且 `linearNarrativeQueue` 已持久化两段 AI 叙事；
4. 执行 `investigate` 行动：
   - 验证 fake live source 未被再次调用（零 API）、即时写回；
   - 验证场景 `narration` 等于预生成 AI 文本（含车轮印延伸至北巷旧道的交代）、`source === "generated"`；
   - 验证 queue 对应条目被消费、当前目标自动流转为"前往北巷旧道"；
5. 执行 `move` 前往北巷旧道：验证同样消费预生成 move 叙事、即时抵达；
6. 验证抵达后顾砚在场且交谈入口就绪，与顾砚展开对话（fake live source 正常生成对话场景）；
7. 复跑同一旅程但 fake source 不携带 `linearActionNarratives`：验证调查/移动仍即时完成、narration 含 Task 5 增强后的动线文本、`source === "fallback"` 且失败码已记录。

- [ ] **Step 2: 运行端到端测试**

Run: `npm test src/game/application/testing/investigationFlowJourney.test.ts`
Expected: PASS

- [ ] **Step 3: 运行全量测试套件确保无破坏性改动**

Run: `npm test`
Expected: 全部测试通过

- [ ] **Step 4: 提交更改**

```bash
git add src/game/application/testing/investigationFlowJourney.test.ts
git commit -m "test: add journey regression tests for AI pre-generated linear investigation flow"
```

---

## 验收要点（对照用户报告的问题）

1. **"npc 沟通后不应该在调查后再调用 api"** → Task 1+2+3：调查叙事在 NPC 对话回合的既有 AI 调用中一并生成并持久化；点击调查零 API、毫秒级反馈。
2. **"调查后要剧情推进，调查了什么，为什么引导到北巷旧道"** → Task 1 prompt 约束（演绎权威 factText + 必须解释指向下一地点）+ Task 4（叙事不被建筑描述遮盖）+ Task 5（兜底同等质量）。
3. **评审发现的缺口修复** → 缺口 1（题材覆盖）：Task 5 全 7 题材 + generic；缺口 2（测试文件路径）：Task 4 落在 `sharedUiContract.test.tsx`；缺口 3（幕末演化跳过）：Task 3 Step 1 第三个用例 + `immediateAction` 防护条件；缺口 4（初始进入建筑的判定）：Task 4 以 `eventKind` 区分动态/静态叙事。

## Non-goals

- 不改变 `move` 在非预生成场景下的即时确定性路径（无匹配 queue 条目时维持现状）；玩家偏离主线的自由移动不强制 AI 化。
- 不为 `take_item` / `attack` 引入预生成叙事（拾取/战斗已有独立反馈机制）；如后续需要，按 `LinearActionNarrative` 同构扩展 `actionKind`。
- 不调整场景/演化 token 预算（3000/3200）；预生成叙事增加的输出量在现有预算内消化，若实测超限再另行评估。
