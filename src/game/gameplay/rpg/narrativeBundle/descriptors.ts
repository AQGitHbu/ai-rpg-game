import { npcReferencesFact } from "./resultBoundary";
import type { Action } from "@/game/domain/action";
import type {
  NarrativeBundleTerminal,
  NarrativeBundleTrigger,
} from "@/game/domain/narrativeBundle";
import { narrativeBundleTriggerKey } from "@/game/domain/narrativeBundle";
export { narrativeBundleTriggerKey };
import type { ObjectiveTransition } from "@/game/domain/narrativeBeat";
import type { StoryState } from "@/game/domain/storyState";
import {
  findNpc,
  type QuestObjective,
  type WorldState,
} from "@/game/domain/worldState";
import { locationScaleOf } from "@/game/domain/worldEntity";
import {
  asItemId,
  type FactId,
  type ItemId,
  type LocationId,
  type NpcId,
  type QuestId,
} from "@/game/domain/worldEntity";
import type { PreparedChoiceCandidate, PreparedArrivalNpcContext } from "@/game/gameplay/rpg/preparedContinuation";
import { getEntity, type EntityRecord, type NpcEntityRecord } from "@/game/domain/entity";
import { evaluateStoryCondition } from "@/game/gameplay/rpg/storyInteraction";
import { availableInvestigations } from "@/game/gameplay/rpg/investigation";

export type { PreparedChoiceCandidate, PreparedArrivalNpcContext };

function npcRecord(record: EntityRecord | undefined): NpcEntityRecord | undefined {
  return record?.core.kind === "npc" ? record as NpcEntityRecord : undefined;
}

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
    readonly objectiveIndex: number;
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

export type BuildNarrativeBundleDescriptorsInput = {
  readonly worldState: WorldState;
  readonly storyState: StoryState;
  readonly transition: ObjectiveTransition;
  /** Explicitly requested, structurally approved return to the original giver. */
  readonly includeDeliveryReturn?: boolean;
  /** Explicit B proposal to resume an already visited, adjacent talk objective. */
  readonly includeObjectiveReturn?: boolean;
};

function objectiveKey(questId: QuestId, objectiveIndex: number): string {
  return `${String(questId)}:${objectiveIndex}`;
}

function entityIdsForObjective(objective: QuestObjective): readonly string[] {
  switch (objective.kind) {
    case "visit_location": return [String(objective.locationId)];
    case "talk_to_npc": return [String(objective.npcId)];
    case "obtain_item": return [String(objective.itemId)];
    case "discover_fact": return [String(objective.factId)];
    case "defeat_enemy": return [String(objective.enemyId)];
  }
}

function factIdsForNpc(worldState: WorldState, npcId: NpcId): readonly FactId[] {
  const npc = findNpc(worldState, npcId);
  if (npc === undefined) return [];
  const known = new Set(npc.memory.knownFactIds.map(String));
  return worldState.worldFacts
    .filter((fact) => known.has(String(fact.factId)))
    .map((fact) => fact.factId);
}

function preparedNpcContext(
  worldState: WorldState,
  npc: WorldState["npcs"][number],
): PreparedArrivalNpcContext {
  const knownFactIds = factIdsForNpc(worldState, npc.id);
  const known = new Set(knownFactIds.map(String));
  const knownFactCards = worldState.worldFacts
    .filter((fact) => known.has(String(fact.factId)))
    .map((fact) => ({ factId: fact.factId, text: fact.text }));
  const sceneVisibleFactIds = worldState.worldFacts
    .filter((fact) => fact.discovered)
    .map((fact) => fact.factId);

  const record = npcRecord(getEntity(worldState.entityStore, npc.id));
  const consumedInteractionIds = new Set(worldState.eventLedger.flatMap((event) =>
    event.outcome === "success" && event.payload?.type === "story_interaction_resolved" && event.payload.npcId === npc.id
      ? [event.payload.interactionId] : []));
  const interactionIds = record
    ? record.interactions
      ?.filter((entry) => !consumedInteractionIds.has(entry.id) && entry.condition.every((condition) => evaluateStoryCondition(worldState, condition)))
      .map((entry) => entry.id)
    : undefined;

  return {
    id: npc.id,
    name: npc.name,
    role: npc.role,
    publicProfile: npc.description,
    knownFactCards,
    sceneVisibleFactIds,
    goals: [...npc.memory.goals],
    ...(interactionIds === undefined || interactionIds.length === 0 ? {} : { interactionIds }),
  };
}

