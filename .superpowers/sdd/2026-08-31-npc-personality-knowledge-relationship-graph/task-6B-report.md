# Task 6B report — world-delta directed relationship seeds

## Result

Implemented Plan 3 Task 6B on top of the reviewed Task 6A head. The world-delta
NPC creation contract now requires canonical anchors, typed goal proposals, and
an explicit `relationshipSeeds` array. The live world-evolution parser is
fail-closed for missing fields, unknown keys, AI-owned goal/runtime fields, and
relationship numeric/runtime fields.

Approval validates each seed against an application-supplied entity-context
closure and the authoritative entity store. Only existing active NPC targets
are accepted; self, inactive, unknown/out-of-closure, duplicate, malformed,
and overlong inputs are rejected. Stance mapping is server-owned and bounded:
positive stances produce `cooperative`, negative stances produce `wary`, and
`indebted_to` creates exactly one server-minted open `source_owes_target` debt.
The diagnostic reason is not persisted. Edges are directed from the new NPC to
the target; no reverse edge is created.

The approved `npcCreationComponentsById` map remains the sole production input
for new NPC layered components. Goal IDs/status, commitment IDs, and initial
relationship provenance are server-minted. Materialization preserves existing
NPC records exactly and retains the normal new-NPC-to-player edge. Existing
world evolution, location/town/quest behavior, rollback, provider call counts,
and CAS/API behavior remain unchanged. Provider prompt/createGame stock-source
wiring remains intentionally deferred to Task 6C.

## RED → GREEN → REFACTOR evidence

### RED

Added parser and approval tests before the implementation, then ran:

```text
npm test -- src/game/application/server/ai/worldEvolutionSource.test.ts src/game/gameplay/rpg/worldEvolution/approveWorldDelta.test.ts
```

Initial result: 2 files, 72 passing tests and 8 expected failures. The failures
covered missing parsed seeds, missing closure rejection, absent seed edges, and
closure membership not being enforced.

### GREEN

The first minimal implementation passed the core focused suite. Additional
approval boundary tests and explicit materialization/previous-component tests
were added; the focused world-delta suite finished with 3 files / 94 tests
passed. The combined world-delta, opening, and world-evolution suite finished
with 12 files / 178 tests passed.

### REFACTOR

- Reused canonical NPC creation bounds and closed unions for seed parsing.
- Centralized fixed stance mapping in the relationship gameplay policy.
- Added an explicit application closure builder and threaded it through the
  existing world-delta approval callers without adding provider calls.
- Kept seed reasons out of edge/source/commitment data and kept the existing
  explicit component-map materializer path intact.
- Updated deterministic and test proposals to the required typed shape without
  changing Task 6C provider prompt/source contract wiring.

## Verification

- Focused world-delta/opening/world-evolution: 12 files / 178 tests passed.
- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm run test:boundaries`: 105 tests passed.
- `npm run check:standards`: passed (`@ai-game/standards@0.5.0`).
- `npm test`: 170 files / 2,236 tests passed.
- `git diff --check`: passed.
- Source scan: no production `importNpcLayers` call or legacy/default
  materializer fallback was introduced; production materialization consumes the
  approved explicit component map.

## Commit

Subject: `feat(npc): materialize directed relationship seeds`

## Concerns

No blocking concerns. Task 6C still owns provider prompt and createGame stock
source wiring, which is intentionally not included here.
