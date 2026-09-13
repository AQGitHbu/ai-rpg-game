import {
  getEntity,
  canNpcDiscloseFact,
  hasCommittedConfidentialityPermission,
  hasCommittedDisclosureToPlayer,
  type DirectedRelationshipEdge,
  type EntityRecord,
  type EntityStore,
  type NpcEntityRecord,
  type NpcIdentityAnchors,
  type RelationshipCommitment,
  type RelationshipStage,
  type RelationshipTrend,
} from "@/game/domain/entity";
import type { NpcInteraction } from "@/game/domain/worldEntries";
import type { FactId, NpcId, PlayerEntityId } from "@/game/domain/worldEntity";
import { isWellFormedEventId, type CommittedNarrativeEvent, type EventId } from "@/game/domain/events";
import { relationshipTierOf, type RelationshipTier } from "@/game/domain/relationship";
import {
  areUniqueNpcSpeechReferenceIds,
  isWellFormedNpcSpeechReferenceId,
} from "@/game/domain/npcSpeechReferences";
import { parseStoryInteractionProposal, type StoryInteractionProposal } from "@/game/domain/storyInteraction";
import type {
  NpcDeliberationProposal,
  NpcDeliberationResponse,
} from "./npcDeliberationSource";

export type NpcSpeechReferenceRejection =
  | "duplicate_npc_reference"
  | "invalid_fact_reference"
  | "invalid_interaction_reference"
  | "invalid_event_reference";

export type NpcSpeechReferenceAuthority = Pick<
  NpcSpeechAuthority,
  "allowedFactIds" | "allowedEventIds"
>;

/** The only context used to decide which references a speaker may expose. */
export type NpcSpeechAuthorityInput = Readonly<{
  readonly store: EntityStore;
  readonly speakerNpcId: NpcId;
  readonly sceneVisibleFactIds: readonly FactId[];
  /** Optional only for isolated legacy projections; production callers pass the authoritative ledger. */
  readonly eventLedger?: readonly CommittedNarrativeEvent[];
  readonly targetContext?: Readonly<{
    readonly targetId?: PlayerEntityId | NpcId;
    readonly interactionEventIds?: readonly EventId[];
    /** Current committed job events, independently checked for speaker participation. */
    readonly currentEventIds?: readonly EventId[];
  }>;
}>;

export type NpcSpeechRelationship = Readonly<{
  readonly targetId: DirectedRelationshipEdge["targetId"];
  readonly stage: RelationshipStage;
  readonly trend: RelationshipTrend;
  readonly openCommitments: readonly NpcSpeechCommitment[];
}>;

export type NpcSpeechCommitment = Readonly<{
  readonly kind: RelationshipCommitment["kind"];
  readonly commitmentId: string;
  readonly description: string;
  readonly direction?: "source_owes_target" | "target_owes_source";
  readonly promisor?: "source" | "target";
}>;

export type NpcSpeechInteraction = Readonly<{
  readonly eventId: EventId;
  readonly actionId: string;
  readonly dialogueAct: NpcInteraction["dialogueAct"];
  readonly topicSummary: string;
  readonly outcome: NpcInteraction["outcome"];
  readonly summary: string;
}>;

export type NpcSpeechFactCard = Readonly<{
  readonly factId: FactId;
  readonly text: string;
}>;

export type NpcSpeechAuthority = Readonly<{
  readonly speakerNpcId: NpcId;
  readonly responseTier: RelationshipTier;
  readonly allowedFactIds: readonly FactId[];
  readonly withheldFactIds: readonly FactId[];
  readonly allowedFactCards: readonly NpcSpeechFactCard[];
  readonly allowedEventIds: readonly EventId[];
  readonly recentInteractions: readonly NpcSpeechInteraction[];
  readonly identityAnchors: NpcIdentityAnchors;
  readonly activeGoals: readonly string[];
  readonly relationships: readonly NpcSpeechRelationship[];
  readonly relationship?: NpcSpeechRelationship & Readonly<{
    readonly targetId: PlayerEntityId | NpcId;
  }>;
  readonly evidenceKeys: readonly string[];
}>;

