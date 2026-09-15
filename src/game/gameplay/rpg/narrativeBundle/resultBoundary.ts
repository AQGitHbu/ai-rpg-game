import type { Action } from "@/game/domain/action";
import type {
  CommittedNarrativeEvent,
  EventId,
  FactDiscoveredPayload,
  NpcGoalStatusChangedPayload,
  NpcKnowledgeChangedPayload,
  NpcRelationshipChangedPayload,
} from "@/game/domain/events";
import type { StoryState } from "@/game/domain/storyState";
import type { FactId, LocationId } from "@/game/domain/worldEntity";
import type { WorldState } from "@/game/domain/worldState";
import type { ResultBoundaryProof } from "@/game/domain/resultBoundary";
import { PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import { projectObserverEvidence } from "@/game/gameplay/rpg/narrativeMemory";

export type { ResultBoundaryProof } from "@/game/domain/resultBoundary";

/**
 * 服务端规则对“结果需要重新进入 A/B 叙事链”的唯一证明。
 *
 * 该类型故意不暴露客户端可构造的授权字段；调用者只能拿到规则已经
 * 提交的事件 ID，后续 provider job 只保存这个证明用于路由和审计。
 */
export type ResultBoundaryInput = Readonly<{
  readonly beforeWorld: WorldState;
  readonly beforeStory: StoryState;
  readonly afterWorld: WorldState;
  readonly afterStory: StoryState;
  readonly action: Action;
  readonly newEvents: readonly CommittedNarrativeEvent[];
}>;

type FactDiscoveredEvent = CommittedNarrativeEvent<FactDiscoveredPayload>;
type NpcGoalStatusChangedEvent = CommittedNarrativeEvent<NpcGoalStatusChangedPayload>;
type NpcKnowledgeChangedEvent = CommittedNarrativeEvent<NpcKnowledgeChangedPayload>;
type NpcRelationshipChangedEvent = CommittedNarrativeEvent<NpcRelationshipChangedPayload>;

function isFactDiscoveredEvent(event: CommittedNarrativeEvent): event is FactDiscoveredEvent {
  return event.payload.type === "fact_discovered";
}

function isNpcGoalOrKnowledgeEvent(
  event: CommittedNarrativeEvent,
): event is NpcGoalStatusChangedEvent | NpcKnowledgeChangedEvent {
  return event.payload.type === "npc_goal_status_changed"
    || event.payload.type === "npc_knowledge_changed";
}

function isNpcRelationshipChangedEvent(
  event: CommittedNarrativeEvent,
): event is NpcRelationshipChangedEvent {
  return event.payload.type === "npc_relationship_changed";
}

const REVISIT_CHANGE_KINDS: ReadonlySet<CommittedNarrativeEvent["kind"]> = new Set([
  "fact_discovered",
  "npc_goal_status_changed",
  "npc_knowledge_changed",
  "npc_relationship_changed",
  "story_interaction_resolved",
  "item_obtained",
  "item_given",
  "quest_completed",
  "quest_failed",
  "quest_unlocked",
  "location_unlocked",
  "enemy_defeated",
]);

function proveInvestigationResult(input: ResultBoundaryInput): ResultBoundaryProof | null {
  const action = input.action;
  if (action.type !== "investigate" || action.approachId === undefined) return null;
  if (action.approachId.trim() === "") return null;

  const beforeFact = input.beforeWorld.worldFacts.find((fact) => fact.factId === action.factId);
  const afterFact = input.afterWorld.worldFacts.find((fact) => fact.factId === action.factId);
  if (beforeFact?.discovered !== false || afterFact?.discovered !== true) return null;

  const sourceEventIds = input.newEvents
    .filter(isFactDiscoveredEvent)
    .filter((event) => event.payload.factId === action.factId)
    .filter((event) => event.payload.approachId === action.approachId)
    .map((event) => event.eventId);
  if (sourceEventIds.length === 0) return null;

  return {
    kind: "investigation_result",
    factId: action.factId,
    approachId: action.approachId,
    sourceEventIds: uniqueEventIds(sourceEventIds),
  };
}

function previousSceneEventAt(
  worldState: WorldState,
  locationId: LocationId,
): CommittedNarrativeEvent | null {
  const scenes = worldState.eventLedger.filter((event) =>
    event.kind === "narrative_scene_presented" && event.locationId === locationId,
  );
  return scenes.reduce<CommittedNarrativeEvent | null>(
    (latest, event) => latest === null || event.sequence > latest.sequence ? event : latest,
    null,
  );
}

function isLocationRelatedVisibleChange(
  event: CommittedNarrativeEvent,
  locationId: LocationId,
  worldState: WorldState,
): boolean {
  if (!REVISIT_CHANGE_KINDS.has(event.kind)) return false;
  if (event.locationId === locationId) return true;

  // NPC-scoped changes are accepted only when the affected NPC is actually
  // present at the revisited location in the resulting world projection.
  if (isNpcGoalOrKnowledgeEvent(event)) {
    return worldState.npcs.some((npc) =>
      npc.id === event.payload.npcId && npc.locationId === locationId,
    );
  }
  if (isNpcRelationshipChangedEvent(event)) {
    return worldState.npcs.some((npc) =>
      (npc.id === event.payload.fromNpcId || npc.id === event.payload.targetId)
      && npc.locationId === locationId,
    );
  }

  return false;
}

function proveChangedRevisit(input: ResultBoundaryInput): ResultBoundaryProof | null {
  if (input.action.type !== "move") return null;
  const locationId = input.action.locationId;
  if (input.beforeWorld.currentLocationId === locationId) return null;
  if (input.afterWorld.currentLocationId !== locationId) return null;
  if (!input.beforeWorld.visitedLocationIds.includes(locationId)) return null;

  const previousScene = previousSceneEventAt(input.beforeWorld, locationId);
  if (previousScene === null) return null;

  // Changes normally happen on an earlier action, before the player returns.
  // The latest actually presented scene is the acknowledgement watermark;
  // rendering a new result prevents subsequent visits replaying old changes.
  const visibleEvents = projectObserverEvidence({
    worldState: input.afterWorld,
    storyState: input.afterStory,
    observerId: PLAYER_ENTITY_ID,
  }).events;
  const sourceEventIds = visibleEvents
    .filter((event) => event.sequence > previousScene.sequence)
    .filter((event) => isLocationRelatedVisibleChange(event, locationId, input.afterWorld))
    .map((event) => event.eventId);
  if (sourceEventIds.length === 0) return null;

  return {
    kind: "changed_revisit",
    locationId,
    previousSceneEventId: previousScene.eventId,
    sourceEventIds: uniqueEventIds(sourceEventIds),
  };
}

function uniqueEventIds(eventIds: readonly EventId[]): readonly EventId[] {
  return [...new Set(eventIds)];
}

/**
 * 证明本次已提交规则结果是否需要新的 provider 场景。
 * beforeStory/afterStory 保留在接口中，确保边界判断始终以完整 A/B
 * 输入为契约；当前两类证明的权威条件来自 world ledger 与投影变化。
 */
export function proveResultBoundary(input: ResultBoundaryInput): ResultBoundaryProof | null {
  void input.beforeStory;
  return proveInvestigationResult(input) ?? proveChangedRevisit(input);
}
