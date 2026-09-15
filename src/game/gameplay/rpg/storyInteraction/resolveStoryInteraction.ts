import type { Action, TalkAction } from "@/game/domain/action";
import { eventIdFor, type NarrativeEventDraft } from "@/game/domain/events";
import { canNpcDiscloseFact, getEntity, type EntityId, type EntityRecord, type ItemEntityRecord, type NpcEntityRecord } from "@/game/domain/entity";
import type { EntityMutation } from "@/game/gameplay/rpg/entityWorld";
import { applyEntityMutations } from "@/game/gameplay/rpg/entityWorld";
import { PLAYER_ENTITY_ID, type FactId, type NpcId, type PlayerEntityId } from "@/game/domain/worldEntity";
import type { WorldState } from "@/game/domain/worldState";
import type { ResolveDeps, ResolveResult } from "../ruleEngine/resolveByType";
import type { StoryCondition, StoryInteraction } from "@/game/domain/storyInteraction";
import { canRevealFactWithoutInvestigation } from "@/game/gameplay/rpg/investigation";

function npcOf(worldState: WorldState, npcId: NpcId): NpcEntityRecord | undefined {
  const record = getEntity(worldState.entityStore, npcId);
  return isNpcRecord(record) && record.core.lifecycle === "active" ? record : undefined;
}

function isNpcRecord(record: EntityRecord | undefined): record is NpcEntityRecord {
  return record?.core.kind === "npc";
}

function isPlayerRecord(record: EntityRecord | undefined): record is Extract<EntityRecord, { core: { kind: "player_character" } }> {
  return record?.core.kind === "player_character";
}

function isItemRecord(record: EntityRecord | undefined): record is ItemEntityRecord {
  return record?.core.kind === "item";
}

function hasItem(worldState: WorldState, itemId: string, ownerId: string): boolean {
  const item = getEntity(worldState.entityStore, itemId);
  if (!isItemRecord(item)) return false;
  const owner = item.possession.owner;
  if (owner.kind === "player") return owner.playerId === ownerId;
  if (owner.kind === "location") return owner.locationId === ownerId;
  if (owner.kind === "npc") return owner.npcId === ownerId;
  return false;
}

function knowsFact(worldState: WorldState, actorId: string, factId: string): boolean {
  if (actorId === PLAYER_ENTITY_ID) {
    const player = getEntity(worldState.entityStore, PLAYER_ENTITY_ID);
    return isPlayerRecord(player)
      && player.knowledge.knownFactIds.some((knownFactId) => String(knownFactId) === factId);
  }
  const actor = getEntity(worldState.entityStore, actorId);
  return isNpcRecord(actor)
    && actor.knowledge.entries.some((entry) => String(entry.factId) === factId);
}

function commitmentStatus(worldState: WorldState, npcId: string, promiseId: string): string | undefined {
  const npc = getEntity(worldState.entityStore, npcId);
  if (!isNpcRecord(npc)) return undefined;
  for (const edge of npc.relationships.outgoing) {
    const commitment = edge.commitments.find((entry) => entry.commitmentId === promiseId);
    if (commitment !== undefined) return commitment.status;
  }
  return undefined;
}

function goalStatus(worldState: WorldState, npcId: string, goalId: string): string | undefined {
  const npc = getEntity(worldState.entityStore, npcId);
  if (!isNpcRecord(npc)) return undefined;
  return npc.dynamicState.goals.find((goal) => goal.goalId === goalId)?.status;
}

/** Pure condition evaluator shared by interactions and story-thread closure. */
export function evaluateStoryCondition(worldState: WorldState, condition: StoryCondition): boolean {
  switch (condition.kind) {
    case "has_item":
      return hasItem(worldState, String(condition.itemId), String(condition.ownerId));
    case "knows_fact":
      return knowsFact(worldState, String(condition.actorId), String(condition.factId));
    case "promise_status":
      return commitmentStatus(worldState, String(condition.npcId), condition.promiseId) === condition.status;
    case "goal_status":
      return goalStatus(worldState, String(condition.npcId), condition.goalId) === condition.status;
    case "investigation_observed": {
      const discoveries = new Map<string, { readonly factId: string; readonly evidenceQuality: "clean" | "noisy" }>();
      for (const event of worldState.eventLedger) {
        if (event.payload.type === "fact_discovered" && event.payload.evidenceQuality !== undefined) {
          discoveries.set(String(event.eventId), { factId: String(event.payload.factId), evidenceQuality: event.payload.evidenceQuality });
        }
      }
      return worldState.eventLedger.some((event) => {
        if (event.outcome === "failure") return false;
        if (event.payload.type === "fact_discovered") {
          return String(event.payload.factId) === String(condition.factId)
            && event.payload.evidenceQuality === condition.evidenceQuality
            && (event.payload.witnessNpcIds ?? []).some((npcId) => String(npcId) === String(condition.npcId));
        }
        if (event.payload.type !== "story_interaction_resolved" || event.payload.operation !== "share_known_fact") return false;
        if (!(event.payload.audienceIds ?? []).some((audienceId) => String(audienceId) === String(condition.npcId))) return false;
        if (!event.payload.factIds.includes(condition.factId)) return false;
        return event.payload.evidenceEventIds.some((sourceEventId) => {
          const source = discoveries.get(String(sourceEventId));
          return source !== undefined && source.factId === String(condition.factId) && source.evidenceQuality === condition.evidenceQuality;
        });
      });
    }
  }
}

