import type { Action } from "@/game/domain/action";
import type { GameEvent } from "@/game/domain/events";
import type { ResolvedEvent } from "@/game/domain/resolvedEvent";
import type { NarrativeSceneState } from "@/game/domain/narrative";
import type { StoryState } from "@/game/domain/storyState";
import {
  createPreparedContinuationState,
  NARRATIVE_CONTINUATION_INVALID,
  NARRATIVE_CONTINUATION_MISSING,
  preparedContinuationTriggerKey,
  type PreparedContinuationErrorCode,
  type PreparedContinuationState,
  type PreparedContinuationStepState,
  type PreparedContinuationTrigger,
} from "@/game/domain/preparedContinuation";
import { createApprovedChoice, type ApprovedChoice } from "@/game/domain/approvedChoice";
import type { WorldState } from "@/game/domain/worldState";
import type { EnemyId, FactId, LocationId } from "@/game/domain/worldEntity";

export type ConsumePreparedContinuationResult =
  | { readonly ok: true; readonly nextWorldState: WorldState; readonly nextStoryState: StoryState }
  | { readonly ok: false; readonly code: PreparedContinuationErrorCode };

function battleEventFor(
  events: readonly GameEvent[],
): Extract<GameEvent, { readonly type: "battle_started" | "battle_resolved" }> | undefined {
  return events.find((event): event is Extract<GameEvent, { readonly type: "battle_started" | "battle_resolved" }> =>
    event.type === "battle_started" || event.type === "battle_resolved");
}

function triggerFor(
  action: Action,
  resolvedEvent: ResolvedEvent,
  events: readonly GameEvent[],
): PreparedContinuationTrigger | null {
  if (action.type === "move") return { kind: "move", locationId: action.locationId as LocationId };
  if (action.type === "investigate") {
    return { kind: "investigate", factId: action.factId as FactId, ...(action.approachId === undefined ? {} : { approachId: action.approachId }) };
  }
  if (resolvedEvent.eventKind !== "battle") return null;
  const battleEvent = battleEventFor(events);
  if (battleEvent === undefined) return null;
  if (battleEvent.type === "battle_started") {
    return { kind: "battle_started", enemyId: battleEvent.enemyId as EnemyId };
  }
  return {
    kind: "battle_resolved",
    enemyId: battleEvent.enemyId as EnemyId,
    outcome: battleEvent.outcome,
  };
}

export function hasPreparedContinuationMatch(input: {
  readonly storyState: StoryState;
  readonly action: Action;
  readonly resolvedEvent: ResolvedEvent;
  readonly domainEvents: readonly GameEvent[];
}): boolean {
  if (input.storyState.narrative.status !== "ready") return false;
  const prepared = input.storyState.narrative.preparedContinuation;
  const trigger = triggerFor(input.action, input.resolvedEvent, input.domainEvents);
  if (prepared === undefined || trigger === null) return false;
  const key = preparedContinuationTriggerKey(trigger);
  return prepared.activeStepIds.some((stepId) => {
    const step = prepared.steps.find((candidate) => candidate.stepId === stepId);
    return step !== undefined && preparedContinuationTriggerKey(step.trigger) === key;
  });
}

function reachableStepIds(
  state: PreparedContinuationState,
  roots: readonly string[],
): Set<string> {
  const byId = new Map(state.steps.map((step) => [step.stepId, step]));
  const reachable = new Set<string>();
  const visit = (stepId: string): void => {
    if (reachable.has(stepId)) return;
    const step = byId.get(stepId);
    if (step === undefined) return;
    reachable.add(stepId);
    step.nextStepIds.forEach(visit);
  };
  roots.forEach(visit);
  return reachable;
}

function sceneForStep(
  step: PreparedContinuationStepState,
  actionId: string,
  revision: number,
): { readonly scene: NarrativeSceneState; readonly choiceRegistry: ApprovedChoice[] } | null {
  const sceneId = `scene-prepared-${actionId}-${step.stepId}`;
  const choiceRegistry: ApprovedChoice[] = [];
  for (const seed of step.scene.choiceSeeds) {
    const approved = createApprovedChoice({
      sceneId,
      basedOnRevision: revision,
      label: seed.label,
      action: seed.action,
    });
    if (!approved.ok) return null;
    choiceRegistry.push(approved.choice);
  }
  const scene: NarrativeSceneState = {
    sceneId,
    turn: revision,
    narration: step.scene.segments.map((segment) => segment.text).join("\n"),
    usedFactIds: step.scene.npcLine?.usedFactIds ?? [],
    npcLine: step.scene.npcLine,
    choices: choiceRegistry.map((choice) => ({ choiceToken: choice.choiceToken, label: choice.label })),
    source: step.scene.source,
    event: step.scene.event,
  };
  return { scene, choiceRegistry };
}

