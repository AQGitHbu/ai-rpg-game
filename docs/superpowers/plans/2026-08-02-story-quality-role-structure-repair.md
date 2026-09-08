# AI Role Structure and Progression Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复导演、编剧、NPC 与规则状态之间的结构断链，使正常主线能沿合法路径推进、关键物品进入叙事，并用可复现指标验证目标命中率。

**Architecture:** 规则层继续独占行动、任务、物品和事件写入；application 上下文投影器计算当前主线目标的直接行动或下一跳移动路径，并向导演/编剧提供最小权限的地点、物品和 NPC 知识卡。writer 只能选择已批准行动和已授权事实，NPC 只能消费 writer 授权且自身已知的事实。评估产物额外记录当前主线目标与玩家选择，用于客观统计导演计划是否真的转化为推进。

**Tech Stack:** TypeScript strict / Vitest / SQLite 临时旅程 / Node story-eval analyzer

## Global Constraints

- 规则状态仍只能由 `src/game/gameplay/rpg/` 裁决；AI 不得直接宣称任务、事实、物品或结局已完成。
- 不把完整 `GameState`、蓝图、eventLedger、prompt 或 provider 配置传给任何角色；新增上下文只投影当前地点、当前目标和必要实体卡。
- `activeMainObjective` 的路径建议必须来自当前合法 `actionCandidates`；不能生成不存在或未解锁的 action key。
- `usedFactIds` 只能来自已批准事实卡；新事实仍只能由 `investigate` 规则行动产生 `fact_discovered` 事件。
- 不实现 `use_item`、装备数值效果、交易或奖励随机化；本轮只让关键物品可达、可见、可被主线目标验证并进入叙事。
- 修改 `@ai-game/*`、foundation 或 `.foundation` junction 均不在本计划范围内。
- 每个修改的 gameplay/application/AI 文件必须有同目录行为测试；最后运行 `npm test`、`npm run typecheck`、`npm run lint`、`npm run build` 与 `npm run test:fast`。

---

### Task 1: Write failing regression tests for the broken progression and role contracts

**Files:**
- Modify: `src/game/gameplay/rpg/scenario/createFallbackBlueprint.test.ts`
- Modify: `src/game/application/runtimeNarrativeContexts.test.ts`
- Modify: `src/game/application/server/ai/liveRuntimeNarrativeSources.test.ts`
- Modify: `src/game/gameplay/rpg/actions/resolveAction.test.ts`
- Modify: `src/game/application/testing/storyEvalArtifacts.test.ts`

**Interfaces:**
- Consumes: current fallback blueprint, `toDirectorContext`, `repairRuntimeNarrativeReferences`, and direct `talk` resolver behavior.
- Produces: failing examples for the new legal route, item card, NPC fact authorization, and direct-talk relationship memory.

- [ ] **Step 1: Add fallback-chain assertions.**

For medium/long generated blueprints, assert the main signatures are:

```ts
[
  "visit_location:loc_2",
  "talk_to_npc:npc_2",
  "visit_location:loc_3",
  "obtain_item:item_key",
  "talk_to_npc:npc_3",
  "visit_location:loc_4",
  "talk_to_npc:npc_4",
  "defeat_enemy:enemy_boss",
]
```

Also assert the final quest has both `visit_location:loc_4` and `defeat_enemy:enemy_boss`, and that no main objective uses `fact_gen_1` or `fact_gen_2` as a later gate.

- [ ] **Step 2: Add director route tests.**

Construct a state at `loc_2` with an active `obtain_item:item_key` quest and assert:

```ts
expect(context.activeMainObjective).toMatchObject({
  kind: "obtain_item",
  targetId: "item_key",
  targetActionKey: "take_item:item_key",
  suggestedActionKey: "move:loc_3",
});
```

At `loc_3`, assert the same objective changes `suggestedActionKey` to `take_item:item_key`.

- [ ] **Step 3: Add writer/NPC permission and item-card tests.**

Assert scene context includes the current location card, `availableItemCards` for `item_key`, and focused NPC `knownFactIds`. Assert a repaired writer proposal preserves an `allowedFactIds` entry only when it is present in both the approved fact cards and the NPC’s known fact IDs.

