# Provider Reasoning Budget Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent live RPG world-evolution and scene-performance requests from exhausting their completion-token budget in provider reasoning before JSON content is returned.

**Architecture:** Keep the shared OpenAI-compatible transport unchanged because it already sends the provider-compatible nested thinking switch and its public contract intentionally does not contain product retry semantics. Restore product-level budgets based on the observed provider response—3200 tokens for world evolution and 3000 for scene performance—while retaining the current 45-second request window and deterministic fallback path.

**Tech Stack:** TypeScript, Vitest, Next.js server AI sources, Markdown runtime documentation.

## Global Constraints

- Provider calls remain server-only and must not log API keys, complete prompts, or raw model responses.
- AI output remains a proposal only; existing parse, approval, ID, and deterministic fallback paths remain authoritative.
- The 45-second live request timeout remains unchanged for the player-facing runtime.
- The protected `ai-game-foundation` repository and `.foundation` junction are not modified from this consumer worktree.

---

### Task 1: Add budget regression coverage

**Files:**
- Modify: `src/game/application/server/ai/liveScenePerformanceSource.test.ts`
- Modify: `src/game/application/server/ai/worldEvolutionSource.test.ts`

**Interfaces:**
- Consumes: `LIVE_SCENE_MAX_TOKENS` and `LIVE_WORLD_EVOLUTION_MAX_TOKENS` exported runtime constants.
- Produces: Tests that fail if either live source is reduced below the provider's required reasoning-plus-JSON budget.

- [x] **Step 1: Add a scene budget assertion**

Add a focused test beside the existing request-options assertions that requires `LIVE_SCENE_MAX_TOKENS` to be at least `3000` and keeps `LIVE_SCENE_TIMEOUT_MS` at `45_000`.

- [x] **Step 2: Add a world budget assertion**

Import `LIVE_WORLD_EVOLUTION_MAX_TOKENS` and `LIVE_WORLD_EVOLUTION_TIMEOUT_MS` and assert a minimum of `3200` tokens with the timeout fixed at `45_000`.

- [x] **Step 3: Run the two focused test files**

Run `npm exec vitest run src/game/application/server/ai/liveScenePerformanceSource.test.ts src/game/application/server/ai/worldEvolutionSource.test.ts`.

Expected: the new minimum assertions fail against the current `1800` constants.

### Task 2: Restore provider-safe runtime budgets

**Files:**
- Modify: `src/game/application/server/ai/liveScenePerformanceSource.ts:42-51`
- Modify: `src/game/application/server/ai/liveWorldEvolutionSource.ts:28-36`

**Interfaces:**
- Consumes: The existing `createProviderRequestOptions` contract with nested `chat_template_kwargs.enable_thinking=false`.
- Produces: Scene requests with `max_tokens=3000` and world-evolution requests with `max_tokens=3200`, both retaining the 45-second timeout and current retry/fallback behavior.

- [x] **Step 1: Raise the scene budget**

Change `LIVE_SCENE_MAX_TOKENS` from `1_800` to `3_000` and update the adjacent comment to state that the budget covers provider reasoning plus the scene JSON body.

- [x] **Step 2: Raise the world-evolution budget**

Change `LIVE_WORLD_EVOLUTION_MAX_TOKENS` from `1_800` to `3_200` and update the adjacent comment with the same reasoning-plus-content requirement.

- [x] **Step 3: Run the focused tests**

Run the two AI source test files again.

Expected: PASS, including the request-option assertions that now observe the raised constants.

### Task 3: Document the runtime contract

**Files:**
- Modify: `docs/agent/运行时AI导演与场景表演.md`
- Modify: `docs/Agent文档索引.md`

**Interfaces:**
- Consumes: The final runtime constants and provider behavior established by Tasks 1–2.
- Produces: A current implementation fact explaining that provider completion tokens include reasoning and that the live budgets are 3200/3000 with a 45-second timeout.

- [x] **Step 1: Update the runtime AI document**

Add the world-evolution and scene-performance token budgets near the existing 45-second contract, explain that `reasoning_content` consumes the same completion budget, and state that a response without usable `message.content` remains a failed AI proposal eligible for deterministic recovery.

- [x] **Step 2: Update the index summary**

Append the budget/diagnostic fact to the existing runtime-AI index entry without changing its routing path.

- [x] **Step 3: Run repository verification**

Run `npm exec vitest run src/game/application/server/ai/liveScenePerformanceSource.test.ts src/game/application/server/ai/worldEvolutionSource.test.ts`, `npm run typecheck`, and `npm test -- --run`.

Expected: focused tests, typecheck, and the full test suite pass; no shared package or junction changes appear in `git status`.
