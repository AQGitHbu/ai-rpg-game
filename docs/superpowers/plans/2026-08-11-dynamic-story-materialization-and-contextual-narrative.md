# Dynamic Story Materialization and Contextual Narrative Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the up-front fixed-world generation model with a bounded, dynamically materialized RPG loop that restores the town layer and makes every generated scene directly respond to the player, NPC relationship/memory, resolved rule outcomes, and the authoritative current objective.

**Architecture:** New-game generation creates only a story contract plus the opening slice: world premise, player, prologue, starting town/location, first NPC, first active objective, budget, and two abstract ending directions. After each successful rule turn, an optional world-evolution proposal materializes only the entities needed by the next beat; the server mints IDs, validates budgets/references/reachability, then gives the approved state to one scene-performance call. The scene-performance call receives typed outcome beats, one focus NPC's isolated memory/policy, and the before/after objective transition; AI remains proposal-only and the narrative write-back atomically persists approved world evolution, ready scene, choice registry, and candidate events.

**Tech Stack:** TypeScript, Next.js App Router, React, Vitest, SQLite/libSQL, `@ai-game/ai-transport` public API, deterministic seed-derived fallback generation.

## Global Constraints

- Execute on a `codex/` feature branch in `.worktrees/`; do not use `git checkout` in the main workspace.
- Modify only `ai-rpg-game`. Reuse `@ai-game/ai-transport@0.1.0` through its public export; do not modify `ai-game-foundation`, shared packages, `.foundation`, or synchronized `docs/共同规范/` files.
- Preserve the six canonical routes exactly: create, current, actions, narrative ensure, prologue ack, and development clear. Town generation in this plan is deterministic application/gameplay work and does not add a town ensure endpoint.
- Rules own action legality, entity IDs, budgets, objectives, relationship changes, fact disclosure, inventory, battle, and endings. AI can only propose world evolution and scene performance.
- A successful player action still performs exactly one `applyState` CAS. The pending narrative job is completed by one independent narrative write-back CAS that may contain an approved world delta plus the scene.
- Fixed choices and free text continue through `/api/game/actions` and `performTurn`; the browser never receives `actionKey`, effects, hidden facts, or internal proposal references.
- Opening generation must materialize exactly one starting location, one focus NPC, one active main quest, and only items/facts needed by that opening objective. It must not name or persist future NPCs, future locations, future quest entities, future enemies, or concrete endings.
- Quantity alone is not a sufficient generation constraint. Preserve type boundaries, hard/soft budgets, target acts, causal objective closure, location reachability, two disjoint ending directions, and deterministic fallback/replay.
- `personalityTags` and `contentIntensity` affect presentation policy only. They must not silently change combat math, success probability, rewards, or action legality.
- The scene performer receives only one focus NPC's memory. Private fact text is never sent when disclosure is not rule-approved; only private fact IDs and a withholding instruction may be sent.
- Player free text is transient for the current pending job. Long-term NPC memory stores a normalized dialogue act, structured topic reference, bounded summary, relationship result, and learned fact IDs, not the raw utterance.
- Live and fallback paths pass the same parsers, validators, approval functions, and write-back contract.
- Do not cherry-pick `ca3a9e42` or restore its deleted legacy runtime wholesale. Port only the pure town generator/visual ideas from `ca3a9e42^` and adapt them to current `WorldState`, `StoryState`, `GameSessionView`, and canonical APIs.

---

## Target File Structure

### Domain

- Create `src/game/domain/worldEntity.ts`: branded entity IDs, generation metadata, entity enums, stats, and presentation metadata currently mixed into `scenarioBlueprint.ts`.
- Create `src/game/domain/storyContract.ts`: bounded story contract and abstract ending directions with no future entity IDs.
- Create `src/game/domain/openingGenerationCandidate.ts`: AI/fallback opening-slice candidate and parser.
- Create `src/game/domain/worldDelta.ts`: proposal-local references, approved world delta, evolution need, and materialization counters.
- Create `src/game/domain/narrativeBeat.ts`: mandatory outcome beats, objective transition, and approved scene-performance types.
- Create `src/game/domain/townState.ts`: stable town layout slots and NPC-to-building bindings.
- Modify `src/game/domain/worldState.ts`, `storyState.ts`, `pendingNarrativeJob.ts`, `events.ts`, `narrative.ts`, `newGame.ts`.
- Delete `src/game/domain/worldGenerationCandidate.ts` and `src/game/domain/scenarioBlueprint.ts` after all imports move to the new focused domain modules.

### Gameplay

- Replace `src/game/gameplay/rpg/worldGeneration/` with opening-slice parsing/validation/compilation under `src/game/gameplay/rpg/openingGeneration/`.
- Create `src/game/gameplay/rpg/worldEvolution/`: trigger, approval, deterministic ID minting, materialization, quest/ending closure, and facade.
- Create `src/game/gameplay/rpg/narrativeContext/`: outcome-beat derivation, objective-transition derivation, and NPC response policy.
- Restore and adapt `src/game/gameplay/rpg/town/` as a pure deterministic generator consuming `TownRuntimeState`; it must not import application, provider, persistence, or legacy `GameState`/`ScenarioBlueprint`.
- Modify current rule engine quest progression so an act completes into `needs_next_act` or `needs_ending_pair`, rather than unlocking pre-generated quest IDs.

### Application and server AI

