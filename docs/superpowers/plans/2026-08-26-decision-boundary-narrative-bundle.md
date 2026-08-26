# Decision-Boundary Narrative Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将运行时叙事改造成“只有初始化、正式剧情二选一和当前焦点 NPC 自定义输入才能创建 AI 任务”的原子生成包架构，并删除全部生产硬编码剧情模板。

**Architecture:** 生产端以一个 `NarrativeBundleSource` 取代独立 opening/world/scene/intent provider 链；一次逻辑任务返回世界增量、当前回应、直到下一正式决策的完整服务端权威续接图，并经一次 CAS 原子写回。规则层继续裁决状态，只消费预生成文本；战斗回合完全规则化，失败恢复战前检查点，胜利消费预生成后继。

**Tech Stack:** TypeScript 5.8、Next.js 16、React 19、Vitest 3、SQLite/libSQL、现有 `@ai-game/ai-transport` 与 AI 文本审计。

**Spec:** `docs/superpowers/specs/2026-08-26-decision-boundary-narrative-bundle-design.md`

## Global Constraints

- 唯一正常 AI 触发点为新游戏初始化、正式剧情二选一、当前焦点 NPC 自定义输入；重试必须复用原逻辑任务。
- 一个决策边界只创建一个逻辑生成任务；不得再串行调用 intent、world、scene 三个独立 provider。
- NPC 卡片、移动、调查、探索、物品、建筑、战斗开始/回合/结算、GET/poll/ensure 均为零 provider 调用。
- 所有玩家可见剧情旁白、NPC 台词、动态剧情选项和剧情性反馈必须来自已审批 AI 文本。
- 生产代码不得创建 `source="rule"` 场景，不得提供 deterministic/fixture 剧情 fallback。
- AI 不得提交图边、active roots、opaque token 或任意状态 patch；规则状态与图结构始终由服务端维护。
- `MAX_NARRATIVE_BUNDLE_STEPS` 固定为 `12`；每个可达叶节点必须是下一正式决策或结局。
- 战斗回合只改变 battle state；失败/撤退恢复战前玩法检查点，胜利才消费剧情后继。数据库 revision 始终单调递增。
- 存档 schema 升到 7；v6 不做隐式 AI 修复，不删除数据库，返回明确不兼容系统状态。
- 只修改 `ai-rpg-game`；不修改 `../ai-game-foundation` 或任何共享 package。

## File Structure

### New files

- `src/game/domain/narrativeBundle.ts` — 生成包、符号引用、终点和持久化 continuation 契约。
- `src/game/application/narrativeBundleSource.ts` — 统一 provider port 与 opening/decision context union。
- `src/game/application/approveNarrativeBundle.ts` — world delta、scene、continuation、终点的原子审批 facade。
- `src/game/application/generatePendingNarrativeBundle.ts` — pending job 的单 source 调用、修复预算、CAS 与审计。
- `src/game/application/server/ai/liveNarrativeBundleSource.ts` — 唯一生产运行时叙事 provider 实现。
- `src/game/application/server/ai/narrativeContext/bundleNarrativeContext.ts` — 统一 prompt/context compiler。
- `src/game/gameplay/rpg/narrativeBundle/descriptors.ts` — 从预览状态重建服务端权威步骤和图边。
- `src/game/gameplay/rpg/narrativeBundle/coverage.ts` — 可达性、上限、终点与完整覆盖验证。
- `src/game/gameplay/rpg/narrativeBundle/index.ts` — gameplay 导出面。
- `src/game/application/performBattleRound.ts` — 活跃战斗的规则专用提交路径。

### Files removed after migration

- `src/game/application/ruleOwnedScene.ts`
- `src/game/application/ruleOwnedScene.test.ts`
- `src/game/application/generatePendingScene.ts`
- `src/game/application/generatePendingScene.test.ts`
- `src/game/application/worldEvolutionSource.ts`
- `src/game/application/server/ai/liveWorldEvolutionSource.ts`
- `src/game/application/server/ai/worldEvolutionSource.test.ts`
- `src/game/application/server/ai/intentParserSourceFactory.ts`
- `src/game/application/server/ai/intentParserSourceFactory.test.ts`
- `src/game/application/server/ai/liveIntentParserSource.ts`
- `src/game/application/server/ai/liveIntentParserSource.test.ts`
- `src/game/application/server/ai/intentParserSource.ts`
- `src/game/application/server/ai/intentParserSource.test.ts`
- `src/game/application/evolveWorld.ts`
- `src/game/application/evolveWorld.test.ts`
- `src/game/application/sceneSource.ts`
- `src/game/application/deterministicSceneSource.ts`
- `src/game/application/deterministicSceneSource.test.ts`
- `src/game/application/deterministicEvolutionSource.ts`
- `src/game/application/deterministicEvolutionSource.test.ts`
- `src/game/application/server/ai/liveScenePerformanceSource.ts`
- `src/game/application/server/ai/liveScenePerformanceSource.test.ts`
- `src/game/application/server/ai/openingGenerationSource.ts`
- `src/game/application/server/ai/openingGenerationSource.test.ts`

`evolveWorld.ts`、`sceneSource.ts`、`liveScenePerformanceSource.ts` 和 opening source 在中间任务中只作为迁移来源；Task 10 将仍需要的纯 proposal 类型移入 `narrativeBundleSource.ts`，随后删除这些旧端口和实现。

---

## Task 1: Lock the semantic provider boundary

**Files:**

- Modify: `src/game/domain/pendingNarrativeJob.ts`
- Modify: `src/game/domain/pendingNarrativeJob.test.ts`
- Modify: `src/game/gameplay/rpg/narrativeExecution/narrativeExecutionPolicy.ts`
- Modify: `src/game/gameplay/rpg/narrativeExecution/narrativeExecutionPolicy.test.ts`
- Modify: `src/game/application/server/providerTriggerBoundary.test.ts`

**Interfaces:**

- Produces: `DECISION_BOUNDARY_KINDS` and `DecisionBoundaryKind = "initialization" | "narrative_choice" | "npc_free_text"` as an additive contract.
- Produces: `classifyProviderDecisionBoundary(input): DecisionBoundaryKind | null`.
- Keeps temporarily: legacy job kind/request fields so this task remains typecheck-clean; Task 7 switches every caller and removes them atomically.

- [ ] **Step 1: Write the failing domain whitelist tests**

Add assertions equivalent to:

```ts
expect(DECISION_BOUNDARY_KINDS).toEqual([
  "initialization",
  "narrative_choice",
  "npc_free_text",
]);

expect(classifyProviderDecisionBoundary(formalFixedChoice)).toBe("narrative_choice");
expect(classifyProviderDecisionBoundary(focusedFreeText)).toBe("npc_free_text");
expect(classifyProviderDecisionBoundary(nonDialogueBoundary)).toBeNull();
```

- [ ] **Step 2: Run the domain tests and verify failure**

Run:

```bash
npx vitest run src/game/domain/pendingNarrativeJob.test.ts
```

Expected: FAIL because the semantic boundary classifier does not exist.

- [ ] **Step 3: Add a formal-decision proof classifier**

Introduce the classifier with a dedicated proof input. Do not modify the `NarrativeExecutionInput` already consumed by `decideNarrativeExecution`; it stays unchanged until Task 7 so existing call sites continue to compile.

```ts
export type DecisionBoundaryProofInput = {
  readonly action: Action;
  readonly interactionKind: "fixed_choice" | "free_text";
  readonly fixedChoiceIsCurrentFormalDecision: boolean;
  readonly focusedNpcId: NpcId | null;
};

export function classifyProviderDecisionBoundary(
  input: DecisionBoundaryProofInput,
): DecisionBoundaryKind | null;
```

Return `narrative_choice` only for `talk + fixed_choice + fixedChoiceIsCurrentFormalDecision`; return `npc_free_text` only when the target is the current focus NPC. Return `null` for every other shape.

- [ ] **Step 4: Add the negative trigger matrix**

Test that move, explore, investigate, take, give, attack, battle action, a synthetic talk token, and a talk action with no current formal-choice proof all return `null`. The later Task 7 source guard removes `worldBoundaryNeedsPreparation` and `npc_fixed_choice` after all consumers are migrated.

- [ ] **Step 5: Run focused tests**

Run:

