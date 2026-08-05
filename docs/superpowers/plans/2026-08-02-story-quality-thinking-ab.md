# Story Quality Thinking A/B Experiment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make provider extended reasoning an explicit, role-scoped, opt-in experiment so we can measure whether director/writer reasoning improves story quality without changing the default game behavior.

**Architecture:** Parse a closed `AI_THINKING_ROLES` environment variable once in the application AI layer. Pass the selected roles to the live scenario/runtime sources, which emit the provider-specific `enable_thinking` flag while keeping the current default false. Record the selected roles in story-evaluation manifests so metrics and artifacts are comparable.

**Tech Stack:** TypeScript, Vitest, existing OpenAI-compatible transport, story-evaluation smoke artifacts.

## Global Constraints

- Do not modify `@ai-game/*` packages or the protected foundation sibling repository.
- Default behavior remains `enable_thinking:false` when `AI_THINKING_ROLES` is unset or invalid.
- Accept only `scenario`, `director`, `writer`, and `npc`; ignore unknown role names and duplicate entries.
- The experiment must not expose prompts, provider responses, API keys, or model secrets in logs or manifests.
- Compare reliability and objective story metrics separately; a three-scene smoke is calibration evidence, not a formal quality baseline.

---

### Task 1: Add failing tests for role-scoped thinking configuration

**Files:**
- Create: `src/game/application/server/ai/aiThinking.ts`
- Create: `src/game/application/server/ai/aiThinking.test.ts`
- Modify: `src/game/application/server/ai/liveRuntimeNarrativeSources.storyEval.test.ts`
- Modify: `src/game/application/server/ai/scenarioCandidateSourceFactory.test.ts`

**Interfaces:**
- Consumes: `Record<string, string | undefined>` environment values and live source request options.
- Produces: `resolveAiThinkingRoles(env)` returning a stable readonly role list and source tests proving only selected roles receive `enable_thinking:true`.

- [x] **Step 1: Write the parser tests**

Assert that unset/invalid input returns `[]`, while `"writer,director,writer,unknown"` returns `['director', 'writer']` in stable order.

- [x] **Step 2: Write runtime source transport-option tests**

Inject a fake transport, call director/writer/NPC sources with `thinkingRoles: ['director', 'writer']`, and assert their request options contain `enable_thinking: true, true, false` respectively.

- [x] **Step 3: Write scenario factory opt-in coverage**

Create the source with `AI_THINKING_ROLES: 'scenario'`, invoke it with the existing valid fixture input, and assert the transport options contain `enable_thinking:true`.

- [x] **Step 4: Run the focused tests and verify they fail**

Run:

```powershell
npx vitest run src/game/application/server/ai/aiThinking.test.ts src/game/application/server/ai/liveRuntimeNarrativeSources.storyEval.test.ts src/game/application/server/ai/scenarioCandidateSourceFactory.test.ts
```

Expected: the new parser/source tests fail because the helper and options do not exist; existing tests remain green.

### Task 2: Implement opt-in thinking and manifest evidence

**Files:**
- Modify: `src/game/application/server/ai/aiThinking.ts`
- Modify: `src/game/application/server/ai/liveScenarioCandidateSource.ts`
- Modify: `src/game/application/server/ai/liveRuntimeNarrativeSources.ts`
- Modify: `src/game/application/server/ai/scenarioCandidateSourceFactory.ts`
- Modify: `src/game/application/server/ai/runtimeNarrativeSourceFactory.ts`
- Modify: `src/game/application/testing/storyEvalJourney.test.ts`
- Modify: `.env.example`

**Interfaces:**
- `resolveAiThinkingRoles(env)` returns `readonly ('scenario'|'director'|'writer'|'npc')[]`.
- Scenario live source receives `enableThinking?: boolean`.
- Runtime live sources receive `thinkingRoles?: readonly ('director'|'writer'|'npc')[]`.
- `manifest.json` gains `thinkingRoles` with the same sanitized role names.

- [x] **Step 1: Implement the closed role parser**

Normalize comma-separated values, filter to the four allowed roles, deduplicate, and return the canonical order `scenario,director,writer,npc`; return an empty list for unset or invalid values.

- [x] **Step 2: Thread flags into live source requests**

Replace hard-coded `enable_thinking:false` with the source option, preserving all existing temperature, timeout, response-format, parsing, audit, and fallback behavior.

- [x] **Step 3: Thread environment configuration through both factories**

Use `resolveAiThinkingRoles(env)` at factory assembly. Enable the scenario source only when `scenario` is selected; pass the runtime subset to director/writer/NPC sources.

- [x] **Step 4: Record the selected roles in story-evaluation manifests**

Add `thinkingRoles: resolveAiThinkingRoles(env)` next to temperature/timeout, without recording the raw environment string.

- [x] **Step 5: Document the opt-in variable**

