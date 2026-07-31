# Phase 11 剧情连续性与结构化记忆（内容推进引擎） Implementation Plan

> 状态：待执行

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 由规则事件确定性归约出有界、持久化的剧情记忆和主线节奏，并将最小连续性上下文供给 Phase 10 的 director、writer、NPC 链路。

**Architecture:** domain 声明可选 v1 memory 和场景提交事件，保证旧 JSON 存档零迁移可读；gameplay/rpg/narrative 用无 IO reducer 和 progression 派生器裁决记忆/节奏；application 在现有规则 action 与 pending scene 的单次 CAS 前归约 memory，并把按角色裁剪的卡片投影给 AI。AI 只消费投影、继续经过 approval，绝不写 memory 或规则事实。

**Tech Stack:** TypeScript strict、Next.js、Vitest、SQLite/libsql、既有 @ai-game/ai-transport@0.1.0（不修改 foundation）。

**Spec:** docs/superpowers/specs/2026-07-31-phase-11-story-continuity-structured-memory.md

## Global Constraints

- 工作分支仅创建在 .worktrees/phase11-story-continuity-memory，目标分支 codex/phase11-story-continuity-memory；不要 git checkout 主工作区。
- domain 不 import gameplay/application；gameplay 不 import application/UI/server；UI/API 只经 application facade；新增跨层 import 同步维护 src/dependencyBoundaries.test.ts。
- eventLedger 是事实源。AI 文本、原始响应、prompt、token、actionKey、provider config、密钥不得保存进 StoryMemoryState 或 NarrativeScenePresentedEvent。
- 新旧存档保持 schemaVersion 1、stateVersion 1、GAME_RECORD_VERSION 不变；GameState.storyMemory 必须可选，读取缺失字段不能失败。
- 所有 reducer/projection/approval 纯函数均不读取 IO、Date、process.env 或随机数；时间由 application 注入。
- 每次写入仍只有一次 repository CAS；stale 时丢弃生成结果，禁止部分写入或重新调用 AI。
- 日常测试零网络零计费。真实 journey 只能由 RUN_REAL_AI_JOURNEY=1 的显式 smoke 启动。

## 明确边界

- 只修改 ai-rpg-game；不修改 foundation、共享 UI、共享 transport 或任一 sibling 仓库。
- 不创建运行时蓝图实体，不加入自由输入、关系数值、向量检索、streaming、图片或语音。
- 不让 AI 文案成为世界事实、memory 或持久化关系状态。

---

### Task 1: domain — 版本化记忆、场景提交事件与旧存档读取

**Files:**

- Create: src/game/domain/storyMemory.ts
- Create: src/game/domain/storyMemory.test.ts
- Modify: src/game/domain/events.ts
- Modify: src/game/domain/events.test.ts
- Modify: src/game/domain/gameState.ts
- Modify: src/game/domain/index.ts
- Modify: src/game/gameplay/rpg/scenario/compileScenarioBlueprint.ts
- Modify: src/game/gameplay/rpg/scenario/compileScenarioBlueprint.test.ts

**Interfaces:**

- Produces STORY_MEMORY_VERSION, STORY_MEMORY_RECENT_LIMIT, StoryPacing, StoryMemoryEntry, NpcContinuityMemory, StoryMemoryState, createEmptyStoryMemory(), storyMemoryOf(state).
- Adds optional GameState.storyMemory and NarrativeScenePresentedEvent to GameEvent.

- [ ] **Step 1: Write the failing tests**

~~~ts
it("新局初始化 v1 空 memory，旧 state 缺省时返回同构空 memory", () => {
  const state = initializeGameState(compileValid());
  expect(state.storyMemory).toEqual(createEmptyStoryMemory());
  expect(storyMemoryOf({ ...state, storyMemory: undefined })).toEqual(createEmptyStoryMemory());
});

it("scene 提交事件只允许结构索引，不保存叙事文本或 token", () => {
  const event: GameEvent = {
    type: "narrative_scene_presented", sceneId: "scene-1", locationId: asLocationId("loc_1"),
    focusNpcId: null, revealedFactIds: [], pacing: "develop", occurredAt: "2026-07-31T00:00:00.000Z",
  };
  expect(event.type).toBe("narrative_scene_presented");
});
~~~

- [ ] **Step 2: Run test to verify it fails**

Run: npx vitest run src/game/domain/storyMemory.test.ts src/game/domain/events.test.ts src/game/gameplay/rpg/scenario/compileScenarioBlueprint.test.ts

