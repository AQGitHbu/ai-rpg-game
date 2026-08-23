# AI Trigger Boundary and Prepared Continuation Architecture Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make new-game creation and formal NPC fixed/free-text responses the only production AI-generation triggers, while every handoff, navigation, investigation, item, and battle transition consumes already approved content or deterministic rule presentation without another provider call.

**Architecture:** Replace the narration-only `linearNarrativeQueue` with a server-only `PreparedContinuationState` that stores complete, approved scene seeds through the next formal NPC decision boundary. Add an explicit execution policy before state commit, make linear actions consume prepared content in the same CAS as their rule result, separate local dialogue acknowledgement/navigation from gameplay actions, and centralize structured-output/content-repair ownership. Keep `@ai-game/ai-transport` unchanged: transport remains responsible only for HTTP/timeout/cancellation/error contracts; RPG prompts, schema, retry policy, and continuation semantics remain in this repository.

**Tech Stack:** TypeScript 5.8, Next.js 16, React 19, Vitest 3, SQLite/libSQL, existing `@ai-game/ai-transport`, RPG application/gameplay/domain facades.

**Spec:** `docs/游戏设计原则.md` (“无需玩家决策时立即后台生成”), `docs/策划文档/AI生成RPG_MVP.md`, `docs/agent/NPC对话驱动叙事场景触发.md`, `docs/agent/地图与地点冒险.md`, `docs/agent/运行时AI导演与场景表演.md`; the target state machine and invariants below are normative for this remediation.

## Global Constraints

- Production provider calls are allowed only for `opening` and a formal NPC branch (`npc_fixed_choice` or `npc_free_text`). Explicit retry may rerun the same persisted provider job, but must not create a new gameplay turn.
- A fixed-choice token may still use `POST /api/game/actions` for a deterministic rule action, but that request must not invoke scene/world/intent providers unless the submitted interaction is a formal NPC branch.
- The final single button under the old NPC is a local acknowledgement. It closes the dialogue only; it has no `choiceToken`, creates no action ID, changes no revision/turn/location, and shows no “waiting for NPC” state.
- A formal NPC response generates and approves all deterministic continuation presentations through the next formal NPC two-choice/free-text boundary, including travel narration, investigation variants, arrival NPC opening lines, arrival NPC choice labels/actions, battle-resolution presentation, and any deferred approved world transition required before that boundary.
- Linear action consumption is atomic: rule effects, optional deferred world transition, prepared-scene materialization, choice-token minting, continuation consumption, and revision increment occur in one repository CAS.
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
5. `POST /api/game/narrative/ensure` may schedule only a persisted provider-allowed job. Ordinary polling never changes `failed` to `pending`.

## Target File Structure

### New files

- `src/game/domain/preparedContinuation.ts` — persistent server-side continuation/scene-seed contract; no provider or application imports.
- `src/game/application/narrativeExecutionPolicy.ts` — pure whitelist decision for provider/prepared/rule-only execution.
- `src/game/application/preparedContinuationCandidates.ts` — builds authoritative future candidate IDs/actions for move/investigation/arrival/battle steps.
- `src/game/application/approvePreparedContinuation.ts` — validates AI-prepared steps and rebuilds persistent domain state.
- `src/game/application/consumePreparedContinuation.ts` — matches a resolved action, reapplies any approved deferred world proposal, mints scene tokens, and returns the next states for one CAS.
- `src/game/application/ruleOwnedScene.ts` — deterministic location/item/navigation presentation; contains no generated dialogue.
- `src/game/application/server/ai/structuredJsonResponse.ts` — shared JSON/fenced-JSON normalization only.
- `src/game/application/server/ai/structuredContentAttempts.ts` — role-neutral attempt budget and retry metadata; no prompt or RPG state.
- `src/game/application/server/providerTriggerBoundary.test.ts` — static architecture guard for orchestrator-level provider entry points.
- `src/game/application/testing/providerTriggerMatrix.test.ts` — authoritative provider-call count journey.

