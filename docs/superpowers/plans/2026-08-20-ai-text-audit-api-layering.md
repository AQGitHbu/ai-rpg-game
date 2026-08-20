# AI Text Audit API Layering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep complete AI/text quality evidence while reducing repeated polling HTTP exchanges to compact operational audit events by default.

**Architecture:** `AI_TEXT_AUDIT` continues to control the complete AI-call and final-story ledger. A separate `GAME_API_AUDIT` setting controls HTTP exchange detail: `compact` by default, `full` for replay/debugging, and `off` to disable game API events. Polling routes (`/api/game/current` and `/api/game/narrative/ensure`) always use compact records unless full mode is explicitly selected; mutation/action routes retain complete request/response bodies in compact mode’s full-business subset.

**Tech Stack:** TypeScript, Next.js server composition root, append-only JSONL recorder, Vitest, Node native CLI tests, Markdown operational documentation.

## Global Constraints

- `AI_TEXT_AUDIT` remains default-on; only `AI_TEXT_AUDIT=off` disables AI-call and story-text auditing.
- Complete `ai_call` input/output and `story_text` events must not be reduced or moved to ordinary diagnostic logs.
- API key, Authorization, cookie, and complete URL values remain excluded from audit records.
- The six canonical `/api/game/**` routes remain unchanged; no compatibility route or client-facing audit API is added.
- Compact polling events contain no request/response text bodies.
- Changes stay in `ai-rpg-game`; no foundation package is modified.

---

### Task 1: Define API audit modes and event contract

**Files:**
- Modify: `src/game/application/server/ai/textAuditTypes.ts`
- Modify: `src/game/application/server/ai/textAuditRecorder.ts`
- Test: `src/game/application/server/ai/textAuditRecorder.test.ts`

**Interfaces:**
- Produce `GameApiAuditMode = "off" | "compact" | "full"`.
- Extend the recorder port with `gameApiMode: GameApiAuditMode` so the composition root can choose body capture without duplicating environment parsing.
- Extend `game_api` payloads with `detail: "compact" | "full"`, `durationMs`, and compact-safe request/response metadata; full events retain the existing sanitized `rawBody`/`json` fields.

- [x] Add mode resolution with `GAME_API_AUDIT` defaulting to `compact`; trim/lowercase `off` and `full`, and treat missing, blank, or other values as `compact`.
- [x] Add type-level variants so a compact event cannot claim to contain complete bodies, while a full event still requires sanitized request and response objects.
- [x] Make `createTextAuditRecorder` expose the resolved mode without changing the existing `enabled`, `record`, or `close` behavior.
- [x] Update recorder fixtures and tests to assert default compact, explicit full, explicit off, and invalid-value fallback.
- [x] Run `npx vitest run src/game/application/server/ai/textAuditRecorder.test.ts` and require all tests to pass.

### Task 2: Split polling capture from business API capture

**Files:**
- Modify: `src/game/application/server/compositionRoot.ts`
- Test: `src/game/application/server/compositionRoot.audit.test.ts`

**Interfaces:**
- Consume `auditRecorder.gameApiMode` and the existing `ROUTE_TRIGGERS` map.
- Produce compact `game_api` entries for polling routes and full entries for meaningful action/mutation routes when `GAME_API_AUDIT=compact`; produce full entries for every route when mode is `full`; produce none for game APIs when mode is `off`.

- [x] Classify `/api/game/current` and `/api/game/narrative/ensure` as polling routes; classify `/api/game`, `/api/game/actions`, `/api/game/prologue/ack`, and `/api/game/dev/current` as business/debug routes.
- [x] Capture request and response body text only when the resolved mode is `full` or when the route is a business/debug route in `compact` mode.
- [x] Emit compact polling metadata with route, method, trigger, trace ID, HTTP status, duration, and boolean body-presence flags; do not include raw body, parsed JSON, prompt, or story text.
- [x] Preserve existing sanitization for every full body and preserve error-name-only behavior for failed handlers.
- [x] Add tests proving default compact polling records omit bodies, business routes retain bodies, full mode captures polling bodies, and off mode emits no `game_api` events.
- [x] Run `npx vitest run src/game/application/server/compositionRoot.audit.test.ts` and require all tests to pass.

### Task 3: Update configuration and audit documentation

**Files:**
- Modify: `.env.example`
- Modify: `docs/agent/AI文本审计.md`
- Modify: `docs/agent/日志与追踪.md`
- Modify: `docs/operations/logging.md`
- Modify: `docs/Agent文档索引.md`

**Interfaces:**
- Document `GAME_API_AUDIT=compact|full|off`, default `compact`, independently from `AI_TEXT_AUDIT`.
- Document that `ai_call` and `story_text` remain the primary quality-analysis events, while polling `game_api` entries are compact operational evidence.

- [x] Add the new environment variable to `.env.example` with the default and the full-debug override.
- [x] Update the AI audit event table and safety/verification notes to describe compact/full `game_api` records without changing AI-call completeness claims.
- [x] Update operator commands with examples for filtering `ai_call`, `story_text`, and optionally `game_api` records.
- [x] Update the document index’s implementation fact from “all API exchanges are full” to the layered mode contract.
- [x] Run `npm run check:standards` and ensure no shared-doc copy is edited.

### Task 4: Validate the layered audit behavior and finish

**Files:**
- Modify: `scripts/aiTextAudit.node-test.mjs` only if CLI verification needs explicit compact-event coverage.

- [x] Run `npm run typecheck`.
- [x] Run `npm run test:boundaries`.
- [x] Run `npm run test:game-application`.
- [x] Run `npm run test:ai-text-audit`.
- [x] Run `npm run build`.
- [ ] Run `git diff --check`, review the diff, commit the implementation, fast-forward merge it to `main`, and use `npm run branch:finish -- ai-text-audit-layering` to remove the junction-backed worktree and merged local branch.
