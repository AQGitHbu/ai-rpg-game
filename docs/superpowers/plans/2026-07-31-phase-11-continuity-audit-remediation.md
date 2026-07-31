# Phase 11 Continuity Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Close the Phase 11 knowledge-boundary and player-facing continuity defects, then replace the replay fixture only after a successful opt-in live AI journey and immediate zero-network replay.

**Architecture:** eventLedger remains the only source of story facts. Split director/writer history to 12/6; writer receives identity/role plus approved cards only, NPC receives own contact plus approved cards only. Saved action copy is derived from authoritative candidates rather than model wording.

**Tech Stack:** TypeScript strict, Vitest, runtime-narrative-v2 recording/replay, SQLite test repository, configured AI transport under RUN_REAL_AI_JOURNEY=1.

## Global Constraints

- Do not send undiscovered fact text, another NPC's continuity, or global ledger data to writer/NPC contexts.
- Director continuity is exactly 12 safe milestones; writer continuity is exactly 6.
- Story-memory persistence, CAS and fallback semantics remain unchanged.
- Saved choice labels and strategies come from authoritative action candidates.
- Context-shape changes deliberately invalidate request fingerprints and require a new recording.

---

### Task 1: Enforce context least privilege and limits

**Files:**
- Modify: src/game/application/runtimeNarrativeContexts.ts
- Modify: src/game/application/runtimeNarrativeContexts.test.ts

**Interfaces:** director gets 12 milestones; writer gets six and a profile without knownFactTexts; NPC has no recentEvents.

- [ ] **Step 1: Write the failing tests**

```ts
expect(toDirectorContext({ blueprint, stateWithThirteenMilestones }).recentContinuity).toHaveLength(12);
expect(toSceneScriptContext({ blueprint, state: stateWithThirteenMilestones, plan }).recentContinuity).toHaveLength(6);
expect(JSON.stringify(toSceneScriptContext({ blueprint: blueprintWithNpcHiddenFact, state, plan }))).not.toContain("未发现事实");
const npc = toNpcLineContext({ blueprint, state: stateWithOtherNpcAndBattleEvents, npcId: "npc_b", speechAct: "warn", allowedFactIds: [], mayLie: false });
expect("recentEvents" in npc).toBe(false);
expect(JSON.stringify(npc)).not.toContain("battle_resolved");
```

- [ ] **Step 2: Run test to verify it fails**

Run: npx vitest run src/game/application/runtimeNarrativeContexts.test.ts

Expected: FAIL because the shared six-entry limit, writer knownFactTexts and NPC recentEvents exist.

- [ ] **Step 3: Write minimal implementation**

```ts
const DIRECTOR_CONTINUITY_LIMIT = 12;
const WRITER_CONTINUITY_LIMIT = 6;
function projectRecentContinuity(state: GameState, blueprint: ScenarioBlueprint, limit: number) {
  return storyMemoryOf(state).recent.slice(-limit).map((entry) => ({ text: continuityMilestoneText(entry, blueprint, state) }));
}
// Director uses 12, writer uses 6; npcProfile is { id, name, role }; NPC context does not read eventLedger.
```

- [ ] **Step 4: Run test to verify it passes**

Run: npx vitest run src/game/application/runtimeNarrativeContexts.test.ts

Expected: PASS with explicit hidden-fact and global-knowledge absence assertions.

- [ ] **Step 5: Commit**

```bash
git add src/game/application/runtimeNarrativeContexts.ts src/game/application/runtimeNarrativeContexts.test.ts
git commit -m "fix(phase11): restrict narrative continuity contexts"
```

### Task 2: Bind saved choice copy to rule actions

**Files:**
- Modify: src/game/application/orchestrateNarrativeScene.ts
- Modify: src/game/application/orchestrateNarrativeScene.test.ts
- Modify: src/game/application/server/ai/liveRuntimeNarrativeSources.ts

**Interfaces:** each saved NarrativeSceneState choice retains its approved key but uses the matching candidate publicLabel and deterministic strategy.

- [ ] **Step 1: Write the failing test**

```ts
const result = await orchestrateNarrativeScene(depsWithWriterChoices(
  { actionKey: "move:loc_2", label: "观察旧井", strategy: "留在原地" },
  { actionKey: "observe:loc_1", label: "前往渡口", strategy: "立即离开" },
));
expect(result.scene.choices[0]).toMatchObject({ actionKey: "move:loc_2", label: "前往渡口" });
```

- [ ] **Step 2: Run test to verify it fails**

Run: npx vitest run src/game/application/orchestrateNarrativeScene.test.ts

Expected: FAIL because model labels and strategies are preserved today.

- [ ] **Step 3: Write minimal implementation**

```ts
const candidate = candidates.find((entry) => entry.actionKey === choice.actionKey);
if (candidate === undefined) throw new Error("approved action candidate disappeared");
return { choiceToken: `${traceId}-choice:${index}`, actionKey: choice.actionKey, label: candidate.publicLabel, strategy: `执行「${candidate.publicLabel}」` };
```

