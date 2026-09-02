import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { describe, it, expect } from "vitest";
import { buildFocusNpcContext } from "./focusNpcContext";
import type { FocusNpcContext } from "./focusNpcContext";
import {
  type LocationEntry,
  type NpcEntry,
  type NpcInteraction,
  type WorldFactEntry,
  type WorldState,
} from "@/game/domain/worldState";
import { createInitialStoryState, type StoryState } from "@/game/domain/storyState";
import { asLocationId, asNpcId, asFactId, asGenerationId, type GenerationMetadata } from "@/game/domain/worldEntity";
import { asNarrativeJobId, asTurnId, type CommittedNarrativeEvent } from "@/game/domain/events";
import type { EntityCompatibilityProjection } from "@/game/domain/entity/entityProjection";
import {
  createWorldStateFixtureWith,
  type WorldStateFixtureOverrides,
} from "@/game/domain/testing/worldStateFixture.testutil";
import { createPendingNarrativeJob, type PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import type { GameRecord } from "./server/persistence/gameRepository";

// Task 5 Step 2/5：焦点 NPC 的隔离记忆 + 关系政策。
// 只含选中 NPC 最近 5 条结构化交互；绝不含其他 NPC 条目、玩家原话或未披露私密正文。

const LOC_1 = asLocationId("loc_1");
const NPC_1 = asNpcId("npc_1");
const NPC_2 = asNpcId("npc_2");
const FACT_PUBLIC = asFactId("fact_public");
const FACT_PRIVATE = asFactId("fact_private");
const FACT_OTHER_SECRET = asFactId("fact_other_secret");

const loc: LocationEntry = {
  id: LOC_1, name: "客栈", description: "一间简朴的客栈", kind: "main",
  connectedLocationIds: [], npcIds: [NPC_1, NPC_2], availableItemIds: [], tags: [],
};

function makeNpc(id: ReturnType<typeof asNpcId>, overrides: Partial<NpcEntry> = {}): NpcEntry {
  return {
    id,
    name: id === NPC_1 ? "老板" : "客人",
    role: id === NPC_1 ? "客栈老板" : "酒客",
    description: id === NPC_1 ? "热情的老板" : "沉默的客人",
    locationId: LOC_1,
    isCompanion: false,
    tags: [],
    met: true,
    memory: {
      npcId: id,
      knownFactIds: [],
      hiddenFactIds: [],
      interactionHistory: [],
      relationship: { affinity: 0 },
      emotion: "neutral",
      goals: [],
    },
    ...overrides,
  };
}

function makeInteraction(overrides: Partial<NpcInteraction> = {}): NpcInteraction {
  return {
    turnNumber: 1,
    actionId: "act_1",
    locationId: LOC_1,
    dialogueAct: "ask",
    topic: { kind: "general" },
    topicSummary: "闲谈",
    outcome: "positive",
    relationshipDelta: 1,
    learnedFactIds: [],
    summary: "再次交谈，ask，气氛融洽，关系+1",
    ...overrides,
  };
}

function makeJob(actionId: string): PendingNarrativeJob {
  const result = createPendingNarrativeJob({
    jobId: asNarrativeJobId(`job_${actionId}`),
    turnId: asTurnId(`turn_${actionId}`),
    actionId,
    expectedRevision: 0,
    turnNumber: 9,
    actionSummary: { kind: "talk", npcId: NPC_1 },
    utterance: "你能告诉我矿坑的秘密吗？",
    resolvedEvent: {
      actionId, status: "success", eventKind: "dialogue",
      facts: [], stateChanges: [], costs: [], rewards: [], triggeredEvents: [], rejectedEffects: [],
    },
    domainEventRange: { fromLedgerIndex: 0, toLedgerIndexExclusive: 1 },
    focusNpcId: NPC_1,
    requestedAt: "2026-01-02",
    objectiveTransition: { before: null, completed: [], after: null, mode: "unchanged" },
    mandatoryBeats: [],
    generationKind: "npc_fixed_choice",
    sceneRequestKind: "npc_response",
  });
  if (!result.ok) throw new Error("job 构造失败");
  return result.job;
}

const GENERATION: GenerationMetadata = {
  generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia",
};

// 老板（焦点）：trusted 档位；知道公开 + 私密两条事实；有 6 条交互历史。
const bossHistory: NpcInteraction[] = [
  makeInteraction({ actionId: "act_0", turnNumber: 1, topic: { kind: "general" }, topicSummary: "闲谈", outcome: "neutral", relationshipDelta: 1, summary: "首次见面，ask，语气平淡，关系+1" }),
  makeInteraction({ actionId: "act_1", turnNumber: 2, dialogueAct: "support", topic: { kind: "fact", factId: FACT_PUBLIC }, topicSummary: "询问线索", outcome: "positive", relationshipDelta: 3, summary: "再次交谈，support，气氛融洽，关系+3" }),
  makeInteraction({ actionId: "act_2", turnNumber: 3, topic: { kind: "quest", questId: "quest_0" as never }, topicSummary: "谈论任务", outcome: "positive", relationshipDelta: 2, summary: "再次交谈，ask，气氛融洽，关系+2" }),
  makeInteraction({ actionId: "act_3", turnNumber: 4, topic: { kind: "thread", threadId: "main_thread" }, topicSummary: "延续话题", outcome: "neutral", relationshipDelta: 1, summary: "再次交谈，offer，语气平淡，关系+1" }),
  makeInteraction({ actionId: "act_4", turnNumber: 5, topic: { kind: "general" }, topicSummary: "闲谈", outcome: "positive", relationshipDelta: 1, summary: "再次交谈，reassure，气氛融洽，关系+1" }),
  // 本轮（job.actionId = act_5）—— relationshipDelta 应取自这条
  makeInteraction({ actionId: "act_5", turnNumber: 9, topic: { kind: "fact", factId: FACT_PUBLIC }, topicSummary: "询问线索", outcome: "positive", relationshipDelta: 4, summary: "再次交谈，ask，气氛融洽，关系+4" }),
];

const bossNpc: NpcEntry = makeNpc(NPC_1, {
  memory: {
    npcId: NPC_1,
    knownFactIds: [FACT_PUBLIC, FACT_PRIVATE],
    hiddenFactIds: [FACT_PRIVATE],
    interactionHistory: bossHistory,
    relationship: { affinity: 70 },
    emotion: "warm",
    goals: ["守住客栈的秘密"],
  },
});

// 客人（非焦点）：有自己的私密事实，绝不可进入焦点上下文。
const guestNpc: NpcEntry = makeNpc(NPC_2, {
  memory: {
    npcId: NPC_2,
    knownFactIds: [FACT_OTHER_SECRET],
    hiddenFactIds: [FACT_OTHER_SECRET],
    interactionHistory: [makeInteraction({ actionId: "guest_1", summary: "客人自己的交谈记录" })],
    relationship: { affinity: 5 },
    emotion: "neutral",
    goals: [],
  },
});

const innFacts: readonly WorldFactEntry[] = [
  { factId: FACT_PUBLIC, text: "矿坑里藏着密道", source: "generated", discovered: true, locationId: LOC_1 },
  { factId: FACT_PRIVATE, text: "老板年轻时犯下的旧案", source: "generated", discovered: false, locationId: LOC_1 },
  { factId: FACT_OTHER_SECRET, text: "客人暗藏的一批私货", source: "generated", discovered: false, locationId: LOC_1 },
];

const BASE_PROJECTION: EntityCompatibilityProjection = {
  player: { name: "侠客", identity: "剑客", stats: { hp: 100, attack: 10, defense: 5 } },
  locations: [loc],
  currentLocationId: LOC_1,
  unlockedLocationIds: [LOC_1],
  visitedLocationIds: [LOC_1],
  npcs: [bossNpc, guestNpc],
  items: [],
  inventory: [],
  worldFacts: innFacts,
  quests: [],
  enemies: [],
  defeatedEnemyIds: [],
  factions: [],
};

const INITIALIZED_LEDGER: readonly CommittedNarrativeEvent[] = [{ type: "game_initialized", generation: GENERATION } as unknown as CommittedNarrativeEvent];

function makeWorldState(overrides: WorldStateFixtureOverrides = {}): WorldState {
  return createWorldStateFixtureWith(
    { generation: GENERATION, base: BASE_PROJECTION },
    { eventLedger: INITIALIZED_LEDGER, ...overrides },
  );
}

function makeRecord(overrides: WorldStateFixtureOverrides = {}): GameRecord {
  const worldState = makeWorldState(overrides);

  const ss: StoryState = createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(),
    gameLength: "short",
    initialEntityCounts: { locations: 1, npcs: 2, quests: 0, events: 0 },
  });
  const storyState: StoryState = {
    ...ss,
    narrative: {
      status: "provider_pending",
      mode: "offline",
      job: makeJob("act_5"),
      lastPresentedScene: ss.narrative.status === "ready" ? ss.narrative.currentScene : null,
    },
  };

  return { gameId: "g1" as never, worldState, storyState, revision: 0, createdAt: "2026-01-01" };
}

