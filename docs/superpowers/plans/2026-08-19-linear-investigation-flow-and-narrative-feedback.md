# 线性调查流程优化与叙事反馈增强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除单线无分支调查行动（`investigate`）中无意义的 Live AI 阻塞调用，实现即时确定性叙事反馈；修复建筑场景内静态描述遮盖调查旁白的 UI Bug；增强线索到新地点的物理动线因果交代。

**Architecture:** 
1. 将 `investigate` 纳入 `generatePendingScene` 的即时确定性路径（`immediateAction`），与 `move` / `take_item` 保持一致，毫秒级生成结构化调查线索叙事并完成场景写回；
2. 修复 `LocationSceneScreen` 旁注渲染逻辑，确保最新发生的调查/探索/互动叙事优先展示，不被静态建筑模板吞没；
3. 增强 `deterministicEvolutionBeats` 与确定性场景源中的线索描述，明确交代“调查发现了什么”以及“为何引导至新地点”；
4. 完善端到端旅程回归测试，验证“NPC对话 -> 调查线索 -> 剧情交代与动线引导 -> 前往新地点 -> 新NPC交谈”的连贯闭环。

**Tech Stack:** TypeScript, React, Next.js, Vitest

## Global Constraints

- 不新增并行接口或版本化路由，统一使用 `/api/game/actions` 与 `performTurn`；
- 遵循单次 CAS 状态提交与安全 write-back 机制；
- 不破坏现有 NPC 双选项与自定义输入规则；
- 保持离线确定性可玩基线与真实 AI 导演模式的契约一致性。

---

### Task 1: 将 `investigate` 纳入即时确定性场景 fast-path

**Files:**
- Modify: `src/game/application/generatePendingScene.ts`
- Modify: `src/game/application/deterministicSceneSource.ts`
- Test: `src/game/application/generatePendingScene.test.ts`
- Test: `src/game/application/deterministicSceneSource.test.ts`

**Interfaces:**
- Consumes: `PendingNarrativeJob` 中的 `actionSummary: { kind: "investigate", factId }`
- Produces: `deterministicSceneSource` 产出包含完整调查叙事和后续可达行动的 `ScenePerformanceProposal`，无需调用远程 Live AI

- [ ] **Step 1: 编写针对 investigate 走即时确定性场景的失败测试**

在 `src/game/application/generatePendingScene.test.ts` 中添加测试用例：
```ts
it("uses fast deterministic scene source for investigate actions without remote AI call", async () => {
  // 模拟 pending job 为 investigate 的游戏记录
  // 验证 generatePendingScene 在未提供 live AI 或不等待远程调用的情况下即时返回 saved
  // 验证生成的场景包含线索发现的叙事正文
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test src/game/application/generatePendingScene.test.ts`
Expected: FAIL（目前 investigate 未被归入 `immediateAction`，在无 live source / 缺少 mock 时会尝试演化或挂起）

- [ ] **Step 3: 完善 generatePendingScene 与 deterministicSceneSource 的 investigate 分支**

在 `src/game/application/generatePendingScene.ts` 中将 `investigate` 纳入 `immediateAction`：
```ts
const immediateAction = generation.job.actionSummary.kind === "move"
  || generation.job.actionSummary.kind === "take_item"
  || generation.job.actionSummary.kind === "investigate";
```

在 `src/game/application/deterministicSceneSource.ts` 中增强针对 `investigate` 的旁白与选项生成：
- 当上一动作是 `investigate` 时，旁白明确展示线索文本；
- 如果当前权威主线目标是指向新地点或新人物，旁白结尾附带明确的动线引导提示（例如：“线索清晰指向……，当前应前往……”）。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test src/game/application/generatePendingScene.test.ts src/game/application/deterministicSceneSource.test.ts`
Expected: PASS

- [ ] **Step 5: 提交更改**

```bash
git add src/game/application/generatePendingScene.ts src/game/application/deterministicSceneSource.ts src/game/application/generatePendingScene.test.ts src/game/application/deterministicSceneSource.test.ts
git commit -m "feat(narrative): route investigate actions through fast deterministic scene path"
```

---

### Task 2: 修复建筑场景旁注遮盖动态调查叙事的 UI 缺陷

**Files:**
- Modify: `src/components/LocationSceneScreen.tsx`
- Test: `src/components/LocationSceneScreen.test.tsx` 或 `src/components/sharedUiContract.test.tsx`

**Interfaces:**
- Consumes: `GameSessionView.narrative.narration`, `GameSessionView.narrative.eventKind`, `buildingSideNote`
- Produces: 呈现给玩家的 `displayNarration`，优先展示刚完成行动的动态叙事反馈

- [ ] **Step 1: 编写针对建筑内动态叙事呈现的失败测试**

编写测试验证：当玩家在建筑场景内执行了调查/拾取等动作产生新 `narrative.narration` 时，UI 显示的地点旁注中必须包含该 `narration` 正文，不能被静态 `describeBuildingScene` 100% 替换。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test src/components/LocationSceneScreen.test.tsx`
Expected: FAIL（因为 `buildingSideNote || cleanLocationSideNote(...)` 逻辑导致 `buildingSideNote` 永远抢占）

- [ ] **Step 3: 优化 LocationSceneScreen 旁注与动态叙事合成逻辑**