```bash
npx vitest run src/game/domain/pendingNarrativeJob.test.ts src/game/gameplay/rpg/narrativeExecution/narrativeExecutionPolicy.test.ts src/game/application/server/providerTriggerBoundary.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/game/domain/pendingNarrativeJob.ts src/game/domain/pendingNarrativeJob.test.ts src/game/gameplay/rpg/narrativeExecution/narrativeExecutionPolicy.ts src/game/gameplay/rpg/narrativeExecution/narrativeExecutionPolicy.test.ts src/game/application/server/providerTriggerBoundary.test.ts
git commit -m "refactor: restrict ai to narrative decisions"
```

## Task 2: Define the atomic bundle and generated-only narrative state

**Files:**

- Create: `src/game/domain/narrativeBundle.ts`
- Create: `src/game/domain/narrativeBundle.test.ts`
- Modify: `src/game/domain/preparedContinuation.ts`
- Modify: `src/game/domain/preparedContinuation.test.ts`
- Modify: `src/game/domain/narrative.ts`
- Modify: `src/game/domain/narrative.test.ts`
- Modify: `src/game/application/sceneSource.ts`

**Interfaces:**

- Produces: `MAX_NARRATIVE_BUNDLE_STEPS = 12`.
- Produces: `NarrativeSymbolRef`, `NarrativeBundleProposal`, `NarrativeBundleTerminal`, `NarrativeBundleState`.
- Defines: the replacement trigger union inside `narrativeBundle.ts`; existing `PreparedContinuationTrigger` remains compatible until Task 7 migrates consumers.
- Keeps: schema 6 and legacy scene provenance temporarily; Task 7 performs the schema/bundle/provenance cutover after all production writers and the active-battle path migrate.

- [ ] **Step 1: Add failing strict-parser tests**

Cover these cases:

```ts
expect(parseNarrativeBundleProposal(validBundle).ok).toBe(true);
expect(parseNarrativeBundleProposal({ ...validBundle, terminal: { kind: "next_decision", target: { kind: "current_scene" } }, continuationScenes: [oneStep] }).ok).toBe(false);
expect(parseNarrativeBundleProposal({ ...validBundle, terminal: { kind: "next_decision", target: { kind: "continuation_step" } } }).ok).toBe(false);
expect(parseNarrativeBundleProposal({ ...validBundle, continuationScenes: thirteenSteps }).ok).toBe(false);
```

- [ ] **Step 2: Run the domain tests and verify failure**

Run:

```bash
npx vitest run src/game/domain/narrativeBundle.test.ts src/game/domain/preparedContinuation.test.ts src/game/domain/narrative.test.ts
```

Expected: FAIL because the additive bundle contract does not exist.

- [ ] **Step 3: Add the bundle proposal contract**

Define:

```ts
export const MAX_NARRATIVE_BUNDLE_STEPS = 12 as const;

export type NarrativeSymbolRef =
  | "@current.location"
  | "@current.focus_npc"
  | "@new.location"
  | "@new.npc"
  | "@new.item"
  | "@new.enemy"
  | "@new.fact"
  | "@new.quest"
  | "@ending.trust"
  | "@ending.doubt";

export type NarrativeBundleTerminal =
  | { readonly kind: "next_decision"; readonly target: { readonly kind: "current_scene" } }
  | { readonly kind: "next_decision"; readonly target: { readonly kind: "continuation_step"; readonly stepKey: string } }
  | { readonly kind: "ending" };

export type BundleSceneProposal = {
  readonly segments: readonly ScenePerformanceSegment[];
  readonly npcLine: ScenePerformanceNpcLine | null;
  readonly npcDialogues?: readonly ScenePerformanceNpcDialogue[];
  readonly objectiveLink: ScenePerformanceObjectiveLink | null;
  readonly choices: readonly { readonly candidateId: string; readonly label: string }[];
  readonly handoffAcknowledgement?: string;
};

export type BundleStepProposal = {
  readonly stepKey: string;
  readonly scene: BundleSceneProposal;
};

export type NarrativeBundleProposal = {
  readonly worldDelta: WorldDeltaProposal | null;
  readonly currentScene: BundleSceneProposal;
  readonly continuationScenes: readonly BundleStepProposal[];
  readonly terminal: NarrativeBundleTerminal;
};
```

Move the pure `ScenePerformanceSegment`, `ScenePerformanceNpcLine`, `ScenePerformanceNpcDialogue` and `ScenePerformanceObjectiveLink` value types from `sceneSource.ts` into `narrativeBundle.ts`; temporarily re-export them from `sceneSource.ts` so legacy callers remain typecheck-clean. Domain code must not import from application. The parser must allow only documented keys, non-empty text and known symbol references.

`BundleStepProposal.stepKey` is a provider-facing selector from this closed grammar, not a persisted graph ID:

```text
move:<location-ref>
explore:<location-ref>
investigate:<fact-ref>[:<approachId>]
take_item:<item-ref>
give_item:<item-ref>:<npc-ref>
battle_started:<enemy-ref>
battle_resolved:victory:<enemy-ref>
```

Each ref must be either an existing entity ID explicitly exposed in the prompt or a compatible `NarrativeSymbolRef`. Approval resolves symbols, canonicalizes the selector, matches it one-to-one to a server-rebuilt descriptor and then mints the actual `stepId`; provider output never controls edges or active roots. Reject unknown verbs, malformed arity, refs outside the authority set and duplicate canonical selectors.

- [ ] **Step 4: Define the replacement one-shot trigger union**

Use this closed union:

```ts
export type NarrativeBundleTrigger =
  | { readonly kind: "move"; readonly locationId: LocationId }
  | { readonly kind: "explore"; readonly locationId: LocationId }
  | { readonly kind: "investigate"; readonly factId: FactId; readonly approachId?: string }
  | { readonly kind: "take_item"; readonly itemId: ItemId }
  | { readonly kind: "give_item"; readonly itemId: ItemId; readonly npcId: NpcId }
  | { readonly kind: "battle_started"; readonly enemyId: EnemyId }
  | { readonly kind: "battle_resolved"; readonly enemyId: EnemyId; readonly outcome: "victory" };
```

Do not add `battle_round`, `defeat` or `withdraw` triggers.

- [ ] **Step 5: Add the approved bundle state**

Persist the server-owned graph and explicit terminal as a new type; do not replace the legacy prepared type in this additive task:

```ts
export type NarrativeBundleTerminalState =
  | { readonly kind: "next_decision"; readonly target: { readonly kind: "current_scene" } }
  | { readonly kind: "next_decision"; readonly target: { readonly kind: "continuation_step"; readonly stepId: string } }
  | { readonly kind: "ending" };

export type NarrativeBundleStepState = {
  readonly stepId: string;
  readonly objectiveKey: string;
  readonly consumptionGroupKey: string;
  readonly trigger: NarrativeBundleTrigger;
  readonly scene: PreparedSceneSeedState;
  readonly nextStepIds: readonly string[];
};

export type NarrativeBundleState = {
  readonly contractVersion: 1;
  readonly originJobId: NarrativeJobId;
  readonly steps: readonly NarrativeBundleStepState[];
  readonly activeStepIds: readonly string[];
  readonly terminal: NarrativeBundleTerminalState;
};
```

Keep current `PreparedContinuationState` consumers unchanged in this additive task. Parse `NarrativeBundleState` independently and reject cycles, unknown edges, duplicate trigger siblings, more than 12 steps, a continuation terminal whose `stepId` is absent, a current-scene terminal with any continuation steps, and an ending bundle with continuation steps.

- [ ] **Step 6: Add a compatibility seam for later migration**

Export pure conversion helpers that turn approved bundle steps into the existing ready runtime shape without accepting `source="rule"` as new bundle input. Do not change `NarrativeSceneState.source` or `STORY_STATE_SCHEMA_VERSION` yet; Task 7 changes both with the first non-empty bundle write after old writers are gone.

- [ ] **Step 7: Run domain tests**

Run:

```bash
npx vitest run src/game/domain
npm run typecheck
```

Expected: all domain tests and typecheck pass because this task is additive.

- [ ] **Step 8: Commit**

```bash
git add src/game/domain/narrativeBundle.ts src/game/domain/narrativeBundle.test.ts src/game/domain/preparedContinuation.ts src/game/domain/preparedContinuation.test.ts src/game/domain/narrative.ts src/game/domain/narrative.test.ts src/game/application/sceneSource.ts
git commit -m "feat: define atomic narrative bundle contract"
```

## Task 3: Build and prove the server-owned continuation graph

**Files:**

