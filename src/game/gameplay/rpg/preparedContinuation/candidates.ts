import type { Action } from "@/game/domain/action";
import type {
  PreparedContinuationTrigger,
} from "@/game/domain/preparedContinuation";
import type { ObjectiveTransition } from "@/game/domain/narrativeBeat";
import type { StoryState } from "@/game/domain/storyState";
import {
  findNpc,
  type QuestObjective,
  type WorldState,
} from "@/game/domain/worldState";
import type {
  EnemyId,
  FactId,
  LocationId,
  NpcId,
  QuestId,
} from "@/game/domain/worldEntity";
import { preparedContinuationTriggerKey as domainPreparedTriggerKey } from "@/game/domain/preparedContinuation";

export type PreparedChoiceCandidate = {
  readonly candidateId: string;
  readonly action: Action;
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

export type BuildPreparedStepDescriptorsInput = {
  readonly worldState: WorldState;
  readonly storyState: StoryState;
  readonly transition: ObjectiveTransition;
};

export type BuildPreparedStepDescriptorsResult = {
  readonly descriptors: readonly PreparedStepDescriptor[];
  readonly activeStepIds: readonly string[];
};

export function preparedTriggerKey(trigger: PreparedContinuationTrigger): string {
  return domainPreparedTriggerKey(trigger);
}

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

function arrivalNpcFor(
  worldState: WorldState,
  objectives: readonly QuestObjective[],
  nextObjectiveIndex: number,
  locationId: LocationId,
): PreparedArrivalNpcContext | undefined {
  const next = objectives[nextObjectiveIndex];
  if (next?.kind !== "talk_to_npc") return undefined;
  const npc = findNpc(worldState, next.npcId);
  if (npc === undefined || npc.locationId !== locationId) return undefined;

  const knownFactIds = factIdsForNpc(worldState, npc.id);
  const known = new Set(knownFactIds.map(String));
  const knownFactCards = worldState.worldFacts
    .filter((fact) => known.has(String(fact.factId)))
    .map((fact) => ({ factId: fact.factId, text: fact.text }));
  const sceneVisibleFactIds = worldState.worldFacts
    .filter((fact) => fact.discovered)
    .map((fact) => fact.factId);

  return {
    id: npc.id,
    name: npc.name,
    role: npc.role,
    publicProfile: npc.description,
    knownFactCards,
    sceneVisibleFactIds,
    goals: [...npc.memory.goals],
  };
}

function choicesForNpc(npc: PreparedArrivalNpcContext | undefined, stepId: string): readonly PreparedChoiceCandidate[] {
  if (npc === undefined) return [];
  return [
    {
      candidateId: `${stepId}_choice_1`,
      action: { type: "talk", npcId: npc.id, dialogueAct: "support" },
    },
    {
      candidateId: `${stepId}_choice_2`,
      action: { type: "talk", npcId: npc.id, dialogueAct: "challenge" },
    },
  ];
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

function isAcyclic(descriptors: readonly PreparedStepDescriptor[]): boolean {
  const byId = new Map(descriptors.map((descriptor) => [descriptor.stepId, descriptor]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (stepId: string): boolean => {
    if (visiting.has(stepId)) return false;
    if (visited.has(stepId)) return true;
    const descriptor = byId.get(stepId);
    if (descriptor === undefined) return false;
    visiting.add(stepId);
    if (!descriptor.nextStepIds.every(visit)) return false;
    visiting.delete(stepId);
    visited.add(stepId);
    return true;
  };
  return descriptors.every((descriptor) => visit(descriptor.stepId));
}

/**
 * Projects only server-authoritative future choices. The walk is finite by
 * objective order and stops as soon as the next NPC decision is prepared.
 */
export function buildPreparedStepDescriptors(
  input: BuildPreparedStepDescriptorsInput,
): BuildPreparedStepDescriptorsResult {
  const { worldState, transition } = input;
  if (transition.after === null) return { descriptors: [], activeStepIds: [] };

  const quest = worldState.quests.find((candidate) => candidate.id === transition.after?.questId);
  if (quest === undefined) return { descriptors: [], activeStepIds: [] };

  const descriptors: PreparedStepDescriptor[] = [];
  let nextOrdinal = 1;

  const createDescriptor = (inputDescriptor: Omit<PreparedStepDescriptor, "stepId" | "nextStepIds">): string => {
    const stepId = `prepared_${nextOrdinal}`;
    nextOrdinal += 1;
    descriptors.push({ ...inputDescriptor, stepId, nextStepIds: [] });
    return stepId;
  };

  const setSuccessors = (stepId: string, nextStepIds: readonly string[]): void => {
    const index = descriptors.findIndex((descriptor) => descriptor.stepId === stepId);
    const descriptor = descriptors[index];
    if (descriptor === undefined) throw new Error(`Unknown prepared descriptor ${stepId}`);
    descriptors[index] = { ...descriptor, nextStepIds: [...nextStepIds] };
  };

  const buildObjective = (objectiveIndex: number, branchKey: string): readonly string[] => {
    const objective = quest.objectives[objectiveIndex];
    if (objective === undefined) return [];

    if (objective.kind === "talk_to_npc" || objective.kind === "obtain_item") return [];

    if (objective.kind === "visit_location") {
      const trigger: PreparedContinuationTrigger = {
        kind: "move",
        locationId: objective.locationId,
      };
      const arrivalNpc = arrivalNpcFor(worldState, quest.objectives, objectiveIndex + 1, objective.locationId);
      const stepId = createDescriptor({
        objectiveKey: objectiveKey(quest.id, objectiveIndex),
        consumptionGroupKey: groupKeyFor(quest.id, objectiveIndex, "move", branchKey),
        trigger,
        authority: {
          questId: quest.id,
          objectiveIndex,
          allowedEntityIds: [
            ...entityIdsForObjective(objective),
            ...(arrivalNpc === undefined ? [] : [String(arrivalNpc.id)]),
          ],
          visibleFactIds: arrivalNpc?.sceneVisibleFactIds ?? [],
        },
        ...(arrivalNpc === undefined ? {} : { arrivalNpc }),
        choiceCandidates: choicesForNpc(arrivalNpc, `prepared_${nextOrdinal}`),
      });
      const nextStepIds = arrivalNpc === undefined
        ? buildObjective(objectiveIndex + 1, `${branchKey}b${stepId}`)
        : [];
      setSuccessors(stepId, nextStepIds);
      return [stepId];
    }

    if (objective.kind === "discover_fact") {
      const fact = worldState.worldFacts.find((candidate) => candidate.factId === objective.factId);
      const approaches = fact?.investigationApproaches?.length
        ? fact.investigationApproaches
        : [undefined];
      const stepIds: string[] = [];
      for (let variantIndex = 0; variantIndex < approaches.length; variantIndex += 1) {
        const approach = approaches[variantIndex];
        const trigger: PreparedContinuationTrigger = approach === undefined
          ? { kind: "investigate", factId: objective.factId }
          : { kind: "investigate", factId: objective.factId, approachId: approach.approachId };
        const stepId = createDescriptor({
          objectiveKey: objectiveKey(quest.id, objectiveIndex),
          consumptionGroupKey: groupKeyFor(quest.id, objectiveIndex, "investigate", branchKey),
          trigger,
          authority: {
            questId: quest.id,
            objectiveIndex,
            allowedEntityIds: entityIdsForObjective(objective),
            visibleFactIds: [],
          },
          choiceCandidates: [],
        });
        const nextStepIds = buildObjective(objectiveIndex + 1, `${branchKey}v${variantIndex + 1}`);
        setSuccessors(stepId, nextStepIds);
        stepIds.push(stepId);
      }
      return stepIds;
    }

    if (objective.kind === "defeat_enemy") {
      const startedId = createDescriptor({
        objectiveKey: objectiveKey(quest.id, objectiveIndex),
        consumptionGroupKey: groupKeyFor(quest.id, objectiveIndex, "battle_started", branchKey),
        trigger: { kind: "battle_started", enemyId: objective.enemyId },
        authority: {
          questId: quest.id,
          objectiveIndex,
          allowedEntityIds: entityIdsForObjective(objective),
          visibleFactIds: [],
        },
        choiceCandidates: [],
      });
      const outcomeIds: string[] = [];
      for (const outcome of ["victory", "defeat", "withdraw"] as const) {
        const trigger: PreparedContinuationTrigger = {
          kind: "battle_resolved",
          enemyId: objective.enemyId,
          outcome,
        };
        const outcomeId = createDescriptor({
          objectiveKey: objectiveKey(quest.id, objectiveIndex),
          consumptionGroupKey: groupKeyFor(quest.id, objectiveIndex, "battle_resolved", branchKey),
          trigger,
          authority: {
            questId: quest.id,
            objectiveIndex,
            allowedEntityIds: entityIdsForObjective(objective),
            visibleFactIds: [],
          },
          choiceCandidates: [],
        });
        const nextStepIds = buildObjective(objectiveIndex + 1, `${branchKey}o${outcome}`);
        setSuccessors(outcomeId, nextStepIds);
        outcomeIds.push(outcomeId);
      }
      setSuccessors(startedId, outcomeIds);
      return [startedId];
    }

    return [];
  };

  const activeStepIds = buildObjective(transition.after.objectiveIndex, "");
  if (!isAcyclic(descriptors)) throw new Error("Prepared continuation projection must be acyclic");
  return { descriptors, activeStepIds };
}
