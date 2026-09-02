import type { CommittedNarrativeEvent } from "./events";
import type { LocationId, NpcId } from "./worldEntity";

const RECENT_BEATS_LIMIT = 12;

export type RecentBeat = {
  readonly turn: number;
  readonly kind: string;
  readonly summary: string;
};

export type NpcContact = {
  readonly npcId: NpcId;
  readonly lastContactTurn: number;
  readonly lastLocationId: LocationId;
};

export type MaterializedView = {
  readonly recentBeats: readonly RecentBeat[];
  readonly npcContacts: readonly NpcContact[];
  readonly reducedThroughEventCount: number;
};

export function createEmptyMaterializedView(): MaterializedView {
  return { recentBeats: [], npcContacts: [], reducedThroughEventCount: 0 };
}

const BEAT_EVENTS = new Set([
  "quest_completed", "quest_failed", "fact_discovered", "npc_met",
  "battle_resolved", "ending_reached", "blueprint_expanded",
]);

export function reconcileMaterializedView(
  prev: MaterializedView,
  eventLedger: readonly CommittedNarrativeEvent[],
  currentLocationId: LocationId,
): MaterializedView {
  if (eventLedger.length <= prev.reducedThroughEventCount) return prev;

  const newBeats: RecentBeat[] = [];
  const npcContactMap = new Map<string, NpcContact>(
    prev.npcContacts.map((c) => [String(c.npcId), c]),
  );

  for (let i = prev.reducedThroughEventCount; i < eventLedger.length; i++) {
    const event = eventLedger[i]!;
    const turn = event.turnNumber;

    if (BEAT_EVENTS.has(event.kind)) {
      newBeats.push({ turn, kind: event.kind, summary: summarizeBeat(event) });
    }

    if (event.kind === "npc_met") {
      const payload = event.payload as { npcId: NpcId };
      const npcId = payload.npcId;
      npcContactMap.set(String(npcId), {
        npcId,
        lastContactTurn: turn,
        lastLocationId: currentLocationId,
      });
    }
  }

  const allBeats = [...prev.recentBeats, ...newBeats].slice(-RECENT_BEATS_LIMIT);

  return {
    recentBeats: allBeats,
    npcContacts: Array.from(npcContactMap.values()),
    reducedThroughEventCount: eventLedger.length,
  };
}

function summarizeBeat(event: CommittedNarrativeEvent): string {
  switch (event.kind) {
    case "quest_completed": {
      const p = event.payload as { questId: string };
      return `Quest completed: ${p.questId}`;
    }
    case "quest_failed": {
      const p = event.payload as { questId: string };
      return `Quest failed: ${p.questId}`;
    }
    case "fact_discovered": {
      const p = event.payload as { factId: string };
      return `Fact discovered: ${p.factId}`;
    }
    case "npc_met": {
      const p = event.payload as { npcId: string };
      return `NPC met: ${p.npcId}`;
    }
    case "battle_resolved": {
      const p = event.payload as { outcome: string };
      return `Battle resolved: ${p.outcome}`;
    }
    case "ending_reached": {
      const p = event.payload as { endingId: string };
      return `Ending: ${p.endingId}`;
    }
    case "blueprint_expanded":
      return `World expanded`;
    default:
      return event.kind;
  }
}
