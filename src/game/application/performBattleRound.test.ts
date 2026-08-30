import { describe, it, expect } from "vitest";
import { performBattleRound } from "./performBattleRound";
import type { GameRepository, GameRecord } from "./server/persistence/gameRepository";
import type { WorldState, BattleStartSnapshot } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { Action } from "@/game/domain/action";
import { asEnemyId, asLocationId } from "@/game/domain/worldEntity";
import { asCombatantId } from "@/game/domain/combat";
import { createInitialWorldState } from "@/game/domain/worldState";
import { createInitialStoryState } from "@/game/domain/storyState";
import type { GameEvent } from "@/game/domain/events";

function createInMemoryRepo(record: GameRecord | null): { repo: GameRepository; getRecord: () => GameRecord | null; getApplyCount: () => number } {
  let current: GameRecord | null = record;
  let applyCount = 0;
  return {
    repo: {
      async createInitialGame() { return { ok: true as const }; },
      async getCurrentGame() {
        if (current === null) return { ok: true as const, status: "none" as const };
        return { ok: true as const, status: "active" as const, record: current };
      },
      async applyState(input) {
        applyCount++;
        if (current === null) return { ok: false, code: "NO_ACTIVE_GAME" as const };
        if (input.expectedRevision !== current.revision) return { ok: false, code: "STALE_GAME_REVISION" as const };
        current = { ...current, worldState: input.nextWorldState, storyState: input.nextStoryState, revision: current.revision + 1 };
        return { ok: true as const, record: current };
      },
      async applySceneWriteBack(input) {
        if (current === null) return { ok: false, code: "NO_ACTIVE_GAME" as const };
        if (input.expectedRevision !== current.revision) return { ok: false, code: "STALE_GAME_REVISION" as const };
        current = { ...current, worldState: input.nextWorldState, storyState: input.nextStoryState, revision: current.revision + 1 };
        return { ok: true as const, record: current };
      },
      async clearCurrentGame() { return { ok: true as const }; },
      async replaceCurrentGame() { return { ok: true as const }; },
    } as GameRepository,
    getRecord: () => current,
    getApplyCount: () => applyCount,
  };
}

function createBattleWorldState(overrides?: Partial<WorldState>): WorldState {
  const base = createInitialWorldState({
    generation: { generationId: "gen_test" as never, seed: "test", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "测试", identity: "测试身份", stats: { hp: 100, attack: 20, defense: 10 } },
    startingLocation: {
      id: asLocationId("loc_0"), name: "测试", description: "测试", kind: "main",
      connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
    },
    startingItemIds: [],
  });
  const preBattleSnapshot: BattleStartSnapshot = {
    entityStore: base.entityStore,
    eventLedger: [] as readonly GameEvent[],
  };
  return {
    ...base,
    enemies: [{ id: asEnemyId("enemy_0"), name: "测试敌人", tier: "normal" as never, stats: { maxHp: 50, attack: 10, defense: 5, speed: 10 } as never, locationId: asLocationId("loc_0"), tags: [] }],
    defeatedEnemyIds: [],
    battle: {
      status: "active" as const,
      enemyId: asEnemyId("enemy_0"),
      playerHp: 80,
      enemyHp: 30,
      round: 1,
      preBattleSnapshot,
    },
    ...overrides,
  };
}

function createBattleStoryState(narrative?: StoryState["narrative"]): StoryState {
  const readyNarrative: StoryState["narrative"] = narrative ?? {
    status: "ready" as const,
    mode: "ai" as const,
    currentScene: {
      sceneId: "scene-battle-1",
      turn: 1,
      narration: "战斗即将开始",
      usedFactIds: [],
      npcLine: null,
      choices: [],
      source: "generated" as const,
    },
    choiceRegistry: [],
  };
  return {
    ...createInitialStoryState({
      gameLength: "short" as const,
      initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 },
      initialNarrative: readyNarrative,
    }),
  };
}

