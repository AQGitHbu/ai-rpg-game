# NPC 对话视角与上下文修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 NPC 对话只呈现 NPC 的第一人称直接台词，并让每次回应明确承接玩家当前话语或当前交谈情境，避免描述性前缀和无上下文的“我知道了”。

**Architecture:** 在 domain 增加纯函数统一清理 NPC 台词的叙述性包装，并把无 AI/非法 AI 的 fallback 改为读取当前 pending job、焦点 NPC 关系政策和玩家话语的上下文回应。场景审批与 read model 再做边界归一化，兼容已经写入存档的旧台词；live prompt 同步强化直接台词与上下文要求。

**Tech Stack:** TypeScript, Next.js, React, Vitest, SQLite 持久化的结构化场景链。

## Global Constraints

- 保持 `/api/game/actions` → `performTurn` → `PendingNarrativeJob` → 场景表演 → scene CAS 的单一路径。
- 规则状态、关系、事实披露仍由服务端裁决；NPC 台词只表现已批准上下文。
- 不把玩家原文写入 NPC 长期记忆、事件账本或日志；只在当前 pending 场景中用于直接回应。
- 兼容旧存档：读取场景时也必须去掉已持久化的 NPC 名称/动作描述前缀。

---

### Task 1: 建立 NPC 直接台词的纯函数边界

**Files:**
- Create: `src/game/domain/npcSpeech.ts`
- Create: `src/game/domain/npcSpeech.test.ts`
- Modify: `src/game/domain/narrative.ts`

**Interfaces:**
- Produces `normalizeNpcSpeech(text: string, npcName?: string): string`，去除可识别的“NPC 名称 + 说道/答道/动作 + 冒号 + 引号”包装，返回可直接显示的台词正文。
- Produces `isGenericNpcAcknowledgement(text: string): boolean`，识别没有承接对象的通用确认句，供 live source 回退。

- [ ] **Step 1: Write failing tests**

```ts
expect(normalizeNpcSpeech('邵叔如实答道："我知道了。"', '邵叔')).toBe('我知道了。');
expect(normalizeNpcSpeech('“这件事我会查清楚。”', '邵叔')).toBe('这件事我会查清楚。');
expect(isGenericNpcAcknowledgement('我知道了。')).toBe(true);
expect(isGenericNpcAcknowledgement('关于商队失踪的事，我先说我确定的部分。')).toBe(false);
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm run test:game-domain -- src/game/domain/npcSpeech.test.ts`

Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Implement the minimal pure helper**

Handle quoted direct speech, exact speaker-name prefixes, and recognizable narration-before-colon only when the remainder is quoted; otherwise preserve the text. Keep the generic-acknowledgement set small and deterministic.

- [ ] **Step 4: Wire the existing deterministic no-scene fallback to direct speech**

Change `composeDeterministicNpcLine` to return only a direct greeting, without NPC name, role, gaze, or speech verbs.

- [ ] **Step 5: Run the focused test and verify it passes**

Run: `npm run test:game-domain -- src/game/domain/npcSpeech.test.ts src/game/domain/narrative.test.ts`

Expected: PASS.

---

### Task 2: Make deterministic and live NPC responses contextual

**Files:**
- Modify: `src/game/application/deterministicSceneSource.ts`
- Modify: `src/game/application/server/ai/liveScenePerformanceSource.ts`
- Modify: `src/game/application/deterministicSceneSource.test.ts`
- Modify: `src/game/application/server/ai/liveScenePerformanceSource.test.ts`

**Interfaces:**
- Deterministic fallback consumes `job.utterance`, `focusNpcContext.responsePolicy`, `objectiveTransition`, and the focus NPC name to produce direct first-person replies.
- Live source normalizes AI output and rejects a generic acknowledgement when a contextual response is required, causing the same deterministic fallback to run.

- [ ] **Step 1: Add failing fallback tests**

Cover a neutral NPC with `utterance: "商队失踪的事你知道吗？"`, asserting the line contains a bounded reference to the current question and is not `我知道了`; cover no utterance with a direct invitation to ask; assert hostile/trusted lines remain distinct and contain no narration verbs.

- [ ] **Step 2: Add failing live-source contract tests**