function arrivalNpcFor(
  worldState: WorldState,
  objectives: readonly QuestObjective[],
  nextObjectiveIndex: number,
  locationId: LocationId,
): PreparedArrivalNpcContext | undefined {
  // Scan through zero-action objectives (discover_fact) to find the talk_to_npc
  // boundary that marks the next formal decision.
  let idx = nextObjectiveIndex;
  while (idx < objectives.length) {
    const obj = objectives[idx];
    if (obj === undefined) return undefined;
    if (obj.kind === "talk_to_npc") {
      const npc = findNpc(worldState, obj.npcId);
      if (npc === undefined || npc.locationId !== locationId) return undefined;
      return preparedNpcContext(worldState, npc);
    }
    // discover_fact is zero-action — keep scanning
    if (obj.kind !== "discover_fact") return undefined;
    idx += 1;
  }
  return undefined;
}

function authorizedFactIdsForArrivalNpc(
  npc: PreparedArrivalNpcContext,
): readonly FactId[] {
  const ids = new Set([
    ...npc.sceneVisibleFactIds.map(String),
    ...npc.knownFactCards.map((fact) => String(fact.factId)),
  ]);
  return [...ids].map((id) => id as FactId);
}

function deliveryItemForFinalAct(
  worldState: WorldState,
  storyState: StoryState,
  npcId: NpcId,
): ItemId | undefined {
  if (storyState.delivery?.recipientNpcId !== npcId) return undefined;
  if (storyState.currentAct < storyState.targetActs || storyState.contract.delivery === undefined) return undefined;
  const item = worldState.items.find((candidate) =>
    worldState.inventory.includes(candidate.id) && candidate.id === storyState.delivery?.itemId);
  return item?.id ?? undefined;
}

function choicesForNpc(npc: PreparedArrivalNpcContext | undefined, stepKey: string): readonly PreparedChoiceCandidate[] {
  if (npc === undefined) return [];
  const interactionIds = npc.interactionIds ?? [];
  if (interactionIds.length >= 2) {
    return interactionIds.slice(0, 2).map((interactionId, index) => ({
      candidateId: `${stepKey}_interaction_${index + 1}`,
      action: { type: "talk", npcId: npc.id, dialogueAct: "ask", interactionId },
    }));
  }
  if (interactionIds.length === 1) {
    return [
      {
        candidateId: `${stepKey}_interaction_1`,
        action: { type: "talk", npcId: npc.id, dialogueAct: "ask", interactionId: interactionIds[0] },
      },
      {
        candidateId: `${stepKey}_choice_2`,
        action: { type: "talk", npcId: npc.id, dialogueAct: "challenge" },
      },
    ];
  }
  return [
    {
      candidateId: `${stepKey}_choice_1`,
      action: { type: "talk", npcId: npc.id, dialogueAct: "support" } as Action,
    },
    {
      candidateId: `${stepKey}_choice_2`,
      action: { type: "talk", npcId: npc.id, dialogueAct: "challenge" } as Action,
    },
  ];
}

/**
 * A bundle whose next formal decision is already in currentScene still needs
 * server-authored actions.  The provider may supply only the two labels.
 */
