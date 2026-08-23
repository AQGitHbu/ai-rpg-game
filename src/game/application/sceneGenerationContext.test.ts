import { describe, it, expect } from "vitest";
import {
  buildSceneGenerationContext,
  type SceneGenerationContext,
} from "./sceneGenerationContext";
import { buildStylePolicy } from "./stylePolicy";
import {
  createInitialWorldState,
  appendNpc,
  appendLocation,
  type LocationEntry,
  type NpcEntry,
  type NpcInteraction,
} from "@/game/domain/worldState";
import { createInitialStoryState, type StoryState } from "@/game/domain/storyState";
import {
  asLocationId,
  asNpcId,
  asGenerationId,
  asFactId,
} from "@/game/domain/worldEntity";
import { asNarrativeJobId, asTurnId } from "@/game/domain/events";
import { createPendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import type { PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import type { MandatoryNarrativeBeat, ObjectiveTransition } from "@/game/domain/narrativeBeat";
import { asItemId, asQuestId } from "@/game/domain/worldEntity";
import type { GameRecord } from "./server/persistence/gameRepository";
import { projectGameSessionView } from "./gameSessionView";

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

function makeJob(overrides: {
  transition?: ObjectiveTransition;
  beats?: readonly MandatoryNarrativeBeat[];
  summary?: PendingNarrativeJob["actionSummary"];
  focusNpcId?: string;
  utterance?: string;
} = {}): PendingNarrativeJob {
  const result = createPendingNarrativeJob({
    jobId: asNarrativeJobId("job_1"),
    turnId: asTurnId("turn_1"),
    actionId: IMPORTANT_ACTION_ID,
    expectedRevision: 0,
    turnNumber: 1,
    actionSummary: overrides.summary ?? { kind: "move", locationId: asLocationId("loc_2") },
    utterance: overrides.utterance,
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
    focusNpcId: overrides.focusNpcId !== undefined ? asNpcId(overrides.focusNpcId) : undefined,
    requestedAt: "2026-01-02",
    objectiveTransition: overrides.transition ?? { before: null, completed: [], after: null, mode: "unchanged" },
    mandatoryBeats: overrides.beats ?? [],
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

function makeRecord(withJob = true, job?: PendingNarrativeJob, world?: ReturnType<typeof makeWorld>): GameRecord {
  const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 2, npcs: 1, quests: 0, events: 0 } });
  const storyState: StoryState = withJob
    ? { ...ss, narrative: { ...ss.narrative, generation: { status: "pending", job: job ?? makeJob() } } }
    : ss;
  return {
    gameId: "g1" as never,
    worldState: world ?? makeWorld(),
    storyState,
    revision: 0,
    createdAt: "2026-01-01",
  };
}

/** 主线任务（已交谈后）：当前权威目标 = 获取盟誓印谱。 */
function makeQuestWorld(met = true): ReturnType<typeof makeWorld> {
  const base = makeWorld();
  return {
    ...base,
    npcs: base.npcs.map((n) => (n.id === asNpcId("npc_1") ? { ...n, met } : n)),
    quests: [{
      id: asQuestId("quest_0"),
      name: "查明真相",
      description: "查清矿坑的真相",
      objectives: [
        { kind: "talk_to_npc", npcId: asNpcId("npc_1") },
        { kind: "obtain_item", itemId: asItemId("item_seal") },
      ],
      onSuccess: { kind: "advance_story" },
      onFailure: { kind: "closed" },
      tags: [],
      kind: "main",
      stage: 1,
      status: "active",
    }],
    items: [{ id: asItemId("item_seal"), name: "盟誓印谱", description: "刻着盟约的印谱", kind: "quest", tags: [] }],
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
      recentInteractionSummaries: [], recentInteractionActionIds: [],
      relationship: { affinity: 0 }, emotion: "neutral",
      goals: [], forbiddenKnowledgeIds: [],
    }]);
    expect(context.story.currentAct).toBe(1);
    expect(context.story.targetActs).toBe(3);
    expect(context.story.tension).toBe(30);
    expect(context.story.nextPacingNeed).toBe("reveal");
    expect(context.legalActionCandidates.some((c) => c.kind === "move")).toBe(true);
  });

  it("story.stylePolicy 由开局配置的呈现字段映射而来（缺省 = 默认政策）", () => {
    const context = buildSceneGenerationContext(makeRecord());
    expect(context.story.stylePolicy).toEqual(buildStylePolicy());
  });

  it("story.stylePolicy 携带开局配置的标签/叙事风格/内容强度并只含呈现字段", () => {
    const world = makeWorld();
    const worldWithSetup = {
      ...world,
      generation: {
        ...world.generation,
        setup: {
          characterName: "侠客",
          characterIdentity: "剑客",
          personalityTags: ["冷静", "多疑"],
          worldPremise: "旧盟约正在瓦解。",
          storyOpening: "主角在客栈醒来。",
          narrativeStyle: "cinematic" as const,
          contentIntensity: "dark" as const,
        },
      },
    };
    const record = { ...makeRecord(), worldState: worldWithSetup };
    const context = buildSceneGenerationContext(record);
    expect(context.story.stylePolicy).toEqual(buildStylePolicy({
      personalityTags: ["冷静", "多疑"],
      narrativeStyle: "cinematic",
      contentIntensity: "dark",
    }));
    // 呈现政策不进入规则字段
    expect(JSON.stringify(context.story.stylePolicy)).not.toMatch(/"stats"|"attack"|"hp"|"rewards"|"budget"/);
  });

  it("never receives the whole record: a GameRecord is not assignable to the context type", () => {
    const record = makeRecord();
    // @ts-expect-error SceneSource must not receive the full record
    acceptContext(record);
    const context = buildSceneGenerationContext(record);
    // @ts-expect-error full candidate pool must not leak into the context type
    void context.story.candidateEventPool;
  });

  it("context JSON carries no eventLedger / candidateEventPool / worldFacts secret text", () => {
    const record = makeRecord();
    const context = buildSceneGenerationContext(record);
    const serialized = JSON.stringify(context);
    expect(serialized).not.toContain("eventLedger");
    expect(serialized).not.toContain("candidateEventPool");
    expect(serialized).not.toContain("worldFacts");
  });

  it("projects the minimal story contract without leaking future-facing story state", () => {
    const base = makeRecord();
    const record = {
      ...base,
      storyState: {
        ...base.storyState,
        contract: {
          ...base.storyState.contract,
          centralConflict: "镖银失踪牵出门派内应",
          endingDirections: [
            { key: "trust", theme: "与旧友共同揭露真相" },
            { key: "doubt", theme: "独自追查并承担代价" },
          ] as const,
        },
      },
    };
    const context = buildSceneGenerationContext(record);
    expect(context.story.contract).toEqual({
      centralConflict: "镖银失踪牵出门派内应",
      endingDirections: [
        { key: "trust", theme: "与旧友共同揭露真相" },
        { key: "doubt", theme: "独自追查并承担代价" },
      ],
    });
    expect(JSON.stringify(context.story.contract)).not.toMatch(/futureEntity|eventLedger|hiddenFactIds/);
  });

  it("is deterministic: same record produces an identical context", () => {
    const contextA = buildSceneGenerationContext(makeRecord());
    const contextB = buildSceneGenerationContext(makeRecord());
    expect(contextA).toEqual(contextB);
  });

  it("active battle 只投影两个可执行 battle_action 候选", () => {
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

  // ── Task 4：把规则结果/目标转换投影给场景源 ──────────────────────────────

  it("context 投影 job 的目标转换，但 after 以持久化状态的权威当前目标为准", () => {
    const transition: ObjectiveTransition = {
      before: { questId: asQuestId("quest_0"), objectiveIndex: 0, label: "与客栈老板交谈" },
      completed: [{ questId: asQuestId("quest_0"), objectiveIndex: 0, label: "与客栈老板交谈" }],
      after: { questId: asQuestId("quest_0"), objectiveIndex: 1, label: "获取盟誓印谱" },
      mode: "progressed",
    };
    const beats: readonly MandatoryNarrativeBeat[] = [
      { beatId: "quest_0", kind: "quest_progress", subjectIds: ["quest_0"], instruction: "完成了目标：与客栈老板交谈" },
      { beatId: "item_0", kind: "item_obtained", subjectIds: ["item_seal"], instruction: "获得物品「盟誓印谱」" },
    ];
    const record = makeRecord(true, makeJob({ transition, beats }), makeQuestWorld());
    const context = buildSceneGenerationContext(record);
    expect(context.objectiveTransition.after).toEqual({ questId: asQuestId("quest_0"), objectiveIndex: 1, label: "获取盟誓印谱" });
    expect(context.objectiveTransition.before).toEqual(transition.before);
    expect(context.objectiveTransition.completed).toEqual(transition.completed);
    expect(context.objectiveTransition.mode).toBe("progressed");
    expect(context.mandatoryBeats).toEqual(beats);
    expect(context.story.activeQuest).toEqual({
      questId: "quest_0",
      name: "查明真相",
      description: "查清矿坑的真相",
      objectiveIndex: 1,
      objectiveLabel: "获取盟誓印谱",
      objectiveKind: "obtain_item",
    });
  });

  it("幕边界：job 快照 after 为空时，after 修正为已具象化的下一幕目标", () => {
    const transition: ObjectiveTransition = {
      before: { questId: asQuestId("quest_0"), objectiveIndex: 0, label: "与客栈老板交谈" },
      completed: [],
      after: null,
      mode: "advanced_act",
    };
    const record = makeRecord(true, makeJob({ transition }), makeQuestWorld());
    const context = buildSceneGenerationContext(record);
    expect(context.objectiveTransition.mode).toBe("advanced_act");
    expect(context.objectiveTransition.after?.label).toBe("获取盟誓印谱");
  });

  it("beatSubjects 从持久化状态解析节拍引用的实体描述（item_seal → 盟誓印谱）", () => {
    const beats: readonly MandatoryNarrativeBeat[] = [
      { beatId: "item_0", kind: "item_obtained", subjectIds: ["item_seal"], instruction: "获得物品「盟誓印谱」" },
      { beatId: "quest_0", kind: "quest_progress", subjectIds: ["quest_0"], instruction: "完成了目标" },
    ];
    const record = makeRecord(true, makeJob({ beats }), makeQuestWorld());
    const context = buildSceneGenerationContext(record);
    const itemSubject = context.beatSubjects.find((s) => s.id === "item_seal");
    expect(itemSubject).toEqual({ id: "item_seal", kind: "item", name: "盟誓印谱", description: "刻着盟约的印谱" });
    const questSubject = context.beatSubjects.find((s) => s.id === "quest_0");
    expect(questSubject).toEqual({ id: "quest_0", kind: "quest", name: "查明真相", description: "查清矿坑的真相" });
  });

  it("HUD 与场景上下文投影同一个 after.label（同源持久化状态）", () => {
    const record = makeRecord(true, makeJob({
      transition: {
        before: { questId: asQuestId("quest_0"), objectiveIndex: 0, label: "与客栈老板交谈" },
        completed: [{ questId: asQuestId("quest_0"), objectiveIndex: 0, label: "与客栈老板交谈" }],
        after: { questId: asQuestId("quest_0"), objectiveIndex: 1, label: "获取盟誓印谱" },
        mode: "progressed",
      },
    }), makeQuestWorld());
    const context = buildSceneGenerationContext(record);
    const view = projectGameSessionView(record.worldState, record.storyState, record.revision, "test-ending-session");
    expect(context.objectiveTransition.after?.label).toBe("获取盟誓印谱");
    expect(view.story.currentObjectiveLabel).toBe("获取盟誓印谱");
    expect(view.story.currentObjectiveLabel).toBe(context.objectiveTransition.after?.label);
  });

  // ── Task 4：调查方式投影（approach labels + 已结算结果）──────────────────

  function makeInvestigateRecord(): GameRecord {
    const world = makeWorld();
    const fact = {
      factId: asFactId("fact_trace"),
      text: "泥地上有两行车辙",
      source: "generated" as const,
      discovered: false,
      locationId: asLocationId("loc_1"),
      investigationLabel: "泥地上的异常痕迹",
      investigationApproaches: [
        { approachId: "follow", label: "沿痕迹追查", evidenceQuality: "clean" as const, tensionDelta: 4 },
        { approachId: "search", label: "翻查附近杂物", hint: "动静较大", evidenceQuality: "noisy" as const, tensionDelta: 12 },
      ],
    };
    const quest = {
      id: asQuestId("quest_discover"),
      name: "查明真相",
      description: "查清车辙的来历",
      objectives: [{ kind: "discover_fact" as const, factId: fact.factId }],
      onSuccess: { kind: "advance_story" as const },
      onFailure: { kind: "closed" as const },
      tags: [],
      kind: "main" as const,
      stage: 1,
      status: "active" as const,
    };
    const worldWithInvestigation = {
      ...world,
      worldFacts: [fact],
      quests: [quest],
      eventLedger: [
        ...world.eventLedger,
        { type: "fact_discovered" as const, factId: fact.factId, occurredAt: "2026-01-02", approachId: "search", evidenceQuality: "noisy" as const, tensionDelta: 12 },
      ],
    };
    const job = makeJob({
      summary: { kind: "investigate", factId: fact.factId },
      transition: { before: null, completed: [], after: { questId: quest.id, objectiveIndex: 0, label: "查明真相" }, mode: "unchanged" },
      beats: [{ beatId: "fact_discovered_0", kind: "fact_discovered", subjectIds: [String(fact.factId)], instruction: `发现了线索：${fact.text}` }],
    });
    return makeRecord(true, job, worldWithInvestigation);
  }

  it("当前 discover_fact 目标提供安全的 approach labels 与结果表现约束（不含事实正文）", () => {
    const context = buildSceneGenerationContext(makeInvestigateRecord());
    expect(context.currentInvestigationApproaches).toEqual([
      { approachId: "follow", label: "沿痕迹追查", evidenceQuality: "clean", tensionDelta: 4 },
      { approachId: "search", label: "翻查附近杂物", hint: "动静较大", evidenceQuality: "noisy", tensionDelta: 12 },
    ]);
    const serialized = JSON.stringify(context.currentInvestigationApproaches);
    expect(serialized).not.toContain("泥地上有两行车辙");
    expect(serialized).not.toContain("fact_trace");
  });

  it("investigate job 从 eventLedger 范围内解析已结算的 approach/evidence 结果", () => {
    const context = buildSceneGenerationContext(makeInvestigateRecord());
    expect(context.resolvedInvestigation).toEqual({
      factId: asFactId("fact_trace"),
      approachId: "search",
      approachLabel: "翻查附近杂物",
      evidenceQuality: "noisy",
      tensionDelta: 12,
    });
    const serialized = JSON.stringify(context.resolvedInvestigation);
    expect(serialized).not.toContain("泥地上有两行车辙");
    expect(serialized).not.toContain("follow");
  });

  it("非 investigate 行动不投影 resolvedInvestigation，approach-less 事实不投影 approach labels", () => {
    const context = buildSceneGenerationContext(makeRecord());
    expect(context.resolvedInvestigation).toBeUndefined();
    expect(context.currentInvestigationApproaches).toBeUndefined();
  });

  // ── Task 5：焦点 NPC 隔离上下文 ─────────────────────────────────────────

  it("talk 行动投影 focusNpcContext（焦点 NPC 政策 + 本轮关系结果）", () => {
    const record = makeRecord(true, makeJob({
      summary: { kind: "talk", npcId: asNpcId("npc_1") },
      focusNpcId: "npc_1",
      utterance: "你知道矿坑的密道吗？",
    }), makeQuestWorld());
    const context = buildSceneGenerationContext(record);
    expect(context.focusNpcContext).toBeDefined();
    expect(context.focusNpcContext?.id).toBe(asNpcId("npc_1"));
    expect(context.focusNpcContext?.responsePolicy.tier).toBe("neutral"); // affinity 0
    expect(context.focusNpcContext?.responsePolicy.initiative).toBe("reactive");
    expect(context.focusNpcContext?.emotion).toBe("neutral");
    // talk job 无 interaction → 本轮默认 neutral/0
    expect(context.focusNpcContext?.thisTurn).toEqual({ relationshipDelta: 0, outcome: "neutral" });
  });

  it("focusNpcContext 不含玩家原话、其他 NPC 交互或私密事实正文", () => {
    const world = makeQuestWorld();
    const secretB = asFactId("fact_secret_b");
    const npcB: NpcEntry = {
      id: asNpcId("npc_2"), name: "客人", role: "酒客", description: "沉默的客人",
      locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: true,
      memory: {
        npcId: asNpcId("npc_2"),
        knownFactIds: [secretB],
        hiddenFactIds: [secretB],
        interactionHistory: [{
          turnNumber: 1, actionId: "guest_1", locationId: asLocationId("loc_1"),
          dialogueAct: "ask", topic: { kind: "general" }, topicSummary: "闲谈",
          outcome: "positive", relationshipDelta: 1, learnedFactIds: [],
          summary: "客人的交谈",
        }],
        relationship: { affinity: 5 }, emotion: "neutral", goals: [],
      },
    };
    const bossHistory: NpcInteraction = {
      turnNumber: 9, actionId: IMPORTANT_ACTION_ID, locationId: asLocationId("loc_1"),
      dialogueAct: "ask", topic: { kind: "fact", factId: secretB }, topicSummary: "询问线索",
      outcome: "negative", relationshipDelta: -2, learnedFactIds: [],
      summary: "再次交谈，ask，氛围紧张，关系-2",
    };
    const boss = world.npcs.find((n) => n.id === asNpcId("npc_1"))!;
    const worldWithNpcB = {
      ...world,
      npcs: [
        { ...boss, memory: { ...boss.memory, interactionHistory: [bossHistory] } },
        npcB,
      ],
      worldFacts: [
        ...world.worldFacts,
        { factId: secretB, text: "客人暗藏私货", source: "generated" as const, discovered: false, locationId: asLocationId("loc_1") },
      ],
    };
    const record = makeRecord(true, makeJob({
      summary: { kind: "talk", npcId: asNpcId("npc_1") },
      focusNpcId: "npc_1",
      utterance: "你知道矿坑的密道吗？",
    }), worldWithNpcB);
    const context = buildSceneGenerationContext(record);
    const serialized = JSON.stringify(context.focusNpcContext);
    expect(serialized).not.toContain("你知道矿坑的密道吗"); // 无玩家原话
    expect(serialized).not.toContain("客人的交谈"); // 无其他 NPC 交互
    expect(serialized).not.toContain("客人暗藏私货"); // 无私密正文
    expect(context.focusNpcContext?.recentInteractions).toHaveLength(1);
    expect(context.focusNpcContext?.recentInteractions[0]?.actionId).toBe(IMPORTANT_ACTION_ID);
    // 本轮 delta/outcome 来自 actionId 匹配的 interaction
    expect(context.focusNpcContext?.thisTurn).toEqual({ relationshipDelta: -2, outcome: "negative" });
  });
});
