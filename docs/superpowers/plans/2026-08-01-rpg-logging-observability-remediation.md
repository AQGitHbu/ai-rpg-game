# RPG Logging Observability Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 RPG 消费者无法解析共享日志包的问题，并补齐请求关联、稳定结果、规则决策、AI 后台任务和基础运维所需的安全日志。

**Architecture:** 保持 `@ai-game/logging` 作为通用底座，RPG 只在本仓的 `src/game/logging` facade 和 server composition root 定义 RPG 事件与白名单字段。HTTP route 在 composition root 创建请求上下文，所有早期校验、use-case、AI 和后台任务共享同一个 traceId；日志只记录稳定 ID、分类、计数、耗时和结果，不记录玩家原文、prompt、模型输出或密钥。保留游戏 `eventLedger` 作为玩家可见事实来源，不把完整存档复制进运维日志。

**Tech Stack:** TypeScript strict、Next.js route handlers、Vitest、`@ai-game/logging`、SQLite/JSONL。

## Global Constraints

- 当前 Phase 13 已完成，`sharedInfrastructureChangeAllowed: false`；本次不修改 `../ai-game-foundation`，只修复 RPG 消费者和已有 shared package 的本地链接使用。
- 只能从 `@/game/logging` 使用 RPG logger；只有 `src/game/logging/serverConsoleLogger.ts` 保留直接 console fallback。
- 日志不得包含 API key、Authorization、cookie、完整 prompt、模型原文、玩家输入、异常 message/stack、完整存档或数据库连接信息。
- 异步玩家请求、其 use-case、provider audit 和后台任务必须尽可能复用同一个 traceId；没有外部 trace 时由 server 生成并在响应头返回。
- 日志写入失败、初始化失败、保留任务失败都不能改变规则结果或阻塞游戏请求。
- 不改变已有 API body/status 契约；仅增加安全的 `X-Request-Trace-Id` response header。
- 保留工作区已有的用户文档修改，不使用 destructive git 操作。

---

### Task 1: 恢复共享日志消费者依赖并建立失败回归

**Files:**
- Modify: `node_modules` only through the package manager; do not hand-edit it
- Test: `src/game/logging/serverConsoleLogger.test.ts`
- Test: `src/game/logging/gameLogger.test.ts`

**Interfaces:**
- `package.json` and `package-lock.json` already declare `@ai-game/logging: file:.foundation/packages/logging`.
- The installed package must expose both `@ai-game/logging` and `@ai-game/logging/redaction`.

- [x] **Step 1: Verify the package and lockfile before installation**

Run:

```powershell
Test-Path .foundation/packages/logging/dist/index.d.ts
Test-Path .foundation/packages/logging/dist/redactLogData.d.ts
Test-Path node_modules/@ai-game/logging
npm ls @ai-game/logging --depth=0
```

Expected: foundation dist files exist; the consumer package is currently missing or unresolved.

- [x] **Step 2: Restore the consumer install from the committed lockfile**

Run:

```powershell
npm ci --ignore-scripts
```

Expected: `node_modules/@ai-game/logging` resolves to `.foundation/packages/logging` and no package lock diff is produced. If npm reports a lock mismatch, stop before editing the lockfile and inspect the exact mismatch.

- [x] **Step 3: Run the focused logging tests and typecheck**

Run:

```powershell
npm run test:game-logging
npm run typecheck
```

Expected: the previous module-resolution failures disappear; any remaining failure is a real implementation failure to fix in later tasks.

---

### Task 2: Add one HTTP request context and propagate its traceId

**Files:**
- Modify: `src/game/application/server/compositionRoot.ts`
- Create: `src/game/logging/requestLog.ts`
- Modify: `src/app/api/game/route.ts`
- Modify: `src/app/api/game/actions/route.ts`
- Modify: `src/app/api/game/current/route.ts`
- Modify: `src/app/api/game/npc/dialogue/route.ts`
- Modify: `src/app/api/game/narrative/ensure/route.ts`
- Modify: `src/app/api/game/town/ensure/route.ts`
- Modify: `src/app/api/game/dev/current/route.ts`
- Modify: all seven corresponding `*Handler.ts` files
- Test: create `src/game/logging/requestLog.test.ts`
- Test: add HTTP wrapper/header assertions to `src/game/application/server/compositionRoot.test.ts`

**Interfaces:**

`requestLog.ts` produces a server-only-safe value object:

```ts
export type RequestLogContext = Readonly<{
  traceId: string;
  method: string;
  route: string;
  startedAtMs: number;
  markResultCode(code: string | undefined): void;
  resultCode(): string | undefined;
}>;
```