export type NpcDeliberationOutwardProjection = Readonly<{
  readonly npcId: NpcId;
  readonly response: NpcDeliberationResponse;
  readonly evidenceEventIds: readonly EventId[];
  readonly discloseFactIds: readonly FactId[];
  readonly interactionProposals: readonly StoryInteractionProposal[];
}>;

export type NpcDeliberationOutwardRejection =
  | "invalid_fact_disclosure"
  | "invalid_event_reference"
  | "invalid_interaction_proposal";

/**
 * The single reference gate used by every narrative approval path.  It is
 * intentionally non-normalizing: a malformed, duplicate, or unauthorized ID
 * rejects the whole speech payload instead of silently dropping a reference.
 */
export function validateNpcSpeechReferences(input: {
  readonly authority: NpcSpeechReferenceAuthority;
  readonly usedFactIds: readonly string[];
  readonly usedEventIds: readonly string[];
  readonly eventLedger?: readonly CommittedNarrativeEvent[];
  readonly speakerNpcId?: NpcId;
}): { readonly ok: true } | { readonly ok: false; readonly code: NpcSpeechReferenceRejection } {
  if (input.usedFactIds.some((id) => !isWellFormedNpcSpeechReferenceId(id))) {
    return { ok: false, code: "invalid_fact_reference" };
  }
  if (input.usedEventIds.some((id) => !isWellFormedEventId(id))) {
    return { ok: false, code: "invalid_event_reference" };
  }
  if (!areUniqueNpcSpeechReferenceIds(input.usedFactIds)
    || !areUniqueNpcSpeechReferenceIds(input.usedEventIds)) {
    return { ok: false, code: "duplicate_npc_reference" };
  }
  const allowedFacts = new Set(input.authority.allowedFactIds.map(String));
  if (input.usedFactIds.some((id) => !allowedFacts.has(String(id)))) {
    return { ok: false, code: "invalid_fact_reference" };
  }
  const allowedEvents = new Set(input.authority.allowedEventIds.map(String));
  if (input.usedEventIds.some((id) => !allowedEvents.has(String(id)))) {
    return { ok: false, code: "invalid_event_reference" };
  }
  if (input.eventLedger !== undefined && input.speakerNpcId !== undefined) {
    const committed = new Map(input.eventLedger.map((event) => [String(event.eventId), event]));
    for (const eventId of input.usedEventIds) {
      const event = committed.get(String(eventId));
      if (event === undefined || !eventInvolvesNpc(event, input.speakerNpcId)) {
        return { ok: false, code: "invalid_event_reference" };
      }
    }
  }
  return { ok: true };
}

/**
 * Cross the private-to-public boundary for one NPC proposal. Only references
 * that the existing speech authority permits survive; privateContext, goals,
 * and all private reasoning stay outside this projection.
 */
