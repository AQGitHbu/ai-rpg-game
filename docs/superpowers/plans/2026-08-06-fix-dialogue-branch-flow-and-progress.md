# Fix Dialogue Branch Flow and Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修正角色阶段进度语义，并让 NPC 对话选项使用玩家口吻、在首个对白场景中预生成两条回应分支，选择后立即显示连贯的下一句对白，再由下一次选择触发后续原子事件生成。

**Architecture:** 将“阶段完成”从每次 provider 成功响应改为每个 director/writer/npc 阶段最多计数一次；重试只更新当前角色和 attempt。为 dialogue scene 增加服务端持久化的两条预生成 follow-up，客户端不暴露未选分支，选择时由 application 直接把选中分支转为新的 dialogue scene，不再把对白回应误送进世界 action / pending 生成路径；该 follow-up scene 的下一次对白选择才重新进入三角色原子事件生成。

**Tech Stack:** TypeScript, React 19, Vitest, SQLite CAS repository, existing runtime narrative sources.

## Global Constraints

- 规则层仍负责正式状态与行动裁决，预生成对白分支只保存展示文本与安全 hint，不直接修改任务、物品、战斗或事实状态。
- 客户端只提交 `choiceToken + revision`；不暴露 `dialogueFollowups`、actionKey、fact ID 或 provider diagnostics。
- dialogue scene 的两个选项固定为玩家口吻：“请问一下目前状况是怎么样的？”、“是否可以告诉我事情的缘由？”。
- 旧存档缺少 `dialogueFollowups` 时继续走原有 pending 生成兼容路径。
- 不修改 foundation/shared package；不改变世界事件（observe/investigate/item/battle）的合法 action 路由。

---

### Task 1: Correct role-stage progress and fixed player dialogue labels

**Files:**
- Modify: `src/game/application/runtimeNarrative.ts`
- Modify: `src/game/application/orchestrateNarrativeScene.ts`
- Modify: `src/game/application/server/ai/liveRuntimeNarrativeSources.ts` only if source fallback labels are exposed before orchestration normalization
- Modify: `src/components/NarrativeGenerationModal.tsx`
- Test: `src/game/application/orchestrateNarrativeScene.test.ts`
- Test: `src/components/AdventureGameShell.test.tsx`

**Interfaces:**
- `NarrativeGenerationProgress.completedCalls` counts distinct approved role stages, not successful retry responses.
- `NarrativeSceneState.choices` for `event.kind === "dialogue"` always use the two fixed player-facing labels while retaining stable `dialogueIntent` values.

- [ ] **Step 1: Add failing assertions for retry progress and player-voice labels.**

```ts
expect(progress.some((item) => item.currentRole === "director" && item.attempt === 3 && item.completedCalls === 2)).toBe(false);
expect(dialogueScene.choices.map((choice) => choice.label)).toEqual([
  "请问一下目前状况是怎么样的？",
  "是否可以告诉我事情的缘由？",
]);
```

- [ ] **Step 2: Run the focused tests and confirm the old counter/labels fail.**

Run: `npx vitest run src/game/application/orchestrateNarrativeScene.test.ts src/components/AdventureGameShell.test.tsx`

- [ ] **Step 3: Count each role at most once and normalize dialogue labels.**

Use a `Set<NarrativeRoleStage>` in `orchestrateNarrativeScene`; only an approved stage adds to the set. Keep `currentRole` and `attempt` updated before each request. Normalize dialogue choice labels after approval so generated and fallback scenes share the same copy.

- [ ] **Step 4: Render and test the corrected progress copy.**

Keep the UI count as `completedCalls / 3`; show the current attempt separately, so `0 / 3，当前导演第3次尝试` is valid while a director retry is still unresolved.

- [ ] **Step 5: Run focused tests and typecheck.**

Run: `npx vitest run src/game/application/orchestrateNarrativeScene.test.ts src/components/AdventureGameShell.test.tsx && npm run typecheck`

### Task 2: Add pre-generated dialogue follow-ups to the narrative scene contract

**Files:**
- Modify: `src/game/domain/narrative.ts`
- Modify: `src/game/application/orchestrateNarrativeScene.ts`
- Modify: `src/game/application/gameSessionView.ts`
- Modify: `src/game/application/locationAdventureView.ts`
- Modify: `src/game/application/index.ts` only if new public view types need facade exports
- Modify: `src/components/NpcDialoguePanel.tsx`
- Test: `src/game/application/orchestrateNarrativeScene.test.ts`
- Test: `src/game/application/locationAdventureView.test.ts`
- Test: `src/components/NpcDialoguePanel.test.tsx`

