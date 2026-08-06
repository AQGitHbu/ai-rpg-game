# Narrative Generation Modal UI Preservation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When runtime narrative generation is pending, keep the current map, town, scene, and any open overlay rendered unchanged while showing the existing preparation message in a blocking modal until the API returns a non-pending view.

**Architecture:** Keep pending detection in `AdventureGameShell`, but remove it from the main screen selection so the existing local navigation state and open overlays remain mounted. Add a dedicated non-dismissible modal component layered above the shell; its presence is controlled solely by `view.narrativeGeneration.status`, so the normal API refresh removes it when generation is ready.

**Tech Stack:** React client components, TypeScript, existing RPG CSS, Vitest, Testing Library.

## Global Constraints

- 修改范围仅限 `ai-rpg-game` worktree `.worktrees/phase14-progressive-generation`，不修改 foundation 或共享 package。
- UI 只消费 `GameSessionView`，不改变 `GameState`、规则结果、API 契约或轮询逻辑。
- 模态窗口必须显示文案：`世界导演、编剧与当前角色正在依据已保存的规则结果准备场景。`
- pending 期间不关闭或替换当前地图、城镇、地点场景、详情弹层或 NPC 对话弹层；API 返回非 pending view 后模态窗口自动解除。
- 最低验收包含组件测试、`npm run typecheck` 和相关测试门禁。

---

### Task 1: Add the non-dismissible narrative generation modal

**Files:**
- Create: `src/components/NarrativeGenerationModal.tsx`
- Modify: `src/components/AdventureGameShell.tsx`
- Modify: `src/app/globals.css`

**Interfaces:**
- Consumes: `AdventureGameShell`'s existing `narrativePending` boolean.
- Produces: `NarrativeGenerationModal` with an accessible, focusable `role="dialog"` that has no close control and does not dismiss on Escape.

- [ ] **Step 1: Implement the modal component**

  Render a fixed, blocking section with `role="dialog"`, `aria-modal="true"`, an accessible title, and the exact preparation message. Focus the dialog on mount and stop keydown propagation from the modal so an underlying `AdventureOverlay` cannot close when Escape is pressed. Do not add an `onClose` prop or close button.

- [ ] **Step 2: Replace the pending screen branch with an overlay**

  In `AdventureGameShell`, always render the existing `LocationSceneScreen` for the scene screen. Render `NarrativeGenerationModal` after the existing overlays whenever narrative generation is pending and there is no active battle or ending. Do not change `CurrentGameScreen` polling or `screen` state.

- [ ] **Step 3: Style the modal above existing overlays and toasts**

  Add scoped CSS for the full-screen backdrop, centered content panel, readable text, and a z-index above the existing toast and overlay layers. The backdrop must intercept pointer events while the current interface remains mounted underneath.

### Task 2: Lock the behavior with UI regression tests and documentation

**Files:**
- Modify: `src/components/AdventureGameShell.test.tsx`
- Modify: `docs/agent/地图与地点冒险.md`
- Modify: `docs/Agent文档索引.md`

**Interfaces:**
- Consumes: the existing session fixtures and `AdventureGameShell` rerender path.
- Produces: regression coverage proving map/scene/dialogue remain visible during pending and the modal disappears after a ready view arrives.

- [ ] **Step 1: Add a pending scene preservation test**

  Render a pending view, assert the exact message is inside a modal, enter the current location, and assert the location caption and interaction remain visible alongside the modal. Rerender with a ready view and assert the modal is gone while the scene remains.

- [ ] **Step 2: Add an open-dialogue preservation test**

  Start from a ready narrative view, open an NPC dialogue overlay, submit a narrative choice that returns a pending view, and assert the dialogue overlay is still present while the generation modal is shown. This guards the requirement that submitting a trigger must not close the current interface.

- [ ] **Step 3: Update implementation facts**

  Add a dated maintenance note to the map/location agent document and reference the same Phase 14 UI behavior in the Agent index; do not change gameplay or persistence documentation.

- [ ] **Step 4: Run focused verification**

  Run `npx vitest run src/components/AdventureGameShell.test.tsx`, then `npm run typecheck` and `npm run test:components`. Expected result: all relevant tests and type checks pass.
