# Story Quality Item Contract Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent optional item-presentation metadata drift from invalidating an otherwise playable AI-generated scenario candidate.

**Architecture:** Keep the existing validator as the final authority. Extend the application-layer mechanical repair with a narrow presentation-only sanitizer that removes invalid optional metadata while preserving item identity and all rule-bearing fields; strengthen the scenario prompt with the same closed enums and bounds.

**Tech Stack:** TypeScript, Vitest, existing RPG scenario validator and AI scenario prompt.

## Global Constraints

- Do not modify `@ai-game/*` packages or the foundation sibling repository.
- Do not rewrite item IDs, names, descriptions, kinds, tags, references, quests, or numeric game rules.
- Only remove invalid optional presentation metadata: `category`, `rarity`, `level`, or the whole invalid `statLines` field.
- Re-run `validateScenarioBlueprintCandidate` after repair; unsafe or non-presentation issues still return `null`.
- Keep the real-AI artifact that exposed `items[2].rarity=legendary` as diagnostic evidence; do not overwrite it.

---

### Task 1: Add regression tests for invalid optional item metadata

**Files:**
- Modify: `src/game/application/scenarioCandidateRecovery.test.ts`
- Modify: `src/game/application/server/ai/scenarioPrompt.test.ts`

**Interfaces:**
- Consumes: `repairScenarioCandidate()` and `buildScenarioPromptMessages()`.
- Produces: regression coverage proving invalid presentation metadata is removed without changing the item identity, and the prompt names legal values.

- [x] **Step 1: Add the failing recovery test**

Add an item with `rarity: "legendary"` and assert repair preserves its `id`/`name` while removing only `rarity`:

```ts
  it("非法物品展示稀有度只删除可选字段并保留物品本体", () => {
    const candidate = buildValidCandidate() as MutableCandidate;
    const sourceItem = candidate.items[1];
    candidate.items = [
      ...candidate.items,
      {
        ...sourceItem,
        id: "item_display_invalid",
        rarity: "legendary"
      } as unknown as (typeof candidate.items)[number]
    ];

    const repaired = repairScenarioCandidate(candidate, { policy: REPAIR_POLICY });
    const repairedItem = repaired?.items.find((item) => item.id === "item_display_invalid");

    expect(repairedItem).toMatchObject({ id: "item_display_invalid", name: sourceItem.name });
    expect(repairedItem?.rarity).toBeUndefined();
  });
```

- [x] **Step 2: Add the prompt contract assertion**

Assert the joined prompt contains the legal categories and rarities and the level/stat-line bounds:

```ts
    expect(joined).toContain("category 只能是 equipment、consumable、material、quest");
    expect(joined).toContain("rarity 只能是 common、fine、rare、epic");
    expect(joined).toContain("level 必须是 1~99 的整数");
    expect(joined).toContain("statLines 最多 6 条");
```

- [x] **Step 3: Run the focused tests and verify the new recovery test fails**

Run:

```powershell
npx vitest run src/game/application/scenarioCandidateRecovery.test.ts src/game/application/server/ai/scenarioPrompt.test.ts
```

Expected before implementation: the recovery test fails because `legendary` remains and the validator returns `null`; existing tests remain green.

### Task 2: Implement narrow presentation repair and prompt hardening

**Files:**
- Modify: `src/game/application/scenarioCandidateRecovery.ts`
- Modify: `src/game/application/server/ai/scenarioPrompt.ts`

**Interfaces:**
- Consumes: cloned `ScenarioBlueprintCandidate.items` and the existing prompt budget sections.
- Produces: `mechanicalRepair()` that sanitizes only optional item presentation fields before final validation.

- [x] **Step 1: Add item presentation sanitization to mechanical repair**

After deep clone and before list-budget pruning, map `cloned.items` through a helper that deletes only invalid optional fields. Use the closed sets `equipment|consumable|material|quest` and `common|fine|rare|epic`; accept integer level `1..99`; delete `statLines` if it is not an array of at most six non-empty `{label,value}` rows.

- [x] **Step 2: Add the matching prompt section**

Add a deterministic user prompt section:

```ts
    "# 物品展示元数据（若提供必须逐字合法）",
    "category 只能是 equipment、consumable、material、quest；rarity 只能是 common、fine、rare、epic；level 必须是 1~99 的整数；statLines 最多 6 条且每条都要有非空 label/value。禁止使用 legendary 等其他稀有度。",
```

- [x] **Step 3: Run focused tests and typecheck**

Run:

```powershell
npx vitest run src/game/application/scenarioCandidateRecovery.test.ts src/game/application/server/ai/scenarioPrompt.test.ts
npm run typecheck
```

Expected: all focused tests pass and TypeScript exits 0.

### Task 3: Run offline gates and a bounded real smoke verification

**Files:**
- Modify: `docs/agent/AI内容质量评估.md`
- Modify: this plan's run log
- Test artifacts: `artifacts/story-eval/`

**Interfaces:**
- Consumes: the repaired candidate path and the prompt contract.
- Produces: complete smoke artifacts or a preserved diagnostic failure, plus objective metrics.

- [x] **Step 1: Run repository quality gates**

```powershell
npm test
npm run lint
npm run test:fast
npm run build
```

Expected: no failures; lint may retain the five known story-evaluation warnings.

- [x] **Step 2: Run the short real-AI smoke**

```powershell
$env:RUN_REAL_AI_STORY_EVAL='1'
$env:STORY_EVAL_PROFILE='smoke'
npm run smoke:ai:story-eval -- --case=wuxia-a
```

Expected: `REAL_AI_JOURNEY_OK`; both strategy artifacts contain `manifest.json` and `story.jsonl`. Analyze both runs and record fallback rates; this remains calibration evidence, not the v2 baseline.

- [x] **Step 3: Record the result**

Update `docs/agent/AI内容质量评估.md` with the observed item-contract result and artifact paths. Do not claim formal story quality improvement from a three-scene smoke alone.

## Execution Log (2026-08-02)

- The focused recovery test failed before implementation as expected: `items[2].rarity=legendary` survived repair and final validation returned `null`.
- Added presentation-only sanitization for `category`, `rarity`, `level`, and `statLines`, plus matching closed-enum prompt constraints. Focused tests passed (16 tests) and `npm run typecheck` passed.
- Offline gates passed: `npm test` (148 files, 1609 tests, 4 skipped), `npm run lint` (0 errors, 5 existing warnings), `npm run test:fast`, and `npm run build`.
- Preserved the diagnostic incomplete artifact at `artifacts/story-eval/wuxia-a-explore-0-2026-08-02T05-32-02-537Z-4d5dd44a`; its failure was the invalid optional `rarity` field, not an item identity or quest-reference defect.
- Post-fix smoke returned `REAL_AI_JOURNEY_OK`. Complete artifacts:
  - `artifacts/story-eval/wuxia-a-explore-0-2026-08-02T05-48-44-810Z-ee367cd3`: 3 scenes, `max_scenes`, `fallbackRate=0`, scenario attempts 1/1 successful.
  - `artifacts/story-eval/wuxia-a-objective-1-2026-08-02T05-51-11-164Z-05d241cc`: 3 scenes, `max_scenes`, `fallbackRate=0`; scenario needed one retry after one failed attempt, then recovered.
- Both smoke runs remain calibration evidence only: tension was flat at `2,2,2`, no paired branch evidence was produced, and the objective run missed its planned `fact_identity`/`fact_premise` reveal events. The post-fix judge attempt exceeded the 240-second command limit and produced no new score files.
