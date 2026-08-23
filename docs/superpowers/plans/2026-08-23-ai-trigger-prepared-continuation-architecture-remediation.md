# AI Trigger Boundary and Prepared Continuation Architecture Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make new-game creation and formal NPC fixed/free-text responses the only production AI-generation triggers, while every handoff, navigation, investigation, item, and battle transition consumes already approved content or deterministic rule presentation without another provider call.

**Architecture:** Replace the narration-only `linearNarrativeQueue` with a server-only `PreparedContinuationState` that stores complete, approved scene seeds through the next formal NPC decision boundary. Add an explicit execution policy before state commit, make linear actions consume prepared content in the same CAS as their rule result, separate local dialogue acknowledgement/navigation from gameplay actions, and centralize structured-output/content-repair ownership. Keep `@ai-game/ai-transport` unchanged: transport remains responsible only for HTTP/timeout/cancellation/error contracts; RPG prompts, schema, retry policy, and continuation semantics remain in this repository.

**Tech Stack:** TypeScript 5.8, Next.js 16, React 19, Vitest 3, SQLite/libSQL, existing `@ai-game/ai-transport`, RPG application/gameplay/domain facades. This remediation introduces the first `src/game/core/` modules (`json` fence normalizer and generic bounded-attempt controller) — they are pure, RPG-vocabulary-free, have their own facades/tests/boundary guards per `docs/游戏开发规范.md §1.1`.

**Spec:** `docs/游戏设计原则.md` (“无需玩家决策时立即后台生成”), `docs/策划文档/AI生成RPG_MVP.md`, `docs/agent/NPC对话驱动叙事场景触发.md`, `docs/agent/地图与地点冒险.md`, `docs/agent/运行时AI导演与场景表演.md`; the target state machine and invariants below are normative for this remediation.

## Global Constraints

- Production provider calls are allowed only for `opening` and a formal NPC branch (`npc_fixed_choice` or `npc_free_text`). Explicit retry may rerun the same persisted provider job, but must not create a new gameplay turn.
- A fixed-choice token may still use `POST /api/game/actions` for a deterministic rule action, but that request must not invoke scene/world/intent providers unless the submitted interaction is a formal NPC branch.
- The final single button under the old NPC is a local acknowledgement. It closes the dialogue only; it has no `choiceToken`, creates no action ID, changes no revision/turn/location, and shows no “waiting for NPC” state.
- A formal NPC response generates and approves all deterministic continuation presentations through the next formal NPC two-choice/free-text boundary, including travel narration, investigation variants, arrival NPC opening lines, arrival NPC choice labels/actions, and battle-resolution presentation. Any world evolution required by those paths is materialized inside that same allowed provider job and hidden/released by structured reveal state; no AI world proposal is deferred into a later linear action.
- Prepared continuation is a server-authored acyclic graph, not a flat queue: investigation approaches and battle outcomes are sibling alternatives in one consumption group; consuming a node activates only its server-declared successors and prunes the unchosen branch.
- Linear action consumption is atomic: rule effects, prepared-scene materialization, choice-token minting, continuation consumption, and revision increment occur in one repository CAS.
- Missing or stale prepared content never falls back to a provider call. It returns a stable `NARRATIVE_CONTINUATION_MISSING` or `NARRATIVE_CONTINUATION_INVALID` result with zero state write.
- Backtracking to an already visited non-objective location is deterministic navigation: it uses the location description/rule state, never creates a pending narrative job, and never calls a provider.
- Active battle rounds remain rule-only. Battle start and victory/ending handoff consume prepared content; remove production battle scene prewarm/provider calls.
- Transport retry remains solely in `RpgAiClient`; structured content repair is owned once by the role use case; manual failed-job retry is owned solely by the existing ensure endpoint.
- A scene proposal and all continuation steps from one content attempt are approved and accepted atomically. Do not mix a scene from a repair response with continuation fields salvaged from a rejected response.
- Old StoryState v5 saves are unsupported after this architecture change. Bump to v6, classify v5 as `UNSUPPORTED_RECORD`, and require clearing the development save; do not silently default a missing continuation.
- Keep the six existing `/api/game/**` routes. Do not add compatibility routes, versioned facades, redirect endpoints, or a second action pipeline.
- Do not modify `../ai-game-foundation`, `.foundation`, or any `@ai-game/*` package. Shared transport non-goals explicitly include RPG retry policy, prompt, schema, and fallback behavior.
- Implementation must occur in a `.worktrees/<name>` worktree created at execution time. Do not use `git checkout`; do not disturb the current dirty main worktree.
- Every task uses TDD, updates direct tests, and ends in a focused commit. Do not postpone broken journey tests to the final task.
- Keep this as one atomic remediation Plan: trigger authorization, prepared-state persistence, one-CAS consumption, UI handoff semantics, and retry ownership share the same state invariant. Landing only one of them would either re-open a hidden provider path or make fresh v6 saves unplayable.
- `src/game/core/` is created only because this Plan introduces two genuinely reusable, RPG-vocabulary-free mechanisms (JSON fence normalization and attempt-budget control). Core modules must have an independent public facade (`src/game/core/<system>/index.ts`), co-located tests, and a dedicated boundary guard added in `src/dependencyBoundaries.test.ts`; they must not import `domain`/`gameplay`/`application`/`components`/`store`/`app` and must not contain location/NPC/quest/battle/narrative business fields or prompts (see `docs/游戏开发规范.md §1.1`).
- These core helpers remain RPG-repository-local first-consumer implementations. Do not add a foundation package or cross-repository change unless a second production consumer later proves the same contract, per `docs/共同规范/共享模块开发流程.md`.

---

## Target State Machine

The persistent narrative runtime is one discriminated union, not a `generation` flag plus several independently optional fields:

```ts
export type NarrativeRuntimeState =
  | {
      readonly status: "ready";
      readonly mode: NarrativeMode;
      readonly currentScene: NarrativeSceneState;
      readonly choiceRegistry: readonly ApprovedChoice[];
      readonly preparedContinuation?: PreparedContinuationState;
      readonly dialogueSession?: DialogueSessionState;
    }
  | {
      readonly status: "provider_pending";
      readonly mode: NarrativeMode;
      readonly job: PendingNarrativeJob;
      readonly lastPresentedScene: NarrativeSceneState | null;
      readonly dialogueSession?: DialogueSessionState;
    }
  | {
      readonly status: "provider_failed";
      readonly mode: NarrativeMode;
      readonly job: PendingNarrativeJob;
      readonly failure: NarrativeGenerationFailure;
      readonly lastPresentedScene: NarrativeSceneState | null;
      readonly dialogueSession?: DialogueSessionState;
    };
```

| From | Event | To | Write/provider rule |
| --- | --- | --- | --- |
| no save | create game | `provider_pending(opening)` | one initial CAS, opening job is provider-authorized |
| `ready` | formal NPC fixed/free-text input | `provider_pending(npc_*)` | consume choice + rule result + job in one CAS |
| `provider_pending` | atomic proposal accepted | `ready` | one scene write-back CAS; scene and all prepared steps share one accepted attempt |
| `provider_pending` | terminal attempt failure | `provider_failed` | same job ID; stable failure only |
| `provider_failed` | explicit retry | `provider_pending` | same job/action/turn/generation/scene-request identity |
| `ready` | local acknowledgement/navigation | `ready` unchanged | zero domain writes, zero provider calls |
| `ready` | prepared action | `ready` | rule + prepared scene + token mint + consume in one CAS |
| `ready` | rule-owned action | `ready` | one deterministic CAS, zero provider calls |

UI navigation is a separate client-only state machine: `dialogue_open → location_view → town_view → map_view`. Only selecting a different map location submits a deterministic `move`; closing a dialogue must never synthesize that transition.

| Input/event | State transition | Provider permission | Required presentation source |
| --- | --- | --- | --- |
| Create new game | create opening world + `PendingNarrativeJob(kind="opening")` | opening/world/scene allowed | generated opening + prepared first decision |
| Formal NPC fixed choice | rule result + `PendingNarrativeJob(kind="npc_fixed_choice")` | world/scene allowed | generated NPC response + prepared continuation |
| Formal NPC free text | intent parse + rule result + `PendingNarrativeJob(kind="npc_free_text")` | intent/world/scene allowed | generated NPC response + prepared continuation |
| Failed provider job retry | `provider_failed → provider_pending` for the same job ID | same job allowed | new atomic proposal; no repeated rule turn |
| NPC final acknowledgement | local modal close | forbidden | already generated label only |
| Return to map / enter current town / enter building / open NPC card | UI navigation only | forbidden | existing read model |
| Objective move | rule result + prepared-step consumption in one CAS | forbidden | generated prepared scene |
| Objective investigation (each approach) | rule result + matching prepared-step consumption in one CAS | forbidden | generated prepared approach scene |
| Take/give item without a prepared story boundary | rule result in one CAS | forbidden | rule-owned presentation |
| Backtrack to visited location | rule navigation in one CAS | forbidden | rule-owned location presentation |
| Active battle round | rule result in one CAS | forbidden | battle read model |
| Battle start/resolution/ending handoff | rule result + prepared-step consumption in one CAS | forbidden | generated prepared battle/ending scene |

### State invariants

```ts
export const PROVIDER_GENERATION_KINDS = [
  "opening",
  "npc_fixed_choice",
  "npc_free_text",
] as const;

// This is an executable invariant, not documentation-only guidance.
export function providerAllowedFor(kind: unknown): kind is ProviderGenerationKind {
  return PROVIDER_GENERATION_KINDS.includes(kind as ProviderGenerationKind);
}
```

1. `provider_pending|provider_failed` contains exactly one `PendingNarrativeJob` whose `generationKind` is in `PROVIDER_GENERATION_KINDS`; neither state can carry live choices or a prepared queue.
2. `move`, `investigate`, `take_item`, `give_item`, `attack`, and `battle_action` leave the narrative runtime in `ready` and never create a provider state.
3. A prepared step contains no minted `choiceToken`; tokens are minted only when the step becomes the current scene, using the post-commit revision.
4. The next formal NPC scene is ready before the player opens that NPC; clicking an NPC/building never submits an artificial `ask` turn.
5. `POST /api/game/narrative/ensure` may schedule only a persisted provider-allowed job. Ordinary polling never changes `provider_failed` to `provider_pending`.
6. Only `activeStepIds` may match the next action. Every step ID and successor ID is unique and server-authored; the graph is acyclic, every successor exists, and every terminal path ends at the next formal NPC decision boundary.

## Target File Structure

### New files

- `src/game/domain/preparedContinuation.ts` — persistent server-side continuation/scene-seed graph; no provider/application imports and no persisted AI world proposal.
- `src/game/core/json/structuredJsonResponse.ts` — pure JSON/fenced-JSON normalization (no RPG vocabulary, no domain/gameplay/application imports); public facade `src/game/core/json/index.ts`.
- `src/game/core/retry/boundedAttempts.ts` — generic attempt-budget controller (caller supplies `maxAttempts` and typed prior failure) with no prompt/provider/RPG state; public facade `src/game/core/retry/index.ts`.
- `src/game/gameplay/rpg/narrativeExecution/index.ts` — gameplay facade for the provider/prepared/rule-only whitelist (exports `providerAllowedFor`, `decideNarrativeExecution`); internal implementation `narrativeExecutionPolicy.ts`.
- `src/game/gameplay/rpg/preparedContinuation/candidates.ts` — gameplay-pure future-candidate projection (public via `src/game/gameplay/rpg/preparedContinuation/index.ts`); builds the authoritative, branch-aware continuation graph from `WorldState`, `StoryState`, and `ObjectiveTransition` without importing application `GameRecord`.
- `src/game/application/approvePreparedContinuation.ts` — application orchestration that validates AI-prepared steps via the gameplay candidate projection and rebuilds persistent domain state (consumes Task 2 types + gameplay candidates; does not import provider).
- `src/game/application/consumePreparedContinuation.ts` — matches a resolved action in the active prepared graph, mints scene tokens, and returns the next states for one CAS (imports domain + gameplay facades, not AI transport).
- `src/game/application/ruleOwnedScene.ts` — deterministic location/item/navigation presentation (`source="rule"`); contains no generated dialogue.
- `src/game/application/server/providerTriggerBoundary.test.ts` — static architecture guard for orchestrator-level provider entry points.
- `src/game/application/testing/providerTriggerMatrix.test.ts` — authoritative provider-call count journey.

### Files to split or substantially modify