- Modify `src/game/application/createGame.ts`, `performTurn.ts`, `sceneGenerationContext.ts`, `sceneSource.ts`, `generatePendingScene.ts`, `approveAndWriteScene.ts`, `gameSessionView.ts`.
- Create `src/game/application/worldEvolutionSource.ts` and `src/game/application/focusNpcContext.ts`.
- Create `src/game/application/townView.ts`.
- Split `src/game/application/server/ai/sourceFactory.ts` into neutral factories plus `openingGenerationSource.ts`, `liveWorldEvolutionSource.ts`, and `liveScenePerformanceSource.ts`.
- Modify `src/game/application/server/persistence/gameRepository.ts` and `sqliteGameRepository.ts` so narrative write-back can atomically persist the approved next `WorldState` and `StoryState` with the ready scene.

### UI

- Create `src/components/TownLayerScreen.tsx` and restore adapted `src/components/town/TownMapSvg.tsx`.
- Modify `AdventureGameShell.tsx`, `WorldMapScreen.tsx`, `LocationSceneScreen.tsx`, `AdventureHud.tsx`, `CurrentGameScreen.tsx`, `NewGameSetupForm.tsx`, and `globals.css`.

---

### Task 1: Remove the executable blueprint model and define the dynamic story contract

**Files:**
- Create: `src/game/domain/worldEntity.ts`
- Create: `src/game/domain/storyContract.ts`
- Create: `src/game/domain/worldDelta.ts`
- Modify: `src/game/domain/worldState.ts`
- Modify: `src/game/domain/storyState.ts`
- Modify: `src/game/domain/events.ts`
- Modify: all production/test imports currently resolving IDs or entity enums from `src/game/domain/scenarioBlueprint.ts`
- Delete: `src/game/domain/scenarioBlueprint.ts`
- Delete: `src/game/domain/scenarioBlueprint.test.ts`
- Test: `src/game/domain/storyContract.test.ts`
- Test: `src/game/domain/worldDelta.test.ts`
- Test: `src/dependencyBoundaries.test.ts`

**Interfaces:**
- Produces `StoryContract`, `StoryEvolutionState`, `EvolutionNeed`, `WorldDeltaProposal`, and `ApprovedWorldDelta` for all later tasks.
- `worldEntity.ts` preserves the current branded ID helper names so the import migration is mechanical and behavior-neutral.

```ts
export type EndingDirectionKey = "trust" | "doubt";

export type StoryContract = {
  readonly version: 1;
  readonly targetActs: 3 | 5;
  readonly centralConflict: string;
  readonly endingDirections: readonly [
    { readonly key: "trust"; readonly theme: string },
    { readonly key: "doubt"; readonly theme: string },
  ];
};

export type StoryEvolutionState = {
  readonly nextLocationOrdinal: number;
  readonly nextNpcOrdinal: number;
  readonly nextItemOrdinal: number;
  readonly nextEnemyOrdinal: number;
  readonly nextFactOrdinal: number;
  readonly status: "stable" | "needs_next_act" | "needs_ending_pair";
};

export type EvolutionNeed =
  | { readonly kind: "none" }
  | { readonly kind: "next_act"; readonly act: number }
  | { readonly kind: "pacing"; readonly pacingNeed: "complicate" | "escalate" }
  | { readonly kind: "ending_pair"; readonly finalAct: number };
```

- [ ] **Step 1: Write failing domain tests for a contract with no future entity IDs**

```ts
it("stores only abstract ending directions and act count", () => {
  const contract = createStoryContract({
    gameLength: "short",
    centralConflict: "旧案背后的盟约正在瓦解",
    endingThemes: { trust: "共同承担真相", doubt: "独自揭露真相" },
  });
  expect(contract.targetActs).toBe(3);
  expect(JSON.stringify(contract)).not.toMatch(/npc_|loc_|item_|enemy_|quest_/);
});
```

- [ ] **Step 2: Run the tests and verify the missing contract fails**

Run: `npm run test:game-domain -- src/game/domain/storyContract.test.ts src/game/domain/worldDelta.test.ts`

Expected: FAIL because `storyContract.ts` and `worldDelta.ts` do not exist.

- [ ] **Step 3: Move stable entity language and implement the contract**

Move branded IDs, `GenerationMetadata`, `FactSource`, `LocationScale`, `LocationKind`, `StatBlock`, `EnemyTier`, and item display enums from `scenarioBlueprint.ts` into `worldEntity.ts`. Add `contract` and `evolution` to `StoryState`; do not add a second world aggregate.

```ts
export type StoryState = {
  // existing fields remain
  readonly contract: StoryContract;
  readonly evolution: StoryEvolutionState;
};
```

- [ ] **Step 4: Migrate imports and delete dead blueprint types**

Run before deletion: `rg -n 'ScenarioBlueprint|ScenarioBlueprintCandidate|SceneDefinition|EndingDirection|PrologueDefinition' src`

Expected before deletion: only `scenarioBlueprint.ts`, its test, and comments. Replace every `@/game/domain/scenarioBlueprint` import with `@/game/domain/worldEntity`, delete the obsolete aggregate types/file/test, then rerun the scan.

Expected after deletion: zero production/test references.

- [ ] **Step 5: Verify domain and boundary tests**