- Create: `src/game/gameplay/rpg/narrativeBundle/descriptors.ts`
- Create: `src/game/gameplay/rpg/narrativeBundle/descriptors.test.ts`
- Create: `src/game/gameplay/rpg/narrativeBundle/coverage.ts`
- Create: `src/game/gameplay/rpg/narrativeBundle/coverage.test.ts`
- Create: `src/game/gameplay/rpg/narrativeBundle/index.ts`
- Modify: `src/game/gameplay/rpg/preparedContinuation/candidates.ts`
- Modify: `src/game/gameplay/rpg/preparedContinuation/candidates.test.ts`
- Modify: `src/dependencyBoundaries.test.ts`

**Interfaces:**

- Produces: `buildNarrativeBundleDescriptors(input): BundleDescriptorGraph`.
- Produces: `validateNarrativeBundleCoverage(graph): BundleCoverageResult`.
- Consumes later: symbolic step keys and candidate IDs used by prompt and approval.

Define the shared graph shapes in `descriptors.ts`:

```ts
export type BundleStepDescriptor = {
  readonly stepKey: string;
  readonly objectiveKey: string;
  readonly consumptionGroupKey: string;
  readonly trigger: NarrativeBundleTrigger;
  readonly absorbedObjectiveIndexes: readonly number[];
  readonly authority: {
    readonly questId: QuestId;
    readonly allowedEntityIds: readonly string[];
    readonly visibleFactIds: readonly FactId[];
  };
  readonly arrivalNpc?: PreparedArrivalNpcContext;
  readonly choiceCandidates: readonly PreparedChoiceCandidate[];
  readonly nextStepKeys: readonly string[];
};

export type BundleDescriptorGraph = {
  readonly steps: readonly BundleStepDescriptor[];
  readonly activeStepKeys: readonly string[];
  readonly currentChoiceCandidates: readonly PreparedChoiceCandidate[];
  readonly terminal: NarrativeBundleTerminal;
};
```

- [ ] **Step 1: Add the reproduced `visit -> discover -> talk` failure test**

Build a quest with exactly those three objectives and assert:

```ts
const graph = buildNarrativeBundleDescriptors({ worldState, storyState, transition });
expect(graph.activeStepKeys).toEqual(["move:loc_dyn_1"]);
expect(graph.currentChoiceCandidates).toEqual([]);
expect(graph.steps).toHaveLength(1);
expect(graph.steps[0]?.absorbedObjectiveIndexes).toEqual([0, 1, 2]);
expect(graph.steps[0]?.arrivalNpc?.id).toBe(npcDyn1);
expect(graph.steps[0]?.choiceCandidates).toHaveLength(2);
expect(graph.terminal).toEqual({
  kind: "next_decision",
  target: { kind: "continuation_step", stepKey: "move:loc_dyn_1" },
});
```

- [ ] **Step 2: Add coverage rejection tests**

Test a missing successor, cycle, 13-step graph, leaf without a decision, terminal NPC with one choice, terminal NPC with three choices, and ending graph with executable successors. Each must return a stable rejection code.

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
npx vitest run src/game/gameplay/rpg/narrativeBundle src/game/gameplay/rpg/preparedContinuation/candidates.test.ts
```

Expected: FAIL because traversal currently stops at `talk_to_npc` and only inspects the immediately following objective for an arrival NPC.

- [ ] **Step 4: Implement zero-action objective folding**

The descriptor walker must scan through automatic `discover_fact` objectives and attach their mandatory beats to the preceding player action. It must stop on `obtain_item` and `defeat_enemy`, because those require player actions, and stop after attaching a `talk_to_npc` terminal.

Use deterministic step keys:

```ts
export function narrativeBundleTriggerKey(trigger: NarrativeBundleTrigger): string;
```

Implement every member of the closed union explicitly (`move`, `explore`, `investigate`, `take_item`, `give_item`, `battle_started`, `battle_resolved:victory`). Add a separate parser/resolver for the provider selector grammar from Task 2; after symbol resolution it must equal `narrativeBundleTriggerKey(descriptor.trigger)`. Graph edges, candidate actions and active roots must be derived after world-delta materialization and never copied from provider output.

- [ ] **Step 5: Implement exact leaf coverage**

`validateNarrativeBundleCoverage` returns success only when:

```ts
export type BundleCoverageErrorCode =
  | "step_limit_exceeded"
  | "cycle"
  | "unknown_edge"
  | "unreachable_step"
  | "missing_terminal"
  | "invalid_terminal_choice_count"
  | "executable_after_ending";

type BundleCoverageResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: BundleCoverageErrorCode };
```

For `target.kind="continuation_step"`, require no current-scene candidates, require every reachable graph leaf to equal the declared terminal step and require that step to have exactly two server-authored `talk` candidates for one focus NPC. For `target.kind="current_scene"`, require an empty continuation graph and exactly two `currentChoiceCandidates` for one focus NPC. An `ending` terminal has an empty continuation graph and no current-scene candidate. Approval separately requires provider labels to match these server-authored candidate IDs exactly.

- [ ] **Step 6: Preserve battle retry topology**

For `defeat_enemy`, generate one `battle_started` step followed only by `battle_resolved:victory`. The pre-battle checkpoint captures the bundle while `battle_started` is still active, so Task 8 can restore that exact state after defeat or withdrawal. Do not create generated defeat/withdraw scenes or reconstruct roots independently.

- [ ] **Step 7: Run gameplay tests**

Run:

```bash
npx vitest run src/game/gameplay/rpg/narrativeBundle src/game/gameplay/rpg/preparedContinuation/candidates.test.ts
npm run test:game-gameplay
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/game/gameplay/rpg/narrativeBundle src/game/gameplay/rpg/preparedContinuation/candidates.ts src/game/gameplay/rpg/preparedContinuation/candidates.test.ts src/dependencyBoundaries.test.ts
git commit -m "feat: build complete narrative continuation graphs"
```

## Task 4: Approve world evolution and narrative text as one bundle

**Files:**

- Create: `src/game/application/approveNarrativeBundle.ts`
- Create: `src/game/application/approveNarrativeBundle.test.ts`
- Create: `src/game/application/narrativeBundleSource.ts`
- Modify: `src/game/application/approveAndWriteScene.ts`
- Modify: `src/game/application/approvePreparedContinuation.ts`
- Modify: `src/game/application/approvePreparedContinuation.test.ts`
- Modify: `src/game/application/evolveWorld.ts`
- Modify: `src/game/application/evolveWorld.test.ts`

**Interfaces:**

- Produces: `NarrativeBundleSource.generate(context): Promise<NarrativeBundleSourceResult>`.
- Produces: `approveNarrativeBundle(input): ApproveNarrativeBundleResult`.
- Reuses: `approveWorldDelta`, `materializeWorldDelta`, scene grounding approval and server-built descriptor graph.

- [ ] **Step 1: Write atomic-approval tests**

Use a valid decision context whose world delta creates a location, fact and NPC. Assert one approval returns the preview world, current scene, full bundle state and terminal choices. Add failures for invalid world reference, missing continuation scene, invented graph edge, invalid fact reference and a terminal with the wrong candidate count.

Also assert no partial result is exposed:

```ts
const result = approveNarrativeBundle(invalidContinuationInput);
expect(result).toEqual({ ok: false, code: "bundle_missing_step" });
expect("previewWorldState" in result).toBe(false);
```

- [ ] **Step 2: Run the approval tests and verify failure**

Run:

```bash
npx vitest run src/game/application/approveNarrativeBundle.test.ts src/game/application/approvePreparedContinuation.test.ts src/game/application/evolveWorld.test.ts
```

Expected: FAIL because approval is split between world and scene calls.

- [ ] **Step 3: Define the unified source port**

Add this union without provider dependencies:

```ts
export type NarrativeBundleSourceContext =
  | { readonly kind: "opening"; readonly jobId: NarrativeJobId; readonly input: OpeningGenerationInput; readonly auditLink?: AiTextAuditLink }
  | { readonly kind: "decision"; readonly worldState: WorldState; readonly storyState: StoryState; readonly job: PendingNarrativeJob; readonly auditLink?: AiTextAuditLink; readonly contentRepair?: NarrativeBundleRepair };

export type OpeningNarrativeBundleProposal = {
  readonly opening: OpeningGenerationCandidate;
  readonly currentScene: BundleSceneProposal;
  readonly continuationScenes: readonly [];
  readonly terminal: { readonly kind: "next_decision"; readonly target: { readonly kind: "current_scene" } };
};

export type NarrativeBundleSourceResult =
  | { readonly ok: true; readonly kind: "opening"; readonly proposal: OpeningNarrativeBundleProposal }
  | { readonly ok: true; readonly kind: "decision"; readonly proposal: NarrativeBundleProposal }
  | { readonly ok: false; readonly failure: AiGenerationFailure; readonly repairReason?: NarrativeBundleRepairReason };

