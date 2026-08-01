# Shared Logging Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the proven, game-agnostic logging substrate from `ai-slg-game` into `@ai-game/logging`, then migrate RPG and SLG to use the same durable, queryable, redacted logging infrastructure.

**Architecture:** `@ai-game/logging` owns the generic event envelope, trace IDs, timestamps, redaction, validation, payload limits, sink interface, JSONL sink, independent SQLite log database, migrations, bounded queue, fallback behavior, and retention/query primitives. Each game keeps a thin local facade and owns its event names, business fields, request/use-case instrumentation, and product-specific read models; neither game DB nor gameplay state is placed in foundation.

**Tech Stack:** TypeScript, Node ESM package workspaces, `@libsql/client` 0.17.3, SQLite/WAL, JSONL, Vitest/Node test runner, Next.js server composition roots.

## Global Constraints

- Work only in same-named `codex/shared-logging` worktrees under `.worktrees/` in foundation, SLG, and RPG; do not modify any repository main checkout.
- The shared package is `private: true`, consumed only through `file:.foundation/packages/logging`, and must publish a public root export with no deep-import requirement.
- Foundation production code must not import either game's domain, gameplay, application, UI, prompt, or persistence types.
- Game state databases and log databases must be physically separate; log sink failures must never fail a gameplay request, save transaction, fallback, or deterministic rule result.
- All persisted events include a server-created or validated `traceId`, `occurredAtMs`, normalized timestamp, `level`, `category`, `event`, `source`, and bounded context fields; raw request bodies, player input, API keys, credentials, prompts, model output, full saves, and database URLs are forbidden.
- The shared package reads no product environment variables; consumers resolve environment configuration and pass explicit sink options.
- Every shared package change requires package tests, rebuilt committed `dist/`, two consumer contract tests, and the foundation family gate before consumer acceptance.

---

### Task 1: Create the public `@ai-game/logging` package

**Files:**
- Create: `F:\AI2\ai-game-foundation\packages\logging\package.json`
- Create: `F:\AI2\ai-game-foundation\packages\logging\tsconfig.json`
- Create: `F:\AI2\ai-game-foundation\packages\logging\src\index.ts`
- Create: `F:\AI2\ai-game-foundation\packages\logging\src\logTypes.ts`
- Create: `F:\AI2\ai-game-foundation\packages\logging\src\traceId.ts`
- Create: `F:\AI2\ai-game-foundation\packages\logging\src\redactLogData.ts`
- Create: `F:\AI2\ai-game-foundation\packages\logging\src\logValidation.ts`
- Create: `F:\AI2\ai-game-foundation\packages\logging\src\gameLogger.ts`
- Create: `F:\AI2\ai-game-foundation\packages\logging\src\logWriteQueue.ts`
- Create: `F:\AI2\ai-game-foundation\packages\logging\src\sinks\logSink.ts`
- Create: `F:\AI2\ai-game-foundation\packages\logging\src\sinks\jsonlLogSink.ts`
- Create: `F:\AI2\ai-game-foundation\packages\logging\src\sinks\sqliteLogSink.ts`
- Create: `F:\AI2\ai-game-foundation\packages\logging\src\sqlite\logDatabase.ts`
- Create: `F:\AI2\ai-game-foundation\packages\logging\src\sqlite\migrationRunner.ts`
- Create: `F:\AI2\ai-game-foundation\packages\logging\src\sqlite\migrations\index.ts`
- Create: `F:\AI2\ai-game-foundation\packages\logging\src\sqlite\migrations\000_schema_migrations.ts`
- Create: `F:\AI2\ai-game-foundation\packages\logging\src\sqlite\migrations\001_log_events.ts`
- Create: `F:\AI2\ai-game-foundation\packages\logging\src\sqlite\migrations\002_log_context.ts`
- Create: `F:\AI2\ai-game-foundation\packages\logging\src\sqlite\logRetention.ts`
- Create: `F:\AI2\ai-game-foundation\packages\logging\src\logSinkFactory.ts`
- Create: `F:\AI2\ai-game-foundation\packages\logging\src\index.test.ts`
- Modify: `F:\AI2\ai-game-foundation\package.json`
- Modify: `F:\AI2\ai-game-foundation\package-lock.json`
- Modify: `F:\AI2\ai-game-foundation\README.md`
- Modify: `F:\AI2\ai-game-foundation\CHANGELOG.md`
- Modify: `F:\AI2\ai-game-foundation\packages\standards\catalog\共享模块目录.json`

