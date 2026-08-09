# Task 3 report

Status: `DONE`

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
- retained current UI entry files use neutral `CurrentGameScreen.tsx`, `AdventureGameShell.tsx`, and `gameActionRequest.ts`; no compatibility view bridge remains.

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

## Review closure

- `NewGameSetupForm`, `CurrentGameScreen`, `AdventureGameShell`, and `gameActionRequest` now form one type-safe client chain through the neutral application facade.
- `AdventureGameShell` consumes `GameSessionView` directly and submits only opaque `fixed_choice` tokens or `free_text`; it no longer fabricates semantic tokens or casts through a compatibility view.
- `viewCompatibilityAdapter` and `gameSessionCompatibilityView` were deleted with their obsolete component consumers.
- `fixtureScenarioCandidateSource`, `liveRuntimeNarrativeSources`, and `generatePendingTownPlan` were deleted with the superseded runtime/town/story-eval executable closure, so no deleted imports remain.
- Active battle resolver exports are neutral `startBattle` and `battleAction`.
- The boundary guard asserts the canonical facade imports and exactly six `/api/game/**` routes; it has no V1/V2 dual-state constants or assertions.
- The neutral runtime contract runs under the Node Vitest environment, and the 80-turn SQLite test counts the initial ledger entry explicitly.
- Stale `.next` generated files are excluded from source `tsc --noEmit`; current route/source types are checked directly.

### Exact review deletion list

