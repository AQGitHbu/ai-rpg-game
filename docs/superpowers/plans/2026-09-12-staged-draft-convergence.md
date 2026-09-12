# Staged Draft Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 收敛为规划器一次产出完整初稿、三路只润色，在明确的真实样本范围内达到稳定发布。

**Architecture:** 在既有 Unit 上保存完整 `draft: UnitOutput`，复用现有解析、引用审批和发布格式。润色器只返回正文，程序回填初稿的不可变元数据；删除规划语义预审及维度纠错链，整包仅做初稿与成稿的保真/授权检查，不重新规划故事。玩家实际选中的 label 是后续问答依据。

**Tech Stack:** TypeScript、Vitest、现有 RPG StageSource、SQLite、真实 provider。

## Global Constraints

- 只在 `.worktrees/staged-narrative-generation` 工作，不修改、合并或推送 main，不启动其它 current-phase。
- 不修改 `.foundation`、foundation sibling 或 `docs/共同规范/`；不新增依赖或平行生产路径。
- 保留 lease/fence、CAS、取消、job deadline、请求发送前扣账及现有生成尝试上限。生产失败显式可重试；不使用默认故事、fixture 或未通过审批的初稿冒充成功。
- 内容只由 planning 决定；润色不能重新选择事实、人物、问答、条件、行动、候选或世界。已批准规划不因润色或保真审核拒绝被重新生成。
- 新生成不再使用 inquiries/answers 的 source、method 等抽象维度；旧字段仅用于解析历史，不再据此强制补问、判重复或重新裁决历史选择。
- 既有结构/知识/行动/披露门禁保留。程序引用校验不等于能证明任意自然语言安全；最终保真检查同时检查相对授权事实的新增主张，但不改变原问题、不推断新的剧情意图。
- subagent 实现，root 逐项审查；同一时间仅一个实现 agent。最终独立代码审查后真实调用，main 复用历史证据，不重跑。
- 原失败样本与新评估原文全部保留。稳定发布以冻结样本的完整分母报告；失败不重抽隐藏，不以高文案分抵消失败。

## Task 1: 开局玩家知识独立于 NPC，并前移静态权限校验

**Files:**
- Modify: `src/game/domain/openingGenerationCandidate.ts`
- Modify: `src/game/gameplay/rpg/openingGeneration/validateOpeningGenerationCandidate.ts`、`compileOpeningGenerationCandidate.ts` 及同目录测试
- Modify: `src/game/application/narrativeGeneration/approvePlanningContext.ts` 及同目录测试
- Modify: `docs/agent/NPC人格知识与关系图.md`

**Interfaces:** `OpeningGenerationCandidate.player.knownFactKeys?: readonly string[]`。显式字段决定玩家初始 discovered，不依赖 NPC 已知集合；缺省只保留旧存档/fixture 的原行为，不改变 NPC knowledge。新 live prompt 在 Task 2 要求提供该字段。

- [ ] **Step 1: 固化真实权限失败并先验证 RED。** 来源为 `tmp/staged-semantic-retest-20260912/publication-failure-review.json` 的武侠首次原稿。构造玩家亲历失镖、陌生掌柜不知道该事实的最小候选，玩家 knownFactKeys 包含该公开事实、NPC knownFactKeys 不含；旁白可用，NPC不可用，私密事实不可进入玩家集合。

```ts
expect(compiled.worldState.worldFacts.find(f => f.factId === playerFact)?.discovered).toBe(true);
expect(compiled.worldState.npcs[0].memory.knownFactIds).not.toContain(playerFact);
expect(approvePlanningContext(openingInput, invalidNpcPlan).ok).toBe(false);
```

- [ ] **Step 2: 最小实现。** parser 逐字段保留 knownFactKeys；validator 拒绝重复、未知和 NPC privateFactKeys 的交集；compiler 使用显式玩家集合，缺省使用旧集合。开局与 decision 共用对无观察依赖单元的静态权限预检；有条件观察的部分仍等待真实上游输出，不编造观察回执。

```ts
const playerKnown = candidate.player.knownFactKeys === undefined
  ? knownFactIds
  : candidate.player.knownFactKeys.map(key => factIdByKey.get(key)!);
// NPC knowledge construction remains based on npc.knownFactKeys/privateFactKeys.
```

- [ ] **Step 3: 回归、文档、提交。** 覆盖显式空玩家集合、旧候选缺省、私密引用失败、旁白/NPC分离、开局预检先于表达。运行 affected openingGeneration/approvePlanningContext 测试、typecheck、boundaries；文档原位解释知识集合各自归属。root review 后提交 `fix(narrative): separate opening player knowledge from npc knowledge`。

## Task 2: 完整初稿与纯文本润色，移除重复内容裁决

