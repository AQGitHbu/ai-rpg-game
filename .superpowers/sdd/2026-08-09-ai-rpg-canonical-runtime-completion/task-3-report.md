# Task 3 report

Status: `DONE_WITH_CONCERNS`

## Rename list

- `src/game/application/createGameV2.{ts,test.ts}` → `createGame.{ts,test.ts}`
- `src/game/application/generatePendingSceneV2.{ts,test.ts}` → `generatePendingScene.{ts,test.ts}`
- `src/game/application/gameSessionViewV2.{ts,test.ts}` → `gameSessionView.{ts,test.ts}`
- `src/game/application/http/v2RequestParser.{ts,test.ts}` → `src/game/application/requestParser.{ts,test.ts}`
- `src/game/application/server/compositionRootV2.ts` → `compositionRoot.ts`
- `src/game/application/server/persistence/gameRepositoryV2.{ts,test.ts}` → `gameRepository.{ts,test.ts}`
- `src/game/application/server/persistence/sqliteGameRepositoryV2.{ts,test.ts}` → `sqliteGameRepository.{ts,test.ts}`
- `src/game/application/server/ai/v2SourceFactory.{ts,test.ts}` → `sourceFactory.{ts,test.ts}`
- `src/game/application/server/ai/worldGenerationSourceV2.{ts,test.ts}` → `worldGenerationSource.{ts,test.ts}`
- `src/game/application/server/ai/liveExpansionSourceV2.{ts,test.ts}` → `liveExpansionSource.{ts,test.ts}`
- `src/game/application/server/ai/liveIntentParserSourceV2.{ts,test.ts}` → `liveIntentParserSource.{ts,test.ts}`
- `src/game/application/server/ai/sceneSourceV2.test.ts` → `liveSceneSource.test.ts`
- `src/game/gameplay/rpg/scenarioV2/**` → `src/game/gameplay/rpg/worldGeneration/**`
- `src/game/application/testing/v2FoundationJourney.testutil.ts` → `foundationJourney.testutil.ts`
- `src/game/application/testing/v2FoundationJourney.test.ts` → `foundationJourney.test.ts`
- `src/game/application/testing/v2StoryDivergenceJourney.test.ts` → `storyDivergenceJourney.test.ts`
- `scripts/v2FoundationJourney.mjs` → `scripts/foundationJourney.mjs`
- package commands: `test:v2-foundation-journey` → `test:foundation-journey`; `journey:v2-foundation` → `journey:foundation`
- retained current UI entry files were moved to neutral `CurrentGameScreen.tsx`, `AdventureGameShell.tsx`, and `gameActionRequest.ts`; the temporary view bridge was moved to `viewCompatibilityAdapter.ts`.

## Delete list

- Deleted all former `src/app/api/game/**` handlers/tests/routes before moving the retained routes; deleted old `npc/dialogue` and `town/ensure` endpoints.
- Deleted the complete `src/app/api/v2/**` tree. The resulting route files are exactly:
  - `src/app/api/game/route.ts`
  - `src/app/api/game/current/route.ts`
  - `src/app/api/game/actions/route.ts`
  - `src/app/api/game/narrative/ensure/route.ts`
  - `src/app/api/game/prologue/ack/route.ts`
  - `src/app/api/game/dev/current/route.ts`
- Deleted `src/game/application/performActionV2.{ts,test.ts}` and direct callers now use `performTurn`.
- Deleted `src/game/application/index.v1.ts`, the superseded old application use cases/regressions, old composition-root tests, and the old town-demo route/test that had no neutral runtime importer.
- Deleted `tsconfig.v1-legacy.json`.

## Storage and logs

- SQLite schema and all current SQL use only `game_records` and `current_game`; no migration/read/copy path for `game_records_v2`, `games`, or old pointers was added.
- Corruption classification is neutral: `UNSUPPORTED_RECORD`, `VERSION_MISMATCH`, and `UNPARSEABLE_RECORD`.
- Current story schema validation uses `STORY_STATE_SCHEMA_VERSION`; record revision remains the CAS barrier.
- HTTP events are `http_request_started/completed/failed` and source names use `rpg.http.*`.

## Commands and raw outcomes

### TDD red: route contract

Command: `npm run test:app -- src/app/api/game/routeContract.test.ts`

Raw result: exit 1; 1 failed, 125 passed. Received 14 routes. Unexpected routes were old `game/npc/dialogue`, old `game/town/ensure`, and all six `v2/game/**` routes.

### TDD red: neutral imports and tables

Command: `npm run test:game-application -- src/game/application/neutralRuntimeContract.test.ts src/game/application/server/persistence/sqliteGameRepositoryV2.test.ts`

Raw result: exit 1; 2 failed files, 97 passed files; 1 failed/784 passed/4 skipped tests. Neutral import failed because `generatePendingScene` did not exist. Table assertion received `["current_game_v2", "game_records_v2"]` instead of `["current_game", "game_records"]`.

### Route green

Command: `npm run test:app`

```text
Test Files  2 passed (2)
Tests       11 passed (11)
EXIT_CODE=0
```

### Focused neutral runtime

Command: `npx vitest run src/game/application/neutralRuntimeContract.test.ts src/game/application/server/persistence/gameRepository.test.ts src/game/application/server/persistence/sqliteGameRepository.test.ts src/game/application/createGame.test.ts src/game/application/generatePendingScene.test.ts src/game/application/server/ai/sourceFactory.test.ts src/game/application/server/ai/worldGenerationSource.test.ts src/game/application/server/ai/liveExpansionSource.test.ts src/game/application/server/ai/liveIntentParserSource.test.ts`

```text
Test Files  2 failed | 7 passed (9)
Tests       1 failed | 78 passed (79)
```

Failures: the contract test loaded the server composition root under the default browser-like Vitest environment and hit the SQLite server-only guard; the 80-turn persistence test now reaches an active schema-v3 record and exposes an existing ledger-size mismatch (`expected 80`, `received 81`). The neutral-table assertion itself passed.

### Typecheck

Command: `npm run typecheck`

Raw result: exit 2. Failures include stale generated `.next` route types, deleted legacy town/runtime imports, remaining compatibility UI types, and old story-eval/town executable files that are outside the retained runtime. This command is not green in this checkpoint.

### Brief commands not run after final checkpoint

- `npm run test:game-application`: not rerun to completion.
- `npm run test:boundaries`: not run after final checkpoint.
- `npm run typecheck`: run once and failed as recorded above; not rerun.

## Remaining version/compatibility naming and concerns

- Historical fixture/schema strings such as `templateVersion: "v2"` remain where they represent persisted protocol facts.
- `viewCompatibilityAdapter.ts` and `gameSessionCompatibilityView.ts` remain because Task 4 owns the complete UI projector/adapter replacement. They are the principal executable compatibility concern.
- Some old non-production story-eval/town/AI files remain and still reference deleted legacy modules; this is why the full application/typecheck/boundary gates are not yet green.
- `.foundation` and the sibling foundation repository were not modified, removed, moved, staged, or rebuilt.
