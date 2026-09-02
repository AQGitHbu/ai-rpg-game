import { describe, expect, it } from "vitest";
import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { asNarrativeJobId, type CommittedNarrativeEvent } from "@/game/domain/events";
import { createInitialStoryState, type StoryState } from "@/game/domain/storyState";
import {
  asGenerationId,
  asLocationId,
  asNpcId,
  asQuestId,
  type GenerationMetadata,
} from "@/game/domain/worldEntity";
import type { EntityCompatibilityProjection } from "@/game/domain/entity/entityProjection";
import { createWorldStateFixtureWith } from "@/game/domain/testing/worldStateFixture.testutil";
import type { WorldState } from "@/game/domain/worldState";
import type { ResolvedEvent } from "@/game/domain/resolvedEvent";
import type {
  PreparedContinuationState,
  PreparedContinuationStepState,
} from "@/game/domain/preparedContinuation";
import {
  consumePreparedContinuation,
  type ConsumePreparedContinuationResult,
} from "./consumePreparedContinuation";

const locTown = asLocationId("loc_town");
const locTemple = asLocationId("loc_temple");
const npcBeggar = asNpcId("npc_beggar");
const questId = asQuestId("quest_prepared");

const GENERATION: GenerationMetadata = {
  generationId: asGenerationId("generation_prepared"),
  seed: "prepared-seed",
  templateVersion: "v1",
  inputDigest: "prepared-digest",
  gameType: "wuxia",
};

/** 与 createInitialWorldState 一致：开局事件仍在账本里。 */
const INITIALIZED_LEDGER: readonly CommittedNarrativeEvent[] = [{ type: "game_initialized", generation: GENERATION }];

// 起始投影一次给全：小镇的连接边指向镇外破庙，因此破庙同批具象化。
// 名册留空——本夹具不具象化任何 NPC；说台词的老乞丐只存在于 prepared step 的 scene 里。
const BASE_PROJECTION: EntityCompatibilityProjection = {
  player: { name: "侠客", identity: "旅人", stats: { hp: 100, attack: 10, defense: 5 } },
  locations: [
    {
      id: locTown,
      name: "小镇",
      description: "山脚下的小镇。",
      kind: "main",
      connectedLocationIds: [locTemple],
      npcIds: [],
      availableItemIds: [],
      tags: [],
    },
    {
      id: locTemple,
      name: "镇外破庙",
      description: "断墙后的破庙。",
      kind: "main",
      connectedLocationIds: [locTown],
      npcIds: [],
      availableItemIds: [],
      tags: [],
    },
  ],
  currentLocationId: locTown,
  unlockedLocationIds: [locTown, locTemple],
  visitedLocationIds: [locTown],
  npcs: [],
  items: [],
  inventory: [],
  worldFacts: [],
  quests: [],
  enemies: [],
  defeatedEnemyIds: [],
  factions: [],
};

function worldState(): WorldState {
  return createWorldStateFixtureWith(
    { generation: GENERATION, base: BASE_PROJECTION },
    { eventLedger: INITIALIZED_LEDGER },
  );
}

function preparedStep(
  overrides: Partial<PreparedContinuationStepState> = {},
): PreparedContinuationStepState {
  return {
    stepId: "step_arrive_temple",
    objectiveKey: `${questId}:0`,
    consumptionGroupKey: `${questId}:0:move`,
    trigger: { kind: "move", locationId: locTemple },
    scene: {
      segments: [{ beatId: "arrival", text: "你沿山路抵达破庙。" }],
      event: { kind: "travel", locationId: locTemple },
      npcLine: {
        npcId: npcBeggar,
        text: "后生，脚步放轻些。",
        emotion: "guarded",
        usedFactIds: [],
        usedInteractionActionIds: [],
      },
      objectiveLink: { questId, objectiveIndex: 0, mode: "hint" },
      choiceSeeds: [
        {
          label: "请问昨夜来的是谁？",
          action: { type: "talk", npcId: npcBeggar, dialogueAct: "support" },
        },
        {
          label: "你若隐瞒，我只能自己搜。",
          action: { type: "talk", npcId: npcBeggar, dialogueAct: "challenge" },
        },
      ],
      source: "generated",
    },
    nextStepIds: [],
    ...overrides,
  };
}