```text
scripts/phase10Journey.mjs
scripts/phase10Journey.node-test.mjs
scripts/phase11StoryContinuityJourney.mjs
scripts/storyEvalAnalyze.mjs
scripts/storyEvalAnalyze.node-test.mjs
scripts/storyEvalJourney.mjs
scripts/storyEvalJourney.node-test.mjs
scripts/storyEvalJudge.mjs
scripts/storyEvalJudge.node-test.mjs
scripts/storyEvalQualityGate.mjs
scripts/storyEvalQualityGate.node-test.mjs
scripts/storyEvalVerify.mjs
scripts/storyEvalVerify.node-test.mjs
scripts/townAiJourney.mjs
src/components/AdventureDetailsPanel.test.tsx
src/components/AdventureDetailsPanel.tsx
src/components/AdventureGameShell.test.tsx
src/components/AdventureHud.test.tsx
src/components/AdventureHud.tsx
src/components/AdventureLogPanel.tsx
src/components/AdventureOverlay.test.tsx
src/components/AdventureOverlay.tsx
src/components/BattleActionRail.test.tsx
src/components/BattleActionRail.tsx
src/components/BattleArena.test.tsx
src/components/BattleArena.tsx
src/components/BattlePanel.test.tsx
src/components/BattlePanel.tsx
src/components/CharacterAvatarIcon.tsx
src/components/EndingPanel.test.tsx
src/components/EndingPanel.tsx
src/components/InventoryPanel.test.tsx
src/components/InventoryPanel.tsx
src/components/ItemPanel.test.tsx
src/components/ItemPanel.tsx
src/components/LocationSceneScreen.test.tsx
src/components/LocationSceneScreen.tsx
src/components/NarrativeGenerationModal.tsx
src/components/NarrativeScenePanel.test.tsx
src/components/NarrativeScenePanel.tsx
src/components/NewGameSetupForm.test.tsx
src/components/NpcDialoguePanel.test.tsx
src/components/NpcDialoguePanel.tsx
src/components/OpeningGameView.test.tsx
src/components/OpeningGameView.tsx
src/components/PrologueScreen.test.tsx
src/components/PrologueScreen.tsx
src/components/QuestTracker.test.tsx
src/components/QuestTracker.tsx
src/components/SceneActionMenu.test.tsx
src/components/SceneActionMenu.tsx
src/components/SceneActionPanel.test.tsx
src/components/SceneActionPanel.tsx
src/components/SceneNarrationBar.test.tsx
src/components/SceneNarrationBar.tsx
src/components/ToastNotification.test.tsx
src/components/ToastNotification.tsx
src/components/TownLayerScreen.test.tsx
src/components/TownLayerScreen.tsx
src/components/TravelNarrationScreen.test.tsx
src/components/TravelNarrationScreen.tsx
src/components/TravelPanel.test.tsx
src/components/TravelPanel.tsx
src/components/WorldMapScreen.test.tsx
src/components/WorldMapScreen.tsx
src/components/adventureVisuals.test.tsx
src/components/adventureVisuals.tsx
src/components/inventoryVisuals.tsx
src/components/sessionViewFixture.testutil.ts
src/components/town/BuildingPlaceholderArt.tsx
src/components/town/BuildingProfilePanel.test.tsx
src/components/town/BuildingProfilePanel.tsx
src/components/town/TownMapSvg.test.tsx
src/components/town/TownMapSvg.tsx
src/components/viewCompatibilityAdapter.test.ts
src/components/viewCompatibilityAdapter.ts
src/game/application/gameSessionCompatibilityView.ts
src/game/application/generatePendingTownPlan.test.ts
src/game/application/generatePendingTownPlan.ts
src/game/application/internal/runtimeNarrativeFallbacks.ts
src/game/application/locationAdventureView.test.ts
src/game/application/locationAdventureView.ts
src/game/application/narrativeProgressTypes.ts
src/game/application/openingGameView.ts
src/game/application/server/ai/aiThinking.test.ts
src/game/application/server/ai/aiThinking.ts
src/game/application/server/ai/fixtureScenarioCandidateSource.test.ts
src/game/application/server/ai/fixtureScenarioCandidateSource.ts
src/game/application/server/ai/liveRuntimeNarrativeSources.storyEval.test.ts
src/game/application/server/ai/liveRuntimeNarrativeSources.test.ts
src/game/application/server/ai/liveRuntimeNarrativeSources.ts
src/game/application/server/ai/liveScenarioCandidateSource.storyEval.test.ts
src/game/application/server/ai/liveScenarioCandidateSource.test.ts
src/game/application/server/ai/liveScenarioCandidateSource.ts
src/game/application/server/ai/liveTownPlanSource.ts
src/game/application/server/ai/runtimeNarrativeFixtureSource.test.ts
src/game/application/server/ai/runtimeNarrativeFixtureSource.ts
src/game/application/server/ai/runtimeNarrativeRecording.test.ts
src/game/application/server/ai/runtimeNarrativeRecording.ts
src/game/application/server/ai/runtimeNarrativeSourceFactory.ts
src/game/application/server/ai/runtimeNarrativeTaskCoordinator.test.ts
src/game/application/server/ai/runtimeNarrativeTaskCoordinator.ts
src/game/application/server/ai/scenarioCandidateSourceFactory.test.ts
src/game/application/server/ai/scenarioCandidateSourceFactory.ts
src/game/application/server/ai/scenarioGenerationAudit.test.ts
src/game/application/server/ai/scenarioGenerationAudit.ts
src/game/application/server/ai/scenarioPrompt.test.ts
src/game/application/server/ai/scenarioPrompt.ts
src/game/application/server/ai/scenarioResponseFormat.test.ts
src/game/application/server/ai/scenarioResponseFormat.ts
src/game/application/server/ai/sourceFactory.storyEval.test.ts
src/game/application/server/ai/storyEvalCapture.test.ts
src/game/application/server/ai/storyEvalCapture.ts
src/game/application/server/ai/townPlanFixtureSource.ts
src/game/application/server/ai/townPlanPrompt.ts
src/game/application/server/ai/townPlanRecording.test.ts
src/game/application/server/ai/townPlanRecording.ts
src/game/application/server/ai/townPlanSource.test.ts
src/game/application/server/ai/townPlanSourceFactory.test.ts
src/game/application/server/ai/townPlanSourceFactory.ts
src/game/application/server/ai/townPlanTaskCoordinator.test.ts
src/game/application/server/ai/townPlanTaskCoordinator.ts
src/game/application/server/offlineBaselines.test.ts
src/game/application/server/offlineBaselines.ts
src/game/application/storyEvalCaptureTypes.ts
src/game/application/testing/offlineGenreJourney.test.ts
src/game/application/testing/offlineGenreJourney.ts
src/game/application/testing/phase10FullJourney.test.ts
src/game/application/testing/phase11StoryContinuityJourney.test.ts
src/game/application/testing/runtimeNarrativeJourney.test.ts
src/game/application/testing/runtimeNarrativeJourney.ts
src/game/application/testing/storyEvalArtifacts.test.ts
src/game/application/testing/storyEvalArtifacts.ts
src/game/application/testing/storyEvalCases.test.ts
src/game/application/testing/storyEvalCases.ts
src/game/application/testing/storyEvalCheckpoint.test.ts
src/game/application/testing/storyEvalCheckpoint.ts
src/game/application/testing/storyEvalContinuation.test.ts
src/game/application/testing/storyEvalContinuation.ts
src/game/application/testing/storyEvalJourney.test.ts
src/game/application/testing/storyEvalStrategy.test.ts
src/game/application/testing/storyEvalStrategy.ts
src/game/application/testing/tmpRunDir.testutil.ts
src/game/application/testing/townAiJourney.test.ts
src/game/application/townDemo.test.ts
src/game/application/townDemo.ts
src/game/application/townPlanGeneration.test.ts
src/game/application/townPlanGeneration.ts
src/game/application/townRuntimeView.test.ts
src/game/application/townRuntimeView.ts
```

