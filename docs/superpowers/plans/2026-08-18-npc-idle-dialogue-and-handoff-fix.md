# NPC 对话交接与闲聊模式修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 彻底解决 NPC 对话引出下一幕（如调查酒楼后巷车轮印）后，NPC 仍然出现“与 NPC 交谈”按钮并误触发新 AI 对话分支的 Bug，将已交接/非目标 NPC 的交互转为轻量级、零 API 开销的本地闲聊/提醒模式。

**Architecture:** 
1. **读模型解耦 (`gameSessionView.ts`)**：当主线目标不再是与该 NPC 交谈时（如已交接为调查、移动、战斗），NPC 标记为非焦点且 `choices: []`，不再强制下发触发完整回合的 `fallbackTalkChoice` (`dialogueAct: "ask"`)。
2. **UI 闲聊与提醒模式 (`LocationSceneScreen.tsx`)**：对话弹窗检测到无焦点选项时，展示预生成的直接台词或提醒台词，并提供显式的“知道了 / 离开”关闭按钮，不提交任何 API 请求。
3. **场景预生成支持 (`deterministicSceneSource.ts` / `npcSpeech.ts`)**：在交接与场景生成时，为在场 NPC 准备符合人设与当前进度的待机/提醒台词。

**Tech Stack:** TypeScript, React, Next.js, Vitest, Testing Library.

## Global Constraints

- 保持单一架构：所有规则修改与状态保持纯函数确定性。
- 零额外 API 调用：非目标 NPC 的闲聊完全消费已由主线场景或规则模板预生成的数据，不得在点击时创建 `PendingNarrativeJob`。
- 测试必须全部通过：确保所有 `pnpm test` 保持绿色。

---

### Task 1: 修复 `gameSessionView.ts` 中已交接/非目标 NPC 的对话选择投影

**Files:**
- Modify: `src/game/application/gameSessionView.ts`
- Test: `src/game/application/gameSessionView.test.ts`

**Interfaces:**
- `projectGameSessionView(worldState, storyState, revision, endingSessionIdentity): GameSessionView`
- `NpcDialogueView`: 当 `isFocus === false` 且当前主线目标不是与该 NPC 交谈时，`choices` 数组应为空 `[]`，`freeInputEnabled` 为 `false`。

- [ ] **Step 1: 编写失败测试**

