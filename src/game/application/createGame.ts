import type { GameRepository } from "./server/persistence/gameRepository";
import type { GameId } from "./server/persistence/gameRepository";
import type { StoryState } from "@/game/domain/storyState";
import type { GameTypeId, GameLength } from "@/game/domain/newGame";
import type { WorldGenerationCandidate } from "@/game/domain/worldGenerationCandidate";
import { parseWorldGenerationCandidate } from "@/game/domain/worldGenerationCandidate";
import { validateWorldGenerationCandidate } from "@/game/gameplay/rpg/worldGeneration";
import { compileWorldGenerationCandidate } from "@/game/gameplay/rpg/worldGeneration";
import { asGenerationId } from "@/game/domain/scenarioBlueprint";
import { createPendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import { asNarrativeJobId, asTurnId } from "@/game/domain/events";

// ---------------------------------------------------------------------------
// Task 14 Step 2：世界生成编排改为 source → parse → validate → compile。
// WorldGenerationSource.generate 返回 WorldGenerationCandidate（原始字符串 ID）。
// createGame 内：schema parse → gameplay validate → compile 为单一 World/Story
// State，任何失败返回明确错误码，绝不用 `as never` 透传。
// ---------------------------------------------------------------------------

export type WorldGenerationSource = {
  generate(input: {
    gameType: GameTypeId;
    seed: string;
    gameLength: GameLength;
  }): Promise<WorldGenerationCandidate>;
};

export type CreateGameInput = {
  readonly gameId: GameId;
  readonly gameType: GameTypeId;
  readonly gameLength: GameLength;
  readonly seed: string;
};

export type CreateGameResult =
  | { readonly ok: true; readonly revision: number }
  | { readonly ok: false; readonly code: "ACTIVE_GAME_EXISTS" | "GENERATION_FAILED" | "INFRASTRUCTURE_FAILURE" };

export type CreateGameDeps = {
  readonly repository: GameRepository;
  readonly source: WorldGenerationSource;
  readonly now: () => string;
  /** Whether AI config is available (determines narrative.mode) */
  readonly aiEnabled?: boolean;
};

export async function createGame(
  input: CreateGameInput,
  deps: CreateGameDeps,
): Promise<CreateGameResult> {
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
  // pending 唯一载体是带 job 的 PendingNarrativeJob（Spec §10.3），
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
    async generate(input) {
      const variants = [
        { npc: "沈掌柜", route: "青石古道", lair: "黑风寨", clue: "残月密函", secret: "密函暗纹指向黑风寨主的秘密盟约。", boss: "黑风寨主" },
        { npc: "顾账房", route: "芦苇渡口", lair: "沉钟水寨", clue: "潮痕账册", secret: "账册夹页记录着水寨与官府的暗中交易。", boss: "沉钟舵主" },
        { npc: "陆驿丞", route: "断桥驿道", lair: "赤焰山庄", clue: "焦边路引", secret: "路引背面藏着山庄劫掠商队的密令。", boss: "赤焰庄主" },
        { npc: "叶药师", route: "药王山径", lair: "寒鸦别院", clue: "药香手札", secret: "手札末页揭示别院正在试炼禁药。", boss: "寒鸦院主" },
      ] as const;
      let hash = 2166136261;
      for (const char of input.seed) {
        hash ^= char.charCodeAt(0);
        hash = Math.imul(hash, 16777619) >>> 0;
      }
      const variant = variants[hash % variants.length]!;
      return {
        world: {
          summary: `一场从客栈延伸到${variant.lair}的江湖追索。`,
          tone: "江湖沧桑",
          themes: ["探索", "抉择"],
          publicFacts: [{ id: "fact_inn", text: `${variant.npc}守着通往${variant.route}的消息。` }],
          hiddenFacts: [{ id: "fact_secret", text: variant.secret }],
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
            id: "loc_start", name: "听雨客栈", description: `一间临近${variant.route}的旧客栈。`, kind: "main",
            connectedLocationIds: ["loc_street"], npcIds: ["npc_innkeeper"], availableItemIds: [], tags: [],
          },
          {
            id: "loc_street", name: variant.route, description: `通向${variant.lair}的必经之路。`, kind: "main",
            connectedLocationIds: ["loc_start", "loc_lair"], npcIds: [], availableItemIds: ["item_clue"], tags: ["route"],
          },
          {
            id: "loc_lair", name: variant.lair, description: `${variant.boss}盘踞的险地。`, kind: "main",
            connectedLocationIds: ["loc_street"], npcIds: [], availableItemIds: [], tags: ["climax"],
          },
        ],
        npcs: [
          {
            id: "npc_innkeeper", name: variant.npc, role: "关键线人", description: `掌握${variant.route}沿途消息的客栈主人。`,
            locationId: "loc_start", isCompanion: false,
            knownFactIds: ["fact_inn"], hiddenFactIds: ["fact_secret"], goals: ["查明幕后势力"], tags: ["key_npc"],
          },
        ],
        items: [{ id: "item_clue", name: variant.clue, description: "能指向最终据点的关键证物。", kind: "clue", tags: ["quest"] }],
        enemies: [{ id: "enemy_boss", name: variant.boss, description: "主线最终强敌。", tier: "boss", stats: { hp: 24, attack: 6, defense: 2 }, locationId: "loc_lair", tags: ["boss"] }],
        factions: [],
        quests: [
          {
            id: "quest_main", name: `取得${variant.npc}的信任`, description: "从关键线人口中确认追索方向。", kind: "main", stage: 1,
            objectives: [{ kind: "talk_to_npc", npcId: "npc_innkeeper" }],
            onSuccess: { kind: "unlock_quests", questIds: ["quest_clue"], locationIds: ["loc_street"] },
            onFailure: { kind: "closed" },
            tags: ["main"],
          },
          {
            id: "quest_clue", name: `追查${variant.clue}`, description: "沿途取得证物并查明其中秘密。", kind: "main", stage: 2,
            objectives: [{ kind: "visit_location", locationId: "loc_street" }, { kind: "obtain_item", itemId: "item_clue" }],
            onSuccess: { kind: "unlock_quests", questIds: ["quest_climax"], locationIds: ["loc_lair"] },
            onFailure: { kind: "closed" },
            tags: ["main"],
          },
          {
            id: "quest_climax", name: `决战${variant.boss}`, description: "击败幕后强敌，为选择承担结果。", kind: "main", stage: 3,
            objectives: [{ kind: "defeat_enemy", enemyId: "enemy_boss" }],
            onSuccess: { kind: "reach_ending", endingId: "ending_trust" },
            onFailure: { kind: "closed" },
            tags: ["main", "climax"],
          },
        ],
        endings: [
          { id: "ending_trust", name: "并肩破局", description: `你与${variant.npc}以信任守住了胜利。`, requirements: [{ kind: "quest_completed", questId: "quest_climax" }, { kind: "npc_affinity_at_least", npcId: "npc_innkeeper", value: 10 }] },
          { id: "ending_doubt", name: "孤身远行", description: "你赢下决战，却因猜疑独自离开。", requirements: [{ kind: "quest_completed", questId: "quest_climax" }, { kind: "npc_affinity_at_most", npcId: "npc_innkeeper", value: 5 }] },
        ],
        openingBudget: { locationsCount: 3, npcsCount: 1, sideQuestsCount: 0, endingsCount: 2, townLocationsCount: 0 },
      };
    },
  };
}
