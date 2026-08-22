# NPC Handoff Dialogue and Action Rail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 NPC 对话交接到下一地点时展示真实的玩家回应，并移除底部重复的导航/NPC 提示，同时保留探索、调查、拾取和战斗等真实场景行动。

**Architecture:** 继续使用现有 `GameSessionView` 的权威目标 token。`LocationSceneScreen` 识别交接场景中的 travel choice，将其玩家文案作为对话记录展示；底部行动栏只过滤重复的 `travel`/`dialogue` 入口，不改变规则层或 opaque token。普通非焦点 NPC 没有交接玩家文案时仍保持零回合的本地关闭语义。

**Tech Stack:** React, TypeScript, Vitest, Testing Library

**Spec:** 用户本轮请求与 `docs/agent/NPC对话驱动叙事场景触发.md`、`docs/agent/地图与地点冒险.md`

## Global Constraints

- UI 只消费 `GameSessionView` 下发的 opaque token，不生成或解析业务 token。
- NPC 正式回合仍只能由对话选项/自定义输入提交；展示玩家回应不得提交新回合。
- 地点移动仍由地图入口承载；探索、调查、拾取和战斗等无其它入口的真实行动不得被删除。
- 修改直接发生在本仓 `main`，不得创建或清理 worktree，不得覆盖用户已有未提交改动。

---

### Task 1: 将 NPC 交接玩家回应展示为对白

**Files:**
- Modify: `src/components/LocationSceneScreen.tsx`
- Test: `src/components/AdventureGameShell.test.tsx`

**Interfaces:**
- `NpcDialogueModal` 接收可选 `playerResponse?: string | null`，只用于展示，不触发 `onSubmit`。
- `LocationSceneScreen` 从已解析的 `currentObjectiveAction` 取 `presentation === "travel"` 的 label，在非焦点交接 NPC 对话中传入。

- [x] **Step 1: 写失败测试**

新增一个 handoff fixture：旧 NPC 的 `npcDialogues` 没有 choices/free input，当前目标 token 命中一条带玩家措辞的 `travel` choice。点击 NPC 卡片后断言：

```tsx
expect(screen.getByRole("dialog", { name: "与陈半仙对话" }))
  .toHaveTextContent("（（抱拳）多谢先生指点，那练刀场在断魂崖后山何处？我这就去瞧瞧。）");
expect(screen.queryByRole("button", { name: "知道了" })).not.toBeInTheDocument();
```

- [x] **Step 2: 运行组件测试确认失败**

Run: `npx vitest run src/components/AdventureGameShell.test.tsx`

Expected: 新增断言失败，因为非焦点 NPC 当前只渲染 `知道了`，不会渲染交接 travel label。

- [x] **Step 3: 实现最小修复**

在 `NpcDialogueModal` 的 speech 区域追加 `playerResponse`，并只在存在该值时隐藏 `知道了` 按钮；保留右上角关闭按钮。调用方只在“旧焦点已交接 + 当前目标 travel action”时传入当前权威 choice 的 label，不能把任何普通旁白或客户端文本当作玩家对白。

- [x] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/components/AdventureGameShell.test.tsx src/components/LocationSceneScreen.test.tsx`

Expected: handoff 玩家回应测试通过，原有普通非焦点 NPC 零回合关闭测试仍通过。

---

### Task 2: 删除重复的底部导航/NPC/空提示

**Files:**
- Modify: `src/components/LocationSceneScreen.tsx`
- Test: `src/components/AdventureGameShell.test.tsx`
- Test: `src/components/LocationSceneScreen.test.tsx`
- Modify: `docs/agent/地图与地点冒险.md`
- Modify: `docs/Agent文档索引.md`

**Interfaces:**
- `scene-action-rail` 仅渲染 `explore`、`investigate`、`item`、`battle` 等真实场景动作。
- `travel`、`dialogue` 及“主线已指向别处/当前场景没有可执行行动”的底部提示不再渲染；地图、左侧 HUD、右侧 NPC 卡片分别承载这些信息/入口。

- [x] **Step 1: 更新失败断言**

将现有组件测试中“底栏显示 dialogue/travel”的断言改为不显示；保留并断言探索、战斗等真实行动仍显示。例如：

```tsx
expect(screen.queryByRole("button", { name: "与老板交谈" })).not.toBeInTheDocument();
expect(screen.queryByRole("button", { name: "前往街道" })).not.toBeInTheDocument();
expect(within(actionRail).getByRole("button", { name: "探索客栈" })).toBeInTheDocument();
```

为没有剩余真实场景行动的交接场景增加断言：页面不再出现行动栏空提示。

- [x] **Step 2: 运行组件测试确认旧断言失败**

Run: `npx vitest run src/components/AdventureGameShell.test.tsx src/components/LocationSceneScreen.test.tsx`

Expected: 旧断言因仍找到 travel/dialogue/空提示而失败，作为行为变更的红灯基线。

- [x] **Step 3: 过滤底部行动栏并清理空状态渲染**

从 `actionRailChoices` 派生 `visibleActionRailChoices = actionRailChoices.filter(choice => choice.presentation !== "travel" && choice.presentation !== "dialogue")`；仅当该数组非空时渲染 `<nav aria-label="行动栏">`。删除交接动线和“当前场景没有可执行行动”的 `<span>`，不删除 `sceneActions`/`narrative.choices` 的服务端 token，也不影响地图和右侧 NPC 入口。

- [x] **Step 4: 更新实现事实并运行定向验证**

在 `docs/agent/地图与地点冒险.md` 与 `docs/Agent文档索引.md` 记录：地图承载 travel、右侧 NPC 卡承载 dialogue、底部仅保留没有其它专属入口的真实场景动作；交接玩家回应显示在旧 NPC 对话中。

Run: `npx vitest run src/components/AdventureGameShell.test.tsx src/components/LocationSceneScreen.test.tsx && npm run typecheck`

Expected: 组件测试与类型检查通过。

---

## Self-Review

- 玩家回应展示不改变 action 提交链，满足 opaque token 与零回合展示约束。
- travel/dialogue 的底部入口被移除，但探索/调查/拾取/战斗仍有可执行 UI，不会造成玩法软锁。
- 普通非焦点 NPC 无交接 choice 时仍可用“知道了”关闭，避免把闲聊误当成正式对白。