在 `src/game/application/gameSessionView.test.ts` 中添加测试用例：
```typescript
it("does not provide ask choices or free input for handed-off non-focus NPCs after objective transitions to investigation", () => {
  const worldState = createTestWorldState({
    currentLocationId: asLocationId("loc_tavern"),
    npcs: [createTestNpc({ id: asNpcId("npc_lao_zhou"), name: "老周", role: "茶摊老板", locationId: asLocationId("loc_tavern"), met: true })],
    worldFacts: [{ factId: "fact_tracks", locationId: asLocationId("loc_tavern"), text: "车轮印", discovered: false, investigationLabel: "车轮印" }],
    quests: [{
      id: asQuestId("quest_main"),
      name: "主线",
      description: "",
      kind: "main",
      status: "active",
      objectives: [
        { kind: "talk_to_npc", npcId: asNpcId("npc_lao_zhou") },
        { kind: "discover_fact", factId: "fact_tracks" },
      ],
    }],
  });
  const storyState = createTestStoryState({
    turnNumber: 3,
    narrative: {
      mode: "online",
      currentScene: {
        sceneId: asSceneId("scene_handoff"),
        event: { kind: "observe" },
        npcLine: { npcId: asNpcId("npc_lao_zhou"), text: "接下来去查明车轮印。", emotion: "neutral" },
        choices: [],
      },
      dialogueSession: { npcId: asNpcId("npc_lao_zhou"), turnCount: 2, requiredTurns: 2, completed: true },
    },
  });

  const view = projectGameSessionView(worldState, storyState, 1, "test_session");
  const laoZhouDialogue = view.narrative.npcDialogues.find((d) => d.name === "老周");
  expect(laoZhouDialogue).toBeDefined();
  expect(laoZhouDialogue?.choices).toEqual([]);
  expect(laoZhouDialogue?.freeInputEnabled).toBe(false);
  expect(laoZhouDialogue?.speechPages.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: 运行测试并确认失败**

运行：`pnpm vitest run src/game/application/gameSessionView.test.ts`
预期：失败（当前 `choices` 包含 `fallbackTalkChoice`）。

- [ ] **Step 3: 修改 `gameSessionView.ts`**

调整 `npcDialogues` 映射逻辑：
当 NPC 不是焦点 NPC 时（`!isFocus`），不再强制返回 `[fallbackTalkChoice]`，而是返回 `[]`，使非焦点 NPC 处于只读闲聊/提醒展示态。

- [ ] **Step 4: 运行测试并确认通过**

运行：`pnpm vitest run src/game/application/gameSessionView.test.ts`
预期：PASS。

- [ ] **Step 5: 提交更改**

```bash
git add src/game/application/gameSessionView.ts src/game/application/gameSessionView.test.ts
git commit -m "fix(narrative): prevent handed-off npc from projecting actionable ask choices"
```

---

### Task 2: 优化 `LocationSceneScreen.tsx` 对话弹窗的闲聊与提醒展示

**Files:**
- Modify: `src/components/LocationSceneScreen.tsx`
- Test: `src/components/AdventureGameShell.test.tsx`

**Interfaces:**
- `NpcDialogueModal`: 当 `dialogue.choices.length === 0` 且 `!dialogue.freeInputEnabled` 时，渲染 NPC 的 `speechPages` 以及一个友好的“知道了 / 离开”按钮（点击调用 `onClose`）。

- [ ] **Step 1: 编写或更新 UI 测试**

在 `src/components/AdventureGameShell.test.tsx` 中添加测试：
```typescript
it("renders idle reminder dialogue for handed-off NPC with a close button and no action submission", async () => {
  const view = buildView({
    narrative: {
      ...buildView().narrative,
      npcDialogues: [{
        npcId: "npc_lao_zhou",
        name: "老周",
        role: "茶摊老板",
        speechPages: ["接下来查明车轮印，不要只凭传闻判断。"],
        choices: [],
        freeInputEnabled: false,
        giveChoices: [],
      }],
    },
  });

  const onSubmit = vi.fn();
  render(<AdventureGameShell initialView={view} onRequestAction={onSubmit} />);

  // 点击老周打开闲聊弹窗
  const npcCard = screen.getByText("老周");
  fireEvent.click(npcCard);

  expect(screen.getByText("接下来查明车轮印，不要只凭传闻判断。")).toBeInTheDocument();
  // 不存在“与老周交谈”这个可提交的回合按钮
  expect(screen.queryByRole("button", { name: "与老周交谈" })).not.toBeInTheDocument();

  // 存在“知道了”关闭按钮
  const closeBtn = screen.getByRole("button", { name: /知道了|关闭/i });
  fireEvent.click(closeBtn);

  // 确认没有向后端发送回合
  expect(onSubmit).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: 运行测试并确认失败**

运行：`pnpm vitest run src/components/AdventureGameShell.test.tsx`

- [ ] **Step 3: 修改 `LocationSceneScreen.tsx`**

在 `NpcDialogueModal` 中：
当 `!hasFocusInteraction` 且 `dialogue.choices.length === 0` 时：
渲染：
```tsx
<div className="npc-dialogue-choices" role="group" aria-label="对话操作">
  <button
    type="button"
    className="npc-dialogue-dismiss-btn"
    onClick={onClose}
  >
    知道了
  </button>
</div>
```

- [ ] **Step 4: 运行测试并确认通过**

运行：`pnpm vitest run src/components/AdventureGameShell.test.tsx`
预期：PASS。

- [ ] **Step 5: 提交更改**

```bash
git add src/components/LocationSceneScreen.tsx src/components/AdventureGameShell.test.tsx
git commit -m "feat(ui): add dismiss button for ambient and reminder npc dialogues"
```

---

### Task 3: 优化场景生成中的 NPC 待机/提醒台词与降级逻辑

**Files:**
- Modify: `src/game/domain/npcSpeech.ts`
- Modify: `src/game/application/deterministicSceneSource.ts`
- Test: `src/game/domain/npcSpeech.test.ts`
- Test: `src/game/application/deterministicSceneSource.test.ts`

**Interfaces:**
- `composeDirectNpcGreeting(role?: string, name?: string, currentObjectiveLabel?: string): string`

- [ ] **Step 1: 编写失败测试**

测试在有当前主线目标时，已交接 NPC 的待机台词能结合当前主线进行友好提醒（例如：“去调查车轮印要紧……”）。

- [ ] **Step 2: 运行测试并确认失败**

- [ ] **Step 3: 完善台词生成逻辑**

- [ ] **Step 4: 运行测试并确认通过**

- [ ] **Step 5: 提交更改**

```bash
git add src/game/domain/npcSpeech.ts src/game/application/deterministicSceneSource.ts src/game/domain/npcSpeech.test.ts
git commit -m "feat(narrative): enrich npc idle and reminder dialogue generation"
```

---

### Task 4: 全量回归测试与文档同步

**Files:**
- Modify: `docs/agent/NPC对话驱动叙事场景触发.md`
- Modify: `docs/agent/闲聊功能实现说明.md`

- [ ] **Step 1: 运行所有测试**

运行：`pnpm test`
确保全部 270+ 测试均正常通过。

- [ ] **Step 2: 更新架构与设计文档**

在 `docs/agent/NPC对话驱动叙事场景触发.md` 中记录非焦点/交接后 NPC 的闲聊与提醒模式设计。

- [ ] **Step 3: 提交更改**

```bash
git add docs/agent/NPC对话驱动叙事场景触发.md docs/agent/闲聊功能实现说明.md
git commit -m "docs: update npc dialogue and idle interaction specifications"
```