function blockedResult(worldState: WorldState, feedback: string): ResolveResult {
  return { ok: true, nextWorldState: worldState, drafts: [], feedback, status: "blocked", stateChanges: [], facts: [] };
}

function interactionFor(worldState: WorldState, action: TalkAction): StoryInteraction | undefined {
  if (action.interactionId === undefined) return undefined;
  const npc = npcOf(worldState, action.npcId);
  return npc?.interactions?.find((entry) => entry.id === action.interactionId);
}

function cooperationDefinitionFor(
  npc: NpcEntityRecord,
  operation: StoryInteraction["operation"],
) {
  if (operation !== "request_introduction" && operation !== "request_verification") return undefined;
  return npc.cooperationDefinitions?.find((definition) => definition.operation === operation);
}

function subsetOf(values: readonly string[], allowed: readonly string[]): boolean {
  const permitted = new Set(allowed.map(String));
  return values.every((value) => permitted.has(String(value)));
}

function knownFacts(worldState: WorldState, npcId: NpcId, factIds: readonly FactId[]): boolean {
  return factIds.every((factId) => knowsFact(worldState, String(npcId), String(factId)));
}

function canDiscloseFactToAudience(
  worldState: WorldState,
  npcId: NpcId,
  factId: FactId,
  audienceId: EntityId,
): boolean {
  const fact = worldState.worldFacts.find((entry) => entry.factId === factId);
  if (fact === undefined || !canRevealFactWithoutInvestigation({ worldState, factId })) return false;
  const npc = npcOf(worldState, npcId);
  if (npc === undefined) return false;
  return canNpcDiscloseFact(npc, factId, audienceId, worldState.eventLedger);
}

function canDiscloseFactsToAudiences(
  worldState: WorldState,
  interaction: StoryInteraction,
  npcId: NpcId,
): boolean {
  return interaction.factIds.every((factId) => interaction.audienceIds.every((audienceId) =>
    canDiscloseFactToAudience(worldState, npcId, factId, audienceId)));
}

function evidenceExists(worldState: WorldState, eventIds: readonly string[]): boolean {
  const ledger = new Set(worldState.eventLedger.map((event) => String(event.eventId)));
  return eventIds.every((eventId) => ledger.has(eventId));
}

function entityExists(worldState: WorldState, entityId: EntityId): boolean {
  const record = getEntity(worldState.entityStore, String(entityId));
  return record !== undefined && record.core.lifecycle === "active";
}

function baseInteractionDraft(
  worldState: WorldState,
  interaction: StoryInteraction,
  action: TalkAction,
  audienceIds: readonly EntityId[],
): NarrativeEventDraft {
  return {
    eventKey: `story_interaction_resolved:${interaction.id}`,
    episodeKey: "turn",
    actorIds: (interaction.operation === "promise_confidentiality" || interaction.operation === "share_known_fact") ? [PLAYER_ENTITY_ID] : [PLAYER_ENTITY_ID, action.npcId],
    targetIds: audienceIds.flatMap((id): readonly (PlayerEntityId | NpcId)[] => {
      const record = getEntity(worldState.entityStore, String(id));
      if (record?.core.kind === "npc") return [record.core.id];
      if (record?.core.kind === "player_character") return [PLAYER_ENTITY_ID];
      return [];
    }),
    locationId: worldState.currentLocationId,
    causeKeys: [],
    factIds: interaction.factIds,
    questIds: [],
    outcome: "success",
    salience: 60,
    payload: {
      type: "story_interaction_resolved",
      interactionId: interaction.id,
      npcId: action.npcId,
      operation: interaction.operation,
      factIds: interaction.factIds,
      audienceIds,
      evidenceEventIds: interaction.evidenceEventIds,
    },
  };
}