Add `AI_THINKING_ROLES=` to `.env.example` and describe default-off behavior and A/B interpretation in `docs/agent/AI内容质量评估.md`.

- [x] **Step 6: Run focused tests and typecheck**

Run the focused Vitest command from Task 1 and `npm run typecheck`; expected result is all focused tests pass and TypeScript exits 0.

### Task 3: Run the controlled A/B and update the quality record

**Files:**
- Modify: `docs/agent/AI内容质量评估.md`
- Modify: this plan's execution log
- Test artifacts: `artifacts/story-eval/`

**Interfaces:**
- Control: existing no-thinking smoke artifact for `wuxia-a`.
- Treatment: same case/profile with `AI_THINKING_ROLES=director,writer`.
- Outputs: complete manifests, objective metrics, and a bounded quality comparison.

- [x] **Step 1: Run offline gates**

Run `npm test`, `npm run lint`, `npm run test:fast`, and `npm run build`; no new errors are acceptable.

- [x] **Step 2: Run the treatment smoke**

```powershell
$env:RUN_REAL_AI_STORY_EVAL='1'
$env:STORY_EVAL_PROFILE='smoke'
$env:AI_THINKING_ROLES='director,writer'
npm run smoke:ai:story-eval -- --case=wuxia-a
```

Expected: `REAL_AI_JOURNEY_OK`, complete explore/objective artifacts, and manifests showing `thinkingRoles:["director","writer"]`.

- [x] **Step 3: Analyze and compare**

Run `npm run analyze:story-eval -- <treatmentDir>` for both treatment artifacts. Compare fallback rate, retries/timeouts, latency, tension progression, fact adoption, entity contribution, and branch evidence against the no-thinking control; do not infer causality from a single three-scene sample.

- [x] **Step 4: Record the conclusion**

Record whether thinking is a reliability cost, a measurable story-quality gain, or inconclusive. If inconclusive, use `regression` with 12 scenes before changing the default.

## Execution Log (2026-08-02)

- Before implementation, focused tests confirmed the current hard-coded request option was `enable_thinking:false` for all runtime roles and scenario generation.
- Added `AI_THINKING_ROLES`, defaulting to an empty list. The allowlist is `scenario,director,writer,npc`; unknown names are ignored and manifests record only the normalized role list.
- Focused tests passed (14 tests), followed by `npm run typecheck`.
- Offline gates passed: `npm test` (149 files, 1613 tests, 4 skipped), `npm run lint` (0 errors, 5 existing warnings), `npm run test:fast`, and `npm run build`.
- Treatment command used `AI_THINKING_ROLES=director,writer`. The first treatment run preserved one incomplete objective artifact caused by scenario `service_error` then timeout; a second same-config run returned `REAL_AI_JOURNEY_OK` with complete explore/objective artifacts.
- Complete treatment artifacts:
  - `artifacts/story-eval/wuxia-a-explore-0-2026-08-02T06-59-27-681Z-3816d4f6`: 3 scenes, `max_scenes`, `fallbackRate=0`, tension `2,2,2`, one scenario retry, no planned fact reveal.
  - `artifacts/story-eval/wuxia-a-objective-1-2026-08-02T07-02-35-585Z-73f414d8`: 3 scenes, `max_scenes`, `fallbackRate=0`, tension `1,2,2`, `tensionStddev=0.471`, no planned fact reveal.
