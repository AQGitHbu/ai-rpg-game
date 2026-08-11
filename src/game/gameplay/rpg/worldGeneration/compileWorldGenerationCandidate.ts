import type {
  WorldGenerationCandidate,
  NpcGenerationCandidate,
  FactionCandidate,
} from "@/game/domain/worldGenerationCandidate";
import type {
  WorldState,
  LocationEntry,
  NpcEntry,
  ItemEntry,
  EnemyEntry,
  QuestEntry,
  EndingEntry,
  WorldFactEntry,
  FactionEntry,
  QuestObjective,
  QuestOutcome,
  PlayerState,
} from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { GameTypeId, GameLength } from "@/game/domain/newGame";
import {
  asLocationId, asNpcId, asItemId, asEnemyId, asQuestId, asEndingId, asFactId,
  type GenerationMetadata, type QuestDefinitionCandidate, type LocationDefinitionCandidate,
  type ItemDefinitionCandidate, type EnemyTemplateCandidate, type EndingDefinitionCandidate,
  type QuestOutcomeCandidate, type QuestObjectiveCandidate,
} from "@/game/domain/worldEntity";
import {
  createInitialWorldState, appendLocation, appendNpc, appendItem, appendEnemy,
} from "@/game/domain/worldState";
import { createInitialStoryState } from "@/game/domain/storyState";

// ---------------------------------------------------------------------------
// Task 14：把已验证的 WorldGenerationCandidate 编译为单一 World State + Story State。
//
// - 确定性：不读取时间/随机；generation metadata 由调用方显式传入。
// - 起始/解锁/已访问集合正确；NPC memory 初始知识与 goals 正确。
// - main thread、targetActs、budget opening、tension 初值正确。
// - 第一幕 main quest active，其余任务按解锁图 locked。
// - 两个结局 requirements 保留。
// ---------------------------------------------------------------------------

export type CompileWorldGenerationCandidateInput = {
  readonly candidate: WorldGenerationCandidate;
  readonly generation: GenerationMetadata;
  readonly gameType: GameTypeId;
  readonly gameLength: GameLength;
};

export type CompileWorldGenerationCandidateResult = {
  readonly worldState: WorldState;
  readonly storyState: StoryState;
};

export function compileWorldGenerationCandidate(
  input: CompileWorldGenerationCandidateInput,
): CompileWorldGenerationCandidateResult {
  const { candidate } = input;

  const compileLocations = candidate.locations.map(compileLocation);
  const compileNpcs = candidate.npcs.map(compileNpc);
  const compileItems = candidate.items.map(compileItem);
  const compileEnemies = candidate.enemies.map(compileEnemy);

  const startingLocation = compileLocations.find((l) => l.id === asLocationId(candidate.startAnchor.locationId))
    ?? compileLocations[0];

  const player: PlayerState = {
    name: candidate.player.name,
    identity: candidate.player.identity,
    stats: {
      hp: candidate.player.baseStats.hp,
      attack: candidate.player.baseStats.attack,
      defense: candidate.player.baseStats.defense,
    },
  };

  let worldState = createInitialWorldState({
    generation: input.generation,
    player,
    startingLocation,
    startingItemIds: candidate.player.startingItemIds.map(asItemId),
  });

  for (const loc of compileLocations) {
    if (loc.id !== startingLocation.id) worldState = appendLocation(worldState, loc);
  }
  for (const npc of compileNpcs) worldState = appendNpc(worldState, npc);
  for (const item of compileItems) worldState = appendItem(worldState, item);
  for (const enemy of compileEnemies) worldState = appendEnemy(worldState, enemy);

  // 世界事实：公开事实开局即可见（discovered），隐藏事实未发现。
  const worldFacts: readonly WorldFactEntry[] = [
    ...candidate.world.publicFacts.map((f) => ({
      factId: asFactId(f.id),
      text: f.text,
      source: "generated" as const,
      discovered: true,
    })),
    ...candidate.world.hiddenFacts.map((f) => ({
      factId: asFactId(f.id),
      text: f.text,
      source: "generated" as const,
      discovered: false,
    })),
  ];

  // 任务：第一幕 main quest（stage 1）active；side quests 初始可接（active）；
  // 其余被解锁链引用的任务 locked。
  const quests = compileQuests(candidate.quests);

  const endings = compileEndings(candidate.endings);
  const factions = compileFactions(candidate.factions);

  worldState = {
    ...worldState,
    unlockedLocationIds: [startingLocation.id],
    visitedLocationIds: [startingLocation.id],
    worldFacts,
    quests,
    endings,
    factions,
  };

  const storyState = createInitialStoryState({
    gameLength: input.gameLength,
    mainThreadId: candidate.startAnchor.mainThreadId,
    initialEntityCounts: {
      locations: compileLocations.length,
      npcs: compileNpcs.length,
      quests: quests.length,
      events: 0,
    },
  });

  return { worldState, storyState };
}

