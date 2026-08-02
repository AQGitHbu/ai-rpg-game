# Story Quality Budget Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Increase real-AI opening reliability by safely repairing over-budget NPC arrays without deleting NPCs referenced by locations, the opening scene, or quest objectives.

**Architecture:** Keep the repair in the existing application-layer mechanical recovery function. When the NPC count exceeds the current `BudgetPolicy`, repeatedly remove only an unreferenced NPC, preferring non-companions and later array entries; if every removable candidate is referenced, return `null` and preserve the existing retry/fallback safety behavior. Re-run the full validator after repair.

**Tech Stack:** TypeScript, Vitest, existing RPG blueprint validator and `BudgetPolicy`.

## Global Constraints

- Do not create or modify `@ai-game/*` packages or the foundation sibling repository.
- Do not invent or rewrite story content, IDs, references, tags, or numeric values in the repair.
- Preserve all NPCs referenced by `locations[].npcIds`, `openingScene.presentNpcIds`, or `quests[].objectives[].npcId`.
- Preserve the existing `null` result when a safe mechanical repair cannot produce a fully valid candidate.
- Run the focused test before and after implementation, then run the required offline gates.

---

### Task 1: Add the regression test for a referenced tail NPC

**Files:**
- Modify: `src/game/application/scenarioCandidateRecovery.test.ts`
- Test: `src/game/application/scenarioCandidateRecovery.test.ts`

**Interfaces:**
- Consumes: `repairScenarioCandidate(candidate, { policy })`.
- Produces: A regression assertion proving that an earlier unreferenced NPC can be removed while a later NPC referenced by a main quest is preserved.

- [x] **Step 1: Add a failing test**

Add this test after `只移除未知字段并裁剪超预算尾部项`:

```ts
  it("超预算尾部 NPC 被主线引用时，移除安全冗余 NPC 而保留引用 NPC", () => {
    const candidate = buildValidCandidate() as MutableCandidate;
    candidate.npcs = [
      ...candidate.npcs,
      {
        id: "npc_7",
        name: "主线遗客",
        role: "关键线人",
        description: "主线任务必须找到的线人。",
        locationId: "loc_2",
        isCompanion: false,
        knownFactIds: [],
        tags: []
      }
    ];
    candidate.quests = candidate.quests.map((quest) =>
      quest.kind === "main"
        ? {
            ...quest,
            objectives: [
              ...quest.objectives,
              { kind: "talk_to_npc", npcId: "npc_7" }
            ]
          }
        : quest
    );

    const repaired = repairScenarioCandidate(candidate, { policy: REPAIR_POLICY });

    expect(repaired).not.toBeNull();
    expect(repaired?.npcs).toHaveLength(6);
    expect(repaired?.npcs.some((npc) => npc.id === "npc_7")).toBe(true);
    expect(repaired?.npcs.some((npc) => npc.id === "npc_6")).toBe(false);
  });
```

- [x] **Step 2: Run the focused test and verify it fails**

Run:

```powershell
npx vitest run src/game/application/scenarioCandidateRecovery.test.ts -t "超预算尾部 NPC 被主线引用"
```

Expected: FAIL because the current tail-only slice removes `npc_7`, leaving the quest objective dangling and returning `null`.

### Task 2: Implement reference-aware mechanical pruning

**Files:**
- Modify: `src/game/application/scenarioCandidateRecovery.ts`
- Test: `src/game/application/scenarioCandidateRecovery.test.ts`

**Interfaces:**
- Consumes: `ScenarioBlueprintCandidate`, `BudgetPolicy`, and the existing deep-clone/root-whitelist repair.
- Produces: `mechanicalRepair()` that returns a repaired candidate or lets the existing caller return `null`.

- [x] **Step 1: Replace tail-only NPC slicing with safe pruning**

Replace the current line:

```ts
  cloned.npcs = (cloned.npcs as unknown[]).slice(0, policy.opening.coreNpcsMax);
```

with:

```ts
  cloned.npcs = pruneNpcBudget(
    cloned.npcs as ScenarioBlueprintCandidate["npcs"],
    cloned.locations as ScenarioBlueprintCandidate["locations"],
    cloned.quests as ScenarioBlueprintCandidate["quests"],
    cloned.openingScene as ScenarioBlueprintCandidate["openingScene"],
    policy.opening.coreNpcsMax
  );
```

Add this helper before `deepTrimClone`:

```ts
function pruneNpcBudget(
  npcs: ScenarioBlueprintCandidate["npcs"],
  locations: ScenarioBlueprintCandidate["locations"],
  quests: ScenarioBlueprintCandidate["quests"],
  openingScene: ScenarioBlueprintCandidate["openingScene"],
  maxCount: number
): ScenarioBlueprintCandidate["npcs"] {
  const kept = [...npcs];
  while (kept.length > maxCount) {
    const referenced = new Set<string>([
      ...locations.flatMap((location) => location.npcIds.map(String)),
      ...openingScene.presentNpcIds.map(String),
      ...quests.flatMap((quest) =>
        quest.objectives.flatMap((objective) =>
          objective.kind === "talk_to_npc" ? [String(objective.npcId)] : []
        )
      )
    ]);
    const removableIndex = [...kept]
      .map((npc, index) => ({ npc, index }))
      .reverse()
      .sort((left, right) => Number(left.npc.isCompanion) - Number(right.npc.isCompanion))
      .find(({ npc }) => !referenced.has(String(npc.id)))?.index;
    if (removableIndex === undefined) return kept;
    kept.splice(removableIndex, 1);
  }
  return kept;
}
```

The existing validator remains the final authority; if pruning leaves an invalid structure, `repairScenarioCandidate` still returns `null`.

- [x] **Step 2: Run the focused test and verify it passes**

Run:

```powershell
npx vitest run src/game/application/scenarioCandidateRecovery.test.ts
```

Expected: all recovery tests pass, including the new referenced-tail regression.

### Task 3: Run quality gates and real regression

**Files:**
- Modify: none
- Test: existing repository test suites and generated `artifacts/story-eval/` files

- [x] **Step 1: Run focused application tests**

```powershell
npm run test:game-application
```

Expected: all application tests pass.

- [x] **Step 2: Run offline acceptance**

```powershell
npm test
npm run lint
npm run typecheck
npm run test:fast
npm run build
```

Expected: no test/type/boundary/build failures; lint warnings are recorded separately.

- [x] **Step 3: Run one real regression case**

```powershell
$env:RUN_REAL_AI_STORY_EVAL='1'
$env:STORY_EVAL_PROFILE='regression'
npm run smoke:ai:story-eval -- --case=wuxia-a
```

Expected: both strategies produce complete artifacts; compare generated-opening success, `fallbackRate`, convergence, per-role retries, facts planned/actual overlap, tension curve, and branch differences against the pre-change smoke evidence. Do not call the result a full baseline until all six cases are run.

## Run result (2026-08-02)

- The regression profile completed with `REAL_AI_JOURNEY_FAILED 1/2`; the failing explore sample exposed a separate contract drift: `collect_item` instead of the required `obtain_item` objective kind.
- The follow-up smoke run passed with `REAL_AI_JOURNEY_OK`; both strategies wrote complete `manifest.json` and `story.jsonl` artifacts. The explore run had `fallbackRate=0`, while objective had `fallbackRate=0.333`.
- The prompt now enumerates objective kinds explicitly and forbids `collect_item`; prompt and reference-aware NPC repair regressions pass. This is a calibration result, not the six-case v2 baseline.
