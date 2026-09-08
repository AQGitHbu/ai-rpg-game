# Story Quality Run and Debug Plan

> **For agentic workers:** This is a diagnostic and evaluation plan. Execute the checks in order and preserve failing artifacts before changing implementation.

**Goal:** Establish a reproducible baseline for current RPG story quality, separate product-quality failures from evaluator/tooling failures, and produce prioritized optimization actions.

**Architecture:** Use three evidence layers: deterministic game/runtime correctness, story-evaluation artifact completeness and objective metrics, then human/LLM judgment of the player-visible story. Offline replay establishes code and contract health; gated real-AI runs measure model-dependent quality only after offline gates pass.

**Tech Stack:** Next.js/TypeScript, Vitest, Node `--test`, SQLite test repositories, JSONL evaluation artifacts, optional real AI provider.

## Global Constraints

- Run commands inside `F:\AI2\ai-rpg-game\.worktrees\ai-story-quality-eval`.
- Do not modify `../ai-game-foundation` or the `.foundation` junction.
- Preserve existing user changes and do not delete incomplete evaluation artifacts.
- Treat an incomplete artifact as a failed evaluation run, not as a zero-quality score.
- Do not run real-AI baseline until offline checks and one-case calibration pass.

## Quality Definition

Game quality is the intersection of:

1. **Playable correctness:** the game reaches a valid ending or reports a stable, diagnosable failure; rules, persistence, boundaries, type checks, and UI/API contracts remain valid.
2. **Story experience:** the generated story has structure and escalation (S1–S2), planted-and-paid-off information (S3), bounded surprise (S4), functional entities (S5), motivated conflict and ending (S6–S7), meaningful choice consequences and agency (S8–S9), plus scene-level NPC consistency (C1), continuity (C2), choice quality (C3), and prose quality (C4).
3. **Evidence trustworthiness:** every scored run has required calls, manifest, answer key, previous-scene context, NPC profile/relationship/memory evidence, safe event IDs, and paired-branch evidence where S8/S9 are interpreted above the cap of 3.

Report these dimensions separately; do not collapse them into one unsupported score. The v2 scale and objective metric definitions in `docs/archive/AI内容质量评估标准.md` are authoritative.

## Execution Gates

### Gate 1: Story-evaluation offline regression

Run:

```powershell
npm run test:story-eval-journey
npm run test:story-eval-journey-script
npm run test:story-eval-analyze
npm run test:story-eval-judge
npm run journey:story-eval
```

Expected: all tests pass; replay exits successfully and produces a complete artifact. If replay is incomplete, inspect `manifest.json`, `calls.jsonl`, and `story.jsonl` before any score is reported.

### Gate 2: RPG application behavior

Run:

```powershell
npm run test:game-domain
npm run test:game-gameplay
npm run test:game-application
npm run test:components
npm run test:app
```

Expected: deterministic rules, application orchestration, UI, and API tests pass. Failures are categorized by subsystem and reproduced with the narrowest test command.

### Gate 3: Static and architectural acceptance

Run:

```powershell
npm run lint
npm run typecheck
npm run test:boundaries
npm run test:fast
npm run build
```

Expected: lint, typecheck, boundary guards, standards/foundation checks, and production build pass offline. A failure here is an engineering-quality blocker even when story prose looks good.

### Gate 4: One-case real-AI calibration

After Gates 1–3 pass, run one fixed case with both strategies and branch evidence:

```powershell
$env:RUN_REAL_AI_STORY_EVAL='1'
$env:STORY_EVAL_PROFILE='regression'
npm run smoke:ai:story-eval -- --case=wuxia-a
```

Then analyze the resulting run directory and run the gated judge. Review all low-scoring evidence and three deterministic spot checks manually; repeat with an independent judge model when calibrating S4 and subjective dimensions.

### Gate 5: Baseline matrix

Only after calibration is accepted, run all six cases × two strategies with `STORY_EVAL_PROFILE=baseline`, then aggregate per-case/per-strategy mean, median, worst score, null/incomplete rate, objective metrics, and timings. The result is a descriptive v2 baseline for the tested model/configuration, not a universal pass line.

## Debugging Order

