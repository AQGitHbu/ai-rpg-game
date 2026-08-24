import type { GameLength } from "@/game/domain/newGame";
import type { OpeningGenerationCandidate } from "@/game/domain/openingGenerationCandidate";
import type { GenerationMetadata } from "@/game/domain/worldEntity";
import { asLocationId, asNpcId, asQuestId, asFactId } from "@/game/domain/worldEntity";
import type { WorldState } from "@/game/domain/worldState";
import { createInitialWorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import { createInitialStoryState } from "@/game/domain/storyState";
import type { NarrativeRuntimeState } from "@/game/domain/narrative";
import { createTownRuntime, townSeedFor, bindNpcToTownSlot } from "@/game/gameplay/rpg/town";
import { PLAYER_COMBAT_STATS, toStatBlock } from "@/game/domain/combat";

// ---------------------------------------------------------------------------
// Task 2：把已验证的开局切片编译为单一 World State + Story State。
// 只铸造 loc_0 / npc_0 / quest_0 与开场需要的事实 ID（fact_0..N-1）；
// 不具象化任何未来实体（无敌人、无结局、无预生成任务/地点/NPC）。
// 首个任务的 onSuccess 是 advance_story（幕推进信号，Task 3 消费），
// onFailure 是 closed。演化状态 stable，序号从开场后计起供 Task 3 铸造。
// ---------------------------------------------------------------------------

export type CompileOpeningGenerationCandidateInput = {
  readonly candidate: OpeningGenerationCandidate;
  readonly generation: GenerationMetadata;
  readonly gameLength: GameLength;
  readonly initialNarrative: NarrativeRuntimeState;
};

export type CompileOpeningGenerationCandidateResult = {
  readonly worldState: WorldState;
  readonly storyState: StoryState;
};

export const OPENING_NPC_ID = asNpcId("npc_0");

export function compileOpeningGenerationCandidate(
  input: CompileOpeningGenerationCandidateInput,
): CompileOpeningGenerationCandidateResult {
  const { candidate, generation, gameLength } = input;

  const locationId = asLocationId("loc_0");
  const npcId = OPENING_NPC_ID;
  const questId = asQuestId("quest_0");

  const factIds = candidate.world.publicFacts.map((fact, index) => ({
    factId: asFactId(`fact_${index}`),
    key: fact.key,
    text: fact.text,
    investigationApproaches: fact.investigationApproaches,
  }));

  const knownFactIds = candidate.opening.npc.knownFactKeys.map((key) => factIds.find((fact) => fact.key === key)!.factId);
  const privateFactIds = candidate.opening.npc.privateFactKeys.map((key) => factIds.find((fact) => fact.key === key)!.factId);

  // Task 7：开局地点是 scale="town" 时编译稳定几何 + 未绑定剧情建筑 slot，
  // 开局 NPC npc_0 绑定 slot_0。不再生成任何未来 NPC 名称。
  const openingTown = candidate.opening.location.scale === "town"
    ? bindNpcToTownSlot(
        createTownRuntime({
          locationId,
          seed: townSeedFor(generation.seed, locationId),
          ...(candidate.opening.location.buildingName === undefined
            ? {}
            : { openingBuildingName: candidate.opening.location.buildingName }),
        }),
        npcId,
      ).town
    : undefined;

  const worldState: WorldState = {
    ...createInitialWorldState({
      generation,
      player: {
        name: candidate.player.name,
        identity: candidate.player.identity,
        // 规则拥有玩家战斗属性；旧候选中的 baseStats 只为历史 fixture 保留，不能越权落库。
        stats: toStatBlock(PLAYER_COMBAT_STATS),
      },
      startingLocation: {
        id: locationId,
        name: candidate.opening.location.name,
        description: candidate.opening.location.description,
        kind: "main",
        connectedLocationIds: [],
        npcIds: [npcId],
        availableItemIds: [],
        tags: [],
        scale: candidate.opening.location.scale,
        town: openingTown,
      },
      startingItemIds: [],
    }),
    npcs: [{
      id: npcId,
      name: candidate.opening.npc.name,
      role: candidate.opening.npc.role,
      description: candidate.opening.npc.description,
      locationId,
      isCompanion: false,
      tags: [],
      met: false,
      memory: {
        npcId,
        knownFactIds,
        hiddenFactIds: privateFactIds,
        interactionHistory: [],
        relationship: { affinity: 0 },
        emotion: "neutral",
        goals: candidate.opening.npc.goals,
      },
    }],
    worldFacts: factIds.map((fact) => ({
      factId: fact.factId,
      text: fact.text,
      source: "generated",
      discovered: knownFactIds.includes(fact.factId),
      // 只复制已审批（validated）候选携带的方式；缺省/空保持自动揭示。
      ...(fact.investigationApproaches === undefined || fact.investigationApproaches.length === 0
        ? {}
        : { investigationApproaches: fact.investigationApproaches }),
    })),
    quests: [{
      id: questId,
      name: candidate.opening.quest.name,
      description: candidate.opening.quest.description,
      objectives: [{ kind: "talk_to_npc", npcId }],
      onSuccess: { kind: "advance_story" },
      onFailure: { kind: "closed" },
      tags: [],
      kind: "main",
      stage: 1,
      status: "active",
    }],
  };

  const baseStoryState = createInitialStoryState({
    gameLength,
    initialEntityCounts: { locations: 1, npcs: 1, quests: 1, events: 0 },
    initialNarrative: input.initialNarrative,
  });
  const storyState: StoryState = {
    ...baseStoryState,
    targetActs: candidate.storyContract.targetActs,
    contract: candidate.storyContract,
    prologueText: candidate.prologue,
    evolution: {
      nextLocationOrdinal: 1,
      nextNpcOrdinal: 1,
      nextItemOrdinal: 0,
      nextEnemyOrdinal: 0,
      nextFactOrdinal: factIds.length,
      nextQuestOrdinal: 1,
      nextEndingOrdinal: 0,
      status: "stable",
    },
  };

  return { worldState, storyState };
}