- `src/game/domain/pendingNarrativeJob.ts` — add explicit `generationKind` and immutable `sceneRequestKind`.
- `src/game/domain/narrative.ts` — replace nested generation flags with the discriminated runtime state, add `handoffAcknowledgement`, add `source="rule"`, replace `linearNarrativeQueue`, remove unused legacy follow-up/trigger/chat types.
- `src/game/domain/storyState.ts` — schema v6; update `classifyStoryStateSchemaVersion` and repository `interpretGameRow` to return `UNSUPPORTED_RECORD` for v5.
- `src/game/application/sceneGenerationContext.ts` — project explicit generation kind and future prepared-step descriptors (consuming gameplay candidates via facade); stop inferring handoff from mutable global state.
- `src/game/application/sceneSource.ts` — one atomic proposal contract with `handoffAcknowledgement` and `preparedContinuations`; delete `LinearActionNarrative`/`LinearActionNpcLine`/`contentRepairAttempt`.
- `src/game/application/deterministicSceneSource.ts` — adapt fixture source to emit the new `preparedContinuations` contract (fixture-only, not production); remove `linearActionNarratives` emission.
- `src/game/application/server/ai/narrativeContext/sceneNarrativeContext.ts` — render the new single output contract.
- `src/game/application/server/ai/liveScenePerformanceSource.ts` — one provider attempt + parse only; no recursive content repair; import core JSON helper via `src/game/core/json`.
- `src/game/application/approveAndWriteScene.ts` — approve only current scene; delegate continuation approval.
- `src/game/application/generatePendingScene.ts` — provider-job orchestration only; delete immediate-action/queue/battle branches.
- `src/game/application/performTurn.ts` — dispatch provider, prepared, or rule-owned path before commit (imports gameplay `narrativeExecution` through its facade and same-layer `consumePreparedContinuation` directly; imports no scene/world AI source).
- `src/game/application/server/compositionRoot.ts` — remove synchronous immediate generation and battle prewarm; enforce provider whitelist via gameplay facade; delete prewarm audit path `prewarmed`.
- `src/game/application/gameSessionView.ts` — project local handoff acknowledgement separately from executable choices; delete token-backed `handoffChoice` projection.
- `src/components/LocationSceneScreen.tsx` — local close for handoff; formal choices alone enter waiting state.
- `src/components/AdventureGameShell.tsx` / `WorldMapScreen.tsx` — retain local navigation; map travel stays deterministic and never opens an AI-generation modal.
- `src/components/CurrentGameScreen.tsx` / `gameActionRequest.ts` — one recovery ensure, GET-only observation polling, explicit manual retry; expose opaque `jobKey` derived from `job.jobId`.
- `src/dependencyBoundaries.test.ts` — add dedicated core dependency/facade guards while preserving the existing rule that `@ai-game/ai-transport` is allowed only under `application/server/ai`; pin the new gameplay facades (`narrativeExecution`, `preparedContinuation`).
- Delete `src/game/application/server/battleScenePrewarm.ts` and its tests after prepared battle coverage exists.

---

### Task 1: Lock the Provider Trigger Whitelist

**Files:**
- Create: `src/game/gameplay/rpg/narrativeExecution/narrativeExecutionPolicy.ts`
- Create: `src/game/gameplay/rpg/narrativeExecution/index.ts` — gameplay facade (re-exports only `providerAllowedFor`, `decideNarrativeExecution` and types; no deep-import allowed)
- Create: `src/game/gameplay/rpg/narrativeExecution/narrativeExecutionPolicy.test.ts`
- Modify: `src/game/domain/pendingNarrativeJob.ts`
- Modify: `src/game/domain/pendingNarrativeJob.test.ts`
- Modify: `src/dependencyBoundaries.test.ts` — pin new facade, forbid deep-import `narrativeExecution/*`, add `narrativeExecution` to `FACADES` list

**Interfaces:**
- Produces (domain `pendingNarrativeJob.ts`): `PROVIDER_GENERATION_KINDS`, `ProviderGenerationKind`, `NarrativeSceneRequestKind`, `parsePendingNarrativeJob(value)`. Produces (gameplay facade `src/game/gameplay/rpg/narrativeExecution`): `NarrativeExecutionKind`, `NarrativeExecutionDecision`, `decideNarrativeExecution(input)`, `providerAllowedFor(kind)`, `intentProviderAllowedFor(input)`, and type-only re-exports of the two domain kinds.
- Consumes: domain `Action`/`Interaction`/`NpcId` and server-computed scalar facts (`advancesObjective`, prepared-match presence, battle/dialogue completion). Must not import `application`, `components`, `store`, `app`, `server-only`, or `@ai-game/*`.

- [ ] **Step 1: Write the failing trigger-matrix unit test**

```ts
import { describe, expect, it } from "vitest";
import {
  decideNarrativeExecution,
  intentProviderAllowedFor,
  providerAllowedFor,
  type NarrativeExecutionInput,
} from "@/game/gameplay/rpg/narrativeExecution";

describe("narrative execution provider whitelist", () => {
  it.each([
    ["opening", true],
    ["npc_fixed_choice", true],
    ["npc_free_text", true],
    ["prepared_action", false],
    ["rule_only", false],
  ] as const)("%s providerAllowed=%s", (kind, allowed) => {
    expect(providerAllowedFor(kind)).toBe(allowed);
  });

  it("classifies formal NPC choices as provider work", () => {
    expect(decideNarrativeExecution({
      action: { type: "talk", npcId: "npc_1" as never, dialogueAct: "support" },
      interactionKind: "fixed_choice",
      advancesObjective: true,
      hasPreparedStep: false,
      battleWillResolve: false,
      dialogueWillComplete: false,
    })).toEqual({
      kind: "provider",
      generationKind: "npc_fixed_choice",
      sceneRequestKind: "npc_response",
    });
  });

  const nonDialogueInputs: readonly NarrativeExecutionInput[] = [
    { action: { type: "move", locationId: "loc_2" as never }, interactionKind: null, advancesObjective: true, hasPreparedStep: true, battleWillResolve: false, dialogueWillComplete: false },
    { action: { type: "investigate", factId: "fact_2" as never }, interactionKind: null, advancesObjective: true, hasPreparedStep: true, battleWillResolve: false, dialogueWillComplete: false },
    { action: { type: "take_item", itemId: "item_1" as never }, interactionKind: null, advancesObjective: false, hasPreparedStep: false, battleWillResolve: false, dialogueWillComplete: false },
    { action: { type: "give_item", itemId: "item_1" as never, npcId: "npc_1" as never }, interactionKind: null, advancesObjective: false, hasPreparedStep: false, battleWillResolve: false, dialogueWillComplete: false },
    { action: { type: "attack", enemyId: "enemy_1" as never }, interactionKind: null, advancesObjective: true, hasPreparedStep: true, battleWillResolve: false, dialogueWillComplete: false },
    { action: { type: "battle_action", action: "attack" }, interactionKind: null, advancesObjective: true, hasPreparedStep: true, battleWillResolve: true, dialogueWillComplete: false },
  ];

  it.each(nonDialogueInputs)("$action.type never receives provider permission", (input) => {
    expect(decideNarrativeExecution(input).kind).not.toBe("provider");
  });

  it("does not authorize an internally synthesized talk without a formal interaction", () => {
    expect(decideNarrativeExecution({
      action: { type: "talk", npcId: "npc_1" as never, dialogueAct: "ask" },
      interactionKind: null,
      advancesObjective: false,
      hasPreparedStep: false,
      battleWillResolve: false,
      dialogueWillComplete: false,
    })).toEqual({ kind: "rule_only" });
  });

  it("routes an objective action with missing prepared content to the prepared error path", () => {
    expect(decideNarrativeExecution({
      action: { type: "move", locationId: "loc_2" as never },
      interactionKind: null,
      advancesObjective: true,
      hasPreparedStep: false,
      battleWillResolve: false,
      dialogueWillComplete: false,
    })).toEqual({ kind: "prepared" });
  });

  it("allows intent AI only for free text bound to the authoritative focused NPC", () => {
    const npcId = "npc_1" as never;
    expect(intentProviderAllowedFor({
      interaction: { kind: "free_text", text: "昨夜发生了什么？", targetNpcId: npcId },
      focusedNpcId: npcId,
    })).toBe(true);
    expect(intentProviderAllowedFor({
      interaction: { kind: "free_text", text: "昨夜发生了什么？", targetNpcId: "npc_2" as never },
      focusedNpcId: npcId,
    })).toBe(false);
  });
});
```

- [ ] **Step 2: Run the policy test and verify it fails**

Run: `npx vitest run src/game/gameplay/rpg/narrativeExecution/narrativeExecutionPolicy.test.ts`

Expected: FAIL because `narrativeExecutionPolicy.ts` and the exported types do not exist.

- [ ] **Step 2b: Update dependency boundaries and verify they fail without the facade**

Run: `npm run test:boundaries`

Expected: FAIL until `src/dependencyBoundaries.test.ts` is updated to list `narrativeExecution` in `FACADES` and forbid deep-import `narrativeExecution/narrativeExecutionPolicy` from `application/components/store/app`.

- [ ] **Step 3: Implement the explicit decision type and whitelist**

```ts
import type { Action, Interaction } from "@/game/domain/action";
import type { NpcId } from "@/game/domain/worldEntity";
import {
  PROVIDER_GENERATION_KINDS,
  type ProviderGenerationKind,
  type NarrativeSceneRequestKind,
} from "@/game/domain/pendingNarrativeJob";

export type NarrativeExecutionKind = ProviderGenerationKind | "prepared_action" | "rule_only";

export type NarrativeExecutionInput = {
  readonly action: Action;
  readonly interactionKind: "fixed_choice" | "free_text" | null;
  readonly advancesObjective: boolean;
  readonly hasPreparedStep: boolean;
  readonly battleWillResolve: boolean;
  readonly dialogueWillComplete: boolean;
};

export type NarrativeExecutionDecision =
  | {
      readonly kind: "provider";
      readonly generationKind: ProviderGenerationKind;
      readonly sceneRequestKind: Exclude<NarrativeSceneRequestKind, "opening">;
    }
  | { readonly kind: "prepared" }
  | { readonly kind: "rule_only" };

export function providerAllowedFor(kind: unknown): kind is ProviderGenerationKind {
  return PROVIDER_GENERATION_KINDS.some((allowed) => allowed === kind);
}

export function intentProviderAllowedFor(input: {
  readonly interaction: Interaction;
  readonly focusedNpcId: NpcId | null;
}): boolean {
  return input.interaction.kind === "free_text"
    && input.focusedNpcId !== null
    && input.interaction.targetNpcId === input.focusedNpcId;
}

export function decideNarrativeExecution(input: NarrativeExecutionInput): NarrativeExecutionDecision {
  if (input.action.type === "talk" && input.interactionKind !== null) {
    return {
      kind: "provider",
      generationKind: input.interactionKind === "free_text" ? "npc_free_text" : "npc_fixed_choice",
      sceneRequestKind: input.dialogueWillComplete ? "npc_handoff" : "npc_response",
    };
  }
  if (input.advancesObjective || input.hasPreparedStep || input.battleWillResolve) return { kind: "prepared" };
  return { kind: "rule_only" };
}
```

- [ ] **Step 4: Add `generationKind` to pending jobs and reject non-whitelisted construction**

Update `createPendingNarrativeJob` so its input requires both trigger authorization and immutable output mode:

```ts
export const PROVIDER_GENERATION_KINDS = ["opening", "npc_fixed_choice", "npc_free_text"] as const;
export type ProviderGenerationKind = (typeof PROVIDER_GENERATION_KINDS)[number];
export type NarrativeSceneRequestKind = "opening" | "npc_response" | "npc_handoff";

readonly generationKind: ProviderGenerationKind;
readonly sceneRequestKind: NarrativeSceneRequestKind;
```

Persist both on `PendingNarrativeJob`; add `parsePendingNarrativeJob(value: unknown)` that rebuilds a valid job through the existing factory. The factory/parser accepts only `opening+opening` or `npc_fixed_choice|npc_free_text + npc_response|npc_handoff`; reject cross-paired values. Add tests proving `{ generationKind: "prepared_action" }` cannot be constructed through the typed factory, runtime parsing rejects unknown/cross-paired strings, and retry preserves both values. A formal NPC rule transition fixes `npc_response` or `npc_handoff` before the job is committed.

- [ ] **Step 5: Run focused domain/gameplay/boundary tests**

Run: `npm run test:boundaries && npx vitest run src/game/gameplay/rpg/narrativeExecution/narrativeExecutionPolicy.test.ts src/game/domain/pendingNarrativeJob.test.ts`