1. Fix incomplete artifacts and deterministic test failures.
2. Fix rule/state/persistence defects that change the player-visible path.
3. Fix evaluator evidence gaps or metric-definition bugs.
4. Fix repeated fallback, invalid JSON, approval rejection, and timeout hotspots.
5. Optimize story structure, choice consequence, entity adoption, continuity, and prose using evidence from the baseline.

## Deliverables

- A command-by-command test result summary with exact failures.
- A reproducible artifact directory for each real-AI run; no scored result from incomplete artifacts.
- Separate engineering blockers, evaluator trust issues, and story-quality opportunities.
- A prioritized optimization backlog with a regression metric and rerun command for every change.

## Run Log (2026-08-02)

- Offline story-evaluation tests, replay, RPG layer tests, full `npm test`, typecheck, boundaries, `test:fast`, and production build passed after synchronizing the generated standards copy from the clean foundation main repository.
- Lint passed with five unused-variable warnings in story-evaluation test files; no lint errors.
- Real smoke for `wuxia-a` ran both strategies. `objective` produced a complete three-scene artifact with `fallbackRate=0`, but stopped at `max_scenes` without an ending. `explore` failed the generated-opening gate and left calls-only incomplete evidence, so neither run is a formal baseline score.
- The successful smoke artifact showed a flat three-scene tension sequence (`2, 2, 2`), missed the planned `fact_premise`, and had no paired branch evidence; use regression profile before drawing story-level conclusions.
- After reference-aware NPC pruning and an explicit `obtain_item` objective prompt constraint, the follow-up smoke run produced complete artifacts for both strategies. Explore had `fallbackRate=0` and tension `2,1,2`; objective had `fallbackRate=0.333` and tension `1,2`. Both stopped at the smoke `max_scenes=3` cap, so they remain calibration evidence rather than a formal baseline.
- The explore judge report was generated at `artifacts/story-eval/wuxia-a-explore-0-2026-08-02T03-50-36-339Z-6c3762bc`, with C1/C2/C3 unavailable due short-run evidence gaps and low story-level scores concentrated in payoff, progression, entity function, ending motivation, and choice consequence. Next optimization should target longer traces, fact reveal adoption, and paired branch evidence.
- The next regression exposed a separate optional item-presentation contract drift: `items[2].rarity=legendary` invalidated an otherwise usable candidate. The diagnostic calls-only artifact is preserved at `artifacts/story-eval/wuxia-a-explore-0-2026-08-02T05-32-02-537Z-4d5dd44a`; the repair now strips only invalid presentation metadata and hardens the prompt contract.
- The post-repair smoke returned `REAL_AI_JOURNEY_OK` with complete explore/objective artifacts at `artifacts/story-eval/wuxia-a-explore-0-2026-08-02T05-48-44-810Z-ee367cd3` and `artifacts/story-eval/wuxia-a-objective-1-2026-08-02T05-51-11-164Z-05d241cc`. Both had `fallbackRate=0`, flat tension `2,2,2`, no paired branches, and therefore remain calibration evidence; objective still missed the planned identity/premise fact reveal. A new judge attempt timed out before producing scores.
- The request path was audited and confirmed to hard-code `enable_thinking:false` for scenario, director, writer, and NPC. A role-scoped opt-in `AI_THINKING_ROLES` switch was added with default-off behavior, manifest evidence, and offline coverage.
- The `director,writer` treatment completed on a second attempt at `artifacts/story-eval/wuxia-a-explore-0-2026-08-02T06-59-27-681Z-3816d4f6` and `artifacts/story-eval/wuxia-a-objective-1-2026-08-02T07-02-35-585Z-73f414d8`. Explore stayed at tension `2,2,2`; objective was `1,2,2`; both had zero fallback and no paired branches. This is not enough evidence to make thinking the default, and the provider does not expose an acknowledgement that proves internal reasoning tokens were actually used.
- To isolate a role and control wall-clock cost, the runner now supports `--strategy=explore|objective`. A director-only 12-scene regression completed at `artifacts/story-eval/wuxia-a-explore-0-2026-08-02T08-14-42-180Z-4248d344`; the no-thinking explore control completed at `artifacts/story-eval/wuxia-a-explore-0-2026-08-02T08-31-18-044Z-608e80e7`. Both had 12 scenes and zero fallback. The thinking run showed a stronger tension arc (`stddev 1.374` vs `0.500`) and balanced setup/develop/climax pacing, but still missed premise/identity facts and had no paired choice evidence. The control had one paired choice with state/event/narration differences and more NPC contributions. Since the two generated world seeds differ, this is only a hypothesis signal; no production default change is justified.
- The full regression command hit the 900-second outer shell limit during the objective run; the objective calls-only artifact is intentionally excluded from scoring. The next quality-testing optimization should reduce provider wait/total budget or add blueprint reuse before running the remaining writer/double-thinking arms.
- The runner now supports `--blueprint-artifact=<calls.jsonl>` for controlled A/B: the captured scenario candidate is revalidated/compiled, and the manifest marks `blueprintSource=captured_artifact` without storing the path. With the same world seed, the pre-fix director-thinking run exhausted at 8 scenes after staying at stage 1 and persisting three expansions, while the no-thinking control reached 12 scenes/stage 3.
- The director prompt was hardened to prioritize main-quest actions and treat expansion as a rare fallback. Post-fix fixed-blueprint smoke had zero approved expansion, and post-fix regression `artifacts/story-eval/wuxia-a-explore-0-2026-08-02T09-13-13-992Z-75fa3c74` reached 12 scenes/stage 8 with zero fallback and zero persisted expansion. This is the current optimization result; a post-fix no-thinking control and multi-seed replication remain before changing the default thinking configuration.
- The post-fix no-thinking control completed at `artifacts/story-eval/wuxia-a-explore-0-2026-08-02T09-39-20-265Z-6c4c11f3`: 10 scenes before exhaustion, stage 3, zero fallback, zero actual expansion, and flatter tension (`stddev=0.500`). The post-fix director-thinking run reached 12 scenes/stage 8 with `stddev=1.323`. This supports using director thinking as a dev/staging candidate, while the production default remains off until multi-seed replication and fact/branch metrics are acceptable.
- Multi-seed fixed-blueprint replication (seeds `20260731/20260732/20260733`) completed for both arms. Thinking averaged 11.67 scenes and reached stage 8 in all three runs; no-thinking averaged 11 scenes and ended at stages 3/8/4. Thinking had higher mean tension variance (`1.216` vs `0.773`) and slightly higher fact recall (`2/20` vs `1/17`), but both arms had zero fallback, zero paired branches, zero item contribution, no ending convergence, and zero approved/persisted/adopted expansion. This confirms a progression signal, not a production-quality verdict; keep the default off and prioritize fact/choice/ending instrumentation and repairs.
- Mainline objective repair completed with `fallback-5`: the prior stage jump came from repeated state-backed objectives in the shared template, not from the thinking flag. Full offline gates passed (149 test files, 1616 passed, 4 skipped), and a fresh real-AI blueprint was captured at `artifacts/story-eval/wuxia-a-explore-0-2026-08-02T12-35-32-525Z-e667efda`.
- Post-fix same-blueprint comparison: director-thinking artifact `...12-35-32-525Z-e667efda` reached 12 scenes with recorded stages `1,1,1,1,1,2,2,2,2,2,2,2`, `fallbackRate=0`, `tensionStddev=0.373`, and no writer retry; no-thinking control `artifacts/story-eval/wuxia-a-explore-0-2026-08-02T12-46-16-902Z-8595d1da` reached recorded stages `1,1,1,1,2,3,3,3,5,5,5,5`, `fallbackRate=0`, `tensionStddev=0.624`, one valid paired branch, and three writer invalid-JSON retries. Both stopped at `max_scenes`, so the evidence is a mainline-target selection signal rather than a final quality verdict.
- Active-main-objective follow-up smoke completed at `artifacts/story-eval/wuxia-a-explore-0-2026-08-02T13-06-40-551Z-8fdb4870`: the real director request carried `visit_location:loc_2` with legal action `move:loc_2`, and the first recommendation was `move:loc_2`; the 3-scene smoke had `fallbackRate=0`. This validates the runtime wiring only; it is not a baseline because it stopped at the smoke scene cap without an ending.

