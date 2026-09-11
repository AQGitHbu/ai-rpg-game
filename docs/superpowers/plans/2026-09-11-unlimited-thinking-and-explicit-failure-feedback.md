# Unlimited Thinking Budget and Explicit Provider Failure Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent thinking-enabled staged planning requests from exhausting a fixed `max_tokens` cap before final JSON is produced, and preserve actionable provider failure details in the next automatic repair request.

**Architecture:** Keep the role policy as the source of requested budgets, enforce the thinking-mode invariant at the shared provider-request builder, and make the staged live source translate provider failures into structured `AiSourceFailure` repair reason/detail values. The staged planning job will also mark retries with the existing content-repair audit context.

**Tech Stack:** TypeScript, Vitest, `@ai-game/ai-transport`, staged narrative generation runtime, SQLite-backed audit logs.

## Global Constraints

- Work only in `F:/AI2/ai-rpg-game/.worktrees/staged-narrative-generation`.
- Preserve unrelated user changes already present in the worktree.
- Thinking enabled means the provider request must omit `max_tokens`; thinking disabled keeps the existing bounded role budgets.
- Failure feedback must be concise, stable, and safe to persist; do not pass arbitrary provider response text into prompts.
- Do not introduce deterministic narrative fallback for an AI generation failure.

## Task 1: Remove the fixed output cap for thinking-enabled requests

**Files:**
- Modify `src/game/application/server/ai/providerRequestOptions.ts`
- Modify `src/game/application/server/ai/providerRequestOptions.test.ts`
- Modify `src/game/application/server/ai/rpgAiClient.ts`
- Modify `src/game/application/server/ai/rpgAiClient.test.ts`

- [x] Add the shared request-builder invariant: when `thinking` is `"on"`, omit the effective `max_tokens` request field while preserving any explicitly requested low temperature; when thinking is off, preserve current behavior.
- [x] Remove the default `6_000` planning cap so the default staged planning policy is explicitly unbounded while retaining its timeout, thinking switch, JSON prompt mode, and retry count.
- [x] Make the client’s audit metadata report the effective budget, so an omitted provider cap is not logged as if it were sent.
- [x] Update unit tests to cover both sides of the invariant: thinking on ignores a passed cap, and thinking off still sends the cap.
- [x] Run the focused provider request/client tests.

## Task 2: Preserve explicit provider failure feedback for the next attempt

**Files:**
- Modify `src/game/application/server/ai/staged/liveStageSource.ts`
- Modify `src/game/application/server/ai/staged/liveStageSource.test.ts`
- Modify `src/game/application/narrativeGeneration/runJob.ts`
- Modify `src/game/application/narrativeGeneration/runJob.test.ts`

- [x] Translate provider `empty_response` failures into `repairReason: "empty_response"` and include a stable detail describing `finishReason=length`, observed reasoning tokens, and the missing final JSON when those metadata are present.
- [x] Translate other provider transport failures into the existing `provider_failure` category while including the concrete transport code in `repairDetail`.
- [x] Keep schema/parser failures on their existing `invalid_schema` path and do not expose raw provider content.
- [x] Pass the existing `aiRepairAuditContext` on the staged planning retry so the audit event records a content-repair retry rather than another initial call.
- [x] Add focused tests proving the detail survives from the live source to the retry request and that the retry audit context is marked correctly.

## Task 3: Verification and handoff

**Files:**
- No production files unless verification exposes a regression.

- [x] Run the focused Vitest files for provider options, RPG AI client, live stage source, and narrative job retry behavior.
- [x] Run the repository’s relevant typecheck/lint command if available without changing dependency state.
- [x] Review the diff and report the observed behavior, tests, and any unrelated pre-existing worktree changes left untouched.