Expected: PASS (boundaries pin `narrativeExecution` deep-import).

- [ ] **Step 6: Commit**

```bash
git add src/game/gameplay/rpg/narrativeExecution src/game/domain/pendingNarrativeJob.ts src/game/domain/pendingNarrativeJob.test.ts src/dependencyBoundaries.test.ts
git commit -m "refactor(narrative): define provider trigger whitelist"
```

---

### Task 2: Introduce StoryState v6 Prepared Continuations

**Files:**
- Create: `src/game/domain/preparedContinuation.ts`
- Create: `src/game/domain/preparedContinuation.test.ts`
- Modify: `src/game/domain/narrative.ts`
- Modify: `src/game/domain/narrativeGenerationFailure.ts` — update the persisted-failure comment/type references to `provider_failed`
- Modify: `src/game/domain/storyState.ts`
- Modify: `src/game/domain/storyState.test.ts`
- Modify: `src/game/gameplay/rpg/openingGeneration/compileOpeningGenerationCandidate.ts`
- Modify: `src/game/gameplay/rpg/openingGeneration/compileOpeningGenerationCandidate.test.ts`
- Modify: `src/game/application/createGame.ts`
- Modify: `src/game/application/createGame.test.ts`
- Modify: `src/game/application/focusNpcContext.ts`, `src/game/application/gameSessionView.ts`, `src/game/application/generatePendingScene.ts`, `src/game/application/markNarrativeGenerationFailed.ts`, `src/game/application/performTurn.ts`, `src/game/application/retryNarrativeGeneration.ts`, `src/game/application/sceneGenerationContext.ts`, `src/game/application/stateCommit.ts`
- Modify source semantics atomically: `src/game/application/sceneSource.ts`, `src/game/application/deterministicSceneSource.ts`, `src/game/application/deterministicSceneSource.test.ts`, `src/game/application/narrativeText.ts`, `src/game/application/narrativeText.test.ts`, `src/game/application/server/ai/textAuditTypes.ts`
- Modify: `src/game/application/server/compositionRoot.ts`, `src/game/application/server/battleScenePrewarm.ts`, `src/game/application/server/persistence/gameRepository.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/advanceStoryProgression.ts`, `src/game/gameplay/rpg/ruleEngine/resolveEnding.ts`
- Modify fixtures/tests: `src/game/application/focusNpcContext.test.ts`, `src/game/application/gameSessionView.test.ts`, `src/game/application/generatePendingScene.test.ts`, `src/game/application/markNarrativeGenerationFailed.test.ts`, `src/game/application/performTurn.test.ts`, `src/game/application/retryNarrativeGeneration.test.ts`, `src/game/application/sceneGenerationContext.test.ts`, `src/game/application/stateCommit.test.ts`, `src/game/application/server/compositionRoot.test.ts`, `src/game/application/testing/foundationJourney.testutil.ts`, `src/game/application/testing/investigationFlowJourney.test.ts`, `src/game/application/testing/prologueAckPreservesSceneChoices.test.ts`, `src/game/gameplay/rpg/ruleEngine/reconcileQuests.test.ts`, `src/game/gameplay/rpg/worldEvolution/keyEndingNpc.test.ts`
- Modify remaining `createInitialStoryState` callers: `src/game/application/buildChoiceMap.test.ts`, `src/game/application/deterministicEvolutionSource.test.ts`, `src/game/application/deterministicSceneSource.test.ts`, `src/game/application/evolveWorld.test.ts`, `src/game/application/sceneWriteBack.test.ts`, `src/game/application/server/ai/worldEvolutionSource.test.ts`, `src/game/application/server/battleScenePrewarm.test.ts`, `src/game/application/server/persistence/gameRepository.test.ts`, `src/game/application/testing/investigationChoiceJourney.test.ts`, `src/game/domain/turnResolution.test.ts`, `src/game/domain/worldDelta.test.ts`, `src/game/gameplay/rpg/candidateEvents/approveCandidateEvents.test.ts`, `src/game/gameplay/rpg/intentParser/intentContext.test.ts`, `src/game/gameplay/rpg/narrativeContext/buildOutcomeBeats.test.ts`, `src/game/gameplay/rpg/narrativeContext/deriveObjectiveTransition.test.ts`, `src/game/gameplay/rpg/ruleEngine/advanceStoryProgression.test.ts`, `src/game/gameplay/rpg/ruleEngine/approveCandidateEvents.test.ts`, `src/game/gameplay/rpg/ruleEngine/index.test.ts`, `src/game/gameplay/rpg/ruleEngine/resolveByType.test.ts`, `src/game/gameplay/rpg/ruleEngine/resolveEnding.test.ts`, `src/game/gameplay/rpg/ruleEngine/updateStoryMetrics.test.ts`, `src/game/gameplay/rpg/worldEvolution/approveWorldDelta.test.ts`, `src/game/gameplay/rpg/worldEvolution/deriveEvolutionNeed.test.ts`, `src/game/gameplay/rpg/worldEvolution/materializeWorldDelta.test.ts`, `src/game/gameplay/rpg/worldEvolution/storyReveal.test.ts`
- Modify: `src/game/application/server/persistence/sqliteGameRepository.ts`
- Modify: `src/game/application/server/persistence/sqliteGameRepository.test.ts`

**Interfaces:**
- Produces: `PreparedContinuationState`, `PreparedContinuationStepState`, `PreparedContinuationTrigger`, `PreparedSceneSeedState`, `PreparedChoiceSeedState`, `parseNarrativeRuntimeState(value)`.
- Consumes: `Action`, `NarrativeEventState`, `NarrativeNpcLineState`, and entity-ID domain types. Domain persistence types must not import `sceneSource.ts`, `WorldDeltaProposal`, or any application module.

- [ ] **Step 1: Write failing domain tests for a complete move-to-NPC prepared step**

```ts
const prepared: PreparedContinuationState = {
  originJobId: asNarrativeJobId("job_dialogue_2"),
  steps: [{
    stepId: "prepared:quest_2:move:loc_temple",
    objectiveKey: "quest_2:0",
    consumptionGroupKey: "quest_2:0:move",
    trigger: { kind: "move", locationId: asLocationId("loc_temple") },
    scene: {
      segments: [{ beatId: "atmosphere", text: "你沿山路抵达破庙。" }],
      event: { kind: "travel", locationId: asLocationId("loc_temple") },
      npcLine: {
        npcId: asNpcId("npc_beggar"),
        text: "后生，脚步放轻些。这里昨夜来过不该来的人。",
        emotion: "guarded",
        usedFactIds: [],
      },
      objectiveLink: { questId: asQuestId("quest_2"), objectiveIndex: 1, mode: "hint" },
      choiceSeeds: [
        { label: "老丈，昨夜来的是谁？", action: { type: "talk", npcId: asNpcId("npc_beggar"), dialogueAct: "support" } },
        { label: "你若隐瞒，我只能自己搜。", action: { type: "talk", npcId: asNpcId("npc_beggar"), dialogueAct: "challenge" } },
      ],
      source: "generated",
    },
    nextStepIds: [],
  }],
  activeStepIds: ["prepared:quest_2:move:loc_temple"],
};

expect(prepared.steps[0]!.scene.choiceSeeds).toHaveLength(2);
expect("choiceToken" in prepared.steps[0]!.scene.choiceSeeds[0]!).toBe(false);
```

Also test distinct triggers for `investigate` with `approachId` and for `battle_resolved` with the same `enemyId` but three distinct outcomes.

- [ ] **Step 2: Run the domain test and verify it fails**

Run: `npx vitest run src/game/domain/preparedContinuation.test.ts`

Expected: FAIL because the prepared-continuation types do not exist.

- [ ] **Step 3: Add the domain contract**

```ts
export type PreparedContinuationTrigger =
  | { readonly kind: "move"; readonly locationId: LocationId }
  | { readonly kind: "investigate"; readonly factId: FactId; readonly approachId?: string }
  | { readonly kind: "battle_started"; readonly enemyId: EnemyId }
  | {
      readonly kind: "battle_resolved";
      readonly enemyId: EnemyId;
      readonly outcome: "victory" | "defeat" | "withdraw";
    };

export type PreparedChoiceSeedState = {
  readonly label: string;
  readonly action: Action;
};

export type PreparedNarrativeSegmentState = {
  readonly beatId: string;
  readonly text: string;
  readonly referencedEntityIds?: readonly string[];
};

export type PreparedObjectiveLinkState = {
  readonly questId: QuestId;
  readonly objectiveIndex: number;
  readonly mode: "hint" | "progress" | "handoff";
};

export type PreparedSceneSeedState = {
  readonly segments: readonly PreparedNarrativeSegmentState[];
  readonly event: NarrativeEventState;
  readonly npcLine: NarrativeNpcLineState | null;
  readonly objectiveLink: PreparedObjectiveLinkState | null;
  readonly choiceSeeds: readonly PreparedChoiceSeedState[];
  readonly source: "generated" | "fixture";
};

export type PreparedContinuationStepState = {
  readonly stepId: string;
  readonly objectiveKey: string;
  /** Sibling variants share this key; consuming one prunes only this group. */
  readonly consumptionGroupKey: string;
  readonly trigger: PreparedContinuationTrigger;
  readonly scene: PreparedSceneSeedState;
  /** Server-authored graph edge; AI output never supplies or changes it. */
  readonly nextStepIds: readonly string[];
};

export type PreparedContinuationState = {
  readonly originJobId: NarrativeJobId;
  readonly steps: readonly PreparedContinuationStepState[];
  readonly activeStepIds: readonly string[];
};
```

The domain factory validates unique IDs, non-empty initial `activeStepIds` when steps exist, existing successor references, acyclicity, and that sibling variants in one `consumptionGroupKey` do not share the same canonical trigger. Add tests proving investigation alternatives activate branch-specific successors and `battle_started` activates three `battle_resolved` outcome variants instead of deleting them.

- [ ] **Step 4: Replace legacy narrative fields with the discriminated runtime state**

Implement the `ready | provider_pending | provider_failed` `NarrativeRuntimeState` union defined in the Target State Machine. Delete the nested `NarrativeGenerationState` and `linearNarrativeQueue`. `preparedContinuation` and `choiceRegistry` exist only on `ready`; `job` exists only on provider states; `failure` exists only on `provider_failed`. Add `parseNarrativeRuntimeState(value: unknown)` returning `{ok:true,value:NarrativeRuntimeState}|{ok:false,code:"INVALID_NARRATIVE_RUNTIME"}`; it must reject mixed fields, missing ready scene/registry, non-provider job kinds, malformed failure, unknown prepared IDs, and legacy `generation`. Add compile-time fixtures using `satisfies NarrativeRuntimeState` plus parser tests for each valid variant and rejected mixed-field records. `interpretGameRow` must call this parser before returning an active record and classify rejection as `UNPARSEABLE_RECORD`.

Do not weaken `ready.currentScene` to nullable merely to preserve the old constructor. Instead, make opening construction atomic:

```ts
export type CreateInitialStoryStateInput = {
  readonly gameLength: GameLength;
  readonly initialEntityCounts: { readonly locations: number; readonly npcs: number; readonly quests: number; readonly events: number };
  readonly initialNarrative: NarrativeRuntimeState;
  readonly mainThreadId?: ThreadId;
};
```

Export `OPENING_NPC_ID = asNpcId("npc_0")` from the existing `openingGeneration` facade and use that constant in both the compiler and `createGame`; do not duplicate the raw ID. `createGame` constructs the opening `PendingNarrativeJob` first, then passes `{ status:"provider_pending", mode:narrativeMode, job, lastPresentedScene:null, dialogueSession }` into `compileOpeningGenerationCandidate`, which forwards it to `createInitialStoryState`. Delete the later spread that overwrites `storyState.narrative`. Update all other `createInitialStoryState` callers with an explicit valid runtime fixture.

Migrate every production consumer listed in this task in the same commit: replace `narrative.generation.status` with the runtime discriminant; rename repository `expectedNarrativeGeneration` to `expectedNarrativeJob` with statuses `"provider_pending"|"provider_failed"`; use `lastPresentedScene` only for pending/failed speech/narration display and always project zero executable choices from it; preserve the existing client read-model status mapping as `idle|pending|failed`. The migration is not complete while this command finds a production legacy access:

```bash
rg -n "narrative\.generation|generation: \{ status:|expectedNarrativeGeneration" src --glob '!*.test.ts' --glob '!*.test.tsx' --glob '!*.testutil.ts'
```

