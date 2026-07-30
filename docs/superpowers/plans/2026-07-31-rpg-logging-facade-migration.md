# RPG Logging Facade Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace production-level direct `console` calls with a redacted, structured RPG logging facade injected from the server composition root.

**Architecture:** `src/game/logging/` remains product-local, game-agnostic infrastructure. Its root facade exposes the logger port and pure redaction/entry formatting; the composition root owns the console sink and injects the port into SQLite and AI adapters. Application code receives the port as an optional dependency and defaults to a no-op logger for deterministic unit tests.

**Tech Stack:** TypeScript, Vitest, Next.js server composition root, SQLite via `@libsql/client`, `@ai-game/ai-transport`.

## Global Constraints

- Log only whitelisted event metadata; never emit API keys, Authorization, cookies, prompts, model output, player input, database URLs, or complete saves.
- UI, store, page, API, domain, and gameplay code must not import the server console sink.
- `src/game/logging/` must not import RPG domain, gameplay, application, UI, store, API, or `@ai-game/*` packages.
- Preserve existing AI failures, fallback results, repository error codes, and test injection seams.
- Keep the module inside RPG: it has no second consumer and must not be moved to foundation.

---

### Task 1: Add the logging port, redaction, and console sink

**Files:**
- Create: `src/game/logging/logTypes.ts`
- Create: `src/game/logging/redactLogData.ts`
- Create: `src/game/logging/gameLogger.ts`
- Create: `src/game/logging/index.ts`
- Create: `src/game/logging/serverConsoleLogger.ts`
- Test: `src/game/logging/gameLogger.test.ts`

**Interfaces:**
- Produces: `GameLogger`, `GameLogEntry`, `NOOP_GAME_LOGGER`, `createGameLogger`, and `createServerConsoleLogger`.
- Consumed by: application orchestration and server composition/adapters in Tasks 2 and 3.

- [x] **Step 1: Write failing logger tests**

```ts
const entries: GameLogEntry[] = [];
const logger = createGameLogger({ write: (entry) => entries.push(entry) });
logger.warn("runtime_narrative_approval", { traceId: "trace-1", apiKey: "secret" });
expect(entries[0]).toMatchObject({ level: "warn", event: "runtime_narrative_approval", details: { traceId: "trace-1", apiKey: "[REDACTED]" } });
```

- [x] **Step 2: Run the logger test to verify it fails**

Run: `npm test -- src/game/logging/gameLogger.test.ts`

Expected: FAIL because `@/game/logging` does not yet export `createGameLogger`.

- [x] **Step 3: Implement the minimal logger facade**

```ts
export type GameLogger = Readonly<{
  info(event: string, details?: Readonly<Record<string, unknown>>): void;
  warn(event: string, details?: Readonly<Record<string, unknown>>): void;
  error(event: string, details?: Readonly<Record<string, unknown>>): void;
}>;

export const NOOP_GAME_LOGGER: GameLogger = { info() {}, warn() {}, error() {} };
```

Build entries through a recursive key-based redactor and let only `serverConsoleLogger.ts` call `console.log`, `console.warn`, or `console.error`.

- [x] **Step 4: Run the logger test to verify it passes**

Run: `npm test -- src/game/logging/gameLogger.test.ts`

Expected: PASS; the secret value and nested authorization fields are redacted.

### Task 2: Migrate AI, narrative, and SQLite logging to the injected port

**Files:**
- Modify: `src/game/application/orchestrateNarrativeScene.ts`
- Modify: `src/game/application/generatePendingNarrativeScene.ts`
- Modify: `src/game/application/getOrCreateScene.ts`
- Modify: `src/game/application/server/ai/liveRuntimeNarrativeSources.ts`
- Modify: `src/game/application/server/ai/liveTownPlanSource.ts`
- Modify: `src/game/application/server/ai/scenarioGenerationAudit.ts`
- Modify: `src/game/application/server/ai/scenarioCandidateSourceFactory.ts`
- Modify: `src/game/application/server/ai/runtimeNarrativeSourceFactory.ts`
- Modify: `src/game/application/server/ai/townPlanSourceFactory.ts`
- Modify: `src/game/application/server/ai/runtimeNarrativeTaskCoordinator.ts`
- Modify: `src/game/application/server/ai/townPlanTaskCoordinator.ts`
- Modify: `src/game/application/server/compositionRoot.ts`
- Modify: `src/game/application/server/persistence/sqliteGameRepository.ts`
- Test: `src/game/application/orchestrateNarrativeScene.test.ts`
- Test: `src/game/application/server/ai/townPlanSource.test.ts`
- Test: `src/game/application/server/ai/runtimeNarrativeTaskCoordinator.test.ts`
- Test: `src/game/application/server/ai/townPlanTaskCoordinator.test.ts`

