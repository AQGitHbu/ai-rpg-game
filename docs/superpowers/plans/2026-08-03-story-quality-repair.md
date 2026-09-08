# Story Quality Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the runtime AI story loop more choice-driven and measurable by preserving scene intent across AI roles, preventing semantically duplicated mainline stages, and making the evaluator report durable facts and consequences instead of proxy counts.

**Architecture:** Keep the existing Scenario → Director → Writer → NPC pipeline, but make the handoff context explicit and bounded. Reject low-information mainline blueprints before they reach runtime, while making deterministic fallback content unique by objective. Update evaluation at the artifact boundary so metrics are derived from persisted facts/events and visible ending data.

**Tech Stack:** TypeScript, Vitest, Node.js story-evaluation scripts, JSONL artifacts.

## Global Constraints

- Do not let any AI role mutate game state directly; state changes remain validated action events.
- Preserve the existing scenario, narrative, and artifact schemas unless a field is strictly additive and backward-compatible.
- Tests must run from `F:\AI2\ai-rpg-game\.worktrees\ai-story-quality-eval`.
- Do not modify the protected `../ai-game-foundation` repository or `.foundation` junction.

---

### Task 1: Preserve scene intent through the NPC handoff

**Files:**
- Modify: `src/game/application/runtimeNarrativeContexts.ts`
- Modify: `src/game/application/orchestrateNarrativeScene.ts`
- Modify: `src/game/application/server/ai/liveRuntimeNarrativeSources.ts`
- Test: `src/game/application/runtimeNarrativeContexts.test.ts`
- Test: `src/game/application/orchestrateNarrativeScene.test.ts`

**Interfaces:**
- `toNpcLineContext` accepts the current scene goal, player name, location summary, and requested emotion.
- `NpcLineContext` exposes only safe, bounded context needed by the NPC source.
- `orchestrateNarrativeScene` passes the Writer-approved `npcInstruction.emotion` and scene goal into the NPC context.

- [x] **Step 1: Add failing context assertions** — verify NPC description, player name, scene goal, current location, and requested emotion reach the NPC source context.
- [x] **Step 2: Run the focused context tests and confirm they fail** — `npx vitest run src/game/application/runtimeNarrativeContexts.test.ts src/game/application/orchestrateNarrativeScene.test.ts`.
- [x] **Step 3: Implement the additive context fields and prompt usage** — keep fact cards and relationship data filtered by existing allowlists.
- [x] **Step 4: Run the focused tests and typecheck** — the two tests plus `npm run typecheck` must pass.

### Task 2: Reject repetitive mainline blueprints and improve fallback stages

**Files:**
- Modify: `src/game/gameplay/rpg/scenario/validateScenarioBlueprint.ts`
- Modify: `src/game/gameplay/rpg/scenario/createFallbackBlueprint.ts`
- Test: `src/game/gameplay/rpg/scenario/validateScenarioBlueprint.test.ts`
- Test: `src/game/gameplay/rpg/scenario/createFallbackBlueprint.test.ts`

**Interfaces:**
- Scenario validation emits a stable issue code when multiple mainline stages reuse the same non-empty description.
- Fallback mainline descriptions are generated from the objective type and target, so every stage communicates a distinct player-facing purpose.

- [x] **Step 1: Add failing validator and fallback tests** — duplicate mainline descriptions must be invalid; fallback descriptions must be unique and mention their objective target.
- [x] **Step 2: Run the focused scenario tests and confirm the new assertions fail** — `npx vitest run src/game/gameplay/rpg/scenario/validateScenarioBlueprint.test.ts src/game/gameplay/rpg/scenario/createFallbackBlueprint.test.ts`.
- [x] **Step 3: Implement validation and deterministic fallback copy** — do not invent new facts or bypass existing objective/event validation.
- [x] **Step 4: Run scenario tests and typecheck** — all focused tests and `npm run typecheck` must pass.

### Task 3: Make story-evaluation metrics reflect durable story change

**Files:**
- Modify: `scripts/storyEvalAnalyze.mjs`
- Modify: `src/game/application/testing/storyEvalArtifacts.ts`
- Modify: `src/game/application/testing/storyEvalJourney.test.ts`
- Test: `scripts/storyEvalAnalyze.test.mjs`

**Interfaces:**
- Manifest snapshots include the fact universe and visible ending metadata when available.
- Analyzer reports unique/new/repeated fact usage, excludes `none_proposed` expansion decisions from proposals, and detects branch reconvergence at the configured horizon.
- Existing analyzer output keys remain compatible; new fields are additive.

- [x] **Step 1: Add failing analyzer assertions** — repeated fact usage is not counted as new coverage; empty expansion decisions are not proposals; reconverged branches are reported.
- [x] **Step 2: Run analyzer tests and confirm they fail** — `node --test scripts/storyEvalAnalyze.node-test.mjs`.
- [x] **Step 3: Implement artifact capture and metric corrections** — derive counts from persisted facts/action events and preserve old fields.
- [x] **Step 4: Run analyzer/artifact tests, then the existing story-eval regression suite** — `node --test scripts/storyEvalAnalyze.node-test.mjs` and `npx vitest run src/game/application/testing/storyEvalJourney.test.ts`.

### Task 4: Verify the repaired quality gates

**Files:**
- Modify: `src/game/application/server/ai/runtimeNarrativeRecording.ts` (rebuildable handoff fields and rekeyed golden replay fingerprints).
- Modify: `data/fixtures/phase10-journey/v1/calls.jsonl`, `data/fixtures/phase11-journey/v1/calls.jsonl`.
- Inspect: generated `artifacts/story-eval/**` and `docs/archive/AI内容质量评估标准.md`.

- [x] **Step 1: Run focused tests from Tasks 1–3.** — context/scenario/analyzer/artifact focused suites pass.
- [x] **Step 2: Run the relevant application/gameplay test subsets and `npm run typecheck`.** — application 64 files/504 tests, gameplay 37 files/570 tests, typecheck and boundaries pass.
- [x] **Step 3: Run one bounded real-AI journey if the configured provider is available; otherwise report the deterministic evidence and runner limitation.** — `case=wuxia-a`, regression profile, both `explore` and `objective` completed with `REAL_AI_JOURNEY_OK`; objective converged in 13 scenes, explore exhausted at 11 scenes. Artifacts and remaining gaps are recorded in `docs/archive/AI内容质量评估.md`.
- [x] **Step 4: Summarize remaining quality gaps by rule completion, consequence durability, fact coverage, branch convergence, and pacing.**
