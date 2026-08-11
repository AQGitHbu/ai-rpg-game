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

  // 首选：满足全部要求的结局。命中多个或一个都不中时，退化为按 id 的
  // 确定性平局裁决（同 id 排序下首个），保证 endingAllowed 下必有结局可达。
  const satisfied = ws.endings
    .filter((ending) => ending.requirements.every((req) => isRequirementMet(ws, req)));
  const candidates = satisfied.length > 0 ? satisfied : ws.endings;
  const matchingEnding = [...candidates].sort((left, right) => left.id.localeCompare(right.id))[0];
  if (matchingEnding) {
      const event: GameEvent = {
        type: "ending_reached",
        endingId: matchingEnding.id,
        outcome: "success",
        occurredAt: deps.now(),
      };
      return {
        nextWorldState: {
          ...ws,
          ending: { endingId: matchingEnding.id, outcome: "success" },
          eventLedger: [...ws.eventLedger, event],
        },
        nextStoryState: ss,
        events: [event],
      };
  }

  return { nextWorldState: ws, nextStoryState: ss, events: [] };
}