Expected: FAIL because the module, event discriminator and storyMemory field do not exist.

- [ ] **Step 3: Write minimal implementation**

~~~ts
export const STORY_MEMORY_VERSION = 1 as const;
export const STORY_MEMORY_RECENT_LIMIT = 12 as const;
export function createEmptyStoryMemory(): StoryMemoryState {
  return { version: STORY_MEMORY_VERSION, reducedThroughEventCount: 0, recent: [], npcContacts: [] };
}
export function storyMemoryOf(state: Pick<GameState, "storyMemory">): StoryMemoryState {
  return state.storyMemory ?? createEmptyStoryMemory();
}
~~~

Make StoryMemoryEntry variants exactly match Spec section 4. Add storyMemory: createEmptyStoryMemory() to initializeGameState; do not make SQLite migration changes.

- [ ] **Step 4: Run test to verify it passes**

Run: npx vitest run src/game/domain/storyMemory.test.ts src/game/domain/events.test.ts src/game/gameplay/rpg/scenario/compileScenarioBlueprint.test.ts

Expected: PASS.

- [ ] **Step 5: Commit**

~~~bash
git add src/game/domain src/game/gameplay/rpg/scenario/compileScenarioBlueprint.ts src/game/gameplay/rpg/scenario/compileScenarioBlueprint.test.ts
git commit -m "feat(domain): add versioned structured story memory"
~~~

### Task 2: gameplay — 纯记忆 reducer 和内容推进器

**Files:**

- Create: src/game/gameplay/rpg/narrative/reconcileStoryMemory.ts
- Create: src/game/gameplay/rpg/narrative/reconcileStoryMemory.test.ts
- Create: src/game/gameplay/rpg/narrative/contentProgression.ts
- Create: src/game/gameplay/rpg/narrative/contentProgression.test.ts
- Modify: src/game/gameplay/rpg/narrative/index.ts

**Interfaces:**

- Produces reconcileStoryMemory({ state }): StoryMemoryState and deriveContentProgression({ blueprint, state }): ContentProgression.
- ContentProgression is { mainStage: 1 | 2 | 3 | null; allowedPacing: readonly StoryPacing[]; activeQuestIds: readonly QuestId[] }.

- [ ] **Step 1: Write the failing tests**

~~~ts
it("只归约 cursor 后的事件、有界保留最后 12 条且不变异输入", () => {
  const before = structuredClone(stateWithThirteenEvents);
  const memory = reconcileStoryMemory({ state: stateWithThirteenEvents });
  expect(memory.reducedThroughEventCount).toBe(stateWithThirteenEvents.eventLedger.length);
  expect(memory.recent).toHaveLength(12);
  expect(stateWithThirteenEvents).toEqual(before);
});

it("NPC contact 只更新对应角色的最后接触", () => {
  const memory = reconcileStoryMemory({ state: stateWithNpcAAndNpcBEvents });
  expect(memory.npcContacts).toContainEqual({ npcId: asNpcId("npc_a"), lastContactTurn: 3, lastLocationId: asLocationId("loc_1") });
  expect(memory.npcContacts.find((entry) => entry.npcId === asNpcId("npc_b"))?.lastContactTurn).toBe(5);
});

it.each([[1, ["setup", "develop"]], [2, ["develop", "turn"]], [3, ["climax"]]])(
  "active main stage %i derives required pacing",
  (stage, allowedPacing) => expect(deriveContentProgression({ blueprint, state: stateAtStage(stage) }).allowedPacing).toEqual(allowedPacing),
);
~~~

- [ ] **Step 2: Run test to verify it fails**

Run: npx vitest run src/game/gameplay/rpg/narrative/reconcileStoryMemory.test.ts src/game/gameplay/rpg/narrative/contentProgression.test.ts

Expected: FAIL because the modules are absent.

- [ ] **Step 3: Write minimal implementation**

Use the pending event slice from memory.reducedThroughEventCount. Turn is the zero-based ledger index. Carry recent forward, then call slice(-STORY_MEMORY_RECENT_LIMIT). Unknown events advance only the cursor. For an NPC contact, replace matching npcId or append one; never include fact text.

Implement exact progression fallback:

~~~ts
if (activeMain?.stage === 1) return { mainStage: 1, allowedPacing: ["setup", "develop"], activeQuestIds };
if (activeMain?.stage === 2) return { mainStage: 2, allowedPacing: ["develop", "turn"], activeQuestIds };
if (activeMain?.stage === 3) return { mainStage: 3, allowedPacing: ["climax"], activeQuestIds };
if (hasCompletedMain) return { mainStage: null, allowedPacing: ["resolution"], activeQuestIds };
return { mainStage: null, allowedPacing: ["setup", "develop"], activeQuestIds };
~~~

