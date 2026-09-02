# Task 5E report — remove the legacy NPC memory write bridge

## Status

PASS. The legacy whole-component NPC write path is removed and the requested gates are green.

## RED evidence

Tests were adjusted before production deletion and run with:

```text
npm test -- src/game/gameplay/rpg/entityWorld/entityMutation.test.ts src/game/application/performBattleRound.test.ts
```

The probe failed for the intended reason: `entityMutation.test.ts` had 4 failing writer-surface assertions because the production `applyOne` switch still reported `sync_npc_legacy_memory` as a relationships, knowledge, history, and dynamic-state writer. The battle test already passed after its helper was retargeted to narrow mutations, proving the rollback assertions exercised real component changes rather than the deleted bridge.

## GREEN / refactor evidence

- Removed `sync_npc_legacy_memory` from the `EntityMutation` union and handler.
- Deleted `compileLegacyNpcSync`, `NpcLegacySyncLayers`, `AddedNpcKnowledge`, and `NpcLegacyBridgeError` plus their exports and bridge-only tests.
- Kept `importNpcLayers`, normalization, and deterministic `legacy_import` construction. The adapter now only constructs initial-world knowledge provenance; action provenance remains owned by `npcKnowledge.ts`.
- Retargeted the mid-battle fixture to `record_npc_knowledge`, `apply_relationship_signal`, `record_npc_interaction`, and `set_npc_emotion`.
- Made `formatNpcInteractionSummary` module-private.
- Removed unused `RELATIONSHIP_CHANGE` constants and their obsolete test.
- Reworded the remaining historical propagation test comment so the required scans are clean.

## Rollback proof

The mid-battle helper changes all four required live components through narrow mutations: dynamic state via emotion, knowledge via a `player_told` fact, the player relationship via `supported`, and history via an interaction whose learned fact is already recorded. Both defeat and withdraw tests assert:

- each modified component differs from the pre-battle record before resolution;
- the complete NPC record, including identity, dynamic state, knowledge, relationships, history, core, and position, equals the pre-battle NPC;
- the complete EntityStore and event ledger equal the pre-battle snapshot;
- battle state returns to idle;
- the compatibility projection also returns to the pre-battle projection.

## Files changed

```text
M src/game/application/performBattleRound.test.ts
M src/game/domain/entity/index.ts
M src/game/domain/entity/npcProjection.test.ts
M src/game/domain/entity/npcProjection.ts
M src/game/domain/relationship.test.ts
M src/game/domain/relationship.ts
M src/game/gameplay/rpg/entityWorld/entityMutation.test.ts
M src/game/gameplay/rpg/entityWorld/entityMutation.ts
M src/game/gameplay/rpg/npcMemory/npcKnowledge.ts
M src/game/gameplay/rpg/ruleEngine/propagateKnownFacts.test.ts
D src/game/gameplay/rpg/ruleEngine/updateNpcMemory.test.ts
D src/game/gameplay/rpg/ruleEngine/updateNpcMemory.ts
```

## Source-scan gates

Commands were run exactly as specified:

```text
rg -n "replace_npc_state|sync_npc_legacy_memory|updateNpcMemory|npcState\.memory" src
rg_exit=1

rg -n "compileLegacyNpcSync|NpcLegacySyncLayers|AddedNpcKnowledge|NpcLegacyBridgeError" src
rg_exit=1

rg -n "RELATIONSHIP_CHANGE" src
rg_exit=1
```

All three scans produced no matches.

## Verification

- Focused entity/rule/battle/domain run: 22 test files passed, 424 tests passed.
- Full `npm test`: 170 test files passed, 2207 tests passed.
- `npm run typecheck`: passed.
- `npm run check:standards`: passed (`@ai-game/standards@0.5.0`).
- `npm run test:boundaries`: 2 test files passed, 105 tests passed.
- `npm run lint`: passed with zero errors and zero warnings.
- `git diff --check`: passed.

## Concerns

No known concerns. `importNpcLayers` remains intentionally available for compatibility projection and existing fixtures; no gameplay caller can use it as a live write path.

## Reviewer fix TDD cycle

### RED — before the fix

The falsifiable adapter tests were added before changing production code and run with:

```text
npm test -- src/game/domain/entity/npcProjection.test.ts
```

The exact result was:

```text
FAIL src/game/domain/entity/npcProjection.test.ts > npc projection：previous store 的分层组件逐字保留 > 兼容字段只映射显式 hidden：保留旧 disclosure 与 provenance，不静默降级 secret
AssertionError: expected ... to deeply equal ...
- Expected: disclosure "secret"
+ Received: disclosure "public"
Test Files  1 failed (1)
Tests       1 failed | 12 passed (13)
```

This proved the old adapter retained the action source but silently demoted a retained secret when the compatibility `hiddenFactIds` omitted it.

### GREEN — after the minimal implementation

`compileKnowledge` was replaced by the private `importLegacyKnowledge` helper. Retained certainty, disclosure, and provenance are preserved; only an explicitly present legacy hidden ID maps disclosure to `secret`; new legacy IDs receive only `{ kind: "initial_world", learnedAtTurn }`. The adapter has no action-source input or construction path.

The focused adapter run then passed:

```text
Test Files  1 passed (1)
Tests       13 passed (13)
```

### REFACTOR

The helper and public adapter now carry explicit compatibility-only names/documentation. Existing import, normalization, deterministic `legacy_import` anchors/goals/relationship construction, and all prior provenance-preservation tests remain unchanged in behavior.

## Post-fix verification

After the reviewer fix, the complete required gate set passed:

- Focused adapter run: 1 test file passed, 13 tests passed.
- Focused entity/rule/battle/domain run: 22 test files passed, 424 tests passed.
- Full `npm test`: 170 test files passed, 2207 tests passed.
- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm run test:boundaries`: 2 test files passed, 105 tests passed.
- `npm run check:standards`: passed (`@ai-game/standards@0.5.0`).
- `git diff --check`: passed.
- All three required source scans exited 1 with no matches.