function factDiscoveryMutations(worldState: WorldState, factIds: readonly FactId[]): EntityMutation[] {
  return factIds
    .filter((factId) => worldState.worldFacts.some((fact) => fact.factId === factId && !fact.discovered))
    .map((factId) => ({ kind: "discover_fact", factId }));
}

function audienceMutations(
  worldState: WorldState,
  interaction: StoryInteraction,
  action: TalkAction,
  deps: ResolveDeps,
  factIds: readonly FactId[],
): EntityMutation[] | null {
  if (interaction.audienceIds.length === 0) return null;
  const mutations: EntityMutation[] = [];
  const eventId = eventIdFor(deps.turnId, `story_interaction_resolved:${interaction.id}`);
  for (const audienceId of interaction.audienceIds) {
    if (interaction.operation !== "share_known_fact" && String(audienceId) === String(action.npcId)) return null;
    const audience = getEntity(worldState.entityStore, String(audienceId));
    if (audience?.core.kind === "player_character") {
      if (interaction.operation === "share_known_fact") return null;
      mutations.push(...factDiscoveryMutations(worldState, factIds));
      continue;
    }
    if (audience?.core.kind !== "npc" || audience.core.lifecycle !== "active") return null;
    for (const factId of factIds) {
      mutations.push({
        kind: "record_npc_knowledge",
        npcId: audience.core.id,
        factId,
        certainty: "known",
        disclosure: "public",
        source: {
          kind: "action",
          mode: interaction.operation === "share_known_fact" ? "player_told" : "npc_revealed",
          actionId: deps.actionId,
          eventId,
          turnNumber: deps.turnNumber,
          ...(interaction.operation === "share_known_fact" ? {} : { sourceNpcId: action.npcId }),
        },
      });
      if (interaction.operation !== "share_known_fact") mutations.push({
        kind: "apply_relationship_signal",
        fromNpcId: action.npcId,
        targetId: audience.core.id,
        signal: "shared_fact",
        source: { kind: "action", actionId: deps.actionId, turnNumber: deps.turnNumber },
        supportingEventId: eventId,
      });
    }
  }
  return mutations;
}

