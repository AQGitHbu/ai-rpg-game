import type { GameEvent } from "./events";
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
  eventLedger: readonly GameEvent[],
  currentLocationId: LocationId,
): MaterializedView {
  if (eventLedger.length <= prev.reducedThroughEventCount) return prev;

  const newBeats: RecentBeat[] = [];
  const npcContactMap = new Map<string, NpcContact>(
    prev.npcContacts.map((c) => [String(c.npcId), c]),
  );

  for (let i = prev.reducedThroughEventCount; i < eventLedger.length; i++) {
    const event = eventLedger[i]!;
    const turn = i;

    if (BEAT_EVENTS.has(event.type)) {
      newBeats.push({ turn, kind: event.type, summary: summarizeBeat(event) });
    }

    if (event.type === "npc_met") {
      const npcId = event.npcId;
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

function summarizeBeat(event: GameEvent): string {
  switch (event.type) {
    case "quest_completed": return `Quest completed: ${String(event.questId)}`;
    case "quest_failed": return `Quest failed: ${String(event.questId)}`;
    case "fact_discovered": return `Fact discovered: ${String(event.factId)}`;
    case "npc_met": return `NPC met: ${String(event.npcId)}`;
    case "battle_resolved": return `Battle resolved: ${event.outcome}`;
    case "ending_reached": return `Ending: ${String(event.endingId)}`;
    case "blueprint_expanded": return `World expanded`;
    default: return event.type;
  }
}