- [ ] **Step 4: Run tests**

Run: npx vitest run src/game/gameplay/rpg/narrative/reconcileStoryMemory.test.ts src/game/gameplay/rpg/narrative/contentProgression.test.ts src/dependencyBoundaries.test.ts

Expected: PASS.

- [ ] **Step 5: Commit**

~~~bash
git add src/game/gameplay/rpg/narrative
git commit -m "feat(narrative): derive bounded memory and story pacing"
~~~

### Task 3: application — 每次规则 CAS 同步归约 memory

**Files:**

- Modify: src/game/application/performAction.ts
- Modify: src/game/application/performAction.test.ts
- Modify: src/game/application/performActionSqlite.test.ts

**Interfaces:**

- Consumes reconcileStoryMemory({ state }) after action、quest、battle、ending、town transition.
- Produces every successful applyResolvedAction state with an up-to-date storyMemory.

- [ ] **Step 1: Write the failing tests**

~~~ts
it("action、quest reconciliation 与 memory 在同一保存结果中出现", async () => {
  const result = await performAction({ intent: { type: "investigate", factId }, expectedRevision: 0 }, deps);
  expect(result.ok).toBe(true);
  const record = await repository.getCurrentGame();
  if (record.ok && record.status === "active") {
    expect(record.record.state.storyMemory?.recent.at(-1)).toMatchObject({ kind: "fact", factId });
    expect(record.record.state.storyMemory?.reducedThroughEventCount).toBe(record.record.state.eventLedger.length);
  }
});
~~~

Add a stale revision case asserting stored state and prior memory remain unchanged.

- [ ] **Step 2: Run test to verify it fails**

Run: npx vitest run src/game/application/performAction.test.ts src/game/application/performActionSqlite.test.ts

Expected: FAIL because actions do not populate storyMemory.

- [ ] **Step 3: Write minimal implementation**

Immediately before existing Step 5 repository call:

~~~ts
nextState = { ...nextState, storyMemory: reconcileStoryMemory({ state: nextState }) };
~~~

Import only from narrative facade. Keep rejection/pending branches unchanged so rejected actions remain zero-write.

- [ ] **Step 4: Run tests**

Run: npx vitest run src/game/application/performAction.test.ts src/game/application/performActionSqlite.test.ts src/dependencyBoundaries.test.ts

Expected: PASS.

- [ ] **Step 5: Commit**

~~~bash
git add src/game/application/performAction.ts src/game/application/performAction.test.ts src/game/application/performActionSqlite.test.ts
git commit -m "feat(application): persist story memory with rule actions"
~~~

### Task 4: application — 场景提交事件、memory 与 ready scene 的原子保存

**Files:**

- Modify: src/game/application/generatePendingNarrativeScene.ts
- Modify: src/game/application/generatePendingNarrativeScene.test.ts
- Modify: all GeneratePendingNarrativeSceneDependencies fakes to add now: () => string

**Interfaces:**

- Dependency adds now: () => string.
- OrchestrateSceneResult exposes focusNpcId and progression to build the durable event.

- [ ] **Step 1: Write the failing tests**

~~~ts
it("scene、scene-presented event 与 memory 由一条 CAS 同时保存", async () => {
  const result = await generatePendingNarrativeScene({ ...deps, now: () => "2026-07-31T00:00:00.000Z" });
  expect(result).toBe("saved");
  expect(repository.lastApply?.nextState.narrative.currentScene).not.toBeNull();
  expect(repository.lastApply?.nextState.eventLedger.at(-1)).toMatchObject({
    type: "narrative_scene_presented", pacing: "develop",
  });
  expect(repository.lastApply?.nextState.storyMemory?.recent.at(-1)).toMatchObject({ kind: "scene" });
});
~~~

Also test fallback and STALE_GAME_REVISION: one source sequence, no partial write, result stale.

- [ ] **Step 2: Run test to verify it fails**

Run: npx vitest run src/game/application/generatePendingNarrativeScene.test.ts

Expected: FAIL because no event/memory/time dependency exists.

- [ ] **Step 3: Write minimal implementation**