/** Resolve one server-approved interaction; no persistence or event append occurs here. */
export function resolveStoryInteraction(
  worldState: WorldState,
  action: Extract<Action, { type: "talk" }>,
  deps: ResolveDeps,
): ResolveResult {
  const npc = npcOf(worldState, action.npcId);
  const interaction = interactionFor(worldState, action);
  if (npc === undefined || interaction === undefined || interaction.npcId !== action.npcId) {
    return { ok: false, feedback: "未知的故事互动。" };
  }
  if (interaction.condition.some((entry) => !evaluateStoryCondition(worldState, entry))) {
    return blockedResult(worldState, "当前条件不满足。");
  }
  const cooperation = cooperationDefinitionFor(npc, interaction.operation);
  if ((interaction.operation === "request_introduction" || interaction.operation === "request_verification")
    && npc.cooperationDefinitions !== undefined) {
    if (cooperation === undefined) return { ok: false, feedback: "该角色未批准这类合作。" };
    if (cooperation.requirements.some((entry) => !evaluateStoryCondition(worldState, entry))) {
      return blockedResult(worldState, "合作前提尚未满足。");
    }
    if (interaction.factIds.length === 0 || interaction.audienceIds.length === 0
      || !subsetOf(interaction.factIds, cooperation.allowedFactIds)
      || !subsetOf(interaction.audienceIds, cooperation.allowedAudienceIds)) {
      return { ok: false, feedback: "合作范围不在角色批准的边界内。" };
    }
  }
  if (!interaction.factIds.every((factId) => entityExists(worldState, factId))) {
    return { ok: false, feedback: "互动引用了未知事实。" };
  }
  if (!interaction.audienceIds.every((audienceId) => entityExists(worldState, audienceId))) {
    return { ok: false, feedback: "互动引用了未知听众。" };
  }
  const playerShares = interaction.operation === "share_known_fact";
  if (playerShares && !interaction.evidenceEventIds.every((id) => {
    const source = worldState.eventLedger.find((event) => event.eventId === id);
    if (source === undefined || source.outcome === "failure") return false;
    if (source.payload.type !== "fact_discovered") return true;
    return interaction.factIds.includes(source.payload.factId)
      && (source.actorIds.includes(PLAYER_ENTITY_ID) || source.targetIds.includes(PLAYER_ENTITY_ID));
  })) return { ok: false, feedback: "告知的调查来源与实际分享不一致。" };
  if (playerShares && (!interaction.audienceIds.includes(action.npcId) || interaction.audienceIds.some((id) => npcOf(worldState, id as NpcId)?.position.locationId !== worldState.currentLocationId))) return { ok: false, feedback: "告知听众不在现场。" };
  if (!(playerShares ? interaction.factIds.every((id) => knowsFact(worldState, PLAYER_ENTITY_ID, id)) : knownFacts(worldState, action.npcId, interaction.factIds))) {
    return { ok: false, feedback: "角色没有足够的事实依据。" };
  }
  if (!playerShares && interaction.operation !== "promise_confidentiality" && !canDiscloseFactsToAudiences(worldState, interaction, action.npcId)) {
    return { ok: false, feedback: "角色没有足够的披露权限。" };
  }
  if (interaction.operation === "request_verification" && !evidenceExists(worldState, interaction.evidenceEventIds)) {
    return { ok: false, feedback: "核验依据尚未成立。" };
  }
  if (interaction.audienceIds.length === 0) {
    return { ok: false, feedback: "互动听众无效。" };
  }
  if (interaction.operation !== "promise_confidentiality" && interaction.factIds.length === 0) {
    return { ok: false, feedback: "互动没有事实结果。" };
  }

  if (interaction.operation === "promise_confidentiality" && interaction.confidentiality === undefined) return { ok: false, feedback: "保密承诺缺少明确条款。" };
  if (interaction.confidentiality !== undefined && (
    !knownFacts(worldState, action.npcId, interaction.confidentiality.protectedFactIds)
    || !interaction.confidentiality.allowedAudienceIds.every((id) => entityExists(worldState, id))
    || !interaction.confidentiality.allowedAudienceIds.includes(PLAYER_ENTITY_ID))) {
    return { ok: false, feedback: "保密承诺引用无效。" };
  }
  const eventId = eventIdFor(deps.turnId, `story_interaction_resolved:${interaction.id}`);
  const mutations: EntityMutation[] = [];
  switch (interaction.operation) {
    case "promise_confidentiality":
      mutations.push({
        kind: "apply_relationship_commitment",
        fromNpcId: action.npcId,
        targetId: PLAYER_ENTITY_ID,
        operation: { kind: "open_promise", openKey: interaction.id, promisor: "target", description: "relationship.promise.confidentiality", ...(interaction.confidentiality === undefined ? {} : { confidentiality: interaction.confidentiality }) },
        source: { kind: "action", actionId: deps.actionId, turnNumber: deps.turnNumber },
        supportingEventId: eventId,
      });
      break;
    case "request_introduction":
    case "request_verification":
      {
        const audience = audienceMutations(worldState, interaction, action, deps, interaction.factIds);
        if (audience === null) return { ok: false, feedback: "互动听众无效。" };
        mutations.push(...audience);
      }
      break;
    case "share_known_fact": {
      const audience = audienceMutations(worldState, interaction, action, deps, interaction.factIds);
      if (audience === null) return { ok: false, feedback: "互动听众无效。" };
      mutations.push(...audience);
      break;
    }
  }

  const applied = applyEntityMutations(worldState, mutations);
  if (!applied.ok) return { ok: false, feedback: "互动后果无法写入世界。" };
  const audience = interaction.operation === "promise_confidentiality"
    ? [...new Set([action.npcId, ...interaction.audienceIds.filter((id) => id !== PLAYER_ENTITY_ID)])]
    : interaction.audienceIds;
  const playerWasInformed = audience.some((audienceId) => String(audienceId) === String(PLAYER_ENTITY_ID));
  const disclosedFacts = interaction.operation !== "promise_confidentiality" && playerWasInformed ? interaction.factIds : [];
  return {
    ok: true,
    nextWorldState: applied.worldState,
    drafts: [baseInteractionDraft(worldState, interaction, action, audience)],
    feedback: "互动已按条件结算。",
    status: "success",
    stateChanges: disclosedFacts.map((factId) => ({ path: `worldFacts[${String(factId)}].discovered`, description: "互动产生事实结果", operation: "set" as const })),
    facts: disclosedFacts.map((factId) => ({ factId, change: "revealed" as const, source: "npc_revealed" as const })),
  };
}
