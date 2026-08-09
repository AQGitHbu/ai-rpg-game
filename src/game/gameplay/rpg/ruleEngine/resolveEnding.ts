import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { GameEvent } from "@/game/domain/events";

export type EndingResolveResult = {
  readonly nextWorldState: WorldState;
  readonly nextStoryState: StoryState;
  readonly events: readonly GameEvent[];
};

function isRequirementMet(ws: WorldState, req: WorldState["endings"][number]["requirements"][number]): boolean {
  switch (req.kind) {
    case "quest_completed": return ws.quests.find((q) => q.id === req.questId)?.status === "completed";
    case "quest_failed": return ws.quests.find((q) => q.id === req.questId)?.status === "failed";
    case "fact_discovered": return ws.worldFacts.find((f) => f.factId === req.factId)?.discovered ?? false;
    case "npc_affinity_at_least": return (ws.npcs.find((npc) => npc.id === req.npcId)?.memory.relationship.affinity ?? -101) >= req.value;
    case "npc_affinity_at_most": return (ws.npcs.find((npc) => npc.id === req.npcId)?.memory.relationship.affinity ?? 101) <= req.value;
  }
}

export function resolveEnding(ws: WorldState, ss: StoryState, deps: { readonly now: () => string }): EndingResolveResult {
  if (!ss.endingAllowed || ws.ending !== null) {
    return { nextWorldState: ws, nextStoryState: ss, events: [] };
  }

  for (const ending of ws.endings) {
    if (ending.requirements.every((req) => isRequirementMet(ws, req))) {
      const event: GameEvent = {
        type: "ending_reached",
        endingId: ending.id,
        outcome: "success",
        occurredAt: deps.now(),
      };
      return {
        nextWorldState: {
          ...ws,
          ending: { endingId: ending.id, outcome: "success" },
          eventLedger: [...ws.eventLedger, event],
        },
        nextStoryState: ss,
        events: [event],
      };
    }
  }

  return { nextWorldState: ws, nextStoryState: ss, events: [] };
}