Expected: no matches.

In `NarrativeSceneState`, add:

```ts
readonly handoffAcknowledgement?: string;
readonly source: "generated" | "rule" | "fixture";
```

Rename the current ambiguous `fallback` source to `fixture` atomically across `NarrativeSceneState`, `ScenePerformanceProposal`, explicit offline/test sources, read-model decoration, and AI audit source types. Production live source factories must never inject a fixture source; rule-owned scenes use `rule`. `narrativeText` renders fixture pages with the existing visible offline marker policy (rename the internal argument/type, not the player copy) and its tests pin that behavior. The Task 2 typecheck must not leave a mixed `fallback|fixture` union.

Delete unused production types/fields proven by `rg` to have no consumer: `NarrativeDialogueFollowupState`, `NarrativeTriggerContext`, `PlayerNpcChatState`, `dialogueFollowups`, and `nextEventHint`. Update/delete their type-only tests.

- [ ] **Step 5: Bump StoryState to v6 and make v5 explicitly unsupported**

```ts
export const STORY_STATE_SCHEMA_VERSION = 6 as const;

if (version === 2 || version === 3 || version === 4 || version === 5) {
  return { ok: false, code: "UNSUPPORTED_RECORD" };
}
```

Update `src/game/domain/storyState.ts` **and** `src/game/application/server/persistence/sqliteGameRepository.ts:interpretGameRow` to explicitly return `corrupt("UNSUPPORTED_RECORD")` when `storyStateJson.version === 5` (otherwise the generic `VERSION_MISMATCH` check would mask the required stable code). Update SQLite interpretation tests to assert a persisted v5 record is reported as `corrupt/UNSUPPORTED_RECORD` and a fresh v6 record loads normally.

- [ ] **Step 6: Run domain, migration, persistence, and type tests**

Run: `npx vitest run src/game/domain src/game/gameplay/rpg/openingGeneration/compileOpeningGenerationCandidate.test.ts src/game/application/createGame.test.ts src/game/application/server/persistence/sqliteGameRepository.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/game/domain src/game/gameplay/rpg/openingGeneration src/game/gameplay/rpg/ruleEngine/advanceStoryProgression.ts src/game/gameplay/rpg/ruleEngine/resolveEnding.ts src/game/application src/dependencyBoundaries.test.ts
git commit -m "refactor(narrative): add prepared continuation state"
```

---

### Task 3: Project the Full Continuation Through the Next NPC Decision

**Files:**
- Create: `src/game/gameplay/rpg/preparedContinuation/candidates.ts` — pure gameplay projection (no application/server imports)
- Create: `src/game/gameplay/rpg/preparedContinuation/index.ts` — gameplay facade (re-exports only `buildPreparedStepDescriptors`, `preparedTriggerKey` and descriptor types)
- Create: `src/game/gameplay/rpg/preparedContinuation/candidates.test.ts`
- Modify: `src/game/application/sceneGenerationContext.ts` — consume gameplay facade via `import { buildPreparedStepDescriptors } from "@/game/gameplay/rpg/preparedContinuation"`
- Modify: `src/game/application/sceneGenerationContext.test.ts`
- Modify: `src/game/application/sceneChoiceCandidates.ts` — keep candidate-ID derivation aligned with gameplay descriptors; no direct internal import
- Modify: `src/dependencyBoundaries.test.ts` — add `preparedContinuation` to `FACADES`, forbid deep-import `preparedContinuation/candidates` from `application/components/store/app`

**Interfaces:**
- Produces (gameplay facade `src/game/gameplay/rpg/preparedContinuation`): `PreparedStepDescriptor`, `PreparedChoiceCandidate`, `PreparedArrivalNpcContext`, `buildPreparedStepDescriptors(input)`, `preparedTriggerKey(trigger)`.
- Consumes: Task 2 `PreparedContinuationState`/`PreparedContinuationTrigger` plus domain `WorldState`, `StoryState`, and `ObjectiveTransition`. It must not accept/import application `GameRecord` and must not import `application`, `components`, `store`, `app`, `server-only`, or `@ai-game/*`.

- [ ] **Step 1: Write failing projection tests for the Sun Erniang → temple flow**

Create a record whose new quest is:

```ts
[
  { kind: "visit_location", locationId: locTemple, completed: false },
  { kind: "talk_to_npc", npcId: npcBeggar, completed: false },
]
```

Call `buildPreparedStepDescriptors({ worldState, storyState, transition })` and assert it returns one active move descriptor containing:

```ts
{
  trigger: { kind: "move", locationId: locTemple },
  arrivalNpc: {
    id: npcBeggar,
    name: "老乞丐",
    role: "破庙守夜人",
    publicProfile: "常年借宿镇外破庙",
    knownFactCards: [],
    sceneVisibleFactIds: [],
    goals: ["确认来者是否可信"],
  },
  choiceCandidates: [
    { candidateId: "prepared_1_choice_1", action: { type: "talk", npcId: npcBeggar, dialogueAct: "support" } },
    { candidateId: "prepared_1_choice_2", action: { type: "talk", npcId: npcBeggar, dialogueAct: "challenge" } },
  ],
}
```

Add a second test with two investigation approaches and assert two trigger variants are projected, one per `approachId`, without provider-dependent labels.

- [ ] **Step 2: Run the projection tests and verify they fail**

Run: `npx vitest run src/game/gameplay/rpg/preparedContinuation/candidates.test.ts`

Expected: FAIL because the descriptor builder does not exist.

- [ ] **Step 2b: Run boundaries and verify the facade is pinned**

Run: `npm run test:boundaries`

Expected: FAIL until `preparedContinuation` facade is added to `FACADES` and deep-import is forbidden.

- [ ] **Step 3: Implement deterministic descriptor projection (gameplay-pure)**

The traversal starts at `ObjectiveTransition.after`, walks released deterministic objectives, and stops immediately after it has prepared the next `talk_to_npc` scene with two choices. It may include `discover_fact`, `visit_location`, `defeat_enemy`, and their approach/battle variants; it must not choose a future NPC branch.

```ts
export type PreparedChoiceCandidate = {
  readonly candidateId: string;
  readonly action: Action;
};

export type PreparedStepDescriptor = {
  readonly stepId: string;
  readonly objectiveKey: string;
  readonly consumptionGroupKey: string;
  readonly trigger: PreparedContinuationTrigger;
  readonly authority: {
    readonly questId: QuestId;
    readonly objectiveIndex: number;
    readonly allowedEntityIds: readonly string[];
    readonly visibleFactIds: readonly FactId[];
  };
  readonly arrivalNpc?: PreparedArrivalNpcContext;
  readonly choiceCandidates: readonly PreparedChoiceCandidate[];
  readonly nextStepIds: readonly string[];
};

export type PreparedArrivalNpcContext = {
  readonly id: NpcId;
  readonly name: string;
  readonly role: string;
  readonly publicProfile: string;
  readonly knownFactCards: readonly { readonly factId: FactId; readonly text: string }[];
  readonly sceneVisibleFactIds: readonly FactId[];
  readonly goals: readonly string[];
};

export function buildPreparedStepDescriptors(input: {
  readonly worldState: WorldState;
  readonly storyState: StoryState;
  readonly transition: ObjectiveTransition;
}): {
  readonly descriptors: readonly PreparedStepDescriptor[];
  readonly activeStepIds: readonly string[];
};
```

Generate IDs and graph edges from objective/variant order, never from entity names or AI text. Investigation approaches are sibling descriptors in one `consumptionGroupKey`, each pointing to its own branch-specific successors. A `defeat_enemy` objective creates one `battle_started` descriptor whose successors are three `battle_resolved` descriptors (`victory|defeat|withdraw`) in a second consumption group. Validate the graph is acyclic before returning it.

- [ ] **Step 4: Put descriptors into `SceneGenerationContext`**

Replace `upcomingLinearObjectives` and `dialogueSessionCompleted` with:

```ts
readonly generationKind: ProviderGenerationKind;
readonly finalDialogueHandoff: boolean;
readonly preparedStepDescriptors: readonly PreparedStepDescriptor[];
readonly preparedActiveStepIds: readonly string[];
```

Project `finalDialogueHandoff` directly from `job.sceneRequestKind === "npc_handoff"`; do not reconstruct it from the later mutable `dialogueSession.completed` flag. Copy `descriptors` and `activeStepIds` from the single `buildPreparedStepDescriptors` result. Keep `ObjectiveTransition.after` correction for newly materialized entities, but do not use it to change `generationKind` or `sceneRequestKind`.

- [ ] **Step 5: Prove projection stops at the next decision boundary**

Add a quest chain `visit → investigate(two approaches) → move → talk NPC → move` and assert descriptors include both investigation branches and each branch-specific successor chain through the talk scene, but exclude the final move after that NPC choice. Add `move → defeat_enemy → talk NPC` and assert consuming `battle_started` would leave all three resolution outcomes reachable.

- [ ] **Step 6: Run focused tests**

Run: `npm run test:boundaries && npx vitest run src/game/gameplay/rpg/preparedContinuation/candidates.test.ts src/game/application/sceneGenerationContext.test.ts src/game/application/sceneChoiceCandidates.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/game/gameplay/rpg/preparedContinuation src/game/application/sceneGenerationContext.ts src/game/application/sceneGenerationContext.test.ts src/game/application/sceneChoiceCandidates.ts src/dependencyBoundaries.test.ts
git commit -m "feat(narrative): project continuation to next NPC decision"
```

---

### Task 4: Replace the Scene Output Contract with Atomic Prepared Steps

**Files:**
- Modify: `src/game/application/sceneSource.ts`
- Create: `src/game/application/approvePreparedContinuation.ts` — application orchestration; consumes `src/game/gameplay/rpg/preparedContinuation` facade for descriptor validation
- Create: `src/game/application/approvePreparedContinuation.test.ts`
- Modify: `src/game/application/approveAndWriteScene.ts`
- Modify: `src/game/application/approveAndWriteScene.test.ts`
- Modify: `src/game/application/deterministicSceneSource.ts` — explicit offline/test fixture source: replace `linearActionNarratives` with `preparedContinuations` and emit `source="fixture"` consistently
- Modify: `src/game/application/server/ai/narrativeContext/sceneNarrativeContext.ts`
- Modify: `src/game/application/server/ai/narrativeContext/sceneNarrativeContext.test.ts`
- Modify: `src/game/application/server/ai/liveScenePerformanceSource.ts` — import core JSON helper (`src/game/core/json`) instead of local `parseJsonResponse`
- Modify: `src/game/application/server/ai/liveScenePerformanceSource.test.ts`
- Modify: `src/dependencyBoundaries.test.ts` — forbid `application/server/ai` importing gameplay internals; ensure `approvePreparedContinuation` imports gameplay only via facade

**Interfaces:**
- Produces: `PreparedContinuationProposal`, `approvePreparedContinuation(input)`, and the new atomic `ScenePerformanceProposal`.
- Consumes: Task 3 descriptors/candidate IDs and Task 2 persistent state.

- [ ] **Step 1: Write the failing raw-contract/parser regression**

For a final NPC handoff, the raw response must have no executable current-scene choices:

```ts
const raw = {
  segments: [
    { beatId: "player_utterance", text: "你答应照她的指引去镇外破庙。" },
    { beatId: "rule_result", text: "孙二娘压低声音，交代了破庙的方位。" },
    { beatId: "objective_handoff", text: "下一步需要由你从大地图前往镇外破庙。" },
  ],
  npcLine: {
    npcId: "npc_sun_erniang",
    text: "出了镇沿北坡走，见到断碑便是破庙。",
    emotion: "guarded",
    answeredBeatIds: ["player_utterance"],
    usedFactIds: [],
    usedInteractionActionIds: ["action_dialogue_2"],
  },
  npcDialogues: [],
  objectiveLink: { questId: "quest_2", objectiveIndex: 0, mode: "handoff" },
  choices: [],
  handoffAcknowledgement: "（向孙二娘抱拳道谢，转身离开茶摊。）",
  preparedContinuations: [{
    stepId: "prepared:quest_2:move:loc_temple",
    segments: [{ beatId: "atmosphere", text: "你沿山路抵达破庙。" }],
    npcLine: {
      npcId: "npc_beggar",
      text: "后生，脚步放轻些。这里昨夜来过不该来的人。",
      emotion: "guarded",
      answeredBeatIds: [],
      usedFactIds: [],
      usedInteractionActionIds: [],
    },
    objectiveLink: { questId: "quest_2", objectiveIndex: 1, mode: "hint" },
    choices: [
      { candidateId: "prepared_1_choice_1", label: "老丈，昨夜来的是谁？" },
      { candidateId: "prepared_1_choice_2", label: "你若隐瞒，我只能自己搜。" },
    ],
  }],
};
```