### Files to split or substantially modify

- `src/game/domain/pendingNarrativeJob.ts` — add explicit `generationKind` and immutable `sceneRequestKind`.
- `src/game/domain/narrative.ts` — replace nested generation flags with the discriminated runtime state, add `handoffAcknowledgement`, add `source="rule"`, replace `linearNarrativeQueue`, remove unused legacy follow-up/trigger/chat types.
- `src/game/domain/storyState.ts` — schema v6.
- `src/game/application/sceneGenerationContext.ts` — project explicit generation kind and future prepared-step descriptors; stop inferring handoff from mutable global state.
- `src/game/application/sceneSource.ts` — one atomic proposal contract with `handoffAcknowledgement` and `preparedContinuations`.
- `src/game/application/server/ai/narrativeContext/sceneNarrativeContext.ts` — render the new single output contract.
- `src/game/application/server/ai/liveScenePerformanceSource.ts` — one provider attempt + parse only; no recursive content repair.
- `src/game/application/approveAndWriteScene.ts` — approve only current scene; delegate continuation approval.
- `src/game/application/generatePendingScene.ts` — provider-job orchestration only; delete immediate-action/queue/battle branches.
- `src/game/application/performTurn.ts` — dispatch provider, prepared, or rule-owned path before commit.
- `src/game/application/server/compositionRoot.ts` — remove synchronous immediate generation and battle prewarm; enforce provider whitelist.
- `src/game/application/gameSessionView.ts` — project local handoff acknowledgement separately from executable choices.
- `src/components/LocationSceneScreen.tsx` — local close for handoff; formal choices alone enter waiting state.
- `src/components/AdventureGameShell.tsx` / `WorldMapScreen.tsx` — retain local navigation; map travel stays deterministic and never opens an AI-generation modal.
- `src/components/CurrentGameScreen.tsx` / `gameActionRequest.ts` — one recovery ensure, GET-only observation polling, explicit manual retry.
- Delete `src/game/application/server/battleScenePrewarm.ts` and its tests after prepared battle coverage exists.

---

### Task 1: Lock the Provider Trigger Whitelist

**Files:**
- Create: `src/game/application/narrativeExecutionPolicy.ts`
- Create: `src/game/application/narrativeExecutionPolicy.test.ts`
- Modify: `src/game/domain/pendingNarrativeJob.ts`
- Modify: `src/game/domain/pendingNarrativeJob.test.ts`

**Interfaces:**
- Produces: `ProviderGenerationKind`, `NarrativeExecutionKind`, `NarrativeExecutionDecision`, `decideNarrativeExecution(input)`, `providerAllowedFor(kind)`.
- Consumes: existing `Action`, `Interaction`, `ObjectiveTransition`, and resolved post-turn battle state.

- [ ] **Step 1: Write the failing trigger-matrix unit test**

```ts
import { describe, expect, it } from "vitest";
import {
  decideNarrativeExecution,
  providerAllowedFor,
  type NarrativeExecutionInput,
} from "./narrativeExecutionPolicy";

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
});
```

- [ ] **Step 2: Run the policy test and verify it fails**

Run: `npx vitest run src/game/application/narrativeExecutionPolicy.test.ts`

Expected: FAIL because `narrativeExecutionPolicy.ts` and the exported types do not exist.

- [ ] **Step 3: Implement the explicit decision type and whitelist**

```ts
export type ProviderGenerationKind = "opening" | "npc_fixed_choice" | "npc_free_text";
export type NarrativeExecutionKind = ProviderGenerationKind | "prepared_action" | "rule_only";
export type NarrativeSceneRequestKind = "opening" | "npc_response" | "npc_handoff";

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
  return kind === "opening" || kind === "npc_fixed_choice" || kind === "npc_free_text";
}

export function decideNarrativeExecution(input: NarrativeExecutionInput): NarrativeExecutionDecision {
  if (input.action.type === "talk") {
    return {
      kind: "provider",
      generationKind: input.interactionKind === "free_text" ? "npc_free_text" : "npc_fixed_choice",
      sceneRequestKind: input.dialogueWillComplete ? "npc_handoff" : "npc_response",
    };
  }
  if (input.hasPreparedStep || input.battleWillResolve) return { kind: "prepared" };
  return { kind: "rule_only" };
}
```