`ServerGameEntryPoints` adds:

```ts
executeHttpRequest(
  method: string,
  route: string,
  handler: (context: RequestLogContext) => Promise<Response>,
  traceId?: string
): Promise<Response>;
```

All existing entry points that represent a player request accept an optional `traceId` argument. `runLoggedUseCase` uses that value instead of generating a second UUID. `executeHttpRequest` logs `http_request_started` and `http_request_completed`/`http_request_failed`, recording only method, route, HTTP status, result code, and duration, and sets `X-Request-Trace-Id` on the returned response.

- [x] **Step 1: Write failing request-context tests**

Cover:

```ts
it("keeps one supplied traceId and records a stable result code", () => {
  const context = createRequestLogContext({ traceId: "trace_test_1", method: "POST", route: "/api/game", now: () => 100 });
  context.markResultCode("INVALID_INTENT");
  expect(context.traceId).toBe("trace_test_1");
  expect(context.resultCode()).toBe("INVALID_INTENT");
});
```

Also assert that an HTTP request response receives exactly the generated trace header and that its completion event contains `httpStatus` and `durationMs`.

- [x] **Step 2: Implement the context and composition-root HTTP wrapper**

Use `randomUUID()` only when no valid incoming trace is supplied. Normalize the route into the log source, call the handler once, log `response.status` in `http_request_completed`, and clone the response only to add the header. Never inspect or serialize the request body.

- [x] **Step 3: Thread the context into every route and handler**

Each route follows this shape:

```ts
const entryPoints = getServerGameEntryPoints();
return entryPoints.executeHttpRequest("POST", "/api/game", (context) =>
  handleCreateGameRequest(request, entryPoints, context)
);
```

Handlers pass `context.traceId` to the matching entry point. Their local `json`/`Response.json` helper calls `context.markResultCode` from the stable `body.code` field only; it never logs `detail`, `fields`, `text`, or response content.

- [x] **Step 4: Run API and request logging tests**

Run:

```powershell
npm run test:app
npx vitest run src/game/application/server/logging/requestLog.test.ts
```

Expected: existing API status/body assertions remain unchanged and every wrapped route exposes a trace header.

---

### Task 3: Enrich use-case and gameplay logs with safe decision context

**Files:**
- Modify: `src/game/application/server/compositionRoot.ts`
- Modify: `src/game/application/performAction.ts`
- Modify: `src/game/application/handleNpcDialogue.ts`
- Modify: `src/game/application/server/ai/liveRuntimeNarrativeSources.ts`
- Modify: `src/game/application/server/ai/liveTownPlanSource.ts`
- Modify: `src/game/application/server/ai/_shared/ensureCoordinator.ts`
- Modify: `src/game/application/server/ai/runtimeNarrativeTaskCoordinator.ts`
- Modify: `src/game/application/server/ai/townPlanTaskCoordinator.ts`
- Modify: `src/game/application/generatePendingNarrativeScene.ts`
- Modify: `src/game/application/generatePendingTownPlan.ts`
- Modify: `src/game/application/server/persistence/sqliteGameRepository.ts`
- Test: `src/game/application/server/compositionRoot.test.ts`
- Test: `src/game/application/handleNpcDialogue.test.ts`
- Test: `src/game/application/server/ai/liveRuntimeNarrativeSources.test.ts`
- Test: `src/game/application/server/ai/liveTownPlanSource.test.ts`
- Test: `src/game/application/server/ai/_shared/ensureCoordinator.test.ts`

**Interfaces:**

- `runLoggedUseCase(logger, operation, work, details?, traceId?)` merges a safe detail record with `stableResultDetails(result)`.
- `stableResultDetails` adds only `view.currentLocation.id`, `view.revision`, active quest count, story event count, and generation/battle/town status when present.
- `perform_action` adds `intentType`, stable target ID, and `expectedRevision`.
- `handle_npc_dialogue` adds `npcId`, `textLength`, classification (`chat`/`narrative`), tone, relationship delta, and result kind; never `text`.
- Runtime narrative and town provider audit functions accept `request.traceId` and store it in the envelope.
- Background coordinator logs every terminal result (`queued`, `already_running`, `not_pending`, `saved`, `cleared`, `stale`, `unavailable`) with trace, gameId, and duration.
- SQLite errors add stable operation and error class only; no exception message/stack.

- [x] **Step 1: Add failing assertions for safe context and trace correlation**

Assert that action logs contain `intentType` and `expectedRevision` but not player text; NPC logs contain `textLength` and tone but not text; runtime/town provider logs use the request traceId; task result logs include `saved` or `stale`.