Run: `npm run test:game-domain && npm run test:boundaries && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```text
git add src/game/domain src/game src/dependencyBoundaries.test.ts
git commit -m "refactor(story): replace blueprint aggregate with story contract"
```

---

### Task 2: Generate and compile only the opening slice

**Files:**
- Create: `src/game/domain/openingGenerationCandidate.ts`
- Create: `src/game/gameplay/rpg/openingGeneration/index.ts`
- Create: `src/game/gameplay/rpg/openingGeneration/validateOpeningGenerationCandidate.ts`
- Create: `src/game/gameplay/rpg/openingGeneration/compileOpeningGenerationCandidate.ts`
- Test: same-name adjacent test files
- Modify: `src/game/application/createGame.ts`
- Modify: `src/game/application/server/ai/worldGenerationSource.ts` and rename it to `openingGenerationSource.ts`
- Modify: `src/game/application/server/ai/sourceFactory.ts`
- Delete: `src/game/domain/worldGenerationCandidate.ts`
- Delete: `src/game/gameplay/rpg/worldGeneration/`
- Test: `src/game/application/createGame.test.ts`
- Test: `src/game/application/server/ai/openingGenerationSource.test.ts`

**Interfaces:**
- Consumes `StoryContract` from Task 1 and validated `GameSetup`.
- Produces exactly one materialized starting location/NPC/quest and a generated prologue.

```ts
export type OpeningGenerationCandidate = {
  readonly world: {
    readonly summary: string;
    readonly tone: string;
    readonly themes: readonly string[];
    readonly publicFacts: readonly { readonly key: string; readonly text: string }[];
  };
  readonly player: {
    readonly name: string;
    readonly identity: string;
    readonly backgroundSummary: string;
    readonly baseStats: StatBlock;
  };
  readonly prologue: string;
  readonly storyContract: StoryContract;
  readonly opening: {
    readonly location: { readonly name: string; readonly description: string; readonly scale: "town" };
    readonly npc: {
      readonly name: string;
      readonly role: string;
      readonly description: string;
      readonly knownFactKeys: readonly string[];
      readonly privateFactKeys: readonly string[];
      readonly goals: readonly string[];
    };
    readonly quest: {
      readonly name: string;
      readonly description: string;
      readonly objective: { readonly kind: "talk_to_opening_npc" };
    };
  };
};
```

- [ ] **Step 1: Write failing parser, validator, compiler, and application tests**

The compiler test must assert exactly one location, one NPC, one active main quest, no enemies, no concrete endings, and no locked future quests.

```ts
expect(worldState.locations).toHaveLength(1);
expect(worldState.npcs).toHaveLength(1);
expect(worldState.quests).toHaveLength(1);
expect(worldState.quests[0]?.status).toBe("active");
expect(worldState.enemies).toEqual([]);
expect(worldState.endings).toEqual([]);
expect(storyState.contract.endingDirections.map((x) => x.key)).toEqual(["trust", "doubt"]);
```

- [ ] **Step 2: Run focused tests and verify the old full-world generator violates them**

Run: `npm run test:game-gameplay -- src/game/gameplay/rpg/openingGeneration && npm run test:game-application -- src/game/application/createGame.test.ts`

Expected: FAIL because the current source/compiler materializes 3–5 locations, 3–6 NPCs, all quests, enemies, items, and endings.

- [ ] **Step 3: Implement the opening parser/validator/compiler**

The compiler mints only `loc_0`, `npc_0`, `quest_0`, and fact IDs required by the opening. The first quest outcome becomes `{ kind: "advance_story" }`; it does not reference a pre-generated next quest.

```ts
export type QuestOutcome =
  | { readonly kind: "advance_story" }
  | { readonly kind: "resolve_story" }
  | { readonly kind: "closed" };