export function authorizeNpcDeliberationOutward(input: {
  readonly store: EntityStore;
  readonly speakerNpcId: NpcId;
  readonly sceneVisibleFactIds: readonly FactId[];
  readonly eventLedger?: readonly CommittedNarrativeEvent[];
  readonly targetContext?: NpcSpeechAuthorityInput["targetContext"];
  readonly proposal: Pick<
    NpcDeliberationProposal,
    "response" | "evidenceEventIds" | "discloseFactIds" | "interactionProposals"
  > & Readonly<{ goalIds?: readonly string[] }>;
}):
  | { readonly ok: true; readonly projection: NpcDeliberationOutwardProjection }
  | { readonly ok: false; readonly code: NpcDeliberationOutwardRejection } {
  const authority = buildNpcSpeechAuthority({
    store: input.store,
    speakerNpcId: input.speakerNpcId,
    sceneVisibleFactIds: input.sceneVisibleFactIds,
    ...(input.eventLedger === undefined ? {} : { eventLedger: input.eventLedger }),
    ...(input.targetContext === undefined ? {} : { targetContext: input.targetContext }),
  });
  if (authority === null) return { ok: false, code: "invalid_interaction_proposal" };

  const referenceResult = validateNpcSpeechReferences({
    authority,
    usedFactIds: input.proposal.discloseFactIds.map(String),
    usedEventIds: input.proposal.evidenceEventIds.map(String),
    ...(input.eventLedger === undefined ? {} : { eventLedger: input.eventLedger }),
    speakerNpcId: input.speakerNpcId,
  });
  if (!referenceResult.ok) {
    return {
      ok: false,
      code: referenceResult.code === "invalid_fact_reference"
        ? "invalid_fact_disclosure"
        : referenceResult.code === "invalid_event_reference"
          ? "invalid_event_reference"
          : "invalid_interaction_proposal",
    };
  }

  const speaker = getEntity(input.store, String(input.speakerNpcId));
  if (!isNpc(speaker)) return { ok: false, code: "invalid_interaction_proposal" };
  const currentGoalIds = new Set(
    speaker.dynamicState.goals
      .filter((goal) => goal.status === "active" || goal.status === "blocked")
      .map((goal) => goal.goalId),
  );
  if ((input.proposal.goalIds ?? []).some((goalId) => !currentGoalIds.has(goalId))) {
    return { ok: false, code: "invalid_interaction_proposal" };
  }
  const knownFactIds = new Set(speaker.knowledge.entries.map((entry) => String(entry.factId)));
  const proposalKeys = new Set<string>();
  const interactionProposals: StoryInteractionProposal[] = [];
  for (const [index, rawProposal] of input.proposal.interactionProposals.entries()) {
    const parsed = parseStoryInteractionProposal(rawProposal, `interactionProposals[${index}]`);
    if (!parsed.ok || String(parsed.value.npcId) !== String(input.speakerNpcId)) {
      return { ok: false, code: "invalid_interaction_proposal" };
    }
    if (proposalKeys.has(parsed.value.proposalKey)) {
      return { ok: false, code: "invalid_interaction_proposal" };
    }
    if (parsed.value.goalIds.some((goalId) => !currentGoalIds.has(goalId))) {
      return { ok: false, code: "invalid_interaction_proposal" };
    }
    const playerSharing = parsed.value.operation === "share_known_fact";
    const player = getEntity(input.store, "player_0");
    const sharingFacts = player?.core.kind === "player_character" ? (player as import("@/game/domain/entity").PlayerEntityRecord).knowledge.knownFactIds : [];
    if (parsed.value.factIds.some((factId) => playerSharing ? !sharingFacts.includes(factId) : !knownFactIds.has(String(factId)))) {
      return { ok: false, code: "invalid_interaction_proposal" };
    }
    if (parsed.value.confidentiality !== undefined) {
      const speaker = getEntity(input.store, input.speakerNpcId);
      if (speaker?.core.kind !== "npc" || parsed.value.confidentiality.protectedFactIds.some((factId) => !(speaker as NpcEntityRecord).knowledge.entries.some((entry) => entry.factId === factId))
        || parsed.value.confidentiality.allowedAudienceIds.some((id) => !isValidNpcSpeechTarget(input.store, id as PlayerEntityId | NpcId))) return { ok: false, code: "invalid_interaction_proposal" };
    }
    if (parsed.value.audienceIds.length === 0) {
      return { ok: false, code: "invalid_interaction_proposal" };
    }
    if (playerSharing && (!parsed.value.audienceIds.includes(input.speakerNpcId) || parsed.value.audienceIds.some((id) => {
      const target = getEntity(input.store, id);
      return target?.core.kind !== "npc" || (target as NpcEntityRecord).position.locationId !== speaker.position.locationId;
    }))) return { ok: false, code: "invalid_interaction_proposal" };
    for (const targetId of parsed.value.audienceIds) {
      if (playerSharing) continue;
      if (!isValidNpcSpeechTarget(input.store, targetId as PlayerEntityId | NpcId)
        || String(targetId) === String(input.speakerNpcId)) {
        return { ok: false, code: "invalid_interaction_proposal" };
      }
      const audienceAuthority = buildNpcSpeechAuthority({
        store: input.store,
        speakerNpcId: input.speakerNpcId,
        sceneVisibleFactIds: input.sceneVisibleFactIds,
        ...(input.eventLedger === undefined ? {} : { eventLedger: input.eventLedger }),
        targetContext: { targetId: targetId as PlayerEntityId | NpcId },
      });
      if (audienceAuthority === null
        || parsed.value.factIds.some((factId) => !canNpcDiscloseFact(speaker, factId, targetId, input.eventLedger)
          || !audienceAuthority.allowedFactIds.some((allowedFactId) => String(allowedFactId) === String(factId))
          && !((parsed.value.operation === "request_introduction" || parsed.value.operation === "request_verification")
            && hasCommittedConfidentialityPermission(speaker, factId, targetId, input.eventLedger)))) {
        return { ok: false, code: "invalid_fact_disclosure" };
      }
    }
    if (parsed.value.operation !== "promise_confidentiality" && parsed.value.factIds.length === 0) {
      return { ok: false, code: "invalid_interaction_proposal" };
    }
    if (parsed.value.operation === "request_verification" && parsed.value.evidenceEventIds.length === 0) {
      return { ok: false, code: "invalid_interaction_proposal" };
    }
    const interactionEvidence = validateNpcSpeechReferences({
      authority,
      usedFactIds: [],
      usedEventIds: parsed.value.evidenceEventIds.map(String),
      ...(input.eventLedger === undefined ? {} : { eventLedger: input.eventLedger }),
      speakerNpcId: input.speakerNpcId,
    });
    if (!interactionEvidence.ok) return { ok: false, code: "invalid_interaction_proposal" };
    proposalKeys.add(parsed.value.proposalKey);
    interactionProposals.push(parsed.value);
  }

  return {
    ok: true,
    projection: {
      npcId: input.speakerNpcId,
      response: input.proposal.response,
      evidenceEventIds: [...input.proposal.evidenceEventIds],
      discloseFactIds: [...input.proposal.discloseFactIds],
      interactionProposals,
    },
  };
}

