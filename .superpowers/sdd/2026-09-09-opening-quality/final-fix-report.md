# Final fix evidence

Scope: all findings in `final-review.md` (2 Important, 1 Minor). No provider or user database was used.

## Result

- Opening thread envelope `factIds` are canonicalized in first-occurrence order. The payload still preserves `questionFactId` and the full `supportingFactIds`, including valid overlap. Draft commit and persisted-ledger validation compare against the same canonical envelope.
- A production decision context with mandatory overflow returns the typed source failure `context_budget_exceeded` before `RpgAiClient.complete`. It remains on the existing bounded content-retry and explicit player retry path. Contexts within budget take the unchanged prompt path; no prompt prose or context rendering changed.
- NPC documentation now distinguishes known/neutral `acquainted` from policy-defined non-neutral stages and states that public history is origin/basis while all initial evidence arrays are empty.

## RED

Command:

```text
npx vitest run src/game/gameplay/rpg/openingGeneration/compileOpeningGenerationCandidate.test.ts src/game/application/server/persistence/sqliteGameRepository.test.ts src/game/application/testing/openingQualityJourney.test.ts
```

Before implementation: 3 test files failed; 4 tests failed and 45 passed. Resolver-accepted question/support overlap threw `Failed to commit game_initialized event` from compiler, SQLite roundtrip, and real `createGame`. The large accepted opening reached the same overlap crash before the overflow assertion, confirming the canonical-envelope defect blocked the downstream production path.

## GREEN

Same focused command after implementation: 3 test files passed; 49 tests passed. Coverage includes compiler payload/envelope semantics, SQLite persistence reload, real `createGame` classification, a real opening → fixed choice → first pending job, a compiled manifest with positive mandatory overflow, typed `context_budget_exceeded`, and zero provider calls.

Broader affected-contract command:

```text
npx vitest run src/game/domain/eventLedger.test.ts src/game/gameplay/rpg/openingGeneration/openingSituationRules.test.ts src/game/gameplay/rpg/openingGeneration/validateOpeningGenerationCandidate.test.ts src/game/application/createGame.test.ts src/game/application/server/persistence/worldStatePersistenceValidation.test.ts src/game/application/server/ai/liveNarrativeBundleSource.test.ts src/game/application/testing/openingQualityJourney.test.ts
```

Result: 7 test files passed; 112 tests passed.

Required gates:

```text
npm test
npm run typecheck
npm run test:boundaries
npm run check:docs
git diff --check
```

Results:

- `npm test`: 192 files passed, 1 live file skipped; 2,564 tests passed, 1 skipped.
- `npm run typecheck`: passed.
- `npm run test:boundaries`: 2 files passed; 124 tests passed.
- `npm run check:docs`: 34 current documents; 0 errors, 0 warnings.
- `git diff --check`: passed.

## Limits

The overflow regression is offline and spies on the production source boundary; no real API call was needed or made. The guard does not compact or otherwise alter normal accepted context or prompt output, so existing within-budget live evidence remains representative of prompt behavior.