~~~ts
const withScene = { ...record.state, narrative: { currentScene: generated.scene, generation: { status: "idle" }, mode: record.state.narrative.mode } };
const sceneEvent = {
  type: "narrative_scene_presented" as const,
  sceneId: generated.scene.sceneId, locationId: record.state.currentLocationId,
  focusNpcId: generated.focusNpcId, revealedFactIds: generated.scene.usedFactIds,
  pacing: generated.selectedPacing, occurredAt: deps.now(),
};
const withEvent = { ...withScene, eventLedger: [...withScene.eventLedger, sceneEvent] };
const nextState = { ...withEvent, storyMemory: reconcileStoryMemory({ state: withEvent }) };
~~~

selectedPacing must be the approved plan pacing, not a model field. Do not include text, action keys or tokens.

- [ ] **Step 4: Run tests**

Run: npx vitest run src/game/application/generatePendingNarrativeScene.test.ts src/game/application/performAction.test.ts

Expected: PASS.

- [ ] **Step 5: Commit**

~~~bash
git add src/game/application/generatePendingNarrativeScene.ts src/game/application/generatePendingNarrativeScene.test.ts
git commit -m "feat(narrative): atomically record presented scenes and memory"
~~~

### Task 5: narrative approval — 用 progression 约束 director 节奏

**Files:**

- Modify: src/game/gameplay/rpg/narrative/types.ts
- Modify: src/game/gameplay/rpg/narrative/approveDirectorProposal.ts
- Modify: src/game/gameplay/rpg/narrative/approveDirectorProposal.test.ts
- Modify: src/game/application/orchestrateNarrativeScene.ts
- Modify: src/game/application/orchestrateNarrativeScene.test.ts

**Interfaces:**

- Adds continuity_violation to NarrativeApprovalCategory.
- ApproveDirectorProposalInput adds progression: ContentProgression.
- OrchestrateSceneResult adds progression, focusNpcId and selectedPacing.

- [ ] **Step 1: Write the failing tests**

~~~ts
it("rejects a valid director plan whose pacing is outside progression", () => {
  expect(approveDirectorProposal({
    proposal: { ...proposal, pacing: "resolution" }, blueprint, state, candidates, progression: stageOne,
  })).toEqual({ ok: false, category: "continuity_violation" });
});

it("retries only director after continuity rejection, then returns existing fallback", async () => {
  const result = await orchestrateNarrativeScene({ ...input, directorSource: sourceReturningBadPacingThreeTimes });
  expect(result.provenance).toBe("fallback");
});
~~~

- [ ] **Step 2: Run test to verify it fails**

Run: npx vitest run src/game/gameplay/rpg/narrative/approveDirectorProposal.test.ts src/game/application/orchestrateNarrativeScene.test.ts

Expected: FAIL because pacing is not compared to progression.

- [ ] **Step 3: Write minimal implementation**

Derive progression once before director invocation; pass it to approval. After schema checks:

~~~ts
if (!input.progression.allowedPacing.includes(proposal.pacing)) {
  return { ok: false, category: "continuity_violation" };
}
~~~

Return progression and plan.focusNpcId from successful orchestration; fallback returns the same progression, null focus NPC, and its first allowed pacing. Do not change action candidate or fact checks.

- [ ] **Step 4: Run tests**

Run: npx vitest run src/game/gameplay/rpg/narrative/approveDirectorProposal.test.ts src/game/application/orchestrateNarrativeScene.test.ts src/dependencyBoundaries.test.ts

Expected: PASS.

- [ ] **Step 5: Commit**

~~~bash
git add src/game/gameplay/rpg/narrative src/game/application/orchestrateNarrativeScene.ts src/game/application/orchestrateNarrativeScene.test.ts
git commit -m "feat(narrative): enforce progression-aware scene pacing"
~~~

### Task 6: application/server AI — 最小连续性 context、v2 contract 与离线 fixtures

**Files:**

- Modify: src/game/application/runtimeNarrative.ts
- Modify: src/game/application/runtimeNarrativeContexts.ts
- Modify: src/game/application/runtimeNarrativeContexts.test.ts
- Modify: src/game/application/server/ai/liveRuntimeNarrativeSources.ts
- Modify: src/game/application/server/ai/liveRuntimeNarrativeSources.test.ts
- Modify: src/game/application/server/ai/runtimeNarrativeFixtureSource.ts
- Modify: src/game/application/server/ai/runtimeNarrativeFixtureSource.test.ts
- Modify: src/game/application/server/ai/runtimeNarrativeRecording.test.ts

**Interfaces:**