function eventInvolvesNpc(event: CommittedNarrativeEvent, npcId: NpcId): boolean {
  return [...event.actorIds, ...event.targetIds].some((participantId) => String(participantId) === String(npcId));
}

function validEventIdForSpeaker(
  eventId: EventId,
  speakerNpcId: NpcId,
  ledger: readonly CommittedNarrativeEvent[] | undefined,
): boolean {
  if (!isWellFormedEventId(String(eventId))) return false;
  if (ledger === undefined) return true;
  const event = ledger.find((candidate) => String(candidate.eventId) === String(eventId));
  return event !== undefined && eventInvolvesNpc(event, speakerNpcId);
}

/** A target reference is valid only for an actual NPC or player entity. */
export function isValidNpcSpeechTarget(
  store: EntityStore,
  targetId: PlayerEntityId | NpcId | undefined,
): boolean {
  if (targetId === undefined) return true;
  const target = getEntity(store, String(targetId));
  return target?.core.kind === "npc" || target?.core.kind === "player_character";
}

function compareId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueSorted<T>(values: readonly T[], key: (value: T) => string): T[] {
  const result = new Map<string, T>();
  for (const value of values) result.set(key(value), value);
  return [...result.entries()]
    .sort(([left], [right]) => compareId(left, right))
    .map(([, value]) => value);
}

function isNpc(record: EntityRecord | undefined): record is NpcEntityRecord {
  return record !== undefined && record.core.kind === "npc";
}

function isFact(record: EntityRecord | undefined): record is Extract<EntityRecord, { core: { kind: "fact" } }> {
  return record !== undefined && record.core.kind === "fact";
}