- [ ] **Step 4: Add `generationKind` to pending jobs and reject non-whitelisted construction**

Update `createPendingNarrativeJob` so its input requires both trigger authorization and immutable output mode:

```ts
readonly generationKind: ProviderGenerationKind;
readonly sceneRequestKind: NarrativeSceneRequestKind;
```

Persist both on `PendingNarrativeJob`; add tests proving `{ generationKind: "prepared_action" }` cannot be constructed through the typed factory, runtime parsing rejects unknown strings, and retry preserves both values. Opening uses `sceneRequestKind="opening"`; a formal NPC rule transition fixes `npc_response` or `npc_handoff` before the job is committed.

- [ ] **Step 5: Run focused domain/application tests**

Run: `npx vitest run src/game/application/narrativeExecutionPolicy.test.ts src/game/domain/pendingNarrativeJob.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/game/application/narrativeExecutionPolicy.ts src/game/application/narrativeExecutionPolicy.test.ts src/game/domain/pendingNarrativeJob.ts src/game/domain/pendingNarrativeJob.test.ts
git commit -m "refactor(narrative): define provider trigger whitelist"
```

---

### Task 2: Introduce StoryState v6 Prepared Continuations

**Files:**
- Create: `src/game/domain/preparedContinuation.ts`
- Create: `src/game/domain/preparedContinuation.test.ts`
- Modify: `src/game/domain/narrative.ts`
- Modify: `src/game/domain/storyState.ts`
- Modify: `src/game/domain/storyState.test.ts`
- Modify: `src/game/application/server/persistence/sqliteGameRepository.ts`
- Modify: `src/game/application/server/persistence/sqliteGameRepository.test.ts`

**Interfaces:**
- Produces: `PreparedContinuationState`, `PreparedContinuationStepState`, `PreparedContinuationTrigger`, `PreparedSceneSeedState`, `PreparedChoiceSeedState`, `ApprovedDeferredWorldTransitionState`.
- Consumes: `Action`, `NarrativeEventState`, `NarrativeNpcLineState`, `WorldDeltaProposal`, and `EvolutionNeed` domain types. Domain persistence types must not import `sceneSource.ts` or any other application module.

- [ ] **Step 1: Write failing domain tests for a complete move-to-NPC prepared step**

```ts
const prepared: PreparedContinuationState = {
  originJobId: asNarrativeJobId("job_dialogue_2"),
  steps: [{
    stepId: "prepared:quest_2:move:loc_temple",
    objectiveKey: "quest_2:0",
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
  }],
};

expect(prepared.steps[0]!.scene.choiceSeeds).toHaveLength(2);
expect("choiceToken" in prepared.steps[0]!.scene.choiceSeeds[0]!).toBe(false);
```

Also test distinct triggers for `investigate` with `approachId` and `battle_resolved` with `enemyId`.

- [ ] **Step 2: Run the domain test and verify it fails**

Run: `npx vitest run src/game/domain/preparedContinuation.test.ts`

Expected: FAIL because the prepared-continuation types do not exist.

- [ ] **Step 3: Add the domain contract**