export type NarrativeBundleSource = {
  generate(context: NarrativeBundleSourceContext): Promise<NarrativeBundleSourceResult>;
};

export type NarrativeBundleRepairReason =
  | "invalid_json"
  | "invalid_schema"
  | "invalid_reference"
  | "coverage_rejected"
  | "approval_rejected";

export type NarrativeBundleRejection =
  | "world_delta_rejected"
  | "bundle_missing_step"
  | "bundle_unknown_step"
  | "bundle_duplicate_step"
  | "bundle_invalid_reference"
  | "bundle_invalid_scene"
  | "bundle_invalid_terminal"
  | BundleCoverageErrorCode;

export type NarrativeBundleRepair = {
  readonly attempt: 1;
  readonly reason: NarrativeBundleRepairReason;
  readonly rejectionCode?: NarrativeBundleRejection;
};
```

The public source method remains one `generate` call. It must reject a success whose result `kind` does not match the input context kind.

- [ ] **Step 4: Implement ordered atomic approval**

`approveNarrativeBundle` must:

1. approve `worldDelta` against the current evolution need;
2. materialize a preview with real IDs;
3. build descriptors from the preview;
4. resolve only the documented symbolic references;
5. approve the current scene and every descriptor scene;
6. validate graph coverage and terminal;
7. return one immutable approved value.

Use this success shape:

```ts
type ApprovedNarrativeBundle = {
  readonly nextWorldState: WorldState;
  readonly nextStoryStatePreview: StoryState;
  readonly currentScene: NarrativeSceneState;
  readonly choiceRegistry: readonly ApprovedChoice[];
  readonly bundle: NarrativeBundleState;
  readonly candidateEventPool: readonly EventCandidate[];
};

export type ApproveNarrativeBundleResult =
  | { readonly ok: true; readonly approved: ApprovedNarrativeBundle }
  | { readonly ok: false; readonly code: NarrativeBundleRejection };
```

- [ ] **Step 5: Reuse pure validators, not IO orchestration**

Extract pure helpers from `evolveWorld.ts` and `approveAndWriteScene.ts` where required. Do not call `WorldEvolutionSource`, `SceneSource`, `aiClient` or repository methods from `approveNarrativeBundle.ts`.

- [ ] **Step 6: Run focused and application tests**

Run:

```bash
npx vitest run src/game/application/approveNarrativeBundle.test.ts src/game/application/approvePreparedContinuation.test.ts src/game/application/evolveWorld.test.ts
npm run test:game-application
npm run typecheck
```

Expected: all named tests, application tests and typecheck pass; legacy orchestration remains functional until Task 7 switches production composition.

- [ ] **Step 7: Commit**

```bash
git add src/game/application/approveNarrativeBundle.ts src/game/application/approveNarrativeBundle.test.ts src/game/application/narrativeBundleSource.ts src/game/application/approveAndWriteScene.ts src/game/application/approvePreparedContinuation.ts src/game/application/approvePreparedContinuation.test.ts src/game/application/evolveWorld.ts src/game/application/evolveWorld.test.ts
git commit -m "feat: approve narrative bundles atomically"
```

## Task 5: Replace world-plus-scene provider calls with one live bundle call

**Files:**

- Create: `src/game/application/server/ai/liveNarrativeBundleSource.ts`
- Create: `src/game/application/server/ai/liveNarrativeBundleSource.test.ts`
- Create: `src/game/application/server/ai/narrativeContext/bundleNarrativeContext.ts`
- Create: `src/game/application/server/ai/narrativeContext/bundleNarrativeContext.test.ts`
- Modify: `src/game/application/server/ai/sourceFactory.ts`
- Modify: `src/game/application/server/ai/sourceFactory.test.ts`
- Modify: `src/game/application/server/ai/textAuditTypes.ts`

**Interfaces:**

- Produces: `createNarrativeBundleSource(...)` alongside legacy factories until Task 7 switches composition.
- Keeps production wiring and persistence unchanged in this additive task; Task 7 creates the pending-job orchestrator and replaces `generatePendingScene` in `BackgroundEnsureCoordinator`.

- [ ] **Step 1: Write a one-call source test**

Mock `RpgAiClient.complete` and return a single JSON object containing `worldDelta`, `currentScene`, `continuationScenes` and `terminal`. Assert:

```ts
expect(complete).toHaveBeenCalledTimes(1);
expect(complete).toHaveBeenCalledWith(
  "narrative_bundle",
  expect.any(Array),
  expect.objectContaining({ purpose: "narrative_bundle_generation" }),
);
```

The prompt assertion must contain the symbolic-reference whitelist, maximum 12 steps, the distinction between `current_scene` and `continuation_step`, exactly two choices at the selected next-decision target, and the instruction that battle failure returns to its checkpoint and therefore has no generated failure branch.

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npx vitest run src/game/application/server/ai/liveNarrativeBundleSource.test.ts src/game/application/server/ai/narrativeContext/bundleNarrativeContext.test.ts
```

Expected: FAIL because the unified live source and prompt compiler do not exist.

- [ ] **Step 3: Compile one prompt and parse one response**

`liveNarrativeBundleSource` must make exactly one `aiClient.complete("narrative_bundle", ...)` call per attempt. Parsing may perform non-creative normalization such as JSON-fence removal, but may not issue nested world or scene calls.

The decision prompt must provide:

- current authoritative world/story slices;
- resolved player choice or clipped custom input;
- evolution need and budget;
- mandatory beats;
- allowed symbolic references;
- conditional step-key rules;
- exact JSON shape and terminal rules.

- [ ] **Step 4: Add the bundle factory without switching production composition**

Export:

```ts
export function createNarrativeBundleSource(
  env: Record<string, string | undefined>,
  logger?: GameLogger,
  aiClient?: RpgAiClient,
): NarrativeBundleSource;
```

Factory tests must prove AI-available and unavailable behavior. Do not inject it into `compositionRoot.ts` until Task 7, when pending job kinds and action callers switch together.

- [ ] **Step 5: Define collapsed audit identity**

Extend `AiTextAuditRole` with `"narrative_bundle"`, the purpose union with `"narrative_bundle_generation"`, and the new audit context/link with `triggerKind: DecisionBoundaryKind`. The unified call emits the existing `ai_call` event with `role="narrative_bundle"`, `purpose="narrative_bundle_generation"`, `gameId`, `jobId`, `triggerKind`, `turnNumber`, top-level `attempt` and structured `retry.origin`. The final `story_text` event remains separate because it records approved output, but shares the same link. Production stops emitting initial `world_evolution` and `scene_performance` events after the Task 7 composition switch.

- [ ] **Step 6: Run source and factory tests**

Run:

```bash
npx vitest run src/game/application/server/ai/liveNarrativeBundleSource.test.ts src/game/application/server/ai/narrativeContext/bundleNarrativeContext.test.ts src/game/application/server/ai/sourceFactory.test.ts
npm run typecheck
```

Expected: PASS and every one-attempt assertion reports one provider invocation; no production persistence or composition path has switched yet.

- [ ] **Step 7: Commit**

```bash
git add src/game/application/server/ai/liveNarrativeBundleSource.ts src/game/application/server/ai/liveNarrativeBundleSource.test.ts src/game/application/server/ai/narrativeContext/bundleNarrativeContext.ts src/game/application/server/ai/narrativeContext/bundleNarrativeContext.test.ts src/game/application/server/ai/sourceFactory.ts src/game/application/server/ai/sourceFactory.test.ts src/game/application/server/ai/textAuditTypes.ts
git commit -m "feat: generate runtime narrative in one bundle call"
```

## Task 6: Make new-game initialization a single ready bundle

**Files:**

- Modify: `src/game/domain/openingGenerationCandidate.ts`
- Modify: `src/game/domain/openingGenerationCandidate.test.ts`
- Modify: `src/game/gameplay/rpg/openingGeneration/validateOpeningGenerationCandidate.ts`
- Modify: `src/game/gameplay/rpg/openingGeneration/validateOpeningGenerationCandidate.test.ts`
- Modify: `src/game/gameplay/rpg/openingGeneration/compileOpeningGenerationCandidate.ts`
- Modify: `src/game/gameplay/rpg/openingGeneration/compileOpeningGenerationCandidate.test.ts`
- Modify: `src/game/application/createGame.ts`
- Modify: `src/game/application/createGame.test.ts`
- Modify: `src/game/application/server/ai/liveNarrativeBundleSource.ts`
- Modify: `src/game/application/server/ai/liveNarrativeBundleSource.test.ts`
- Modify: `src/game/application/server/ai/narrativeContext/bundleNarrativeContext.ts`
- Modify: `src/game/application/server/ai/narrativeContext/bundleNarrativeContext.test.ts`
- Modify: `src/game/application/server/compositionRoot.ts`

