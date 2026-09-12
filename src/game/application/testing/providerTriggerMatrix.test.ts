/** @vitest-environment jsdom */
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Action } from "@/game/domain/action";
import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { asNarrativeJobId } from "@/game/domain/events";
import { createInitialStoryState, type StoryState } from "@/game/domain/storyState";
import type { PreparedContinuationTrigger } from "@/game/domain/preparedContinuation";
import type { NarrativeBundleTrigger } from "@/game/domain/narrativeBundle";
import { asEnemyId, asFactId, asGenerationId, asLocationId, type GenerationMetadata } from "@/game/domain/worldEntity";
import type { EntityCompatibilityProjection } from "@/game/domain/entity/entityProjection";
import {
  createWorldStateFixtureWith,
  type WorldStateFixtureOverrides,
} from "@/game/domain/testing/worldStateFixture.testutil";
import type { LocationEntry, WorldState } from "@/game/domain/worldState";
import type { GameRecord, ApplyStateInput, GameRepository } from "@/game/application/server/persistence/gameRepository";
import { asGameId } from "@/game/application/server/persistence/gameRepository";
import type { WorldEvolutionSource } from "@/game/application/worldEvolutionSource";
import { performTurn } from "@/game/application/performTurn";
import { buildEncounter } from "@/game/gameplay/rpg/ruleEngine/buildEncounter";
import { createTurnOrder } from "@/game/gameplay/rpg/ruleEngine/combatMath";
import { ENEMY_COMBAT_STATS, PLAYER_COMBAT_STATS, toStatBlock } from "@/game/domain/combat";
import type { GameSessionView } from "@/game/application/gameSessionView";
import { LocationSceneScreen } from "@/components/LocationSceneScreen";

const gameId = asGameId("provider-trigger-matrix");
const origin = asLocationId("loc_origin");
const next = asLocationId("loc_next");
const factId = asFactId("fact_trace");
const enemyId = asEnemyId("enemy_wolf");

const ORIGIN_LOCATION: LocationEntry = {
  id: origin,
  name: "旧道",
  description: "一条潮湿的旧道。",
  kind: "main",
  connectedLocationIds: [next],
  npcIds: [],
  availableItemIds: [],
  tags: [],
};
const NEXT_LOCATION: LocationEntry = {
  id: next,
  name: "破庙",
  description: "断墙后的破庙。",
  kind: "main",
  connectedLocationIds: [origin],
  npcIds: [],
  availableItemIds: [],
  tags: [],
};

const GENERATION: GenerationMetadata = {
  generationId: asGenerationId("generation-provider-trigger-matrix"),
  seed: "provider-trigger-matrix",
  templateVersion: "v1",
  inputDigest: "provider-trigger-matrix",
  gameType: "wuxia",
};

// 兼容投影即完整初始世界：相连地点两条 record 一次声明，不再事后 spread 数组。
const BASE_PROJECTION: EntityCompatibilityProjection = {
  player: { name: "侠客", identity: "旅人", stats: toStatBlock(PLAYER_COMBAT_STATS) },
  locations: [ORIGIN_LOCATION, NEXT_LOCATION],
  currentLocationId: origin,
  unlockedLocationIds: [origin, next],
  visitedLocationIds: [origin],
  npcs: [],
  items: [],
  inventory: [],
  worldFacts: [{
    factId,
    text: "泥地里留着半枚旧令牌。",
    source: "generated",
    discovered: false,
    locationId: origin,
    investigationLabel: "泥地上的痕迹",
    investigationApproaches: [{
      approachId: "follow",
      label: "沿痕迹追查",
      evidenceQuality: "clean",
      tensionDelta: 4,
    }, {
      approachId: "search",
      label: "翻查附近杂物",
      evidenceQuality: "noisy",
      tensionDelta: 12,
    }],
  }],
  quests: [],
  enemies: [],
  defeatedEnemyIds: [],
  factions: [],
};

function buildWorld(overrides: WorldStateFixtureOverrides = {}): WorldState {
  return createWorldStateFixtureWith({ generation: GENERATION, base: BASE_PROJECTION }, overrides);
}

function makeWorld(): WorldState {
  return buildWorld();
}