```

- [ ] **Step 4: Replace the live opening prompt and fallback**

The prompt must include `personalityTags`, `narrativeStyle`, and `contentIntensity`, and explicitly prohibit future named entities. Its JSON schema contains only the interface above. The deterministic fallback uses the player setup and seed but also returns only the opening slice.

- [ ] **Step 5: Remove the old full-world source and compiler**

Run: `rg -n 'WorldGenerationCandidate|compileWorldGenerationCandidate|validateWorldGenerationCandidate' src`

Expected after deletion/migration: zero matches.

- [ ] **Step 6: Verify and commit**

Run: `npm run test:game-domain && npm run test:game-gameplay && npm run test:game-application -- src/game/application/createGame.test.ts && npm run typecheck`

```text
git add src/game/domain src/game/gameplay/rpg src/game/application
git commit -m "feat(opening): materialize only the first playable story slice"
```

---

### Task 3: Materialize new NPCs, locations, items, enemies, quests, and endings during play

**Files:**
- Create: `src/game/gameplay/rpg/worldEvolution/index.ts`
- Create: `src/game/gameplay/rpg/worldEvolution/deriveEvolutionNeed.ts`
- Create: `src/game/gameplay/rpg/worldEvolution/approveWorldDelta.ts`
- Create: `src/game/gameplay/rpg/worldEvolution/materializeWorldDelta.ts`
- Create: adjacent tests
- Create: `src/game/application/worldEvolutionSource.ts`
- Create: `src/game/application/deterministicWorldEvolutionSource.ts`
- Create: `src/game/application/server/ai/liveWorldEvolutionSource.ts`
- Create: adjacent source tests
- Modify: `src/game/application/performTurn.ts`
- Modify: `src/game/application/generatePendingScene.ts`
- Modify: `src/game/application/server/ai/sourceFactory.ts`
- Modify: `src/game/application/server/persistence/gameRepository.ts`
- Modify: `src/game/application/server/persistence/sqliteGameRepository.ts`
- Test: repository, `performTurn`, and `generatePendingScene` tests

**Interfaces:**
- Consumes `EvolutionNeed`, current approved state, story budget, genre constraints, and current objective.
- Produces an `ApprovedWorldDelta` with server-minted IDs and a preview state used to build legal scene choices.

```ts
export type WorldDeltaProposal = {
  readonly beatSummary: string;
  readonly newLocation: null | {
    readonly name: string;
    readonly description: string;
    readonly scale: "scene" | "town";
    readonly connectFromLocationId: string;
  };
  readonly newNpc: null | {
    readonly name: string;
    readonly role: string;
    readonly description: string;
    readonly locationRef: { readonly kind: "existing"; readonly id: string } | { readonly kind: "new_location" };
    readonly goals: readonly string[];
  };
  readonly newItem: null | { readonly name: string; readonly description: string; readonly locationRef: "current" | "new_location" };
  readonly newEnemy: null | { readonly name: string; readonly tier: "normal" | "boss"; readonly locationRef: "current" | "new_location" };
  readonly newFact: null | { readonly text: string; readonly visibility: "public" | "npc_private" };
  readonly nextMainQuest: null | DynamicQuestProposal;
  readonly endingPair: null | readonly [DynamicEndingProposal, DynamicEndingProposal];
};
```

- [ ] **Step 1: Write failing trigger and approval tests**

Cover `needs_next_act`, low-tension pacing, final ending materialization, soft/hard budget rejection, unknown location references, duplicate names, and climax closure. Assert normal conversation returns `EvolutionNeed.none` and does not call the evolution source.

- [ ] **Step 2: Write failing atomic write-back tests**

```ts
expect(saved.worldState.npcs).toContainEqual(expect.objectContaining({ name: "新出现的信使" }));
expect(saved.storyState.narrative.currentScene).not.toBeNull();
expect(saved.revision).toBe(before.revision + 1);
expect(repository.applySceneWriteBack).toHaveBeenCalledTimes(1);
```

The write-back must reject stale revision without partially persisting the new NPC or scene.

- [ ] **Step 3: Implement deterministic trigger, ID minting, approval, and materialization**

Mint IDs from persisted ordinals (`npc_dyn_1`, `loc_dyn_1`, and so on), never AI-provided IDs. Approval enforces remaining budgets, genre constraints, current/fresh location references, one main quest for the requested act, reachable objective entities, and exactly two disjoint ending directions at the final act.

- [ ] **Step 4: Implement optional live and deterministic evolution sources**

Call the source only when `EvolutionNeed.kind !== "none"`. The live source outputs proposal-local references; invalid/timeout output falls back to the deterministic source, which always materializes a completable next act.

- [ ] **Step 5: Expand narrative write-back without adding a route or extra rule CAS**

```ts
export type ApplySceneWriteBackInput = {
  readonly gameId: GameId;
  readonly expectedRevision: number;
  readonly nextWorldState: WorldState;
  readonly nextStoryState: StoryState;
};
```

`generatePendingScene` approves/materializes the delta into a preview record, builds scene context from that preview, approves the performance, then invokes this method once.

- [ ] **Step 6: Verify and commit**

Run: `npm run test:game-gameplay -- src/game/gameplay/rpg/worldEvolution && npm run test:game-application -- src/game/application/generatePendingScene.test.ts src/game/application/performTurn.test.ts src/game/application/server/persistence && npm run typecheck`

```text
git add src/game/gameplay/rpg/worldEvolution src/game/application src/game/domain
git commit -m "feat(world): materialize bounded story entities at runtime"
```

---

### Task 4: Convert rule results and quest changes into mandatory narrative beats

**Files:**
- Create: `src/game/domain/narrativeBeat.ts`
- Create: `src/game/gameplay/rpg/narrativeContext/index.ts`
- Create: `src/game/gameplay/rpg/narrativeContext/buildOutcomeBeats.ts`
- Create: `src/game/gameplay/rpg/narrativeContext/deriveObjectiveTransition.ts`
- Create: adjacent tests
- Modify: `src/game/domain/pendingNarrativeJob.ts`
- Modify: `src/game/application/performTurn.ts`
- Modify: `src/game/application/sceneGenerationContext.ts`
- Modify: `src/game/application/gameSessionView.ts`
- Test: `performTurn`, `sceneGenerationContext`, and view tests

**Interfaces:**

```ts
export type ObjectiveRef = {
  readonly questId: QuestId;
  readonly objectiveIndex: number;
  readonly label: string;
};

export type ObjectiveTransition = {
  readonly before: ObjectiveRef | null;
  readonly completed: readonly ObjectiveRef[];
  readonly after: ObjectiveRef | null;
  readonly mode: "unchanged" | "progressed" | "advanced_act" | "ready_for_ending";
};