**Interfaces:**
- Add internal `NarrativeDialogueFollowupState = { dialogueIntent, narration, npcLine, nextEventHint? }`.
- Add optional `dialogueFollowups: readonly [NarrativeDialogueFollowupState, NarrativeDialogueFollowupState]` and optional safe `nextEventHint` to `NarrativeSceneState`.
- `projectNarrativeSceneView` must not expose `dialogueFollowups`; it may expose only the selected branch’s `nextEventHint` through the safe location/NPC view.

- [ ] **Step 1: Write failing tests proving a dialogue scene stores two follow-ups and projects no hidden branch payload.**

Assert the application result contains two server-side follow-ups, while `GameSessionView.narrative` contains narration, NPC line, choices, and optional selected hint only—not `dialogueFollowups`.

- [ ] **Step 2: Implement the optional domain shape with old-save compatibility.**

Use optional fields and keep all existing scene fixtures valid without changes. Follow-up NPC lines must use the focus NPC and already allowed/discovered fact IDs.

- [ ] **Step 3: Build the two follow-ups during dialogue scene assembly.**

Generate them before the scene is persisted, using the approved dialogue intents, focus NPC, current approved NPC line/context, deterministic narration, and a safe next-event hint derived only from already legal action labels. Do not add any rule event or future hidden ID to the public read model.

- [ ] **Step 4: Project the selected scene hint into the NPC dialogue UI.**

Add an optional `nextEventHint` to `NpcDialogueView` and render it as a status paragraph only when present. Ensure non-dialogue events still use the existing `NarrativeScenePanel` and world-action labels.

- [ ] **Step 5: Run the focused orchestration, location, and component tests.**

Run: `npx vitest run src/game/application/orchestrateNarrativeScene.test.ts src/game/application/locationAdventureView.test.ts src/components/NpcDialoguePanel.test.tsx`

### Task 3: Consume a pre-generated branch before queueing the next atomic event

**Files:**
- Modify: `src/game/application/performAction.ts`
- Modify: `src/game/application/locationAdventureView.ts` if the branch needs a focused NPC projection adjustment
- Modify: `src/game/application/gameSessionView.ts`
- Modify: `src/components/AdventureGameShell.tsx` only if branch scene rendering needs a distinct state guard
- Test: `src/game/application/performAction.test.ts`
- Test: `src/game/application/phase14ProgressiveGenerationRegression.test.ts`
- Test: `src/components/AdventureGameShell.test.tsx`

**Interfaces:**
- A dialogue response with a matching `scene.dialogueFollowups` entry commits the existing `narrative_dialogue_choice` event and sets `currentScene` to the selected pre-generated dialogue scene with `generation: idle`.
- A dialogue response without a matching follow-up (including old saves and the next choice in the follow-up scene) preserves the existing pending `dialogue_response` flow.
- The selected follow-up uses two fixed player dialogue choices and no unrelated world-event overlay or world hotspots.

- [ ] **Step 1: Add a failing performAction test for an immediate branch transition.**

Given a ready dialogue scene with two follow-ups, submit the first `narrative_choice` and assert: one CAS write, `narrative_dialogue_choice` appended, `currentScene.event.kind === "dialogue"`, selected NPC reply present, `generation.status === "idle"`, and no pending generation.

- [ ] **Step 2: Add the compatibility test for a scene without follow-ups.**

Assert the existing old behavior remains: the choice clears the scene, writes the dialogue event, and queues `generation.status === "pending"` with `playerNpcChat`.

- [ ] **Step 3: Implement branch selection before the generic pending queue.**

Match by `dialogueIntent`, create a new opaque scene ID/token set, preserve only safe branch data, and set a local `dialogueFollowupConsumed` flag so the later generic queue block does not overwrite the selected ready scene.

- [ ] **Step 4: Ensure the follow-up’s next choice queues a new atomic scene.**

Do not attach follow-ups recursively to the selected scene. Its next fixed dialogue choice must take the existing pending path, allowing the director to choose a subsequent dialogue, investigation, item, battle, travel, or observe event.

- [ ] **Step 5: Run application and component regression tests.**

Run: `npx vitest run src/game/application/performAction.test.ts src/game/application/phase14ProgressiveGenerationRegression.test.ts src/components/AdventureGameShell.test.tsx`

### Task 4: Update dialogue documentation and execute validation gates

**Files:**
- Modify: `docs/agent/NPC对话驱动叙事场景触发.md`
- Modify: `docs/agent/运行时AI导演与场景表演.md`
- Modify: `docs/agent/地图与地点冒险.md`
- Modify: `docs/Agent文档索引.md`

- [ ] **Step 1: Document distinct-stage progress semantics and fixed player wording.**
- [ ] **Step 2: Document pre-generated dialogue follow-ups, selected-branch immediate rendering, and next-choice generation boundary.**
- [ ] **Step 3: Run `npm run lint`, `npm run typecheck`, `npm run test:fast`, focused tests, and `npm run build`.**
- [ ] **Step 4: Record unrelated existing full-suite failures separately; do not broaden this change into Phase 4 fixture repair.**
