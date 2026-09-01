# Task 5C2 report — `give_item` mutation migration

## Result

Implemented and verified the `give_item` migration on the reviewed Task 5C1 head.
The path now submits one atomic `applyEntityMutations` batch in this order:

1. `transfer_item` to the recipient NPC.
2. `apply_relationship_signal` with the existing `gave_item` signal on the directed NPC → player edge.
3. `record_npc_interaction` with the locked `offer` payload.

The legacy `updateNpcMemory` / `compileLegacyNpcSync` / `sync_npc_legacy_memory` path is no longer used by
`give_item`.

## TDD evidence

### RED

Added the give-item behavior tests before changing production code and ran:

```text
npm test -- src/game/gameplay/rpg/ruleEngine/resolveByType.test.ts
```

Result: 31 tests ran, 28 passed, 3 failed. The failures demonstrated the missing migration behavior:

- the bridge produced legacy affinity `+1` (`3`) instead of the policy's `gave_item` affinity `+4` (`6` from an initial `2`);
- replaying the same `actionId` succeeded instead of returning `ok:false` with `世界状态不一致。`;
- an inactive recipient mutation succeeded instead of failing atomically.

### GREEN

Replaced only the `give_item` implementation with the narrow mutation batch and reran the focused command.

Result: 31 tests passed.

The tests cover transfer/event behavior, the directed evidence-bound relationship signal, policy-derived affinity,
the interaction's stamped relationship delta and exact offer payload, duplicate action atomicity, failed mutation
atomicity, and reference identity for unrelated NPC components.

## Behavior decisions

- The deterministic `topicSummary` remains `收到玩家交付的{item.name}`.
- `record_npc_interaction` supplies no `relationshipDelta` or `summary`; the entity mutation stamps both from the
  actual signal delta.
- The rule seam test for duplicate action IDs calls `resolveByType` directly. The signal mutation is a no-op on the
  replayed evidence, then the duplicate interaction mutation rejects the batch; the original records and event
  ledger remain reference-identical and no second `item_given` event is appended.
- An inactive NPC exercises mutation failure after the transfer appears in the batch. The entity mutation layer
  rejects the batch atomically, so the source records and event ledger remain unchanged.
- No new signal, direct numeric relationship write, provider/client call, or commitment category table was added.

## Files changed

- `src/game/gameplay/rpg/ruleEngine/resolveByType.ts`
- `src/game/gameplay/rpg/ruleEngine/resolveByType.test.ts`
- `.superpowers/sdd/2026-08-31-npc-personality-knowledge-relationship-graph/task-5C2-report.md`

## Verification

| Command | Result |
|---|---:|
| `npm test -- src/game/gameplay/rpg/ruleEngine/resolveByType.test.ts` (GREEN) | 1 file, 31 tests passed |
| focused entity/rule tests (`resolveByType`, `entityMutation`, `npcProjection`) | 3 files, 175 tests passed |
| `npm run test:game-gameplay` | 50 files, 751 tests passed |
| `npm test` | 171 files, 2,227 tests passed |
| `npm run typecheck` | passed |
| `npx eslint src/game/gameplay/rpg/ruleEngine` | passed |
| `npm run test:boundaries` | 2 files, 105 tests passed |
| `npm run check:standards` | passed |
| `git diff --check` | passed |

## Concerns

No pre-existing full-suite failures were observed. The full suite emitted the existing JSON logging-fallback
stderr line from `serverConsoleLogger.test.ts`; that test passed and does not indicate a regression.
