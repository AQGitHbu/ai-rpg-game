import type { GameLength } from "@/game/domain/newGame";
import type { OpeningGenerationCandidate } from "@/game/domain/openingGenerationCandidate";
import type { GenerationMetadata } from "@/game/domain/worldEntity";
import { asLocationId, asNpcId, asQuestId, asFactId, asItemId, PLAYER_ENTITY_ID, RETURN_REQUIRED_ITEM_TAG } from "@/game/domain/worldEntity";
import type { WorldState } from "@/game/domain/worldState";
import { createWorldStateFromProjection } from "@/game/domain/worldState";
import { commitInitializationEvent } from "@/game/domain/eventLedger";
import { canonicalOpeningThreadEnvelopeFactIds, type NarrativeEventDraft } from "@/game/domain/events";
import type {
  ItemEntry, LocationEntry, NpcEntry, QuestEntry, WorldFactEntry,
} from "@/game/domain/worldEntries";
import type { StoryState } from "@/game/domain/storyState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { rebuildEpisodicMemory } from "@/game/domain/episodicMemory";
import type { NarrativeRuntimeState } from "@/game/domain/narrative";
import { createTownRuntime, townSeedFor, bindNpcToTownSlot } from "@/game/gameplay/rpg/town";
import { PLAYER_COMBAT_STATS, toStatBlock } from "@/game/domain/combat";
import { npcGoalId } from "@/game/domain/entity";
import type {
  NpcDynamicStateComponent, NpcGoal, NpcHistoryComponent, NpcKnowledgeComponent,
  NpcRelationshipComponent,
} from "@/game/domain/entity";
import { INITIAL_RELATIONSHIP_SEED_POLICY } from "@/game/gameplay/rpg/npcMemory";

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

  const privateFactIdSet = new Set(privateFactIds);
  const knowledgeFactIds = [...new Set([...knownFactIds, ...privateFactIds])];
  const openingKnowledge: NpcKnowledgeComponent = {
    entries: knowledgeFactIds.map((factId) => ({
      factId,
      certainty: "known",
      disclosure: privateFactIdSet.has(factId) ? "secret" : "public",
      source: { kind: "initial_world", learnedAtTurn: 0 },
    })),
  };
  const connection = candidate.opening.situation.npcConnection;
  const initialEmotion = input.initialNarrative.status === "ready"
    ? input.initialNarrative.currentScene.npcLine?.emotion ?? "neutral"
    : "neutral";
  const openingDynamicState: NpcDynamicStateComponent = {
    isCompanion: false,
    met: connection.familiarity === "known",
    emotion: initialEmotion,
    goals: candidate.opening.npc.goals.map((proposal, index): NpcGoal => ({
      goalId: npcGoalId(String(npcId), index + 1),
      horizon: proposal.horizon,
      description: proposal.description,
      priority: proposal.priority,
      status: "active",
      reason: proposal.reason,
    })),
  };
  const relationshipRule = connection.stance === "neutral"
    ? {
        dimensions: { affinity: 0, trust: 0, fear: 0, hostility: 0 },
        stage: connection.familiarity === "known" ? "acquainted" as const : "unknown" as const,
        reasonKey: connection.basisHistoryKeys[0] ?? "opening_npc",
      }
    : INITIAL_RELATIONSHIP_SEED_POLICY[connection.stance];
  const openingRelationships: NpcRelationshipComponent = {
    outgoing: [{
      targetId: PLAYER_ENTITY_ID,
      dimensions: relationshipRule.dimensions,
      stage: relationshipRule.stage,
      trend: "stable",
      commitments: [],
      evidence: [],
      origin: {
        kind: "initial_world",
        createdAtTurn: 0,
        reasonKey: connection.basisHistoryKeys[0] ?? relationshipRule.reasonKey,
      },
      lastChangedAtTurn: 0,
    }],
  };
  const openingHistory: NpcHistoryComponent = { interactions: [] };

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

  const startingLocation: LocationEntry = {
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
  };

  const openingNpc: NpcEntry = {
    id: npcId,
    name: candidate.opening.npc.name,
    role: candidate.opening.npc.role,
    description: candidate.opening.npc.description,
    locationId,
    isCompanion: false,
    tags: [],
    met: connection.familiarity === "known",
    memory: {
      npcId,
      knownFactIds,
      hiddenFactIds: privateFactIds,
      interactionHistory: [],
      relationship: { affinity: relationshipRule.dimensions.affinity },
      emotion: initialEmotion,
      goals: candidate.opening.npc.goals.map((goal) => goal.description),
    },
  };

  const openingFacts: readonly WorldFactEntry[] = factIds.map((fact) => ({
    factId: fact.factId,
    text: fact.text,
    source: "generated",
    discovered: knownFactIds.includes(fact.factId),
    // 只复制已审批（validated）候选携带的方式；缺省/空保持自动揭示。
    ...(fact.investigationApproaches === undefined || fact.investigationApproaches.length === 0
      ? {}
      : { investigationApproaches: fact.investigationApproaches }),
  }));

  const openingItems: readonly ItemEntry[] = candidate.opening.item === undefined
    ? []
    : [{
        id: asItemId("item_0"),
        name: candidate.opening.item.name,
        description: candidate.opening.item.description,
        kind: candidate.opening.item.kind,
        tags: [...new Set([
          ...candidate.opening.item.tags,
          ...(candidate.storyContract.delivery === undefined ? [] : [RETURN_REQUIRED_ITEM_TAG]),
        ])],
      }];

  const openingQuest: QuestEntry = {
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
  };

  // 开局一次编译：全部通过 approval 的实体先进入同一投影，不留前向引用缺口。
  const worldState: WorldState = createWorldStateFromProjection({
    generation,
    projection: {
      player: {
        name: candidate.player.name,
        identity: candidate.player.identity,
        // 规则拥有玩家战斗属性；旧候选中的 baseStats 只为历史 fixture 保留，不能越权落库。
        stats: toStatBlock(PLAYER_COMBAT_STATS),
      },
      locations: [startingLocation],
      currentLocationId: locationId,
      unlockedLocationIds: [locationId],
      visitedLocationIds: [locationId],
      npcs: [openingNpc],
      items: openingItems,
      inventory: openingItems.map((item) => item.id),
      worldFacts: openingFacts,
      quests: [openingQuest],
      enemies: [],
      defeatedEnemyIds: [],
      factions: [],
    },
    npcCreationComponentsById: new Map([[npcId, {
      anchors: candidate.opening.npc.anchors,
      dynamicState: openingDynamicState,
      knowledge: openingKnowledge,
      relationships: openingRelationships,
      history: openingHistory,
    }]]),
    eventLedger: [],
  });

  const factIdByKey = new Map(factIds.map((fact) => [fact.key, fact.factId] as const));
  const participantId = (ref: "player" | "opening_npc") => ref === "player" ? PLAYER_ENTITY_ID : npcId;
  const historyDrafts: NarrativeEventDraft[] = candidate.opening.situation.history.map((history) => {
    const referencedFactIds = history.factKeys.map((key) => factIdByKey.get(key)!);
    return {
      eventKey: `history_${history.key}`,
      episodeKey: "initialization",
      actorIds: history.participantRefs.map(participantId),
      targetIds: [],
      locationId,
      causeKeys: history.causeHistoryKeys.map((key) => ({ kind: "same_batch" as const, eventKey: `history_${key}` })),
      factIds: referencedFactIds,
      questIds: [],
      outcome: "neutral",
      salience: 70,
      payload: { type: "opening_history_established", factIds: referencedFactIds },
    };
  });
  const threadDrafts: NarrativeEventDraft[] = candidate.opening.situation.threads.map((thread) => {
    const questionFactId = factIdByKey.get(thread.questionFactKey)!;
    const supportingFactIds = thread.supportingFactKeys.map((key) => factIdByKey.get(key)!);
    return {
      eventKey: `thread_${thread.key}`,
      episodeKey: "initialization",
      actorIds: thread.participantRefs.map(participantId),
      targetIds: [],
      locationId,
      causeKeys: thread.causeHistoryKeys.map((key) => ({ kind: "same_batch" as const, eventKey: `history_${key}` })),
      factIds: canonicalOpeningThreadEnvelopeFactIds({ questionFactId, supportingFactIds }),
      questIds: [],
      outcome: "neutral",
      salience: 80,
      payload: {
        type: "opening_thread_established",
        threadId: `thread_init_${thread.key}`,
        questionFactId,
        supportingFactIds,
      },
    };
  });
  const initCommit = commitInitializationEvent({
    generation,
    locationId,
    committedAt: "1970-01-01T00:00:00Z",
    entityStore: worldState.entityStore,
    backgroundDrafts: [...historyDrafts, ...threadDrafts],
  });
  if (!initCommit.ok) throw new Error("Failed to commit game_initialized event");
  const committedWorldState: WorldState = { ...worldState, eventLedger: initCommit.ledger };

  const openingThreads = candidate.opening.situation.threads.map((thread) => {
    const questionFactId = factIdByKey.get(thread.questionFactKey)!;
    const evidenceEventId = initCommit.eventIdByKey.get(`thread_${thread.key}`);
    const causeEventIds = thread.causeHistoryKeys
      .map((key) => initCommit.eventIdByKey.get(`history_${key}`))
      .filter((eventId): eventId is NonNullable<typeof eventId> => eventId !== undefined);
    return {
      id: `thread_init_${thread.key}`,
      kind: "question" as const,
      participantIds: thread.participantRefs.map(participantId),
      causeEventIds,
      questIds: [questId],
      goalRefs: [],
      promiseRefs: [],
      question: factIds.find((fact) => fact.factId === questionFactId)?.text ?? thread.questionFactKey,
      status: "open" as const,
      evidenceEventIds: evidenceEventId === undefined ? [] : [evidenceEventId],
      closure: [],
      tentativeDirections: [],
    };
  });

  const baseStoryState = createInitialStoryState({
    gameLength,
    initialEntityCounts: { locations: 1, npcs: 1, quests: 1, events: 0 },
    initialNarrative: input.initialNarrative,
    mainThreadId: openingThreads[0]?.id,
  });
  const storyState: StoryState = {
    ...baseStoryState,
    threads: openingThreads,
    unresolvedThreads: openingThreads.map((thread) => thread.id),
    memory: rebuildEpisodicMemory(committedWorldState.eventLedger),
    targetActs: candidate.storyContract.targetActs,
    contract: candidate.storyContract,
    ...(candidate.storyContract.delivery === undefined ? {} : {
      delivery: { itemId: openingItems[0]!.id, giverNpcId: npcId, recipientNpcId: null },
    }),
    prologueText: candidate.prologue,
    evolution: {
      nextLocationOrdinal: 1,
      nextNpcOrdinal: 1,
      nextItemOrdinal: openingItems.length,
      nextEnemyOrdinal: 0,
      nextFactOrdinal: factIds.length,
      nextQuestOrdinal: 1,
      nextEndingOrdinal: 0,
      status: "stable",
    },
  };

  return { worldState: committedWorldState, storyState };
}