export type MandatoryNarrativeBeat = {
  readonly beatId: string;
  readonly kind: "player_utterance" | "item_obtained" | "fact_discovered" | "quest_progress" | "quest_advanced" | "battle_started" | "battle_round" | "battle_resolved" | "entity_introduced";
  readonly subjectIds: readonly string[];
  readonly instruction: string;
};
```

- [ ] **Step 1: Write failing beat tests for item, quest, and battle outcomes**

```ts
expect(buildOutcomeBeats(itemResolution, before, after)).toContainEqual(expect.objectContaining({
  kind: "item_obtained",
  subjectIds: ["item_seal"],
  instruction: expect.stringContaining("盟誓印谱"),
}));
```

Add parallel assertions for quest completion/unlock, battle start, damage/HP, victory/withdrawal, and ending readiness.

- [ ] **Step 2: Write failing objective-transition tests**

Assert a completed talk objective records both the old objective and the newly materialized next objective; unchanged turns retain the authoritative current objective; the HUD and scene context project the same `after.label`.

- [ ] **Step 3: Implement pure beat/transition derivation**

Derive beats from `ResolvedEvent` plus before/after `WorldState`/`StoryState`. Do not ask AI to infer state changes from event prose or ledger strings.

- [ ] **Step 4: Persist the transition in the pending job**

`performTurn` computes `ObjectiveTransition` before committing and attaches it with mandatory beats to the job. The job remains bounded; entity descriptions come from the current state and the number of beats is capped at eight.

- [ ] **Step 5: Verify and commit**

Run: `npm run test:game-domain -- src/game/domain/pendingNarrativeJob.test.ts src/game/domain/narrativeBeat.test.ts && npm run test:game-gameplay -- src/game/gameplay/rpg/narrativeContext && npm run test:game-application -- src/game/application/performTurn.test.ts src/game/application/sceneGenerationContext.test.ts src/game/application/gameSessionView.test.ts`

```text
git add src/game/domain src/game/gameplay/rpg/narrativeContext src/game/application
git commit -m "feat(narrative): carry exact outcomes and objectives into every scene"
```

---

### Task 5: Make NPC replies consume the player's utterance, relationship, and isolated memory

**Files:**
- Create: `src/game/application/focusNpcContext.ts`
- Create: `src/game/gameplay/rpg/narrativeContext/npcResponsePolicy.ts`
- Create: adjacent tests
- Modify: `src/game/gameplay/rpg/intentParser/intentParserSource.ts`
- Modify: `src/game/application/server/ai/liveIntentParserSource.ts`
- Modify: `src/game/gameplay/rpg/dialogue/dialogueResolution.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/updateNpcMemory.ts`
- Modify: `src/game/application/sceneGenerationContext.ts`
- Modify: `src/game/application/deterministicSceneSource.ts`
- Modify: `src/game/application/server/ai/sourceFactory.ts`
- Test: intent, dialogue, context, deterministic scene, and live source tests

**Interfaces:**

```ts
export type StructuredDialogueTopic =
  | { readonly kind: "fact"; readonly factId: FactId }
  | { readonly kind: "quest"; readonly questId: QuestId }
  | { readonly kind: "thread"; readonly threadId: ThreadId }
  | { readonly kind: "general" };

export type NpcResponsePolicy = {
  readonly tier: "hostile" | "cold" | "neutral" | "friendly" | "trusted";
  readonly toneInstruction: string;
  readonly initiative: "refuse" | "guarded" | "reactive" | "helpful" | "proactive";
  readonly allowedDisclosureFactIds: readonly FactId[];
  readonly privateKnowledgeIds: readonly FactId[];
};