function currentSceneChoicesFor(
  worldState: WorldState,
  storyState: StoryState,
  objectives: readonly QuestObjective[],
  startIndex: number,
): readonly PreparedChoiceCandidate[] {
  const narrative = storyState.narrative;
  if (narrative.status === "provider_pending" || narrative.status === "provider_failed") {
    const job = narrative.job;
    const focus = job.focusNpcId === undefined ? undefined : findNpc(worldState, job.focusNpcId);
    if (focus !== undefined && focus.locationId === worldState.currentLocationId) {
      return choicesForNpc(preparedNpcContext(worldState, focus), "current_scene");
    }
    const proof = job.resultBoundaryProof;
    if (proof?.kind === "changed_revisit") {
      const factIds = worldState.eventLedger.filter((event) => proof.sourceEventIds.includes(event.eventId))
        .flatMap((event) => event.payload.type === "fact_discovered" ? [event.payload.factId] : []);
      const related = worldState.npcs.find((npc) => {
        if (npc.locationId !== worldState.currentLocationId) return false;
        const record = npcRecord(getEntity(worldState.entityStore, npc.id));
        return record?.core.lifecycle === "active" && factIds.some((factId) => npcReferencesFact(record, factId));
      });
      if (related !== undefined) return choicesForNpc(preparedNpcContext(worldState, related), "current_scene");
    }
  }
  let index = startIndex;
  while (index < objectives.length) {
    const objective = objectives[index];
    if (objective === undefined) return [];
    if (objective.kind === "discover_fact") {
      const investigationCandidates = availableInvestigations({ worldState, storyState })
        .filter((candidate) => String(candidate.factId) === String(objective.factId));
      if (investigationCandidates.length > 0) {
        return investigationCandidates.map((candidate, candidateIndex) => ({
          candidateId: `current_scene_investigation_${candidateIndex + 1}`,
          action: candidate.action,
        }));
      }
      index += 1;
      continue;
    }
    if (objective.kind !== "talk_to_npc") return [];
    const npc = findNpc(worldState, objective.npcId);
    return npc === undefined ? [] : choicesForNpc(preparedNpcContext(worldState, npc), "current_scene");
  }
  return [];
}

function groupKeyFor(
  questId: QuestId,
  objectiveIndex: number,
  kind: string,
  branchKey: string,
): string {
  const base = `${objectiveKey(questId, objectiveIndex)}:${kind}`;
  return branchKey.length === 0 ? base : `${base}:${branchKey}`;
}

