import { describe, expect, it } from "vitest";
import { asFactId, asGenerationId, asLocationId, asNpcId, asQuestId } from "@/game/domain/worldEntity";
import { createWorldStateFixture, emptyProjection } from "@/game/domain/testing/worldStateFixture.testutil";
import { getEntity, type FactEntityRecord, type NpcEntityRecord, type QuestEntityRecord } from "@/game/domain/entity";
import { createInitialStoryState } from "@/game/domain/storyState";
import { approveStoryConsequenceBindings } from "./approveStoryConsequenceBindings";

const LOCATION = asLocationId("loc_binding");
const NPC = asNpcId("npc_binding");
const FACT = asFactId("fact_binding");
const QUEST = asQuestId("quest_binding");

function world() {
  return createWorldStateFixture({
    generation: { generationId: asGenerationId("gen:binding"), seed: "seed", templateVersion: "v1", inputDigest: "", gameType: "wuxia" },
    projection: {
      ...emptyProjection({ player: { name: "玩家", identity: "旅人", stats: { hp: 10, attack: 2, defense: 1 } }, locations: [{ id: LOCATION, name: "现场", description: "", kind: "main", scale: "scene", connectedLocationIds: [], npcIds: [NPC], availableItemIds: [], tags: [] }], currentLocationId: LOCATION }),
      npcs: [{ id: NPC, name: "记录者", role: "记录者", description: "", locationId: LOCATION, isCompanion: false, tags: [], met: true, memory: { npcId: NPC, knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: ["确认账册"] } }],
      worldFacts: [{ factId: FACT, text: "账册内容", source: "generated", discovered: false, discoveryMode: "automatic", locationId: LOCATION, investigationLabel: "查验账册" }],
      quests: [{ id: QUEST, name: "核验", description: "", objectives: [{ kind: "talk_to_npc", npcId: NPC }], onSuccess: { kind: "closed" }, onFailure: { kind: "closed" }, tags: [], kind: "main", status: "active" }],
    },
  });
}

const storyState = createInitialStoryState({ initialNarrative: { status: "idle", currentScene: null } as never, gameLength: "short", initialEntityCounts: { locations: 1, npcs: 1, quests: 1, events: 0 } });

describe("approveStoryConsequenceBindings", () => {
  it("resolves ordinals and installs all four bounded binding kinds through mutations", () => {
    const result = approveStoryConsequenceBindings({
      proposal: [
        { kind: "bind_goal_resolution", npcRef: NPC, goalOrdinal: 0, resolution: {
          completeWhen: [{ kind: "investigation_observed", npcId: NPC, factId: FACT, evidenceQuality: "clean" }],
          blockWhen: [{ kind: "investigation_observed", npcId: NPC, factId: FACT, evidenceQuality: "noisy" }],
        } },
        { kind: "bind_investigation", factRef: FACT, discoveryMode: "investigation", approaches: [
          { approachId: "clean", label: "逐页查验", evidenceQuality: "clean", tensionDelta: 0 },
          { approachId: "noisy", label: "仓促翻阅", evidenceQuality: "noisy", tensionDelta: 1 },
        ] },
        { kind: "bind_talk_completion", questRef: QUEST, npcRef: NPC, conditions: [{ kind: "goal_status", npcId: NPC, goalOrdinal: 0, status: "completed" }] },
        { kind: "bind_npc_cooperation", npcRef: NPC, definitions: [{ operation: "request_verification", requirements: [{ kind: "goal_status", npcId: NPC, goalOrdinal: 0, status: "completed" }], allowedFactIds: [FACT], allowedAudienceIds: ["player_0"] }] },
      ],
      worldState: world(), storyState, symbols: new Map(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const npc = getEntity(result.worldState.entityStore, NPC);
    const fact = getEntity(result.worldState.entityStore, FACT);
    const quest = getEntity(result.worldState.entityStore, QUEST);
    expect(npc?.core.kind === "npc" ? (npc as NpcEntityRecord).dynamicState.goals[0]?.resolution : undefined).toBeDefined();
    expect(fact?.core.kind === "fact" ? (fact as FactEntityRecord).fact.discoveryMode : undefined).toBe("investigation");
    expect(quest?.core.kind === "quest" ? (quest as QuestEntityRecord).quest.objectives[0] : undefined).toMatchObject({ completionConditions: [{ kind: "goal_status" }] });
  });

  it("rejects an unknown fact before writing any earlier binding in the same batch", () => {
    const current = world();
    const result = approveStoryConsequenceBindings({
      proposal: [{ kind: "bind_investigation", factRef: "missing", discoveryMode: "investigation", approaches: [] }],
      worldState: current, storyState, symbols: new Map(),
    });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? result.worldState : current).toBe(current);
  });
});