export type FocusNpcContext = {
  readonly id: NpcId;
  readonly name: string;
  readonly role: string;
  readonly publicProfile: string;
  readonly responsePolicy: NpcResponsePolicy;
  readonly speakableFactCards: readonly FactCard[];
  readonly recentInteractions: readonly {
    readonly actionId: string;
    readonly dialogueAct: DialogueAct | "freeform";
    readonly topicSummary: string;
    readonly outcome: NpcInteraction["outcome"];
    readonly summary: string;
  }[];
  readonly goals: readonly string[];
  readonly emotion: NarrativeEmotion;
};
```

- [ ] **Step 1: Write failing relationship-policy tests**

Assert exact policy mapping: hostile is terse/refusing, cold is guarded, neutral is factual/reactive, friendly is warm/helpful, trusted is candid/proactive. The deterministic fallback must produce observably different lines for hostile and trusted tiers for the same action.

- [ ] **Step 2: Write failing focus-memory isolation tests**

Build two NPCs with different secret facts and histories. Assert the focus context contains only the selected NPC's last five structured interactions, never the other NPC's entries, never raw prior utterances, and never private fact text that was not disclosed.

- [ ] **Step 3: Extend free-text intent parsing with structured topic references**

The live parser may select only from server-supplied fact/quest/thread IDs. Invalid topic IDs fall back to `general`. Persist `dialogueAct + StructuredDialogueTopic + bounded summary`; keep the exact current utterance only in `PendingNarrativeJob.utterance`.

- [ ] **Step 4: Require a direct-response beat**

When `job.utterance` exists and the action targets the focus NPC, add a mandatory `player_utterance` beat. The scene performance contract must return an NPC line for that NPC and list the beat ID it answers. A missing answer makes the generated proposal invalid and triggers the deterministic fallback.

- [ ] **Step 5: Feed relationship delta and post-turn policy, not a bare number**

The context carries the post-turn tier/emotion plus this turn's `relationshipDelta` and outcome. Fact disclosure remains rule-owned; the model receives only `allowedDisclosureFactIds` and withholding instructions.

- [ ] **Step 6: Verify and commit**

Run: `npm run test:game-gameplay -- src/game/gameplay/rpg/intentParser src/game/gameplay/rpg/dialogue src/game/gameplay/rpg/narrativeContext && npm run test:game-application -- src/game/application/focusNpcContext.test.ts src/game/application/sceneGenerationContext.test.ts src/game/application/deterministicSceneSource.test.ts src/game/application/server/ai/liveIntentParserSource.test.ts src/game/application/server/ai/liveSceneSource.test.ts`

```text
git add src/game/gameplay/rpg src/game/application src/game/domain
git commit -m "feat(npc): answer player speech with relationship-aware isolated memory"
```

---

### Task 6: Replace the generic scene prompt with an approved scene-performance contract

**Files:**
- Modify: `src/game/application/sceneSource.ts`
- Modify: `src/game/application/approveAndWriteScene.ts`
- Modify: `src/game/application/generatePendingScene.ts`
- Modify: `src/game/application/deterministicSceneSource.ts`
- Create: `src/game/application/server/ai/liveScenePerformanceSource.ts`
- Modify: `src/game/application/server/ai/sourceFactory.ts`
- Test: `approveAndWriteScene`, `generatePendingScene`, deterministic source, and live performance source tests

**Interfaces:**

```ts
export type ScenePerformanceProposal = {
  readonly sceneId: string;
  readonly segments: readonly {
    readonly beatId: string;
    readonly text: string;
  }[];
  readonly npcLine: null | {
    readonly npcId: string;
    readonly text: string;
    readonly emotion: NarrativeEmotion;
    readonly answeredBeatIds: readonly string[];
    readonly usedFactIds: readonly string[];
    readonly usedInteractionActionIds: readonly string[];
  };
  readonly objectiveLink: null | {
    readonly questId: string;
    readonly objectiveIndex: number;
    readonly mode: "hint" | "progress" | "handoff";
  };
  readonly choices: readonly [
    { readonly candidateId: string; readonly label: string },
    { readonly candidateId: string; readonly label: string },
  ];
  readonly source: "generated" | "fallback";
};
```

- [ ] **Step 1: Write failing approval coverage tests**

Reject proposals that omit a mandatory beat, invent a beat ID, answer player speech with the wrong NPC, use a private/unknown fact, cite another NPC's interaction, link a stale objective, choose duplicate candidate IDs, or omit all objective-progress-capable choices.

- [ ] **Step 2: Implement segmented narration approval**

Require one segment per mandatory beat and join approved segments in beat order. Optional atmospheric text is accepted only as a segment with the server-provided `atmosphere` beat ID. If any required segment is absent, run the deterministic source and approve it through the same function.

- [ ] **Step 3: Build a complete live prompt from safe sections**

The prompt sections are: style policy, current player utterance, exact resolved outcome beats, objective transition, current location, recent story beats, story pacing/budget, approved introduced entities, focus NPC context, legal candidate IDs, and output schema. Do not serialize the complete record, event ledger, all NPC contexts, or private fact text.

- [ ] **Step 4: Enforce objective coherence**

When `ObjectiveTransition.after` exists, require `objectiveLink` to match it and require at least one selected legal action to advance, approach, or gather information for that objective. When the objective advanced this turn, require a `quest_advanced` segment naming the new objective's relevant approved entity.

- [ ] **Step 5: Verify concrete item/battle/quest narration**

Add three source tests with stub transport responses:

1. item obtained: narration segment names the exact item and marks its beat ID;
2. battle resolved: narration states victory/withdrawal and current HP without contradicting the rule result;
3. quest advanced: narration names the next destination/NPC/item and the `objectiveLink` matches the HUD objective.

- [ ] **Step 6: Verify and commit**

Run: `npm run test:game-application -- src/game/application/approveAndWriteScene.test.ts src/game/application/generatePendingScene.test.ts src/game/application/deterministicSceneSource.test.ts src/game/application/server/ai/liveScenePerformanceSource.test.ts && npm run typecheck`

```text
git add src/game/application
git commit -m "feat(scene): render every rule outcome and objective through typed beats"
```

---

### Task 7: Restore the real map → town → scene layer on the canonical runtime

**Files:**
- Create: `src/game/domain/townState.ts`
- Create: `src/game/gameplay/rpg/town/index.ts`
- Restore/adapt pure generator files from `ca3a9e42^`: `townRandom.ts`, `terrain.ts`, `anchors.ts`, `roads.ts`, `blocks.ts`, `buildings.ts`, `validateTown.ts`, `generateTown.ts`
- Create: `src/game/gameplay/rpg/town/createTownRuntime.ts`
- Create: `src/game/gameplay/rpg/town/bindNpcToTownSlot.ts`
- Create: adjacent tests including the 1000-seed batch test
- Modify: `src/game/domain/worldState.ts`
- Modify: `src/game/gameplay/rpg/openingGeneration/compileOpeningGenerationCandidate.ts`
- Modify: `src/game/gameplay/rpg/worldEvolution/materializeWorldDelta.ts`
- Create: `src/game/application/townView.ts`
- Modify: `src/game/application/gameSessionView.ts`
- Create: `src/components/TownLayerScreen.tsx`
- Restore/adapt: `src/components/town/TownMapSvg.tsx`
- Modify: `src/components/AdventureGameShell.tsx`
- Modify: `src/components/LocationSceneScreen.tsx`
- Modify: `src/components/AdventureHud.tsx`
- Modify: `src/app/globals.css`
- Test: town gameplay, application view, and component tests

**Interfaces:**

```ts
export type TownBuildingSlot = {
  readonly slotId: string;
  readonly buildingId: string;
  readonly buildingType: "tavern" | "blacksmith" | "house" | "guild" | "clinic" | "market";
  readonly boundNpcId: NpcId | null;
};

