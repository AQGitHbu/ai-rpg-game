# Investigation and Scene Action Regression Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan.

**Goal:** Make a generated remote-location clue produce a reachable “go to that location” objective, remove obsolete player investigation choices, and remove the bottom scene action rail.

**Architecture:** Keep `investigate` in the domain/rule layer for historical compatibility, but stop exposing it as a current player choice. A new world location is the first objective in its act, and the clue is mounted to that location. Arrival/action reconciliation automatically discovers the clue, so the next visible interaction is the NPC/location flow. The scene screen no longer renders a bottom action rail; map, NPC cards, hotspots, and battle-specific controls remain the interaction surfaces.

**Tech Stack:** TypeScript, React, Vitest, SQLite-backed RPG runtime.

## Global Constraints

- Preserve unrelated existing worktree changes.
- Do not infer the regression from the screenshot alone; prove it with the persisted save and AI audit record plus tests.
- Keep legacy explicit `investigate` resolution available for old records, while preventing new read-model/action-map projections from reviving it.
- Update RPG agent documentation when the implementation contract changes.

## Task 1: Lock the data and objective-order regression with tests

**Files:** `src/game/gameplay/rpg/worldEvolution/approveWorldDelta.test.ts`, `src/game/gameplay/rpg/worldEvolution/approveWorldDelta.ts`

- Add/update a proposal fixture with a world location, NPC, fact, and next main quest.
- Assert the quest begins with `visit_location`, followed by `discover_fact`.
- Assert the generated fact is mounted to the minted location, not the current location.
- Assert the new location is released when the first objective is the visit.

## Task 2: Remove investigation branches from prepared continuation projection

**Files:** `src/game/gameplay/rpg/preparedContinuation/candidates.ts`, `src/game/gameplay/rpg/preparedContinuation/candidates.test.ts`

- Treat `discover_fact` as an automatic rule boundary and walk directly to the next objective.
- Replace the branch-sibling investigation test with a regression asserting that no prepared investigation trigger is emitted.

## Task 3: Make fact discovery automatic for all approved-approach facts

**Files:** `src/game/gameplay/rpg/ruleEngine/resolveByType.ts`, `src/game/gameplay/rpg/ruleEngine/resolveByType.test.ts`

- Remove the “two or more approaches means wait for a player investigation button” condition.
- Assert an undiscovered current-location fact with approved approaches is automatically discovered and carries no approach metadata.

## Task 4: Stop exposing investigation choices and remove the bottom rail

**Files:** `src/game/application/buildChoiceMap.ts`, `src/game/application/gameSessionView.ts`, `src/components/LocationSceneScreen.tsx`, affected component/application tests

- Do not add current investigation actions to the runtime choice map or session view.
- Keep compatibility types/legacy action resolution only where required by persisted records and existing narrative code.
- Remove the bottom `行动栏` render path from the location scene screen, including its now-unused filtering/selection plumbing.
- Add assertions that investigation choices and the bottom action rail are absent while NPC/map/hotspot interactions remain available.

## Task 5: Update implementation documentation

**Files:** relevant `docs/agent/*.md`, `docs/Agent文档索引.md`

- Record that clues attached to a newly generated world location use visit-first objective ordering and are automatically revealed on arrival/action reconciliation.
- Record that investigation approach buttons and the bottom scene action rail are not part of the current player interaction contract.

## Task 6: Verify and self-review

- Run focused Vitest suites for world evolution, prepared continuations, rule resolution, view projection, and location scene rendering.
- Run the project typecheck/build or the documented equivalent.
- Inspect the final diff for accidental edits to unrelated dirty files and for stale comments claiming that investigation buttons or the bottom rail are active.
