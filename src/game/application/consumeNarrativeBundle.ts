import type { Action } from "@/game/domain/action";
import type { GameEvent } from "@/game/domain/events";
import type { ResolvedEvent } from "@/game/domain/resolvedEvent";
import type { NarrativeSceneState } from "@/game/domain/narrative";
import type { StoryState } from "@/game/domain/storyState";
import {
  narrativeBundleTriggerKey,
  type NarrativeBundleState,
  type NarrativeBundleStepState,
  type NarrativeBundleTrigger,
} from "@/game/domain/narrativeBundle";
import { createApprovedChoice, type ApprovedChoice } from "@/game/domain/approvedChoice";
import type { WorldState } from "@/game/domain/worldState";
import type { EnemyId, FactId, ItemId, LocationId, NpcId } from "@/game/domain/worldEntity";

export type ConsumeNarrativeBundleResult =
  | { readonly ok: true; readonly nextWorldState: WorldState; readonly nextStoryState: StoryState }
  | { readonly ok: false; readonly code: "NARRATIVE_CONTINUATION_MISSING" | "NARRATIVE_CONTINUATION_INVALID" };

function triggerFor(action: Action, worldState: WorldState, events: readonly GameEvent[]): NarrativeBundleTrigger | null {
  if (action.type === "move") return { kind: "move", locationId: action.locationId as LocationId };
  if (action.type === "explore") return { kind: "explore", locationId: worldState.currentLocationId as LocationId };
  if (action.type === "investigate") return { kind: "investigate", factId: action.factId as FactId, ...(action.approachId === undefined ? {} : { approachId: action.approachId }) };
  if (action.type === "take_item") return { kind: "take_item", itemId: action.itemId as ItemId };
  if (action.type === "give_item") return { kind: "give_item", itemId: action.itemId as ItemId, npcId: action.npcId as NpcId };
  const battle = events.find((candidate): candidate is Extract<GameEvent, { readonly type: "battle_started" | "battle_resolved" }> =>
    candidate.type === "battle_started" || candidate.type === "battle_resolved");
  if (battle?.type === "battle_started") return { kind: "battle_started", enemyId: battle.enemyId as EnemyId };
  if (battle?.type === "battle_resolved" && battle.outcome === "victory") {
    return { kind: "battle_resolved", enemyId: battle.enemyId as EnemyId, outcome: "victory" };
  }
  return null;
}

export function hasNarrativeBundleMatch(input: {
  readonly worldState: WorldState;
  readonly storyState: StoryState;
  readonly action: Action;
  readonly resolvedEvent: ResolvedEvent;
  readonly domainEvents: readonly GameEvent[];
}): boolean {
  if (input.storyState.narrative.status !== "ready") return false;
  const bundle = input.storyState.narrative.narrativeBundle;
  const trigger = triggerFor(input.action, input.worldState, input.domainEvents);
  if (bundle === undefined || trigger === null) return false;
  const key = narrativeBundleTriggerKey(trigger);
  return bundle.activeStepIds.some((id) => {
    const step = bundle.steps.find((candidate) => candidate.stepId === id);
    return step !== undefined && narrativeBundleTriggerKey(step.trigger) === key;
  });
}

function materializeScene(step: NarrativeBundleStepState, actionId: string, revision: number): { scene: NarrativeSceneState; choiceRegistry: readonly ApprovedChoice[] } | null {
  const sceneId = `scene-bundle-${actionId}-${step.stepId}`;
  const choiceRegistry: ApprovedChoice[] = [];
  for (const seed of step.scene.choiceSeeds) {
    const created = createApprovedChoice({ sceneId, basedOnRevision: revision, label: seed.label, action: seed.action });
    if (!created.ok) return null;
    choiceRegistry.push(created.choice);
  }
  const firstChoiceSeed = step.scene.choiceSeeds[0];
  const dialogueFocusNpcId = step.scene.choiceSeeds.length === 2
    && step.scene.choiceSeeds.every((seed) => seed.action.type === "talk")
    && firstChoiceSeed?.action.type === "talk"
    ? firstChoiceSeed.action.npcId
    : undefined;
  return {
    scene: {
      sceneId,
      turn: revision,
      narration: step.scene.segments.map((segment) => segment.text).join("\n"),
      usedFactIds: step.scene.npcLine?.usedFactIds ?? [],
      npcLine: step.scene.npcLine,
      choices: choiceRegistry.map(({ choiceToken, label }) => ({ choiceToken, label })),
      source: step.scene.source,
      // A travel/item/battle trigger has just been consumed.  If its prepared
      // scene ends at a two-choice NPC boundary, the *presented* scene is now
      // a dialogue boundary; otherwise the following formal choice is treated
      // as an ordinary action and incorrectly looks for another bundle step.
      event: dialogueFocusNpcId !== undefined
        ? { kind: "dialogue", focusNpcId: dialogueFocusNpcId }
        : step.scene.event,
    },
    choiceRegistry,
  };
}