function makeStory(trigger?: PreparedContinuationTrigger): StoryState {
  const base = createInitialStoryState({
    initialNarrative: createFixtureNarrativeRuntimeState(),
    gameLength: "short",
    initialEntityCounts: { locations: 2, npcs: 0, quests: 0, events: 0 },
  });
  if (trigger === undefined) return base;
  if (base.narrative.status !== "ready") throw new Error("matrix story fixture must start ready");
  return {
    ...base,
    narrative: {
      ...base.narrative,
      narrativeBundle: {
        contractVersion: 2,
        originJobId: asNarrativeJobId("job-provider-trigger-matrix"),
        activeStepIds: ["step-trigger"],
        steps: [{
      stepId: "step-trigger",
      objectiveKey: "matrix:0",
      consumptionGroupKey: `matrix:0:${trigger.kind}`,
      trigger: trigger as NarrativeBundleTrigger,
      scene: {
        segments: [{ beatId: "matrix-result", text: `规则结果：${trigger.kind}` }],
        event: trigger.kind === "move"
          ? { kind: "travel", locationId: trigger.locationId }
          : trigger.kind === "investigate"
            ? { kind: "investigate", factId: trigger.factId }
            : { kind: "battle", enemyId: trigger.enemyId },
        npcLine: null,
        objectiveLink: null,
        choiceSeeds: [],
        source: "fixture",
      },
      nextStepIds: [],
        }],
        terminal: { kind: "next_decision", target: { kind: "current_scene" } },
      },
    },
  };
}

function makeBattleWorld(): WorldState {
  const enemy = {
    id: enemyId,
    name: "灰狼",
    tier: "normal" as const,
    stats: toStatBlock(ENEMY_COMBAT_STATS.normal),
    locationId: origin,
    tags: [],
  };
  const world = buildWorld({ enemies: [enemy] });
  const encounter = buildEncounter(world, enemyId).map((combatant) => (
    combatant.side === "enemies" ? { ...combatant, hp: 1 } : combatant
  ));
  return {
    ...world,
    battle: {
      status: "active",
      enemyId,
      enemyIds: [enemyId],
      playerHp: 100,
      enemyHp: 1,
      round: 1,
      combatants: encounter,
      turnOrder: createTurnOrder(encounter),
      turnIndex: 0,
      enemyIntents: [],
      downedEnemyIds: [],
      lastAdvance: [],
    },
  };
}

function makeRepository(worldState: WorldState, storyState: StoryState) {
  let record: GameRecord = {
    gameId,
    worldState,
    storyState,
    revision: 0,
    createdAt: "2026-08-24T00:00:00.000Z",
  };
  const applyState = vi.fn(async (input: ApplyStateInput) => {
    if (input.expectedRevision !== record.revision) return { ok: false as const, code: "STALE_GAME_REVISION" as const };
    record = {
      ...record,
      worldState: input.nextWorldState,
      storyState: input.nextStoryState,
      revision: input.incrementRevision === false ? record.revision : record.revision + 1,
    };
    return { ok: true as const, record };
  });
  const applySceneWriteBack = vi.fn(async () => ({ ok: false as const, code: "INFRASTRUCTURE_FAILURE" as const }));
  const repository: GameRepository = {
    async createInitialGame() { return { ok: false as const, code: "ACTIVE_GAME_EXISTS" as const }; },
    async replaceCurrentGame() { return { ok: false as const, code: "NO_ACTIVE_GAME" as const }; },
    async getCurrentGame() { return { ok: true as const, status: "active" as const, record }; },
    applyState,
    applySceneWriteBack,
    async clearCurrentGame() { return { ok: true as const }; },
  };
  return { repository, applyState, applySceneWriteBack, record: () => record };
}

function worldProposalSpy(): { source: WorldEvolutionSource; propose: ReturnType<typeof vi.fn> } {
  const propose = vi.fn(async () => ({ ok: true as const, proposal: null }));
  return { source: { propose }, propose };
}

type TriggerCase = {
  readonly name: string;
  readonly worldState: WorldState;
  readonly trigger: PreparedContinuationTrigger;
  readonly action: Action;
  readonly token: string;
};

const preparedTriggerCases: readonly TriggerCase[] = [
  {
    name: "move",
    worldState: makeWorld(),
    trigger: { kind: "move", locationId: next },
    action: { type: "move", locationId: next },
    token: "move",
  },
  {
    name: "investigate",
    worldState: makeWorld(),
    trigger: { kind: "investigate", factId, approachId: "follow" },
    action: { type: "investigate", factId, approachId: "follow" },
    token: "investigate",
  },
  {
    name: "battle",
    worldState: makeBattleWorld(),
    trigger: { kind: "battle_resolved", enemyId, outcome: "victory" },
    action: {
      type: "battle_action",
      action: "attack",
      command: { actorId: "ally:protagonist" as never, targetId: "enemy:enemy_wolf" as never },
    },
    token: "battle",
  },
];

