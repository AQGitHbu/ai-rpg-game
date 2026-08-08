import type { GameRepositoryV2 } from "./server/persistence/gameRepositoryV2";
import type { GameId } from "./server/persistence/gameRepository";
import type { StoryState } from "@/game/domain/storyState";
import type { GameTypeId, GameLength } from "@/game/domain/newGame";
import type { WorldGenerationCandidate } from "@/game/domain/worldGenerationCandidate";
import { parseWorldGenerationCandidate } from "@/game/domain/worldGenerationCandidate";
import { validateWorldGenerationCandidate } from "@/game/gameplay/rpg/scenarioV2";
import { compileWorldGenerationCandidate } from "@/game/gameplay/rpg/scenarioV2";
import { asGenerationId } from "@/game/domain/scenarioBlueprint";
import { createPendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import { asNarrativeJobId, asTurnId } from "@/game/domain/events";

// ---------------------------------------------------------------------------
// Task 14 Step 2：世界生成编排改为 source → parse → validate → compile。
// WorldGenerationSource.generate 返回 WorldGenerationCandidate（原始字符串 ID）。
// createGameV2 内：schema parse → gameplay validate → compile 为单一 World/Story
// State，任何失败返回明确错误码，绝不用 `as never` 透传。
// ---------------------------------------------------------------------------

export type WorldGenerationSource = {
  generate(input: {
    gameType: GameTypeId;
    seed: string;
    gameLength: GameLength;
  }): Promise<WorldGenerationCandidate>;
};

export type CreateGameV2Input = {
  readonly gameId: GameId;
  readonly gameType: GameTypeId;
  readonly gameLength: GameLength;
  readonly seed: string;
};

export type CreateGameV2Result =
  | { readonly ok: true; readonly revision: number }
  | { readonly ok: false; readonly code: "ACTIVE_GAME_EXISTS" | "GENERATION_FAILED" | "INFRASTRUCTURE_FAILURE" };

export type CreateGameV2Deps = {
  readonly repository: GameRepositoryV2;
  readonly source: WorldGenerationSource;
  readonly now: () => string;
  /** Whether AI config is available (determines narrative.mode) */
  readonly aiEnabled?: boolean;
};

export async function createGameV2(
  input: CreateGameV2Input,
  deps: CreateGameV2Deps,
): Promise<CreateGameV2Result> {
  const generated = await deps.source.generate({
    gameType: input.gameType,
    seed: input.seed,
    gameLength: input.gameLength,
  });
  if (!generated) return { ok: false, code: "GENERATION_FAILED" };

  // Step 2.2：schema parse → validate → compile。
  const parsed = parseWorldGenerationCandidate(generated);
  if (!parsed.ok) return { ok: false, code: "GENERATION_FAILED" };

  const validated = validateWorldGenerationCandidate(parsed.value);
  if (!validated.ok) return { ok: false, code: "GENERATION_FAILED" };

  const generation = {
    generationId: asGenerationId(`gen_${input.seed}`),
    seed: input.seed,
    templateVersion: "v2" as const,
    inputDigest: "",
    gameType: input.gameType,
  };

  const { worldState, storyState } = compileWorldGenerationCandidate({
    candidate: validated.validated,
    generation,
    gameType: input.gameType,
    gameLength: input.gameLength,
  });

  // Set narrative to pending so the first scene (prologue) gets generated
  // by the ensure polling mechanism (spec §9.1: 生成序幕场景).
  // v2.1：pending 唯一载体是带 job 的 PendingNarrativeJob（Spec §10.3），
  // 不再使用无 job 的 requestedAt legacy 形式。
  const narrativeMode = deps.aiEnabled ? "ai" : "offline";
  const jobResult = createPendingNarrativeJob({
    jobId: asNarrativeJobId(`job_${input.seed}_0`),
    turnId: asTurnId(`turn_${input.seed}_0`),
    actionId: `start_${input.seed}`,
    expectedRevision: 0,
    turnNumber: 0,
    actionSummary: { kind: "explore" },
    resolvedEvent: {
      actionId: `start_${input.seed}`,
      status: "success",
      eventKind: "observe",
      facts: [],
      stateChanges: [],
      costs: [],
      rewards: [],
      triggeredEvents: [],
      rejectedEffects: [],
    },
    domainEventRange: { fromLedgerIndex: 0, toLedgerIndexExclusive: 1 },
    requestedAt: deps.now(),
  });
  if (!jobResult.ok) return { ok: false, code: "GENERATION_FAILED" };

  const storyStateWithPending: StoryState = {
    ...storyState,
    narrative: {
      ...storyState.narrative,
      mode: narrativeMode,
      generation: { status: "pending", job: jobResult.job },
    },
  };

  const createResult = await deps.repository.createInitialGame({
    gameId: input.gameId,
    worldState,
    storyState: storyStateWithPending,
    createdAt: deps.now(),
  });

  if (!createResult.ok) return createResult;
  return { ok: true, revision: 0 };
}

export function createFixtureWorldSource(): WorldGenerationSource {
  return {
    async generate() {
      // 开局只给 1 个地点 + 1 个 NPC（spec：渐进式世界扩展）。
      // 第二个地点存在但不解锁——通过剧情推进后 ExpansionProposer 提议解锁。
      return {
        world: {
          summary: "一个江湖恩怨交织的世界。",
          tone: "江湖沧桑",
          themes: ["探索", "抉择"],
          publicFacts: [{ id: "fact_inn", text: "起始客栈是小镇的门户。" }],
          hiddenFacts: [],
          tags: ["武侠"],
        },
        player: {
          name: "无名侠客",
          identity: "流浪剑客",
          backgroundSummary: "独自流浪，追寻身世之谜。",
          startingLocationId: "loc_start",
          startingItemIds: [],
          baseStats: { hp: 100, attack: 10, defense: 5 },
        },
        startAnchor: {
          locationId: "loc_start",
          npcId: "npc_innkeeper",
          startQuestId: "quest_main",
          mainThreadId: "thread_main",
        },
        locations: [
          {
            id: "loc_start", name: "起始客栈", description: "一间简朴的客栈，空气中弥漫着茶香。门外是一条通往小镇的土路。", kind: "main",
            connectedLocationIds: ["loc_street"], npcIds: ["npc_innkeeper"], availableItemIds: [], tags: [],
          },
          {
            id: "loc_street", name: "小镇街道", description: "热闹的街道两旁摆满了摊位", kind: "main",
            connectedLocationIds: ["loc_start"], npcIds: [], availableItemIds: [], tags: [],
          },
        ],
        npcs: [
          {
            id: "npc_innkeeper", name: "客栈老板", role: "路人", description: "热情的客栈老板，似乎知道很多消息",
            locationId: "loc_start", isCompanion: false,
            knownFactIds: ["fact_inn"], hiddenFactIds: [], goals: [], tags: [],
          },
        ],
        items: [],
        enemies: [],
        factions: [],
        quests: [
          {
            id: "quest_main", name: "探索未知世界", description: "踏出客栈，探索这个世界隐藏的秘密。", kind: "main", stage: 1,
            objectives: [{ kind: "talk_to_npc", npcId: "npc_innkeeper" }, { kind: "visit_location", locationId: "loc_street" }],
            onSuccess: { kind: "reach_ending", endingId: "ending_success" },
            onFailure: { kind: "closed" },
            tags: ["main"],
          },
        ],
        endings: [
          { id: "ending_success", name: "冒险成功", description: "你完成了这段冒险。", requirements: [{ kind: "quest_completed", questId: "quest_main" }] },
          { id: "ending_roam", name: "浪迹天涯", description: "你选择了继续流浪。", requirements: [{ kind: "fact_discovered", factId: "fact_inn" }] },
        ],
        openingBudget: { locationsCount: 2, npcsCount: 1, sideQuestsCount: 0, endingsCount: 2, townLocationsCount: 0 },
      };
    },
  };
}