- [x] **Step 2: Implement stable use-case detail extraction**

Add small pure helpers in `compositionRoot.ts` for intent and result projection. Do not serialize `view`, `feedback.message`, field errors, player name, or any arbitrary input object.

- [x] **Step 3: Propagate trace and add NPC decision telemetry**

Pass the HTTP trace into `performAction` and `handleNpcDialogue` dependencies. Inject the logger into the NPC use-case and emit one `npc_dialogue_decision` event with classification/tone/delta/result. Use `text.length` after input validation only.

- [x] **Step 4: Fix provider and background-task correlation**

Use `request.traceId` in both provider audits. Extend the background coordinator `ensure(traceId?: string)` and pass that trace to pending narrative/town generation, while retaining a generated task trace for non-HTTP callers.

- [x] **Step 5: Log deterministic generation/task outcomes**

Record final scenario source/fallback category through the production observer or an equivalent safe composition-root event. Record town validation attempts and final source without candidate content. Log CAS outcomes and task terminal states.

- [x] **Step 6: Run focused application tests**

Run:

```powershell
npm run test:game-application
npm run test:game-logging
```

Expected: stable result codes and existing gameplay behavior remain unchanged.

---

### Task 4: Add minimal operational retention, querying, and health support

**Files:**
- Create: `scripts/logs.mjs`
- Modify: `package.json`
- Modify: `.env.example`
- Create: `docs/operations/logging.md`
- Modify: `docs/operations/README.md`
- Modify: `docs/agent/日志与追踪.md`
- Modify: `docs/Agent文档索引.md`
- Test: create `scripts/logs.node-test.mjs`

**Interfaces:**

`npm run logs:query -- --event <event> [--trace <traceId>] [--from <ms>] [--to <ms>]` reads the configured SQLite log database and prints redacted structured JSON. It must not print environment values or raw request data.

`npm run logs:retention -- --standard-days <n> --audit-days <n>` runs `runLogRetention` in bounded batches and prints only deleted count, batch count, protected count, and time-limit status.

`npm run logs:health` opens the configured log database, runs a bounded count query, and exits non-zero only when the log database cannot be opened/migrated; it never runs as part of a player request.

Add `GAME_LOG_STANDARD_RETENTION_DAYS` and `GAME_LOG_AUDIT_RETENTION_DAYS` as optional operator settings. Keep SQLite as the default sink and retain existing fallback settings.

- [x] **Step 1: Write CLI contract tests with a temporary database**

Cover query by event/trace, retention summary output, health success, and invalid/missing arguments. Assert that command output contains no database path, environment secrets, prompt, or player text.

- [x] **Step 2: Implement the CLI using the shared public package**

Resolve paths from `process.env`, create a SQLite sink with `createLogSink`, use `SqliteLogSink.queryByEvent/queryByTraceId/queryByTimeRange`, and close the sink in `finally`. Use `LogDatabase` plus `runLogRetention` for retention. Do not import RPG gameplay or database modules.

- [x] **Step 3: Document backup, retention, fallback, and alerting**

Document separate game/log DB paths, JSONL fallback collection, daily backup/retention execution, disk-space monitoring, future-schema behavior, queue-drop limitations, and the invariant that log failure cannot fail gameplay.

- [x] **Step 4: Run CLI tests**

Run:

```powershell
node --test scripts/logs.node-test.mjs
```

Expected: all commands pass against temporary files and leave no tracked `data/`, `logs/`, or `.env` artifacts.

---

### Task 5: Full verification and handoff

- [x] **Step 1: Run all mandatory gates**

```powershell
npm run lint
npm run typecheck
npm run test:boundaries
npm run test:game-logging
npm run test:game-application
npm run test:app
npm test
npm run build
```

- [x] **Step 2: Re-check privacy and trace coverage**

Search production code for direct `console.*`, raw player fields in logger calls, `prompt`, `response`, `apiKey`, `Authorization`, and use-case-generated trace IDs that overwrite an active request trace.

- [x] **Step 3: Update implementation facts and inspect status**

Update `docs/agent/日志与追踪.md`, `docs/Agent文档索引.md`, and `docs/operations/logging.md` with the actual event names and commands. Run `git status --short` and report any pre-existing user changes separately.

> Verification note: the first final `npm test` run passed 139 files / 1565 tests (3 skipped). A later parallel rerun hit one unrelated 5-second `BattleActionRail` UI-test timeout; that file passed when isolated. Logging, API, boundary, typecheck, fast-gate, CLI, and production build checks all passed.