**Interfaces:**

- `LogEvent` carries `level: "debug" | "info" | "warn" | "error"`, string `category`, string `event`, `traceId`, optional `durationMs`, `data`, and a redacted `error` object.
- `LogContext` carries `scope: "request" | "system" | "migration" | "legacy"`, `source`, and optional `accountId`, `gameId`, `saveId`, `sessionId`, and `scenarioId`; no consumer-specific faction/NPC/quest types are exported.
- `PersistedLogEvent` adds `id`, `occurredAtMs`, normalized timestamp, schema version, context, detail mode, truncation metadata, and import provenance.
- `LogSink` is `{ write(event): Promise<void>; flush(): Promise<void>; close(): Promise<void> }`.
- `createLogger(options)` returns fire-and-forget `debug/info/warn/error` methods plus `flush` and `close`; each write performs redaction, validation, byte-limit truncation, level filtering, and sink-failure isolation.
- `createLogSink({ backend, sqlitePath, jsonlDir })` constructs an explicit SQLite or JSONL sink; it does not inspect `process.env`.
- `SqliteLogSink` supports `queryByTraceId`, `queryByContext`, `queryByEvent`, and `queryByTimeRange`; its database owns only `schema_migrations` and `log_events`.
- `runLogRetention` deletes ordinary events in bounded batches while preserving a separately configured longer audit retention period.

- [ ] **Step 1: Add the package manifest and TypeScript build contract**

Use `@libsql/client: "0.17.3"`, `private: true`, `type: "module"`, `main: "./dist/index.js"`, `types: "./dist/index.d.ts"`, and an export map exposing only `.` and `./package.json`. Add `build` and `test` scripts matching the existing `ai-transport` package and add workspace scripts for build/test/pack.

- [ ] **Step 2: Write failing tests for the generic envelope and sinks**

Cover timestamp creation, trace ID validation/regeneration, nested redaction of credentials/prompts/session data, max-payload replacement with hash metadata, level filtering, sink failure isolation, JSONL one-event-per-line output, independent SQLite schema creation, query by trace/context/event/time, migration idempotency/future-version rejection, bounded queue fallback, and retention batch limits.

- [ ] **Step 3: Implement the event envelope and safety pipeline**

Build the event in this order: `toPersistedEvent` → `redactSensitiveData` on `data/error` → `validateEvent` → `truncateIfNeeded` → configured sink. Use `Date.now()` for `occurredAtMs`, an ISO-like local-offset timestamp compatible with the existing SLG format, a bounded trace pattern, and a stable `eventSchemaVersion`.

- [ ] **Step 4: Implement JSONL, SQLite, queue, migrations, and retention**

Use daily `game-YYYY-MM-DD.jsonl` files for JSONL. Use an independent SQLite path with WAL and `busy_timeout`; create indexed `log_events` columns for time, trace, context, level, and event. Use a bounded async queue that preferentially drops debug/info, never silently drops error, and writes failed batches to a JSONL fallback when configured. Do not attach the game database or share its transaction.

- [ ] **Step 5: Build the package and inspect its public surface**

Run `npm test --workspace @ai-game/logging`, `npm run build --workspace @ai-game/logging`, and `npm run internal:check`. Confirm `dist/` is deterministic, the package exposes no deep imports, and no foundation source imports an RPG/SLG path.

- [ ] **Step 6: Commit the foundation package**

Stage only the new package, workspace metadata, catalog, README, and changelog, then commit with `feat: add shared structured logging package`.

### Task 2: Migrate RPG to the shared durable logger

