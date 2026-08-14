# Unified RPG AI Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every production RPG AI request use one transport/client, give each role an explicit thinking policy, and diagnose provider responses that contain reasoning but no final JSON instead of blindly retrying the same request.

**Architecture:** Keep `@ai-game/ai-transport` protocol-only while extending its sanitized completion metadata contract in the foundation same-name worktree. Add an RPG-local `RpgAiClient` that owns one transport instance, role policies, provider body construction, and retry decisions. Live sources receive the client and remain responsible for prompts, parsing, validation, and deterministic fallback.

**Tech Stack:** TypeScript, Vitest, `@ai-game/ai-transport`, Next.js server composition root.

## Global Constraints

- Preserve the existing `.foundation` junction and do not edit or remove the protected foundation repository through the junction; shared package changes go through `F:\AI2\ai-game-foundation\.worktrees\real-browser-playtest`.
- Keep provider-specific thinking semantics in the RPG application layer; the shared transport only exposes generic protocol metadata.
- Production RPG roles default to `thinking: "off"`; enabling thinking must be an explicit role policy, never inferred from prompt text.
- Do not parse `reasoning_content` as the final RPG response.
- Preserve existing schema validation, deterministic fallback, redacted logging, and API contracts.
- Use the current worktree's uncommitted changes as user-owned work; do not reset or overwrite unrelated changes.

---

### Task 1: Establish the shared transport boundary

**Files:**
- Modify: `F:\AI2\ai-game-foundation\.worktrees\real-browser-playtest\packages\ai-transport\src\index.ts`
- Test: `F:\AI2\ai-game-foundation\.worktrees\real-browser-playtest\packages\ai-transport\src\index.test.ts`
- Modify generated contract artifacts: the package `dist/` files, `package.json`, lockfile, and README

**Interfaces:**
- The shared contract exposes sanitized completion content, failure codes, finish reason, reasoning-token count, and a boolean indicating reasoning content was observed; it never exposes raw reasoning text.
- The RPG client treats `empty_response` as a final-content protocol failure and does not repeat the identical request.

- [x] **Step 1: Confirm the current shared contract:** transport exposes only sanitized completion content/failure code and deliberately owns no retry or product semantics.
- [x] **Step 2: Create the foundation same-name worktree and keep the consumer `.foundation` junction safely linked to it.
- [x] **Step 3: Add safe completion metadata extraction and reasoning-token usage support without exposing raw provider reasoning.
- [x] **Step 4: Run the shared `ai-transport` package tests and rebuild its generated distribution artifacts.

### Task 2: Add the RPG-local unified AI client and role policies

**Files:**
- Create: `src/game/application/server/ai/rpgAiClient.ts`
- Test: `src/game/application/server/ai/rpgAiClient.test.ts`
- Modify: `src/game/application/server/ai/providerRequestOptions.ts`

**Interfaces:**
- `RpgAiRole = "intent" | "opening" | "scene" | "world"`.
- `RpgAiThinking = "off" | "on"`.
- `RpgAiRolePolicy = { thinking, timeoutMs, maxTokens?, jsonMode, maxAttempts }`.
- `createRpgAiClient({ transport, config, logger?, policies? })` returns `{ complete(role, messages): Promise<RpgAiCompletion> }`.
- Default policies use thinking off, existing timeouts/budgets, and role-specific retry limits.

- [x] **Step 1: Write tests for defaults, explicit role-level thinking on/off, nested provider body construction, and one shared transport call path.
- [x] **Step 2: Write tests proving a response with empty final content plus reasoning metadata is not retried with identical options.
- [x] **Step 3: Implement the client, including role-based request options and nested `chat_template_kwargs.enable_thinking`.
- [x] **Step 4: Implement bounded retry only for transient transport failures; return provider protocol failures for source fallback.
- [x] **Step 5: Run the focused client and provider-option tests.

### Task 3: Migrate all production live sources to the unified client

**Files:**
- Modify: `src/game/application/server/ai/sourceFactory.ts`
- Modify: `src/game/application/server/ai/intentParserSourceFactory.ts`
- Modify: `src/game/application/server/ai/openingGenerationSource.ts`
- Modify: `src/game/application/server/ai/liveScenePerformanceSource.ts`
- Modify: `src/game/application/server/ai/liveWorldEvolutionSource.ts`
- Modify: `src/game/application/server/ai/liveIntentParserSource.ts`
- Modify: `src/game/application/server/compositionRoot.ts` only if dependency injection requires it
- Test: the existing source tests plus factory/client integration tests

**Interfaces:**
- Source modules consume the RPG client facade instead of constructing provider options or deciding retry counts.
- `createServerGameEntryPoints` creates one transport and one RPG client, then injects role-bound completion functions into all live sources.

- [x] **Step 1: Add tests for role policies, production role overrides, and the one shared client path.
- [x] **Step 2: Replace direct `transport.complete` calls with client role calls while preserving each source's parsing, validation, fallback, and result markers.
- [x] **Step 3: Give opening generation an explicit bounded output budget instead of passing `undefined` for `max_tokens`.
- [x] **Step 4: Remove source-local duplicate retry loops after the client owns retry policy; preserve source logs and fallback markers.
- [x] **Step 5: Run focused source tests and verify the request bodies contain the expected role policy.

### Task 4: Add diagnostics, provider health behavior, and documentation

**Files:**
- Modify: `src/game/logging` only if an existing redacted event helper is required
- Modify: `docs/agent/AI环境.md`
- Modify: `docs/agent/运行时AI导演与场景表演.md`
- Modify: `docs/Agent文档索引.md`
- Test: client/source logging and failure classification tests

**Interfaces:**
- Log only safe metadata: role, transport failure code, finish reason, latency, and token counters; never prompt, response text, API key, or authorization headers.
- Use stable diagnostics `rpg_ai_provider_reasoning_observed` and `rpg_ai_provider_empty_final_content` when the provider returns reasoning without final content.

- [x] **Step 1: Add tests for redacted diagnostic logging and preserving fallback behavior after provider protocol failure.
- [x] **Step 2: Implement the diagnostics and document that `enable_thinking:false` is a best-effort provider request, not proof of disabled reasoning.
- [x] **Step 3: Document role defaults and the explicit role-level thinking override without reusing evaluation-only environment variables for production runtime.
- [x] **Step 4: Run documentation/standards checks relevant to the changed docs.

### Task 5: Verify the complete change

- [x] **Step 1: Run focused AI source and client tests.
- [x] **Step 2: Run `npm run typecheck`.
- [x] **Step 3: Run `npm test -- --run` after the boundary-test assertion update.
- [x] **Step 4: Run `git diff --check` and inspect `git status --short` to ensure only intended files changed.

> 家族级 `ready:family` 已执行但被外部条件阻断：`F:\AI2\ai-slg-game\.worktrees\real-browser-playtest` 不存在。未使用 `--allow-main-fallback`，避免把 SLG `main` 混入本次共享包验收。

## Self-review

- The provider issue is covered by metadata extraction, explicit role policy, and non-identical retry behavior.
- All four production RPG roles are covered by the migration task.
- Shared transport remains generic; provider-specific policy stays in RPG application code, while safe response metadata is available to diagnose provider behavior.
- Existing fallback and validation behavior remains a source responsibility.