```ts
export type PreparedContinuationTrigger =
  | { readonly kind: "move"; readonly locationId: LocationId }
  | { readonly kind: "investigate"; readonly factId: FactId; readonly approachId?: string }
  | { readonly kind: "battle_started"; readonly enemyId: EnemyId }
  | { readonly kind: "battle_resolved"; readonly enemyId: EnemyId };

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

export type ApprovedDeferredWorldTransitionState = {
  readonly need: Exclude<EvolutionNeed, { readonly kind: "none" } | { readonly kind: "pacing" }>;
  /** Persist only after approveWorldDelta accepted it; re-approve before consumption. */
  readonly approvedProposal: WorldDeltaProposal;
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
  readonly trigger: PreparedContinuationTrigger;
  readonly scene: PreparedSceneSeedState;
  readonly deferredWorldTransition?: ApprovedDeferredWorldTransitionState;
};

export type PreparedContinuationState = {
  readonly originJobId: NarrativeJobId;
  readonly steps: readonly PreparedContinuationStepState[];
};
```

- [ ] **Step 4: Replace legacy narrative fields with the discriminated runtime state**

Implement the `ready | provider_pending | provider_failed` `NarrativeRuntimeState` union defined in the Target State Machine. Delete the nested `NarrativeGenerationState` and `linearNarrativeQueue`. `preparedContinuation` and `choiceRegistry` exist only on `ready`; `job` exists only on provider states; `failure` exists only on `provider_failed`. Add compile-time fixtures using `satisfies NarrativeRuntimeState` plus runtime parser tests for each valid variant and for rejected mixed-field records.

In `NarrativeSceneState`, add:

```ts
readonly handoffAcknowledgement?: string;
readonly source: "generated" | "rule" | "fixture";
```

Rename the current ambiguous `fallback` source to `fixture` in explicit offline/test sources and persisted scenes. Production source factories must never inject a fixture source; rule-owned scenes use `rule`.

Delete unused production types/fields proven by `rg` to have no consumer: `NarrativeDialogueFollowupState`, `NarrativeTriggerContext`, `PlayerNpcChatState`, `dialogueFollowups`, and `nextEventHint`. Update/delete their type-only tests.

- [ ] **Step 5: Bump StoryState to v6 and make v5 explicitly unsupported**

```ts
export const STORY_STATE_SCHEMA_VERSION = 6 as const;

if (version === 2 || version === 3 || version === 4 || version === 5) {
  return { ok: false, code: "UNSUPPORTED_RECORD" };
}
```

Update SQLite interpretation tests to assert a persisted v5 record is reported as `corrupt/UNSUPPORTED_RECORD` and a fresh v6 record loads normally.

- [ ] **Step 6: Run domain and persistence tests**

Run: `npx vitest run src/game/domain src/game/application/server/persistence/sqliteGameRepository.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/game/domain src/game/application/server/persistence/sqliteGameRepository.ts src/game/application/server/persistence/sqliteGameRepository.test.ts
git commit -m "refactor(narrative): add prepared continuation state"
```

---

### Task 3: Project the Full Continuation Through the Next NPC Decision

**Files:**
- Create: `src/game/application/preparedContinuationCandidates.ts`
- Create: `src/game/application/preparedContinuationCandidates.test.ts`
- Modify: `src/game/application/sceneGenerationContext.ts`
- Modify: `src/game/application/sceneGenerationContext.test.ts`
- Modify: `src/game/application/sceneChoiceCandidates.ts`

**Interfaces:**
- Produces: `PreparedStepDescriptor`, `PreparedChoiceCandidate`, `buildPreparedStepDescriptors(record, transition)`, `preparedTriggerKey(trigger)`.
- Consumes: Task 2 prepared types and the post-world-evolution preview record.

- [ ] **Step 1: Write failing projection tests for the Sun Erniang → temple flow**

Create a record whose new quest is:

```ts
[
  { kind: "visit_location", locationId: locTemple, completed: false },
  { kind: "talk_to_npc", npcId: npcBeggar, completed: false },
]
```

Assert `buildPreparedStepDescriptors` returns one move descriptor containing:

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

Run: `npx vitest run src/game/application/preparedContinuationCandidates.test.ts`

Expected: FAIL because the descriptor builder does not exist.

- [ ] **Step 3: Implement deterministic descriptor projection**