**Interfaces:**

- Consumes: `NarrativeBundleSource` opening context.
- Produces: a revision-0 save whose narrative is already `ready` with one generated focus line, exactly two choices and free-input eligibility.
- Removes: the opening `provider_pending` scene job and post-create `narrativeCoordinator.ensure` call.

- [ ] **Step 1: Add failing opening atomicity tests**

Assert a successful `createGame`:

```ts
expect(bundleSource.generate).toHaveBeenCalledTimes(1);
expect(saved.storyState.narrative.status).toBe("ready");
expect(saved.storyState.narrative.currentScene.source).toBe("generated");
expect(saved.storyState.narrative.currentScene.choices).toHaveLength(2);
expect(saved.storyState.narrative.currentScene.npcLine?.npcId).toBe(OPENING_NPC_ID);
```

Assert invalid first-decision output creates no save. Assert `createGame` derives one initialization `jobId` before the first source call; novelty/content retries reuse that exact ID with increasing `attempt` and do not create intermediate records.

- [ ] **Step 2: Run opening tests and verify failure**

Run:

```bash
npx vitest run src/game/application/createGame.test.ts src/game/application/server/ai/liveNarrativeBundleSource.test.ts src/game/application/server/ai/narrativeContext/bundleNarrativeContext.test.ts src/game/gameplay/rpg/openingGeneration
```

Expected: FAIL because opening currently creates a pending scene that triggers a second provider call.

- [ ] **Step 3: Extend the opening candidate with its first decision scene**

The opening provider JSON must include the initial focus NPC line, scene narration, exactly two candidate labels and `terminal={ kind:"next_decision", target:{ kind:"current_scene" } }` with an empty continuation list. Candidate actions remain server-authored `support` and `challenge` against `OPENING_NPC_ID`.

- [ ] **Step 4: Compile the initial scene and choices before persistence**

After validating the opening world, compile the first scene and use `createApprovedChoice` with `basedOnRevision: 0`. Build `NarrativeRuntimeState` as `ready`; do not construct a `PendingNarrativeJob`.

- [ ] **Step 5: Remove the second opening generation path**

Delete the `narrativeCoordinator.ensure(traceId)` call after successful `createGame`. The HTTP response returns only after the single initialization bundle is valid and saved.

- [ ] **Step 6: Run opening and composition tests**

Run:

```bash
npx vitest run src/game/application/createGame.test.ts src/game/application/server/ai/liveNarrativeBundleSource.test.ts src/game/application/server/ai/narrativeContext/bundleNarrativeContext.test.ts src/game/gameplay/rpg/openingGeneration src/game/application/server/compositionRoot.test.ts
npm run typecheck
```

Expected: PASS; opening audit contains one logical initialization `jobId` shared by every retry/approved-text event and no pending-scene event.

- [ ] **Step 7: Commit**

```bash
git add src/game/domain/openingGenerationCandidate.ts src/game/domain/openingGenerationCandidate.test.ts src/game/gameplay/rpg/openingGeneration src/game/application/createGame.ts src/game/application/createGame.test.ts src/game/application/server/ai/liveNarrativeBundleSource.ts src/game/application/server/ai/liveNarrativeBundleSource.test.ts src/game/application/server/ai/narrativeContext/bundleNarrativeContext.ts src/game/application/server/ai/narrativeContext/bundleNarrativeContext.test.ts src/game/application/server/compositionRoot.ts
git commit -m "refactor: initialize games with one ready narrative bundle"
```

## Task 7: Make decision turns create bundles and every other剧情 action consume them

**Files:**

- Modify: `src/game/application/actionConverter.ts`
- Modify: `src/game/application/actionConverter.test.ts`
- Modify: `src/game/application/performTurn.ts`
- Modify: `src/game/application/performTurn.test.ts`
- Modify: `src/game/application/consumePreparedContinuation.ts`
- Modify: `src/game/application/consumePreparedContinuation.test.ts`
- Modify: `src/game/application/buildChoiceMap.ts`
- Modify: `src/game/application/buildChoiceMap.test.ts`
- Create: `src/game/application/generatePendingNarrativeBundle.ts`
- Create: `src/game/application/generatePendingNarrativeBundle.test.ts`
- Create: `src/game/application/performBattleRound.ts`
- Create: `src/game/application/performBattleRound.test.ts`
- Modify: `src/game/application/combatView.ts`
- Modify: `src/game/application/combatView.test.ts`
- Modify: `src/game/application/server/compositionRoot.ts`
- Modify: `src/game/application/server/compositionRoot.test.ts`
- Modify: `src/game/application/server/compositionRoot.audit.test.ts`
- Modify: `src/game/application/server/ai/sourceFactory.ts`
- Modify: `src/game/domain/narrative.ts`
- Modify: `src/game/domain/narrative.test.ts`
- Modify: `src/game/domain/pendingNarrativeJob.ts`
- Modify: `src/game/domain/pendingNarrativeJob.test.ts`
- Modify: `src/game/domain/storyState.ts`
- Modify: `src/game/domain/storyState.test.ts`
- Modify: `src/game/application/server/persistence/sqliteGameRepository.test.ts`
- Modify: `src/game/gameplay/rpg/narrativeExecution/narrativeExecutionPolicy.ts`
- Modify: `src/game/gameplay/rpg/narrativeExecution/narrativeExecutionPolicy.test.ts`
- Modify: `src/game/application/testing/providerTriggerMatrix.test.ts`
- Delete: `src/game/application/server/ai/intentParserSourceFactory.ts`
- Delete: `src/game/application/server/ai/intentParserSourceFactory.test.ts`
- Delete: `src/game/application/server/ai/liveIntentParserSource.ts`
- Delete: `src/game/application/server/ai/liveIntentParserSource.test.ts`
- Delete: `src/game/application/ruleOwnedScene.ts`
- Delete: `src/game/application/ruleOwnedScene.test.ts`

**Interfaces:**

- Fixed choice provider proof: the token belongs to both `currentScene.choices` and `choiceRegistry`, and its action is `talk` to the current focus NPC.
- Free text conversion: a local neutral `talk/ask` action with clipped player utterance.
- Non-boundary outcome: consume an exact generated bundle step or return `NARRATIVE_CONTINUATION_MISSING` with zero writes.
- Produces: `generatePendingNarrativeBundle(deps): Promise<GeneratePendingNarrativeBundleResult>`.
- Production coordinator: `NarrativeBundleSource` + `generatePendingNarrativeBundle` only.
- Persistence cutover: ready narrative uses `NarrativeBundleState`, schema becomes 7, and schema 6 is read-only unsupported from the same commit onward.
- Schema-7 battle seam: ready narrative always contains `battleCheckpoint: BattleNarrativeCheckpointState | null`; Task 7 initializes it to `null`, and Task 8 activates its rollback behavior.

- [ ] **Step 1: Add the complete trigger/consumption matrix**

Create table-driven cases that assert provider-call count, state writes and result:

| Case | Provider jobs | Expected path |
|---|---:|---|
| current formal fixed choice | 1 | pending `narrative_choice` |
| current focus free text | 1 | pending `npc_free_text` |
| forged/stale/synthetic fixed token | 0 | reject, zero writes |
| move/explore/investigate/take/give/battle start/victory with matching step | 0 | consume generated step |
| same actions without matching step | 0 | `NARRATIVE_CONTINUATION_MISSING`, zero writes |
| non-focus free text | 0 | reject, zero writes |

The test source spy must throw if invoked from a zero-provider case.

In `generatePendingNarrativeBundle.test.ts`, start from one `provider_pending` record and assert the orchestrator calls the source once, calls `approveNarrativeBundle` once, and requests one atomic write containing the approved world, current scene, choice registry and complete bundle. Add approval-failure and lost-CAS cases that expose no partial state and retain the original `jobId`.

In `performBattleRound.test.ts`, add one active non-terminal round proving the world battle fields and database revision change while the entire story state remains equal and the bundle source is never called. Full defeat/withdraw restoration cases remain for Task 8.

Add one battle-start assertion that the schema-7 checkpoint is captured before `battle_started` is consumed and still contains that active root. Task 8 adds restoration assertions for defeat and withdrawal.

- [ ] **Step 2: Add the free-text no-intent-provider regression**

Assert conversion output exactly:

```ts
expect(converted.action).toEqual({
  type: "talk",
  npcId: focusNpcId,
  dialogueAct: "ask",
  utterance: "玩家原文",
});
```

No `IntentParserSource` dependency may appear in `PerformTurnDeps` or `compositionRoot.ts`.

- [ ] **Step 3: Run focused tests and verify failure**

Run:

```bash
npx vitest run src/game/application/actionConverter.test.ts src/game/application/performTurn.test.ts src/game/application/consumePreparedContinuation.test.ts src/game/application/generatePendingNarrativeBundle.test.ts src/game/application/performBattleRound.test.ts src/game/application/testing/providerTriggerMatrix.test.ts
```

Expected: FAIL because the pending bundle orchestrator and structured active-round path do not exist, non-dialogue boundaries can still create provider jobs, free text can call intent AI, and rule-owned fallback scenes still exist.

- [ ] **Step 4: Implement atomic pending-job generation and repair**

`generatePendingNarrativeBundle` calls the source once, calls `approveNarrativeBundle` once, and commits the approved world, current scene, choice registry and complete `NarrativeBundleState` in one CAS. When approval fails, it performs no partial world/scene write and records `provider_failed` with the same `jobId`.

Use `runBoundedAttempts` with `maxAttempts: 2`. Attempt 2 receives a stable rejection code from parsing or approval and resubmits the entire bundle with the same job and audit identity. Transport retries inside `RpgAiClient` and manual retries also retain the same logical job. Add a race test proving a lost CAS leaves the newer record untouched.

- [ ] **Step 5: Prove formal fixed choices before resolving the turn**

In `performTurn`, derive `fixedChoiceIsCurrentFormalDecision` from the saved ready scene and registry, not from client input or action type alone. Require exactly two current scene choices and a matching focus NPC. A single start/continue token can never pass this proof.

- [ ] **Step 6: Convert free text locally**

Remove provider intent parsing from `convertInteraction`. Validate focus NPC and length, then emit neutral `talk/ask` with the original clipped utterance. Keep the utterance in the pending job and audit context; never store it in arbitrary world fields.

- [ ] **Step 7: Remove provider boundary fallbacks**

Change the job `generationKind` field to `DecisionBoundaryKind`, remove `NarrativeSceneRequestKind`, `sceneRequestKind`, their pairing map, `npc_fixed_choice` and `worldBoundaryNeedsPreparation`. Audit projection exposes this value as `triggerKind`; do not preserve the legacy label in new audit events. A final formal choice still commits a pending `narrative_choice` job; its approved bundle ends with `terminal.kind="ending"`.

- [ ] **Step 8: Fail closed for every剧情 action**

For move, plot explore, investigate, take, give, battle start and battle victory, call `consumePreparedContinuation`. If no exact active trigger exists, return the stable missing/invalid code before `commitState`; do not call `buildRuleOwnedScene`, retain the rule feedback sentence, or synthesize a scene.

Pure navigation/view operations must be separated from剧情 actions: they may update UI navigation state or expose already AI-generated location descriptions, but must not create a turn, replace `currentScene`, or append剧情 prose.

For an already active battle, delegate before generic story reduction to an initial `performBattleRound` path. It applies deterministic combat rules, preserves the complete story state during non-terminal rounds, commits only structured battle state/results and never calls a source. Task 8 extends this path with defeat/withdraw rollback.

When consuming `battle_started`, store the schema-7 narrative checkpoint first. Non-terminal active rounds leave it untouched; victory consumes only `battle_resolved:victory` and clears the checkpoint. Task 8 adds defeat/withdraw restoration and strengthens all terminal-outcome tests.

- [ ] **Step 9: Delete rule-owned and live intent sources**

Remove the listed application intent-source and `ruleOwnedScene` files with all imports. Rewrite tests to construct the neutral `talk/ask` action directly and to consume structured battle results; do not retain an intent-source fixture, compatibility port or rule-scene builder.

- [ ] **Step 10: Switch production composition to the unified generator**

Instantiate one `narrativeBundleSource` from `sourceFactory`. Change the background coordinator to call only `generatePendingNarrativeBundle`; remove production construction/injection of opening/world/scene/intent sources that are no longer used. Keep ensure polling and manual retry semantics, and prove both reuse the existing persisted job.

- [ ] **Step 11: Cut persistence over to schema 7 atomically**

Replace the ready runtime's legacy prepared continuation field with `NarrativeBundleState`, remove `"rule"` from schema-7 scene provenance, and set `STORY_STATE_SCHEMA_VERSION = 7` in this same task—the first task that writes a non-empty bundle. Define the stable checkpoint shape now, initialize it to `null` outside battle, and make both null and battle-start snapshots round-trip:

```ts
type BattleNarrativeCheckpointState = {
  readonly enemyId: EnemyId;
  readonly scene: NarrativeSceneState;
  readonly choiceRegistry: readonly ApprovedChoice[];
  readonly bundle: NarrativeBundleState;
  readonly storyMetrics: {
    readonly turnNumber: number;
    readonly storyProgress: number;
    readonly tension: number;
    readonly nextPacingNeed: PacingNeed;
    readonly recentBeats: readonly unknown[];
    readonly npcContacts: readonly unknown[];
    readonly reducedThroughEventCount: number;
  };
};
```

Classify every v6 record as `UNSUPPORTED_RECORD`; loading it must not update SQLite, create a job or emit a provider audit. Add v7 JSON/parser and SQLite round-trip tests for `battleCheckpoint: null`. Do not temporarily serialize the new bundle under version 6.

- [ ] **Step 12: Run application, composition and trigger tests**

Run:

```bash
npx vitest run src/game/application/actionConverter.test.ts src/game/application/performTurn.test.ts src/game/application/consumePreparedContinuation.test.ts src/game/application/generatePendingNarrativeBundle.test.ts src/game/application/performBattleRound.test.ts src/game/application/combatView.test.ts src/game/application/testing/providerTriggerMatrix.test.ts src/game/application/server/providerTriggerBoundary.test.ts src/game/application/server/compositionRoot.test.ts src/game/application/server/compositionRoot.audit.test.ts src/game/domain/narrative.test.ts src/game/domain/storyState.test.ts src/game/application/server/persistence/sqliteGameRepository.test.ts
npm run test:game-application
npm run typecheck
```

Expected: PASS and `rg -n "buildRuleOwnedScene|source:\\s*['\"]rule['\"]" src/game --glob '!*.test.*'` returns no production match.

- [ ] **Step 13: Commit**

```bash
git add -A src/game/domain/narrative.ts src/game/domain/narrative.test.ts src/game/domain/pendingNarrativeJob.ts src/game/domain/pendingNarrativeJob.test.ts src/game/domain/storyState.ts src/game/domain/storyState.test.ts src/game/gameplay/rpg/narrativeExecution src/game/application src/game/application/testing/providerTriggerMatrix.test.ts
git commit -m "refactor: consume generated narrative between decisions"
```

## Task 8: Add pre-battle checkpoints and restore them on failure

**Files:**

- Modify: `src/game/application/performBattleRound.ts`
- Modify: `src/game/application/performBattleRound.test.ts`
- Modify: `src/game/domain/narrative.ts`
- Modify: `src/game/domain/narrative.test.ts`
- Modify: `src/game/domain/worldState.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/battleResolver.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/battleResolver.test.ts`
- Modify: `src/game/application/performTurn.ts`
- Modify: `src/game/application/performTurn.test.ts`
- Modify: `src/game/application/combatView.ts`
- Modify: `src/game/application/combatView.test.ts`

**Interfaces:**

- Consumes: the nullable `BattleNarrativeCheckpointState` already defined by schema 7 in Task 7.
- Produces: `performBattleRound(input, deps)` with no AI/source dependency.
- Battle failure semantics: restore checkpoint, set battle idle, keep database revision monotonic.

- [ ] **Step 1: Expand battle checkpoint tests**

Starting from the Task 7 battle-start regression, assert every field of the stored schema-7 `BattleNarrativeCheckpointState` matches the pre-consumption state and its bundle snapshot still has `battle_started` as an active root. Add the failure/withdraw restoration assertions below.

The existing `BattleStartSnapshot` continues to own player stats, defeated IDs and event-ledger checkpoint.

- [ ] **Step 2: Expand active-round zero-narrative tests**

Extend the Task 7 non-terminal regression across attack, skill and guard while battle remains active, and assert:

```ts
expect(after.storyState).toEqual(before.storyState);
expect(after.worldState.battle).not.toEqual(before.worldState.battle);
expect(repository.applyState).toHaveBeenCalledTimes(1);
expect(bundleSource.generate).not.toHaveBeenCalled();
```

