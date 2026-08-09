import { describe, it, expect } from "vitest";
import {
  buildSceneGenerationContext,
  type SceneGenerationContext,
} from "./sceneGenerationContext";
import {
  createInitialWorldState,
  appendNpc,
  appendLocation,
  type LocationEntry,
  type NpcEntry,
} from "@/game/domain/worldState";
import { createInitialStoryState, type StoryState } from "@/game/domain/storyState";
import {
  asLocationId,
  asNpcId,
  asGenerationId,
  asFactId,
} from "@/game/domain/scenarioBlueprint";
import { asNarrativeJobId, asTurnId } from "@/game/domain/events";
import { createPendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import type { PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import type { GameRecordV2 } from "./server/persistence/gameRepositoryV2";

const loc1: LocationEntry = {
  id: asLocationId("loc_1"), name: "客栈", description: "一间简朴的客栈", kind: "main",
  connectedLocationIds: [asLocationId("loc_2")], npcIds: [asNpcId("npc_1")], availableItemIds: [], tags: [],
};
const loc2: LocationEntry = {
  id: asLocationId("loc_2"), name: "街道", description: "一条热闹的街道", kind: "main",
  connectedLocationIds: [asLocationId("loc_1")], npcIds: [], availableItemIds: [], tags: [],
};
const npc1: NpcEntry = {
  id: asNpcId("npc_1"), name: "客栈老板", role: "路人", description: "热情的老板",
  locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
  memory: { npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
};

const IMPORTANT_ACTION_ID = "act_persist";

function makeJob(): PendingNarrativeJob {
  const result = createPendingNarrativeJob({
    jobId: asNarrativeJobId("job_1"),
    turnId: asTurnId("turn_1"),
    actionId: IMPORTANT_ACTION_ID,
    expectedRevision: 0,
    turnNumber: 1,
    actionSummary: { kind: "move", locationId: asLocationId("loc_2") },
    resolvedEvent: {
      actionId: IMPORTANT_ACTION_ID,
      status: "success",
      eventKind: "travel",
      facts: [],
      stateChanges: [],
      costs: [],
      rewards: [],
      triggeredEvents: [],
      rejectedEffects: [],
    },
    domainEventRange: { fromLedgerIndex: 1, toLedgerIndexExclusive: 2 },
    requestedAt: "2026-01-02",
  });
  if (!result.ok) throw new Error("fixture job 构造失败");
  return result.job;
}

function makeWorld(): ReturnType<typeof createInitialWorldState> {
  const base = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "侠客", identity: "剑客", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: loc1,
    startingItemIds: [],
  });
  const withNpc = appendNpc(appendLocation(base, loc2), npc1);
  return { ...withNpc, unlockedLocationIds: [asLocationId("loc_1"), asLocationId("loc_2")] };
}

function makeRecord(withJob = true): GameRecordV2 {
  const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 2, npcs: 1, quests: 0, events: 0 } });
  const storyState: StoryState = withJob
    ? { ...ss, narrative: { ...ss.narrative, generation: { status: "pending", job: makeJob() } } }
    : ss;
  return {
    gameId: "g1" as never,
    worldState: makeWorld(),
    storyState,
    revision: 0,
    createdAt: "2026-01-01",
  };
}

function acceptContext(_context: SceneGenerationContext): void {}