**Files:**
- Modify: `src/game/domain/narrativeUnit.ts`、`narrativePlan.ts`、`expressionTask.ts` 及测试
- Modify: `src/game/application/narrativeGeneration/stageSource.ts`、`perspectiveContext.ts`、`expressionTask.ts`、`dialogueContinuity.ts`、`dialogueHistory.ts`、`approvePlanningContext.ts`、`runJob.ts`、`jobBudget.ts`
- Modify: `src/game/application/server/ai/staged/{planningPrompt,narrationPrompt,characterPrompt,choicePrompt,liveStageSource}.ts`
- Replace active review responsibilities: `dialogueConsistencyReview.ts`、`runDialogueConsistencyReview.ts`、`dialogueConsistencyReviewPrompt.ts` with the small polish contract described below; remove production uses of `planningDialogueReview.ts`、`planningSemanticRepair.ts`、`dialogueReviewChecks.ts` and their protocol/content recovery routing. Legacy readers may remain isolated if storage requires them.
- Modify: `src/game/application/server/persistence/{narrativeJobRepository,sqliteNarrativeJobs}.ts`、对应存储/恢复/发布测试、既有 staged fixtures/harness
- Modify: `docs/agent/运行时AI导演与场景表演.md`、`AI环境.md`
- Create if useful: focused `draftPolish.ts` / `polishReview.ts` helpers under the existing narrativeGeneration/domain directories; no generic framework.

**Interfaces:**

```ts
// Optional only for reading historical data; every fresh live unit requires a draft.
type Unit = ExistingUnit & { readonly draft?: UnitOutput };
// Uses existing UnitOutput shape, including terminal trust/doubt labels.
type PolishPayload = { texts: readonly string[] }
  | { labels: readonly { candidateId: string; label: string }[] };
// Strictly reject count/id/length mismatch; reconstruct from immutable draft metadata.
function applyPolish(draft: UnitOutput, payload: unknown): Check<UnitOutput>;

type PolishReviewRequest = { items: readonly {
  id: string; stage: "narration" | "character" | "choices";
  draft: string; text: string;
  facts: readonly { id: string; text: string; certainty: "known" | "suspected" }[];
}[] };
type PolishReviewVerdict = {
  verdict: "pass" | "reject" | "uncertain";
  failedIds: readonly string[];
};
```

The implementation may retain the existing review role name/config and public helper names, but its live request/response must implement only this polish responsibility. Server generates item IDs and maps them to units/candidates; reviewer never chooses scope, fact aspect or a replan route. Facts contain only existing per-unit SafeContext data. Bounded scene/speaker and actual selected-label context may be included to check pronouns and continuity, not global hidden planning data.

- [ ] **Step 1: Complete draft and metadata regressions first.** Parse a real complete narration, NPC and both choice drafts; reject mismatched stage/speaker/candidate, missing fresh-live draft, extra polish keys, wrong count/order and overlong labels. Preserve same text if no stylistic change is needed; do not turn task instructions into a draft after generation.

```ts
const polished = applyPolish(draft, { texts: ["已经润色的原句。"] });
expect(polished.ok && polished.value.parts[0].facts).toEqual(draft.parts[0].facts);
expect(applyPolish(draft, { texts: [], facts: [] }).ok).toBe(false);
expect(parsePlanProposal(withWrongDraftStage).ok).toBe(false);
```

- [ ] **Step 2: Single content authority.** Planning prompt produces `unit.draft` as complete usable text with required metadata; character/choice text is first person, not “问/告诉/描述……”指令。Remove duplicate live brief and inquiries/answers generation requirements, while keeping needed intent/topic/fact/action structure. Ordinary and ending choice drafts both live in the choices unit. Add explicit player.knownFactKeys and preserve selected label in dialogue history; do not reconstruct the question from legacy dimensions. New planner sees actual selected words and same-NPC shown history, deciding the answer and two next choices in one call.

```ts
// A fixed selection remains the exact displayed utterance across persistence/history.
expect(history[0].selectedDialogue.label).toBe(selectedLabel);
expect(characterRequest.playerUtterance).toBe(selectedLabel);
// Real prompts use draft JSON, never append contradictory aspect instructions.
expect(polishPrompt).toContain(draft.parts[0].text);
expect(polishPrompt).not.toContain("必须针对事实");
```

- [ ] **Step 3: Pure polish adapter and retained permissions.** Reuse parseUnitOutput/approveUnit to check drafts against a context built without exposing raw draft. Only after successful reference/permission checks give that unit's draft to its polisher. Polisher returns texts in the same part order/count, or the same two candidate IDs and labels; program preserves facts, evidence, beats, speaker, emotion, actions and candidate identity. No resegmentation in this minimal version. Actual polished output still passes approveUnit, disclosure checks and final assembly; no assertion that structural checks alone prove free text safe. Prompt includes style policy/player personality for player options, NPC delivery for NPC text, with no hidden NPC notes.

- [ ] **Step 4: Delete the repeated judgment/replanning loop.** Remove planning preflight dialogue model calls and planningSemanticRepair from active execution. Remove aspect-based repeat/reply enforcement from the new path; keep exact shown-label repetition/identity checks that do not interpret natural language. After an approved plan exists, a polish/permission failure never rerolls opening, NPC or world; use existing explicit failure and retry entry. Initial unapproved structural proposals may still use existing bounded repair before a plan is accepted. Old unfinished caches without draft are invalidated with all dependent expressions, retaining usedRequests/attempts; never convert legacy brief into an approved draft. Published old saves remain readable.