Database revision increases by one; narrative scene, task state, tension, story progress and story `turnNumber` do not change.

- [ ] **Step 3: Add failure rollback and victory continuation tests**

On defeat and withdraw, assert player stats, defeated IDs, event ledger, scene, choice registry, bundle roots and story metrics equal the checkpoint; battle becomes idle and the enemy is challengeable again. On victory, assert the checkpoint is cleared and only the prepared `battle_resolved:victory` scene is consumed.

- [ ] **Step 4: Run battle tests and verify failure**

Run:

```bash
npx vitest run src/game/application/performBattleRound.test.ts src/game/gameplay/rpg/ruleEngine/battleResolver.test.ts src/game/application/combatView.test.ts src/game/application/performTurn.test.ts -t "battle|战斗"
```

Expected: FAIL because defeat and withdrawal still persist resolved state instead of restoring the existing pre-battle checkpoints.

- [ ] **Step 5: Extend the dedicated battle-round application path**

Keep the Task 7 rule that an active battle accepts only a valid `battle_action` token and delegates before the generic `resolveTurn` path. Extend `performBattleRound` with checkpoint-aware result handling while retaining no `NarrativeBundleSource`, `PendingNarrativeJob` or coordinator reference.

- [ ] **Step 6: Restore checkpoints on failure**

Keep the Task 7 rule that battle start saves the narrative checkpoint before consuming `battle_started`. On defeat/withdraw, restore its exact scene, registry, bundle and active roots, restore the existing world `preBattleSnapshot`, set battle to idle and clear both checkpoints. The restored bundle already makes `battle_started` available again; do not reconstruct roots from provider or descriptor metadata. Do not decrement database revision.

- [ ] **Step 7: Consume only victory prose**

On victory, apply enemy/quest rule effects, consume `battle_resolved:victory`, clear checkpoints and continue the prepared graph. If the victory step is missing, perform zero writes and return `NARRATIVE_CONTINUATION_MISSING`; do not call AI or display a fallback victory sentence.

- [ ] **Step 8: Keep combat presentation structured**

`BattleView` may expose action kind, actor/target slots, damage, HP, energy, round and intent. It must not expose a precomposed narrative sentence. Mechanical control labels remain local UI copy.

- [ ] **Step 9: Run battle and gameplay tests**

Run:

```bash
npx vitest run src/game/application/performBattleRound.test.ts src/game/gameplay/rpg/ruleEngine/battleResolver.test.ts src/game/application/combatView.test.ts src/game/application/performTurn.test.ts src/game/application/testing/providerTriggerMatrix.test.ts
npm run test:game-gameplay
npm run test:game-application
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/game/application/performBattleRound.ts src/game/application/performBattleRound.test.ts src/game/domain/narrative.ts src/game/domain/narrative.test.ts src/game/domain/worldState.ts src/game/gameplay/rpg/ruleEngine/battleResolver.ts src/game/gameplay/rpg/ruleEngine/battleResolver.test.ts src/game/application/performTurn.ts src/game/application/performTurn.test.ts src/game/application/combatView.ts src/game/application/combatView.test.ts
git commit -m "feat: restore prebattle state after combat defeat"
```

## Task 9: Remove synthetic NPC starts and all player-visible hardcoded剧情 prose

**Files:**

- Modify: `src/game/application/gameSessionView.ts`
- Modify: `src/game/application/gameSessionView.test.ts`
- Modify: `src/components/LocationSceneScreen.tsx`
- Modify: `src/components/AdventureGameShell.test.tsx`
- Modify: `src/components/CurrentGameScreen.tsx`
- Modify: `src/game/domain/npcSpeech.ts`
- Modify: `src/game/domain/npcSpeech.test.ts`
- Modify: `src/game/application/narrativeText.ts`
- Modify: `src/game/application/narrativeText.test.ts`
- Modify: `src/game/application/neutralRuntimeContract.test.ts`

**Interfaces:**

- Removes: `Dialogue.startChoice` and all automatic submission on NPC card click.
- Produces: an explicit non-narrative `narrativeUnavailable` read-model state for incomplete/unsupported saves.
- Battle UI consumes only structured combat fields.
- Preserves: the generated/fixture-only schema-7 provenance already enforced in Task 7.

- [ ] **Step 1: Rewrite the NPC card regression test**

Render a target NPC whose saved bundle is missing formal focus dialogue. Clicking the card must open metadata only and must not call `onSubmit`. Assert no “与某人交谈” start button and no loading state appear.

For a valid generated terminal scene, clicking the NPC card displays the saved AI line, exactly two fixed choices and custom input without making a request.

- [ ] **Step 2: Add a hardcoded-prose source guard**

In `neutralRuntimeContract.test.ts`, read production `src/game` and `src/components` files and reject these exact strings plus production scene provenance:

```ts
const forbidden = [
  "你确认了脚下的方向，暂时退回熟悉的路径。",
  "你按规则记录下眼前的调查结果。",
  "你收起了眼前的物品。",
  "你完成了物品交接。",
  "战斗结果已经由规则结算。",
  "你环顾当前地点，确认了周围的结构。",
  "行动未能完全达成。",
  "你记下了眼前的安排。",
  "行动结果已经由规则记录。",
  "战斗结算完成",
];
for (const text of forbidden) expect(productionSource).not.toContain(text);
expect(productionSource).not.toMatch(/source:\s*["']rule["']/);
```

Exclude `*.test.*`, fixture helpers and this guard's own source from the concatenated production-source set.

- [ ] **Step 3: Run component and guard tests and verify failure**

Run:

```bash
npx vitest run src/components/AdventureGameShell.test.tsx src/game/application/gameSessionView.test.ts src/game/application/neutralRuntimeContract.test.ts
```

Expected: FAIL because `startChoice`, synthesized NPC speech, legacy hardcoded action copy and battle feedback prose still exist.

- [ ] **Step 4: Remove `startChoice` end to end**

Delete its read-model field, projection, component branch, auto-submit logic and tests that expect NPC click to start a provider turn. NPC card handlers only select/open the card.

- [ ] **Step 5: Remove synthesized AI-mode NPC speech**

Delete production use of `composeDirectNpcGreeting`, `composeDeterministicNpcLine`, `composeIdleNpcLine` and generic fallback speech. Non-focus NPCs display only AI-generated `npcDialogues`; if absent, display profile metadata without dialogue prose.

- [ ] **Step 6: Separate system copy from剧情 copy**

Keep network/save/error messages and mechanical labels. Remove all component-composed剧情 feedback such as ``你${choice.label}！`` and actor/action prose. Battle animation state should be driven by structured action kinds; the log displays names, numbers and icons without a generated sentence.

Add a projection test proving `projectGameSessionView` never reads rule `feedback`, `StateChange.description` or `rejectedEffects[].description` into `narrative.text`, NPC speech, dialogue pages or choice labels. Only approved scene/bundle text may enter those fields.

- [ ] **Step 7: Project incomplete bundles as unavailable**

When a current objective requires a focus NPC but no generated terminal scene with two choices exists, return `narrativeUnavailable: { code: "INCOMPLETE_NARRATIVE_BUNDLE" }`. The UI shows a system error/restart instruction and never fabricates a choice or calls ensure unless a persisted pending/failed job already exists.

- [ ] **Step 8: Verify the generated-only schema remains closed**

Keep `fixture` limited to explicitly composed tests and verify the production source factory never returns it. Re-run the Task 7 schema tests proving schema-7 records reject rule-owned scenes and v6 reads perform no update or provider call; Task 9 must not loosen those invariants while deleting presentation fallbacks.

- [ ] **Step 9: Run UI, persistence and text-provenance tests**

Run:

```bash
npx vitest run src/components src/game/application/gameSessionView.test.ts src/game/application/narrativeText.test.ts src/game/application/neutralRuntimeContract.test.ts src/game/domain/storyState.test.ts src/game/application/server/persistence/sqliteGameRepository.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/game/application/gameSessionView.ts src/game/application/gameSessionView.test.ts src/components/LocationSceneScreen.tsx src/components/AdventureGameShell.test.tsx src/components/CurrentGameScreen.tsx src/game/domain/npcSpeech.ts src/game/domain/npcSpeech.test.ts src/game/application/narrativeText.ts src/game/application/narrativeText.test.ts src/game/application/neutralRuntimeContract.test.ts
git commit -m "refactor: remove synthetic and hardcoded story text"
```

## Task 10: Remove obsolete provider ports, update contracts, and run full acceptance

**Files:**