Assert the parser rejects: a handoff with one executable current choice; a prepared arrival step with fewer/more than two choices; an unknown/duplicate `stepId`; a future candidate ID not present in the descriptor; a missing branch descriptor; and an invented entity ID. The AI response does not contain `trigger`, `consumptionGroupKey`, `nextStepIds`, or `activeStepIds`; those remain server-authored descriptor facts.

- [ ] **Step 2: Run focused parser tests and verify they fail**

Run: `npx vitest run src/game/application/server/ai/liveScenePerformanceSource.test.ts src/game/application/approvePreparedContinuation.test.ts`

Expected: FAIL on the old `linearActionNarratives` contract.

- [ ] **Step 3: Replace proposal types**

```ts
export type PreparedContinuationProposal = {
  readonly stepId: string;
  readonly segments: readonly ScenePerformanceSegment[];
  readonly npcLine: ScenePerformanceNpcLine | null;
  readonly objectiveLink: ScenePerformanceObjectiveLink | null;
  readonly choices: readonly { readonly candidateId: string; readonly label: string }[];
};

export type ScenePerformanceProposal = {
  readonly sceneId: string;
  readonly segments: readonly ScenePerformanceSegment[];
  readonly npcLine: ScenePerformanceNpcLine | null;
  readonly npcDialogues?: readonly ScenePerformanceNpcDialogue[];
  readonly objectiveLink: ScenePerformanceObjectiveLink | null;
  readonly choices: readonly { readonly candidateId: string; readonly label: string }[];
  readonly handoffAcknowledgement?: string;
  readonly preparedContinuations: readonly PreparedContinuationProposal[];
  readonly source: "generated" | "fixture";
};
```

Delete `LinearActionNarrative`, `LinearActionNpcLine`, and `contentRepairAttempt` from `sceneSource.ts`. `fixture` is accepted only from explicit offline/test composition (`src/game/application/deterministicSceneSource.ts` — update it here to emit `preparedContinuations`, stop emitting `linearActionNarratives`, and update its tests from `fallback/generated` to `fixture`); live adapters always return `generated`.

- [ ] **Step 4: Render one output contract from the descriptor list**

Update the prompt so:

- ordinary NPC scene: exactly two current choices, no acknowledgement;
- final handoff: zero current choices plus exactly one `handoffAcknowledgement`;
- every descriptor has exactly one prepared output entry;
- every arrival NPC decision has two prepared choices;
- no extra/missing prepared step is allowed.

Snapshot only the schema/contract block, not the full prompt.

- [ ] **Step 5: Implement atomic continuation approval**

```ts
export type PreparedContinuationRejection =
  | "missing_step"
  | "duplicate_step"
  | "unknown_step"
  | "invalid_graph"
  | "invalid_entity_reference"
  | "invalid_fact_reference"
  | "invalid_choice_count"
  | "invalid_choice_candidate";

export type ApprovePreparedContinuationResult =
  | { readonly ok: true; readonly prepared: PreparedContinuationState }
  | { readonly ok: false; readonly code: PreparedContinuationRejection };

export function approvePreparedContinuation(input: {
  readonly originJobId: NarrativeJobId;
  readonly proposals: readonly PreparedContinuationProposal[];
  readonly descriptors: readonly PreparedStepDescriptor[];
  readonly activeStepIds: readonly string[];
  readonly worldState: WorldState;
}): ApprovePreparedContinuationResult;
```

Resolve each prepared candidate ID to its server-owned `Action`, normalize text, enforce fact/entity allowlists, validate descriptor identity, and rebuild new objects. Copy `trigger`, `objectiveKey`, `consumptionGroupKey`, `nextStepIds`, and initial `activeStepIds` only from server descriptors; derive `NarrativeEventState` from the descriptor trigger and authoritative preview state, never from AI JSON. Reject the entire prepared bundle if any required node/variant fails, the graph is cyclic, a successor is missing, or an active ID is unknown; do not drop one entry and keep the scene.

- [ ] **Step 6: Change current-scene approval to return scene + prepared state together**

`approveScenePerformance` must return:

```ts
{
  scene: NarrativeSceneState;
  choiceRegistry: readonly ApprovedChoice[];
  preparedContinuation: PreparedContinuationState;
  qualityWarnings: readonly SceneQualityWarningCode[];
}
```

For handoff scenes, persist `handoffAcknowledgement` and an empty `choiceRegistry`; do not mint an action token for the acknowledgement.

- [ ] **Step 7: Run focused schema/approval tests**

Run: `npx vitest run src/game/application/approvePreparedContinuation.test.ts src/game/application/approveAndWriteScene.test.ts src/game/application/server/ai/liveScenePerformanceSource.test.ts src/game/application/server/ai/narrativeContext/sceneNarrativeContext.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/game/application/sceneSource.ts src/game/application/approvePreparedContinuation.ts src/game/application/approvePreparedContinuation.test.ts src/game/application/approveAndWriteScene.ts src/game/application/approveAndWriteScene.test.ts src/game/application/deterministicSceneSource.ts src/game/application/server/ai/liveScenePerformanceSource.ts src/game/application/server/ai/liveScenePerformanceSource.test.ts src/game/application/server/ai/narrativeContext src/dependencyBoundaries.test.ts
git commit -m "refactor(narrative): generate atomic prepared scene bundles"
```

---

### Task 5: Centralize Structured JSON and Content-Repair Ownership

**Files:**
- Create: `src/game/core/json/structuredJsonResponse.ts` — pure JSON fence normalizer
- Create: `src/game/core/json/index.ts` — core facade
- Create: `src/game/core/json/structuredJsonResponse.test.ts`
- Create: `src/game/core/retry/boundedAttempts.ts` — generic positive-integer attempt budget helper
- Create: `src/game/core/retry/index.ts` — core facade
- Create: `src/game/core/retry/boundedAttempts.test.ts`
- Modify: `src/game/application/server/ai/liveScenePerformanceSource.ts` — import `parseStructuredJsonObject` from `src/game/core/json`
- Modify: `src/game/application/server/ai/liveWorldEvolutionSource.ts` — import `parseStructuredJsonObject` from `src/game/core/json`
- Modify: `src/game/application/server/ai/openingGenerationSource.ts` — import `parseStructuredJsonObject` from `src/game/core/json`
- Modify: `src/game/application/server/ai/liveIntentParserSource.ts` — import both core facades; keep intent content repair owned here but express its two-attempt budget through `runBoundedAttempts`
- Modify: `src/game/application/createGame.ts`, `src/game/application/createGame.test.ts` — express the existing three-attempt opening candidate-regeneration budget through `runBoundedAttempts` without nesting source retries
- Modify: `src/game/application/generatePendingScene.ts` — import `runBoundedAttempts` from `src/game/core/retry`
- Modify: `src/game/application/evolveWorld.ts` — import `runBoundedAttempts` from `src/game/core/retry`
- Modify: `src/dependencyBoundaries.test.ts` — add core facades (`json`, `retry`) and forbid `game/gameplay/domain` importing `application/server` to reach them; pin core may only be imported via its facade and must not import RPG layers

**Interfaces:**
- Produces (core `src/game/core/json`): `parseStructuredJsonObject(text) => { ok:true; value:Record<string,unknown>; normalization:"none"|"json_fence" } | { ok:false; reason:"invalid_json"|"root_not_object" }`
- Produces (core `src/game/core/retry`): `runBoundedAttempts(input)` — pure generic budget controller, no AI/provider/prompt/RPG state.
- Consumes: core consumes only caller callbacks and typed failures. Application/server integrations continue consuming the existing `RpgAiClient`; this Plan does not change `@ai-game/ai-transport`. Core modules must not import `domain/gameplay/application` and must be importable only via `src/game/core/<system>/index.ts`.

- [ ] **Step 1: Write failing normalization tests (core)**

```ts
import { parseStructuredJsonObject } from "@/game/core/json";
expect(parseStructuredJsonObject('{"ok":true}')).toEqual({ ok: true, value: { ok: true }, normalization: "none" });
expect(parseStructuredJsonObject('```json\n{"ok":true}\n```')).toEqual({ ok: true, value: { ok: true }, normalization: "json_fence" });
expect(parseStructuredJsonObject('before {"ok":true} after')).toEqual({ ok: false, reason: "invalid_json" });
expect(parseStructuredJsonObject('[]')).toEqual({ ok: false, reason: "root_not_object" });
```

- [ ] **Step 2: Write failing core attempt-budget tests**

Prove:

- a successful first attempt calls `runAttempt` once;
- a non-retryable first failure calls `runAttempt` once;
- a retryable first failure calls attempt 2 exactly once with the stable prior reason;
- a second failure is returned without a third call;
- thrown errors are not swallowed or converted by core.

Keep `RpgAiClient`, audit origin, prompt, provider failure categories, and manual retry out of core tests. Add those integration assertions to `liveIntentParserSource.test.ts`, `generatePendingScene.test.ts`, `evolveWorld.test.ts`, and the existing failed-job retry tests instead.

- [ ] **Step 3: Run the new tests and verify they fail**

Run: `npx vitest run src/game/core/json/structuredJsonResponse.test.ts src/game/core/retry/boundedAttempts.test.ts`

Expected: FAIL because the helpers do not exist.

- [ ] **Step 3b: Run boundaries and verify core guard fails without facade**

Run: `npm run test:boundaries`

Expected: FAIL until `src/dependencyBoundaries.test.ts` pins `src/game/core/json` and `src/game/core/retry` facades.

- [ ] **Step 4: Implement shared normalization and attempt control**

```ts
export type BoundedAttemptResult<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly retryable: boolean; readonly reason: E };

export async function runBoundedAttempts<T, E>(input: {
  readonly maxAttempts: number;
  readonly runAttempt: (attempt: number, priorReason?: E) => Promise<BoundedAttemptResult<T, E>>;
}): Promise<BoundedAttemptResult<T, E>> {
  if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1) {
    throw new RangeError("maxAttempts must be a positive integer");
  }
  let priorReason: E | undefined;
  for (let attempt = 1; attempt <= input.maxAttempts; attempt += 1) {
    const result = await input.runAttempt(attempt, priorReason);
    if (result.ok || !result.retryable || attempt === input.maxAttempts) return result;
    priorReason = result.reason;
  }
  throw new Error("unreachable bounded-attempt state");
}
```

The helper controls count only. Role use cases pass `maxAttempts: 2`, decide which failures are retryable, and build their own repair prompt.

- [ ] **Step 4b: Add executable core facade and dependency guards**

Extend `src/dependencyBoundaries.test.ts` with:

```ts
const CORE_FACADES = [
  { name: "json", path: "@/game/core/json" },
  { name: "retry", path: "@/game/core/retry" },
] as const;

const CORE_LAYER_PATTERNS: readonly BoundaryPattern[] = [
  forbiddenSpecifierPrefix("@/game/domain"),
  forbiddenSpecifierPrefix("@/game/gameplay"),
  forbiddenSpecifierPrefix("@/game/application"),
  forbiddenSpecifierPrefix("@/components"),
  forbiddenSpecifierPrefix("@/store"),
  forbiddenSpecifierPrefix("@/app"),
  forbiddenSpecifierPrefix("@/providers"),
  forbiddenSpecifierPrefix("@ai-game/"),
  SERVER_ONLY_IMPORT,
  LIBSQL_IMPORT,
];

const CORE_DEEP_IMPORTS = CORE_FACADES.map((facade) => ({
  label: `${facade.name} core deep import`,
  regex: new RegExp(`["']${escapeRegExp(facade.path)}\\/[^"']+["']`),
}));
```

Add `{ directory:"game/core", patterns:CORE_LAYER_PATTERNS }` to `rules`, forbid `@/game/core` entirely from domain, and spread `CORE_DEEP_IMPORTS` into production rules for gameplay/application/application-server. Add synthesized negative fixtures proving a core module cannot import domain or `@ai-game/ai-transport`, domain cannot import core, and an application module cannot deep-import `@/game/core/retry/boundedAttempts`.

- [ ] **Step 5: Remove duplicated fenced-JSON parsers**

Replace each local `parseJsonResponse` in opening/intent/scene/world with `parseStructuredJsonObject`. Record `normalization="json_fence"` as a warning/metric so tolerated provider non-compliance is observable rather than silently considered strict compliance.

