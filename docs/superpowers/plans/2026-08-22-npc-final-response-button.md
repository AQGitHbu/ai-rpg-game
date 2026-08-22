# NPC 最后一句玩家回答按钮 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 NPC 对话交接场景中的最后一句玩家回答从静态文本改为唯一的可点击按钮，点击后关闭对话弹窗且不提交任何游戏行动。

**Architecture:** 继续沿用现有 `LocationSceneScreen` 的纯 UI 交互边界。`handoffPlayerResponse` 仍由当前权威旅行选项生成并作为展示文本传入 `NpcDialogueModal`；模态框在“非焦点 NPC + 无正式 choices + 有交接回答”分支中把它投影到现有对话选项容器内，点击只调用 `onClose`。

**Tech Stack:** React 19、TypeScript、Vitest、Testing Library、现有 RPG CSS contracts。

**Spec:** `docs/agent/NPC对话驱动叙事场景触发.md`

## Global Constraints

- 交接离开当前建筑/地点时，旧焦点对话框和旧行动栏一起关闭；旧 NPC 不能继续伪装成新主线。
- 闲聊/关闭动作是只读展示、零回合、零写入，不提交 `/api/game/actions`。
- UI 只消费服务端下发的 opaque token 和展示文案，不生成或解析 action key/token。
- 本次只修复交接终态展示，不改变旅行 token 的权威来源和提交路径。

---

### Task 1: Add regression coverage for the final response button

**Files:**
- Modify: `src/components/AdventureGameShell.test.tsx:284-325`

**Interfaces:**
- Consumes: existing handoff `GameSessionView` fixture with a non-focus NPC, empty dialogue choices, and one travel scene choice whose label is the player's final response.
- Produces: a regression assertion that the response is a button and clicking it closes the dialog without calling `onSubmit`.

- [ ] **Step 1: Change the existing handoff test to require a button**

Use the existing `playerResponse`, `handoffView`, `LocationSceneScreen`, and `within` imports. Replace the old assertion that only checked text and absence of “知道了” with:

```tsx
const responseButton = within(dialogue).getByRole("button", { name: playerResponse });
expect(responseButton).toBeInTheDocument();
expect(within(dialogue).getAllByRole("button")).toHaveLength(2);
```

The two buttons are the close icon and the single response option; the handoff response must be represented as a real option, not only a paragraph.

- [ ] **Step 2: Add the close behavior assertion**

Capture the existing submit mock and click the response option:

```tsx
const onSubmit = vi.fn();
render(<LocationSceneScreen view={handoffView} busy={false} onSubmit={onSubmit} onReturnMap={vi.fn()} />);
const dialogue = screen.getByRole("dialog", { name: "与陈半仙对话" });
await userEvent.click(within(dialogue).getByRole("button", { name: playerResponse }));
expect(screen.queryByRole("dialog", { name: "与陈半仙对话" })).not.toBeInTheDocument();
expect(onSubmit).not.toHaveBeenCalled();
```

Keep the existing assertions that the action rail is absent, so the test still proves the final response is the only gameplay-facing option.

- [ ] **Step 3: Run the focused test and verify it fails**

Run: `npm test -- --run src/components/AdventureGameShell.test.tsx -t "shows the handoff travel choice"`

Expected: FAIL because the current implementation renders the response in `.npc-dialogue-speech-text--player` and does not render a response button.

### Task 2: Render the handoff response as a close-only button

**Files:**
- Modify: `src/components/LocationSceneScreen.tsx:275-368`

**Interfaces:**
- Consumes: `playerResponse?: string | null` and `onClose` already passed to `NpcDialogueModal` by `LocationSceneScreen`.
- Produces: a non-submitting button labeled with the normalized final response, rendered only when the non-focus dialogue has no choices and `playerResponse` is present.

- [ ] **Step 1: Keep the response in the speech panel as context**

Retain the existing player response paragraph so the screenshot-style dialogue transcript still shows what the player says:

```tsx
{playerResponse !== null && playerResponse !== undefined ? (
  <p className="npc-dialogue-speech-text npc-dialogue-speech-text--player">
    {normalizeDisplayText(playerResponse)}
  </p>
) : null}
```

- [ ] **Step 2: Add the response as the sole selectable option**

In the non-focus branch, preserve existing `dialogue.choices` behavior first. When there are no choices and `playerResponse` is present, render one button in the existing `.npc-dialogue-choices` group:

```tsx
) : playerResponse !== null && playerResponse !== undefined ? (
  <div className="npc-dialogue-choices" role="group" aria-label="对话选项">
    <button
      type="button"
      className="npc-dialogue-talk-cta"
      onClick={onClose}
    >
      {normalizeDisplayText(playerResponse)}
    </button>
  </div>
) : (
```

The button must not call `onSubmit`, must not carry a choice token, and must use the existing choice styles. The final fallback remains the zero-turn “知道了” button for ordinary idle dialogue.

- [ ] **Step 3: Run the focused test and verify it passes**

Run: `npm test -- --run src/components/AdventureGameShell.test.tsx -t "shows the handoff travel choice"`

Expected: PASS; clicking the player response closes the modal and produces no action request.

### Task 3: Run proportional validation and inspect the diff

**Files:**
- Test: `src/components/AdventureGameShell.test.tsx`
- Modify: `src/components/LocationSceneScreen.tsx`

- [ ] **Step 1: Run component tests**

Run: `npm run test:components`

Expected: PASS, including idle NPC dismissal, ordinary focus dialogue, and handoff response behavior.

- [ ] **Step 2: Run project minimum gates**

Run: `npm run typecheck && npm run test:boundaries`

Expected: PASS with no new boundary or type errors.

- [ ] **Step 3: Inspect the final diff and worktree**

Run: `git diff --check && git diff -- src/components/LocationSceneScreen.tsx src/components/AdventureGameShell.test.tsx && git status --short`

Expected: only the planned component/test changes plus this plan document are present; no token or action submission logic changes.

### Task 4: Commit the completed fix

**Files:**
- Add: `docs/superpowers/plans/2026-08-22-npc-final-response-button.md`
- Modify: `src/components/LocationSceneScreen.tsx`
- Modify: `src/components/AdventureGameShell.test.tsx`

- [ ] **Step 1: Create the commit**

Run:

```bash
git add docs/superpowers/plans/2026-08-22-npc-final-response-button.md src/components/LocationSceneScreen.tsx src/components/AdventureGameShell.test.tsx
git commit -m "fix: render NPC handoff response as close button"
```

Expected: one commit on `codex/npc-final-response-button` containing the regression test, UI fix, and implementation plan.