- [ ] **Step 4: Add direct-talk relationship regression.**

Assert a successful `talk` action writes `{ affinity: 5 }` and `npc_met.interactionKind === "greet"`, so narrative `talk:<npc>` choices do not bypass Phase 13 relationship memory.

- [ ] **Step 5: Add objective evidence fixture assertions.**

Extend the story-eval story-row fixture with an optional `activeMainObjective` snapshot and assert artifact validation accepts it without accepting arbitrary extra fields.

- [ ] **Step 6: Run the focused tests and confirm they fail.**

Run:

```powershell
npx vitest run src/game/gameplay/rpg/scenario/createFallbackBlueprint.test.ts src/game/application/runtimeNarrativeContexts.test.ts src/game/application/server/ai/liveRuntimeNarrativeSources.test.ts src/game/gameplay/rpg/actions/resolveAction.test.ts src/game/application/testing/storyEvalArtifacts.test.ts
```

Expected: failures for the old fact-based chain, missing route/card fields, cleared NPC facts, and missing relationship update.

---

### Task 2: Repair fallback mainline reachability and direct-talk NPC state

**Files:**
- Modify: `src/game/gameplay/rpg/scenario/createFallbackBlueprint.ts`
- Modify: `src/game/gameplay/rpg/scenario/createFallbackBlueprint.test.ts`
- Modify: `src/game/gameplay/rpg/actions/resolveAction.ts`
- Modify: `src/game/gameplay/rpg/actions/resolveAction.test.ts`

**Interfaces:**
- Consumes: existing `MID_OBJECTIVES`, `ITEM_KEY`, `BOSS_LOCATION_ID`, relationship constants, and quest reconciliation.
- Produces: `fallback-6` blueprints with a legal item path and a final location-plus-battle gate; direct talk updates relationship memory consistently with dialogue choices.

- [ ] **Step 1: Change the fallback template version and objective table.**

Set `FALLBACK_TEMPLATE_VERSION` to `fallback-6` and replace `MID_OBJECTIVES` with:

```ts
const MID_OBJECTIVES = [
  [{ kind: "talk_to_npc", npcId: "npc_2" }],
  [{ kind: "visit_location", locationId: "loc_3" }],
  [{ kind: "obtain_item", itemId: ITEM_KEY }],
  [{ kind: "talk_to_npc", npcId: "npc_3" }],
  [{ kind: "visit_location", locationId: "loc_4" }],
  [{ kind: "talk_to_npc", npcId: "npc_4" }],
] as const;
```

For the final main quest, use:

```ts
objectives: [
  { kind: "visit_location", locationId: "loc_4" },
  { kind: "defeat_enemy", enemyId: ENEMY_BOSS_ID },
]
```

The short three-act compatibility objective remains `talk_to_npc:npc_3 + obtain_item:item_key`.

- [ ] **Step 2: Make direct `talk` use the Phase 13 relationship contract.**

In `resolveAction`’s `talk` branch, compute the current affinity with neutral fallback, add `RELATIONSHIP_CHANGE.GREET_FIRST_MEET`, write `relationship: { affinity }`, and include `interactionKind: "greet"` on the `npc_met` event. Keep the action’s existing movement/task semantics unchanged.

- [ ] **Step 3: Run focused gameplay tests.**

Run:

```powershell
npx vitest run src/game/gameplay/rpg/scenario/createFallbackBlueprint.test.ts src/game/gameplay/rpg/scenario/questGraph.test.ts src/game/gameplay/rpg/quests/quests.test.ts src/game/gameplay/rpg/actions/resolveAction.test.ts
```

Expected: all focused tests pass and the fallback regression proves the key item is encountered before the final battle.

---

### Task 3: Project a legal next-hop route and richer minimal role context

**Files:**
- Modify: `src/game/application/runtimeNarrativeContexts.ts`
- Modify: `src/game/application/runtimeNarrativeContexts.test.ts`
- Modify: `src/game/application/server/ai/liveRuntimeNarrativeSources.ts`
- Modify: `src/game/application/server/ai/liveRuntimeNarrativeSources.test.ts`