- [ ] **Step 6: Assign exactly one generation-attempt owner per role**

Use exactly one owner per role:

- scene: `createLiveScenePerformanceSource.generateScene(context)` performs one `RpgAiClient.complete`, one normalize/parse, and returns a typed repair reason; delete recursive source retry. `generatePendingScene` owns the two-attempt loop and runs parse + current-scene approval + prepared-continuation approval inside each attempt;
- world: `liveWorldEvolutionSource` remains a single-attempt adapter; `evolveWorld` owns its two-attempt parse + approval loop;
- intent: `liveIntentParserSource` remains the role use case and owns its two-attempt loop through the core budget helper; remove the recursive `parseAttempt` implementation but do not add an application-level second loop;
- opening: `openingGenerationSource` remains a single provider attempt; `createGame` owns the existing three-attempt opening candidate/novelty regeneration loop through `runBoundedAttempts({ maxAttempts:3, ... })`. Map the helper's 1-based `attempt` to the existing opening index as `openingAttempt = attempt - 1`, preserving source inputs/audit values `0|1|2`. Audit regeneration as `candidate_regeneration`, not `content_repair`, and never nest another provider retry inside the source.

Provider/transport failures are non-repairable except `empty_response`, which may consume the one content-repair attempt with a changed prompt. Never retain fields from a rejected attempt.

- [ ] **Step 7: Run AI source/retry/boundary tests**

Run: `npm run test:boundaries && npx vitest run src/game/core src/game/application/server/ai src/game/application/createGame.test.ts src/game/application/generatePendingScene.test.ts src/game/application/evolveWorld.test.ts src/game/application/retryNarrativeGeneration.test.ts`

Expected: PASS; maximum content attempts remain exactly two; core facades do not import RPG layers.

- [ ] **Step 8: Commit**

```bash
git add src/game/core src/game/application/server/ai src/game/application/createGame.ts src/game/application/createGame.test.ts src/game/application/generatePendingScene.ts src/game/application/generatePendingScene.test.ts src/game/application/evolveWorld.ts src/game/application/evolveWorld.test.ts src/dependencyBoundaries.test.ts
git commit -m "refactor(ai): centralize structured content attempts"
```

---

### Task 6: Consume Prepared Actions Atomically in `performTurn`

**Files:**
- Modify: `src/game/domain/preparedContinuation.ts` — export the two continuation-consumption error codes beside the state they describe; do not create a two-constant file
- Create: `src/game/application/consumePreparedContinuation.ts` — application orchestration; imports `decideNarrativeExecution` from `src/game/gameplay/rpg/narrativeExecution` and descriptor helpers via `src/game/gameplay/rpg/preparedContinuation`
- Create: `src/game/application/consumePreparedContinuation.test.ts`
- Create: `src/game/application/ruleOwnedScene.ts` — builds deterministic `NarrativeSceneState` with `source="rule"`; imports only `src/game/domain/*` and `src/game/gameplay/rpg/*` via facades
- Create: `src/game/application/ruleOwnedScene.test.ts`
- Modify: `src/game/domain/narrative.ts` — add `source="rule"` and `handoffAcknowledgement?` to `NarrativeSceneState`; ensure `NARRATIVE_CONTINUATION_*` codes map to stable `PerformTurnResult.code`
- Modify: `src/game/application/performTurn.ts` — import policy from gameplay facade, not local
- Modify: `src/game/application/performTurn.test.ts`
- Modify: `src/game/application/stateCommit.ts` — document that prepared-consumption + rule result share one CAS; no separate `applySceneWriteBack`
- Modify: `src/game/application/requestParser.ts`, `src/game/application/requestParser.test.ts` — stable HTTP mapping (`MISSING` → 409, `INVALID` → 500)
- Modify: `src/game/application/server/compositionRoot.ts`, `src/game/application/server/compositionRoot.test.ts` — propagate both codes without collapsing them into AI failures
- Modify: `src/app/api/game/actions/route.test.ts` — pin the two HTTP mappings
- Modify: `src/game/application/server/persistence/gameRepository.ts` — no new methods; only ensure CAS path stays single `applyState`
- Modify: `src/dependencyBoundaries.test.ts` — forbid `consumePreparedContinuation`/`ruleOwnedScene` importing `@ai-game/ai-transport` or `server/ai/*`

**Interfaces:**
- Produces (domain): `PreparedContinuationErrorCode` (`"NARRATIVE_CONTINUATION_MISSING" | "NARRATIVE_CONTINUATION_INVALID"`).
- Produces (application): `consumePreparedContinuation(input)`, `buildRuleOwnedScene(input)`.
- Consumes: Task 1 gameplay execution policy + Task 2 `PreparedContinuationState` + Task 3 gameplay candidate helpers; `performTurn` must not import `SceneSource`/`WorldEvolutionSource`/`generatePendingScene`.

- [ ] **Step 1: Write failing atomic-consumption tests**

For a matching move step, assert:

```ts
expect(result.ok).toBe(true);
if (!result.ok) throw new Error("expected successful prepared continuation consumption");
expect(result.nextWorldState.currentLocationId).toBe(locTemple);
expect(result.nextStoryState.narrative.status).toBe("ready");
if (result.nextStoryState.narrative.status !== "ready") throw new Error("expected ready narrative state");
const narrative = result.nextStoryState.narrative;
expect(narrative.currentScene.npcLine?.npcId).toBe(npcBeggar);
expect(narrative.choiceRegistry).toHaveLength(2);
expect(narrative.choiceRegistry.every((choice) => choice.basedOnRevision === 6)).toBe(true);
expect(narrative.preparedContinuation?.steps).toHaveLength(0);
expect(narrative.preparedContinuation?.activeStepIds).toEqual([]);
```

Assert one repository `applyState` call, revision `+1`, and zero `applySceneWriteBack` calls.

- [ ] **Step 2: Add missing/stale/variant failure tests**

Cover:

- objective move with no matching prepared step → `NARRATIVE_CONTINUATION_MISSING`, zero write;
- matching entity but wrong investigation `approachId` → missing, zero write;
- prepared graph has an unknown successor, duplicate trigger in one active group, or scene seed whose authority no longer matches the resolved rule state → `NARRATIVE_CONTINUATION_INVALID`, zero write;
- replaying a consumed step → missing, zero write;
- non-objective backtrack → rule-owned scene, one write, no prepared requirement.
- free text whose `targetNpcId` does not equal the authoritative focused NPC → `ACTION_REJECTED`, zero intent/scene/world provider calls, zero write;
- only inactive matching trigger exists → missing, zero write;
- consuming one investigation approach activates only that node's branch-specific successors and prunes the sibling branch;
- consuming `battle_started` preserves and activates the three `battle_resolved` outcome siblings;
- resolving `victory`, `defeat`, or `withdraw` matches only the corresponding prepared outcome and prunes the other two.
- `httpStatusForCode("NARRATIVE_CONTINUATION_MISSING") === 409` and `httpStatusForCode("NARRATIVE_CONTINUATION_INVALID") === 500`; neither is mapped to `AI_CALL_FAILED`/`AI_RESPONSE_INVALID`.

- [ ] **Step 3: Run the tests and verify they fail**

Run: `npm run test:boundaries && npx vitest run src/game/application/consumePreparedContinuation.test.ts src/game/application/performTurn.test.ts`

Expected: FAIL because all successful actions still create pending jobs; also FAIL if `consumePreparedContinuation` imports `@ai-game/ai-transport` or `server/ai` (boundary guard).

- [ ] **Step 4: Implement trigger matching and scene materialization**

```ts
export function consumePreparedContinuation(input: {
  readonly beforeWorldState: WorldState;
  readonly beforeStoryState: StoryState;
  readonly resolvedWorldState: WorldState;
  readonly resolvedStoryState: StoryState;
  readonly action: Action;
  readonly postCommitRevision: number;
  readonly resolvedEvent: ResolvedEvent;
  readonly now: () => string;
}): ConsumePreparedContinuationResult;
```

Match the canonical `preparedTriggerKey` only among `activeStepIds`, require exactly one match, verify the prepared scene authority against the resolved rule state, build the current scene, and call `createApprovedChoice` for each seed using `postCommitRevision`. Remove sibling variants sharing the matched node's `consumptionGroupKey`, prune nodes no longer reachable from the matched node's server-authored `nextStepIds`, set those successors as the new `activeStepIds`, and return new states without IO. Never call/materialize world evolution here, and never remove a later battle-resolution group merely because it shares the same `objectiveKey` as `battle_started`.

- [ ] **Step 5: Add rule-owned non-AI presentation**

`buildRuleOwnedScene` may use only structured rule/location/item/battle facts. It must never create NPC dialogue or generated branch labels. Mark its source `rule`.

- [ ] **Step 6: Guard intent before conversion, then dispatch by policy before commit**

Before calling `convertInteraction`, compute the focused NPC from the ready state. If the interaction is free text and `intentProviderAllowedFor({ interaction, focusedNpcId })` is false, return `ACTION_REJECTED` without passing `intentParserSource` and without writing. This is the provider guard for intent parsing, which otherwise occurs before an `Action` exists.

After `resolveTurn`, dispatch the scene/world path:

```ts
const decision = decideNarrativeExecution({
  action,
  interactionKind,
  advancesObjective,
  hasPreparedStep,
  battleWillResolve,
  dialogueWillComplete,
});
switch (decision.kind) {
  case "provider":
    return commitProviderJob(decision.generationKind, decision.sceneRequestKind, resolvedTurn);
  case "prepared":
    return commitPreparedResolution(resolvedTurn);
  case "rule_only":
    return commitRuleOnlyResolution(resolvedTurn);
}
```

Delete the unconditional path from every success into `commitResolution/createPendingNarrativeJob`. Only the provider case may construct a pending job.

- [ ] **Step 7: Run application/boundary tests**

Run: `npm run test:boundaries && npx vitest run src/game/application/consumePreparedContinuation.test.ts src/game/application/ruleOwnedScene.test.ts src/game/application/performTurn.test.ts src/game/application/stateCommit.test.ts src/game/application/requestParser.test.ts src/game/application/server/compositionRoot.test.ts src/app/api/game/actions/route.test.ts`

Expected: PASS; `performTurn` imports no `SceneSource`/`WorldEvolutionSource`; `NARRATIVE_CONTINUATION_*` maps to `PerformTurnResult.code` with zero writes.

- [ ] **Step 8: Commit**

```bash
git add src/game/domain/preparedContinuation.ts src/game/domain/narrative.ts src/game/application/consumePreparedContinuation.ts src/game/application/consumePreparedContinuation.test.ts src/game/application/ruleOwnedScene.ts src/game/application/ruleOwnedScene.test.ts src/game/application/performTurn.ts src/game/application/performTurn.test.ts src/game/application/stateCommit.ts src/game/application/requestParser.ts src/game/application/requestParser.test.ts src/game/application/server/compositionRoot.ts src/game/application/server/compositionRoot.test.ts src/game/application/server/persistence/gameRepository.ts src/app/api/game/actions/route.test.ts src/dependencyBoundaries.test.ts
git commit -m "refactor(turn): consume prepared scenes in one CAS"
```

---

### Task 7: Remove Every Non-Whitelist Provider Entry Point

**Files:**
- Create: `src/game/application/server/providerTriggerBoundary.test.ts`
- Modify: `src/game/application/generatePendingScene.ts`
- Modify: `src/game/application/generatePendingScene.test.ts`
- Modify: `src/game/application/server/compositionRoot.ts`
- Modify: `src/game/application/server/compositionRoot.test.ts`
- Modify: `src/game/application/evolveWorld.ts`
- Modify: `src/game/gameplay/rpg/worldEvolution/deriveEvolutionNeed.ts`
- Delete: `src/game/application/server/battleScenePrewarm.ts`
- Delete: `src/game/application/server/battleScenePrewarm.test.ts`
- Modify: battle journey tests under `src/game/application/testing/`

**Interfaces:**
- Consumes: `providerAllowedFor`, prepared consumption, provider-job `generationKind`.
- Produces: a composition root in which all calls to scene/world/intent providers are guarded by the explicit whitelist.

- [ ] **Step 1: Write a static provider-call boundary test**

Create `src/game/application/server/providerTriggerBoundary.test.ts` with an explicit source-level architecture guard:

```ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const occurrences = (source: string, token: string) => source.split(token).length - 1;

describe("provider trigger architecture boundary", () => {
  it("keeps performTurn free of scene/world provider capabilities", () => {
    const source = read("src/game/application/performTurn.ts");
    expect(source).not.toMatch(/SceneSource|WorldEvolutionSource|generatePendingScene/);
  });

  it("keeps compositionRoot with one pending-job generation entry", () => {
    const source = read("src/game/application/server/compositionRoot.ts");
    expect(occurrences(source, "generatePendingScene({")).toBe(1);
    expect(source).not.toMatch(/shouldCompleteSceneInAction|immediateSceneResult|battleScenePrewarm/);
  });

  it("keeps free-text intent conversion as performTurn's only provider capability", () => {
    const source = read("src/game/application/performTurn.ts");
    expect(source).toMatch(/IntentParserSource/);
    expect(occurrences(source, "intentParserSource")).toBeGreaterThan(0);
  });
});
```

This guard intentionally checks orchestrators, not live adapter implementations. Also add a behavioral test that `generatePendingScene` returns `not_pending`/stable invalid without calling any source when a forged pending job has a non-whitelisted kind.

- [ ] **Step 2: Write provider-spy tests for hidden entry points**

Assert zero scene/world calls for:

- objective move queue miss;
- candidate shortage during a linear action;
- unknown location/NPC action repair;
- battle start;
- active battle rounds;
- battle victory;
- backtracking;
- opening acknowledgement;
- local/same-location NPC handoff.
- free text targeting a stale/non-focused NPC (zero intent calls as well as zero scene/world calls).

- [ ] **Step 3: Run the tests and verify current failures**

Run: `npx vitest run src/game/application/server/compositionRoot.test.ts src/game/application/generatePendingScene.test.ts src/game/application/testing --testNamePattern="provider boundary|battle prewarm|queue miss"`

Expected: FAIL because move completion, candidate shortage, unknown-action repair, and battle prewarm can still call providers.

- [ ] **Step 4: Reduce `generatePendingScene` to provider-job orchestration**

Delete `immediateAction`, `isQueueEligible`, `queueEntryIssueForCurrentScene`, `narrative_queue_hit/miss`, queue merging, queued proposal synthesis, and synchronous action paths. At function entry:

```ts
if (runtime.status !== "provider_pending") return { status: "not_pending" };
if (!providerAllowedFor(runtime.job.generationKind)) {
  logger.warn("provider_trigger_rejected", {
    runtimeStatus: runtime.status,
    generationKind: runtime.job.generationKind,
  });
  return fail({ kind: "AI_RESPONSE_INVALID", phase: "scene", failedAt: now() });
}
```

World evolution inside this function is permitted only because the enclosing persisted job is provider-allowed. It must materialize or prepare everything required through the next NPC decision boundary.

- [ ] **Step 5: Remove synchronous immediate generation from composition root**

Delete `shouldCompleteSceneInAction` and the `await generatePendingScene` branch for move/investigate/take-item (and its `battleScenePrewarm` sibling). After a successful non-provider turn, project the already committed ready/rule scene and return immediately. Also delete the `prewarmed` audit path (`path:"prewarmed"` in `compositionRoot:applyPrewarmedBattleScene` and `battleScenePrewarm.ts`) — after this task there is no in-memory prewarm cache and no `story_text` audit with `path==="prewarmed"`.

- [ ] **Step 6: Remove unknown-action world-AI repair**

An unknown entity/action is a rejected or stale client action, not a reason to generate the world. Return the existing stable action error with zero write/provider call. World evolution occurs only while an allowed provider job prepares its continuation.

- [ ] **Step 7: Replace battle prewarm with prepared battle steps**

Delete prewarm caches/promises/source calls. Before committing a rule result that starts or resolves a battle, require/match the appropriate active prepared trigger. `battle_started` activates the server-authored resolution group; active rounds remain rule-only; the resolving round matches `battle_resolved(enemyId,outcome)` for `victory|defeat|withdraw`. If that exact outcome node is missing, return `NARRATIVE_CONTINUATION_MISSING` before writing the resolved battle.

- [ ] **Step 8: Run boundary/composition/battle tests**

Run: `npm run test:boundaries && npx vitest run src/game/application/server/compositionRoot.test.ts src/game/application/generatePendingScene.test.ts src/game/application/testing --testNamePattern="provider|battle"`

Expected: PASS and all provider spies remain zero outside opening/NPC cases.

- [ ] **Step 9: Commit**

```bash
git add src/game/application/server/providerTriggerBoundary.test.ts src/game/application/generatePendingScene.ts src/game/application/generatePendingScene.test.ts src/game/application/server/compositionRoot.ts src/game/application/server/compositionRoot.test.ts src/game/application/server/battleScenePrewarm.ts src/game/application/server/battleScenePrewarm.test.ts src/game/application/evolveWorld.ts src/game/gameplay/rpg/worldEvolution/deriveEvolutionNeed.ts src/game/application/testing
git commit -m "refactor(ai): remove non-dialogue provider triggers"
```

---

### Task 8: Make Handoff Acknowledgement Local and Keep Map Travel Explicit

**Files:**
- Modify: `src/game/application/gameSessionView.ts`
- Modify: `src/game/application/gameSessionView.test.ts`
- Modify: `src/components/LocationSceneScreen.tsx`
- Modify: `src/components/AdventureGameShell.tsx`
- Modify: `src/components/WorldMapScreen.tsx`
- Modify: `src/components/AdventureGameShell.test.tsx`
- Modify: `src/components/LocationSceneScreen.test.tsx`
- Modify: `src/components/sharedUiContract.test.tsx`

**Interfaces:**
- Produces: `NpcDialogueView.handoffAcknowledgement?: { label: string }` with no token/action.
- Consumes: Task 2 `NarrativeSceneState.handoffAcknowledgement`.

- [ ] **Step 1: Rewrite the failing component regression for the reported bug**

Replace the current expectation that a travel handoff submits and waits with:

```ts
await user.click(within(dialogue).getByRole("button", { name: acknowledgement }));
expect(onSubmit).not.toHaveBeenCalled();
expect(screen.queryByRole("status")).not.toHaveTextContent(/等待.*回应/);
expect(screen.queryByRole("dialog", { name: "与孙二娘对话" })).not.toBeInTheDocument();
expect(onReturnMap).not.toHaveBeenCalled(); // player still chooses the existing return-map control
```

At shell level, assert revision/current location remain unchanged until the player clicks the target map node.

- [ ] **Step 2: Add map interaction tests**

Prove:

- clicking the current 青石镇 node enters town locally and makes zero `/actions` requests;
- returning from the NPC building to town, then map, is local UI navigation;
- clicking `前往镇外破庙` makes one deterministic `/actions` request;
- the returned view is already ready/idle and no `GenerationStatusModal` appears;
- actual map travel may auto-enter the destination scene after the location changes.

- [ ] **Step 3: Run component tests and verify they fail**

Run: `npx vitest run src/components/AdventureGameShell.test.tsx src/components/LocationSceneScreen.test.tsx src/components/sharedUiContract.test.tsx`

Expected: FAIL because handoff currently calls `submitDialogueInteraction`.

- [ ] **Step 4: Separate acknowledgement from executable choices in the read model**

```ts
export type NpcDialogueView = {
  readonly npcId: string;
  readonly name: string;
  readonly role: string;
  readonly speechPages: readonly string[];
  readonly choices: readonly PlayerChoiceView[];
  /** Local-only handoff line; never minted as an ApprovedChoice, never in registry. */
  readonly handoffAcknowledgement?: { readonly label: string };
  readonly freeInputEnabled: boolean;
  readonly giveChoices: readonly {
    readonly itemName: string;
    readonly choice: PlayerChoiceView;
  }[];
};
```

Delete the server-minted `handoffChoice` token path: `projectGameSessionView` must not map `handoffAcknowledgement` through `ApprovedChoice`/`choiceRegistry`/`buildChoiceMap`; it projects the domain `NarrativeSceneState.handoffAcknowledgement` string directly. Never project an acknowledgement into `narrative.choices`, `currentObjectiveChoiceToken`, `currentObjectiveChoiceTokens`, or `choiceRegistry`. The map retains the actual objective travel token for deterministic `move`.

- [ ] **Step 5: Remove handoff submission/waiting behavior**

In `LocationSceneScreen`, replace `handoffChoice/onHandoffChoice` with `handoffAcknowledgement/onAcknowledge`. The handler calls only `resetDialogue()`. Only formal `dialogue.choices`, give-item choices, and free text call `submitDialogueInteraction` and set `dialoguePhase="waiting"`.

- [ ] **Step 6: Keep auto-navigation scoped to actual location changes**

Retain the AdventureGameShell location-change effect for real map travel. Add a regression proving local acknowledgement cannot alter `view.currentLocation`, so it cannot trigger the effect.

- [ ] **Step 7: Run component tests**

Run: `npm run test:components`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/game/application/gameSessionView.ts src/game/application/gameSessionView.test.ts src/components
git commit -m "fix(ui): make NPC handoff acknowledgement local"
```

---

### Task 9: Simplify Pending Observation and Manual Retry

**Files:**
- Modify: `src/components/CurrentGameScreen.tsx`
- Modify: `src/components/CurrentGameScreen.test.tsx`
- Modify: `src/components/gameActionRequest.ts`
- Modify: `src/components/gameActionRequest.test.ts`
- Modify: `src/game/application/server/ai/_shared/ensureCoordinator.ts`
- Modify: `src/game/application/server/ai/_shared/ensureCoordinator.test.ts`
- Modify: `src/game/application/retryNarrativeGeneration.ts`
- Modify: `src/game/application/retryNarrativeGeneration.test.ts`

**Interfaces:**
- Consumes: provider-only pending job invariant.
- Produces: one recovery ensure per observed job, GET-only polling, explicit same-job manual retry.

- [ ] **Step 1: Write failing polling tests**

With fake timers and one pending `jobId`, assert:

```ts
expect(ensureNarrative).toHaveBeenCalledTimes(1);
expect(fetchCurrentGame.mock.calls.length).toBeGreaterThan(1);
```

After the job becomes ready, polling stops. When another distinct job ID becomes pending, ensure is called once for that new ID. A failed job triggers no ordinary ensure; clicking retry calls `retryNarrative()` once.

- [ ] **Step 2: Run polling tests and verify they fail**

Run: `npx vitest run src/components/CurrentGameScreen.test.tsx src/components/gameActionRequest.test.ts`

Expected: FAIL because every 750 ms cycle currently POSTs ensure and GETs current.

- [ ] **Step 3: Expose opaque pending job identity in the read model**

Add `narrativeGeneration.jobKey: string | null` only for pending/failed observation, derived as the opaque `PendingNarrativeJob.jobId` string (UUID-like, already opaque) — do not hash or concatenate `actionSummary`/`utterance`/`selectedDialogue`/retry diagnostics. When `status==="idle"` the field is `null` or omitted. Add a unit test proving the projected value equals `job.jobId` and contains no `utterance` or `actionSummary` substring.

- [ ] **Step 4: Change the client polling loop**

On first observation of a new `jobKey`, call `ensureNarrative()` once. Thereafter poll only `GET /api/game/current` with the existing bounded backoff. Manual retry remains `POST { retry:true }`, then resumes observation for the same job.

- [ ] **Step 5: Reinforce same-job retry invariants**

`retryNarrativeGeneration` must preserve `jobId`, `actionId`, `turnNumber`, rule result, `generationKind`, and `sceneRequestKind`; only status and retry origin change. Reject a non-provider job even if malformed persisted state reaches the function.

- [ ] **Step 6: Run polling/retry tests**

Run: `npx vitest run src/components/CurrentGameScreen.test.tsx src/components/gameActionRequest.test.ts src/game/application/retryNarrativeGeneration.test.ts src/game/application/server/ai/_shared/ensureCoordinator.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/CurrentGameScreen.tsx src/components/CurrentGameScreen.test.tsx src/components/gameActionRequest.ts src/components/gameActionRequest.test.ts src/game/application/retryNarrativeGeneration.ts src/game/application/retryNarrativeGeneration.test.ts src/game/application/server/ai/_shared
git commit -m "refactor(narrative): simplify pending observation and retry"
```

---

### Task 10: Add the Authoritative Provider Trigger Journey

**Files:**
- Create: `src/game/application/testing/providerTriggerMatrix.test.ts`
- Modify: `src/game/application/testing/linearMovePrefetchRegression.test.ts`
- Modify: `src/game/application/testing/investigationFlowJourney.test.ts`
- Modify: `src/game/application/testing/foundationJourney.test.ts`
- Modify: `src/game/application/testing/mediumActJourney.test.ts`
- Modify: `src/game/application/testing/foundationJourney.testutil.ts`

**Interfaces:**
- Consumes: all previous tasks.
- Produces: a journey-level proof whose counts come from real spies, not a hand-written expected trace object.

- [ ] **Step 1: Write the reported Sun Erniang journey before adapting fixtures**

The journey must execute:

1. opening generation;
2. first NPC fixed choice;
3. second NPC fixed choice that produces the handoff + temple continuation;
4. local acknowledgement (assert revision unchanged);
5. return from building → town → map (local navigation, no `/actions` calls);
6. enter current 青石镇 locally (no provider calls, no modal);
7. click target temple travel (one deterministic `/actions` CAS, zero provider calls, revision `+1`);
8. open the old beggar’s already-ready two-choice/free-text dialogue (assert `choiceRegistry` length 2, `preparedContinuation` consumed);
9. backtrack to 青石镇 and revisit temple (deterministic `move` rule-only, no provider).

Capture actual counters and revision:

```ts
type ProviderTriggerTrace = {
  readonly providerTotals: {
    readonly openingCalls: number;
    readonly intentCalls: number;
    readonly worldCalls: number;
    readonly sceneCalls: number;
  };
  readonly sceneCallsAfterSecondNpcChoice: number;
  readonly sceneCallsAfterAcknowledgement: number;
  readonly sceneCallsAfterTempleTravel: number;
  readonly sceneCallsAfterBacktrackAndRevisit: number;
  readonly revisionAfterSecondNpcChoice: number;
  readonly revisionAfterAcknowledgement: number;
  readonly revisionAfterTempleTravel: number;
  readonly revisionAfterBacktrack: number;
};