The traversal starts at `ObjectiveTransition.after`, walks released deterministic objectives, and stops immediately after it has prepared the next `talk_to_npc` scene with two choices. It may include `discover_fact`, `visit_location`, `defeat_enemy`, and their approach/battle variants; it must not choose a future NPC branch.

```ts
export type PreparedStepDescriptor = {
  readonly stepId: string;
  readonly objectiveKey: string;
  readonly trigger: PreparedContinuationTrigger;
  readonly authority: PreparedStepAuthorityContext;
  readonly arrivalNpc?: UpcomingArrivalNpcContext;
  readonly choiceCandidates: readonly PreparedChoiceCandidate[];
};
```

Generate candidate IDs from descriptor order, never from entity names or AI text.

- [ ] **Step 4: Put descriptors into `SceneGenerationContext`**

Replace `upcomingLinearObjectives` and `dialogueSessionCompleted` with:

```ts
readonly generationKind: ProviderGenerationKind;
readonly finalDialogueHandoff: boolean;
readonly preparedStepDescriptors: readonly PreparedStepDescriptor[];
```

Project `finalDialogueHandoff` directly from `job.sceneRequestKind === "npc_handoff"`; do not reconstruct it from the later mutable `dialogueSession.completed` flag. Keep `ObjectiveTransition.after` correction for newly materialized entities, but do not use it to change `generationKind` or `sceneRequestKind`.

- [ ] **Step 5: Prove projection stops at the next decision boundary**

Add a quest chain `visit → investigate(two approaches) → move → talk NPC → move` and assert descriptors include all variants through the talk scene but exclude the final move after that NPC choice.

- [ ] **Step 6: Run focused tests**

Run: `npx vitest run src/game/application/preparedContinuationCandidates.test.ts src/game/application/sceneGenerationContext.test.ts src/game/application/sceneChoiceCandidates.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/game/application/preparedContinuationCandidates.ts src/game/application/preparedContinuationCandidates.test.ts src/game/application/sceneGenerationContext.ts src/game/application/sceneGenerationContext.test.ts src/game/application/sceneChoiceCandidates.ts
git commit -m "feat(narrative): project continuation to next NPC decision"
```

---

### Task 4: Replace the Scene Output Contract with Atomic Prepared Steps

**Files:**
- Modify: `src/game/application/sceneSource.ts`
- Create: `src/game/application/approvePreparedContinuation.ts`
- Create: `src/game/application/approvePreparedContinuation.test.ts`
- Modify: `src/game/application/approveAndWriteScene.ts`
- Modify: `src/game/application/approveAndWriteScene.test.ts`
- Modify: `src/game/application/server/ai/narrativeContext/sceneNarrativeContext.ts`
- Modify: `src/game/application/server/ai/narrativeContext/sceneNarrativeContext.test.ts`
- Modify: `src/game/application/server/ai/liveScenePerformanceSource.ts`
- Modify: `src/game/application/server/ai/liveScenePerformanceSource.test.ts`

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
    trigger: { kind: "move", locationId: "loc_temple" },
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

Assert the parser rejects: a handoff with one executable current choice; a prepared arrival step with fewer/more than two choices; an unknown trigger; a future candidate ID not present in the descriptor; a missing approach variant; and an invented entity ID.

- [ ] **Step 2: Run focused parser tests and verify they fail**

Run: `npx vitest run src/game/application/server/ai/liveScenePerformanceSource.test.ts src/game/application/approvePreparedContinuation.test.ts`

Expected: FAIL on the old `linearActionNarratives` contract.

- [ ] **Step 3: Replace proposal types**