function isAcyclic(descriptors: readonly BundleStepDescriptor[]): boolean {
  const byKey = new Map(descriptors.map((d) => [d.stepKey, d]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string): boolean => {
    if (visiting.has(key)) return false;
    if (visited.has(key)) return true;
    const descriptor = byKey.get(key);
    if (descriptor === undefined) return false;
    visiting.add(key);
    if (!descriptor.nextStepKeys.every(visit)) return false;
    visiting.delete(key);
    visited.add(key);
    return true;
  };
  return descriptors.every((d) => visit(d.stepKey));
}

/**
 * Projects the server-authoritative continuation graph from quest objectives.
 *
 * Key differences from the legacy prepared-continuation walker:
 * - Step keys use `narrativeBundleTriggerKey` (the closed grammar), not ordinal IDs
 * - `discover_fact` objectives are folded (zero-action) into the preceding step
 * - `obtain_item` and `defeat_enemy` stop the fold (they require player actions)
 * - Only `battle_resolved:victory` is generated (defeat/withdraw restore checkpoints)
 * - `talk_to_npc` is the terminal — it stops the walk and marks the step as the
 *   next formal decision boundary
 */
export function buildNarrativeBundleDescriptors(
  input: BuildNarrativeBundleDescriptorsInput,
): BundleDescriptorGraph {
  const { worldState, storyState, transition } = input;
  if (transition.mode === "ready_for_ending" || transition.after === null) {
    return {
      steps: [],
      activeStepKeys: [],
      currentChoiceCandidates: [],
      terminal: { kind: "ending" },
    };
  }

  const quest = worldState.quests.find((q) => q.id === transition.after?.questId);
  if (quest === undefined) {
    return {
      steps: [],
      activeStepKeys: [],
      currentChoiceCandidates: [],
      terminal: { kind: "next_decision", target: { kind: "current_scene" } },
    };
  }

  if (input.includeDeliveryReturn === true && storyState.delivery !== undefined) {
    const { itemId, giverNpcId } = storyState.delivery;
    const item = getEntity(worldState.entityStore, itemId);
    const giver = findNpc(worldState, giverNpcId);
    const owner = item?.core.kind === "item" ? (item as import("@/game/domain/entity").ItemEntityRecord).possession.owner : undefined;
    if (giver !== undefined && giver.locationId === worldState.currentLocationId && owner?.kind === "player") {
      const arrivalNpc = preparedNpcContext(worldState, giver);
      const trigger: NarrativeBundleTrigger = { kind: "give_item", itemId, npcId: giverNpcId };
      const stepKey = narrativeBundleTriggerKey(trigger);
      return { steps: [{ stepKey, objectiveKey: objectiveKey(quest.id, transition.after.objectiveIndex),
        consumptionGroupKey: groupKeyFor(quest.id, transition.after.objectiveIndex, "give_item", "return"),
        trigger, absorbedObjectiveIndexes: [], authority: { questId: quest.id, objectiveIndex: transition.after.objectiveIndex,
          allowedEntityIds: [String(itemId), String(giverNpcId)], visibleFactIds: authorizedFactIdsForArrivalNpc(arrivalNpc) },
        arrivalNpc, choiceCandidates: choicesForNpc(arrivalNpc, stepKey), nextStepKeys: [] }],
        activeStepKeys: [stepKey], currentChoiceCandidates: [], terminal: { kind: "next_decision", target: { kind: "continuation_step", stepKey } } };
    }
  }

  const objective = quest.objectives[transition.after.objectiveIndex];
  const objectiveNpc = objective?.kind === "talk_to_npc" ? findNpc(worldState, objective.npcId) : undefined;
  const currentLocation = worldState.locations.find((location) => location.id === worldState.currentLocationId);
  if (input.includeObjectiveReturn === true && quest.status === "active" && objectiveNpc !== undefined
    && getEntity(worldState.entityStore, objectiveNpc.id)?.core.lifecycle === "active"
    && objectiveNpc.locationId !== worldState.currentLocationId
    && worldState.visitedLocationIds.includes(objectiveNpc.locationId)
    && currentLocation?.connectedLocationIds.includes(objectiveNpc.locationId)) {
    const arrivalNpc = preparedNpcContext(worldState, objectiveNpc);
    const trigger: NarrativeBundleTrigger = { kind: "move", locationId: objectiveNpc.locationId };
    const stepKey = narrativeBundleTriggerKey(trigger);
    return { steps: [{ stepKey, objectiveKey: objectiveKey(quest.id, transition.after.objectiveIndex),
      consumptionGroupKey: groupKeyFor(quest.id, transition.after.objectiveIndex, "move", "objective_return"),
      trigger, absorbedObjectiveIndexes: [], authority: { questId: quest.id, objectiveIndex: transition.after.objectiveIndex,
        allowedEntityIds: [String(objectiveNpc.locationId), String(objectiveNpc.id)], visibleFactIds: authorizedFactIdsForArrivalNpc(arrivalNpc) },
      arrivalNpc, choiceCandidates: choicesForNpc(arrivalNpc, stepKey), nextStepKeys: [] }],
      activeStepKeys: [stepKey], currentChoiceCandidates: [], terminal: { kind: "next_decision", target: { kind: "continuation_step", stepKey } } };
  }

  const descriptors: BundleStepDescriptor[] = [];

  const setSuccessors = (stepKey: string, nextStepKeys: readonly string[]): void => {
    const idx = descriptors.findIndex((d) => d.stepKey === stepKey);
    const desc = descriptors[idx];
    if (desc === undefined) throw new Error(`Unknown descriptor ${stepKey}`);
    descriptors[idx] = { ...desc, nextStepKeys: [...nextStepKeys] };
  };

  const buildObjective = (
    objectiveIndex: number,
    branchKey: string,
    absorbedIndexes: readonly number[],
    activeQuest: typeof quest = quest,
  ): readonly string[] => {
    const objective = activeQuest.objectives[objectiveIndex];
    if (objective === undefined) {
      // Cross-act: look for next act's main quest
      if (activeQuest.id === quest.id && storyState.currentAct < storyState.targetActs) {
        const nextQuest = worldState.quests.find((q) =>
          q.kind === "main" && q.stage === storyState.currentAct + 1,
        );
        return nextQuest === undefined
          ? []
          : buildObjective(0, branchKey, absorbedIndexes, nextQuest);
      }
      return [];
    }

    // talk_to_npc is the terminal — attach its NPC authority and two formal
    // responses to the preceding executable step.  That allows an item or
    // battle resolution to be consumed without another AI call and still
    // land on the server-owned dialogue boundary.
    if (objective.kind === "talk_to_npc") {
      const targetNpc = findNpc(worldState, objective.npcId);
      const targetContext = targetNpc === undefined ? undefined : preparedNpcContext(worldState, targetNpc);
      const deliveryItemId = deliveryItemForFinalAct(worldState, storyState, objective.npcId);
      if (descriptors.length === 0 && deliveryItemId !== undefined && targetContext !== undefined && (targetContext.interactionIds?.length ?? 0) === 0) {
        const trigger: NarrativeBundleTrigger = { kind: "give_item", itemId: deliveryItemId, npcId: objective.npcId };
        const stepKey = narrativeBundleTriggerKey(trigger);
        descriptors.push({ stepKey, objectiveKey: objectiveKey(activeQuest.id, objectiveIndex),
          consumptionGroupKey: groupKeyFor(activeQuest.id, objectiveIndex, "give_item", branchKey), trigger,
          absorbedObjectiveIndexes: [objectiveIndex], authority: { questId: activeQuest.id, objectiveIndex,
            allowedEntityIds: [String(deliveryItemId), String(objective.npcId)], visibleFactIds: authorizedFactIdsForArrivalNpc(targetContext) },
          arrivalNpc: targetContext, choiceCandidates: choicesForNpc(targetContext, stepKey), nextStepKeys: [] });
        return [stepKey];
      }
      const lastDesc = descriptors[descriptors.length - 1];
      if (lastDesc !== undefined) {
        const idx = descriptors.length - 1;
        const npc = findNpc(worldState, objective.npcId);
        const arrivalNpc = npc === undefined ? undefined : preparedNpcContext(worldState, npc);
        descriptors[idx] = {
          ...lastDesc,
          absorbedObjectiveIndexes: [...lastDesc.absorbedObjectiveIndexes, objectiveIndex],
          authority: {
            ...lastDesc.authority,
            allowedEntityIds: [...new Set([
              ...lastDesc.authority.allowedEntityIds,
              ...(arrivalNpc === undefined ? [] : [String(arrivalNpc.id)]),
            ])],
            visibleFactIds: arrivalNpc === undefined
              ? lastDesc.authority.visibleFactIds
              : authorizedFactIdsForArrivalNpc(arrivalNpc),
          },
          ...(arrivalNpc === undefined ? {} : { arrivalNpc }),
          choiceCandidates: choicesForNpc(arrivalNpc, lastDesc.stepKey),
        };
      }
      return [];
    }

    // A town container does not establish arrival at a particular building.
    // Keep one approved arrival boundary before its fact chain, including
    // after world travel or battle; scene items remain explicit pickups.
    if (objective.kind === "discover_fact") {
      const location = worldState.locations.find(entry => entry.id === (worldState.worldFacts.find(fact => fact.factId === objective.factId)?.locationId ?? worldState.currentLocationId));
      const localNpcAhead = location !== undefined && activeQuest.objectives.slice(objectiveIndex + 1).some((entry, index, rest) =>
        entry.kind === "talk_to_npc" && findNpc(worldState, entry.npcId)?.locationId === location.id
        && rest.slice(0, index).every(prior => prior.kind === "discover_fact" || prior.kind === "obtain_item"));
      if (location !== undefined && locationScaleOf(location) === "town" && location.town !== undefined && localNpcAhead
        && !descriptors.some(step => step.trigger.kind === "explore" && step.trigger.locationId === location.id)) {
        const trigger: NarrativeBundleTrigger = { kind: "explore", locationId: location.id };
        const stepKey = narrativeBundleTriggerKey(trigger);
        descriptors.push({ stepKey, objectiveKey: objectiveKey(activeQuest.id, objectiveIndex),
          consumptionGroupKey: groupKeyFor(activeQuest.id, objectiveIndex, "building_arrival", branchKey), trigger,
          absorbedObjectiveIndexes: [],
          authority: { questId: activeQuest.id, objectiveIndex, allowedEntityIds: entityIdsForObjective(objective), visibleFactIds: [] },
          choiceCandidates: [], nextStepKeys: [],
        });
        const nextStepKeys = buildObjective(objectiveIndex, branchKey, absorbedIndexes, activeQuest);
        setSuccessors(stepKey, nextStepKeys);
        return [stepKey];
      }
    }

    // discover_fact: fold into the last created step (zero-action)
    if (objective.kind === "discover_fact") {
      const lastDesc = descriptors[descriptors.length - 1];
      if (lastDesc !== undefined) {
        const idx = descriptors.length - 1;
        descriptors[idx] = {
          ...lastDesc,
          absorbedObjectiveIndexes: [...lastDesc.absorbedObjectiveIndexes, objectiveIndex],
        };
      }
      return buildObjective(objectiveIndex + 1, branchKey, [], activeQuest);
    }

    // visit_location: create a move step, fold discovered facts, find arrival NPC
    if (objective.kind === "visit_location") {
      const trigger: NarrativeBundleTrigger = {
        kind: "move",
        locationId: objective.locationId,
      };
      const stepKey = narrativeBundleTriggerKey(trigger);
      const arrivalLocation = worldState.locations.find(entry => entry.id === objective.locationId);
      const arrivalNpc = arrivalLocation !== undefined && locationScaleOf(arrivalLocation) === "town"
        && activeQuest.objectives[objectiveIndex + 1]?.kind === "discover_fact"
        ? undefined : arrivalNpcFor(
        worldState,
        activeQuest.objectives,
        objectiveIndex + 1,
        objective.locationId,
      );
      const allAbsorbed = [...absorbedIndexes, objectiveIndex];
      const deliveryItemId = arrivalNpc === undefined
        ? undefined
        : deliveryItemForFinalAct(worldState, storyState, arrivalNpc.id);
      descriptors.push({
        stepKey,
        objectiveKey: objectiveKey(activeQuest.id, objectiveIndex),
        consumptionGroupKey: groupKeyFor(activeQuest.id, objectiveIndex, "move", branchKey),
        trigger,
        absorbedObjectiveIndexes: allAbsorbed,
        authority: {
          questId: activeQuest.id,
          objectiveIndex,
          allowedEntityIds: [
            ...entityIdsForObjective(objective),
            ...(arrivalNpc === undefined ? [] : [String(arrivalNpc.id)]),
          ],
          visibleFactIds: arrivalNpc === undefined ? [] : authorizedFactIdsForArrivalNpc(arrivalNpc),
        },
        ...(arrivalNpc === undefined ? {} : { arrivalNpc }),
        choiceCandidates: deliveryItemId === undefined || (arrivalNpc?.interactionIds?.length ?? 0) > 0 ? choicesForNpc(arrivalNpc, stepKey) : [],
        nextStepKeys: [],
      });
      if (arrivalNpc === undefined) {
        // No talk_to_npc boundary ahead — continue folding subsequent objectives
        const nextStepKeys = buildObjective(objectiveIndex + 1, `${branchKey}b${stepKey}`, [], activeQuest);
        setSuccessors(stepKey, nextStepKeys);
        return [stepKey];
      }
      // Arrival NPC found: fold trailing discover_fact and the terminal talk_to_npc
      // into this step's absorbedObjectiveIndexes, unless the final-act delivery
      // contract requires a real give_item action before that dialogue boundary.
      let foldIdx = objectiveIndex + 1;
      while (foldIdx < activeQuest.objectives.length) {
        const foldObj = activeQuest.objectives[foldIdx];
        if (foldObj === undefined) break;
        if (foldObj.kind === "discover_fact") {
          allAbsorbed.push(foldIdx);
          foldIdx += 1;
        } else if (foldObj.kind === "talk_to_npc") {
          if (deliveryItemId === undefined) allAbsorbed.push(foldIdx);
          break;
        } else {
          break;
        }
      }
      const moveDescriptorIndex = descriptors.length - 1;
      descriptors[moveDescriptorIndex] = {
        ...descriptors[moveDescriptorIndex]!,
        absorbedObjectiveIndexes: [...allAbsorbed],
      };
      if (deliveryItemId !== undefined && (arrivalNpc.interactionIds?.length ?? 0) === 0) {
        const giveTrigger: NarrativeBundleTrigger = {
          kind: "give_item",
          itemId: asItemId(deliveryItemId),
          npcId: arrivalNpc.id,
        };
        const giveStepKey = narrativeBundleTriggerKey(giveTrigger);
        descriptors.push({
          stepKey: giveStepKey,
          objectiveKey: objectiveKey(activeQuest.id, foldIdx),
          consumptionGroupKey: groupKeyFor(activeQuest.id, foldIdx, "give_item", branchKey),
          trigger: giveTrigger,
          absorbedObjectiveIndexes: foldIdx < activeQuest.objectives.length ? [foldIdx] : [],
          authority: {
            questId: activeQuest.id,
            objectiveIndex: foldIdx,
            allowedEntityIds: [String(deliveryItemId), String(arrivalNpc.id)],
            visibleFactIds: authorizedFactIdsForArrivalNpc(arrivalNpc),
          },
          arrivalNpc,
          choiceCandidates: choicesForNpc(arrivalNpc, giveStepKey),
          nextStepKeys: [],
        });
        setSuccessors(stepKey, [giveStepKey]);
      }
      return [stepKey];
    }

    // obtain_item: stop fold, create a take_item step
    if (objective.kind === "obtain_item") {
      const trigger: NarrativeBundleTrigger = {
        kind: "take_item",
        itemId: objective.itemId,
      };
      const stepKey = narrativeBundleTriggerKey(trigger);
      const allAbsorbed = [...absorbedIndexes, objectiveIndex];
      descriptors.push({
        stepKey,
        objectiveKey: objectiveKey(activeQuest.id, objectiveIndex),
        consumptionGroupKey: groupKeyFor(activeQuest.id, objectiveIndex, "take_item", branchKey),
        trigger,
        absorbedObjectiveIndexes: allAbsorbed,
        authority: {
          questId: activeQuest.id,
          objectiveIndex,
          allowedEntityIds: entityIdsForObjective(objective),
          visibleFactIds: [],
        },
        choiceCandidates: [],
        nextStepKeys: [],
      });
      const nextStepKeys = buildObjective(objectiveIndex + 1, `${branchKey}t${stepKey}`, [], activeQuest);
      setSuccessors(stepKey, nextStepKeys);
      return [stepKey];
    }

    // defeat_enemy: create battle_started + battle_resolved:victory only
    if (objective.kind === "defeat_enemy") {
      const startedTrigger: NarrativeBundleTrigger = {
        kind: "battle_started",
        enemyId: objective.enemyId,
      };
      const startedKey = narrativeBundleTriggerKey(startedTrigger);
      descriptors.push({
        stepKey: startedKey,
        objectiveKey: objectiveKey(activeQuest.id, objectiveIndex),
        consumptionGroupKey: groupKeyFor(activeQuest.id, objectiveIndex, "battle_started", branchKey),
        trigger: startedTrigger,
        absorbedObjectiveIndexes: [...absorbedIndexes, objectiveIndex],
        authority: {
          questId: activeQuest.id,
          objectiveIndex,
          allowedEntityIds: entityIdsForObjective(objective),
          visibleFactIds: [],
        },
        choiceCandidates: [],
        nextStepKeys: [],
      });

      const victoryTrigger: NarrativeBundleTrigger = {
        kind: "battle_resolved",
        enemyId: objective.enemyId,
        outcome: "victory",
      };
      const victoryKey = narrativeBundleTriggerKey(victoryTrigger);
      const followup = activeQuest.objectives[objectiveIndex + 1];
      const victoryNpc = followup?.kind === "talk_to_npc"
        ? findNpc(worldState, followup.npcId)
        : undefined;
      const victoryNpcContext = victoryNpc === undefined
        ? undefined
        : preparedNpcContext(worldState, victoryNpc);
      descriptors.push({
        stepKey: victoryKey,
        objectiveKey: objectiveKey(activeQuest.id, objectiveIndex),
        consumptionGroupKey: groupKeyFor(activeQuest.id, objectiveIndex, "battle_resolved", branchKey),
        trigger: victoryTrigger,
        absorbedObjectiveIndexes: [],
        authority: {
          questId: activeQuest.id,
          objectiveIndex,
          allowedEntityIds: [
            ...entityIdsForObjective(objective),
            ...(victoryNpcContext === undefined ? [] : [String(victoryNpcContext.id)]),
          ],
          visibleFactIds: victoryNpcContext === undefined ? [] : authorizedFactIdsForArrivalNpc(victoryNpcContext),
        },
        ...(victoryNpcContext === undefined ? {} : { arrivalNpc: victoryNpcContext }),
        choiceCandidates: choicesForNpc(victoryNpcContext, victoryKey),
        nextStepKeys: [],
      });
      const nextStepKeys = buildObjective(objectiveIndex + 1, `${branchKey}v${victoryKey}`, [], activeQuest);
      setSuccessors(victoryKey, nextStepKeys);
      setSuccessors(startedKey, [victoryKey]);
      return [startedKey];
    }

    return [];
  };

  const activeStepKeys = buildObjective(transition.after.objectiveIndex, "", []);
  if (!isAcyclic(descriptors)) throw new Error("Bundle descriptor projection must be acyclic");

  // Determine terminal
  const lastStep = descriptors[descriptors.length - 1];
  let terminal: NarrativeBundleTerminal;
  const currentChoiceCandidates = descriptors.length > 0 ? [] : currentSceneChoicesFor(
    worldState,
    storyState,
    quest.objectives,
    transition.after.objectiveIndex,
  );

  if (descriptors.length === 0) {
    terminal = { kind: "next_decision", target: { kind: "current_scene" } };
  } else if (lastStep?.choiceCandidates.length === 2) {
    // The last step has two choices → it's the next decision boundary
    terminal = { kind: "next_decision", target: { kind: "continuation_step", stepKey: lastStep.stepKey } };
  } else {
    // No explicit NPC boundary found — current scene is the terminal
    terminal = { kind: "next_decision", target: { kind: "current_scene" } };
  }

  return {
    steps: descriptors,
    activeStepKeys,
    currentChoiceCandidates,
    terminal,
  };
}