function compileLocation(loc: LocationDefinitionCandidate): LocationEntry {
  return {
    id: asLocationId(loc.id),
    name: loc.name,
    description: loc.description,
    kind: loc.kind,
    connectedLocationIds: loc.connectedLocationIds.map(asLocationId),
    npcIds: loc.npcIds.map(asNpcId),
    availableItemIds: loc.availableItemIds.map(asItemId),
    tags: loc.tags,
    // town 层级标记：缺省不落字段，读取统一经 locationScaleOf。
    ...(loc.scale === "town" ? { scale: "town" as const } : {}),
  };
}

function compileNpc(npc: NpcGenerationCandidate): NpcEntry {
  const id = asNpcId(npc.id);
  return {
    id,
    name: npc.name,
    role: npc.role,
    description: npc.description,
    locationId: asLocationId(npc.locationId),
    isCompanion: npc.isCompanion,
    tags: npc.tags,
    met: false,
    memory: {
      npcId: id,
      knownFactIds: npc.knownFactIds.map(asFactId),
      hiddenFactIds: npc.hiddenFactIds.map(asFactId),
      interactionHistory: [],
      relationship: { affinity: 0 },
      emotion: "neutral",
      goals: npc.goals,
    },
  };
}

function compileItem(item: ItemDefinitionCandidate): ItemEntry {
  return {
    id: asItemId(item.id),
    name: item.name,
    description: item.description,
    kind: item.kind,
    tags: item.tags,
  };
}

function compileEnemy(enemy: EnemyTemplateCandidate): EnemyEntry {
  return {
    id: asEnemyId(enemy.id),
    name: enemy.name,
    tier: enemy.tier,
    stats: enemy.stats,
    locationId: asLocationId(enemy.locationId),
    tags: enemy.tags,
  };
}

function compileQuests(quests: readonly QuestDefinitionCandidate[]): readonly QuestEntry[] {
  return quests.map((q) => {
    const stage = q.kind === "main" ? q.stage : undefined;
    const stage1Main = q.kind === "main" && q.stage === 1;
    const isInitial = q.kind === "side" || stage1Main;
    return {
      id: asQuestId(q.id),
      name: q.name,
      description: q.description,
      objectives: q.objectives.map(compileObjective),
      onSuccess: compileOutcome(q.onSuccess),
      onFailure: compileOutcome(q.onFailure),
      tags: q.tags,
      kind: q.kind,
      stage,
      status: isInitial ? "active" : "locked",
    };
  });
}

function compileObjective(objective: QuestObjectiveCandidate): QuestObjective {
  switch (objective.kind) {
    case "visit_location": return { kind: "visit_location", locationId: asLocationId(objective.locationId) };
    case "talk_to_npc": return { kind: "talk_to_npc", npcId: asNpcId(objective.npcId) };
    case "obtain_item": return { kind: "obtain_item", itemId: asItemId(objective.itemId) };
    case "discover_fact": return { kind: "discover_fact", factId: asFactId(objective.factId) };
    case "defeat_enemy": return { kind: "defeat_enemy", enemyId: asEnemyId(objective.enemyId) };
  }
}

function compileOutcome(outcome: QuestOutcomeCandidate): QuestOutcome {
  switch (outcome.kind) {
    case "unlock_quests": return {
      kind: "unlock_quests",
      questIds: outcome.questIds.map(asQuestId),
      ...(outcome.locationIds !== undefined ? { locationIds: outcome.locationIds.map(asLocationId) } : {}),
    };
    case "reach_ending": return { kind: "reach_ending", endingId: asEndingId(outcome.endingId) };
    case "closed": return { kind: "closed" };
  }
}

function compileEndings(endings: readonly EndingDefinitionCandidate[]): readonly EndingEntry[] {
  return endings.map((e) => ({
    id: asEndingId(e.id),
    name: e.name,
    description: e.description,
    requirements: e.requirements.map((r) => {
      if (r.kind === "fact_discovered") return { kind: "fact_discovered", factId: asFactId(r.factId) };
      if (r.kind === "quest_failed") return { kind: "quest_failed", questId: asQuestId(r.questId) };
      if (r.kind === "npc_affinity_at_least") return { kind: "npc_affinity_at_least", npcId: asNpcId(r.npcId), value: r.value };
      if (r.kind === "npc_affinity_at_most") return { kind: "npc_affinity_at_most", npcId: asNpcId(r.npcId), value: r.value };
      return { kind: "quest_completed", questId: asQuestId(r.questId) };
    }),
  }));
}

function compileFactions(factions: readonly FactionCandidate[]): readonly FactionEntry[] {
  return factions.map((f) => ({
    factionId: f.factionId,
    name: f.name,
    attitudeToPlayer: f.attitudeToPlayer,
  }));
}