修改 `src/components/LocationSceneScreen.tsx`：
```ts
// 当本场景有新发生的动作叙事（非初始进入建筑场景的默认状态）时，优先呈现动态叙事；
// 初始进入或无特定动作叙事时展示建筑氛围描述；或将动态叙事与建筑名妥善组合。
const rawNarration = cleanLocationSideNote(normalizeDisplayText(view.narrative.narration ?? ""));
const displayNarration = rawNarration !== ""
  ? rawNarration
  : buildingSideNote;
```
同时调整 `cleanLocationSideNote` 的正则，确保不会将合法的线索描述和动线引导文本全部清洗为空。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test src/components/LocationSceneScreen.test.tsx`
Expected: PASS

- [ ] **Step 5: 提交更改**

```bash
git add src/components/LocationSceneScreen.tsx src/components/LocationSceneScreen.test.tsx
git commit -m "fix(ui): ensure dynamic action narration is not occluded by static building description"
```

---

### Task 3: 增强剧本演化中“线索事实 -> 新地点动线”的因果衔接

**Files:**
- Modify: `src/game/application/deterministicEvolutionBeats.ts`
- Modify: `src/game/gameplay/rpg/worldEvolution/approveWorldDelta.ts`
- Test: `src/game/application/deterministicEvolutionBeats.test.ts`

**Interfaces:**
- Consumes: `EvolutionActBeat` 中的 `factText`, `investigationLabel`, `newLocation`
- Produces: 富含物理动线指引的事实文本与叙事节拍，使调查结果直接解释“为什么要去下一地点”

- [ ] **Step 1: 编写检查线索事实动线因果的测试**

在 `deterministicEvolutionBeats.test.ts` 中增加断言：
- 验证各题材（武侠、仙侠、奇幻等）Act 2 的 `factText` 和调查叙事明确解释了与 `newLocation` 的连带关系。

- [ ] **Step 2: 运行测试确认现状与差异**

Run: `npm test src/game/application/deterministicEvolutionBeats.test.ts`

- [ ] **Step 3: 丰富 EvolutionActBeat 中的线索与动线因果描述**

更新 `src/game/application/deterministicEvolutionBeats.ts`：
例如武侠 Act 2：
```ts
factText: "车轮印在后巷泥水中断续向北延伸，指向北巷旧道深处的旧镖局废墟；腰牌上的暗纹与缉凶告示源自同一旧案。",
investigationLabel: "酒楼后巷的车轮印",
```
仙侠 Act 2：
```ts
factText: "山门外的雾中足迹一路蔓延向断炉涧，残留的丹气证实失窃灵砂被带往废丹房方向。",
investigationLabel: "山门外的雾中足迹",
```
奇幻 Act 2：
```ts
factText: "遗迹裂口边缘的爪状凿痕一直向下延伸进熔渣隧道，石片上的刻纹在靠近隧道时隐隐发烫。",
investigationLabel: "裂口边缘的爪状凿痕",
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test src/game/application/deterministicEvolutionBeats.test.ts`
Expected: PASS

- [ ] **Step 5: 提交更改**

```bash
git add src/game/application/deterministicEvolutionBeats.ts src/game/application/deterministicEvolutionBeats.test.ts
git commit -m "feat(story): strengthen spatial causality between clues and target locations across story beats"
```

---

### Task 4: 端到端完整流程与旅程回归验证

**Files:**
- Modify/Add: `src/game/application/testing/investigationFlowJourney.test.ts`
- Test: `src/game/application/testing/foundationJourney.test.ts`
- Test: `src/game/application/testing/storyDivergenceJourney.test.ts`

**Interfaces:**
- Consumes: 全套游戏编排与 UI 投影流程
- Produces: 自动化验证从 NPC 对话结束 -> 调查线索（即时返回、无转圈卡顿） -> 查明线索与动线交代 -> 前往新地点 -> 与新 NPC 对话的完整旅程

- [ ] **Step 1: 编写完整的调查流端到端测试**

在 `src/game/application/testing/investigationFlowJourney.test.ts` 中：
1. 创建武侠新游戏并完成序幕；
2. 在酒楼与韩七完成两轮对话，触发 Act 2 演化；
3. 验证当前目标更新为“调查酒楼后巷的车轮印”；
4. 执行 `investigate` 行动：
   - 验证无需远程 AI 阻塞，即时生成并写回；
   - 验证场景 `narration` 包含车轮印延伸至北巷旧道的明确交代；
   - 验证当前目标自动流转为“前往北巷旧道”；
5. 执行 `move` 前往北巷旧道；
6. 验证抵达北巷旧道后顾砚在场，且顾砚的交谈选项已就绪；
7. 与顾砚展开对话并验证上下文衔接正常。

- [ ] **Step 2: 运行端到端测试**

Run: `npm test src/game/application/testing/investigationFlowJourney.test.ts`
Expected: PASS

- [ ] **Step 3: 运行全量测试套件确保无破坏性改动**

Run: `npm test`
Expected: 全部测试通过

- [ ] **Step 4: 提交更改**

```bash
git add src/game/application/testing/investigationFlowJourney.test.ts
git commit -m "test: add journey regression tests for streamlined linear investigation flow"
```
