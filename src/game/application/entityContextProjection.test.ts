import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { createInitialStoryState } from "@/game/domain/storyState";
import { createWorldStateFixture } from "@/game/domain/testing/worldStateFixture.testutil";
import {
  asEnemyId, asFactId, asGenerationId, asItemId, asLocationId, asNpcId, asQuestId,
} from "@/game/domain/worldEntity";
import { asNarrativeJobId, asTurnId, asEventId } from "@/game/domain/events";
import type { PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import type { EntityCompatibilityProjection } from "@/game/domain/entity";
import type { NpcEntry } from "@/game/domain/worldEntries";
import { createNarrativeGenerationAttempt } from "@/game/domain/narrativeGenerationAttempt";
import { describe, expect, it } from "vitest";
import { buildEntityContextProjection, buildWorldDeltaEntityContextClosure } from "./entityContextProjection";

const loc0 = asLocationId("loc_0");
const loc1 = asLocationId("loc_1");
const loc2 = asLocationId("loc_2");
const focusNpc = asNpcId("npc_focus");
const nearbyNpc = asNpcId("npc_nearby");
const remoteNpc = asNpcId("npc_remote");
const publicFact = asFactId("fact_public");
const privateFact = asFactId("fact_private");
const questId = asQuestId("quest_main");

function npc(id: typeof focusNpc, locationId: typeof loc0, overrides: Partial<NpcEntry> = {}): NpcEntry {
  return {
    id, name: String(id), role: "线人", description: "谨慎的江湖人", locationId,
    isCompanion: false, tags: [], met: true,
    memory: {
      npcId: id, knownFactIds: [], hiddenFactIds: [], interactionHistory: [],
      relationship: { affinity: 0 }, emotion: "neutral", goals: ["查明真相"],
    },
    ...overrides,
  };
}

function projection(): EntityCompatibilityProjection {
  const interactions = Array.from({ length: 6 }, (_, index) => ({
    eventId: asEventId(`evt:interact:${index + 1}`),
    turnNumber: index + 1,
    actionId: `action_${index + 1}`,
    locationId: loc0,
    dialogueAct: "ask" as const,
    topicSummary: `话题${index + 1}`,
    outcome: "neutral" as const,
    relationshipDelta: 0,
    learnedFactIds: [],
    summary: `交互${index + 1}`,
  }));
  return {
    player: { name: "沈希", identity: "走镖人", stats: { hp: 20, attack: 5, defense: 3 } },
    locations: [
      { id: loc0, name: "青石镇", description: "山镇", kind: "main", connectedLocationIds: [loc1], npcIds: [focusNpc, nearbyNpc], availableItemIds: [asItemId("item_nearby"), asItemId("item_optional")], tags: [] },
      { id: loc1, name: "古道", description: "旧路", kind: "main", connectedLocationIds: [loc0], npcIds: [], availableItemIds: [], tags: [] },
      { id: loc2, name: "远山", description: "无关地点", kind: "main", connectedLocationIds: [], npcIds: [remoteNpc], availableItemIds: [asItemId("item_remote")], tags: [] },
    ],
    currentLocationId: loc0,
    unlockedLocationIds: [loc0, loc1],
    visitedLocationIds: [loc0],
    npcs: [
      npc(focusNpc, loc0, { memory: {
        npcId: focusNpc, knownFactIds: [publicFact], hiddenFactIds: [privateFact],
        interactionHistory: interactions, relationship: { affinity: 30 }, emotion: "warm", goals: ["守住证人"],
      } }),
      npc(nearbyNpc, loc0),
      npc(remoteNpc, loc2, { description: "不应进入当前闭包", memory: {
        npcId: remoteNpc, knownFactIds: [], hiddenFactIds: [], interactionHistory: [{ ...interactions[0]!, summary: "远方秘密交互" }],
        relationship: { affinity: 0 }, emotion: "neutral", goals: ["远行"],
      } }),
    ],
    items: [
      { id: asItemId("item_nearby"), name: "铜钥", description: "节拍物品", kind: "key", tags: [] },
      { id: asItemId("item_optional"), name: "药囊", description: "附近物品", kind: "medicine", tags: [] },
      { id: asItemId("item_remote"), name: "远方信物", description: "无关物品", kind: "token", tags: [] },
    ],
    inventory: [],
    worldFacts: [
      { factId: publicFact, text: "古道留有车辙", source: "generated", discovered: true, locationId: loc1 },
      { factId: privateFact, text: "密使真实身份", source: "generated", discovered: true, locationId: loc2 },
    ],
    quests: [{
      id: questId, name: "追查车辙", description: "询问线人后前往古道",
      objectives: [{ kind: "talk_to_npc", npcId: focusNpc }, { kind: "visit_location", locationId: loc1 }],
      onSuccess: { kind: "advance_story" }, onFailure: { kind: "closed" }, tags: [], kind: "main", status: "active",
    }],
    enemies: [{ id: asEnemyId("enemy_nearby"), name: "伏兵", tier: "normal", stats: { hp: 10, attack: 3, defense: 1 }, locationId: loc0, tags: [] }],
    defeatedEnemyIds: [],
    factions: [],
  };
}

function job(overrides: Partial<PendingNarrativeJob> = {}): PendingNarrativeJob {
  return {
    jobId: asNarrativeJobId("job_1"), turnId: asTurnId("turn_1"), actionId: "action_7",
    basedOnRevision: 2, turnNumber: 7, actionSummary: { kind: "talk", npcId: focusNpc },
    resolvedEvent: { actionId: "action_7", status: "success", eventKind: "dialogue", facts: [], stateChanges: [], costs: [], rewards: [], triggeredEvents: [], rejectedEffects: [] },
    domainEventIds: [asEventId("turn_1:event_1")], focusNpcId: focusNpc,
    requestedAt: "2026-08-31T00:00:00.000Z",
    objectiveTransition: { before: null, completed: [], after: { questId, objectiveIndex: 0, label: "询问线人" }, mode: "unchanged" },
    mandatoryBeats: [{ beatId: "item", kind: "item_obtained", subjectIds: ["item_nearby"], instruction: "获得铜钥" }],
    generationKind: "npc_fixed_choice", sceneRequestKind: "npc_response",
    attempt: createNarrativeGenerationAttempt(),
    ...overrides,
  };
}

describe("buildEntityContextProjection", () => {
  const worldState = createWorldStateFixture({
    generation: { generationId: asGenerationId("g"), seed: "s", templateVersion: "v", inputDigest: "", gameType: "wuxia" },
    projection: projection(),
  });
  const baseStory = createInitialStoryState({
    initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short",
    initialEntityCounts: { locations: 3, npcs: 3, quests: 1, events: 0 },
  });

  it("builds the mandatory closure from typed action, objective and beat references", () => {
    const result = buildEntityContextProjection({ worldState, storyState: baseStory, job: job() });
    expect(result.mandatory.map((entry) => entry.id)).toEqual([
      "fact_public", "item_nearby", "loc_0", "loc_1", "npc_focus", "player_0", "quest_main",
    ]);
    expect(result.mandatory.find((entry) => entry.id === "npc_focus")?.summary).toContain("交互2｜交互3｜交互4｜交互5｜交互6");
    expect(JSON.stringify(result.mandatory.find((entry) => entry.id === "npc_focus"))).not.toContain("守住证人");
    expect(result.mandatory.some((entry) => entry.id === "talk_to_npc")).toBe(false);
  });

  it("caps a stable one-hop optional set and excludes remote/private or inactive details", () => {
    const limited = buildEntityContextProjection({ worldState, storyState: baseStory, job: job(), optionalLimit: 2 });
    expect(limited.optional.map((entry) => entry.id)).toEqual(["enemy_nearby", "item_optional"]);
    const full = buildEntityContextProjection({ worldState, storyState: baseStory, job: job(), optionalLimit: 20 });
    expect(full.optional.map((entry) => entry.id)).toEqual(["enemy_nearby", "item_optional", "npc_nearby"]);
    expect(JSON.stringify(full)).not.toContain("密使真实身份");
    expect(JSON.stringify(full)).not.toContain("远方秘密交互");
    expect(JSON.stringify(full)).not.toContain("不应进入当前闭包");
  });

  it("uses the reveal cursor when expanding optional quest objective targets", () => {
    const storyState = { ...baseStory, reveal: { questId, visibleObjectiveIndex: 1 } };
    const result = buildEntityContextProjection({
      worldState, storyState,
      job: job({
        actionSummary: { kind: "explore" }, focusNpcId: undefined, mandatoryBeats: [],
        objectiveTransition: { before: null, completed: [], after: null, mode: "unchanged" },
      }),
    });
    expect(result.optional.map((entry) => entry.id)).toContain("loc_1");
  });

  it("keeps global collision names compact without exposing fact names or prose", () => {
    const result = buildEntityContextProjection({ worldState, storyState: baseStory, job: job() });
    expect(result.occupiedNames.location).toEqual(["古道", "青石镇", "远山"]);
    expect(Object.keys(result.occupiedNames)).toEqual(["location", "npc", "item", "enemy", "quest"]);
    expect(JSON.stringify(result.occupiedNames)).not.toContain("古道留有车辙");
  });

  it("declares only public initial-world facts inside the exact entity closure", () => {
    const result = buildWorldDeltaEntityContextClosure({ worldState, storyState: baseStory, job: job() });
    expect(result.declarableExistingFactIds).toEqual(["fact_public"]);
    expect(result.declarableExistingFactIds).not.toContain("fact_private");
  });

  it("adds only the already-authorized memory entity references to the current cards", () => {
    const result = buildEntityContextProjection({
      worldState,
      storyState: baseStory,
      job: job(),
      memoryEntityIds: [remoteNpc],
    });

    expect(result.mandatory.map((entry) => entry.id)).toContain(String(remoteNpc));
    expect(result.mandatory.map((entry) => entry.id)).not.toContain("npc_remote_unknown");
  });
});