**Files:**
- Modify: `F:\AI2\ai-rpg-game\package.json`
- Modify: `F:\AI2\ai-rpg-game\package-lock.json`
- Modify: `F:\AI2\ai-rpg-game\.env.example`
- Modify: `F:\AI2\ai-rpg-game\src\game\logging\logTypes.ts`
- Modify: `F:\AI2\ai-rpg-game\src\game\logging\gameLogger.ts`
- Modify: `F:\AI2\ai-rpg-game\src\game\logging\redactLogData.ts`
- Modify: `F:\AI2\ai-rpg-game\src\game\logging\serverConsoleLogger.ts`
- Modify: `F:\AI2\ai-rpg-game\src\game\logging\index.ts`
- Modify: `F:\AI2\ai-rpg-game\src\game\application\server\compositionRoot.ts`
- Modify: `F:\AI2\ai-rpg-game\src\app\api\game\route.ts`
- Modify: `F:\AI2\ai-rpg-game\src\app\api\game\actions\route.ts`
- Modify: `F:\AI2\ai-rpg-game\src\app\api\game\current\route.ts`
- Modify: `F:\AI2\ai-rpg-game\src\app\api\game\dev\current\route.ts`
- Modify: `F:\AI2\ai-rpg-game\src\app\api\game\narrative\ensure\route.ts`
- Modify: `F:\AI2\ai-rpg-game\src\app\api\game\town\ensure\route.ts`
- Modify: `F:\AI2\ai-rpg-game\src\app\api\game\npc\dialogue\route.ts`
- Modify: `F:\AI2\ai-rpg-game\src\game\application\performAction.ts`
- Modify: `F:\AI2\ai-rpg-game\src\game\application\handleNpcDialogue.ts`
- Modify: `F:\AI2\ai-rpg-game\src\game\application\getCurrentGame.ts`
- Modify: `F:\AI2\ai-rpg-game\src\game\application\createGame.ts`
- Modify: `F:\AI2\ai-rpg-game\src\game\application\server\persistence\sqliteGameRepository.ts`
- Create: `F:\AI2\ai-rpg-game\src\game\application\server\logging\serverLogFactory.ts`
- Create: `F:\AI2\ai-rpg-game\src\game\application\server\logging\requestLog.ts`
- Modify: `F:\AI2\ai-rpg-game\src\game\logging\gameLogger.test.ts`
- Create: `F:\AI2\ai-rpg-game\src\game\application\server\logging\serverLogFactory.test.ts`
- Create: `F:\AI2\ai-rpg-game\src\game\application\server\logging\requestLog.test.ts`
- Modify: `F:\AI2\ai-rpg-game\src\game\application\server\compositionRoot.test.ts`
- Modify: `F:\AI2\ai-rpg-game\src\dependencyBoundaries.test.ts`
- Modify: `F:\AI2\ai-rpg-game\docs\agent\日志与追踪.md`
- Modify: `F:\AI2\ai-rpg-game\docs\Agent文档索引.md`
- Modify: `F:\AI2\ai-rpg-game\docs\游戏开发规范.md`

**Interfaces:**

- Keep the local `GameLogger.info/warn/error(event, details)` facade as an RPG compatibility layer, but implement it by calling `@ai-game/logging`; no local redaction, queue, JSONL, SQLite, migration, or retention implementation remains.
- Add `GAME_LOG_ENABLED`, `GAME_LOG_LEVEL`, `GAME_LOG_DETAIL`, `GAME_LOG_SINK`, `GAME_LOG_DB_PATH`, `GAME_LOG_DIR`, and `GAME_LOG_MAX_EVENT_BYTES` to the server-only environment contract. The default RPG log database is `db/logs.db`, separate from `GAME_DB_PATH`/`db/rpg.sqlite`.
- Make server composition initialize one shared log client and one dedicated log sink; `close()` flushes and closes the log sink independently of the game repository.
- Use request trace IDs for all API routes. Log only route/source, operation, result code, HTTP status, latency, and safe context; never log request bodies or player text.
- Add stable RPG operational events for request completion/failure, game creation/load, action resolution, NPC dialogue handling, background task outcome, AI provider/approval outcome, and SQLite repository failures. Keep gameplay event names and AI business categories in RPG.
- For test composition roots, inject an in-memory sink or disabled logger so tests do not write a shared `db/logs.db`.