describe("buildFocusNpcContext", () => {
  it("投影焦点 NPC 的档案、政策、可说话事实卡与情绪", () => {
    const context: FocusNpcContext = buildFocusNpcContext(makeRecord(), NPC_1);
    expect(context.id).toBe(NPC_1);
    expect(context.name).toBe("老板");
    expect(context.role).toBe("客栈老板");
    expect(context.publicProfile).toBe("热情的老板");
    // The policy is projected from the entity relationship component.
    expect(context.responsePolicy.tier).toBe("trusted");
    expect(context.responsePolicy.initiative).toBe("proactive");
    expect(context.identityAnchors).toBeDefined();
    // Authority only permits the scene-visible, non-secret fact.
    expect(context.responsePolicy.allowedDisclosureFactIds).toEqual([FACT_PUBLIC]);
    expect(context.speakableFactCards).toEqual([{ factId: FACT_PUBLIC, text: "矿坑里藏着密道" }]);
    // 私密事实只出现 ID，正文绝不出现
    expect(context.responsePolicy).not.toHaveProperty("privateKnowledgeIds");
    expect(context.emotion).toBe("warm");
    expect(context.goals).toEqual(["守住客栈的秘密"]);
  });

  it("component relationship keeps the existing affinity-based public policy", () => {
    const record = makeRecord({
      npcs: [
        { ...bossNpc, memory: { ...bossNpc.memory, relationship: { affinity: -70 } } },
        guestNpc,
      ],
    });
    const context = buildFocusNpcContext(record, NPC_1);
    expect(context.responsePolicy.tier).toBe("hostile");
    expect(context.responsePolicy.initiative).toBe("refuse");
    expect(context.responsePolicy.allowedDisclosureFactIds).toEqual([FACT_PUBLIC]);
    expect(context.speakableFactCards).toEqual([{ factId: FACT_PUBLIC, text: "矿坑里藏着密道" }]);
  });

  it("recentInteractions 只含选中 NPC 最近 5 条结构化交互", () => {
    const context = buildFocusNpcContext(makeRecord(), NPC_1);
    expect(context.recentInteractions).toHaveLength(5);
    expect(context.recentInteractions[0]?.actionId).toBe("act_1");
    expect(context.recentInteractions[4]?.actionId).toBe("act_5");
    // 条目只含规范化字段，绝不含玩家原话
    expect(context.recentInteractions[0]).toEqual({
      actionId: "act_1",
      dialogueAct: "support",
      topicSummary: "询问线索",
      outcome: "positive",
      summary: "再次交谈，support，气氛融洽，关系变化",
    });
  });

  it("绝不包含其他 NPC 的交互条目", () => {
    const context = buildFocusNpcContext(makeRecord(), NPC_1);
    const actionIds = context.recentInteractions.map((i) => i.actionId);
    expect(actionIds).not.toContain("guest_1");
  });

  it("thisTurn carries only the qualitative outcome", () => {
    const context = buildFocusNpcContext(makeRecord(), NPC_1);
    expect(context.thisTurn).toEqual({ outcome: "positive" });
    expect(JSON.stringify(context)).not.toMatch(/"relationshipDelta"\s*:/);
  });

  it("玩家原话绝不进入焦点上下文（含 JSON 序列化扫描）", () => {
    const context = buildFocusNpcContext(makeRecord(), NPC_1);
    const serialized = JSON.stringify(context);
    expect(serialized).not.toContain("矿坑的秘密吗");
  });

  it("未披露的私密事实正文绝不进入焦点上下文（含 JSON 序列化扫描）", () => {
    const context = buildFocusNpcContext(makeRecord(), NPC_1);
    const serialized = JSON.stringify(context);
    expect(serialized).not.toContain("老板年轻时犯下的旧案");
    expect(serialized).not.toContain("客人暗藏的一批私货");
    expect(context.speakableFactCards.map((f) => f.text)).not.toContain("老板年轻时犯下的旧案");
  });

  it("确定性：相同 record 两次调用产出完全一致", () => {
    const record = makeRecord();
    expect(buildFocusNpcContext(record, NPC_1)).toEqual(buildFocusNpcContext(record, NPC_1));
  });
});
