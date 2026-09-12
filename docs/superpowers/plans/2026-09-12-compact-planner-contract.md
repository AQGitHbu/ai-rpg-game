# Compact Planner Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Remove a redundant model-authored beat summary and compare complete planner drafts with the current contract on fixed real inputs.

**Architecture:** Fresh wire beats contain beatId/kind/factIds/evidence only. The existing strict live adapter fills a neutral internal instruction; storage, authority, graph, facts, full drafts, polishers and recovery remain unchanged. A separate opt-in planner-only experiment compares frozen old/new requests without publishing games.

**Tech Stack:** TypeScript, Vitest, Node24 ESM tools, existing RPG AI client/audit.

## Global Constraints

- Work only in `.worktrees/staged-narrative-generation`; baseline9feed57e. No main edits/API/merge/push, no shared package or dependency changes.
- User newly authorizes this bounded contract simplification and planner comparison; previous full-matrix stop remains valid, no new four-stage run.
- One content source remains unit.draft. No extra generator, critic, retry, semantic ontology, permissions relaxation, or deterministic replacement story.
- Remove only fresh requiredBeats.instruction. Keep independently declared facts, observations, evidence, identities, conditions and actions. Never infer authorization from text or fill absent narrative.
- Existing historical parsePlanProposal/SafeBeat/storage stay readable. Current perspectiveContext already replaces model instruction with server-owned instructionByKind and approved fact text; this is the factual basis for removal.
- Run affected regressions, typecheck, boundaries, docs/diff checks and an independent scoped code review before live calls. No full release/stability claim from planner-only trials.

## Task 1: Strict compact wire and prompt

**Files:** modify `src/game/domain/liveDraftPlan.ts`, `src/game/domain/liveDraftPlan.test.ts`, `src/game/application/server/ai/staged/planningPrompt.ts`, relevant tests `planningPromptContract.test.ts`, `stagedPrompts.test.ts`, `liveStageSource.test.ts` as needed; update `docs/agent/运行时AI导演与场景表演.md` in place. Test helpers producing fresh provider payload may be updated locally; historical fixture contracts must not change.

**Interfaces:** `parseLiveDraftPlan(raw: unknown): Check<PlanProposal>` unchanged. Fresh requiredBeat has exactly four required keys; adaptation adds `instruction: "按声明的节拍与引用呈现。"`. Existing parsePlanProposal checks field types/enums/references; existing approval checks permissions and graph. No exported compatibility switch.

- [x] Add regressions: compact fresh beats succeed; supplied instruction/unknown key fails; missing facts/evidence or malformed beat fails; historical full PlanProposal with instruction remains readable; invalid references/authority still fail after adaptation.

```ts
const compactBeat = { beatId: "b", kind: "atmosphere", factIds: [], evidence: [] };
// With otherwise-valid complete fresh plan fixture:
expect(parseLiveDraftPlan(withBeat(compactBeat)).ok).toBe(true);
expect(parseLiveDraftPlan(withBeat({ ...compactBeat, instruction: "额外摘要" })).ok).toBe(false);
// Build withBeat within the test from makeDecisionPlan, stripping existing fresh-only duplicate fields.
```

- [x] Implement strict array/plain-record/exact-key checks before adaptation, preserving errors instead of silently dropping keys.

```ts
if (!Array.isArray(unit.requiredBeats)) return fail("plan_unit_invalid");
const requiredBeats = [];
for (const beat of unit.requiredBeats) {
  if (!isPlainRecord(beat) || !hasOnlyKeys(beat, ["beatId", "kind", "factIds", "evidence"]))
    return fail("plan_unit_invalid");
  requiredBeats.push({ ...beat, instruction: "按声明的节拍与引用呈现。" });
}
// Include requiredBeats in the existing units.push, then existing parsePlanProposal.
```

- [x] Change prompt requiredBeats schema from5keys to4; delete output instruction guidance. Preserve INPUT mandatory beat descriptions and actual fact text. Compact redundant schema explanations, old route target examples forbidden to fresh ordinary options, repeated final constraints and implementation-history commentary. Keep every binding/enum/limit/permission requirement; fixed target/deferredLocation remain null fields. Do not rewrite all creative rules or add failure-specific exceptions.
- [x] Run focused tests with direct exit/result verification; update relevant fresh-wire helper assertions only. Then typecheck, boundaries and docs/diff checks. Record actual old/new request character lengths; no forced shrink percentage or semantic improvement claim from shorter text.
- [x] Root spec/code review and independent scoped review; fix concrete findings and commit specified files. Do not modify experiment frozen inputs.

## Task 2: Frozen planner-only comparison

**Files:** ignored `tmp/compact-planner-20260912/` capture/run/summary scripts, frozen baseline adapter, contexts/messages, registration, audits/results and report. Root controls registration/review; a subagent implements scripts. No new production experiment flag or client role.

**Interfaces:** capture planning messages through `createLiveStageSource` using a fake client.complete that records messages and aborts before network; use existing `PlanningContext` job.input. Baseline capture happens before Task1 edits, compare captured messages against actual r5 planning audit. After Task1, capture compact messages from identical contexts. Evaluate each response through its arm's strict live adapter and the same unchanged `approvePlanningContext`. Old parser imports the same unchanged domain dependencies via local tool resolve hooks. Use existing real client.complete("planning", frozenMessages, audit, execution), not runJob/composition or expression/reviewer methods.