- [ ] **Step 5: One simple final polish check with durable receipt.** Cover all narration/character/choice outputs; compare each to its original draft and authorized facts, allowing paraphrase but rejecting added/removed questions, changed unknown/refusal/condition, role changes, or unauthorized claims. No source/method classification and no assessment that a harmless alternate paraphrase should be a different story. Strict response has only verdict/failedIds; pass/uncertain require empty IDs, reject needs known IDs. Use one attempts counter with at most **2 review requests per cycle**: a first protocol error can retry review, or a first semantic reject can repolish only the failed unit and descendants then recheck; these share the same two-attempt limit. Provider failure/uncertain remain explicit failure. No separate protocol/content/unknown allowances, no replan. Digest binds draft, final output, cycle and relevant context; publication transaction rechecks the same receipt. Manual retry alone starts a new cycle; restart/input digest change never resets consumed attempts. Old review payloads are read-only compatibility, never current pass evidence.

```ts
expect(source.calls.filter(c => c.trigger === "dialogue_consistency_planning_review")).toHaveLength(0);
expect(planningCalls).toHaveLength(1); // initial approved draft unchanged after failed polish
expect(reviewRequests).toHaveLength(2); // protocol OR local polish retry, no renewed allowance
expect(publishWithChangedDraftOrText).toEqual({ ok: false, code: "JOB_CONFLICT" });
```

- [ ] **Step 6: Real failure regressions and compatibility.** Use previous science/wuxia/urban raw texts: identity/source/method wording no longer creates protocol addresses; NPC own question stays its draft; selected旧址原句得到对应自然回答，不再被翻成“消息来源”；unknown、refusal、条件、角色和新事实变更 are fidelity negatives. Include narration as well as NPC/choices, terminal drafts, missing/malformed draft, invalid references, disclosure rejection, cached-pass invalidation, SQLite positive publication control and zero partial writes. Update obsolete tests to the new behavior rather than retaining fake legacy production branches or broadly deleting safety tests. Keep fixtures explicitly offline.

- [ ] **Step 7: Review and full acceptance.** Run related domain/application/AI/SQLite tests with typecheck/boundaries; report removed production calls/state fields and net relevant LOC. Root spec/code review, then `npm run accept` and independent final review. Resolve findings, update current system facts in place, commit `refactor(narrative): generate full drafts and polish without replanning` (multiple focused commits within task are allowed).

## Task 3: 冻结真实发布与质量验证，按证据继续收敛

**Files:** ignored `tmp/staged-draft-convergence/` contains scenario regressions; each real round gets a separate `tmp/staged-draft-live-<round>/` preregistration, script, audit, snapshots and report. Reuse the existing production smoke composition, no separate fake runtime.

**Interfaces:** original main inputs and same-snapshot choice 0/1; actual new API contract replaces obsolete aspect controls. Historical main raw data and scores remain unchanged.

- [ ] **Step 1: Preregister before calls.** Same frozen code runs **two complete batches** of wuxia/science_fiction/urban openings and both first-turn branches (18 intended publications total). Add 12 frozen faithful/changed-meaning controls drawn from prior real samples, covering question, unknown, refusal, condition, speaker and fact changes. Per code round cap: publication **150 HTTP**, controls **12 HTTP**, total **60 minutes**; all sends and failures count. Keep five quality weights25/25/20/20/10 and compare only same-name published main samples. Old aspect controls are retired with explicit reason, not counted as newly passing.

```js
const frozen = { batches: 2, intendedPublications: 18,
  limits: { publication: 150, controls: 12, durationMs: 60 * 60_000 } };
// Freeze HEAD, production source hashes, complete inputs and expected control verdicts.
// Refuse to overwrite started rounds or silently resume a new sample as the same run.
```

- [ ] **Step 2: Run and inspect complete denominators.** Root runs authorized real API after offline acceptance. Stable in this matrix requires18/18 durable publications, zero false-negative fidelity controls and no confirmed wrong role, knowledge disclosure, question/answer/condition change. Independently score published draft→polish pairs and task continuity; no unapproved draft score or no-op fake success. All generation, re-polish, review, transport retry costs separately recorded. Report first-attempt publication and repaired publication separately.
- [ ] **Step 3: Continue only from observed failures.** A failed round remains complete evidence. Fix its concrete code/prompt cause with a regression, without adding scope/AI roles or changing pass criteria. Freeze a new round and rerun both batches; never combine best samples from different commits. External outage/usage errors are recorded separately, and repeating identical calls without evidence is not a fix. Once matrix passes, report stability only for this covered range; offline journey/build guard wider state consumption, not a claim of all possible live playthroughs.
- [ ] **Step 4: Document result and limits.** Save independent review, raw sample paths, final source hash verification and main paired comparison. Update this Plan with actual commits/checks and publish counts; no merge/push without user request.

## Evidence

Baseline `96bc0215`. Prior real sample root: `tmp/staged-semantic-retest-20260912/`; contract inventory: `tmp/staged-draft-convergence/contract-inventory.md`. Execution evidence is recorded per task in this Plan's SDD ledger; planned behavior is not yet implementation.
