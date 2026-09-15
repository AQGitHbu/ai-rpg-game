import { canNpcDiscloseFact, hasCommittedConfidentialityPermission, getEntity, type EntityRecord, type EntityStore, type FactEntityRecord, type NpcEntityRecord } from "@/game/domain/entity";
import type { EventId, NarrativeJobId } from "@/game/domain/events";
import type { PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import type { StoryState } from "@/game/domain/storyState";
import type { WorldState } from "@/game/domain/worldState";
import { PLAYER_ENTITY_ID, type NpcId } from "@/game/domain/worldEntity";
import type { NpcKnowledgeEntry, NpcKnowledgeSource, RelationshipCommitment } from "@/game/domain/entity";
import type { NarrativeMemoryContext } from "@/game/domain/narrativeMemoryContext";
import { buildNpcSpeechAuthority } from "./npcSpeechAuthority";
import type { NpcDeliberationInput } from "./npcDeliberationSource";
import { projectStoryConsequences } from "./storyConsequenceContext";

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

function commitmentContext(commitment: RelationshipCommitment) {
  return {
    kind: commitment.kind,
    commitmentId: commitment.commitmentId,
    description: commitment.description,
    status: commitment.status,
    ...(commitment.kind === "debt" ? { direction: commitment.direction } : {
      promisor: commitment.promisor,
      ...(commitment.confidentiality === undefined ? {} : { confidentiality: commitment.confidentiality }),
    }),
  };
}

function relationshipContext(store: EntityStore, npc: NpcEntityRecord): readonly unknown[] {
  const result: Array<{
    readonly targetId: string;
    readonly targetName: string;
    readonly stage: string;
    readonly trend: string;
    readonly openCommitments: readonly unknown[];
    readonly resolvedCommitments: readonly unknown[];
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
          .map(commitmentContext)
          .sort((left, right) => compareId(left.commitmentId, right.commitmentId)),
        resolvedCommitments: edge.commitments
          .filter((commitment) => commitment.status !== "open")
          .map(commitmentContext)
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

function outwardAuthority(worldState: WorldState, npc: NpcEntityRecord, job: PendingNarrativeJob) {
  const player = getEntity(worldState.entityStore, PLAYER_ENTITY_ID);
  return buildNpcSpeechAuthority({
    store: worldState.entityStore, speakerNpcId: npc.core.id,
    sceneVisibleFactIds: player?.core.kind === "player_character" ? (player as import("@/game/domain/entity").PlayerEntityRecord).knowledge.knownFactIds : [],
    eventLedger: worldState.eventLedger,
    targetContext: { targetId: PLAYER_ENTITY_ID, currentEventIds: job.domainEventIds },
  });
}

function evidenceContext(
  worldState: WorldState,
  npc: NpcEntityRecord,
  job: PendingNarrativeJob,
): readonly unknown[] {
  const authority = outwardAuthority(worldState, npc, job);
  const eventIds = new Set<string>(authority?.allowedEventIds.map(String) ?? []);
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
        factIds: event.factIds.filter(id => npc.knowledge.entries.some(entry => entry.factId === id)).map(String),
      });
  }
  return result.sort((left, right) => compareId(left.eventId, right.eventId));
}

function historicalMemoryContext(memory: NarrativeMemoryContext | undefined, npcId: NpcId): Readonly<{
  readonly uncovered: readonly unknown[];
  readonly recalled: readonly unknown[];
  readonly requiredEvents: readonly unknown[];
  readonly overviewEvents: readonly unknown[];
}> | undefined {
  if (memory === undefined) return undefined;
  if (String(memory.observerId) !== String(npcId)) throw new Error("NPC_MEMORY_OBSERVER_MISMATCH");
  const renderEntry = (entry: NarrativeMemoryContext["uncovered"][number]) => ({
    historyId: entry.id,
    sequence: entry.sequence,
    turnNumber: entry.turnNumber,
    kind: entry.kind,
    speakerId: entry.speakerId === null ? null : String(entry.speakerId),
    audienceIds: entry.audienceIds.map(String),
    text: entry.text,
    eventIds: entry.eventIds.map(String),
  });
  return {
    uncovered: memory.uncovered.map(renderEntry),
    recalled: memory.recalled.map(renderEntry),
    requiredEvents: memory.requiredEvents,
    overviewEvents: (memory.overviewEvents ?? []).filter(event => !memory.requiredEvents.some(required => required.eventId === event.eventId)),
  };
}

/** The selected action expression is distinct from a claimed spoken utterance. */
export function currentNpcPlayerExpressions(storyState: StoryState, job: PendingNarrativeJob, npcId: NpcId) {
  if (job.focusNpcId !== npcId) return [];
  return storyState.history.entries
    .filter(entry => entry.actionId === job.actionId && entry.speakerId === PLAYER_ENTITY_ID
      && (entry.kind === "player_choice" || entry.kind === "player_freeform"))
    .map(entry => ({ kind: entry.kind, text: entry.text }));
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
  readonly memoryContext?: NarrativeMemoryContext;
}): NpcDeliberationInput {
  const npc = npcOf(input.worldState.entityStore, input.npcId);
  const job = currentJobOf(input.storyState, input.jobId);
  const historicalMemory = historicalMemoryContext(input.memoryContext, input.npcId);
  const authority = outwardAuthority(input.worldState, npc, job);
  const currentConsequences = projectStoryConsequences({
    worldState: input.worldState,
    storyState: input.storyState,
    observerId: input.npcId,
    eventIds: job.domainEventIds,
  });
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
    currentConsequences: {
      requiredEventIds: currentConsequences.requiredEventIds.map(String),
      activeThreadIds: currentConsequences.activeThreadIds,
      currentGoalRefs: currentConsequences.currentGoalRefs,
      availableInteractionIds: currentConsequences.availableInteractionIds,
    },
    ...(historicalMemory === undefined ? {} : { historicalMemory }),
    outwardAuthority: {
      allowedDiscloseFactIds: authority?.allowedFactIds ?? [],
      allowedEvidenceEventIds: authority?.allowedEventIds ?? [],
      allowedIntroductionFactIds: npc.knowledge.entries.filter(entry => canNpcDiscloseFact(npc, entry.factId, PLAYER_ENTITY_ID, input.worldState.eventLedger)
        && (authority?.allowedFactIds.includes(entry.factId)
          || hasCommittedConfidentialityPermission(npc, entry.factId, PLAYER_ENTITY_ID, input.worldState.eventLedger))).map(entry => entry.factId),
    },
    currentJob: {
      jobId: String(job.jobId),
      actionId: job.actionId,
      actionSummary: job.actionSummary,
      utterance: job.utterance,
      selectedDialogue: job.selectedDialogue,
      // Choice labels are recorded expressions, not necessarily spoken dialogue.
      selectedExpression: job.focusNpcId === npc.core.id
        ? currentNpcPlayerExpressions(input.storyState, job, npc.core.id) : undefined,
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