**Interfaces:**
- Consumes: compiled locations/NPCs/items/enemies, unlocked location graph, `projectAvailableActions`, and the active objective.
- Produces: `ActiveMainObjective.targetActionKey`, a legal `suggestedActionKey` that is either the target action or the next move toward it, `currentLocationCard`, `availableItemCards`, and NPC `knownFactIds` as IDs only.

- [ ] **Step 1: Add target-location and BFS helpers.**

Implement pure helpers in `runtimeNarrativeContexts.ts`:

```ts
function objectiveTargetLocationId(blueprint, objective): string | null { /* entity location or opening fact location */ }
function nextMoveToward(blueprint, state, targetLocationId, actionCandidates): string | null { /* BFS over unlocked connected locations */ }
```

The BFS may traverse only `state.unlockedLocationIds`; it returns the first legal `move:<id>` action from the current location or `null`. Direct legal actions always win over route moves.

- [ ] **Step 2: Extend `ActiveMainObjective`.**

Add:

```ts
readonly targetActionKey: string;
```

Set `targetActionKey` to the objective’s direct action key. Set `suggestedActionKey` to the direct legal key first, otherwise the BFS next hop, otherwise `null`.

- [ ] **Step 3: Add minimal location/item/NPC cards.**

Add to director and writer contexts:

```ts
readonly currentLocationCard: { id: string; name: string; description: string; scale: string | null };
readonly availableItemCards: readonly { id: string; name: string; description: string; kind: string; category: string }[];
```

Add `knownFactIds: readonly string[]` to `npcProfile`; do not add fact text there. Keep fact text only in `allowedFactCards`.

- [ ] **Step 4: Update director and writer prompt rules.**

Director rules must say the `suggestedActionKey` is the legal next step toward `targetActionKey` when the target action is unavailable. Writer rules must say that when the active objective is `obtain_item`, or the first approved action is `take_item:*`, the narration should identify the supplied item and its story function without inventing effects.

- [ ] **Step 5: Run context/source tests and typecheck.**

Run:

```powershell
npx vitest run src/game/application/runtimeNarrativeContexts.test.ts src/game/application/server/ai/liveRuntimeNarrativeSources.test.ts
npm run typecheck
```

Expected: route and cards are present, only legal action keys are emitted, and TypeScript passes.

---

### Task 4: Repair writer-to-NPC fact authorization and item narration inputs

**Files:**
- Modify: `src/game/application/server/ai/liveRuntimeNarrativeSources.ts`
- Modify: `src/game/application/server/ai/scenarioPrompt.ts` if shared role-contract text requires synchronization
- Modify: `src/game/application/server/ai/liveRuntimeNarrativeSources.test.ts`
- Modify: `src/game/application/orchestrateNarrativeScene.test.ts`

**Interfaces:**
- Consumes: `allowedFactCards`, `npcProfile.knownFactIds`, active objective, and `availableItemCards`.
- Produces: writer-approved `npcInstruction.allowedFactIds` as the intersection of writer-requested IDs, approved fact cards, and the focused NPC’s known IDs; NPC receives those cards and can use them under existing approval.

- [ ] **Step 1: Stop clearing all NPC fact IDs.**

In `repairRuntimeNarrativeReferences` for `writer`, replace the unconditional `allowedFactIds: []` with filtering:

```ts
const approvedFactIds = new Set(allowedFactCards);
const knownFactIds = new Set(
  Array.isArray(npcProfile.knownFactIds)
    ? npcProfile.knownFactIds.filter((id): id is string => typeof id === "string")
    : [],
);
const allowedFactIds = Array.isArray(instruction.allowedFactIds)
  ? instruction.allowedFactIds.filter((id): id is string => approvedFactIds.has(id) && knownFactIds.has(id))
  : [];
```

Keep `mayLie: false` and the exact NPC ID mechanical protections.

- [ ] **Step 2: Update prompts and tests.**

Tell writer it may select only IDs from both `allowedFactCards` and `npcProfile.knownFactIds`; tell NPC that `factCards` are the only facts it may cite. Add a test showing an allowed known fact survives and an unknown or unapproved fact is removed.

- [ ] **Step 3: Verify item context reaches writer.**

Add a source test that the writer user context contains `availableItemCards` and `activeMainObjective.kind === "obtain_item"` when the item is the current target. This is input verification, not a prose-quality assertion.

