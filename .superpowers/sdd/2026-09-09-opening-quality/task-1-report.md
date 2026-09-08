# Task 1 implementation report

## Outcome

Implemented the required opening situation proposal parser, semantic response resolver, and contextual opening choice registry. `OpeningGenerationCandidate.opening.situation` is required and is never synthesized by repair or runtime code. The opening scene must provide exactly the response candidate IDs declared by the validated situation; each response is compiled into a server-owned `TalkAction` and passed through `createApprovedChoice`.

The resolver maps fact keys by `world.publicFacts` order (`fact_N`) and thread keys to `thread_init_<key>`. It validates topology, references, public visibility, known/private disjointness, and relationship basis rules. Choice uniqueness uses `semanticSummaryOf(action)`, independent of candidate ID and label.

The fixture opening source now emits an explicit situation with matching scene choices. The live bundle prompt's current structural outline describes the situation/response mapping without reintroducing a second production path. Full production prompt quality remains Task 4 scope.

## TDD evidence

RED command:

`npx vitest run src/game/domain/openingSituation.test.ts src/game/gameplay/rpg/openingGeneration/openingSituationRules.test.ts`

Observed result: exit 1. `openingSituation.test.ts` passed 2 tests; `openingSituationRules.test.ts` failed during transform because `./openingSituationRules` did not exist. This is the captured RED for the semantic resolver. The domain parser implementation had already been added before the first captured run, so there is no observed parser-specific RED and none is claimed.

First focused GREEN command:

`npx vitest run src/game/domain/openingSituation.test.ts src/game/gameplay/rpg/openingGeneration/openingSituationRules.test.ts`

Observed result: exit 0; 2 files passed, 5 tests passed.

Final targeted command:

`npx vitest run src/game/domain/openingGenerationCandidate.test.ts src/game/domain/openingSituation.test.ts src/game/gameplay/rpg/openingGeneration src/game/application/createGame.test.ts src/game/application/server/ai/openingGenerationSource.test.ts src/game/application/server/ai/liveNarrativeBundleSource.test.ts`

Observed result: exit 0; 8 files passed, 127 tests passed.

Additional gates:

- `npm run typecheck`: exit 0.
- `npm run test:boundaries`: exit 0; 2 files passed, 124 tests passed.
- `git diff --check`: exit 0.

## Coverage added

- Exact situation keys, local-key grammar, counts, duplicate participants, invalid dialogue acts, malformed/missing situation, and limits.
- History topological order/cycles, fact/thread references, relationship basis, known/private overlap, secret and unknown response targets.
- Fact and thread server ID mapping across all existing `DialogueAct` values accepted by the parser.
- Same act with distinct topics succeeds and produces distinct opaque tokens.
- Same act and same resolved topic is rejected despite different keys/labels.
- Opening scene missing/extra/mismatched candidate IDs is rejected before persistence.
- `createGame` exercises ask/refuse, ask/ask with different topics, semantic duplicate, unknown topic, and private topic through the real compile path and verifies atomic failure.

## Self-review

- Domain parser depends only on domain types; gameplay resolver is exported through the opening-generation facade; application code does not deep-import gameplay internals.
- Production candidate repair preserves provider situation data verbatim and does not invent history, threads, connection basis, or responses.
- The choice registry contains only actions returned by the resolver and still uses the existing approved-choice constructor.
- Scene choice order controls display order while candidate IDs only join scene labels to already resolved actions.
- No WorldState/event/persistence behavior was added; those remain Tasks 2 and 3. New `thread_init_<key>` topics are Action references only and are not added to `unresolvedThreads`.
- No live AI calls were run.

## Files

Created:

- `src/game/domain/openingSituation.ts`
- `src/game/domain/openingSituation.test.ts`
- `src/game/domain/openingSituation.testutil.ts`
- `src/game/gameplay/rpg/openingGeneration/openingSituationRules.ts`
- `src/game/gameplay/rpg/openingGeneration/openingSituationRules.test.ts`

Modified the Task 1 candidate/parser, validator/facade, create-game compiler/fixture, source key guards/prompt outline, and their explicit test fixtures.

## Review fix round 1

The review identified that the resolver incorrectly required every history fact to appear in the focus NPC's `knownFactKeys`. History only requires an existing fact reference; visibility is applied where history is projected. The blanket condition was removed. For `familiarity: "known"`, the resolver now separately requires at least one selected basis history whose fact keys are all public/known to the focus NPC. Stranger connections remain neutral with no basis.

RED command:

`npx vitest run src/game/gameplay/rpg/openingGeneration/openingSituationRules.test.ts`

Observed result: exit 1; 1 of 5 tests failed because a valid non-basis private history still resolved to `null`. The private-only relationship-basis rejection passed under the old blanket rule; after removing that rule it protects the newly separated basis check.

GREEN command:

`npx vitest run src/game/domain/openingSituation.test.ts src/game/gameplay/rpg/openingGeneration/openingSituationRules.test.ts src/game/application/createGame.test.ts && npm run typecheck && git diff --check`

Observed result: exit 0; 3 test files passed, 30 tests passed; typecheck and diff check passed.
