# Task 4 report

Status: `DONE`

## Outcome

- Replaced the partial read model with one complete canonical `GameSessionView`.
- Added the required `PlayerChoiceView` and `NpcDialogueView` contracts.
- The view now projects unlocked map locations and travel choices, current-location actions, obtainable items, inventory, narrative/dialogue, active battle controls, quest objectives, pending state, revision/reload-safe JSON, and ending presentation.
- Added `runtimeChoiceToken.ts`; `gameSessionView` and `buildChoiceMap` use the same server-side opaque token derivation. Semantic tokens such as `move:*`, `take_item:*`, `attack:*`, `battle_action:*`, `explore`, and `rest` are no longer action-map keys or client constructions.
- `AdventureGameShell` renders every actionable surface from `PlayerChoiceView` and forwards the provided token unchanged. Free text remains the single structured `free_text` request.
- `CurrentGameScreen` consumes canonical pending and ending fields directly.
- `NewGameSetupForm` was already collapsed by Task 3 to one `onCreated` callback and fixed `/api/game` endpoint; Task 4 adds a regression test pinning that contract.
- `gameActionRequest` was already neutralized by Task 3; its current `postAction` contract is now exercised through every canonical visual action.
- No adapter, versioned form, path branching, domain/gameplay UI import, or `as unknown as GameSessionView` cast remains.

## TDD red

Command:

```text
npx vitest run src/game/application/gameSessionView.test.ts src/components/AdventureGameShell.test.tsx src/components/NewGameSetupForm.test.tsx
```

Raw result:

```text
Test Files  2 failed | 1 passed (3)
Tests       8 failed | 15 passed (23)
Exit        1
```

Failures pinned the missing `worldMap`, current-location actions, obtainable item choices, battle controls, canonical NPC dialogue names/roles, and travel/item/battle UI buttons. The already-canonical fixed new-game endpoint test passed at RED.

## Tests added/updated

- `src/game/application/gameSessionView.test.ts`
  - map travel token
  - location explore/talk/attack/rest choices
  - obtainable item token
  - active battle controls
  - focused NPC two-choice tuple and custom input
  - quest objective projection
  - pending, JSON reload, and ending projection
  - serialized leakage guard for `actionKey`, registry, candidate effects, hidden facts, jobs, and full states
  - projector tokens are executable by the server `buildChoiceMap`
- `src/components/AdventureGameShell.test.tsx`
  - two dialogue buttons in separate runs
  - custom free text
  - travel, explore, item, and battle buttons
  - exact server-provided token forwarding
- `src/components/NewGameSetupForm.test.tsx`
  - one callback and fixed `/api/game` endpoint
- `src/game/application/buildChoiceMap.test.ts`
  - runtime action keys are opaque and semantic keys are absent

## Final verification

### `npm run test:game-application -- src/game/application/gameSessionView.test.ts`

```text
> ai-rpg-game@0.1.0 test:game-application
> vitest run src/game/application src/game/application/gameSessionView.test.ts

 RUN  v3.1.4 /Users/liangrongqing/Documents/code/ai-rpg-game/.worktrees/v2-foundation-remediation

 ✓ src/game/application/server/ai/liveIntentParserSource.test.ts (22 tests) 5ms
 ✓ src/game/application/buildChoiceMap.test.ts (10 tests) 5ms
 ✓ src/game/application/approveAndWriteScene.test.ts (20 tests) 5ms
 ✓ src/game/application/server/ai/liveSceneSource.test.ts (3 tests) 4ms
 ✓ src/game/application/sceneGenerationContext.test.ts (6 tests) 5ms
 ✓ src/game/application/generatePendingScene.test.ts (9 tests) 7ms
 ✓ src/game/application/deterministicSceneSource.test.ts (13 tests) 8ms
 ✓ src/game/application/gameSessionView.test.ts (15 tests) 8ms
 ✓ src/game/application/performTurn.test.ts (24 tests) 14ms
 ✓ src/game/application/server/ai/liveExpansionSource.test.ts (14 tests) 4ms
 ✓ src/game/application/stateCommit.test.ts (3 tests) 2ms
 ✓ src/game/application/sceneWriteBack.test.ts (3 tests) 2ms
 ✓ src/game/application/server/persistence/gameRepository.test.ts (3 tests) 2ms
 ✓ src/game/application/server/ai/aiRuntimeConfig.test.ts (17 tests) 6ms
 ✓ src/game/application/server/ai/worldGenerationSource.test.ts (9 tests) 4ms
 ✓ src/game/application/testing/storyDivergenceJourney.test.ts (3 tests) 12ms
 ✓ src/game/application/testing/foundationJourney.test.ts (2 tests) 9ms
 ✓ src/game/application/requestParser.test.ts (20 tests) 3ms
 ✓ src/game/application/server/persistence/sqliteClient.test.ts (6 tests) 14ms
 ✓ src/game/application/server/persistence/sqliteGameRepository.test.ts (14 tests) 225ms
 ✓ src/game/application/actionConverter.test.ts (7 tests) 2ms
 ✓ src/game/application/neutralRuntimeContract.test.ts (2 tests) 2ms
 ✓ src/game/application/expansionProposer.test.ts (3 tests) 4ms
 ✓ src/game/application/createGame.test.ts (2 tests) 3ms
 ✓ src/game/application/server/ai/intentParserSource.test.ts (3 tests) 2ms
 ✓ src/game/application/server/ai/expansionSource.test.ts (3 tests) 2ms
 ✓ src/game/application/server/ai/sourceFactory.test.ts (6 tests) 2ms

 Test Files  27 passed (27)
      Tests  242 passed (242)
   Start at  15:43:50
   Duration  4.12s (transform 1.55s, setup 3.36s, collect 3.22s, tests 361ms, environment 23.55s, prepare 2.27s)
```

Exit: `0`.

### `npm run test:components`

```text
> ai-rpg-game@0.1.0 test:components
> vitest run src/components

 RUN  v3.1.4 /Users/liangrongqing/Documents/code/ai-rpg-game/.worktrees/v2-foundation-remediation

 ✓ src/components/gameActionRequest.test.ts (7 tests) 9ms
 ✓ src/components/sharedUiContract.test.tsx (1 test) 77ms
 ✓ src/components/NewGameSetupForm.test.tsx (1 test) 101ms
 ✓ src/components/AdventureGameShell.test.tsx (7 tests) 241ms

 Test Files  4 passed (4)
      Tests  16 passed (16)
   Start at  15:43:44
   Duration  1.65s (transform 144ms, setup 518ms, collect 469ms, tests 428ms, environment 3.69s, prepare 234ms)
```

Exit: `0`.

### `npm run typecheck`

```text
> ai-rpg-game@0.1.0 typecheck
> tsc --noEmit
```

Exit: `0`.

## Concerns

None. `.foundation`, the sibling foundation repository, and the unrelated untracked plan were not modified or staged.