function reachable(bundle: NarrativeBundleState, roots: readonly string[]): Set<string> {
  const byId = new Map(bundle.steps.map((step) => [step.stepId, step]));
  const seen = new Set<string>();
  const visit = (id: string): void => {
    if (seen.has(id)) return;
    const step = byId.get(id);
    if (step === undefined) return;
    seen.add(id);
    step.nextStepIds.forEach(visit);
  };
  roots.forEach(visit);
  return seen;
}

export function consumeNarrativeBundle(input: {
  readonly beforeStoryState: StoryState;
  readonly resolvedWorldState: WorldState;
  readonly resolvedStoryState: StoryState;
  readonly action: Action;
  readonly actionId: string;
  readonly postCommitRevision: number;
  readonly resolvedEvent: ResolvedEvent;
  readonly domainEvents: readonly GameEvent[];
}): ConsumeNarrativeBundleResult {
  if (input.beforeStoryState.narrative.status !== "ready" || input.resolvedStoryState.narrative.status !== "ready") {
    return { ok: false, code: "NARRATIVE_CONTINUATION_INVALID" };
  }
  const bundle = input.beforeStoryState.narrative.narrativeBundle;
  const trigger = triggerFor(input.action, input.resolvedWorldState, input.domainEvents);
  if (bundle === undefined || trigger === null) return { ok: false, code: "NARRATIVE_CONTINUATION_MISSING" };
  const matches = bundle.activeStepIds
    .map((id) => bundle.steps.find((step) => step.stepId === id))
    .filter((step): step is NarrativeBundleStepState => step !== undefined)
    .filter((step) => narrativeBundleTriggerKey(step.trigger) === narrativeBundleTriggerKey(trigger));
  if (matches.length === 0) return { ok: false, code: "NARRATIVE_CONTINUATION_MISSING" };
  if (matches.length !== 1) return { ok: false, code: "NARRATIVE_CONTINUATION_INVALID" };
  const selected = matches[0];
  const materialized = materializeScene(selected, input.actionId, input.postCommitRevision);
  if (materialized === null) return { ok: false, code: "NARRATIVE_CONTINUATION_INVALID" };
  const remainder = bundle.steps.filter((step) => step.consumptionGroupKey !== selected.consumptionGroupKey);
  const nextRoots = selected.nextStepIds.filter((id) => remainder.some((step) => step.stepId === id));
  const remainderBundle: NarrativeBundleState = { ...bundle, steps: remainder, activeStepIds: nextRoots };
  const visible = reachable(remainderBundle, nextRoots);
  const nextBundle = { ...remainderBundle, steps: remainder.filter((step) => visible.has(step.stepId)), activeStepIds: nextRoots.filter((id) => visible.has(id)) };
  const { narrativeBundle: _oldBundle, battleCheckpoint: _checkpoint, ...narrative } = input.resolvedStoryState.narrative;
  const nextNarrative = {
    ...narrative,
    status: "ready" as const,
    currentScene: materialized.scene,
    choiceRegistry: materialized.choiceRegistry,
    ...(nextBundle.steps.length > 0 ? { narrativeBundle: nextBundle } : {}),
  };
  return { ok: true, nextWorldState: input.resolvedWorldState, nextStoryState: { ...input.resolvedStoryState, narrative: nextNarrative } };
}