- Delete: `src/game/application/generatePendingScene.ts`
- Delete: `src/game/application/generatePendingScene.test.ts`
- Delete: `src/game/application/worldEvolutionSource.ts`
- Delete: `src/game/application/evolveWorld.ts`
- Delete: `src/game/application/evolveWorld.test.ts`
- Delete: `src/game/application/sceneSource.ts`
- Delete: `src/game/application/deterministicSceneSource.ts`
- Delete: `src/game/application/deterministicSceneSource.test.ts`
- Delete: `src/game/application/deterministicEvolutionSource.ts`
- Delete: `src/game/application/deterministicEvolutionSource.test.ts`
- Delete: `src/game/application/server/ai/liveWorldEvolutionSource.ts`
- Delete: `src/game/application/server/ai/worldEvolutionSource.test.ts`
- Delete: `src/game/application/server/ai/liveScenePerformanceSource.ts`
- Delete: `src/game/application/server/ai/liveScenePerformanceSource.test.ts`
- Delete: `src/game/application/server/ai/openingGenerationSource.ts`
- Delete: `src/game/application/server/ai/openingGenerationSource.test.ts`
- Delete: `src/game/application/server/ai/intentParserSource.ts`
- Delete: `src/game/application/server/ai/intentParserSource.test.ts`
- Modify: `src/game/application/index.ts`
- Modify: `src/game/domain/narrative.ts`
- Modify: `src/game/domain/narrative.test.ts`
- Modify: `src/game/domain/npcSpeech.ts`
- Modify: `src/game/domain/npcSpeech.test.ts`
- Modify: `src/game/application/server/ai/sourceFactory.ts`
- Modify: `src/game/application/server/providerTriggerBoundary.test.ts`
- Modify: `src/game/application/testing/foundationJourney.testutil.ts`
- Modify: `src/game/application/testing/foundationJourney.test.ts`
- Modify: `src/game/application/testing/mediumActJourney.test.ts`
- Modify: `src/game/application/testing/storyDivergenceJourney.test.ts`
- Modify: `docs/游戏设计原则.md`
- Modify: `docs/策划文档/运行时AI角色职责与生成规则.md`
- Modify: `docs/策划文档/AI生成RPG_MVP.md`
- Modify: `docs/agent/运行时AI导演与场景表演.md`
- Modify: `docs/agent/NPC对话驱动叙事场景触发.md`
- Modify: `docs/agent/探索与任务推进.md`
- Modify: `docs/agent/物品与任务奖励.md`
- Modify: `docs/agent/地图与地点冒险.md`
- Modify: `docs/Agent文档索引.md`

**Interfaces:**

- Production provider surface after cleanup: opening/decision calls through `NarrativeBundleSource` only.
- Deterministic fixtures remain test-only and implement the same bundle port.
- Documentation records schema 7 and the battle checkpoint contract.

- [ ] **Step 1: Add final static provider-boundary assertions**

Assert production application/composition files contain no imports or identifiers for:

```text
WorldEvolutionSource
SceneSource
IntentParserSource
generatePendingScene
buildRuleOwnedScene
startChoice
worldBoundaryNeedsPreparation
```

Also assert only `liveNarrativeBundleSource.ts` and the existing shared transport client may call the narrative provider operation.

- [ ] **Step 2: Migrate journey fixtures to bundle fixtures**

Replace separate deterministic evolution/scene sources with one deterministic `NarrativeBundleSource`. Each fixture bundle must pass the same real `approveNarrativeBundle` and coverage validators; do not bypass them with casts or repository injection.

- [ ] **Step 3: Move pure proposal types and delete obsolete provider orchestration**

Remove the temporary `sceneSource.ts` re-exports of `ScenePerformanceSegment`, `ScenePerformanceNpcLine`, `ScenePerformanceNpcDialogue` and `ScenePerformanceObjectiveLink`; their canonical pure definitions remain in `domain/narrativeBundle.ts`, and application/source code imports them from there. Move any opening prompt blocks still required by the unified source into `bundleNarrativeContext.ts`. Replace deterministic world/scene/opening test sources with one data-only `createFixtureNarrativeBundleSource` in `src/game/application/testing/foundationJourney.testutil.ts`, then delete every listed old file. Delete the now-dead `composeDirectNpcGreeting`, `composeDeterministicNpcLine`, `composeIdleNpcLine`, their template constants, exports and tests; fixtures must carry explicit bundle text rather than call a prose composer. Do not leave a second production source factory or narrative builder under a compatibility name.

- [ ] **Step 4: Update gameplay/design documentation**

Document the exact trigger matrix, one logical bundle call, generated-only prose, zero-action objective folding, 12-step cap, no NPC `startChoice`, final-choice ending generation and battle behavior. Remove prior statements that missing continuations may use `source="rule"` or that NPC click may submit an ask provider turn.

- [ ] **Step 5: Run the provider-call acceptance matrix**

Run:

```bash
npx vitest run src/game/application/testing/providerTriggerMatrix.test.ts src/game/application/server/providerTriggerBoundary.test.ts src/game/application/server/compositionRoot.audit.test.ts
```

Expected:

```text
initialization       1 logical bundle
formal fixed choice 1 logical bundle
focus free text     1 logical bundle
all linear actions  0 provider calls
all combat actions  0 provider calls
poll / NPC click    0 provider calls
```

- [ ] **Step 6: Run focused journey acceptance**

Run:

```bash
npx vitest run src/game/application/testing/foundationJourney.test.ts src/game/application/testing/mediumActJourney.test.ts src/game/application/testing/storyDivergenceJourney.test.ts
```

Expected: each journey reaches every NPC with already-ready focus dialogue, traverses all intermediate generated steps without a provider call, and reaches a generated ending after the final formal choice.

- [ ] **Step 7: Run repository-wide verification**

Run:

```bash
npm run lint
npm run typecheck
npm test
npm run test:fast
npm run build
git diff --check
```

Expected: all commands pass.

- [ ] **Step 8: Verify no hidden hardcoded剧情 path remains**

Run:

```bash
rg -n "source:\\s*['\"]rule['\"]|buildRuleOwnedScene|startChoice|worldBoundaryNeedsPreparation|composeDirectNpcGreeting|composeDeterministicNpcLine|composeIdleNpcLine|IDLE_REMINDER_VARIANTS|IDLE_AMBIENT_VARIANTS|你收起了眼前的物品|你完成了物品交接|战斗结果已经由规则结算|你环顾当前地点|你确认了脚下的方向|你按规则记录下眼前的调查结果|行动未能完全达成|你记下了眼前的安排|行动结果已经由规则记录|战斗结算完成" src --glob '!*.test.*' --glob '!*.testutil.*'
rg -n 'createWorldEvolutionSource|createSceneSource|createServerIntentParserSource|generatePendingScene' src --glob '!*.test.*' --glob '!*.testutil.*'
```

Expected: no production matches. Test names may mention removed behavior only in explicit negative source guards.

- [ ] **Step 9: Verify the development save is handled explicitly**

Start the app against the existing v6 database and confirm the API/read model reports `UNSUPPORTED_RECORD` without deleting or rewriting `db/rpg.sqlite`, without creating a pending job and without emitting provider audit events. Start a new v7 game and complete one fixed choice, one custom input, one linear move and one battle with a defeat/retry/victory sequence.

- [ ] **Step 10: Commit documentation and cleanup**

```bash
git add -A src docs/游戏设计原则.md docs/策划文档 docs/agent docs/Agent文档索引.md
git commit -m "docs: finalize decision-boundary narrative architecture"
```

## Final Acceptance Checklist

- [ ] Every normal AI call is attributable to `initialization`, `narrative_choice` or `npc_free_text`.
- [ ] Every retry shares the original logical task identity.
- [ ] Initialization returns a ready first decision without a second scene call.
- [ ] Fixed and free-text decisions each use one unified world-plus-narrative response.
- [ ] Every剧情 action between decisions consumes a generated step; missing steps produce zero writes.
- [ ] NPC cards never submit turns and no `startChoice` exists.
- [ ] Battle rounds are deterministic, player-controlled and AI-free.
- [ ] Defeat/withdraw restores the battle checkpoint; victory consumes the prepared successor.
- [ ] Final formal choice generates the ending through the same boundary mechanism.
- [ ] Production has no hardcoded剧情 prose, `source="rule"`, deterministic narrative fallback or independent intent/world/scene provider.
- [ ] All reachable bundle leaves end at exactly one next decision or ending and the graph has at most 12 steps.
- [ ] Schema 6 is rejected explicitly without hidden migration or database deletion; schema 7 round-trips through SQLite.
