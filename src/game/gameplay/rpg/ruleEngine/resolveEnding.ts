import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { NarrativeEventDraft } from "@/game/domain/events";
import { PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import { entitiesOfKind } from "@/game/domain/entity";
import { isStoryDeliveryComplete } from "@/game/gameplay/rpg/storyDelivery";
import { reconcileRuleDerivedStoryThreads } from "@/game/gameplay/rpg/storyThreads";
import { unresolvedStoryThreadIds } from "@/game/domain/storyThreads";

export type EndingResolveResult = {
  readonly nextWorldState: WorldState;
  readonly nextStoryState: StoryState;
  readonly drafts: readonly NarrativeEventDraft[];
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

function themeFromRequirements(
  ending: WorldState["endings"][number],
): "trust" | "doubt" | null {
  if (ending.requirements.some((req) => req.kind === "npc_affinity_at_least")) return "trust";
  if (ending.requirements.some((req) => req.kind === "npc_affinity_at_most")) return "doubt";
  return null;
}

export function resolveEnding(ws: WorldState, ss: StoryState): EndingResolveResult {
  if (!ss.endingAllowed || ws.ending !== null) {
    return { nextWorldState: ws, nextStoryState: ss, drafts: [] };
  }
  if (ss.contract.delivery !== undefined && !isStoryDeliveryComplete(ws, ss)) {
    return { nextWorldState: ws, nextStoryState: ss, drafts: [] };
  }

  // 终幕最后一次 support/challenge 是玩家刚做出的明确分歧，优先于旧的
  // 开场关系门槛；这样“支持最终知情人”不会被早先 NPC 的 affinity 覆盖。
  const finalNpc = ws.npcs.at(-1);
  const finalDialogueAct = finalNpc?.memory.interactionHistory.at(-1)?.dialogueAct;
  const confidentialityBroken = entitiesOfKind(ws.entityStore, "npc").some(npc => npc.relationships.outgoing.some(edge =>
    edge.commitments.some(commitment => commitment.kind === "promise" && commitment.status === "broken" && commitment.confidentiality !== undefined)));
  const explicitTheme = confidentialityBroken ? "doubt" : finalDialogueAct === "support" ? "trust" : finalDialogueAct === "challenge" ? "doubt" : null;
  const explicitEnding = explicitTheme === null
    ? undefined
    : ws.endings.find((ending) => themeFromRequirements(ending) === explicitTheme);

  // 其次：满足全部要求的结局。命中多个或一个都不中时，退化为按 id 的
  // 确定性平局裁决（同 id 排序下首个），保证 endingAllowed 下必有结局可达。
  const satisfied = ws.endings
    .filter((ending) => ending.requirements.every((req) => isRequirementMet(ws, req)));
  const candidates = satisfied.length > 0 ? satisfied : ws.endings;
  const matchingEnding = explicitEnding
    ?? [...candidates].sort((left, right) => left.id.localeCompare(right.id))[0];
  if (matchingEnding) {
    const draft: NarrativeEventDraft = {
      eventKey: `ending_reached:${matchingEnding.id}`,
      episodeKey: "turn",
      actorIds: [PLAYER_ENTITY_ID],
      targetIds: [PLAYER_ENTITY_ID],
      locationId: ws.currentLocationId,
      causeKeys: [],
      factIds: [],
      questIds: [],
      outcome: "success",
      salience: 100,
      payload: { type: "ending_reached", endingId: matchingEnding.id, outcome: "success" },
    };
    return {
      nextWorldState: {
        ...ws,
        ending: { endingId: matchingEnding.id, outcome: "success" },
      },
      nextStoryState: (() => {
        const threads = reconcileRuleDerivedStoryThreads({ worldState: ws, threads: ss.threads, eventDrafts: [draft] });
        return { ...ss, threads, unresolvedThreads: unresolvedStoryThreadIds(threads) };
      })(),
      drafts: [draft],
    };
  }

  return { nextWorldState: ws, nextStoryState: ss, drafts: [] };
}