- [ ] **Step 1: Add the foundation dependency and failing RPG contract tests**

Assert that the RPG facade uses the package redactor, that production composition selects the configured SQLite/JSONL backend, that game and log database paths differ, that request logs contain a trace/timestamp/result but no request body, and that a failing log sink does not change an action result.

- [ ] **Step 2: Replace RPG bottom-layer implementation with a package adapter**

Delete the local recursive redaction/console-only behavior from the production path. Keep only RPG event-to-generic-event mapping, event-category mapping, optional no-op injection, and the test memory writer in the local facade. The only direct `console` sink remains the shared package fallback selected by the server composition root.

- [ ] **Step 3: Add dedicated log sink composition**

Create the sink from explicit server configuration, defaulting to `GAME_LOG_SINK=sqlite` and `GAME_LOG_DB_PATH=./db/logs.db`; configure JSONL fallback at `GAME_LOG_DIR=./logs`. Keep `GAME_DB_PATH` exclusively owned by the game repository. Ensure log initialization/migration failure falls back to console/JSONL and never prevents deterministic game entry points from being created.

- [ ] **Step 4: Add request and use-case coverage**

Generate/validate a trace at each API route, pass the trace into the application command where available, and emit only safe lifecycle metadata. Instrument create/current/action/NPC dialogue/background ensure paths and repository failure paths. Preserve every existing stable HTTP code and gameplay result.

- [ ] **Step 5: Run RPG focused tests and update boundaries**

Run `npm run test:game-logging`, the new server logging tests, `npm run test:app`, `npm run test:game-application`, `npm run test:boundaries`, and `npm run typecheck`. Verify no RPG source imports shared package internals or directly calls console.

- [ ] **Step 6: Commit the RPG consumer**

Commit the RPG package dependency, adapter, composition, instrumentation, tests, and agent documentation with `feat: use shared durable logging in RPG`.

### Task 3: Migrate SLG to consume the same package

**Files:**
- Modify: `F:\AI2\ai-slg-game\package.json`
- Modify: `F:\AI2\ai-slg-game\package-lock.json`
- Modify: `F:\AI2\ai-slg-game\src\game\logging\logTypes.ts`
- Modify: `F:\AI2\ai-slg-game\src\game\logging\gameLogger.ts`
- Modify: `F:\AI2\ai-slg-game\src\game\logging\redactLogData.ts`
- Modify: `F:\AI2\ai-slg-game\src\game\logging\logValidation.ts`
- Modify: `F:\AI2\ai-slg-game\src\game\logging\logWriteQueue.ts`
- Modify: `F:\AI2\ai-slg-game\src\game\logging\logSinkFactory.ts`
- Modify: `F:\AI2\ai-slg-game\src\game\logging\sinks\jsonlLogSink.ts`
- Modify: `F:\AI2\ai-slg-game\src\game\logging\sinks\sqliteLogSink.ts`
- Modify: `F:\AI2\ai-slg-game\src\game\logging\sqlite\logDatabase.ts`
- Modify: `F:\AI2\ai-slg-game\src\game\logging\sqlite\migrationRunner.ts`
- Modify: `F:\AI2\ai-slg-game\src\game\logging\sqlite\migrations\index.ts`
- Modify: `F:\AI2\ai-slg-game\src\game\logging\sqlite\logRetention.ts`
- Modify: `F:\AI2\ai-slg-game\src\game\logging\index.ts`
- Modify: `F:\AI2\ai-slg-game\src\game\logging\turnLogger.ts`
- Create: `F:\AI2\ai-slg-game\src\game\logging\sharedLoggingAdapter.test.ts`
- Modify: `F:\AI2\ai-slg-game\src\game\logging\logSinkFactory.test.ts`
- Modify: `F:\AI2\ai-slg-game\src\game\logging\sqlite\logDatabase.test.ts`
- Modify: `F:\AI2\ai-slg-game\src\game\logging\sinks\sqliteLogSink.test.ts`
- Modify: `F:\AI2\ai-slg-game\docs\operations\persistence-and-logging.md`

