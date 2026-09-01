import {
  getEntity,
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
import { relationshipTierOf, type RelationshipTier } from "@/game/domain/relationship";
import {
  areUniqueNpcSpeechReferenceIds,
  isWellFormedNpcSpeechReferenceId,
} from "@/game/domain/npcSpeechReferences";

export type NpcSpeechReferenceRejection =
  | "duplicate_npc_reference"
  | "invalid_fact_reference"
  | "invalid_interaction_reference";

export type NpcSpeechReferenceAuthority = Pick<
  NpcSpeechAuthority,
  "allowedFactIds" | "allowedInteractionActionIds"
>;

/** The only context used to decide which references a speaker may expose. */
export type NpcSpeechAuthorityInput = Readonly<{
  readonly store: EntityStore;
  readonly speakerNpcId: NpcId;
  readonly sceneVisibleFactIds: readonly FactId[];
  readonly targetContext?: Readonly<{
    readonly targetId?: PlayerEntityId | NpcId;
    readonly interactionActionIds?: readonly string[];
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
  readonly allowedInteractionActionIds: readonly string[];
  readonly recentInteractions: readonly NpcSpeechInteraction[];
  readonly identityAnchors: NpcIdentityAnchors;
  readonly activeGoals: readonly string[];
  readonly relationships: readonly NpcSpeechRelationship[];
  readonly relationship?: NpcSpeechRelationship & Readonly<{
    readonly targetId: PlayerEntityId | NpcId;
  }>;
  readonly evidenceKeys: readonly string[];
}>;

/**
 * The single reference gate used by every narrative approval path.  It is
 * intentionally non-normalizing: a malformed, duplicate, or unauthorized ID
 * rejects the whole speech payload instead of silently dropping a reference.
 */
export function validateNpcSpeechReferences(input: {
  readonly authority: NpcSpeechReferenceAuthority;
  readonly usedFactIds: readonly string[];
  readonly usedInteractionActionIds: readonly string[];
}): { readonly ok: true } | { readonly ok: false; readonly code: NpcSpeechReferenceRejection } {
  if (input.usedFactIds.some((id) => !isWellFormedNpcSpeechReferenceId(id))) {
    return { ok: false, code: "invalid_fact_reference" };
  }
  if (input.usedInteractionActionIds.some((id) => !isWellFormedNpcSpeechReferenceId(id))) {
    return { ok: false, code: "invalid_interaction_reference" };
  }
  if (!areUniqueNpcSpeechReferenceIds(input.usedFactIds)
    || !areUniqueNpcSpeechReferenceIds(input.usedInteractionActionIds)) {
    return { ok: false, code: "duplicate_npc_reference" };
  }
  const allowedFacts = new Set(input.authority.allowedFactIds.map(String));
  if (input.usedFactIds.some((id) => !allowedFacts.has(String(id)))) {
    return { ok: false, code: "invalid_fact_reference" };
  }
  const allowedInteractions = new Set(input.authority.allowedInteractionActionIds.map(String));
  if (input.usedInteractionActionIds.some((id) => !allowedInteractions.has(String(id)))) {
    return { ok: false, code: "invalid_interaction_reference" };
  }
  return { ok: true };
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
  const latestByAction = new Map<string, NpcInteraction>();
  for (const interaction of history) latestByAction.set(interaction.actionId, interaction);
  return [...latestByAction.values()]
    .sort((left, right) => left.turnNumber - right.turnNumber || compareId(left.actionId, right.actionId))
    .slice(-5)
    .map((interaction) => ({
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

function canDisclose(entry: NpcEntityRecord["knowledge"]["entries"][number], target: NpcSpeechRelationship | undefined): boolean {
  if (entry.disclosure === "secret") return false;
  if (entry.disclosure === "public") return true;
  return target?.stage === "cooperative"
    || target?.stage === "trusted"
    || target?.stage === "bonded";
}

/**
 * Project the speaker's disclosure and reference authority from entity components.
 * This function deliberately never consults the compatibility `NpcEntry.memory` view.
 */
export function buildNpcSpeechAuthority(input: NpcSpeechAuthorityInput): NpcSpeechAuthority {
  const speakerRecord = getEntity(input.store, String(input.speakerNpcId));
  if (!isNpc(speakerRecord)) {
    throw new Error(`buildNpcSpeechAuthority: unknown NPC ${String(input.speakerNpcId)}`);
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
  const allowedEntries = speakerRecord.knowledge.entries.filter((entry) =>
    factRecords.has(String(entry.factId))
      && visibleFactIds.has(String(entry.factId))
      && canDisclose(entry, targetRelationship),
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

  const recentInteractions = interactionViews(speakerRecord.history.interactions);
  const recentActionIds = recentInteractions.map((interaction) => interaction.actionId);
  const requestedActionIds = input.targetContext?.interactionActionIds;
  const allowedInteractionActionIds = uniqueSorted(
    requestedActionIds === undefined
      ? recentActionIds
      : requestedActionIds.filter((actionId) => recentActionIds.includes(actionId)),
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
    allowedInteractionActionIds,
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
