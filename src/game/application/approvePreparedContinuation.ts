import type {
  PreparedContinuationProposal,
  ScenePerformanceNpcLine,
  ScenePerformanceObjectiveLink,
  ScenePerformanceSegment,
} from "./sceneSource";
import type {
  NarrativeEventState,
  NarrativeNpcLineState,
} from "@/game/domain/narrative";
import {
  createPreparedContinuationState,
  type PreparedContinuationState,
  type PreparedContinuationStepState,
  type PreparedNarrativeSegmentState,
  type PreparedObjectiveLinkState,
} from "@/game/domain/preparedContinuation";
import { asEnemyId, asFactId, asLocationId, asNpcId, asQuestId } from "@/game/domain/worldEntity";
import type { NarrativeJobId } from "@/game/domain/events";
import type { WorldState } from "@/game/domain/worldState";
import type { PreparedStepDescriptor } from "@/game/gameplay/rpg/preparedContinuation";
import {
  buildNpcSpeechAuthority,
  isValidNpcSpeechTarget,
  validateNpcSpeechReferences,
  type NpcSpeechAuthority,
} from "./npcSpeechAuthority";
import { entitiesOfKind } from "@/game/domain/entity";
import { PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";

export type PreparedContinuationRejection =
  | "missing_step"
  | "duplicate_step"
  | "unknown_step"
  | "invalid_graph"
  | "invalid_entity_reference"
  | "invalid_fact_reference"
  | "invalid_interaction_reference"
  | "duplicate_npc_reference"
  | "invalid_choice_count"
  | "invalid_choice_candidate";

export type ApprovePreparedContinuationResult =
  | { readonly ok: true; readonly prepared: PreparedContinuationState }
  | { readonly ok: false; readonly code: PreparedContinuationRejection };

type PreparedApprovalDescriptor = Omit<PreparedStepDescriptor, "arrivalNpc"> & Readonly<{
  readonly arrivalNpc?: NonNullable<PreparedStepDescriptor["arrivalNpc"]> & Readonly<{
    readonly speechAuthority?: NpcSpeechAuthority;
  }>;
}>;

function eventForTrigger(descriptor: PreparedStepDescriptor): NarrativeEventState {
  switch (descriptor.trigger.kind) {
    case "move":
      return { kind: "travel", locationId: asLocationId(descriptor.trigger.locationId) };
    case "investigate":
      return { kind: "investigate", factId: asFactId(descriptor.trigger.factId) };
    case "battle_started":
    case "battle_resolved":
      return { kind: "battle", enemyId: asEnemyId(descriptor.trigger.enemyId) };
  }
}

function rebuildNpcLine(
  line: ScenePerformanceNpcLine | null,
  descriptor: PreparedApprovalDescriptor,
  worldState?: WorldState,
): NarrativeNpcLineState | { readonly code: PreparedContinuationRejection } | null {
  if (line === null) return null;
  if (!descriptor.authority.allowedEntityIds.some((entityId) => String(entityId) === String(line.npcId))) {
    return { code: "invalid_entity_reference" };
  }
  if (descriptor.arrivalNpc !== undefined && String(line.npcId) !== String(descriptor.arrivalNpc.id)) {
    return { code: "invalid_entity_reference" };
  }
  if (!Array.isArray(line.usedFactIds)) return { code: "invalid_fact_reference" };
  if (!Array.isArray(line.usedInteractionActionIds)) return { code: "invalid_interaction_reference" };
  const arrivalSpeechAuthority = descriptor.arrivalNpc?.speechAuthority;
  if (arrivalSpeechAuthority !== undefined
    && String(arrivalSpeechAuthority.speakerNpcId) !== String(line.npcId)) {
    return { code: "invalid_entity_reference" };
  }
  if (worldState !== undefined && !isValidNpcSpeechTarget(worldState.entityStore, PLAYER_ENTITY_ID)) {
    return { code: "invalid_entity_reference" };
  }
  const worldSpeechAuthority = worldState !== undefined
    ? buildNpcSpeechAuthority({
      store: worldState.entityStore,
      speakerNpcId: line.npcId as never,
      sceneVisibleFactIds: entitiesOfKind(worldState.entityStore, "fact")
        .filter((fact) => fact.fact.discovered)
        .map((fact) => fact.core.id),
      targetContext: { targetId: PLAYER_ENTITY_ID },
    })
    : undefined;
  if (worldState !== undefined && worldSpeechAuthority === null) {
    return { code: "invalid_entity_reference" };
  }
  const speechAuthority = worldSpeechAuthority ?? arrivalSpeechAuthority;
  if (speechAuthority === undefined) return { code: "invalid_entity_reference" };
  const referenceCheck = validateNpcSpeechReferences({
    authority: speechAuthority,
    usedFactIds: line.usedFactIds,
    usedInteractionActionIds: line.usedInteractionActionIds,
  });
  if (!referenceCheck.ok) {
    return { code: referenceCheck.code };
  }
  return {
    npcId: asNpcId(line.npcId),
    text: line.text.trim(),
    emotion: line.emotion,
    usedFactIds: line.usedFactIds.map(asFactId),
    usedInteractionActionIds: [...line.usedInteractionActionIds],
    answeredBeatIds: [...line.answeredBeatIds],
  };
}

function rebuildObjectiveLink(
  link: ScenePerformanceObjectiveLink | null,
  descriptor: PreparedApprovalDescriptor,
): PreparedObjectiveLinkState | null | undefined {
  if (link === null) return null;
  if (String(link.questId) !== String(descriptor.authority.questId)
    || link.objectiveIndex !== descriptor.authority.objectiveIndex) return undefined;
  return {
    questId: asQuestId(link.questId),
    objectiveIndex: link.objectiveIndex,
    mode: link.mode,
  };
}

function rebuildSegments(segments: readonly ScenePerformanceSegment[]): readonly PreparedNarrativeSegmentState[] | null {
  if (segments.length === 0) return null;
  const result: PreparedNarrativeSegmentState[] = [];
  for (const segment of segments) {
    if (segment.beatId.trim() === "" || segment.text.trim() === "") return null;
    result.push({
      beatId: segment.beatId,
      text: segment.text.trim(),
      ...(segment.referencedEntityIds === undefined
        ? {}
        : { referencedEntityIds: [...segment.referencedEntityIds] }),
    });
  }
  return result;
}

function rebuildStep(
  proposal: PreparedContinuationProposal,
  descriptor: PreparedApprovalDescriptor,
  worldState?: WorldState,
): PreparedContinuationStepState | { readonly code: PreparedContinuationRejection } {
  const segments = rebuildSegments(proposal.segments);
  if (segments === null) return { code: "invalid_graph" };
  const npcLine = rebuildNpcLine(proposal.npcLine, descriptor, worldState);
  if (proposal.npcLine !== null && npcLine === null) return { code: "invalid_entity_reference" };
  if (npcLine !== null && "code" in npcLine) return npcLine;
  const objectiveLink = rebuildObjectiveLink(proposal.objectiveLink, descriptor);
  if (objectiveLink === undefined) return { code: "invalid_entity_reference" };

  if (proposal.choices.length !== descriptor.choiceCandidates.length) {
    return { code: "invalid_choice_count" };
  }
  const expectedCandidates = new Map(descriptor.choiceCandidates.map((candidate) => [candidate.candidateId, candidate]));
  const choiceSeeds = proposal.choices.map((choice) => {
    const expected = expectedCandidates.get(choice.candidateId);
    if (expected === undefined || choice.label.trim() === "") return null;
    return { label: choice.label.trim(), action: expected.action };
  });
  if (choiceSeeds.some((choice) => choice === null)
    || new Set(proposal.choices.map((choice) => choice.candidateId)).size !== proposal.choices.length) {
    return { code: "invalid_choice_candidate" };
  }

  return {
    stepId: descriptor.stepId,
    objectiveKey: descriptor.objectiveKey,
    consumptionGroupKey: descriptor.consumptionGroupKey,
    trigger: descriptor.trigger,
    scene: {
      segments,
      event: eventForTrigger(descriptor),
      npcLine,
      objectiveLink,
      choiceSeeds: choiceSeeds as NonNullable<typeof choiceSeeds[number]>[],
      source: proposal.source ?? "generated",
    },
    nextStepIds: [...descriptor.nextStepIds],
  };
}

export function approvePreparedContinuation(input: {
  readonly originJobId: NarrativeJobId;
  readonly proposals: readonly PreparedContinuationProposal[];
  readonly descriptors: readonly PreparedApprovalDescriptor[];
  readonly activeStepIds: readonly string[];
  readonly worldState?: WorldState;
}): ApprovePreparedContinuationResult {
  const descriptorsById = new Map(input.descriptors.map((descriptor) => [descriptor.stepId, descriptor]));
  if (descriptorsById.size !== input.descriptors.length) return { ok: false, code: "duplicate_step" };
  if (new Set(input.activeStepIds).size !== input.activeStepIds.length
    || input.activeStepIds.some((stepId) => !descriptorsById.has(stepId))) {
    return { ok: false, code: "invalid_graph" };
  }
  if (input.proposals.length !== input.descriptors.length) return { ok: false, code: "missing_step" };

  const proposalsById = new Map<string, PreparedContinuationProposal>();
  for (const proposal of input.proposals) {
    if (proposalsById.has(proposal.stepId)) return { ok: false, code: "duplicate_step" };
    if (!descriptorsById.has(proposal.stepId)) return { ok: false, code: "unknown_step" };
    proposalsById.set(proposal.stepId, proposal);
  }

  const steps: PreparedContinuationStepState[] = [];
  for (const descriptor of input.descriptors) {
    const proposal = proposalsById.get(descriptor.stepId);
    if (proposal === undefined) return { ok: false, code: "missing_step" };
    const rebuilt = rebuildStep(proposal, descriptor, input.worldState);
    if ("code" in rebuilt) return { ok: false, code: rebuilt.code };
    steps.push(rebuilt);
  }

  const parsed = createPreparedContinuationState({
    originJobId: input.originJobId,
    steps,
    activeStepIds: [...input.activeStepIds],
  });
  return parsed.ok ? { ok: true, prepared: parsed.value } : { ok: false, code: "invalid_graph" };
}