```ts
export type PreparedContinuationProposal = {
  readonly stepId: string;
  readonly trigger: PreparedContinuationTriggerProposal;
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

Delete `LinearActionNarrative`, `LinearActionNpcLine`, and `contentRepairAttempt` from `sceneSource.ts`. `fixture` is accepted only from explicit offline/test composition; live adapters always return `generated`.

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
export type ApprovePreparedContinuationResult =
  | { readonly ok: true; readonly prepared: PreparedContinuationState }
  | { readonly ok: false; readonly code: PreparedContinuationRejection };

export function approvePreparedContinuation(input: {
  readonly originJobId: NarrativeJobId;
  readonly proposals: readonly PreparedContinuationProposal[];
  readonly descriptors: readonly PreparedStepDescriptor[];
  readonly worldState: WorldState;
}): ApprovePreparedContinuationResult;
```

Resolve each prepared candidate ID to its server-owned `Action`, normalize text, enforce fact/entity allowlists, validate objective/trigger identity, and rebuild new objects. Reject the entire prepared bundle if any required step or variant fails; do not drop one entry and keep the scene.

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
git add src/game/application/sceneSource.ts src/game/application/approvePreparedContinuation.ts src/game/application/approvePreparedContinuation.test.ts src/game/application/approveAndWriteScene.ts src/game/application/approveAndWriteScene.test.ts src/game/application/server/ai/liveScenePerformanceSource.ts src/game/application/server/ai/liveScenePerformanceSource.test.ts src/game/application/server/ai/narrativeContext
git commit -m "refactor(narrative): generate atomic prepared scene bundles"
```

---

### Task 5: Centralize Structured JSON and Content-Repair Ownership

**Files:**
- Create: `src/game/application/server/ai/structuredJsonResponse.ts`
- Create: `src/game/application/server/ai/structuredJsonResponse.test.ts`
- Create: `src/game/application/server/ai/structuredContentAttempts.ts`
- Create: `src/game/application/server/ai/structuredContentAttempts.test.ts`
- Modify: `src/game/application/server/ai/liveScenePerformanceSource.ts`
- Modify: `src/game/application/server/ai/liveWorldEvolutionSource.ts`
- Modify: `src/game/application/server/ai/openingGenerationSource.ts`
- Modify: `src/game/application/server/ai/liveIntentParserSource.ts`
- Modify: `src/game/application/generatePendingScene.ts`
- Modify: `src/game/application/evolveWorld.ts`

**Interfaces:**
- Produces: `parseStructuredJsonObject(text)`, `runStructuredContentAttempts(input)`.
- Consumes: existing `RpgAiClient`; does not change `@ai-game/ai-transport`.

- [ ] **Step 1: Write failing normalization tests**

```ts
expect(parseStructuredJsonObject('{"ok":true}')).toEqual({ ok: true, value: { ok: true }, normalization: "none" });
expect(parseStructuredJsonObject('```json\n{"ok":true}\n```')).toEqual({ ok: true, value: { ok: true }, normalization: "json_fence" });
expect(parseStructuredJsonObject('before {"ok":true} after')).toEqual({ ok: false, reason: "invalid_json" });
expect(parseStructuredJsonObject('[]')).toEqual({ ok: false, reason: "root_not_object" });
```

- [ ] **Step 2: Write failing attempt-budget tests**

Prove:

- transport retry stays inside one `RpgAiClient.complete` call;
- content parsing/approval gets at most two content attempts;
- attempt 2 receives the stable failure reason;
- a provider transport failure does not trigger content repair except `empty_response`, which becomes one changed-prompt content attempt;
- manual retry origin remains `manual_failed_job` across both content attempts.

- [ ] **Step 3: Run the new tests and verify they fail**

Run: `npx vitest run src/game/application/server/ai/structuredJsonResponse.test.ts src/game/application/server/ai/structuredContentAttempts.test.ts`

Expected: FAIL because the helpers do not exist.

- [ ] **Step 4: Implement shared normalization and attempt control**

```ts
export async function runStructuredContentAttempts<T>(input: {
  readonly maxAttempts: 2;
  readonly runAttempt: (attempt: 1 | 2, priorReason?: string) => Promise<
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly repairable: boolean; readonly reason: string }
  >;
}): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string }> {
  const first = await input.runAttempt(1);
  if (first.ok || !first.repairable) return first;
  return input.runAttempt(2, first.reason);
}
```

The helper controls count only. Role use cases still decide which failures are repairable and build their own repair prompt.

- [ ] **Step 5: Remove duplicated fenced-JSON parsers**

Replace each local `parseJsonResponse` in opening/intent/scene/world with `parseStructuredJsonObject`. Record `normalization="json_fence"` as a warning/metric so tolerated provider non-compliance is observable rather than silently considered strict compliance.

- [ ] **Step 6: Make live sources single-attempt adapters**

`createLiveScenePerformanceSource.generateScene(context)` performs one `RpgAiClient.complete`, one normalize/parse, and returns a typed parse reason. Delete recursive `generateSceneInner` content retry.

`generatePendingScene` owns the scene two-attempt loop and runs parse + current-scene approval + prepared-continuation approval inside each attempt. `evolveWorld` uses the same count helper around proposal parse + approval. Never retain fields from a rejected attempt.

- [ ] **Step 7: Run AI source/retry tests**

Run: `npx vitest run src/game/application/server/ai src/game/application/generatePendingScene.test.ts src/game/application/evolveWorld.test.ts`

Expected: PASS; maximum content attempts remain exactly two.

- [ ] **Step 8: Commit**

```bash
git add src/game/application/server/ai src/game/application/generatePendingScene.ts src/game/application/generatePendingScene.test.ts src/game/application/evolveWorld.ts src/game/application/evolveWorld.test.ts
git commit -m "refactor(ai): centralize structured content attempts"
```

---

### Task 6: Consume Prepared Actions Atomically in `performTurn`

**Files:**
- Create: `src/game/application/consumePreparedContinuation.ts`
- Create: `src/game/application/consumePreparedContinuation.test.ts`
- Create: `src/game/application/ruleOwnedScene.ts`
- Create: `src/game/application/ruleOwnedScene.test.ts`
- Modify: `src/game/application/performTurn.ts`
- Modify: `src/game/application/performTurn.test.ts`
- Modify: `src/game/application/stateCommit.ts`
- Modify: `src/game/application/server/persistence/gameRepository.ts`

**Interfaces:**
- Produces: `consumePreparedContinuation(input)`, `buildRuleOwnedScene(input)`.
- Consumes: Tasks 1–4 execution policy and prepared state.

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
```