- [ ] **Step 4: Run the role-chain tests.**

Run:

```powershell
npx vitest run src/game/application/orchestrateNarrativeScene.test.ts src/game/application/orchestrateNarrativeScene.storyEval.test.ts src/game/application/server/ai/liveRuntimeNarrativeSources.test.ts src/game/application/runtimeNarrativeContexts.test.ts
```

Expected: writer/NPC approval remains least-privilege and the actor is no longer structurally starved of authorized facts.

---

### Task 5: Add objective-hit and item-path evidence to story evaluation

**Files:**
- Modify: `src/game/application/testing/storyEvalArtifacts.ts`
- Modify: `src/game/application/testing/storyEvalJourney.test.ts`
- Modify: `scripts/storyEvalAnalyze.mjs`
- Modify: `scripts/storyEvalAnalyze.node-test.mjs`
- Modify: `docs/archive/AI内容质量评估.md`

**Interfaces:**
- Consumes: safe `activeMainObjective` snapshots and each scene’s selected action/new rule events.
- Produces: `metrics.mainlineObjective` with opportunity count, route-hit count, direct-target-hit count, progressed-scene count, and `itemObjective` evidence.

- [ ] **Step 1: Record the safe objective snapshot.**

Before each scene choice, derive the same context used by the director and write only:

```ts
activeMainObjective: {
  questId,
  stage,
  kind,
  targetId,
  targetActionKey,
  suggestedActionKey,
}
```

or `null`. Do not record objective descriptions, hidden fact text, prompts, or full state.

- [ ] **Step 2: Add analyzer metrics.**

For every scene with an objective snapshot, count:

```ts
opportunities += 1;
routeHits += selectedActionKey === suggestedActionKey;
targetHits += selectedActionKey === targetActionKey;
progressedScenes += newEvents.some(event => ["quest_completed", "quest_unlocked", "item_obtained", "npc_met", "location_visited", "fact_discovered", "enemy_defeated"].includes(event.type));
```

Expose `itemObjective` as the subset of these counts where `kind === "obtain_item"`.

- [ ] **Step 3: Add analyzer node tests.**

Assert route hits, direct target hits, progression events, and item subset counts from a three-row fixture.

- [ ] **Step 4: Update the quality log.**

Document the five structural defects, the fact that item use/effects remain intentionally unimplemented, and the new metrics/commands.

- [ ] **Step 5: Run story-eval tests.**

Run:

```powershell
npx vitest run src/game/application/testing/storyEvalArtifacts.test.ts src/game/application/testing/storyEvalJourney.test.ts
node --test scripts/storyEvalAnalyze.node-test.mjs
```

---

### Task 6: Full verification and real regression

**Files:**
- Modify: `docs/superpowers/plans/2026-08-02-story-quality-run-debug.md`
- Modify: `docs/archive/AI内容质量评估.md`

- [ ] **Step 1: Run all offline gates.**

```powershell
npm test
npm run test:fast
npm run typecheck
npm run lint
npm run build
npm run journey:story-eval
git diff --check
```

- [ ] **Step 2: Run one real 12-scene regression with the repaired fallback-6 blueprint.**

```powershell
$env:RUN_REAL_AI_STORY_EVAL='1'
$env:STORY_EVAL_PROFILE='regression'
$env:AI_THINKING_ROLES=''
npm run smoke:ai:story-eval -- --case=wuxia-a --strategy=objective --runs=1 --seed=20260801
```

Analyze the newest artifact:

```powershell
npm run analyze:story-eval -- <runDir>
```

Expected evidence: no fallback, target route hits should be nonzero, item objective should be reached in at least one scene if the journey reaches stage 4, and the result should clearly state whether it converged or stopped at the regression cap.

- [ ] **Step 3: Append exact results to the two evaluation documents.**

Record artifact path, scene count, fallback rate, objective-hit metrics, item-path evidence, ending status, and any remaining role-specific bottleneck. Do not call a 12-scene regression a formal baseline.

- [ ] **Step 4: Self-review the plan.**

Confirm no task authorizes AI to write game state, no item-use system was accidentally introduced, all new context is minimal, and all placeholders/temporary debug outputs are absent.

