import type { EntityId } from "@/game/domain/entity";
import { getEntity, type NpcEntityRecord } from "@/game/domain/entity";
import type { StoryConditionProposal } from "@/game/domain/storyConsequenceBindings";
import type { StoryCondition } from "@/game/domain/storyInteraction";
import type { WorldState } from "@/game/domain/worldState";
import { PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";

export type ResolveStoryConditionInput = Readonly<{
  proposal: StoryConditionProposal;
  worldState: WorldState;
  symbols: ReadonlyMap<string, string>;
}>;

export type ResolveStoryConditionResult =
  | Readonly<{ ok: true; condition: StoryCondition }>
  | Readonly<{ ok: false; code: string; path: string }>;

function resolveRef(raw: string, symbols: ReadonlyMap<string, string>): string | null {
  return symbols.get(raw) ?? (raw.trim() === "" ? null : raw);
}

function activeEntity(worldState: WorldState, id: string): EntityId | null {
  const record = getEntity(worldState.entityStore, id);
  return record?.core.lifecycle === "active" ? record.core.id : null;
}

function activeNpc(worldState: WorldState, id: string): string | null {
  const record = getEntity(worldState.entityStore, id);
  return record?.core.kind === "npc" && record.core.lifecycle === "active" ? String(record.core.id) : null;
}

function resolveGoalId(worldState: WorldState, npcId: string, proposal: Extract<StoryConditionProposal, { kind: "goal_status" }>): string | null {
  const npc = getEntity(worldState.entityStore, npcId);
  if (npc?.core.kind !== "npc" || npc.core.lifecycle !== "active") return null;
  const npcRecord = npc as NpcEntityRecord;
  if (proposal.goalId !== undefined) {
    return npcRecord.dynamicState.goals.some((goal) => goal.goalId === proposal.goalId) ? proposal.goalId : null;
  }
  if (proposal.goalOrdinal === undefined || !Number.isInteger(proposal.goalOrdinal) || proposal.goalOrdinal < 0) return null;
  return npcRecord.dynamicState.goals[proposal.goalOrdinal]?.goalId ?? null;
}

export function resolveStoryConditionProposal(input: ResolveStoryConditionInput): ResolveStoryConditionResult {
  const { proposal, worldState, symbols } = input;
  const ref = (value: string): string | null => resolveRef(value, symbols);
  switch (proposal.kind) {
    case "has_item": {
      const itemId = ref(proposal.itemId);
      const ownerId = ref(proposal.ownerId);
      if (itemId === null || ownerId === null || getEntity(worldState.entityStore, itemId)?.core.kind !== "item"
        || (ownerId !== PLAYER_ENTITY_ID && activeEntity(worldState, ownerId) === null)) return { ok: false, code: "unknown_condition_ref", path: proposal.kind };
      return { ok: true, condition: { kind: "has_item", itemId: itemId as never, ownerId: ownerId as EntityId } };
    }
    case "knows_fact": {
      const actorId = ref(proposal.actorId);
      const factId = ref(proposal.factId);
      if (actorId === null || factId === null || getEntity(worldState.entityStore, factId)?.core.kind !== "fact"
        || (actorId !== PLAYER_ENTITY_ID && activeNpc(worldState, actorId) === null)) return { ok: false, code: "unknown_condition_ref", path: proposal.kind };
      return { ok: true, condition: { kind: "knows_fact", actorId: actorId as EntityId, factId: factId as never } };
    }
    case "promise_status": {
      const npcId = ref(proposal.npcId);
      if (npcId === null || activeNpc(worldState, npcId) === null) return { ok: false, code: "unknown_condition_ref", path: proposal.kind };
      const npc = getEntity(worldState.entityStore, npcId);
      if (npc?.core.kind !== "npc" || !(npc as NpcEntityRecord).relationships.outgoing.some((edge) => edge.commitments.some((commitment) => commitment.commitmentId === proposal.promiseId))) {
        return { ok: false, code: "unknown_promise_ref", path: proposal.kind };
      }
      return { ok: true, condition: { ...proposal, npcId: npcId as never } };
    }
    case "goal_status": {
      const npcId = ref(proposal.npcId);
      if (npcId === null) return { ok: false, code: "unknown_condition_ref", path: proposal.kind };
      const goalId = resolveGoalId(worldState, npcId, proposal);
      if (goalId === null) return { ok: false, code: "unknown_goal_ref", path: proposal.kind };
      return { ok: true, condition: { kind: "goal_status", npcId: npcId as never, goalId, status: proposal.status } };
    }
    case "investigation_observed": {
      const npcId = ref(proposal.npcId);
      const factId = ref(proposal.factId);
      if (npcId === null || factId === null || activeNpc(worldState, npcId) === null || getEntity(worldState.entityStore, factId)?.core.kind !== "fact") {
        return { ok: false, code: "unknown_condition_ref", path: proposal.kind };
      }
      return { ok: true, condition: { kind: "investigation_observed", npcId: npcId as never, factId: factId as never, evidenceQuality: proposal.evidenceQuality } };
    }
  }
}
