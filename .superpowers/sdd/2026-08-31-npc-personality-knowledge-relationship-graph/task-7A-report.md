# Task 7A report — item and quest continuity effects

## Result

Task 7A repair is implemented from the prior Task 7A commit `7921ca7`. The implementation keeps
the existing authoritative EntityMutation path and does not modify main or any Task
7B combat file.

## TDD evidence

- **RED** — first added falsifiable tests, then ran:
  `npm test -- --run src/game/gameplay/rpg/ruleEngine/resolveByType.test.ts src/game/gameplay/rpg/ruleEngine/reconcileQuests.test.ts`
  Result: 2 files, 40 passed / 4 failed. Failures covered ordinary-gift debt
  gating, unowned-item zero-write rejection, and missing NPC quest participant
  signal.
- **GREEN** — added the smallest rule changes and ran the same focused command.
  Result: 2 files, 44/44 passed.
- **REFACTOR** — narrowed quest matching to the exact direct NPC objective,
  removed an unnecessary record type guard, preserved the mutation order, and
  verified with:
  `npm run typecheck && npm test -- --run src/game/gameplay/rpg/ruleEngine/resolveByType.test.ts src/game/gameplay/rpg/ruleEngine/reconcileQuests.test.ts src/game/gameplay/rpg/ruleEngine/index.test.ts`
  Result: typecheck clean; 3 files, 70/70 passed.

## Chosen marker and item behavior

The canonical return-required marker is the server-owned sealed tag
`RETURN_REQUIRED_ITEM_TAG = "rule:return-required"`. It is not an `ItemCategory`
and is not produced by `itemPresentation.ts`. The existing item Entity
presentation/projection already round-trips `tags` without transformation, so no
second item schema or lossy parser was introduced. `resolveByType` selects the
signal from the authoritative item entry:

- the sealed tag → existing `gave_item` policy, which opens the existing
  fixed server-owned `source_owes_target` debt;
- every item without the sealed tag → existing `offered_help` policy, which has
  no commitment, including ordinary items and items whose display category is
  `quest` or whose `kind` derives to that category.

The batch remains exactly `transfer_item → relationship signal →
record_npc_interaction`; actionId is server-supplied through `ResolveDeps`, and
the existing replay failure contract is retained. The player/AI cannot provide a
debt parameter or numeric relationship delta.

## Zero-write and participant evidence

- Unknown item/NPC, non-NPC recipient, and item not owned by the player return
  before any mutation. A replay is checked before possession so it retains the
  stable `世界状态不一致。` result.
- Inactive NPC mutation failure is still an atomic batch failure. Tests assert
  unchanged store, record identities, and event ledger; therefore NPC history,
  knowledge, and relationship components receive zero writes on rejection.
- Existing `validateAction` remains the action-validation gate for tampered/stale
  actions; `resolveByType` does not bypass it. The focused tests also cover
  duplicate actionId replay without a second item event, history entry, signal,
  or debt.
- Quest relationship continuity requires all three explicit facts: a completed
  `talk_to_npc` objective naming the NPC, a completed current dialogue session for
  that same NPC, and an action context whose `participantNpcId` matches exactly.
  The signal is the existing `kept_promise` policy row; no numeric payload is
  supplied.
- Location, enemy, item, and fact objectives remain relationship-neutral even
  when an NPC is present as focus/participant context. A replayed action already
  present in NPC history/evidence produces no second quest relationship reward.
- `resolveTurn` computes `actionWasAlreadyUsed` from the回合开始 authoritative
  NPC history/evidence/event ledger and passes the smallest explicit context to reconciliation. The
  automatic investigation reconciliation has no participant context and cannot
  emit the NPC signal. Quest event/status ordering and historical
  `item_obtained` semantics are unchanged.
- `npc_dialogue_completed` and `item_given` now carry optional server-owned
  `actionId` evidence. Persistence validation accepts the field only as an
  optional string, so old events without it remain readable and malformed values
  fail closed. `npcUsedAction` checks these append-only ledger events in addition
  to capped NPC memory; `actionWasAlreadyUsed` is computed from the world at the
  start of the current turn, so the current turn's newly written history is not
  mistaken for a replay.

## Changed files

- `src/game/gameplay/rpg/ruleEngine/resolveByType.ts`
- `src/game/gameplay/rpg/ruleEngine/resolveByType.test.ts`
- `src/game/gameplay/rpg/ruleEngine/reconcileQuests.ts`
- `src/game/gameplay/rpg/ruleEngine/reconcileQuests.test.ts`
- `src/game/gameplay/rpg/ruleEngine/index.ts` (narrow caller context wiring)
- `src/game/domain/worldEntity.ts` (server-owned sealed marker constant)
- `src/game/domain/events.ts` and `src/game/domain/events.test.ts` (optional
  action evidence with legacy-compatible types)
- `src/game/application/server/persistence/worldStatePersistenceValidation.ts`
  and its test (optional event field validation)

The report is tracked with this change. No Task 7B
`buildEncounter`, combat, `performBattleRound`, or `combatView` file was edited.

## Verification

Required gates all passed:

- focused brief tests: 47/47;
- full suite: 170 files, 2260/2260;
- `npm run typecheck`;
- `npm run lint`;
- `npm run test:boundaries`: 105/105;
- `npm run check:standards`.

Task 7B combat/encounter implementation remains deferred and untouched.

## Repair round — P1/P2 (2026-09-01)

- **P1 RED:** after adding tests for ordinary items, `kind: "key"` → display
  `category: "quest"` without a marker, explicit display `category: "quest"`
  without a marker, and a marked item, the focused rule suites failed because
  the old implementation used display category. The persistence action-evidence
  acceptance test also failed. Clean RED result: 3 files, 51 passed / 5 failed.
- **P1 GREEN:** moved the rule decision to the server-owned sealed
  `RETURN_REQUIRED_ITEM_TAG` constant. Tests prove only the explicit tag opens
  the `source_owes_target` debt; projection and projected compatibility item
  tags remain identical. Ordinary/display-only items record `offered_help` and
  no commitment. No Action or AI payload carries debt state.
- **P2 GREEN:** added optional `actionId` to server-generated
  `npc_dialogue_completed` and `item_given` events, wired both producers, and
  added optional-string persistence validation. `npcUsedAction` now checks the
  append-only `eventLedger`, which is persisted and included in battle rollback
  snapshots; legacy events without `actionId` remain valid. The regression test
  keeps ten newer history entries while the old action survives only in the
  event ledger and verifies no second `kept_promise` signal. A separate test
  proves `actionWasAlreadyUsed: false` allows the current action even when its
  history entry is already present before reconciliation.
- **REFACTOR/gates:** related ruleEngine/events/persistence tests passed 16 files
  / 211 tests; focused Task 7A suites passed 47/47; typecheck, lint,
  `test:boundaries` 105/105, `check:standards`, and `git diff --check` passed;
  full suite passed 170 files / 2260 tests.
- Repair changed only the Task 7A rule/tests, the necessary caller and event
  persistence/type definitions/tests, and this report. Task 7B combat,
  encounter, `performBattleRound`, and `combatView` files remain unmodified.