function openCommitmentOf(commitment: RelationshipCommitment): NpcSpeechCommitment | undefined {
  if (commitment.status !== "open") return undefined;
  if (commitment.kind === "debt") {
    return {
      kind: commitment.kind,
      commitmentId: commitment.commitmentId,
      direction: commitment.direction,
      description: commitment.description,
    };
  }
  return {
    kind: commitment.kind,
    commitmentId: commitment.commitmentId,
    promisor: commitment.promisor,
    description: commitment.description,
  };
}

function relationshipOf(edge: DirectedRelationshipEdge): NpcSpeechRelationship {
  return {
    targetId: edge.targetId,
    stage: edge.stage,
    trend: edge.trend,
    openCommitments: edge.commitments
      .map(openCommitmentOf)
      .filter((commitment): commitment is NpcSpeechCommitment => commitment !== undefined)
      .sort((left, right) => compareId(left.commitmentId, right.commitmentId)),
  };
}

function interactionViews(history: readonly NpcInteraction[]): readonly NpcSpeechInteraction[] {
  const latestByEvent = new Map<string, NpcInteraction>();
  for (const interaction of history) latestByEvent.set(String(interaction.eventId), interaction);
  return [...latestByEvent.values()]
    .sort((left, right) => left.turnNumber - right.turnNumber || compareId(String(left.eventId), String(right.eventId)))
    .slice(-5)
    .map((interaction) => ({
      eventId: interaction.eventId,
      actionId: interaction.actionId,
      dialogueAct: interaction.dialogueAct,
      topicSummary: interaction.topicSummary,
      outcome: interaction.outcome,
      summary: interaction.summary.replace(/关系[+-]?\d+(?:\.\d+)?/g, "关系变化"),
    }));
}

function targetEdgeOf(
  store: EntityStore,
  npc: NpcEntityRecord,
  targetId: PlayerEntityId | NpcId | undefined,
): DirectedRelationshipEdge | undefined {
  if (targetId === undefined) return undefined;
  const target = getEntity(store, String(targetId));
  if (target?.core.kind !== "npc" && target?.core.kind !== "player_character") return undefined;
  return npc.relationships.outgoing.find((edge) => String(edge.targetId) === String(targetId));
}

/**
 * Project the speaker's disclosure and reference authority from entity components.
 * This function deliberately never consults the compatibility `NpcEntry.memory` view.
 * Returns null for an unknown or non-NPC speaker so callers fail closed without exceptions.
 */