Update the writer instruction so labels and strategies are non-authoritative flavor.

- [ ] **Step 4: Run test to verify it passes**

Run: npx vitest run src/game/application/orchestrateNarrativeScene.test.ts src/game/application/generatePendingNarrativeScene.test.ts

Expected: PASS; misleading model wording cannot be persisted.

- [ ] **Step 5: Commit**

```bash
git add src/game/application/orchestrateNarrativeScene.ts src/game/application/orchestrateNarrativeScene.test.ts src/game/application/server/ai/liveRuntimeNarrativeSources.ts
git commit -m "fix(narrative): bind choice copy to rule actions"
```

### Task 3: Make discovered facts useful continuity without leaking hidden facts

**Files:**
- Modify: src/game/application/runtimeNarrativeContexts.ts
- Modify: src/game/application/runtimeNarrativeContexts.test.ts
- Modify: src/game/application/gameSessionView.ts
- Modify: src/game/application/gameSessionView.test.ts
- Modify: docs/agent/剧情连续性与结构化记忆.md
- Modify: docs/agent/当前开发阶段.md

**Interfaces:** fact text is projected only when it is currently discovered; malformed or undiscovered entries become a generic clue.

- [ ] **Step 1: Write failing tests**

```ts
const director = toDirectorContext({ blueprint, state: stateWithDiscoveredFactAndLaterEvents });
expect(director.recentContinuity.map((entry) => entry.text)).toContain("线索：公开事实1");
expect(JSON.stringify(director)).not.toContain("未发现事实");
expect(project(stateWithDiscoveredFact).storyContinuity?.milestones.map((entry) => entry.text)).toContain("查明线索：公开事实1");
```

- [ ] **Step 2: Run test to verify it fails**

Run: npx vitest run src/game/application/runtimeNarrativeContexts.test.ts src/game/application/gameSessionView.test.ts

Expected: FAIL because facts are generic today.

- [ ] **Step 3: Write minimal implementation**

```ts
function discoveredFactText(blueprint: ScenarioBlueprint, state: GameState, factId: string): string {
  const discovered = state.worldFacts.some((entry) => String(entry.factId) === factId && entry.discovered);
  const fact = blueprint.world.facts.find((entry) => String(entry.id) === factId);
  return discovered && fact !== undefined ? fact.text : "一条线索";
}
```

Use it for fact continuity cards and journal entries; do not add text to persisted memory.

- [ ] **Step 4: Run offline checks**

Run: npm run lint; npm run typecheck; npm run test:fast

Expected: PASS. Old Phase 11 replay is expected to drift until Task 4.

- [ ] **Step 5: Commit**

```bash
git add src/game/application/runtimeNarrativeContexts.ts src/game/application/runtimeNarrativeContexts.test.ts src/game/application/gameSessionView.ts src/game/application/gameSessionView.test.ts docs/agent/剧情连续性与结构化记忆.md docs/agent/当前开发阶段.md
git commit -m "feat(phase11): retain safe discovered fact continuity"
```

### Task 4: Re-record and certify the changed contract

**Files:**
- Modify: data/fixtures/phase11-journey/v1/calls.jsonl
- Modify: data/fixtures/phase11-journey/v1/expected-summary.json
- Modify: docs/agent/剧情连续性与结构化记忆.md
- Modify: docs/agent/当前开发阶段.md

**Interfaces:** promoted fixture has only parsed results and context hashes for remediated runtime-narrative-v2 contexts.

- [ ] **Step 1: Run zero-network gates**

Run: npm test; npm run build; npm run phase:status

Expected: PASS; fixture replay is verified after live re-recording.

- [ ] **Step 2: Record and immediately replay a live journey**

Run: $env:RUN_REAL_AI_JOURNEY='1'; npm run smoke:ai:phase11-journey

Expected: bounded success, no mandatory fallback, automatic immediate zero-network replay.

- [ ] **Step 3: Inspect and promote only safe fields**

```powershell
rg -n -i 'api[_-]?key|authorization|cookie|prompt|base[_-]?url|https?://' artifacts\phase11-journey\run-*\calls.jsonl artifacts\phase11-journey\run-*\expected-summary.json
```

Expected: no matches. Promote only calls.jsonl and expected-summary.json.

- [ ] **Step 4: Verify promoted replay**

Run: npm run journey:phase11

Expected: PASS with no fetch calls.

- [ ] **Step 5: Commit**

```bash
git add data/fixtures/phase11-journey/v1 docs/agent/剧情连续性与结构化记忆.md docs/agent/当前开发阶段.md
git commit -m "test(phase11): refresh remediated continuity journey"
```

## Self-Review

- Coverage: Task 1 fixes privilege and capacity; Task 2 removes action-copy mismatch; Task 3 adds safe semantic continuity; Task 4 requires a new live recording and immediate replay.
- No placeholders: tasks provide paths, assertions, commands and expected outcomes.
- Type consistency: changes are application-context and UI-projection only; no persisted schema changes.