export type TownRuntimeState = {
  readonly locationId: LocationId;
  readonly seed: string;
  readonly generatorVersion: string;
  readonly slots: readonly TownBuildingSlot[];
};
```

- [ ] **Step 1: Write failing three-layer navigation tests**

For a `scale: "town"` current location, entering from the world map must render `TownLayerScreen`; selecting a bound story building must render `LocationSceneScreen` and open/focus its NPC. Returning from scene goes to town; returning from town goes to the world map. A `scale: "scene"` location continues map → scene directly.

- [ ] **Step 2: Port only the pure generator and remove legacy dependencies**

Use `git show ca3a9e42^:<path>` as reference. The restored gameplay facade consumes `TownRuntimeState` and `worldEntity` types only. It must not import the deleted `GameState`, `ScenarioBlueprint`, old application views, old AI town sources, or add `/api/game/town/ensure`.

- [ ] **Step 3: Preallocate anonymous building slots from the town NPC budget**

Opening compilation creates stable geometry and unbound slots without generating future NPC names. The opening NPC binds slot 0. Runtime NPC materialization into that town binds the first free slot; geometry and existing building IDs remain unchanged.

- [ ] **Step 4: Add canonical read model and UI**

`GameSessionView.currentLocation.town` exposes only the snapshot, display labels, and bound interactive building entries. It does not expose seed, free slots, generator internals, hidden NPCs, or unapproved locations.

- [ ] **Step 5: Run deterministic and component gates**

Run: `npm run test:game-gameplay -- src/game/gameplay/rpg/town && npm run test:game-application -- src/game/application/townView.test.ts src/game/application/gameSessionView.test.ts && npm run test:components -- src/components/TownLayerScreen.test.tsx src/components/AdventureGameShell.test.tsx`

Expected: all tests pass; the batch test generates 1000 valid towns within its existing 60-second ceiling.

- [ ] **Step 6: Commit**

```text
git add src/game/domain/townState.ts src/game/gameplay/rpg/town src/game/application src/components src/app/globals.css
git commit -m "feat(town): restore canonical three-layer exploration"
```

---

### Task 8: Give setup preferences real presentation effects and show the generated prologue

**Files:**
- Modify: `src/components/NewGameSetupForm.tsx`
- Modify: `src/components/NewGameSetupForm.test.tsx`
- Create: `src/game/application/stylePolicy.ts`
- Create: `src/game/application/stylePolicy.test.ts`
- Modify: `src/game/application/sceneGenerationContext.ts`
- Modify: `src/game/application/server/ai/openingGenerationSource.ts`
- Modify: `src/game/application/server/ai/liveScenePerformanceSource.ts`
- Modify: `src/game/domain/storyState.ts`
- Modify: `src/game/application/gameSessionView.ts`
- Modify: `src/components/CurrentGameScreen.tsx`
- Modify: `src/components/CurrentGameScreen.test.tsx`
- Modify: `src/app/globals.css`

**Interfaces:**

```ts
export type StylePolicy = {
  readonly protagonistTraits: readonly string[];
  readonly narration: "concise" | "novel" | "cinematic";
  readonly intensity: "normal" | "dark";
  readonly narrationInstruction: string;
  readonly intensityInstruction: string;
};
```

- [ ] **Step 1: Write failing setup/UI tests**

Expose six controlled personality tags (`冷静`, `冲动`, `善良`, `多疑`, `幽默`, `寡言`) with a maximum of three and two content-intensity choices (`普通`, `黑暗`). Assert the exact selected values reach `POST /api/game`.

- [ ] **Step 2: Write failing policy tests**

Assert personality tags influence protagonist portrayal and suggested choice wording only. Assert `dark` permits morally difficult consequences and restrained darker imagery, while `normal` avoids graphic detail. Assert neither policy changes stats, rule action, rewards, or budget.

- [ ] **Step 3: Feed the policy into opening and scene performance**

Replace the current behavior where only `narrativeStyle` reaches the opening prompt. Both live prompts receive the same `StylePolicy`; fallback narration uses deterministic wording variants keyed by the policy.

- [ ] **Step 4: Show the approved generated prologue**

Persist `prologueText` in `StoryState` during opening compilation and expose it through `GameSessionView`. `CurrentGameScreen` displays it on the black screen; only generation failure falls back to the player's original `storyOpening`.

- [ ] **Step 5: Verify and commit**

Run: `npm run test:components -- src/components/NewGameSetupForm.test.tsx src/components/CurrentGameScreen.test.tsx && npm run test:game-application -- src/game/application/stylePolicy.test.ts src/game/application/sceneGenerationContext.test.ts && npm run test:app`

```text
git add src/components src/game/application src/game/domain/storyState.ts src/app/globals.css
git commit -m "feat(setup): apply player tone preferences and generated prologue"
```

---

### Task 9: Prove the dynamic MVP journey, update current docs, and run full acceptance

**Files:**
- Replace: `src/game/application/testing/foundationJourney.test.ts`
- Modify: `src/game/application/testing/foundationJourney.testutil.ts`
- Replace: `src/game/application/testing/storyDivergenceJourney.test.ts`
- Create: `src/game/application/testing/dynamicMaterializationJourney.test.ts`
- Create: `src/game/application/testing/narrativeGroundingJourney.test.ts`
- Modify: `docs/策划文档/AI生成RPG_MVP.md`
- Modify: `docs/agent/MVP核心闭环.md`
- Modify: `docs/agent/运行时AI导演与场景表演.md`
- Modify: `docs/agent/剧情连续性与结构化记忆.md`
- Modify: `docs/agent/地图与地点冒险.md`
- Modify: `docs/agent/小镇程序化生成.md`
- Modify: `docs/agent/蓝图动态化.md` and rename it to `docs/agent/世界动态具象化.md`
- Modify: `docs/Agent文档索引.md`
- Modify: `docs/agent/当前开发阶段.md`
- Modify: `docs/agent/current-phase.json`

**Interfaces:**
- Consumes all prior tasks.
- Produces replayable evidence that the product starts small, evolves entities during play, grounds every scene, restores town navigation, and remains completable offline.

- [ ] **Step 1: Write the dynamic-materialization journey**

Start with exactly one location/NPC/quest. Complete the first NPC conversation, assert the next narrative write-back materializes a new NPC and either a new location or item, and assert the next scene mentions the approved name. Continue through map → town → building scene, item acquisition, battle, and one ending in at least 15 successful turns with three repository reloads.

- [ ] **Step 2: Write the grounding journey**

Submit a distinctive current utterance, then assert the next scene has a direct NPC response beat. Repeat under hostile and trusted affinity and assert different response policies/fallback lines. Acquire an item, complete a quest, and resolve a battle; each following scene must cover every mandatory beat, and its `objectiveLink` must equal the HUD current objective.

- [ ] **Step 3: Preserve divergence and deterministic fallback proof**

Run trust and doubt branches from the same seed. Both must materialize completable content, retain isolated NPC memories, and reach different ending IDs. Repeat each offline branch and deep-compare `WorldState + StoryState`.

- [ ] **Step 4: Update implementation and player-rule documentation**

Remove claims that all NPCs/locations/items/quests are generated at opening, that the old blueprint aggregate exists, that director/writer/NPC are always three calls, or that town ensure is a production route. Document the opening slice, optional evolution call, one scene-performance call, isolated focus NPC context, typed narrative beats, and deterministic town layer.

- [ ] **Step 5: Run focused closure scans**

```text
rg -n 'ScenarioBlueprint|WorldGenerationCandidate|compileWorldGenerationCandidate|TownLayerScreen.*deleted|director、writer、npc 是三次' src docs/agent docs/策划文档
rg -n '/api/game/town|town/ensure' src
```

Expected: zero production references to the deleted blueprint/full-world contract; zero town API route; historical dated plans may retain old terms but current docs may not.

- [ ] **Step 6: Run complete acceptance**

```text
npm run check:standards
npm run typecheck
npm run lint
npm run test:boundaries
npm run test:fast
npm run test:game-domain
npm run test:game-gameplay
npm run test:game-application
npm run test:components
npm run test:app
npm test
npm run test:foundation-journey
npm run journey:foundation
npm run build
npm run phase:status
```

Expected: every command exits zero. Real AI smoke remains opt-in and is not a substitute for these deterministic gates.

- [ ] **Step 7: Commit**

```text
git add src/game/application/testing docs
git commit -m "docs(test): prove dynamic contextual RPG MVP"
```

---

## Self-Review

### Requirement coverage

- [x] Confirms and repairs the canonical removal of the real town layer without restoring the legacy runtime.
- [x] Replaces up-front named future entities with quantity/type/causality constraints plus runtime materialization.
- [x] Removes the executable blueprint aggregate and the dead blueprint type surface.
- [x] Gives `personalityTags` and `contentIntensity` concrete presentation-only effects.
- [x] Requires NPCs to answer the exact current utterance before transitioning to a new beat/person.
- [x] Maps affinity tiers and emotion to explicit response policy and deterministic fallback differences.
- [x] Sends only the focus NPC's authorized structured memory and verifies cited memory/fact IDs.
- [x] Converts item, quest, and battle results into mandatory typed narrative segments.
- [x] Carries before/completed/after objectives into the pending job and requires an approved objective link.
- [x] Keeps rule authority, opaque choices, CAS atomicity, fallback, replay, short/medium bounds, and the six-route canonical API.

### Placeholder scan

- [x] No implementation placeholder is present.
- [x] Every task names concrete files, interfaces, failure tests, commands, and a commit checkpoint.
- [x] The town history commit is reference-only; the plan forbids wholesale cherry-pick or legacy API resurrection.

### Type consistency

- [x] `StoryContract`, `StoryEvolutionState`, `EvolutionNeed`, and `ApprovedWorldDelta` are defined before later tasks consume them.
- [x] `ObjectiveTransition` and `MandatoryNarrativeBeat` are persisted in the pending job before the performance contract consumes them.
- [x] `FocusNpcContext` exposes only allowed facts and its own interaction IDs, matching scene approval checks.
- [x] The repository write-back accepts the fully approved next world/story state and remains one CAS.

### Completion rule

The plan is complete only when new games initially contain one playable story slice, later entities appear only through approved runtime materialization, the real town layer is navigable, every NPC reply and narration is grounded in current input/rules/memory/objective, both ending routes remain reachable, and every full acceptance command passes.
