import { describe, expect, it } from "vitest";
import { asFactId, asGenerationId, asLocationId, asQuestId, asNpcId, type GenerationMetadata } from "@/game/domain/worldEntity";
import { createInitialStoryState } from "@/game/domain/storyState";
import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { emptyProjection, createWorldStateFixtureWith } from "@/game/domain/testing/worldStateFixture.testutil";
import type { LocationEntry, PlayerState } from "@/game/domain/worldEntries";
import { availableInvestigations } from "./index";

const generation: GenerationMetadata = {
  generationId: asGenerationId("generation:investigation-test"), seed: "seed", templateVersion: "v1", inputDigest: "", gameType: "wuxia",
};
const player: PlayerState = { name: "玩家", identity: "调查者", stats: { hp: 10, attack: 1, defense: 1 } };
const scene: LocationEntry = {
  id: asLocationId("scene_archive"), name: "档案室", description: "", kind: "main",
  scale: "scene", connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
};
const town: LocationEntry = { ...scene, id: asLocationId("town"), scale: "town" };

function story() {
  return createInitialStoryState({
    initialNarrative: createFixtureNarrativeRuntimeState(),
    gameLength: "short",
    initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 },
  });
}

function worldAt(location: LocationEntry, discoveryMode: "automatic" | "investigation" = "investigation") {
  return createWorldStateFixtureWith(
    { generation, base: emptyProjection({ player, locations: [location], currentLocationId: location.id }) },
    {
      worldFacts: [{
        factId: asFactId("fact_sealed_record"),
        text: "密封记录写着不应提前公开的事实",
        source: "generated",
        discovered: false,
        discoveryMode,
        locationId: location.id,
        investigationLabel: "查看密封记录的保存痕迹",
        investigationApproaches: [
          { approachId: "quiet", label: "保持原样查验", evidenceQuality: "clean", tensionDelta: 1 },
          { approachId: "open", label: "公开拆封查验", evidenceQuality: "noisy", tensionDelta: 5 },
        ],
      }],
    },
  );
}

describe("availableInvestigations", () => {
  it("returns safe method projections without the hidden fact text", () => {
    const opportunities = availableInvestigations({ worldState: worldAt(scene), storyState: story() });
    expect(opportunities).toHaveLength(2);
    expect(opportunities[0]).toMatchObject({ factId: asFactId("fact_sealed_record"), approachId: "quiet" });
    expect(opportunities[0]).not.toHaveProperty("text");
    expect(opportunities[0]?.action).toEqual({ type: "investigate", factId: asFactId("fact_sealed_record"), approachId: "quiet" });
  });

  it("does not expose investigation methods in a town or from another location", () => {
    expect(availableInvestigations({ worldState: worldAt(town, "automatic"), storyState: story() })).toEqual([]);
    const other = { ...scene, id: asLocationId("other_scene") };
    const ws = createWorldStateFixtureWith(
      { generation, base: emptyProjection({ player, locations: [scene, other], currentLocationId: scene.id }) },
      { worldFacts: [{ ...worldAt(other).worldFacts[0]!, locationId: other.id }] },
    );
    expect(availableInvestigations({ worldState: ws, storyState: story() })).toEqual([]);
  });

  it("does not expose a method before its discover_fact objective is released", () => {
    const ws = createWorldStateFixtureWith(
      { generation, base: emptyProjection({ player, locations: [scene], currentLocationId: scene.id }) },
      {
        worldFacts: [
          ...worldAt(scene).worldFacts,
          { factId: asFactId("fact_other"), text: "other", source: "generated", discovered: false, locationId: scene.id },
        ],
        quests: [{
          id: asQuestId("quest_gate"), name: "gate", description: "", objectives: [
            { kind: "discover_fact", factId: asFactId("fact_other") },
            { kind: "discover_fact", factId: asFactId("fact_sealed_record") },
          ],
          onSuccess: { kind: "closed" }, onFailure: { kind: "closed" }, tags: [], kind: "main", status: "active",
        }],
      },
    );
    expect(availableInvestigations({
      worldState: ws,
      storyState: { ...story(), reveal: { questId: asQuestId("quest_gate"), visibleObjectiveIndex: 0 } },
    })).toEqual([]);
  });
});
