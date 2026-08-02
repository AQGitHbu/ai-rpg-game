# Plan: Repair authorized fact coverage in runtime narrative

**Goal:** Make the fact-quality signal represent what the player can actually learn from a scene, and improve the Director → Writer handoff so approved, discovered facts are intentionally used without allowing hidden-fact leakage.

**Architecture:** Keep `fact_discovered` as a rules/action event for player investigation. Treat `allowedRevealFactIds` as a narrative permission for already-discovered facts, and treat `usedFactIds` on the approved scene/NPC output as the evidence of player-visible fact usage. The Director will receive safe fact cards, the Writer will receive the Director’s relevant-fact intent, and the evaluator will report discovery and narrative usage separately.

**Tech Stack:** TypeScript/Vitest runtime narrative contexts and approvals; JSONL story-evaluation artifacts; Node analyzer tests.

## Implementation tasks

1. Add focused tests for Director fact-card projection, Writer relevant-fact handoff, and runtime repair of relevant facts into safe reveal permissions.
2. Extend Director and Writer contexts with only discovered fact text and approved IDs; preserve hidden-fact and NPC knowledge boundaries.
3. Harden the Director/Writer prompt contract so relevant approved facts are intentionally used and `usedFactIds` remains an honest evidence list.
4. Capture scene and NPC fact usage in story-evaluation rows and split analyzer metrics into rule discovery versus narrative usage.
5. Run targeted tests, offline gates, and replay; update the quality audit with the corrected metric semantics and remaining real-AI rerun command.

## Verification

- `npm test`
- `npm run test:fast`
- `npm run lint`
- `npm run build`
- `npm run journey:story-eval`
- `node --test scripts/storyEvalAnalyze.node-test.mjs`

## Post-run metric correction

The fixed-blueprint 16-scene regression reached the boss and converged in 13
scenes. Its final narrative scene emits `battle_started`; the subsequent
`battle_action` loop emits the combat result without consuming another
narrative scene. The analyzer therefore treats `battle_started` as the direct
`defeat_enemy` objective hit, while `enemy_defeated` and the ending remain the
evidence for battle resolution. This prevents a converged run from being
reported as a missed final objective.