- Bumps NARRATIVE_CONTRACT_VERSION to runtime-narrative-v2.
- Director context adds progression, activeQuestCards, recentContinuity; writer adds progression, recentContinuity; NPC adds ownContinuity only.

- [ ] **Step 1: Write the failing tests**

~~~ts
it("director gets named milestones and active quest cards but no full ledger", () => {
  const context = toDirectorContext({ blueprint, state });
  expect(context.recentContinuity).toContainEqual(expect.objectContaining({ text: expect.stringContaining("青石镇") }));
  expect(JSON.stringify(context)).not.toContain("eventLedger");
});

it("NPC B request excludes NPC A contact and undisclosed fact text", () => {
  const context = toNpcLineContext({ blueprint, state, npcId: "npc_b", speechAct: "warn", allowedFactIds: [] });
  expect(JSON.stringify(context)).not.toContain(npcA.name);
  expect(JSON.stringify(context)).not.toContain(hiddenFact.text);
});
~~~

Also assert fixture diagnostics and replay calls use runtime-narrative-v2.

- [ ] **Step 2: Run test to verify it fails**

Run: npx vitest run src/game/application/runtimeNarrativeContexts.test.ts src/game/application/server/ai/liveRuntimeNarrativeSources.test.ts src/game/application/server/ai/runtimeNarrativeFixtureSource.test.ts src/game/application/server/ai/runtimeNarrativeRecording.test.ts

Expected: FAIL because v1 contexts/fixtures lack continuity fields.

- [ ] **Step 3: Write minimal implementation**

Use private projection helpers. Director cards may resolve active quest name/description and safe milestones; writer uses the last six; NPC receives only the matching contact as lastContactTurn and lastLocationName, plus existing fact cards.

Update role instructions: continuity is history, not authority; do not invent events; director pacing must be from progression.allowedPacing; NPC may only use factCards. Mechanical repair only discards malformed extras. It must never add a fact/event. Keep raw context logging prohibited.

- [ ] **Step 4: Run tests**

Run: npx vitest run src/game/application/runtimeNarrativeContexts.test.ts src/game/application/server/ai/liveRuntimeNarrativeSources.test.ts src/game/application/server/ai/runtimeNarrativeFixtureSource.test.ts src/game/application/server/ai/runtimeNarrativeRecording.test.ts

Expected: PASS.

- [ ] **Step 5: Commit**

~~~bash
git add src/game/application/runtimeNarrative.ts src/game/application/runtimeNarrativeContexts.ts src/game/application/server/ai
git commit -m "feat(ai): add least-privilege continuity contexts"
~~~

### Task 7: read model/UI — 安全的本章进展与日志展示

**Files:**

- Modify: src/game/application/gameSessionView.ts
- Modify: src/game/application/gameSessionView.test.ts
- Modify: src/components/AdventureDetailsPanel.tsx
- Modify: src/components/AdventureDetailsPanel.test.tsx
- Modify: src/components/sessionViewFixture.testutil.ts

**Interfaces:**

- GameSessionView.storyContinuity is { chapterLabel: string; milestones: readonly { text: string }[] }.

- [ ] **Step 1: Write the failing tests**

~~~ts
it("projects at most six safe milestones without IDs or NPC private contacts", () => {
  const view = projectGameSessionView(inputWithMemory);
  expect(view.storyContinuity.milestones).toHaveLength(6);
  expect(JSON.stringify(view.storyContinuity)).not.toContain("npc_1");
});

it("journal renders chapter progress before event log", () => {
  render(<AdventureDetailsPanel view={buildSessionViewFixture()} panel="journal" />);
  expect(screen.getByRole("heading", { name: "本章进展" })).toBeInTheDocument();
});
~~~

- [ ] **Step 2: Run test to verify it fails**

Run: npx vitest run src/game/application/gameSessionView.test.ts src/components/AdventureDetailsPanel.test.tsx

Expected: FAIL because the view has no continuity projection.

- [ ] **Step 3: Write minimal implementation**

Add private projectStoryContinuity: map only storyMemoryOf(state).recent.slice(-6) using known-name vocabulary from projectStoryEvent; map progression to 第一章、第二章、第三章、尾声、故事开端. Return one text entry 故事刚刚开始。when none map. Render a section headed 本章进展 in journal. Do not expose raw IDs, contacts, pacing enum, diagnostics or raw events.

- [ ] **Step 4: Run tests**

Run: npx vitest run src/game/application/gameSessionView.test.ts src/components/AdventureDetailsPanel.test.tsx

Expected: PASS.

- [ ] **Step 5: Commit**

