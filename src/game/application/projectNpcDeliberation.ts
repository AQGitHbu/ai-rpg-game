import { getEntity, type EntityRecord, type EntityStore, type FactEntityRecord, type NpcEntityRecord } from "@/game/domain/entity";
import type { EventId, NarrativeJobId } from "@/game/domain/events";
import type { PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import type { StoryState } from "@/game/domain/storyState";
import type { WorldState } from "@/game/domain/worldState";
import type { NpcId } from "@/game/domain/worldEntity";
import type { NpcKnowledgeEntry, NpcKnowledgeSource } from "@/game/domain/entity";
import type { NpcDeliberationInput } from "./npcDeliberationSource";

type NpcPrivateFact = Readonly<{
  readonly factId: string;
  readonly text: string;
  readonly certainty: NpcKnowledgeEntry["certainty"];
  readonly disclosure: NpcKnowledgeEntry["disclosure"];
  readonly source: NpcKnowledgeSource;
}>;

type NpcPrivateInteraction = Readonly<{
  readonly eventId: string;
  readonly actionId: string;
  readonly dialogueAct: string;
  readonly topicSummary: string;
  readonly outcome: string;
  readonly summary: string;
}>;

function compareId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isNpc(record: EntityRecord | undefined): record is NpcEntityRecord {
  return record?.core.kind === "npc";
}

function isFact(record: EntityRecord | undefined): record is FactEntityRecord {
  return record?.core.kind === "fact";
}

function currentJobOf(storyState: StoryState, jobId: NarrativeJobId): PendingNarrativeJob {
  const narrative = storyState.narrative;
  if (narrative.status !== "provider_pending" && narrative.status !== "provider_failed") {
    throw new Error("NPC_DELIBERATION_JOB_NOT_PENDING");
  }
  if (String(narrative.job.jobId) !== String(jobId)) {
    throw new Error("NPC_DELIBERATION_JOB_MISMATCH");
  }
  return narrative.job;
}

function npcOf(store: EntityStore, npcId: NpcId): NpcEntityRecord {
  const record = getEntity(store, String(npcId));
  if (!isNpc(record)) {
    throw new Error("NPC_DELIBERATION_NPC_NOT_FOUND");
  }
  if (record.core.lifecycle !== "active") {
    throw new Error("NPC_DELIBERATION_NPC_NOT_FOUND");
  }
  return record;
}

function factContext(store: EntityStore, npc: NpcEntityRecord): readonly NpcPrivateFact[] {
  const facts = new Map<string, FactEntityRecord["fact"]>();
  for (const record of store.records) {
    if (isFact(record)) facts.set(String(record.core.id), record.fact);
  }
  const result: NpcPrivateFact[] = [];
  for (const entry of npc.knowledge.entries) {
    const fact = facts.get(String(entry.factId));
    if (fact !== undefined) {
      result.push({
        factId: String(entry.factId),
        text: fact.text,
        certainty: entry.certainty,
        disclosure: entry.disclosure,
        source: entry.source,
      });
    }
  }
  return result.sort((left, right) => compareId(left.factId, right.factId));
}

function goalContext(npc: NpcEntityRecord): readonly unknown[] {
  return npc.dynamicState.goals
    .filter((goal) => goal.status === "active" || goal.status === "blocked")
    .sort((left, right) => left.priority - right.priority || compareId(left.goalId, right.goalId))
    .map((goal) => ({
      goalId: goal.goalId,
      horizon: goal.horizon,
      description: goal.description,
      priority: goal.priority,
      status: goal.status,
      reason: goal.reason,
    }));
}

function relationshipContext(store: EntityStore, npc: NpcEntityRecord): readonly unknown[] {
  const result: Array<{
    readonly targetId: string;
    readonly targetName: string;
    readonly stage: string;
    readonly trend: string;
    readonly openCommitments: readonly unknown[];
  }> = [];
  for (const edge of npc.relationships.outgoing) {
    const target = getEntity(store, String(edge.targetId));
    if (target === undefined || (target.core.kind !== "npc" && target.core.kind !== "player_character")) continue;
    result.push({
        targetId: String(edge.targetId),
        targetName: target.core.name,
        stage: edge.stage,
        trend: edge.trend,
        openCommitments: edge.commitments
          .filter((commitment) => commitment.status === "open")
          .map((commitment) => ({
            kind: commitment.kind,
            commitmentId: commitment.commitmentId,
            description: commitment.description,
            ...(commitment.kind === "debt" ? { direction: commitment.direction } : { promisor: commitment.promisor }),
          }))
          .sort((left, right) => compareId(left.commitmentId, right.commitmentId)),
      });
  }
  return result.sort((left, right) => compareId(left.targetId, right.targetId));
}

function interactionContext(npc: NpcEntityRecord): readonly NpcPrivateInteraction[] {
  const latestByEvent = new Map<string, NpcEntityRecord["history"]["interactions"][number]>();
  for (const interaction of npc.history.interactions) latestByEvent.set(String(interaction.eventId), interaction);
  return [...latestByEvent.values()]
    .sort((left, right) => left.turnNumber - right.turnNumber || compareId(String(left.eventId), String(right.eventId)))
    .slice(-5)
    .map((interaction) => ({
      eventId: String(interaction.eventId),
      actionId: interaction.actionId,
      dialogueAct: interaction.dialogueAct,
      topicSummary: interaction.topicSummary,
      outcome: interaction.outcome,
      summary: interaction.summary,
    }));
}

function evidenceContext(
  worldState: WorldState,
  npc: NpcEntityRecord,
  job: PendingNarrativeJob,
): readonly unknown[] {
  const eventIds = new Set<string>(job.domainEventIds.map(String));
  for (const interaction of npc.history.interactions) eventIds.add(String(interaction.eventId));
  for (const entry of npc.knowledge.entries) {
    if (entry.source.kind === "action") eventIds.add(String(entry.source.eventId));
  }
  const events = new Map(worldState.eventLedger.map((event) => [String(event.eventId), event] as const));
  const result: Array<{
    readonly eventId: string;
    readonly kind: string;
    readonly turnNumber: number;
    readonly outcome: string;
    readonly factIds: readonly string[];
  }> = [];
  for (const eventId of eventIds) {
    const event = events.get(eventId);
    if (event === undefined || ![...event.actorIds, ...event.targetIds].some((id) => String(id) === String(npc.core.id))) continue;
    result.push({
        eventId,
        kind: event.kind,
        turnNumber: event.turnNumber,
        outcome: event.outcome,
        factIds: event.factIds.map(String),
      });
  }
  return result.sort((left, right) => compareId(left.eventId, right.eventId));
}

/**
 * Build the private decision envelope for exactly one NPC. The envelope is
 * structured state, not a request for hidden chain-of-thought, and is never
 * reused as the scene author's or player's prompt.
 */
export function projectNpcDeliberation(input: {
  readonly worldState: WorldState;
  readonly storyState: StoryState;
  readonly npcId: NpcId;
  readonly jobId: NarrativeJobId;
  readonly candidateVersion: number;
}): NpcDeliberationInput {
  const npc = npcOf(input.worldState.entityStore, input.npcId);
  const job = currentJobOf(input.storyState, input.jobId);
  const privateContext = JSON.stringify({
    schema: "npc_deliberation.v1",
    npc: {
      npcId: String(npc.core.id),
      name: npc.core.name,
      role: npc.identity.role,
      description: npc.identity.description,
      position: String(npc.position.locationId),
      emotion: npc.dynamicState.emotion,
      anchors: npc.identity.anchors,
    },
    knownFacts: factContext(input.worldState.entityStore, npc),
    goals: goalContext(npc),
    relationships: relationshipContext(input.worldState.entityStore, npc),
    recentInteractions: interactionContext(npc),
    currentEvidence: evidenceContext(input.worldState, npc, job),
    currentJob: {
      jobId: String(job.jobId),
      actionId: job.actionId,
      actionSummary: job.actionSummary,
      utterance: job.utterance,
      selectedDialogue: job.selectedDialogue,
      resolvedEvent: job.resolvedEvent,
      domainEventIds: job.domainEventIds.map((eventId: EventId) => String(eventId)),
    },
  });
  return {
    npcId: input.npcId,
    jobId: input.jobId,
    candidateVersion: input.candidateVersion,
    privateContext,
  };
}