Obsolete package scripts referencing the deleted journeys/evaluators were deleted in the same closure.

### Final command: `npm run typecheck`

```text
> ai-rpg-game@0.1.0 typecheck
> tsc --noEmit
```

Exit: `0`.

### Final command: `npm run test:game-application`

```text
> ai-rpg-game@0.1.0 test:game-application
> vitest run src/game/application

 RUN  v3.1.4 /Users/liangrongqing/Documents/code/ai-rpg-game/.worktrees/v2-foundation-remediation

 ✓ src/game/application/server/ai/liveIntentParserSource.test.ts (22 tests) 5ms
 ✓ src/game/application/buildChoiceMap.test.ts (10 tests) 4ms
 ✓ src/game/application/approveAndWriteScene.test.ts (20 tests) 7ms
 ✓ src/game/application/sceneGenerationContext.test.ts (6 tests) 4ms
 ✓ src/game/application/server/ai/liveSceneSource.test.ts (3 tests) 5ms
 ✓ src/game/application/deterministicSceneSource.test.ts (13 tests) 5ms
 ✓ src/game/application/generatePendingScene.test.ts (9 tests) 7ms
 ✓ src/game/application/gameSessionView.test.ts (11 tests) 5ms
 ✓ src/game/application/performTurn.test.ts (24 tests) 12ms
 ✓ src/game/application/stateCommit.test.ts (3 tests) 2ms
 ✓ src/game/application/server/persistence/gameRepository.test.ts (3 tests) 3ms
 ✓ src/game/application/server/ai/liveExpansionSource.test.ts (14 tests) 4ms
 ✓ src/game/application/server/ai/aiRuntimeConfig.test.ts (17 tests) 6ms
 ✓ src/game/application/sceneWriteBack.test.ts (3 tests) 2ms
 ✓ src/game/application/server/ai/worldGenerationSource.test.ts (9 tests) 4ms
 ✓ src/game/application/testing/foundationJourney.test.ts (2 tests) 9ms
 ✓ src/game/application/testing/storyDivergenceJourney.test.ts (3 tests) 12ms
 ✓ src/game/application/requestParser.test.ts (20 tests) 3ms
 ✓ src/game/application/server/persistence/sqliteClient.test.ts (6 tests) 14ms
 ✓ src/game/application/server/persistence/sqliteGameRepository.test.ts (14 tests) 224ms
 ✓ src/game/application/actionConverter.test.ts (7 tests) 2ms
 ✓ src/game/application/createGame.test.ts (2 tests) 3ms
 ✓ src/game/application/server/ai/sourceFactory.test.ts (6 tests) 2ms
 ✓ src/game/application/neutralRuntimeContract.test.ts (2 tests) 2ms
 ✓ src/game/application/server/ai/intentParserSource.test.ts (3 tests) 2ms
 ✓ src/game/application/server/ai/expansionSource.test.ts (3 tests) 2ms
 ✓ src/game/application/expansionProposer.test.ts (3 tests) 4ms

 Test Files  27 passed (27)
      Tests  238 passed (238)
   Start at  15:18:19
   Duration  4.37s (transform 1.58s, setup 3.79s, collect 3.24s, tests 353ms, environment 25.50s, prepare 2.29s)
```

Exit: `0`.

### Final command: `npm run test:boundaries`

```text
> ai-rpg-game@0.1.0 test:boundaries
> vitest run src/dependencyBoundaries.test.ts src/game/logging/dependencyBoundaries.test.ts

 RUN  v3.1.4 /Users/liangrongqing/Documents/code/ai-rpg-game/.worktrees/v2-foundation-remediation

 ✓ src/game/logging/dependencyBoundaries.test.ts (3 tests) 33ms
 ✓ src/dependencyBoundaries.test.ts (81 tests) 114ms

 Test Files  2 passed (2)
      Tests  84 passed (84)
   Start at  15:20:15
   Duration  1.22s (transform 58ms, setup 200ms, collect 75ms, tests 147ms, environment 1.50s, prepare 87ms)
```

Exit: `0`.

## Remaining version naming and concerns

- Persisted schema/protocol facts such as `templateVersion: "v2"`, the current numeric record version, and explicit unsupported-old-record validation remain intentionally; they are data contract values, not executable entry-point names or compatibility aliases.
- No active runtime file/export/import/route uses a V2 suffix; no executable view compatibility chain remains.
- Exactly the six listed `/api/game/**` routes remain, and storage SQL uses only `game_records` / `current_game`.
- `.foundation`, the sibling foundation repository, and the unrelated untracked plan were not modified, removed, moved, staged, or rebuilt.