describe("performBattleRound", () => {
  it("restores the complete pre-battle entity store after defeat", async () => {
    const worldState = createBattleWorldState({
      battle: {
        status: "active",
        enemyId: asEnemyId("enemy_0"),
        playerHp: 1,
        enemyHp: 30,
        round: 1,
        preBattleSnapshot: { entityStore: createBattleWorldState().entityStore, eventLedger: [] },
      },
    });
    if (worldState.battle.status !== "active" || worldState.battle.preBattleSnapshot === undefined) throw new Error("fixture must have snapshot");
    const snapshot = worldState.battle.preBattleSnapshot;
    const { repo, getRecord } = createInMemoryRepo({ gameId: "g1" as never, worldState, storyState: createBattleStoryState(), revision: 0, createdAt: "2026-01-01" });
    const result = await performBattleRound(
      { gameId: "g1" as never, actionId: "defeat", interactionKind: "fixed_choice", action: { type: "battle_action", action: "guard" }, expectedRevision: 0 },
      { repository: repo, now: () => "2026-01-01" },
    );
    expect(result).toMatchObject({ ok: true, outcome: "defeat" });
    expect(getRecord()?.worldState.entityStore).toEqual(snapshot.entityStore);
    expect(getRecord()?.worldState.eventLedger).toEqual([]);
    expect(getRecord()?.worldState.battle).toEqual({ status: "idle" });
  });

  it("restores the complete pre-battle entity store after withdraw", async () => {
    const worldState = createBattleWorldState();
    if (worldState.battle.status !== "active" || worldState.battle.preBattleSnapshot === undefined) throw new Error("fixture must have snapshot");
    const snapshot = worldState.battle.preBattleSnapshot;
    const { repo, getRecord } = createInMemoryRepo({ gameId: "g1" as never, worldState, storyState: createBattleStoryState(), revision: 0, createdAt: "2026-01-01" });
    const result = await performBattleRound(
      { gameId: "g1" as never, actionId: "withdraw", interactionKind: "fixed_choice", action: { type: "battle_action", action: "flee" }, expectedRevision: 0 },
      { repository: repo, now: () => "2026-01-01" },
    );
    expect(result).toMatchObject({ ok: true, outcome: "withdraw" });
    expect(getRecord()?.worldState.entityStore).toEqual(snapshot.entityStore);
    expect(getRecord()?.worldState.eventLedger).toEqual([]);
    expect(getRecord()?.worldState.battle).toEqual({ status: "idle" });
  });

  it("returns NO_ACTIVE_GAME when no active game exists", async () => {
    const { repo } = createInMemoryRepo(null);
    const action: Action = { type: "battle_action", action: "attack", command: { actorId: asCombatantId("player") } };
    const result = await performBattleRound(
      { gameId: "g1" as never, actionId: "a1", interactionKind: "fixed_choice", action, expectedRevision: 0 },
      { repository: repo, now: () => "2026-01-01" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NO_ACTIVE_GAME");
  });

  it("rejects non-battle actions during active battle", async () => {
    const worldState = createBattleWorldState();
    const storyState = createBattleStoryState();
    const { repo } = createInMemoryRepo({
      gameId: "g1" as never,
      worldState,
      storyState,
      revision: 0,
      createdAt: "2026-01-01",
    });
    const action: Action = { type: "move", locationId: asLocationId("loc_1") } as never;
    const result = await performBattleRound(
      { gameId: "g1" as never, actionId: "a1", interactionKind: "fixed_choice", action, expectedRevision: 0 },
      { repository: repo, now: () => "2026-01-01" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("ACTION_REJECTED");
  });

  it("rejects when narrative is not ready", async () => {
    const worldState = createBattleWorldState();
    const storyState = createBattleStoryState({
      status: "provider_pending" as const,
      mode: "ai" as const,
      job: {} as never,
      lastPresentedScene: null,
    });
    const { repo } = createInMemoryRepo({
      gameId: "g1" as never,
      worldState,
      storyState,
      revision: 0,
      createdAt: "2026-01-01",
    });
    const action: Action = { type: "battle_action", action: "attack", command: { actorId: asCombatantId("player") } };
    const result = await performBattleRound(
      { gameId: "g1" as never, actionId: "a1", interactionKind: "fixed_choice", action, expectedRevision: 0 },
      { repository: repo, now: () => "2026-01-01" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("ACTION_REJECTED");
  });
});