describe("provider trigger matrix", () => {
  afterEach(() => cleanup());

  it.each(preparedTriggerCases)(
    "$name narrative bundle step consumes without provider/world proposal and commits once",
    async ({ worldState, trigger, action, token }) => {
      const fixture = makeRepository(worldState, makeStory(trigger));
      const proposal = worldProposalSpy();

      const result = await performTurn(
        {
          gameId,
          actionId: `matrix-${trigger.kind}`,
          interaction: { kind: "fixed_choice", choiceToken: token },
          expectedRevision: 0,
          choiceMap: new Map([[token, action]]),
        },
        { repository: fixture.repository, now: () => "2026-08-24T00:00:00.000Z", worldEvolutionSource: proposal.source },
      );

      expect(result.ok).toBe(true);
      expect(fixture.applyState).toHaveBeenCalledOnce();
      expect(fixture.applySceneWriteBack).not.toHaveBeenCalled();
      expect(proposal.propose).not.toHaveBeenCalled();
      expect(fixture.record().revision).toBe(1);
      const savedNarrative = fixture.record().storyState.narrative;
      expect(savedNarrative.status).toBe("ready");
      if (savedNarrative.status !== "ready") return;
      expect(savedNarrative.currentScene.source).toBe("fixture");
      expect(savedNarrative.narrativeBundle).toBeUndefined();
    },
  );

  it("missing bundle step rejects explore with zero writes and no provider", async () => {
    const fixture = makeRepository(makeWorld(), makeStory());
    const proposal = worldProposalSpy();

    const result = await performTurn(
      {
        gameId,
        actionId: "matrix-rule-explore",
        interaction: { kind: "fixed_choice", choiceToken: "explore" },
        expectedRevision: 0,
        choiceMap: new Map([["explore", { type: "explore" }]]),
      },
      { repository: fixture.repository, now: () => "2026-08-24T00:00:00.000Z", worldEvolutionSource: proposal.source },
    );

    expect(result).toMatchObject({ ok: false, code: "NARRATIVE_CONTINUATION_MISSING" });
    expect(fixture.applyState).not.toHaveBeenCalled();
    expect(fixture.applySceneWriteBack).not.toHaveBeenCalled();
    expect(proposal.propose).not.toHaveBeenCalled();
  });

  it("NPC handoff acknowledgement is a local close and never submits a persistence action", async () => {
    const onSubmit = vi.fn();
    const onReturnMap = vi.fn();
    const view = {
      revision: 4,
      turnNumber: 3,
      gameType: "wuxia",
      setup: { storyOpening: null, worldPremise: null, characterProfile: null, narrativeStyle: null },
      player: { name: "侠客", identity: "旅人", hp: 100, attack: 10, defense: 5 },
      worldMap: { locations: [{ name: "旧道", current: true, visited: true, scale: "scene", travelChoice: null }] },
      currentLocation: { name: "旧道", description: "旧道", scale: "scene", actions: [], npcs: [{ npcId: "npc_guide", name: "引路人", role: "信使", talkChoice: null, relationshipTier: "neutral" }], town: null },
      obtainableItems: [],
      inventory: [],
      story: { currentAct: 1, targetActs: 3, tension: 20, pacingNeed: "reveal", storyProgress: 1, currentObjectiveLabel: "前往破庙", currentObjectiveChoiceToken: "move", currentObjectiveChoiceTokens: ["move"] },
      narrative: {
        mode: "offline", hasScene: true, eventKind: "dialogue", narration: "破庙在旧道尽头。", choices: [{ choiceToken: "move", label: "（动身前往破庙）", presentation: "travel" }], npcLine: null,
        npcDialogues: [{ npcId: "npc_guide", name: "引路人", role: "信使", speechPages: ["破庙在旧道尽头。"], choices: [], freeInputEnabled: false, giveChoices: [], handoffAcknowledgement: { label: "（点头记下方向）" } }],
      },
      narrativeGeneration: { status: "idle" },
      battle: null,
      quests: [],
      prologueShown: true,
      prologueText: "",
      ending: null,
    } as GameSessionView;

    render(createElement(LocationSceneScreen, { view, busy: false, onSubmit, onReturnMap }));
    await userEvent.click(screen.getByRole("button", { name: "（点头记下方向）" }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(onReturnMap).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "与引路人对话" })).not.toBeInTheDocument();
  });
});