function preparedContinuation(
  activeStepIds: readonly string[] = ["step_arrive_temple"],
): PreparedContinuationState {
  return {
    originJobId: asNarrativeJobId("job_prepared_continuation"),
    steps: [preparedStep()],
    activeStepIds,
  };
}

function storyState(prepared?: PreparedContinuationState): StoryState {
  const base = createInitialStoryState({
    initialNarrative: createFixtureNarrativeRuntimeState(),
    gameLength: "short",
    initialEntityCounts: { locations: 2, npcs: 1, quests: 1, events: 0 },
  });
  if (prepared === undefined) return base;
  if (base.narrative.status !== "ready") throw new Error("fixture narrative must be ready");
  return {
    ...base,
    narrative: { ...base.narrative, preparedContinuation: prepared },
  };
}

function resolvedEvent(): ResolvedEvent {
  return {
    actionId: "action_move_to_temple",
    status: "success",
    eventKind: "travel",
    facts: [],
    stateChanges: [],
    costs: [],
    rewards: [],
    triggeredEvents: [],
    rejectedEffects: [],
  };
}

function moveEvent(): CommittedNarrativeEvent {
  return {
    type: "location_visited",
    locationId: locTemple,
    occurredAt: "2026-08-24T00:00:00.000Z",
  };
}

function consume(
  overrides: Partial<Parameters<typeof consumePreparedContinuation>[0]> = {},
): ConsumePreparedContinuationResult {
  const beforeWorldState = worldState();
  const resolvedWorldState = createWorldStateFixtureWith(
    { generation: GENERATION, base: BASE_PROJECTION },
    {
      eventLedger: INITIALIZED_LEDGER,
      currentLocationId: locTemple,
      visitedLocationIds: [locTown, locTemple],
    },
  );
  const beforeStoryState = storyState(preparedContinuation());
  return consumePreparedContinuation({
    beforeWorldState,
    beforeStoryState,
    resolvedWorldState,
    resolvedStoryState: beforeStoryState,
    action: { type: "move", locationId: locTemple },
    postCommitRevision: 42,
    resolvedEvent: resolvedEvent(),
    domainEvents: [moveEvent()],
    now: () => "2026-08-24T00:00:00.000Z",
    ...overrides,
  });
}

describe("consumePreparedContinuation", () => {
  it("consumes a matching move step and mints choices against postCommitRevision", () => {
    const result = consume();

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const narrative = result.nextStoryState.narrative;
    expect(narrative.status).toBe("ready");
    if (narrative.status !== "ready") return;

    expect(narrative.currentScene).toMatchObject({
      sceneId: "scene-prepared-action_move_to_temple-step_arrive_temple",
      turn: 42,
      source: "generated",
      npcLine: { npcId: npcBeggar },
    });
    expect(narrative.currentScene.choices).toHaveLength(2);
    expect(narrative.choiceRegistry).toHaveLength(2);
    expect(narrative.choiceRegistry.every((choice) => (
      choice.basedOnRevision === 42
        && choice.sceneId === "scene-prepared-action_move_to_temple-step_arrive_temple"
    ))).toBe(true);
    expect(narrative.currentScene.choices).toEqual(
      narrative.choiceRegistry.map(({ choiceToken, label }) => ({ choiceToken, label })),
    );
    expect(narrative.preparedContinuation).toBeUndefined();
  });

  it("returns NARRATIVE_CONTINUATION_MISSING when no continuation is available", () => {
    const result = consume({
      beforeStoryState: storyState(),
      resolvedStoryState: storyState(),
    });

    expect(result).toEqual({ ok: false, code: "NARRATIVE_CONTINUATION_MISSING" });
  });

  it.each([
    ["duplicate active step IDs", ["step_arrive_temple", "step_arrive_temple"]],
    ["an illegal active step ID", ["step_not_in_graph"]],
  ])("returns NARRATIVE_CONTINUATION_INVALID for %s", (_label, activeStepIds) => {
    const result = consume({
      beforeStoryState: storyState(preparedContinuation(activeStepIds)),
      resolvedStoryState: storyState(preparedContinuation(activeStepIds)),
    });

    expect(result).toEqual({ ok: false, code: "NARRATIVE_CONTINUATION_INVALID" });
  });
});