**Interfaces:**

- Preserve SLG's product-facing `createTurnLogger`, event-name strings, `turn`, `factionId`, and existing query behavior in a thin adapter; move all durable logging mechanics to the foundation package.
- Map SLG-specific turn/faction diagnostics into generic event `data`/dimensions rather than adding SLG domain imports to foundation.
- Preserve existing `logs.db` migration compatibility and JSONL import behavior; add a shared-package migration only when required to retain existing rows and indexes.
- Keep `LogPort` as a core-facing SLG port if it is needed for dependency direction, but its implementation must call the shared public package and not duplicate sinks/redaction/SQLite code.

- [ ] **Step 1: Add the package dependency and write the consumer contract**

Assert through the public `@ai-game/logging` import that SLG can persist/query an event, redact sensitive data, flush/close a sink, and keep an existing `logs.db` readable.

- [ ] **Step 2: Replace local infrastructure with compatibility adapters**

Re-export or delegate the local types/functions to the package where no SLG-specific type is involved. Keep only `StateChange`, turn logger binding, SLG event aliases, and product-specific data mapping locally.

- [ ] **Step 3: Verify migration/import/retention compatibility**

Run existing logging, SQLite, import, and retention tests against temporary databases; explicitly test reopening a pre-package `logs.db` and querying imported JSONL without duplicate rows.

- [ ] **Step 4: Run SLG consumer gates**

Run `npm run lint`, `npm run typecheck`, `npm run test:boundaries`, the logging test subset, `npm test`, and `npm run build`.

- [ ] **Step 5: Commit the SLG consumer**

Commit with `feat: consume shared logging package in SLG`.

### Task 4: Family documentation and coordinated acceptance

**Files:**
- Modify: `F:\AI2\ai-game-foundation\packages\standards\catalog\共享模块目录.json`
- Modify: `F:\AI2\ai-game-foundation\README.md`
- Modify: `F:\AI2\ai-game-foundation\CHANGELOG.md`
- Modify: `F:\AI2\ai-rpg-game\docs\agent\日志与追踪.md`
- Modify: `F:\AI2\ai-rpg-game\docs\Agent文档索引.md`
- Modify: `F:\AI2\ai-rpg-game\docs\游戏开发规范.md`
- Modify: `F:\AI2\ai-slg-game\docs\operations\persistence-and-logging.md`

**Interfaces:**

- The catalog records `@ai-game/logging` as `shared-local`, with exports and non-goals: no game events, no gameplay state, no prompts, no player-facing log UI, and no product persistence.
- RPG and SLG docs record their own event vocabulary and explicitly distinguish the shared operational log database from each game's save database.
- The operations runbook documents stdout/stderr fallback, `logs.db` backup/retention, disk-space alerting, migration/future-schema behavior, and the rule that log DB failure cannot fail gameplay.

- [ ] **Step 1: Update implementation facts and shared catalog**

Document the package version, public API, consumer adapters, separate database paths, environment configuration, and test commands. Do not edit generated `docs/共同规范/` copies directly.

- [ ] **Step 2: Run package and consumer validation**

From the foundation same-named worktree, run `npm run family:setup`, `npm run validate:family`, `npm run internal:check`, and `npm run ready:family`. Confirm all three repositories resolve the same `@ai-game/logging` worktree and no consumer uses foundation main as a fallback.

- [ ] **Step 3: Inspect repository state and final handoff**

Run `git status --short` in all three worktrees, confirm no `db/`, `logs/`, `tmp/`, `.env.local`, or test artifacts are tracked, and report the three commit IDs, package version, default log path, query capabilities, fallback behavior, and any acceptance limitation.