Assert one repository `applyState` call, revision `+1`, and zero `applySceneWriteBack` calls.

- [ ] **Step 2: Add missing/stale/variant failure tests**

Cover:

- objective move with no matching prepared step → `NARRATIVE_CONTINUATION_MISSING`, zero write;
- matching entity but wrong investigation `approachId` → missing, zero write;
- deferred world proposal fails re-approval against current state → `NARRATIVE_CONTINUATION_INVALID`, zero write;
- replaying a consumed step → missing, zero write;
- non-objective backtrack → rule-owned scene, one write, no prepared requirement.

- [ ] **Step 3: Run the tests and verify they fail**

Run: `npx vitest run src/game/application/consumePreparedContinuation.test.ts src/game/application/performTurn.test.ts`

Expected: FAIL because all successful actions still create pending jobs.

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

Match by a canonical `preparedTriggerKey`, re-approve/materialize `deferredWorldTransition` when present, build the current scene, call `createApprovedChoice` for each seed using `postCommitRevision`, remove all alternative steps sharing the consumed `objectiveKey`, and return new states without IO.

- [ ] **Step 5: Add rule-owned non-AI presentation**

`buildRuleOwnedScene` may use only structured rule/location/item/battle facts. It must never create NPC dialogue or generated branch labels. Mark its source `rule`.

- [ ] **Step 6: Dispatch by policy before commit**

Refactor `performTurn` after `resolveTurn`:

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

- [ ] **Step 7: Run application tests**