~~~bash
git add src/game/application/gameSessionView.ts src/game/application/gameSessionView.test.ts src/components/AdventureDetailsPanel.tsx src/components/AdventureDetailsPanel.test.tsx src/components/sessionViewFixture.testutil.ts
git commit -m "feat(ui): show safe chapter continuity in journal"
~~~

### Task 8: 离线完整旅程、兼容与边界回归

**Files:**

- Create: src/game/application/testing/phase11StoryContinuityJourney.test.ts
- Create: scripts/phase11Journey.mjs
- Create: scripts/phase11Journey.node-test.mjs
- Create: data/fixtures/phase11-journey/v1/manifest.json
- Modify: package.json
- Modify: src/game/application/testing/runtimeNarrativeJourney.ts only if a Phase 11 report version is required.

**Interfaces:**

- Adds test:phase11-journey, journey:phase11, smoke:ai:phase11-journey. Replay consumes only versioned v2 fixture calls; record remains opt-in.

- [ ] **Step 1: Write the failing fixture journey**

Create a fixture-only journey: game → ready scene → narrative choice → next ready scene; reload after each CAS. Assert:

~~~ts
expect(record.state.storyMemory?.reducedThroughEventCount).toBe(record.state.eventLedger.length);
expect(record.state.eventLedger.some((event) => event.type === "narrative_scene_presented")).toBe(true);
expect(view.storyContinuity.milestones.length).toBeLessThanOrEqual(6);
expect(replay.assertComplete).not.toThrow();
~~~

Add a legacy fixture with storyMemory deleted, a stale result, and a context assertion that NPC B excludes NPC A and hidden facts.

- [ ] **Step 2: Run test to verify it fails**

Run: npx vitest run src/game/application/testing/phase11StoryContinuityJourney.test.ts

Expected: FAIL until v2 fixture data and scripts exist.

- [ ] **Step 3: Implement offline replay tooling**

Copy Phase 10 runner structure but use phase11-journey paths and v2 contract. Default mode uses replay sources and rejects drift. --mode=record first requires RUN_REAL_AI_JOURNEY === "1" and writes parsed candidates/request hashes only. Do not overwrite Phase 10 v1 fixtures.

- [ ] **Step 4: Run tests**

Run: npm run test:phase11-journey && npm run journey:phase11 && npm run test:boundaries

Expected: PASS with no network access.

- [ ] **Step 5: Commit**

~~~bash
git add src/game/application/testing scripts/phase11Journey.mjs scripts/phase11Journey.node-test.mjs data/fixtures/phase11-journey package.json
git commit -m "test: add offline phase11 continuity journey"
~~~

### Task 9: 文档收口与完整验收

**Files:**

- Modify: docs/策划文档/AI生成RPG_MVP.md
- Modify: docs/agent/剧情连续性与结构化记忆.md
- Modify: docs/Agent文档索引.md
- Modify: docs/agent/current-phase.json
- Modify: docs/agent/当前开发阶段.md

- [ ] **Step 1: Update player and implementation facts**

In MVP section 7/9 explain structured chapter milestones and per-NPC contact facts persist, but AI prose is not memory. Document journal recap and non-goals. Change planned status only after all checks pass; include actual fixture/test counts and never claim a real smoke unless run.

- [ ] **Step 2: Run full offline verification**

~~~bash
npm run lint
npm run typecheck
npm test
npm run test:fast
npm run build
npm run journey:phase11
npm run phase:status
~~~

Expected: every command exits 0; no real AI request occurs.

- [ ] **Step 3: Spec self-audit**

Map Spec section 9: 1→Tasks 1/3; 2→Task 2; 3/6→Task 4; 4→Task 5; 5→Task 6; 7→Task 7; 8→Task 8/this task. Search storyMemory, narrative_scene_presented, runtime-narrative-v2 in source/docs; ensure no documentation says AI prose becomes facts.

- [ ] **Step 4: Commit**

~~~bash
git add docs
git commit -m "docs: record phase11 continuity memory implementation"
~~~

## Final Verification

- [ ] npm run lint, npm run typecheck, npm test, npm run test:fast, npm run build, npm run journey:phase11, and npm run phase:status pass offline.
- [ ] npx vitest run src/dependencyBoundaries.test.ts src/game/logging/dependencyBoundaries.test.ts passes after final import changes.
- [ ] An old save missing storyMemory can read and make one legal write; no JSON version bump exists.
- [ ] Stored memory/event records contain no prose, choice token, action key, prompt, provider output, secret or configuration value.
