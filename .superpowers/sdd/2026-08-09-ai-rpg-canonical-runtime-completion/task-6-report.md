# Task 6 report — choice-driven multi-ending journey

Commit: `test(story): prove fifteen-turn choice-driven multi-ending play`

## RED evidence

- Seed diversity first failed with `changedDimensions = 0` because the fixture source ignored its seed.
- The genuine journey first failed at turn 6 with `找不到服务器选项：前往` because the only route was permanently locked and the one-quest world could never reach the three-act ending gate.

## Result

- Added deterministic seed-based content variants. Independent repositories now run the full `createGame` parse → validate → compile → persist path: replaying one seed persists byte-equivalent `worldState + storyState`, while different tested seeds change multiple compiled structural dimensions including NPC identity, quest graph, facts, and locations.
- Replaced the fallback world with a validated three-act route: NPC trust choice → route unlock → quest item → climax unlock → deterministic boss battle.
- Added closed affinity ending predicates (`npc_affinity_at_least` / `npc_affinity_at_most`) across candidate schema parsing, validation, compilation, runtime state, and ending resolution.
- The world validator rejects overlapping affinity intervals for the same NPC, so two endings cannot both match one relationship state. Runtime resolution also sorts matching ending IDs before selection, making malformed/legacy ambiguous state independent of source array order.
- Changed deterministic dialogue scenes to provide two meaningful fixed NPC choices: support and challenge. Custom NPC input remains on the same `performTurn` path.
- Deterministic scene generation now proposes a structured friendly/hostile NPC stance event only after relationship thresholds are crossed; the next turn approves and activates it through the canonical candidate-event pipeline.
- The foundation journey consumes server-issued opaque tokens, executes 15 successful turns, reloads three times, unlocks and visits new locations, obtains an item, activates a candidate event, wins a boss climax, and persists `ending_reached`.
- Same-seed support/challenge branches each run 15 successful turns and three reloads, finish at distinct ending IDs, differ in NPC relationship/memory/emotion and candidate event ID, and replay byte-equivalently when repeated.
- Investigation is not claimed by this task; the acceptance route uses the Plan's `obtain or investigate` alternative and proves the item path.
- No foundation files were modified.

## Verification

- `npm run typecheck` — passed.
- `npm run test:game-domain` — 184 passed.
- `npm run test:game-gameplay` — 210 passed.
- `npm run test:game-application -- src/game/application/testing/foundationJourney.test.ts src/game/application/testing/storyDivergenceJourney.test.ts` — 245 passed.
- `npm run test:foundation-journey` — 3 passed.
- `npm run journey:foundation` — 3 passed.