Run: `npx vitest run src/game/application/consumePreparedContinuation.test.ts src/game/application/ruleOwnedScene.test.ts src/game/application/performTurn.test.ts src/game/application/stateCommit.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/game/application/consumePreparedContinuation.ts src/game/application/consumePreparedContinuation.test.ts src/game/application/ruleOwnedScene.ts src/game/application/ruleOwnedScene.test.ts src/game/application/performTurn.ts src/game/application/performTurn.test.ts src/game/application/stateCommit.ts src/game/application/server/persistence/gameRepository.ts
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

Delete `shouldCompleteSceneInAction` and the `await generatePendingScene` branch for move/investigate/take-item. After a successful non-provider turn, project the already committed ready/rule scene and return immediately.

- [ ] **Step 6: Remove unknown-action world-AI repair**

An unknown entity/action is a rejected or stale client action, not a reason to generate the world. Return the existing stable action error with zero write/provider call. World evolution occurs only while an allowed provider job prepares its continuation.

- [ ] **Step 7: Replace battle prewarm with prepared battle steps**

Delete prewarm caches/promises/source calls. Before committing a rule result that starts or resolves a battle, require/match the appropriate prepared trigger. Active rounds remain rule-only. If the final hit lacks `battle_resolved`, return `NARRATIVE_CONTINUATION_MISSING` before writing the resolved battle.

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
  // existing fields
  readonly choices: readonly PlayerChoiceView[];
  readonly handoffAcknowledgement?: { readonly label: string };
};
```

Never project an acknowledgement into `narrative.choices`, `currentObjectiveChoiceToken`, or `choiceRegistry`. The map retains the actual objective travel token.

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

Add `narrativeGeneration.jobKey` only for pending/failed observation. It must be an opaque hash/ID safe for the browser and contain no action summary, utterance, or retry diagnostics.

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
4. local acknowledgement;
5. return from building → town → map;
6. enter current 青石镇 locally;
7. click target temple travel;
8. open the old beggar’s already-ready two-choice/free-text dialogue;
9. backtrack to 青石镇 and revisit temple.

Capture actual counters:

```ts
expect(trace).toEqual({
  openingCalls: 1,
  intentCalls: 0,
  worldCalls: 1, // exact fixture value, changed only by NPC branch jobs
  sceneCalls: 3, // opening scene + two NPC responses
});
expect(trace.sceneCallsAfterAcknowledgement).toBe(trace.sceneCallsAfterSecondNpcChoice);
expect(trace.sceneCallsAfterTempleTravel).toBe(trace.sceneCallsAfterSecondNpcChoice);
expect(trace.sceneCallsAfterBacktrackAndRevisit).toBe(trace.sceneCallsAfterSecondNpcChoice);
```

Use names appropriate to the deterministic fixture, but preserve the exact interaction categories and zero-increment assertions.

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

- [ ] **Step 3: Document retry ownership**

Use one table:

| Mechanism | Owner | Repeats rule turn? | May change job ID? |
| --- | --- | ---: | ---: |
| transport | `RpgAiClient` | no | no |
| content repair | opening/scene/world role use case | no | no |
| manual failed job | ensure/retry use case | no | no |

- [ ] **Step 4: Scan for superseded production symbols**

Run:

```bash
rg -n "linearNarrativeQueue|LinearActionNarrative|queueEntryIssueForCurrentScene|shouldCompleteSceneInAction|battleScenePrewarm|dialogueFollowups|NarrativeTriggerContext|PlayerNpcChatState" src docs/agent docs/策划文档
```

Expected: no production references; historical dated Plan/Spec references may remain only when clearly marked historical.

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

- [ ] **Step 7: Commit any acceptance-only test/doc corrections**

If acceptance required no code changes, skip this commit. Otherwise inspect `git diff --name-only`, list every acceptance correction explicitly in the execution notes, stage those exact paths one by one, and commit:

```bash
git commit -m "test(narrative): close prepared continuation acceptance gaps"
```

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