Return `邵叔如实答道："我知道了。"` from the stub transport and assert the proposal falls back. Return `邵叔说道："关于商队失踪的事，我先说我确定的部分。"` and assert the proposal is generated with `text === "关于商队失踪的事，我先说我确定的部分。"`.

- [ ] **Step 3: Implement contextual deterministic replies**

Use the current utterance as a bounded topic reference, never as a long-term memory field. For no utterance, use a situation-appropriate invitation. For each relationship tier, vary both tone and initiative while keeping the text in the NPC’s first-person voice.

- [ ] **Step 4: Normalize and validate live NPC lines**

Apply `normalizeNpcSpeech` before building `ScenePerformanceProposal`; if the normalized line is generic while a `player_utterance` beat exists, return `null` so the source uses deterministic fallback. Update the prompt to require direct first-person speech, no speaker name, no “说道/答道/看着你” narration, and an explicit contextual reference.

- [ ] **Step 5: Run application tests**

Run: `npm run test:game-application -- src/game/application/deterministicSceneSource.test.ts src/game/application/server/ai/liveScenePerformanceSource.test.ts`

Expected: PASS.

---

### Task 3: Sanitize scene approval, read model, and NPC card fallbacks

**Files:**
- Modify: `src/game/application/approveAndWriteScene.ts`
- Modify: `src/game/application/gameSessionView.ts`
- Modify: `src/components/LocationSceneScreen.tsx`
- Modify: `src/game/application/approveAndWriteScene.test.ts`
- Modify: `src/game/application/gameSessionView.test.ts`
- Modify: `src/components/AdventureGameShell.test.tsx`

**Interfaces:**
- Every newly persisted `NarrativeNpcLineState` and `NpcDialogueInScene.speechPages` contains direct speech only.
- Old persisted pages are normalized while projecting `GameSessionView`, so the user’s current save no longer displays the old wrapper.

- [ ] **Step 1: Add failing legacy-read-model tests**

Project a scene containing `邵叔如实答道："我知道了。"` in both `npcLine` and `npcDialogues.speechPages`; assert the focus dialogue shows `我知道了。` and contains neither `如实答道` nor the NPC name prefix.

- [ ] **Step 2: Normalize at approval and persistence boundaries**

Normalize the NPC line before `rebuildNpcLine` and pass the normalized speech to `buildNpcDialoguePages`.

- [ ] **Step 3: Normalize legacy pages during read-model projection**

Normalize supplied focus pages and `scene.npcLine.text` before pagination. Update fallback card text to direct speech without the NPC name/role/action description.

- [ ] **Step 4: Run component/application tests**

Run: `npm run test:game-application -- src/game/application/approveAndWriteScene.test.ts src/game/application/gameSessionView.test.ts && npm run test:components -- src/components/AdventureGameShell.test.tsx`

Expected: PASS.

---

### Task 4: Update implementation docs and run acceptance gates

**Files:**
- Modify: `docs/agent/运行时AI导演与场景表演.md`
- Modify: `docs/agent/NPC对话驱动叙事场景触发.md`
- Modify: `docs/Agent文档索引.md`

- [ ] **Step 1: Document the root cause and invariant**

Record that NPC output is a direct-speech field, deterministic fallback is context-derived, live output is normalized/validated, and read-model projection repairs old persisted wrappers.

- [ ] **Step 2: Run focused and minimum gates**

Run: `npm run test:game-domain -- src/game/domain/npcSpeech.test.ts src/game/domain/narrative.test.ts && npm run test:game-application -- src/game/application/deterministicSceneSource.test.ts src/game/application/server/ai/liveScenePerformanceSource.test.ts src/game/application/approveAndWriteScene.test.ts src/game/application/gameSessionView.test.ts && npm run test:components -- src/components/AdventureGameShell.test.tsx && npm run test:boundaries && npm run typecheck`

Expected: every command exits zero.

- [ ] **Step 3: Review diff and verify no old active production templates remain**

Run: `rg -n '如实答道|坦诚地说|看了你一眼|压低声音聊了几句|客官，有什么事情吗' src/game src/components`

Expected: only tests/compatibility normalization cases or direct quoted speech fixtures remain; active fallback templates contain no descriptive speaker wrapper.