## Structural audit and post-repair regression (2026-08-02)

The quality contract is now recorded as six separate dimensions: playable correctness, progression/agency, narrative structure, role separation/continuity, world/item function, and evidence trustworthiness. A prose score alone cannot certify the game: the rule path and the evidence path must both be valid.

The audit found the main normal-progression break at `Director plan → Writer choices → narrative choice → resolver → quest reconciliation`. Director previously had no authoritative active target/route/location/item projection; Writer lacked authoritative item cards and could narrate an item as obtained; NPC fact permissions were not intersected with the actor's own knowledge; and ordinary `talk` did not write the same relationship/memory event as dialogue choices. The fallback chain also repeated state-backed objectives, allowing reconciliation fixed-point cascades and jump scenes. Thinking was therefore a secondary hypothesis, not the primary defect.

Repairs now include fallback template `fallback-6`, repeated-objective validation, `activeMainObjective` with legal next-hop projection, current location/item cards, writer-to-NPC fact intersection, direct-talk relationship persistence, and role-scoped thinking default-off. `actionEvents` was added to story artifacts so a scene's selected action is evaluated against the events it actually caused; old artifacts fall back to `newEvents` for compatibility. The story runner now uses a single fork to avoid long-run Windows tinypool worker shutdowns masking completed artifacts.