**Fixed cases:** r5 `b1-wuxia-opening` (unsupported assertion), `b2-science_fiction-opening` (disclosure completeness), `b2-wuxia-branch0` (invented cargo), `b1-urban-branch1` (unknown answer/style). Take job.input of the corresponding initialization/decision, no old model answer injected as example or correction. These are targeted diagnostic cases, not representative population estimates. First-turn decisions have no additional prior published decision history; exact previous presented scene and selected words stay in input.

- [x] Before code edits, capture baseline contexts/messages and original adapter/source hashes. Assert captures exactly match relevant r5 audit messages; if mismatch, resolve actual context/history rather than silently changing baseline. Keep full original provenance/digests and credentials out of artifacts.
- [x] Predeclare current configured ai-slg-game-model, same thinking/on and output format/policy for both arms, 4cases × 2arms × 2repetitions =16 logical planning calls. Counterbalance arms A/B on repeat1, B/A on repeat2 for each case. No content repair or selective resample. Existing transport max2 means hardcap32HTTP, wallclock30minutes; before-send accounting, timeouts and failures retained. Sequential execution is acceptable; do not add concurrency machinery. If user supplies a candidate before final registration, revise explicit matrix/budget before any live call; otherwise same-model comparison only.
- [x] Freeze source hashes, both message sets, old adapter, runner, model/policies, order and criteria before network; refuse overwrite/resume of started experiment. Opt-in `RUN_REAL_AI_PLANNER_COMPARE=1`; use existing env helper, no key output. Hard-stop cap/deadline, complete diagnostics/exit, raw audit and per-response save. Local startup/import failure is0HTTP; preserve and correct without pretending it was a model trial.
- [x] Offline script checks must verify no-network capture, budget/order and parser identity without any game DB or live API. Run real planner only after Task1 checks/review. All16 outcomes remain denominators, including transport/schema/approval failures.
- [x] Independent subagent evaluates coded samples with arm labels withheld where practical, then root reviews: required facts actually expressed with correct scope/certainty; no unsupported actionable facts/established actions; correct speaker/knowledge; actual question answered or explicitly unknown; two meaningful choices and genre/style. No automatic judge API. Mark structural invalidity separately; readable invalid drafts may receive diagnostic semantic comments but cannot count joint success.
- [x] Report per-arm structural approval, semantic clean and joint clean counts out of8, paired case/repeat changes, original5quality dimensions0–4 and four repair dimensions1–5 where assessable, all failures, request/output size, tokens/latency/transport retries. Prespecified primary improvement evidence: compact joint-clean count greater than baseline and structural-approved count not lower; ties/mixed outcomes are inconclusive. No significance claim from8/arm; no inference about alternative-model ability or main replacement.
- [x] Finalize hashes/accounting and report without further prompt edits or new rounds; record Task1 implementation independently from measured effectiveness, update this Plan, no merge/push.

## Acceptance Evidence

Task1 commit `c01c564d`: strict four-field fresh beat adapter, compact prompt, historical parsing and authority preserved. Added meaningful application authority regression in `approvePlanningContext.test.ts` alongside scoped domain/source/prompt tests. Root review findings resolved; independent production review passed. Focused91/91, boundaries127/127, typecheck/docs/diff checks passed; docs retains one existing soft length reminder. No full release suite or build claimed.

Task2 completed all16 registered logical calls with16 HTTP/16 matching audit entries, all200, no retries or missing usage, exit0; wallclock14m18.704s. Inputs, provider request digests, actual policy and all registered source/tool/runtime hashes independently verified. A local pre-send import error was fixed before any HTTP; both original and corrected registrations and zero-HTTP diagnostic are retained. No real samples were discarded, corrected or resampled. Final independent holistic review verified report facts, aggregation and preregistered criterion compliance with no actionable findings.

Independent coded review scored all16 readable drafts; root reviewed all outputs and accepted the judgments. All incremental scoring samples equal their corresponding final corpus entries. Old/compact structural approvals7/8 vs7/8; semantic clean7/8 vs4/8; joint clean6/8 vs4/8; weighted quality83.59 vs81.88. Thus the prespecified positive-evidence criterion was not met. These8/arm diagnostic samples do not establish statistically reliable improvement/regression, release stability or alternate-model superiority.

Message content characters fell113718→110238 (3.06%); reported total tokens144269→131695. Mean logical elapsed54.39→52.94seconds. Token/latency differences include stochastic output/thinking variation, so they are not solely attributed to the compact contract. Engineering simplification is complete; quality improvement is unproven. No main call, polish/reviewer API, full-stage matrix, merge or push.

Detailed evidence and every failure: [comparison report](../../../tmp/compact-planner-20260912/对照报告.md), [predeclared criteria](../../../tmp/compact-planner-20260912/评估预案.md), [all scored samples](../../../tmp/compact-planner-20260912/results/scored-comparison.json), [final accounting](../../../tmp/compact-planner-20260912/results/finished.json). Local experiment artifacts stay in the preserved worktree; no additional prompt iteration or API round is part of this Plan.
