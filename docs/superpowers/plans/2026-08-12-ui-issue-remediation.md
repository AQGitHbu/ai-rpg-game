# 短篇真机测试 UI 问题修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复短篇真机测试汇总中已确认但尚未处理的功能性与可用性 UI 问题，并保持既有游戏流程与状态模型不变。

**Architecture:** 在场景、对话、小镇和等待状态的现有组件边界内做最小改动。文本清洗只作用于展示层；NPC 对话中间态使用现有 `busy` 状态表达；小镇高亮使用现有 `storyRequired`/`interactiveBuildingIds` 数据，不新增后端字段。

**Tech Stack:** Next.js、React、TypeScript、Vitest、Testing Library、现有 CSS 主题变量。

## Global Constraints

- 不改变 canonical API、opaque choice token、规则引擎和存档格式。
- 等待 API 期间必须继续阻止重复提交，并保留可访问的 `role="status"`/`aria-live` 反馈。
- 只修复汇总中已记录的问题，不扩展到新的玩法或视觉重设计。
- 保留工作区中用户已有的未提交修改。

---

### Task 1: 场景文本去重与空行动反馈

**Files:**
- Modify: `src/components/LocationSceneScreen.tsx`
- Modify: `src/app/globals.css`
- Test: `src/components/AdventureGameShell.test.tsx`

**Interfaces:**
- Consumes: `view.narrative.narration`, `view.currentLocation.description`, `view.currentLocation.actions`。
- Produces: 场景只展示不重复的地点描述，并在没有可用行动时展示可访问的等待提示。

- [x] **Step 1: Write the failing tests**：覆盖相同叙事与地点描述只渲染一份，以及行动栏无按钮时显示“等待剧情推进”。
- [x] **Step 2: Run the component tests**：确认新断言在当前实现下失败。
- [x] **Step 3: Implement minimal presentation logic**：将地点描述从叙事文本重复内容中隐藏；行动栏为空时渲染提示节点，不发送任何 action。
- [x] **Step 4: Add readable styling**：让等待提示沿用行动栏容器的视觉层级，但不伪装成可点击按钮。
- [x] **Step 5: Run component tests**：确认通过。

### Task 2: NPC 对话准备态与生成等待反馈

**Files:**
- Modify: `src/components/LocationSceneScreen.tsx`
- Modify: `src/components/GenerationStatusModal.tsx`
- Modify: `src/components/AdventureGameShell.tsx`
- Modify: `src/components/CurrentGameScreen.tsx`
- Modify: `src/components/NewGameSetupForm.tsx`
- Modify: `src/app/globals.css`
- Test: `src/components/AdventureGameShell.test.tsx`
- Test: `src/components/CurrentGameScreen.test.tsx`

**Interfaces:**
- Consumes: `busy`, `pending`, `prologueAcking`, `submitting`。
- Produces: 清晰的准备态文案、统一等待说明和无需等待用户猜测的状态反馈。

- [x] **Step 1: Write the failing tests**：为初始 NPC 对话只有单个交谈入口的状态增加“正在准备对话”提示；为等待模态增加状态文案断言。
- [x] **Step 2: Run the component tests**：确认当前实现没有准备态文案时失败。
- [x] **Step 3: Implement minimal UI state**：当对话没有焦点选项且只有 talk CTA 时显示“正在准备对话……”，并保留按钮；busy/pending 期间由全屏模态统一说明当前阶段。
- [x] **Step 4: Add non-interactive progress details**：等待模态展示“已提交，正在等待故事生成”类说明、已等待秒数和超时后的重新检查入口，不加入不可靠的百分比进度。
- [x] **Step 5: Run component tests**：确认通过。

### Task 3: 小镇剧情建筑高亮与提示文案

**Files:**
- Modify: `src/components/TownLayerScreen.tsx`
- Modify: `src/components/town/TownMapSvg.tsx`
- Modify: `src/app/globals.css`
- Test: `src/components/TownLayerScreen.test.tsx`

**Interfaces:**
- Consumes: `interactiveBuildingIds`, `storyRequired`, `selectedBuildingId`。
- Produces: 剧情建筑图例、明确的当前剧情建筑提示和可见高亮，不泄漏未探索建筑名称。

- [x] **Step 1: Write the failing tests**：断言小镇显示“剧情建筑”图例和提示；已绑定剧情建筑具有可访问的剧情标识。
- [x] **Step 2: Run the town tests**：确认当前界面缺少图例/标识时失败。
- [x] **Step 3: Implement minimal markup**：在侧栏无选择状态加入图例；在可进入剧情建筑信息组加入“当前剧情”标签；为 SVG story building 添加 `aria-label` 可辨识的剧情状态而不暴露未探索名称。
- [x] **Step 4: Add contrast styling**：强化 story/selected building 的描边、发光和图例样式，保持现有地图颜色体系。
- [x] **Step 5: Run town tests**：确认通过。

### Task 4: 标点清洗、回归验证与文档更新

**Files:**
- Create: `src/components/displayText.ts`
- Modify: `src/components/LocationSceneScreen.tsx`
- Test: `src/components/displayText.test.ts`
- Modify: `docs/短篇真机测试汇总-2026-08-12.md`

**Interfaces:**
- Consumes: 叙事展示字符串。
- Produces: `normalizeDisplayText(text: string): string`，只清理连续重复中文句末标点，不修改业务状态或原始存档内容。

- [x] **Step 1: Write the failing text-normalization tests**：覆盖 `。。`、`！！`、`？？` 和普通文本不变。
- [x] **Step 2: Run the unit test**：确认 helper 尚不存在或断言失败。
- [x] **Step 3: Implement the pure helper**：仅压缩连续相同的 `。！？`，保留省略号和非连续标点结构。
- [x] **Step 4: Apply helper at scene display boundaries**：对旁白和地点描述调用 helper，原始文本继续由后端/日志保留。
- [x] **Step 5: Update the report**：把已修复项目移入修复记录，保留仍需产品决策的残余建议。
- [x] **Step 6: Run typecheck, lint, targeted tests and build**：确认完整交付质量。
