import { createInitialWorldState } from "@/game/domain/worldState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { createFixtureNarrativeRuntimeState, createFixtureNarrativeScene } from "@/game/domain/narrativeTestFixture.testutil";
import { updateWorldStateFixture } from "@/game/domain/testing/worldStateFixture.testutil";
import { makeCommittedEvent } from "@/game/domain/testing/committedEventFactory";
import { asGenerationId, asItemId, asLocationId, asNpcId, asQuestId, PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import { applyEntityMutations } from "@/game/gameplay/rpg/entityWorld";

/** Test-only active delivery quest with two approved NPC answers. */
export function questExitFixture(delivered = false) {
  const revision = 7;
  const locationId = asLocationId("loc_exit");
  const npcId = asNpcId("npc_receiver");
  const itemId = asItemId("item_letter");
  const questId = asQuestId("quest_delivery");
  const sceneId = "scene-exit";
  const choiceRegistry = (["support", "challenge"] as const).map((dialogueAct) => ({
    choiceToken: `approved_${dialogueAct}`, sceneId, basedOnRevision: revision,
    label: dialogueAct === "support" ? "同意" : "追问", semanticSummary: dialogueAct,
    action: { type: "talk" as const, npcId, dialogueAct },
  }));
  const scene = createFixtureNarrativeScene({ sceneId, source: "generated",
    event: { kind: "dialogue", focusNpcId: npcId }, npcLine: { npcId, text: "你准备继续吗？", emotion: "neutral", usedFactIds: [], usedEventIds: [] },
    choices: choiceRegistry.map(({ choiceToken, label }) => ({ choiceToken, label })),
  });
  const story = { ...createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 1, npcs: 1, quests: 1, events: 0 },
    initialNarrative: { ...createFixtureNarrativeRuntimeState(scene), mode: "ai", choiceRegistry } }),
    turnNumber: 4, delivery: { itemId, giverNpcId: asNpcId("npc_giver"), recipientNpcId: npcId },
  };
  const initial = createInitialWorldState({ generation: { generationId: asGenerationId("g_exit"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "信使", identity: "旅人", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: { id: locationId, name: "渡口", description: "渡口", kind: "main", connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [] }, startingItemIds: [],
  });
  let world = updateWorldStateFixture(initial, {
    locations: initial.locations.map(location => ({ ...location, npcIds: [npcId] })),
    npcs: [{ id: npcId, name: "接应人", role: "收信人", description: "等候信件", locationId, isCompanion: false, tags: [], met: true,
      memory: { npcId, knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] } }],
    items: [{ id: itemId, name: "信件", description: "待送信件", kind: "quest", tags: [] }], inventory: [itemId],
    quests: [{ id: questId, name: "递送信件", description: "将信件交给接应人", kind: "main", stage: 1, status: "active",
      objectives: [{ kind: "talk_to_npc", npcId }], onSuccess: { kind: "advance_story" }, onFailure: { kind: "closed" }, tags: [] }],
  });
  if (delivered) {
    const transferred = applyEntityMutations(world, [{ kind: "transfer_item", itemId, owner: { kind: "npc", npcId } }]);
    if (!transferred.ok) throw new Error(transferred.code);
    world = { ...transferred.worldState, eventLedger: [makeCommittedEvent({ type: "item_given", itemId, npcId, locationId }, { outcome: "success", actorIds: [PLAYER_ENTITY_ID], targetIds: [npcId] })] };
  }
  return { world, story, revision, questId, npcId };
}
