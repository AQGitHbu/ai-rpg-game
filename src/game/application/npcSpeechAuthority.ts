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
  npc: NpcEntityRecord,
  targetId: PlayerEntityId | NpcId | undefined,
): DirectedRelationshipEdge | undefined {
  if (targetId === undefined) return undefined;
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
  const targetEdge = targetEdgeOf(speakerRecord, targetId);
  const targetRelationship = targetEdge === undefined ? undefined : relationshipOf(targetEdge);
  // Keep the public response policy compatible with the existing affinity-based
  // fallback while keeping the numeric component private to this projection.
  const responseTier = targetEdge === undefined
    ? "neutral"
    : relationshipTierOf(targetEdge.dimensions);
  const visibleFactIds = new Set(input.sceneVisibleFactIds.map(String));
  const allowedEntries = speakerRecord.knowledge.entries.filter((entry) =>
    visibleFactIds.has(String(entry.factId)) && canDisclose(entry, targetRelationship),
  );
  const allowedFactIds = uniqueSorted(allowedEntries.map((entry) => entry.factId), String);
  const allowedFactIdSet = new Set(allowedFactIds.map(String));
  const withheldFactIds = uniqueSorted(
    speakerRecord.knowledge.entries
      .map((entry) => entry.factId)
      .filter((factId) => !allowedFactIdSet.has(String(factId))),
    String,
  );
  const factRecords = new Map(
    input.store.records
      .filter((record) => record.core.kind === "fact")
      .map((record) => [String(record.core.id), record]),
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
  const relationships = uniqueSorted(
    speakerRecord.relationships.outgoing.map(relationshipOf),
    (relationship) => String(relationship.targetId),
  );
  const evidenceKeys = uniqueSorted(
    (targetEdge === undefined ? speakerRecord.relationships.outgoing : [targetEdge])
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
