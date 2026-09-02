/**
 * Test-only factory for creating CommittedNarrativeEvent objects.
 * Production code must use commitEventDrafts.
 */
import type { CommittedNarrativeEvent, NarrativeEventPayload, EventId, EpisodeId, TurnId } from "../events";
import { asEventId, asTurnId, asEpisodeId, eventIdFor, episodeIdForTurn } from "../events";
import type { LocationId, NpcId, PlayerEntityId, EnemyId, FactId, QuestId } from "../worldEntity";
import { PLAYER_ENTITY_ID } from "../worldEntity";

let testSequence = 0;
let testTurnCounter = 0;

/**
 * Reset the test sequence counter (call in beforeEach).
 */
export function resetTestEventSequence(): void {
  testSequence = 0;
  testTurnCounter = 0;
}

function nextTurnId(): TurnId {
  testTurnCounter += 1;
  return asTurnId(`test:turn:${testTurnCounter}`);
}

/**
 * Create a minimal CommittedNarrativeEvent for testing.
 * Most fields have sensible defaults; callers override what they need.
 */
export function makeCommittedEvent(
  payload: NarrativeEventPayload,
  overrides: Partial<CommittedNarrativeEvent> = {},
): CommittedNarrativeEvent {
  const turnId = overrides.turnId ?? nextTurnId();
  const eventKey = `test_event:${testSequence}`;
  const sequence = overrides.sequence ?? testSequence;
  testSequence += 1;
  return {
    eventId: overrides.eventId ?? eventIdFor(turnId, eventKey),
    sequence,
    turnId,
    turnNumber: overrides.turnNumber ?? 0,
    episodeId: overrides.episodeId ?? episodeIdForTurn(turnId),
    kind: overrides.kind ?? payload.type,
    actorIds: overrides.actorIds ?? [PLAYER_ENTITY_ID],
    targetIds: overrides.targetIds ?? [],
    locationId: overrides.locationId ?? null,
    causeEventIds: overrides.causeEventIds ?? [],
    factIds: overrides.factIds ?? [],
    questIds: overrides.questIds ?? [],
    outcome: overrides.outcome ?? "neutral",
    salience: overrides.salience ?? 50,
    committedAt: overrides.committedAt ?? "2026-01-01T00:00:00Z",
    payload: overrides.payload ?? payload,
    ...(overrides.actionId !== undefined ? { actionId: overrides.actionId } : {}),
  };
}

/**
 * Create a committed event from a legacy-style payload object.
 * Usage: fromLegacyPayload({ type: "fact_discovered", factId: asFactId("f1") })
 */
export function fromLegacyPayload(
  legacyPayload: NarrativeEventPayload,
  overrides: Partial<CommittedNarrativeEvent> = {},
): CommittedNarrativeEvent {
  return makeCommittedEvent(legacyPayload, overrides);
}