describe("buildSceneGenerationContext", () => {
  it("copies the pending job and derives current location, present NPCs and story hints", () => {
    const record = makeRecord();
    const context = buildSceneGenerationContext(record);
    const generation = record.storyState.narrative.generation;
    expect(context.job).toEqual(generation.status === "pending" ? generation.job : undefined);
    expect(context.currentLocation).toEqual({
      id: loc1.id, name: loc1.name, description: loc1.description, kind: "main",
    });
    expect(context.presentNpcs).toEqual([{
      id: npc1.id, name: npc1.name, role: npc1.role, publicProfile: npc1.description,
      knownFactCards: [], hiddenFactCards: [], sceneVisibleFactIds: [],
      recentInteractionSummaries: [], relationship: { affinity: 0 }, emotion: "neutral",
      goals: [], forbiddenKnowledgeIds: [],
    }]);
    expect(context.story.currentAct).toBe(1);
    expect(context.story.targetActs).toBe(3);
    expect(context.story.tension).toBe(30);
    expect(context.story.nextPacingNeed).toBe("reveal");
    expect(context.legalActionCandidates.some((c) => c.kind === "move")).toBe(true);
  });

  it("never receives the whole record: a GameRecordV2 is not assignable to the context type", () => {
    const record = makeRecord();
    // @ts-expect-error SceneSource must not receive the full record
    acceptContext(record);
    const context = buildSceneGenerationContext(record);
    // @ts-expect-error full candidate pool must not leak into the context type
    context.story.candidateEventPool;
  });

  it("context JSON carries no eventLedger / candidateEventPool / worldFacts secret text", () => {
    const record = makeRecord();
    const context = buildSceneGenerationContext(record);
    const serialized = JSON.stringify(context);
    expect(serialized).not.toContain("eventLedger");
    expect(serialized).not.toContain("candidateEventPool");
    expect(serialized).not.toContain("worldFacts");
  });

  it("is deterministic: same record produces an identical context", () => {
    const contextA = buildSceneGenerationContext(makeRecord());
    const contextB = buildSceneGenerationContext(makeRecord());
    expect(contextA).toEqual(contextB);
  });

  it("active battle 只投影三个可执行 battle_action 候选", () => {
    const record = makeRecord();
    const context = buildSceneGenerationContext({
      ...record,
      worldState: {
        ...record.worldState,
        battle: { status: "active", enemyId: "enemy_1" as never, playerHp: 80, enemyHp: 30, round: 2 },
      },
    });
    expect(context.legalActionCandidates).toEqual([
      { kind: "battle_action", label: "攻击", targetId: "attack" },
      { kind: "battle_action", label: "防守", targetId: "guard" },
      { kind: "battle_action", label: "撤退", targetId: "flee" },
    ]);
  });

  it("NPC 最小权限：焦点 NPC context 不含其他 NPC 私密事实正文", () => {
    const world = makeWorld();
    const secretA = { factId: asFactId("fact_secret_a"), text: "老板的秘密A", source: "generated" as const, discovered: false };
    const secretB = { factId: asFactId("fact_secret_b"), text: "客人的秘密B", source: "generated" as const, discovered: false };
    const npcA = { ...npc1, name: "老板", memory: { ...npc1.memory, hiddenFactIds: [asFactId("fact_secret_a")] } };
    const npcB: NpcEntry = {
      id: asNpcId("npc_2"), name: "客人", role: "酒客", description: "沉默的客人",
      locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: true,
      memory: { npcId: asNpcId("npc_2"), knownFactIds: [], hiddenFactIds: [asFactId("fact_secret_b")], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
    };
    const worldWithSecrets = {
      ...world,
      npcs: [npcA, npcB],
      worldFacts: [secretA, secretB],
    };
    const record = { ...makeRecord(), worldState: worldWithSecrets };
    const context = buildSceneGenerationContext(record);
    const npcAContext = context.presentNpcs.find((n) => String(n.id) === "npc_1")!;
    const npcBContext = context.presentNpcs.find((n) => String(n.id) === "npc_2")!;
    const serialized = JSON.stringify(context);
    // npcA 的私密事实正文只出现在 npcA 自己的 hiddenFactCards，不出现在 npcB context / 全局文本
    expect(npcAContext.hiddenFactCards.map((f) => f.text)).toContain("老板的秘密A");
    expect(npcAContext.hiddenFactCards.map((f) => f.text)).not.toContain("客人的秘密B");
    expect(npcBContext.hiddenFactCards.map((f) => f.text)).toContain("客人的秘密B");
    expect(npcBContext.hiddenFactCards.map((f) => f.text)).not.toContain("老板的秘密A");
    // 序列化后只出现各自秘密一次（无全局 publicWorldFacts 泄漏文本）
    expect(serialized.split("老板的秘密A").length - 1).toBe(1);
    expect(serialized.split("客人的秘密B").length - 1).toBe(1);
  });
});
