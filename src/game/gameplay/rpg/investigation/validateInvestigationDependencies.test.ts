import { describe, expect, it } from "vitest";
import { createWorldStateFixture, emptyProjection } from "@/game/domain/testing/worldStateFixture.testutil";
import { asFactId, asGenerationId, asLocationId, asNpcId, PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import { npcGoalId, type NpcEntityRecord } from "@/game/domain/entity";
import type { NpcGoalResolution } from "@/game/domain/entity/npcComponents";
import type { StoryCondition } from "@/game/domain/storyInteraction";
import { validateInvestigationDependencies } from "./validateInvestigationDependencies";

describe("validateInvestigationDependencies", () => {
  it.each([
    { current: "completed", required: "blocked", bound: true, expected: false },
    { current: "abandoned", required: "completed", bound: true, expected: false },
    { current: "completed", required: "completed", bound: false, expected: true },
    { current: "active", required: "completed", bound: false, expected: false },
    { current: "active", required: "completed", bound: true, expected: false },
    { current: "active", required: "blocked", bound: true, expected: false },
  ] as const)("rejects unreachable goal transitions (%j)", ({ current, required, bound, expected }) => {
    const locationId = asLocationId("loc:goal-dependencies");
    const npcId = asNpcId("npc:goal-dependencies");
    const factId = asFactId("fact:goal-dependencies");
    const requirement: StoryCondition = { kind: "goal_status", npcId, goalId: npcGoalId(npcId, 1), status: required };
    const initial = createWorldStateFixture({
      generation: { generationId: asGenerationId("gen:dependencies"), seed: "dependencies", templateVersion: "test", inputDigest: "", gameType: "wuxia" },
      projection: {
        ...emptyProjection({ player: { name: "玩家", identity: "旅人", stats: { hp: 10, attack: 2, defense: 1 } },
          locations: [{ id: locationId, name: "档案室", description: "", kind: "main", scale: "scene", connectedLocationIds: [], npcIds: [npcId], availableItemIds: [], tags: [] }],
          currentLocationId: locationId }),
        npcs: [{ id: npcId, name: "记录者", role: "记录者", description: "", locationId, isCompanion: false, tags: [], met: true,
          memory: { npcId, knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: ["核验"] } }],
        worldFacts: [{ factId, text: "记录", source: "generated", discovered: false, discoveryMode: "investigation", locationId, investigationLabel: "调查",
          investigationApproaches: ["clean", "noisy"].map((quality) => ({ approachId: quality, label: quality,
            evidenceQuality: quality as "clean" | "noisy", tensionDelta: 0, requirements: [requirement] })) }],
      },
    });
    const world = { ...initial, entityStore: { ...initial.entityStore, records: initial.entityStore.records.map((record) => {
      if (record.core.kind !== "npc") return record;
      const npc = record as NpcEntityRecord;
      return { ...npc, dynamicState: { ...npc.dynamicState, goals: npc.dynamicState.goals.map((goal) => ({
        ...goal, status: current, ...(bound ? { resolution: { completeWhen: [], blockWhen: [] } satisfies NpcGoalResolution } : {}),
      })) } };
    }) } };
    expect(validateInvestigationDependencies(world).ok).toBe(expected);
  });

  it.each([false, true])("rejects two-fact closed cycles but allows a prior independent investigation (entry=%s)", (entry) => {
    const locationId = asLocationId("loc:dependencies");
    const facts = [asFactId("fact:first"), asFactId("fact:second")];
    const world = createWorldStateFixture({
      generation: { generationId: asGenerationId("gen:dependencies"), seed: "dependencies", templateVersion: "test", inputDigest: "", gameType: "wuxia" },
      projection: {
        ...emptyProjection({ player: { name: "玩家", identity: "旅人", stats: { hp: 10, attack: 2, defense: 1 } },
          locations: [{ id: locationId, name: "档案室", description: "", kind: "main", scale: "scene", connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [] }],
          currentLocationId: locationId }),
        worldFacts: facts.map((factId, index) => ({
          factId, text: `记录${index}`, source: "generated", discovered: false, discoveryMode: "investigation",
          locationId, investigationLabel: `查验记录${index}`,
          investigationApproaches: ["clean", "noisy"].map((quality) => ({
            approachId: quality, label: quality, evidenceQuality: quality as "clean" | "noisy", tensionDelta: 0,
            ...(entry && index === 1 ? {} : { requirements: [{ kind: "knows_fact" as const, actorId: PLAYER_ENTITY_ID, factId: facts[1 - index] }] }),
          })),
        })),
      },
    });
    expect(validateInvestigationDependencies(world).ok).toBe(entry);
  });
});
