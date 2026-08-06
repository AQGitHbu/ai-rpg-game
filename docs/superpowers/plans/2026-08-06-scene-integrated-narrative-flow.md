# 场景一体化叙事循环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移除"剧情事件"弹层，实现非对话事件分级表现 + 预生成对话流自动续接 + 生成状态投影修正，形成无缝场景一体化叙事循环。

**Architecture:** 在 phase14 已有的渐进式生成基础上，(1) 调整 `projectNarrativeGenerationView` 使 pending 状态不受 currentScene 影响；(2) 移除 `shouldQueue` 中的 `!dialogueFollowupConsumed` 并保留 followup currentScene 作为桥接内容；(3) 删除 `AdventureGameShell` 中的"剧情事件"弹层逻辑；(4) 新增 `SceneNarrationBar` 和 `TravelNarrationScreen` 组件实现分级表现；(5) 在 `NpcDialoguePanel` 中添加"准备中"指示；(6) 放宽 `atomicEventActive` 对 interactions 的抑制。

**Tech Stack:** Next.js 14 (App Router), React 18, TypeScript, Vitest, Testing Library, `@ai-game/ui`

## Global Constraints

- 修改仓库：仅 `ai-rpg-game`，零 foundation 改动
- 工作目录：`.worktrees/phase14-progressive-generation`
- 测试框架：Vitest + @testing-library/react
- 验收命令：`npm run lint`、`npm run typecheck`、`npm test`、`npm run build`
- domain 的 `NarrativeSceneState.choices` 保持固定二元组 `[Choice, Choice]` 不变
- 旧存档零迁移：所有新增视图字段为可选
- `NarrativeScenePanel` 组件文件保留，不从主流程引用
- 测试零真实 AI、零图片网络调用

## File Structure

### 新增文件