function sceneAuthorityMatches(
  step: PreparedContinuationStepState,
  trigger: PreparedContinuationTrigger,
  resolvedWorldState: WorldState,
): boolean {
  const event = step.scene.event;
  switch (trigger.kind) {
    case "move":
      return event.kind === "travel"
        && String(event.locationId) === String(trigger.locationId)
        && String(resolvedWorldState.currentLocationId) === String(trigger.locationId);
    case "investigate":
      return event.kind === "investigate"
        && String(event.factId) === String(trigger.factId)
        && resolvedWorldState.worldFacts.some((fact) => (
          String(fact.factId) === String(trigger.factId) && fact.discovered
        ));
    case "battle_started":
    case "battle_resolved":
      return event.kind === "battle"
        && String(event.enemyId) === String(trigger.enemyId);
  }
}

export function consumePreparedContinuation(input: {
  readonly beforeWorldState: WorldState;
  readonly beforeStoryState: StoryState;
  readonly resolvedWorldState: WorldState;
  readonly resolvedStoryState: StoryState;
  readonly action: Action;
  readonly postCommitRevision: number;
  readonly resolvedEvent: ResolvedEvent;
  readonly domainEvents: readonly GameEvent[];
  readonly now: () => string;
}): ConsumePreparedContinuationResult {
  void input.beforeWorldState;
  void input.now;
  if (input.beforeStoryState.narrative.status !== "ready"
    || input.resolvedStoryState.narrative.status !== "ready") {
    return { ok: false, code: NARRATIVE_CONTINUATION_INVALID };
  }
  const prepared = input.beforeStoryState.narrative.preparedContinuation;
  const trigger = triggerFor(input.action, input.resolvedEvent, input.domainEvents);
  if (prepared === undefined || trigger === null) return { ok: false, code: NARRATIVE_CONTINUATION_MISSING };
  if (!createPreparedContinuationState(prepared).ok) {
    return { ok: false, code: NARRATIVE_CONTINUATION_INVALID };
  }
  const key = preparedContinuationTriggerKey(trigger);
  const matches = prepared.activeStepIds
    .map((stepId) => prepared.steps.find((step) => step.stepId === stepId))
    .filter((step): step is PreparedContinuationStepState => step !== undefined)
    .filter((step) => preparedContinuationTriggerKey(step.trigger) === key);
  if (matches.length === 0) return { ok: false, code: NARRATIVE_CONTINUATION_MISSING };
  if (matches.length !== 1) return { ok: false, code: NARRATIVE_CONTINUATION_INVALID };
  const step = matches[0]!;

  const matchedTrigger = step.trigger;
  if (!sceneAuthorityMatches(step, matchedTrigger, input.resolvedWorldState)) {
    return { ok: false, code: NARRATIVE_CONTINUATION_INVALID };
  }
  const materialized = sceneForStep(step, input.resolvedEvent.actionId, input.postCommitRevision);
  if (materialized === null) return { ok: false, code: NARRATIVE_CONTINUATION_INVALID };

  const consumedGroup = step.consumptionGroupKey;
  const remaining = prepared.steps.filter((candidate) => candidate.consumptionGroupKey !== consumedGroup);
  const nextRoots = step.nextStepIds.filter((stepId) => remaining.some((candidate) => candidate.stepId === stepId));
  const remainingState: PreparedContinuationState = {
    originJobId: prepared.originJobId,
    steps: remaining,
    activeStepIds: nextRoots,
  };
  const reachable = reachableStepIds(remainingState, nextRoots);
  const nextPrepared = {
    ...remainingState,
    steps: remaining.filter((candidate) => reachable.has(candidate.stepId)),
    activeStepIds: nextRoots.filter((stepId) => reachable.has(stepId)),
  };
  const { preparedContinuation: _consumed, ...narrativeWithoutPrepared } = input.resolvedStoryState.narrative;
  const nextStoryState: StoryState = {
    ...input.resolvedStoryState,
    narrative: {
      ...narrativeWithoutPrepared,
      status: "ready",
      currentScene: materialized.scene,
      choiceRegistry: materialized.choiceRegistry,
      ...(nextPrepared.steps.length === 0
        ? {}
        : { preparedContinuation: nextPrepared }),
    },
  };
  return { ok: true, nextWorldState: input.resolvedWorldState, nextStoryState };
}
