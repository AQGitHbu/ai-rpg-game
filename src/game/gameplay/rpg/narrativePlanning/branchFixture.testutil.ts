import { createWorldStateFixtureWith } from "@/game/domain/testing/worldStateFixture.testutil";
import type { EntityCompatibilityProjection } from "@/game/domain/entity/entityProjection";
import type { GenerationMetadata } from "@/game/domain/worldEntity";
import { asGenerationId, asLocationId, asNpcId, asQuestId } from "@/game/domain/worldEntity";
import type { LocationEntry, NpcEntry, QuestObjective } from "@/game/domain/worldEntries";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import type { BranchOption, Decision } from "@/game/domain/narrativeBranch";
import type { TextPart } from "@/game/domain/narrativeUnit";

// 分支验收用的真实状态骨架：单 NPC（loc_a）+ 两个可达候选地点（loc_b / loc_c）。
// 不使用「双 NPC 开局」这种不存在的世界结构冒充开局验收。

export const BRANCH_GENERATION: GenerationMetadata = {
  generationId: asGenerationId("gen_branch"),
  seed: "branch-seed",
  templateVersion: "v2",
  inputDigest: "",
  gameType: "wuxia",
};

export const LOC_A = asLocationId("loc_a");
export const LOC_B = asLocationId("loc_b");
export const LOC_C = asLocationId("loc_c");
export const NPC_0 = asNpcId("npc_0");
export const QUEST_0 = asQuestId("quest_0");

function loc(id: typeof LOC_A, name: string, connected: readonly (typeof LOC_A)[]): LocationEntry {
  return {
    id, name, description: `${name}的描述`, kind: "main",
    connectedLocationIds: [...connected], npcIds: [], availableItemIds: [], tags: [], scale: "scene",
  };
}

const NPC_ENTRY: NpcEntry = {
  id: NPC_0, name: "老陈", role: "知情者", description: "守着渡口的老陈",
  locationId: LOC_A, isCompanion: false, tags: [], met: false,
  memory: {
    npcId: NPC_0, knownFactIds: [], hiddenFactIds: [], interactionHistory: [],
    relationship: { affinity: 0 }, emotion: "neutral", goals: [],
  },
};

const PROJECTION: EntityCompatibilityProjection = {
  player: { name: "少侠", identity: "过路人", stats: { hp: 100, attack: 10, defense: 5 } },
  locations: [loc(LOC_A, "渡口", [LOC_B, LOC_C]), loc(LOC_B, "废窑", [LOC_A]), loc(LOC_C, "义庄", [LOC_A])],
  currentLocationId: LOC_A,
  unlockedLocationIds: [LOC_A, LOC_B, LOC_C],
  visitedLocationIds: [LOC_A],
  npcs: [NPC_ENTRY],
  items: [],
  inventory: [],
  worldFacts: [],
  quests: [{
    id: QUEST_0,
    name: "渡口疑云",
    description: "查清渡口昨夜发生的事",
    objectives: [{ kind: "talk_to_npc", npcId: NPC_0 }],
    onSuccess: { kind: "advance_story" },
    onFailure: { kind: "closed" },
    tags: [],
    kind: "main",
    stage: 1,
    status: "active",
  }],
  enemies: [],
  defeatedEnemyIds: [],
  factions: [],
};

export function branchWorld(overrides: Partial<EntityCompatibilityProjection> = {}): WorldState {
  return createWorldStateFixtureWith({
    generation: BRANCH_GENERATION,
    base: PROJECTION,
  }, overrides);
}

export function branchWorldWithObjectives(objectives: readonly QuestObjective[]): WorldState {
  return branchWorld({
    quests: [{
      id: QUEST_0,
      name: "渡口疑云",
      description: "查清渡口昨夜发生的事",
      objectives,
      onSuccess: { kind: "advance_story" },
      onFailure: { kind: "closed" },
      tags: [],
      kind: "main",
      stage: 1,
      status: "active",
    }],
  });
}

export function branchStory(): StoryState {
  return createInitialStoryState({
    gameLength: "short",
    initialEntityCounts: { locations: 3, npcs: 1, quests: 1, events: 0 },
    initialNarrative: createFixtureNarrativeRuntimeState(),
  });
}

export function intent(text: string): TextPart {
  return { text, facts: [], evidence: [], beatIds: [] };
}

export function branchOption(overrides: Partial<BranchOption> & { readonly candidateId: string }): BranchOption {
  return {
    dialogueAct: "support",
    topic: { kind: "general" },
    target: { kind: "visit_location", locationId: LOC_B },
    publicIntent: intent("去废窑看看"),
    deferredLocation: null,
    ...overrides,
  };
}

/** 左 → 废窑，右 → 义庄：公开目的与后续可执行目标都不同，不是只换地点名。 */
export function branchDecision(overrides: {
  readonly options?: readonly [BranchOption, BranchOption];
  readonly npcId?: string;
} = {}): Decision {
  return {
    kind: "ordinary",
    point: { stepKey: "current", order: 1 },
    npcId: overrides.npcId ?? String(NPC_0),
    options: overrides.options ?? [
      branchOption({
        candidateId: "left",
        target: { kind: "visit_location", locationId: LOC_B },
        publicIntent: intent("去废窑查那批货"),
      }),
      branchOption({
        candidateId: "right",
        dialogueAct: "challenge",
        target: { kind: "visit_location", locationId: LOC_C },
        publicIntent: intent("去义庄查失踪的人"),
      }),
    ],
  };
}