The clean real regression command was:

```powershell
$env:RUN_REAL_AI_STORY_EVAL='1'
$env:STORY_EVAL_PROFILE='regression'
$env:AI_THINKING_ROLES=''
npm run smoke:ai:story-eval -- --case=wuxia-a --strategy=objective --runs=1 --seed=20260801
npm run analyze:story-eval -- artifacts/story-eval/wuxia-a-objective-0-2026-08-02T14-52-37-704Z-77b9febf
```

Result: `REAL_AI_JOURNEY_OK`; 12 scenes, `status=max_scenes`, no ending within the regression cap, runtime `fallbackRate=0`, and no role retries/failures. The mainline next-hop was presented/chosen `12/12`; direct target presented/chosen `7/12`; target rule events hit `7/12`; all 12 scene rows contained progress events. The item objective was reached `1/1`, including an `item_obtained` action event and one item contribution. One paired branch had state/event/narration differences. Remaining quality gaps were fact recall (planned `fact_identity/fact_premise` not actually discovered), `illegalOrderCount=2`, and no ending evidence at 12 scenes. This is regression evidence, not a formal baseline.

## Extended convergence regression (2026-08-02)

The same captured blueprint and no-thinking objective run was repeated with `STORY_EVAL_MAX_SCENES=16`, producing `artifacts/story-eval/wuxia-a-objective-0-2026-08-02T15-51-24-935Z-c88065e9`. It converged after 13 narrative scenes with zero fallback and no role retries/failures. The final scene selected `start_battle:enemy_boss`; the battle loop then reached the ending. The regression default is now 16 scenes because the 12-scene cap was shorter than this valid long-mainline route.

The analyzer also now treats `battle_started` as the direct `defeat_enemy` objective event; `enemy_defeated` and the ending remain separate battle-resolution evidence. Corrected metrics are mainline direct-target presented/chosen `8/13`, objective-event hits `8/13`, and progressed scenes `13/13`; `pacing.illegalOrderCount=2` remains a narrative-structure follow-up.

## Fact metric correction (2026-08-02)

The previous regression note used an invalid comparison: `allowedRevealFactIds` is a discovered-only permission for narrative citation, while `fact_discovered` is produced by a player `investigate` action. They are not the same planned-versus-actual channel. The runtime now passes discovered fact cards and the Director's `relevantFactIds` into the Writer handoff, and story rows capture `usedFactIds`/`npcUsedFactIds`. `factsPerAct.actualFactIds` now measures narrative citation; `discoveredFactIds` separately measures rule investigation. Historical artifacts remain readable through a compatibility fallback but must not be pooled with new runs without a version note.

The first post-schema run is also preserved at `artifacts/story-eval/wuxia-a-objective-0-2026-08-02T14-42-03-080Z-d5bf6f8a`; it wrote a complete 12-scene artifact but the multi-worker runner exited with `Worker exited unexpectedly`, so it is diagnostic only and not used for the clean run conclusion.