export function buildNpcSpeechAuthority(input: NpcSpeechAuthorityInput): NpcSpeechAuthority | null {
  const speakerRecord = getEntity(input.store, String(input.speakerNpcId));
  if (!isNpc(speakerRecord)) {
    return null;
  }

  const targetId = input.targetContext?.targetId;
  const targetEdge = targetEdgeOf(input.store, speakerRecord, targetId);
  const targetRelationship = targetEdge === undefined ? undefined : relationshipOf(targetEdge);
  // Keep the public response policy compatible with the existing affinity-based
  // fallback while keeping the numeric component private to this projection.
  const responseTier = targetEdge === undefined
    ? "neutral"
    : relationshipTierOf(targetEdge.dimensions);
  const factRecords = new Map(
    input.store.records
      .filter(isFact)
      .map((record) => [String(record.core.id), record]),
  );
  const visibleFactIds = new Set(input.sceneVisibleFactIds.map(String));
  const playerRecord = getEntity(input.store, "player_0");
  const playerKnownFactIds = playerRecord?.core.kind === "player_character"
    ? (playerRecord as import("@/game/domain/entity").PlayerEntityRecord).knowledge.knownFactIds : [];
  const allowedEntries = speakerRecord.knowledge.entries.filter((entry) =>
    factRecords.has(String(entry.factId))
      && visibleFactIds.has(String(entry.factId))
      && (entry.disclosure !== "secret" || playerKnownFactIds.includes(entry.factId))
      && (canNpcDiscloseFact(speakerRecord, entry.factId, targetId, input.eventLedger)
        || (playerKnownFactIds.includes(entry.factId)
          && hasCommittedDisclosureToPlayer(speakerRecord, entry.factId, targetId, input.eventLedger))),
  );
  const allowedFactIds = uniqueSorted(allowedEntries.map((entry) => entry.factId), String);
  const allowedFactIdSet = new Set(allowedFactIds.map(String));
  const withheldFactIds = uniqueSorted(
    speakerRecord.knowledge.entries
      .map((entry) => entry.factId)
      .filter((factId) => !allowedFactIdSet.has(String(factId))),
    String,
  );
  const allowedFactCards = allowedFactIds
    .map((factId) => {
      const record = factRecords.get(String(factId));
      return isFact(record) ? { factId, text: record.fact.text } : undefined;
    })
    .filter((card): card is NpcSpeechFactCard => card !== undefined);

  const recentInteractions = interactionViews(speakerRecord.history.interactions)
    .filter((interaction) => validEventIdForSpeaker(interaction.eventId, input.speakerNpcId, input.eventLedger));
  // Task 4 Step 3: allowedEventIds by three sources:
  //   1. speaker's own interaction events
  //   2. speaker's own knowledge source events
  //   3. target relationship's latest 3 evidence supportingEventIds
  const recentInteractionEventIds = recentInteractions.map((interaction) => interaction.eventId);
  const knowledgeEventIds = speakerRecord.knowledge.entries
    .filter((entry) => entry.source.kind === "action")
    .map((entry) => entry.source.kind === "action" ? entry.source.eventId : null)
    .filter((id): id is EventId => id !== null);
  const evidenceEventIds = targetEdge === undefined
    ? []
    : targetEdge.evidence
        .slice(-3)
        .flatMap((evidence) => evidence.supportingEventIds);
  // One committed interaction can emit multiple events (for example npc_met
  // and npc_interaction_recorded). Every speech path shares this evidence set;
  // a missing denormalized history row must not invalidate the same action.
  const interactionActionIds = new Set(speakerRecord.history.interactions.map(entry => entry.actionId));
  const interactionCompanionEventIds = (input.eventLedger ?? [])
    .filter(event => event.actionId !== undefined && interactionActionIds.has(event.actionId)
      && eventInvolvesNpc(event, input.speakerNpcId))
    .map(event => event.eventId);
  const requestedEventIds = input.targetContext?.interactionEventIds;
  const candidateEventIds = requestedEventIds === undefined
    ? [...recentInteractionEventIds, ...knowledgeEventIds, ...evidenceEventIds]
    : requestedEventIds.filter((eventId) =>
        recentInteractionEventIds.some((id) => String(id) === String(eventId)));
  const allowedEventIds = uniqueSorted(
    [...candidateEventIds, ...knowledgeEventIds, ...evidenceEventIds, ...interactionCompanionEventIds,
      ...(input.eventLedger === undefined ? [] : input.targetContext?.currentEventIds ?? [])]
      .filter((eventId) => validEventIdForSpeaker(eventId, input.speakerNpcId, input.eventLedger)),
    String,
  );
  const relationships = targetEdge === undefined ? [] : [relationshipOf(targetEdge)];
  const evidenceKeys = uniqueSorted(
    (targetEdge === undefined ? [] : [targetEdge])
      .flatMap((edge) => edge.evidence.map((evidence) => evidence.summaryKey)),
    (key) => key,
  ).slice(0, 3);

  return {
    speakerNpcId: speakerRecord.core.id,
    responseTier,
    allowedFactIds,
    withheldFactIds,
    allowedFactCards,
    allowedEventIds,
    recentInteractions,
    identityAnchors: speakerRecord.identity.anchors,
    activeGoals: speakerRecord.dynamicState.goals
      .filter((goal) => goal.status === "active")
      .sort((left, right) => left.priority - right.priority || compareId(left.goalId, right.goalId))
      .map((goal) => goal.description),
    relationships,
    ...(targetRelationship === undefined ? {} : { relationship: targetRelationship }),
    evidenceKeys,
  };
}