**Interfaces:**
- Consumes: `GameLogger` and `NOOP_GAME_LOGGER` from Task 1.
- Produces: the same use-case and provider result types as before, with log event delivery occurring through `GameLogger` rather than direct console calls.

- [x] **Step 1: Write failing migration assertions**

```ts
const entries: GameLogEntry[] = [];
await orchestrateNarrativeScene({ ...input, logger: createGameLogger({ write: (entry) => entries.push(entry) }) });
expect(entries).toContainEqual(expect.objectContaining({ event: "runtime_narrative_approval", level: "warn" }));
```

- [x] **Step 2: Run affected tests to verify the new assertion fails**

Run: `npm test -- src/game/application/orchestrateNarrativeScene.test.ts src/game/application/server/ai/townPlanSource.test.ts`

Expected: FAIL because the orchestrator input has no `logger` field.

- [x] **Step 3: Thread `GameLogger` from the composition root**

```ts
const logger = createServerConsoleLogger();
const repository = createSqliteGameRepository({
  clientFactory: createServerSqliteClientFactory(env),
  logError: (operation) => logger.error("sqlite_repository_failure", { operation }),
});
```

Use `NOOP_GAME_LOGGER` for optional pure-application paths. Emit stable event names and fields only: `runtime_narrative_approval`, `runtime_narrative`, `town_plan`, `scenario_generation`, `runtime_narrative_task`, `town_plan_task`, and `sqlite_repository_failure`.

- [x] **Step 4: Run focused migration tests**

Run: `npm test -- src/game/application/orchestrateNarrativeScene.test.ts src/game/application/server/ai/townPlanSource.test.ts src/game/application/server/ai/runtimeNarrativeTaskCoordinator.test.ts src/game/application/server/ai/townPlanTaskCoordinator.test.ts`

Expected: PASS; all AI/repository outcomes remain unchanged and log entries are structured/redacted.

### Task 3: Enforce the boundary and update implementation documentation

**Files:**
- Modify: `src/dependencyBoundaries.test.ts`
- Create: `src/game/logging/dependencyBoundaries.test.ts`
- Create: `docs/agent/日志与追踪.md`
- Modify: `docs/Agent文档索引.md`
- Modify: `docs/游戏开发规范.md`
- Test: `src/dependencyBoundaries.test.ts`
- Test: `src/game/logging/dependencyBoundaries.test.ts`

**Interfaces:**
- Consumes: the facade from Task 1 and migrated import paths from Task 2.
- Produces: automated guards that permit direct console use only in `serverConsoleLogger.ts` and prevent logging from importing game/product layers.

- [x] **Step 1: Write boundary tests**

```ts
expect(findProductionConsoleCalls()).toEqual([]);
expect(loggingImportsGameLayer()).toEqual([]);
```

- [x] **Step 2: Run the boundary suite to verify the guard**

Run: `npm run test:boundaries`

Expected: FAIL until the new logging facade and direct-console exception are represented in the scanner.

- [x] **Step 3: Add explicit logging rules and documentation**

Document the root facade, server-sink-only console exception, redaction policy, stable event names, and the `traceId` requirement. Add the new logging system to the Agent index.

- [x] **Step 4: Run full relevant verification**

Run: `npm run test:boundaries && npm run typecheck && npm test -- src/game/logging/gameLogger.test.ts src/game/application/orchestrateNarrativeScene.test.ts src/game/application/server/ai/townPlanSource.test.ts`

Expected: all commands exit `0`.

- [ ] **Step 5: Commit**

```powershell
git add src/game/logging src/game/application src/dependencyBoundaries.test.ts docs/游戏开发规范.md docs/agent/日志与追踪.md docs/Agent文档索引.md docs/superpowers/plans/2026-07-31-rpg-logging-facade-migration.md
git commit -m "feat: add RPG structured logging facade"
```
