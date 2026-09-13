import type { CommittedNarrativeEvent } from "../events";
import { PLAYER_ENTITY_ID, type FactId } from "../worldEntity";
import type { NpcEntityRecord } from "./entityRecord";

/** Permission to offer/perform a private disclosure, never a knowledge mutation. */
export function hasCommittedConfidentialityPermission(
  npc: NpcEntityRecord,
  factId: FactId,
  audienceId: string | undefined,
  ledger: readonly CommittedNarrativeEvent[] = [],
): boolean {
  if (audienceId !== PLAYER_ENTITY_ID) return false;
  const edge = npc.relationships.outgoing.find(entry => entry.targetId === PLAYER_ENTITY_ID);
  return edge?.commitments.some(commitment => {
    if (commitment.kind !== "promise" || commitment.promisor !== "target"
      || commitment.status !== "open" || commitment.source.kind !== "action"
      || commitment.confidentiality === undefined) return false;
    const terms = commitment.confidentiality;
    if (!terms.protectedFactIds.includes(factId)
      || !terms.allowedAudienceIds.includes(PLAYER_ENTITY_ID)
      || !terms.allowedAudienceIds.includes(npc.core.id)) return false;
    const actionId = commitment.source.actionId;
    return ledger.some(event => event.actionId === actionId && event.outcome === "success"
      && event.actorIds.includes(PLAYER_ENTITY_ID)
      && event.payload.type === "story_interaction_resolved"
      && event.payload.operation === "promise_confidentiality"
      && event.payload.npcId === npc.core.id
      && commitment.commitmentId === `cmt:action:${actionId}:open_promise:${event.payload.interactionId}`);
  }) ?? false;
}

/** Shared gameplay/authorisation rule; scene visibility is a separate speech gate. */
export function canNpcDiscloseFact(
  npc: NpcEntityRecord,
  factId: FactId,
  audienceId: string | undefined,
  ledger: readonly CommittedNarrativeEvent[] = [],
): boolean {
  const entry = npc.knowledge.entries.find(candidate => candidate.factId === factId);
  if (entry === undefined) return false;
  if (entry.disclosure === "public") return true;
  if (hasCommittedConfidentialityPermission(npc, factId, audienceId, ledger)) return true;
  if (entry.disclosure === "secret") return false;
  const edge = npc.relationships.outgoing.find(candidate => candidate.targetId === audienceId);
  return edge?.stage === "cooperative" || edge?.stage === "trusted" || edge?.stage === "bonded";
}


/** A past successful disclosure permits retelling only to its original player audience. */
export function hasCommittedDisclosureToPlayer(
  npc: NpcEntityRecord,
  factId: FactId,
  audienceId: string | undefined,
  ledger: readonly CommittedNarrativeEvent[] = [],
): boolean {
  return audienceId === PLAYER_ENTITY_ID && ledger.some(event => event.outcome === "success"
    && event.payload.type === "story_interaction_resolved"
    && (event.payload.operation === "request_introduction" || event.payload.operation === "request_verification")
    && event.payload.npcId === npc.core.id && event.actorIds.includes(npc.core.id)
    && event.payload.factIds.includes(factId) && event.payload.audienceIds.includes(PLAYER_ENTITY_ID));
}