expect(trace.providerTotals).toEqual({
  openingCalls: 1,
  intentCalls: 0,
  worldCalls: 1, // exact fixture value, changed only by NPC branch jobs
  sceneCalls: 3, // opening scene + two NPC responses
});
expect(trace.sceneCallsAfterAcknowledgement).toBe(trace.sceneCallsAfterSecondNpcChoice);
expect(trace.sceneCallsAfterTempleTravel).toBe(trace.sceneCallsAfterSecondNpcChoice);
expect(trace.sceneCallsAfterBacktrackAndRevisit).toBe(trace.sceneCallsAfterSecondNpcChoice);
expect(trace.revisionAfterAcknowledgement).toBe(trace.revisionAfterSecondNpcChoice); // local ack is zero writes
expect(trace.revisionAfterTempleTravel).toBe(trace.revisionAfterAcknowledgement + 1); // one CAS
expect(trace.revisionAfterBacktrack).toBe(trace.revisionAfterTempleTravel + 1); // rule-only backtrack CAS
```

Define `trace` with explicit `providerTotals` and the eight named snapshot fields used above; do not compare an object with extra snapshot fields using whole-object `toEqual`. Assert `NarrativeRuntimeState.status==="ready"` after every prepared/rule step (no `provider_pending|provider_failed` created).

- [ ] **Step 2: Run the new journey and verify it fails**

Run: `npx vitest run src/game/application/testing/providerTriggerMatrix.test.ts`

Expected: FAIL on handoff submission, move live generation, and/or missing prepared arrival scene.

- [ ] **Step 3: Repair the existing false-positive move regression**

Delete the hand-written:

```ts
const trace = { queueHit: true, sceneCalls: 0 };
```

Assert directly against `fake.calls()` and `worldSource.calls()`. The expected increment for objective move and focused NPC arrival is zero.

- [ ] **Step 4: Cover free text and content repair separately**

Add a free-text journey proving one allowed intent call and one NPC scene job. Add a malformed first scene response proving exactly one content repair call, while the subsequent local handoff/travel still causes no calls. Keep manual retry in a separate failed-job test so it cannot be confused with a fresh gameplay trigger.

- [ ] **Step 5: Update all offline journeys to prepared consumption**

Fixture sources must emit the full `preparedContinuations` contract. Remove direct calls to `generatePendingScene` after move/investigate/battle actions; those actions must return a `ready` view immediately from the one action CAS.

- [ ] **Step 6: Run all journey tests**

Run: `npm run test:foundation-journey && npm run journey:foundation && npx vitest run src/game/application/testing`

Expected: PASS, including medium story completion and divergent endings with provider counters unchanged during linear actions.

- [ ] **Step 7: Commit**

```bash
git add src/game/application/testing
git commit -m "test(narrative): prove the provider trigger state machine"
```

---

### Task 11: Update Canonical Documentation and Remove Superseded Complexity

**Files:**
- Modify: `docs/游戏设计原则.md`
- Modify: `docs/策划文档/AI生成RPG_MVP.md`
- Modify: `docs/Agent文档索引.md`
- Modify: `docs/agent/NPC对话驱动叙事场景触发.md`
- Modify: `docs/agent/地图与地点冒险.md`
- Modify: `docs/agent/运行时AI导演与场景表演.md`
- Modify: `docs/agent/探索与任务推进.md`
- Modify: `docs/agent/战斗与结局.md`
- Modify: `docs/agent/当前开发阶段.md` and `docs/agent/current-phase.json` only when this Plan becomes the active implementation phase.

**Interfaces:**
- Consumes: final implementation facts and test evidence.
- Produces: one canonical description of trigger policy, prepared state, retries, and UI behavior.

- [ ] **Step 1: Update design rules with the exact trigger whitelist**

Document that “API generation” means provider invocation, not the deterministic `/actions` transport. State that local acknowledgement/navigation may use no game API at all, while a map rule action may use `/actions` but provider permission remains forbidden.

- [ ] **Step 2: Replace all `linearNarrativeQueue` and battle-prewarm documentation**

Document `PreparedContinuationState`, complete next-decision coverage, atomic consumption, source=`rule`, missing-continuation failure, v6 save reset, and the removal of provider battle prewarm.

- [ ] **Step 3: Document retry ownership and core ownership**

Use one table:

| Mechanism | Owner | Repeats rule turn? | May change job ID? |
| --- | --- | --- | ---: |
| transport | `RpgAiClient` only | no | no |
| opening candidate regeneration | `createGame` via `src/game/core/retry` (`maxAttempts=3`) | no | n/a (job not created yet) |
| content repair | intent/scene/world role owner via `src/game/core/json` + `src/game/core/retry` (`maxAttempts=2`) | no | no |
| manual failed job | ensure/retry use case | no | no |

Add a one-line `src/game/core/` entry in `docs/Agent文档索引.md` or `docs/agent/当前开发阶段.md`: `core/json` (fence normalizer) + `core/retry` (attempt budget) — first core modules, RPG-agnostic, facades `src/game/core/<system>/index.ts`.

- [ ] **Step 4: Scan for superseded production symbols**

Run:

```bash
rg -n "NarrativeGenerationState|narrative\.generation|linearNarrativeQueue|LinearActionNarrative|LinearActionNpcLine|queueEntryIssueForCurrentScene|shouldCompleteSceneInAction|battleScenePrewarm|dialogueFollowups|NarrativeTriggerContext|PlayerNpcChatState|contentRepairAttempt|prewarmed" src docs/agent docs/策划文档
# Also verify no stale task-local names leaked:
rg -n "shouldCompleteSceneInAction|immediateAction|isQueueEligible" src/game/application --type ts
```

Expected: no production references; historical dated Plan/Spec references may remain only when clearly marked historical and dated (e.g., `docs/superpowers/plans/2026-08-*.md`).

- [ ] **Step 4b: Verify core facades are documented and pinned**

Run: `rg -n "src/game/core|core/json|core/retry" docs/agent docs/游戏开发规范.md src/dependencyBoundaries.test.ts`

Expected: `docs/游戏开发规范.md` §1.1 core准入 acknowledged, `docs/agent/当前开发阶段.md` mentions `core/json` + `core/retry` as the first core modules, and `dependencyBoundaries.test.ts` contains `json`/`retry` in the core guard.

- [ ] **Step 5: Run documentation and boundary checks**

Run: `npm run check:standards && npm run test:boundaries && git diff --check`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add docs/游戏设计原则.md docs/策划文档/AI生成RPG_MVP.md docs/Agent文档索引.md docs/agent/NPC对话驱动叙事场景触发.md docs/agent/地图与地点冒险.md docs/agent/运行时AI导演与场景表演.md docs/agent/探索与任务推进.md docs/agent/战斗与结局.md docs/agent/当前开发阶段.md docs/agent/current-phase.json
git commit -m "docs(narrative): define prepared continuation architecture"
```

---

### Task 12: Full Verification and Real Browser Acceptance

**Files:**
- Test evidence only; modify production/tests only if a failing acceptance exposes a root issue.

**Interfaces:**
- Consumes: completed Tasks 1–11.
- Produces: automated and real-browser evidence that all reported problems and architecture invariants are fixed.

- [ ] **Step 1: Run focused gates**

Run:

```bash
npm run test:game-domain
npm run test:game-gameplay
npm run test:game-application
npm run test:components
npm run test:app
```

Expected: PASS.

- [ ] **Step 2: Run repository gates**

Run:

```bash
npm run check:standards
npm run typecheck
npm run lint
npm run test:boundaries
npm run test:fast
npm test
npm run test:foundation-journey
npm run journey:foundation
npm run build
npm run phase:status
```

Expected: PASS.

- [ ] **Step 3: Start the development server in the implementation worktree**

Run: `npm run dev`

Use the normal `.env.local` AI configuration. Do not modify or read secrets into logs. Clear the old v5 current save through the development UI/API, then create a fresh v6 game through visible controls.

- [ ] **Step 4: Reproduce the exact browser journey with AI audit enabled**

Through visible browser controls only:

1. complete two formal choices with the opening NPC;
2. wait for the old NPC’s generated final line and local acknowledgement;
3. click the acknowledgement and confirm the dialog closes immediately with no waiting text/modal;
4. confirm the player remains in the old location/building;
5. return to town and map manually;
6. click the current old-location icon and confirm it enters locally with no generation modal;
7. click the new target location and confirm immediate prepared arrival;
8. open the new NPC and confirm two generated fixed choices plus free input are already present;
9. backtrack and revisit once.

- [ ] **Step 5: Query audit evidence**

Use `npm run ai-text-audit` or the existing log query CLI. Verify:

- no `ai_call` between second NPC response completion and the next formal NPC choice/free text;
- acknowledgement has no `/api/game/actions` exchange;
- target map travel has one `/api/game/actions` exchange but no `ai_call`;
- backtrack/revisit has no `ai_call`;
- all observed retries have the correct `origin/mechanism/attempt` and reuse the same job ID.

- [ ] **Step 6: Record final evidence and inspect the diff**

Run: `git status --short && git diff --stat && git diff --check`.

Confirm no foundation files, junctions, secrets, SQLite saves, logs, or AI audit artifacts are staged.

- [ ] **Step 7: Gate acceptance failures instead of patching ad hoc**

If acceptance exposes a failure, stop this task and append a new numbered TDD remediation task to this Plan with the exact failing assertion, production/test paths, focused command, and commit command; execute that task before rerunning Task 12. If acceptance passes without changes, record the commands and audit assertions in the implementation handoff and make no empty commit.

## Final Acceptance Checklist

- [ ] New game and formal NPC fixed/free-text input are the only fresh provider-generation triggers.
- [ ] Manual retry reuses the same persisted provider job and never repeats a rule turn.
- [ ] The final NPC single button is local-only and never displays “waiting for NPC”.
- [ ] Closing the final NPC dialogue does not change location or screen.
- [ ] The player manually returns to map and explicitly chooses the target location.
- [ ] Target travel consumes a complete prepared arrival scene with zero provider calls.
- [ ] Arrival NPC already has two generated fixed choices and free input.
- [ ] Clicking the current map node, entering buildings, opening NPC cards, backtracking, and revisiting never invoke providers.
- [ ] Investigation approaches, items, battle start/round/resolution, act handoffs, and endings have prepared or rule-owned presentation and never invoke providers outside an allowed job.
- [ ] No non-provider action creates `provider_pending|provider_failed`; it remains in `ready`.
- [ ] Prepared action rule result + scene + token mint + continuation consumption is one CAS/revision increment.
- [ ] Missing/invalid prepared content performs zero writes and never calls AI.
- [ ] Scene content repair has one owner, at most two attempts, and never mixes fields across attempts.
- [ ] Transport/content/manual retry audit semantics remain distinct.
- [ ] StoryState v5 is explicitly unsupported; fresh v6 saves load and replay.
- [ ] All focused, journey, boundary, full, build, and real-browser gates pass.