- Compared with the no-thinking control, the treatment did not produce a stable quality lift: no treatment run had paired branch evidence, both remained three-scene samples, and fact planning varied with the generated scenario. The only consistent conclusion is that the flag is wired and reasoning may be worth testing in longer traces; do not change the default yet. A provider-side acknowledgement/telemetry signal is still absent, so manifest evidence proves request configuration rather than internal token-level reasoning.
- Added `--strategy=explore|objective` to the real-AI runner so a long comparison can isolate one strategy and stay within a bounded wall-clock budget; the default remains both strategies. Node runner coverage passed (14 tests).
- The director-only 12-scene regression completed at `artifacts/story-eval/wuxia-a-explore-0-2026-08-02T08-14-42-180Z-4248d344`: `fallbackRate=0`, tension `1,2,2,2,2,2,1,2,5,5,4,4`, `tensionStddev=1.374`, pacing `setup=4/develop=4/climax=4`, no paired branch evidence, and missed `fact_premise`/`fact_identity` reveals. It took about 9.17 minutes.
- The no-thinking 12-scene explore control completed at `artifacts/story-eval/wuxia-a-explore-0-2026-08-02T08-31-18-044Z-608e80e7`: `fallbackRate=0`, tension `2,2,3,3,2,2,2,3,3,3,2,3`, `tensionStddev=0.500`, pacing `setup=2/turn=2/develop=8`, one paired choice with state/event/narration differences, and 1 director retry/failure. It took about 12.47 minutes.
- The long comparison is a promising director-arc signal, not a causal quality win: the generated world seeds differ, director thinking still missed key facts and had zero item contribution, while the control had stronger branch/entity evidence. A full two-strategy regression exceeded the outer 900-second command window during the objective run; its incomplete calls-only artifact is preserved and is not scored. Keep the default off and require fixed-blueprint or multi-seed replication before changing it.
- Added a bounded captured-blueprint mode: `--blueprint-artifact=<run>/calls.jsonl` loads the scenario `parsedCandidate` from a prior capture, injects it only when story-eval capture is enabled, and still passes through `createGame` validation/compilation. Offline journey/composition tests, 15 node runner tests, and typecheck passed.
- Fixed-blueprint pre-fix comparison used `worldSeed=3110f434-791c-4286-a45b-d0cedf80223b`: thinking director run `artifacts/story-eval/wuxia-a-explore-0-2026-08-02T08-55-32-033Z-e11ce143` exhausted at 8 scenes, stayed at main stage 1, and persisted/adopted 3 expansions; no-thinking run `artifacts/story-eval/wuxia-a-explore-0-2026-08-02T08-59-43-458Z-622f2588` reached 12 scenes and stage 3. This overturned the earlier inference that the higher tension variance alone indicated a quality gain.
- Hardened the director prompt so main-quest progression wins over exploration, expansion is a rare fallback, and recent `blueprint_expanded` suppresses another expansion until progress resumes. Focused runtime tests passed (14 tests) and typecheck passed.
- Post-fix fixed-blueprint smoke `artifacts/story-eval/wuxia-a-explore-0-2026-08-02T09-09-54-283Z-179a66e5` had 3 scenes, no approved/persisted expansions, and no fallback. Post-fix 12-scene regression `artifacts/story-eval/wuxia-a-explore-0-2026-08-02T09-13-13-992Z-75fa3c74` reached 12 scenes, stage 8 by scene 7, `fallbackRate=0`, `tensionStddev=1.323`, and `approved/persisted/adopted=0/0/0` expansions. It is a promising repair signal, not a final thinking A/B verdict; keep `AI_THINKING_ROLES` default-off pending post-fix no-thinking control and multi-seed replication.
- Final offline gates after the prompt/replay changes passed: `npm test` (149 files, 1613 passed, 4 skipped), `npm run lint` (0 errors, 5 existing warnings), `npm run test:fast`, and `npm run build`.
- The post-fix no-thinking same-blueprint control completed at `artifacts/story-eval/wuxia-a-explore-0-2026-08-02T09-39-20-265Z-6c4c11f3`: 10 scenes, `exhausted`, stage sequence `1,1,1,1,3,3,3,3,3,3`, `fallbackRate=0`, `tensionStddev=0.500`, and zero actual expansion. Against the post-fix director-thinking run, the thinking arm reached 12 scenes/stage 8 with `tensionStddev=1.323`; both arms missed premise/identity facts and had no paired branch evidence. Current decision: prompt hardening is the clear repair, director thinking is a dev/staging candidate, but one fixed-blueprint replicate is insufficient to change the production default.
- Multi-seed fixed-blueprint replication completed with seeds `20260731/20260732/20260733` in each arm. Thinking artifacts: `artifacts/story-eval/wuxia-a-explore-0-2026-08-02T09-13-13-992Z-75fa3c74`, `artifacts/story-eval/wuxia-a-explore-0-2026-08-02T11-10-24-533Z-976b20c4`, `artifacts/story-eval/wuxia-a-explore-1-2026-08-02T11-17-08-849Z-56564748`; no-thinking artifacts: `artifacts/story-eval/wuxia-a-explore-0-2026-08-02T09-39-20-265Z-6c4c11f3`, `artifacts/story-eval/wuxia-a-explore-0-2026-08-02T11-24-05-187Z-8afe74c8`, `artifacts/story-eval/wuxia-a-explore-1-2026-08-02T11-29-52-840Z-ec2d61f0`.
- Replicate aggregate: thinking averaged 11.67 scenes, reached `stage 8` in all three runs, `tensionStddev=1.216`, fact recall `2/20`, NPC/location/item contributions `3/6/0`, and zero paired branches; no-thinking averaged 11 scenes, reached final stages `3/8/4`, `tensionStddev=0.773`, fact recall `1/17`, contributions `2/6/0`, and also zero paired branches. All six artifacts had `fallbackRate=0`, no run converged to an ending, and expansion approval/persistence/adoption remained `0/0/0` in both arms.
- Replication supports a director-stage progression signal, but not an overall story-quality win: the decisive deficits remain fact adoption, item function, choice consequence, and ending convergence. Keep production default thinking off; use director thinking only in dev/staging until those metrics are repaired and writer/NPC thinking is tested separately.
