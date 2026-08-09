# Task 5 report — canonical architecture closure

Commit: `refactor(architecture): delete legacy runtime and version quarantine`

## Result

- Kept the canonical gameplay facades: `worldGeneration`, `ruleEngine`, `expansion`, `intentParser`, `dialogue`, and `candidateEvents`.
- Redirected application imports through those facades and reduced the domain public facade to the stable new-game input contract.
- Deleted the unreferenced executable gameplay chain under `actions`, `battle`, `choices`, `narrative`, `quests`, `scenario`, and `town`, including its retired tests.
- Deleted isolated domain remnants that had no canonical production consumer: `GameState`, `storyMemory`, `townSnapshot`, and `itemPresentation`, plus their dedicated tests. Removed the obsolete `WorldState.towns` and `town_plan_generated` event references that kept the old state chain reachable.
- Added one-chain assertions for the sole repository, composition root, read model, request client, six API routes, normal typecheck discovery, retired directories, and versioned executable naming.
- Preserved `.foundation` and the untracked completion Plan; no foundation files were modified.

## Review follow-up

- Deleted the retired town demo image-generation script, all eight generated experiment images, and the dead `.town-demo-*` / `.town-layer-*` stylesheet block.
- Extended the one-chain boundary guard to reject reintroduction of the script, asset directory, or town demo CSS selectors.

## Verification

- `rg -n 'index\.v1|performActionV2|handleNpcDialogueV2|viewAdapterV2|compositionRootV2|GameRepositoryV2|scenarioV2' src scripts package.json tsconfig*.json` — no matches.
- `rg -n 'V1|V2|v2\.1|/api/v[12]/' src scripts package.json tsconfig*.json` — no matches.
- `rg -n 'gameState|storyMemory|townSnapshot|itemPresentation|TownRuntimeState|town_plan_generated' src scripts package.json tsconfig*.json` — no matches.
- `npm run typecheck` — passed.
- `npm run test:boundaries` — 88 passed.
- `npm run test:game-domain` — 184 passed.
- `npm run test:game-gameplay` — 206 passed.
- `npm run test:game-application` — 243 passed.
- Follow-up `npm run typecheck` — passed.
- Follow-up `npm run test:boundaries` — 89 passed.
- Follow-up town demo residue scan — no matches.