| 文件 | 职责 |
|------|------|
| `src/components/SceneNarrationBar.tsx` | 轻量事件旁白条组件（observe/investigate/item） |
| `src/components/SceneNarrationBar.test.tsx` | SceneNarrationBar 单元测试 |
| `src/components/TravelNarrationScreen.tsx` | 旅行事件全屏黑底白字旁白组件 |
| `src/components/TravelNarrationScreen.test.tsx` | TravelNarrationScreen 单元测试 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/game/application/gameSessionView.ts` | `projectNarrativeGenerationView` 修正；`projectNarrativeSceneView` 投影可空 choices；`NarrativeSceneView.choices` 类型改为可空 |
| `src/game/application/performAction.ts` | `shouldQueue` 移除 `!dialogueFollowupConsumed`；pending 时保留 followup currentScene |
| `src/game/application/locationAdventureView.ts` | `NpcDialogueView` 新增 `preparingNextScene`；放宽 `atomicEventActive` 抑制逻辑 |
| `src/components/AdventureGameShell.tsx` | 删除"剧情事件"弹层；调整 `NarrativeGenerationModal` 条件；旅行事件渲染 `TravelNarrationScreen`；修正 `activeDialogue` 条件 |
| `src/components/LocationSceneScreen.tsx` | 集成 `SceneNarrationBar` |
| `src/components/NpcDialoguePanel.tsx` | `preparingNextScene` 时显示"准备中"提示 |
| `src/components/sessionViewFixture.testutil.ts` | fixture 补充 `narrativeGeneration` 默认值 |
| `src/app/globals.css` | 新增 `.scene-narration-bar`、`.travel-narration-screen`、`.npc-dialogue-preparing` 样式 |

---

### Task 1: 修正生成状态投影

**Files:**
- Modify: `src/game/application/gameSessionView.ts:393-398`
- Test: `src/game/application/gameSessionView.test.ts`

**Interfaces:**
- Produces: `projectNarrativeGenerationView` 返回 `{ status: "pending" }` 当 `generation.status === "pending"`，不论 `currentScene` 是否存在

- [ ] **Step 1: Write the failing test**

在 `gameSessionView.test.ts` 末尾追加：

```typescript
it("generation pending 时返回 pending，即使 currentScene 非空（followup 桥接）", () => {
  const stateWithFollowupAndPending: GameState = {
    ...PIPELINE.state,
    narrative: {
      currentScene: {
        sceneId: "scene-followup-1",
        turn: 2,
        narration: "陆掌柜沉吟片刻。",
        usedFactIds: [],
        npcLine: { npcId: "npc_lu" as NpcId, text: "此事说来话长。", emotion: "neutral", usedFactIds: [] },
        choices: [
          { choiceToken: "t1", label: "请问一下目前状况是怎么样的？", actionKey: "a1", choiceKind: "dialogue_response", dialogueIntent: "intent_1" },
          { choiceToken: "t2", label: "是否可以告诉我事情的缘由？", actionKey: "a2", choiceKind: "dialogue_response", dialogueIntent: "intent_2" },
        ],
        source: "generated",
        event: { kind: "dialogue", focusNpcId: "npc_lu" as NpcId },
        npcDialogues: [{ npcId: "npc_lu" as NpcId, npcName: "陆掌柜", npcRole: "客栈掌柜", speechPages: ["此事说来话长。"] }],
      },
      generation: { status: "pending", requestedAt: "2026-08-06T00:00:00Z" },
      mode: "ai",
    },
  };
  const view = projectGameSessionView({
    gameId: PIPELINE.gameId,
    blueprint: PIPELINE.blueprint,
    state: stateWithFollowupAndPending,
    revision: 1,
    worldName: "武侠",
  });
  expect(view.narrativeGeneration.status).toBe("pending");
  expect(view.narrative).not.toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/game/application/gameSessionView.test.ts -t "generation pending 时返回 pending"`
Expected: FAIL — `expect(view.narrativeGeneration.status).toBe("pending")` 收到 `"ready"`

- [ ] **Step 3: Write minimal implementation**

修改 `gameSessionView.ts` 中的 `projectNarrativeGenerationView`：

```typescript
function projectNarrativeGenerationView(state: GameState): NarrativeGenerationView {
  return {
    status: state.narrative.generation.status === "pending" ? "pending" : "ready",
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/game/application/gameSessionView.test.ts -t "generation pending 时返回 pending"`
Expected: PASS

- [ ] **Step 5: Run full test suite for this file**

Run: `npx vitest run src/game/application/gameSessionView.test.ts`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add src/game/application/gameSessionView.ts src/game/application/gameSessionView.test.ts
git commit -m "fix: projectNarrativeGenerationView 在 pending 时返回 pending 不受 currentScene 影响"
```

---

### Task 2: 预生成对话流自动续接

**Files:**
- Modify: `src/game/application/performAction.ts:477-496`
- Test: `src/game/application/performAction.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `projectNarrativeGenerationView` 修正（确保 followup + pending 状态正确投影）
- Produces: `shouldQueue` 不再因 `dialogueFollowupConsumed` 跳过排队；pending 时保留 followup `currentScene`

- [ ] **Step 1: Write the failing test**

在 `performAction.test.ts` 中追加测试（需要参考现有 `dialogue_response` 测试的 fixture 模式）：

```typescript
it("dialogue_response 消费 followup 后自动排队下一幕并保留 currentScene", async () => {
  // 构造一个含 dialogueFollowups 的 currentScene
  const { record, deps } = await setupDialogueFollowupRecord();
  const choice = record.state.narrative.currentScene!.choices[0];

  const result = await performAction(
    { intent: { type: "narrative_choice", choiceToken: choice.choiceToken }, expectedRevision: record.revision },
    deps
  );

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  // followup currentScene 被保留（非 null）
  expect(result.view.narrative).not.toBeNull();
  expect(result.view.narrativeGeneration.status).toBe("pending");
});
```

> 注：`setupDialogueFollowupRecord` 辅助函数应参考现有 `performAction.test.ts` 中已有的 dialogue_response fixture 构建方式。如果已有类似 helper，复用它；否则在测试文件顶部新建。

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/game/application/performAction.test.ts -t "dialogue_response 消费 followup 后自动排队下一幕"`
Expected: FAIL — `expect(result.view.narrativeGeneration.status).toBe("pending")` 收到 `"ready"`（因为 `shouldQueue` 被 `!dialogueFollowupConsumed` 阻止）

- [ ] **Step 3: Modify `shouldQueue`**

在 `performAction.ts` 第 477 行：

```typescript
// 修改前
const shouldQueue = intent.type !== "ack_prologue" && !isRepeatTalk && !dialogueFollowupConsumed;

// 修改后
const shouldQueue = intent.type !== "ack_prologue" && !isRepeatTalk;
```

- [ ] **Step 4: Modify pending 时的 currentScene 保留**

在 `performAction.ts` 第 478-496 行的 `if (shouldQueue)` 块内：

```typescript
if (shouldQueue) {
  nextState = {
    ...nextState,
    narrative: {
      currentScene: dialogueFollowupConsumed
        ? nextState.narrative.currentScene  // 保留 followup 供玩家阅读
        : null,
      generation: {
        status: "pending",
        requestedAt: deps.now(),
        triggerContext: intent.type === "talk"
          ? { kind: "talk", npcId: intent.npcId, isFirstMeeting: !isRepeatTalk }
          : intent.type === "narrative_choice"
            ? dialogueResponse?.triggerContext ?? narrativeChoiceTriggerContext ?? { kind: "narrative_choice_followup", previousChoiceActionKey: intent.choiceToken }
            : undefined,
        ...(dialogueResponse !== null ? { playerNpcChat: dialogueResponse.playerNpcChat } : {}),
      },
      mode: nextState.narrative.mode,
    },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/game/application/performAction.test.ts -t "dialogue_response 消费 followup 后自动排队下一幕"`
Expected: PASS

- [ ] **Step 6: Run full performAction test suite**

Run: `npx vitest run src/game/application/performAction.test.ts`
Expected: 全部 PASS（如有因 `shouldQueue` 变更导致的失败，检查是否需要调整断言：原来 followup 后不排队的测试现在会排队，需更新断言）

- [ ] **Step 7: Commit**

```bash
git add src/game/application/performAction.ts src/game/application/performAction.test.ts
git commit -m "feat: 预生成对话流自动续接——移除 !dialogueFollowupConsumed 限制并保留 followup currentScene"
```

---

### Task 3: NarrativeSceneView.choices 改为可空

**Files:**
- Modify: `src/game/application/gameSessionView.ts:110-128` (类型) 和 `:364-391` (投影)
- Test: `src/game/application/gameSessionView.test.ts`

**Interfaces:**
- Produces: `NarrativeSceneView.choices` 类型为 `readonly { label: string; choiceToken: string }[] | null`
- Produces: `projectNarrativeSceneView` 在 `generation.status === "pending"` 时输出 `choices: null`

- [ ] **Step 1: Write the failing test**

在 `gameSessionView.test.ts` 追加：

```typescript
it("generation pending 时 currentScene 的 choices 投影为 null", () => {
  const stateWithFollowupAndPending: GameState = {
    ...PIPELINE.state,
    narrative: {
      currentScene: {
        sceneId: "scene-followup-1",
        turn: 2,
        narration: "陆掌柜沉吟片刻。",
        usedFactIds: [],
        npcLine: { npcId: "npc_lu" as NpcId, text: "此事说来话长。", emotion: "neutral", usedFactIds: [] },
        choices: [
          { choiceToken: "t1", label: "请问一下目前状况是怎么样的？", actionKey: "a1", choiceKind: "dialogue_response", dialogueIntent: "intent_1" },
          { choiceToken: "t2", label: "是否可以告诉我事情的缘由？", actionKey: "a2", choiceKind: "dialogue_response", dialogueIntent: "intent_2" },
        ],
        source: "generated",
        event: { kind: "dialogue", focusNpcId: "npc_lu" as NpcId },
        npcDialogues: [{ npcId: "npc_lu" as NpcId, npcName: "陆掌柜", npcRole: "客栈掌柜", speechPages: ["此事说来话长。"] }],
      },
      generation: { status: "pending", requestedAt: "2026-08-06T00:00:00Z" },
      mode: "ai",
    },
  };
  const view = projectGameSessionView({
    gameId: PIPELINE.gameId,
    blueprint: PIPELINE.blueprint,
    state: stateWithFollowupAndPending,
    revision: 1,
    worldName: "武侠",
  });
  expect(view.narrative).not.toBeNull();
  expect(view.narrative!.choices).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/game/application/gameSessionView.test.ts -t "choices 投影为 null"`
Expected: FAIL — `expect(view.narrative!.choices).toBeNull()` 收到数组

- [ ] **Step 3: Modify the type**

在 `gameSessionView.ts` 第 110-128 行，将 `choices` 类型改为可空：

```typescript
export type NarrativeSceneView = {
  readonly narration: string;
  readonly eventKind?: import("@/game/domain").NarrativeEventKind;
  readonly npcLine: { readonly text: string; readonly emotion: string } | null;
  readonly nextEventHint?: string;
  readonly choices: readonly {
    readonly label: string;
    readonly choiceToken: string;
  }[] | null;
  readonly npcDialogues: readonly {
    readonly npcId: string;
    readonly npcName: string;
    readonly npcRole: string;
    readonly speechPages: readonly string[];
  }[];
} | null;
```

- [ ] **Step 4: Modify the projection**

在 `gameSessionView.ts` 的 `projectNarrativeSceneView` 函数中（第 364-391 行），修改 choices 投影：

```typescript
function projectNarrativeSceneView(
  state: GameState
): NarrativeSceneView {
  const scene = state.narrative.currentScene;
  if (scene === null) return null;
  const isPending = state.narrative.generation.status === "pending";
  return {
    narration: scene.narration,
    ...(scene.event !== undefined ? { eventKind: scene.event.kind } : {}),
    ...(scene.nextEventHint === undefined ? {} : { nextEventHint: scene.nextEventHint }),
    npcLine: scene.npcLine === null ? null : {
      text: scene.npcLine.text,
      emotion: scene.npcLine.emotion,
    },
    // followup 播放 + 后台生成时，选项区被"准备中"提示替换，不投影 choices
    choices: isPending ? null : scene.choices.map((choice, index) => ({
      label: scene.event?.kind === "dialogue"
        ? PLAYER_DIALOGUE_RESPONSE_LABELS[index]
        : choice.label,
      choiceToken: choice.choiceToken,
    })),
    npcDialogues: (scene.npcDialogues ?? []).map((d) => ({
      npcId: String(d.npcId),
      npcName: d.npcName,
      npcRole: d.npcRole,
      speechPages: d.speechPages,
    })),
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/game/application/gameSessionView.test.ts -t "choices 投影为 null"`
Expected: PASS

- [ ] **Step 6: Run typecheck to find any consumers that need updating**

Run: `npx tsc --noEmit`
Expected: 可能有类型错误——`choices` 从固定元组变为可空数组后，引用 `scene.choices.map(...)` 的地方需要空值检查。修复所有编译错误。

- [ ] **Step 7: Run full test suite**

Run: `npx vitest run src/game/application/gameSessionView.test.ts`
Expected: 全部 PASS

- [ ] **Step 8: Commit**

```bash
git add src/game/application/gameSessionView.ts src/game/application/gameSessionView.test.ts
git commit -m "refactor: NarrativeSceneView.choices 改为可空——pending 时投影 null"
```

---

### Task 4: NpcDialogueView 新增 preparingNextScene 字段

**Files:**
- Modify: `src/game/application/locationAdventureView.ts:83-98` (类型) 和 `:275-335` (投影)
- Test: `src/game/application/locationAdventureView.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `NarrativeSceneView.choices` 可空类型
- Produces: `NpcDialogueView.preparingNextScene: boolean`

- [ ] **Step 1: Write the failing test**

在 `locationAdventureView.test.ts` 追加：

```typescript
it("followup 播放 + generation pending 时 preparingNextScene 为 true", () => {
  const state = buildStateWithFollowupAndPending();
  const result = projectLocationAdventureView(
    PIPELINE.blueprint,
    state,
    projectAvailableActions(PIPELINE.blueprint, state)
  );
  const dialogue = result.dialogues.find((d) => d.npcId === "npc_lu");
  expect(dialogue).toBeDefined();
  expect(dialogue!.preparingNextScene).toBe(true);
  expect(dialogue!.choices).toEqual([]);
});

it("generation idle 且有 currentScene 时 preparingNextScene 为 false", () => {
  const state = buildStateWithReadyDialogueScene();
  const result = projectLocationAdventureView(
    PIPELINE.blueprint,
    state,
    projectAvailableActions(PIPELINE.blueprint, state)
  );
  const dialogue = result.dialogues.find((d) => d.npcId === "npc_lu");
  expect(dialogue).toBeDefined();
  expect(dialogue!.preparingNextScene).toBe(false);
});
```

> 注：`buildStateWithFollowupAndPending` 和 `buildStateWithReadyDialogueScene` 辅助函数参考该测试文件已有的 state fixture 构建模式。

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/game/application/locationAdventureView.test.ts -t "preparingNextScene"`
Expected: FAIL — `preparingNextScene` 属性不存在

- [ ] **Step 3: Add the field to the type**

在 `locationAdventureView.ts` 的 `NpcDialogueView` 类型中（第 83-98 行）追加：

```typescript
export type NpcDialogueView = {
  readonly npcId: string;
  readonly name: string;
  readonly role: string;
  readonly slot: SceneSlot;
  readonly speechPages: readonly string[];
  readonly nextEventHint?: string;
  readonly choices: readonly DialogueChoiceView[];
  readonly freeInputEnabled: boolean;
  readonly reviewClues: readonly string[];
  readonly preparingNextScene: boolean;
};
```

- [ ] **Step 4: Add the projection logic**

在 `locationAdventureView.ts` 的 `projectDialogues` 函数内（约第 275-335 行），找到构建 `NpcDialogueView` 返回值的位置，追加 `preparingNextScene`：

```typescript
// 在构建 dialogue 返回值的地方追加：
preparingNextScene: !readOnly
  && scene !== null
  && scene.event?.kind === "dialogue"
  && state.narrative.generation.status === "pending",
```

同时更新 `sessionViewFixture.testutil.ts` 中的 `NpcDialogueView` fixture，补充 `preparingNextScene: false`。

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/game/application/locationAdventureView.test.ts -t "preparingNextScene"`
Expected: PASS

- [ ] **Step 6: Run typecheck and fix any consumer errors**

Run: `npx tsc --noEmit`
Expected: 可能有缺省值错误——所有手写 `NpcDialogueView` 的地方需要补 `preparingNextScene: false`。修复所有编译错误。

- [ ] **Step 7: Commit**

```bash
git add src/game/application/locationAdventureView.ts src/game/application/locationAdventureView.test.ts src/components/sessionViewFixture.testutil.ts
git commit -m "feat: NpcDialogueView 新增 preparingNextScene 字段"
```

---

### Task 5: 放宽 atomicEventActive 对 interactions 的抑制

**Files:**
- Modify: `src/game/application/locationAdventureView.ts:354` 和 `:383`
- Test: `src/game/application/locationAdventureView.test.ts`

**Interfaces:**
- Produces: `locationScene.interactions` 仅在 `readOnly`、`generation.status === "pending"`（无可读场景）、或当前场景 eventKind 为 `travel`/`battle` 时为空；轻量事件（observe/investigate/item）保留 interactions

- [ ] **Step 1: Write the failing test**

在 `locationAdventureView.test.ts` 追加：

```typescript
it("observe 事件场景保留 interactions（轻量事件不抑制热点）", () => {
  const state = buildStateWithObserveEventScene();
  const result = projectLocationAdventureView(
    PIPELINE.blueprint,
    state,
    projectAvailableActions(PIPELINE.blueprint, state)
  );
  expect(result.locationScene.interactions.length).toBeGreaterThan(0);
});

it("travel 事件场景抑制 interactions（全屏呈现）", () => {
  const state = buildStateWithTravelEventScene();
  const result = projectLocationAdventureView(
    PIPELINE.blueprint,
    state,
    projectAvailableActions(PIPELINE.blueprint, state)
  );
  expect(result.locationScene.interactions).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/game/application/locationAdventureView.test.ts -t "observe 事件场景保留 interactions"`
Expected: FAIL — observe 事件场景的 interactions 被置空

- [ ] **Step 3: Modify the suppression logic**

在 `locationAdventureView.ts` 第 354 行，替换 `atomicEventActive` 逻辑：

```typescript
// 修改前
const atomicEventActive = state.narrative.currentScene !== null || state.narrative.generation.status === "pending";

// 修改后：仅 pending（无可读场景）或全屏/战斗事件场景才抑制 interactions；
// 轻量事件（observe/investigate/item）和对话事件保留热点。
const suppressInteractions = readOnly
  || state.narrative.generation.status === "pending"
  || (state.narrative.currentScene !== null
    && state.narrative.currentScene.event !== undefined
    && (state.narrative.currentScene.event.kind === "travel"
      || state.narrative.currentScene.event.kind === "battle"));
```

然后修改第 383 行：

```typescript
// 修改前
interactions: readOnly || atomicEventActive ? [] : projectSceneInteractions(availableActions)

// 修改后
interactions: suppressInteractions ? [] : projectSceneInteractions(availableActions)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/game/application/locationAdventureView.test.ts -t "observe 事件场景保留 interactions"`
Expected: PASS

- [ ] **Step 5: Run full test suite for this file**

Run: `npx vitest run src/game/application/locationAdventureView.test.ts`
Expected: 全部 PASS（如有因放宽抑制导致的失败，检查断言是否需要更新）

- [ ] **Step 6: Commit**

```bash
git add src/game/application/locationAdventureView.ts src/game/application/locationAdventureView.test.ts
git commit -m "feat: 放宽 atomicEventActive 抑制——轻量事件场景保留 interactions"
```

---

### Task 6: SceneNarrationBar 组件

**Files:**
- Create: `src/components/SceneNarrationBar.tsx`
- Test: `src/components/SceneNarrationBar.test.tsx`

**Interfaces:**
- Consumes: `narration: string` from `view.narrative.narration`
- Produces: `SceneNarrationBar` 组件，props: `{ narration: string; onDismiss: () => void }`

- [ ] **Step 1: Write the failing test**

创建 `src/components/SceneNarrationBar.test.tsx`：

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SceneNarrationBar } from "./SceneNarrationBar";

describe("SceneNarrationBar", () => {
  it("显示旁白文本", () => {
    render(<SceneNarrationBar narration="你仔细查看石碑，发现上面刻着古老的符文。" onDismiss={vi.fn()} />);
    expect(screen.getByText("你仔细查看石碑，发现上面刻着古老的符文。")).toBeInTheDocument();
  });

  it("点击关闭按钮调用 onDismiss", async () => {
    const onDismiss = vi.fn();
    render(<SceneNarrationBar narration="测试旁白。" onDismiss={onDismiss} />);
    await userEvent.click(screen.getByRole("button", { name: "关闭旁白" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("不渲染空旁白", () => {
    const { container } = render(<SceneNarrationBar narration="" onDismiss={vi.fn()} />);
    expect(container.querySelector(".scene-narration-bar")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/SceneNarrationBar.test.tsx`
Expected: FAIL — 模块不存在

- [ ] **Step 3: Create the component**

创建 `src/components/SceneNarrationBar.tsx`：

```tsx
"use client";

import type React from "react";

export function SceneNarrationBar(props: Readonly<{
  narration: string;
  onDismiss: () => void;
}>): React.JSX.Element | null {
  const { narration, onDismiss } = props;
  if (narration === "") return null;
  return (
    <div className="scene-narration-bar" role="status" aria-live="polite">
      <p className="scene-narration-bar-text">{narration}</p>
      <button
        type="button"
        className="scene-narration-bar-close"
        aria-label="关闭旁白"
        onClick={onDismiss}
      >
        ×
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/SceneNarrationBar.test.tsx`
Expected: PASS

- [ ] **Step 5: Add CSS styles**

在 `src/app/globals.css` 末尾追加：

```css
/* 场景旁白条——轻量事件（observe/investigate/item）的 AI 旁白 */
.scene-narration-bar {
  position: relative;
  margin: 8px 0;
  padding: 12px 36px 12px 16px;
  background: rgba(17, 22, 18, 0.85);
  border-left: 3px solid var(--game-accent);
  border-radius: 4px;
  animation: scene-narration-fade-in 0.4s ease-out;
}

.scene-narration-bar-text {
  margin: 0;
  line-height: 1.8;
  color: var(--game-text-primary);
  font-size: 0.92rem;
}

.scene-narration-bar-close {
  position: absolute;
  top: 6px;
  right: 8px;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--game-text-muted);
  font-size: 1.2rem;
  line-height: 1;
  cursor: pointer;
  border-radius: 4px;
}

.scene-narration-bar-close:hover {
  background: rgba(255, 255, 255, 0.1);
  color: var(--game-text-primary);
}

@keyframes scene-narration-fade-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}
```

- [ ] **Step 6: Commit**

```bash
git add src/components/SceneNarrationBar.tsx src/components/SceneNarrationBar.test.tsx src/app/globals.css
git commit -m "feat: 新增 SceneNarrationBar 组件——轻量事件旁白条"
```

---

### Task 7: TravelNarrationScreen 组件

**Files:**
- Create: `src/components/TravelNarrationScreen.tsx`
- Test: `src/components/TravelNarrationScreen.test.tsx`

**Interfaces:**
- Consumes: `narration: string` from `view.narrative.narration`
- Produces: `TravelNarrationScreen` 组件，props: `{ narration: string; onComplete: () => void }`

- [ ] **Step 1: Write the failing test**

创建 `src/components/TravelNarrationScreen.test.tsx`：

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TravelNarrationScreen } from "./TravelNarrationScreen";

describe("TravelNarrationScreen", () => {
  it("显示旅行旁白文本", () => {
    render(<TravelNarrationScreen narration="你沿着官道前行，远处城楼的轮廓逐渐清晰。" onComplete={vi.fn()} />);
    expect(screen.getByText(/你沿着官道前行/)).toBeInTheDocument();
  });

  it("点击调用 onComplete", async () => {
    const onComplete = vi.fn();
    render(<TravelNarrationScreen narration="测试旅行旁白。" onComplete={onComplete} />);
    await userEvent.click(screen.getByRole("dialog"));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/TravelNarrationScreen.test.tsx`
Expected: FAIL — 模块不存在

- [ ] **Step 3: Create the component**

创建 `src/components/TravelNarrationScreen.tsx`：

```tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const SKIP_KEYS: ReadonlySet<string> = new Set(["Enter", " ", "Escape"]);

/** 旅行事件全屏黑底白字旁白——复用 PrologueScreen 的视觉风格。 */
export function TravelNarrationScreen(props: Readonly<{
  narration: string;
  onComplete: () => void;
}>): React.JSX.Element {
  const { narration, onComplete } = props;
  const [displayedText, setDisplayedText] = useState("");
  const [isComplete, setIsComplete] = useState(false);
  const submittedRef = useRef(false);

  useEffect(() => {
    let index = 0;
    const timer = setInterval(() => {
      if (index < narration.length) {
        setDisplayedText(narration.slice(0, index + 1));
        index++;
      } else {
        clearInterval(timer);
        setIsComplete(true);
      }
    }, 50);
    return () => clearInterval(timer);
  }, [narration]);

  const handleComplete = useCallback(() => {
    if (!isComplete) {
      setDisplayedText(narration);
      setIsComplete(true);
      return;
    }
    if (submittedRef.current) return;
    submittedRef.current = true;
    onComplete();
  }, [isComplete, narration, onComplete]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (!SKIP_KEYS.has(event.key)) return;
      event.preventDefault();
      handleComplete();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [handleComplete]);

  return (
    <div
      className="travel-narration-screen"
      role="dialog"
      aria-label="旅行旁白"
      onClick={handleComplete}
    >
      <div className="travel-narration-content">
        <p className="travel-narration-text">{displayedText}</p>
        {isComplete && <p className="travel-narration-hint">点击或按 Enter / Space / Esc 继续</p>}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/TravelNarrationScreen.test.tsx`
Expected: PASS

- [ ] **Step 5: Add CSS styles**

在 `src/app/globals.css` 追加：

```css
/* 旅行事件全屏旁白——复用序幕视觉风格 */
.travel-narration-screen {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #000;
  cursor: pointer;
}

.travel-narration-content {
  max-width: 640px;
  padding: 0 32px;
  text-align: center;
}

.travel-narration-text {
  margin: 0;
  color: #f3ead5;
  font-size: 1.1rem;
  line-height: 2;
  letter-spacing: 0.04em;
  min-height: 4em;
}

.travel-narration-hint {
  margin-top: 24px;
  color: rgba(243, 234, 213, 0.5);
  font-size: 0.82rem;
}
```

- [ ] **Step 6: Commit**

```bash
git add src/components/TravelNarrationScreen.tsx src/components/TravelNarrationScreen.test.tsx src/app/globals.css
git commit -m "feat: 新增 TravelNarrationScreen 组件——旅行事件全屏旁白"
```

---

### Task 8: NpcDialoguePanel "准备中"指示

**Files:**
- Modify: `src/components/NpcDialoguePanel.tsx:130-141`
- Test: `src/components/NpcDialoguePanel.test.tsx`

**Interfaces:**
- Consumes: `dialogue.preparingNextScene: boolean` from Task 4
- Produces: 当 `preparingNextScene` 为 true 时，选项区替换为"正在准备下一幕…"提示

- [ ] **Step 1: Write the failing test**

在 `NpcDialoguePanel.test.tsx` 追加：

```typescript
it("preparingNextScene 时显示准备中提示并隐藏选项", () => {
  const dialogue: NpcDialogueView = {
    npcId: "npc_lu",
    name: "陆掌柜",
    role: "客栈掌柜",
    slot: "left",
    speechPages: ["陆掌柜沉吟片刻。"],
    choices: [],
    freeInputEnabled: false,
    reviewClues: [],
    preparingNextScene: true,
  };
  render(
    <NpcDialoguePanel
      dialogue={dialogue}
      gameType="wuxia"
      onChoice={vi.fn()}
      busy={false}
      onFreeInput={vi.fn()}
    />
  );
  expect(screen.getByText("正在准备下一幕…")).toBeInTheDocument();
  expect(screen.queryByRole("group", { name: "对话选项" })).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/NpcDialoguePanel.test.tsx -t "preparingNextScene"`
Expected: FAIL — `preparingNextScene` 属性不存在或"正在准备下一幕…"文本未显示

- [ ] **Step 3: Modify the component**

在 `NpcDialoguePanel.tsx` 中，替换 `npc-dialogue-choices` 区域的渲染逻辑（约第 130-141 行）：

```tsx
{dialogue.preparingNextScene ? (
  <p className="npc-dialogue-preparing" role="status" aria-live="polite">
    正在准备下一幕…
  </p>
) : (
  <div className="npc-dialogue-choices" role="group" aria-label="对话选项">
    {dialogue.choices.map((choice, index) => (
      <button
        key={choice.choiceToken}
        type="button"
        disabled={busy}
        onClick={() => onChoice(choice.choiceToken)}
      >
        {`${index + 1}. ${choice.label}`}
      </button>
    ))}
  </div>
)}
```

- [ ] **Step 4: Add CSS for the preparing hint**

在 `src/app/globals.css` 追加：

```css
.npc-dialogue-preparing {
  margin: 8px 0;
  padding: 12px 16px;
  color: var(--game-text-muted);
  font-size: 0.9rem;
  text-align: center;
  background: rgba(215, 185, 111, 0.08);
  border-radius: 4px;
  animation: scene-narration-fade-in 0.4s ease-out;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/components/NpcDialoguePanel.test.tsx`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add src/components/NpcDialoguePanel.tsx src/components/NpcDialoguePanel.test.tsx src/app/globals.css
git commit -m "feat: NpcDialoguePanel preparingNextScene 时显示准备中提示"
```

---

### Task 9: LocationSceneScreen 集成 SceneNarrationBar

**Files:**
- Modify: `src/components/LocationSceneScreen.tsx:44-110`
- Test: `src/components/LocationSceneScreen.test.tsx`

**Interfaces:**
- Consumes: `SceneNarrationBar` from Task 6, `view.narrative` from `GameSessionView`
- Produces: 当 `view.narrative` 非空且 `eventKind` 为 observe/investigate/item 时，在场景描述下方渲染旁白条

- [ ] **Step 1: Write the failing test**

在 `LocationSceneScreen.test.tsx` 追加：

```typescript
it("observe 事件时显示场景旁白条", () => {
  const view = buildSessionViewFixture();
  (view as any).narrative = {
    narration: "你仔细查看周围，发现了一些有趣的痕迹。",
    eventKind: "observe",
    npcLine: null,
    choices: null,
    npcDialogues: [],
  };
  render(<LocationSceneScreen view={view} onAction={vi.fn()} onOpenDialogue={vi.fn()} onReturnMap={vi.fn()} busy={false} />);
  expect(screen.getByText("你仔细查看周围，发现了一些有趣的痕迹。")).toBeInTheDocument();
});

it("无 narrative 时不显示场景旁白条", () => {
  const view = buildSessionViewFixture();
  render(<LocationSceneScreen view={view} onAction={vi.fn()} onOpenDialogue={vi.fn()} onReturnMap={vi.fn()} busy={false} />);
  expect(screen.queryByRole("status")).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/LocationSceneScreen.test.tsx -t "observe 事件时显示场景旁白条"`
Expected: FAIL — 旁白文本未渲染

- [ ] **Step 3: Modify the component**

在 `LocationSceneScreen.tsx` 中：

1. 在文件顶部导入 `SceneNarrationBar`：

```tsx
import { SceneNarrationBar } from "./SceneNarrationBar";
```

2. 在组件函数体内（`const scene = view.locationScene;` 之后），添加旁白判断逻辑：

```tsx
const LIGHTWEIGHT_EVENT_KINDS = new Set(["observe", "investigate", "item"]);
const sceneNarration = view.narrative !== null
  && view.narrative.eventKind !== undefined
  && LIGHTWEIGHT_EVENT_KINDS.has(view.narrative.eventKind)
  ? view.narrative.narration
  : "";
const [narrationDismissed, setNarrationDismissed] = useState(false);
const showSceneNarration = sceneNarration !== "" && !narrationDismissed;
```

3. 在 JSX 中，`location-scene-caption` 下方、`scene-hotspot-layer` 上方插入：

```tsx
{showSceneNarration ? (
  <SceneNarrationBar
    narration={sceneNarration}
    onDismiss={() => setNarrationDismissed(true)}
  />
) : null}
```

4. 当 `sceneNarration` 变化时重置 dismissed 状态：

```tsx
useEffect(() => {
  setNarrationDismissed(false);
}, [sceneNarration]);
```

5. 在导入区添加 `useEffect, useState`：

```tsx
import { useEffect, useState } from "react";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/LocationSceneScreen.test.tsx`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/LocationSceneScreen.tsx src/components/LocationSceneScreen.test.tsx
git commit -m "feat: LocationSceneScreen 集成 SceneNarrationBar——轻量事件旁白条"
```

---

### Task 10: AdventureGameShell 删除"剧情事件"弹层并集成新组件

**Files:**
- Modify: `src/components/AdventureGameShell.tsx`
- Test: `src/components/AdventureGameShell.test.tsx`

**Interfaces:**
- Consumes: Task 6 `SceneNarrationBar`（经 LocationSceneScreen）、Task 7 `TravelNarrationScreen`、Task 4 `preparingNextScene`
- Produces: 删除 `showNarrativeEvent` / `dismissedNarrativeEvent` 逻辑；`NarrativeGenerationModal` 条件调整为 `narrativePending && view.narrative === null`；旅行事件渲染 `TravelNarrationScreen`；`activeDialogue` 条件修正

- [ ] **Step 1: Write the failing test**

在 `AdventureGameShell.test.tsx` 追加：

```typescript
it("travel 事件渲染 TravelNarrationScreen 而非剧情事件弹层", () => {
  vi.stubGlobal("fetch", vi.fn());
  const base = buildSessionViewFixture();
  const travelView = {
    ...base,
    narrative: {
      narration: "你沿着官道前行，远处城楼的轮廓逐渐清晰。",
      eventKind: "travel",
      npcLine: null,
      choices: null,
      npcDialogues: [],
    },
    narrativeGeneration: { status: "ready" as const },
  };
  renderShell({ view: travelView });
  expect(screen.getByRole("dialog", { name: "旅行旁白" })).toBeInTheDocument();
  expect(screen.queryByText("剧情事件")).toBeNull();
});

it("followup 播放 + pending 时不显示 NarrativeGenerationModal", () => {
  vi.stubGlobal("fetch", vi.fn());
  const base = buildSessionViewFixture();
  const followupPendingView = {
    ...base,
    narrative: {
      narration: "陆掌柜沉吟片刻。",
      eventKind: "dialogue",
      npcLine: { text: "此事说来话长。", emotion: "neutral" },
      choices: null,
      npcDialogues: [{ npcId: "npc_lu", npcName: "陆掌柜", npcRole: "客栈掌柜", speechPages: ["此事说来话长。"] }],
    },
    narrativeGeneration: { status: "pending" as const },
  };
  renderShell({ view: followupPendingView });
  expect(screen.queryByRole("dialog", { name: "正在准备场景" })).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/AdventureGameShell.test.tsx -t "travel 事件渲染 TravelNarrationScreen"`
Expected: FAIL — TravelNarrationScreen 未渲染

- [ ] **Step 3: Remove the "剧情事件" overlay logic**

在 `AdventureGameShell.tsx` 中：

1. 删除以下变量和状态：
   - `dismissedNarrativeEvent` 状态（第 89 行）
   - `atomicWorldEventReady` 变量（第 100-102 行）
   - `narrativeEventKey` 变量（第 103-105 行）
   - `showNarrativeEvent` 变量（第 107 行）

2. 修正 `activeDialogue`（第 108 行）：
```tsx
const activeDialogue = (narrativePending && view.narrative === null) || (view.narrative !== null && view.narrative.eventKind !== undefined && view.narrative.eventKind !== "dialogue")
  ? null
  : selectedDialogue;
```

3. 删除 `showNarrativeEvent && view.narrative !== null` 的 `AdventureOverlay` + `NarrativeScenePanel` 整段 JSX（第 317-326 行）

- [ ] **Step 4: Adjust NarrativeGenerationModal condition**

修改 `NarrativeGenerationModal` 的渲染条件（第 339-344 行）：

```tsx
{narrativePending && view.narrative === null && view.battle === null && view.ending === null ? (
  <NarrativeGenerationModal
    progress={view.narrativeGeneration?.progress}
    unavailable={narrativeGenerationUnavailable}
  />
) : null}
```

- [ ] **Step 5: Add TravelNarrationScreen rendering**

在 `AdventureGameShell.tsx` 顶部导入：

```tsx
import { TravelNarrationScreen } from "./TravelNarrationScreen";
```

在场景渲染区域（`screen === "scene"` 分支内，`LocationSceneScreen` 之前），添加旅行事件判断：

```tsx
// 在 screen !== "map" && screen !== "town" 的分支内
const isTravelEvent = view.narrative !== null
  && view.narrative.eventKind === "travel"
  && view.battle === null
  && view.ending === null;

// 渲染逻辑
{isTravelEvent ? (
  <TravelNarrationScreen
    narration={view.narrative!.narration}
    onComplete={() => setScreen("scene")}
  />
) : (
  <LocationSceneScreen ... />
)}
```

- [ ] **Step 6: Remove unused import**

如果 `NarrativeScenePanel` 不再被 `AdventureGameShell` 引用，删除其导入。

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run src/components/AdventureGameShell.test.tsx`
Expected: 全部 PASS（如有因删除"剧情事件"弹层导致的现有测试失败，更新断言：原来测试"剧情事件"弹层出现的用例改为测试 TravelNarrationScreen 或 SceneNarrationBar）

- [ ] **Step 8: Commit**

```bash
git add src/components/AdventureGameShell.tsx src/components/AdventureGameShell.test.tsx
git commit -m "feat: 删除剧情事件弹层——集成 TravelNarrationScreen + 调整模态条件 + 修正 activeDialogue"
```

---

### Task 11: 全量回归验收

**Files:**
- All previously modified files

- [ ] **Step 1: Run lint**

Run: `npm run lint`
Expected: 无错误

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: 全部通过（如有预存 fixture 失败，确认与本次变更无关）

- [ ] **Step 4: Run build**

Run: `npm run build`
Expected: 成功

- [ ] **Step 5: Fix any remaining issues**

如果上述任何步骤失败，定位并修复。对于因类型变更（`choices` 可空、`preparingNextScene` 新字段）导致的编译/测试错误，在对应文件中补充空值检查或默认值。

- [ ] **Step 6: Commit any fixes**

```bash
git add -A
git commit -m "fix: 全量回归修复——类型适配与测试断言更新"
```

---

## Self-Review Checklist

### Spec coverage

| Spec 条目 | 对应 Task |
|-----------|-----------|
| §1.1 轻量事件 SceneNarrationBar | Task 6 + Task 9 |
| §1.1 放宽 atomicEventActive 抑制 | Task 5 |
| §1.2 旅行事件 TravelNarrationScreen | Task 7 + Task 10 |
| §1.3 战斗事件不变 | 无需 Task（不变） |
| §2.1 移除 !dialogueFollowupConsumed | Task 2 |
| §2.2 保留 followup currentScene | Task 2 |
| §2.3 修正 projectNarrativeGenerationView | Task 1 |
| §2.4 调整模态显示条件 | Task 10 |
| §2.5 对话面板"准备中"指示 | Task 4 + Task 8 |
| §3 删除"剧情事件"弹层 | Task 10 |
| §3 修正 activeDialogue 条件 | Task 10 |
| §4.1 eventKind 已存在 | 无需 Task（已实现） |
| §4.2 choices 改为可空 | Task 3 |

### Placeholder scan

- 无 "TBD"、"TODO"、"implement later"
- 所有代码块包含完整实现
- 所有测试包含实际断言

### Type consistency

- `NarrativeSceneView.choices`: `readonly { label: string; choiceToken: string }[] | null` — Task 3 定义，Task 9/10 消费
- `NpcDialogueView.preparingNextScene`: `boolean` — Task 4 定义，Task 8 消费
- `SceneNarrationBar` props: `{ narration: string; onDismiss: () => void }` — Task 6 定义，Task 9 消费
- `TravelNarrationScreen` props: `{ narration: string; onComplete: () => void }` — Task 7 定义，Task 10 消费
