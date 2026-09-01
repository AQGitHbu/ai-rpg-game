import { describe, expect, it, vi } from "vitest";
import type { AiMessage } from "@ai-game/ai-transport";
import type { RpgAiClient } from "./rpgAiClient";
import { createNarrativeBundleSource } from "./liveNarrativeBundleSource";
import type { NarrativeBundleSourceContext } from "../../narrativeBundleSource";
import { createInitialWorldState, type WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import { projectEntityStore, type EntityCompatibilityProjection } from "@/game/domain/entity";
import { createInitialStoryState } from "@/game/domain/storyState";
import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import {
  asLocationId,
  asNpcId,
  asEnemyId,
  asFactId,
  asItemId,
  asGenerationId,
} from "@/game/domain/worldEntity";
import type { NpcMemory } from "@/game/domain/worldState";
import { asNarrativeJobId } from "@/game/domain/events";
import { createFixtureOpeningCandidateSource } from "../../createGame";
import { createWorldStateFixture } from "@/game/domain/testing/worldStateFixture.testutil";

function mockAiClient(complete: ReturnType<typeof vi.fn>): RpgAiClient {
  return {
    complete,
    policy: () => ({
      thinking: "off" as const,
      timeoutMs: 45_000,
      maxTokens: 5_000,
      jsonMode: "prompt_only" as const,
      maxAttempts: 1,
    }),
  };
}

function makeWorldState(): WorldState {
  return createInitialWorldState({
    generation: {
      generationId: asGenerationId("g1"),
      seed: "seed",
      templateVersion: "v1",
      inputDigest: "",
      gameType: "wuxia",
    },
    player: { name: "侠客", identity: "旅人", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: {
      id: asLocationId("loc_0"),
      name: "小镇",
      description: "山脚下的小镇。",
      kind: "main",
      connectedLocationIds: [],
      npcIds: [],
      availableItemIds: [],
      tags: [],
    },
    startingItemIds: [],
  });
}

function withProjection(base: WorldState, overrides: Partial<EntityCompatibilityProjection>): WorldState {
  const projection = { ...projectEntityStore(base.entityStore), ...overrides };
  return createWorldStateFixture({
    generation: base.generation,
    projection: {
      ...projection,
      locations: projection.locations.map((location) => ({
        ...location,
        npcIds: projection.npcs.filter((npc) => npc.locationId === location.id).map((npc) => npc.id),
      })),
    },
    battle: base.battle,
    endings: base.endings,
    ending: base.ending,
    eventLedger: base.eventLedger,
  });
}

function makeStoryState(): StoryState {
  return createInitialStoryState({
    initialNarrative: createFixtureNarrativeRuntimeState(),
    gameLength: "short",
    initialEntityCounts: { locations: 1, npcs: 0, quests: 1, events: 0 },
  });
}

function makeJob(): PendingNarrativeJob {
  return {
    jobId: asNarrativeJobId("job_1"),
    turnId: "turn_1" as never,
    actionId: "act_1",
    expectedRevision: 0,
    turnNumber: 1,
    actionSummary: { kind: "talk", npcId: asNpcId("npc_1") },
    utterance: undefined,
    resolvedEvent: {
      actionId: "act_1",
      status: "success",
      eventKind: "dialogue",
      facts: [],
      stateChanges: [],
      costs: [],
      rewards: [],
      triggeredEvents: [],
      rejectedEffects: [],
    },
    domainEventRange: { fromLedgerIndex: 0, toLedgerIndexExclusive: 1 },
    focusNpcId: asNpcId("npc_1"),
    requestedAt: "2026-01-02",
    objectiveTransition: { before: null, completed: [], after: null, mode: "unchanged" },
    mandatoryBeats: [],
    generationKind: "npc_fixed_choice",
    sceneRequestKind: "npc_response",
  } as unknown as PendingNarrativeJob;
}

const validBundleResponse = {
  worldDelta: null,
  currentScene: {
    segments: [{ beatId: "atmosphere", text: "场景旁白" }],
    npcLine: {
      npcId: "npc_1",
      text: "你来了。",
      emotion: "neutral",
      answeredBeatIds: [],
      usedFactIds: [],
      usedInteractionActionIds: [],
    },
    objectiveLink: null,
    choices: [
      { candidateId: "support", label: "表示赞同" },
      { candidateId: "challenge", label: "提出质疑" },
    ],
  },
  continuationScenes: [],
  terminal: { kind: "next_decision", target: { kind: "current_scene" } },
};

function makeNextActStoryState(): StoryState {
  return {
    ...makeStoryState(),
    currentAct: 2,
    evolution: { ...makeStoryState().evolution, status: "needs_next_act" },
  };
}

/** A next-act response whose provider scenes are positional and over-planned. */
function nextActOverPlanResponse(input: {
  readonly choicesAt: number;
  readonly totalScenes: number;
}): unknown {
  const stepKey = `move:loc_dyn_${makeStoryState().evolution.nextLocationOrdinal}`;
  const scene = (index: number) => ({
    segments: [{ beatId: `beat_${index}`, text: index === 0 ? "抵达新地点。" : `第 ${index} 段。` }],
    npcLine: null,
    objectiveLink: null,
    choices: index === input.choicesAt
      ? [{ candidateId: "wrong_1", label: "上前施礼" }, { candidateId: "wrong_2", label: "按住刀柄" }]
      : [],
  });
  return {
    worldDelta: null,
    currentScene: {
      segments: [{ beatId: "closing", text: "旧案指向镇外。" }],
      npcLine: null,
      objectiveLink: null,
      choices: [],
    },
    continuationScenes: Array.from({ length: input.totalScenes }, (_, index) => scene(index)),
    terminal: { kind: "next_decision", target: { kind: "continuation_step", stepKey } },
  };
}

describe("createNarrativeBundleSource", () => {
  it("calls aiClient.complete with narrative_bundle role exactly once", async () => {
    const complete = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify(validBundleResponse),
    });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete) });

    const context: NarrativeBundleSourceContext = {
      kind: "decision",
      worldState: makeWorldState(),
      storyState: makeStoryState(),
      job: makeJob(),
    };

    const result = await source.generate(context);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith(
      "narrative_bundle",
      expect.any(Array),
      expect.objectContaining({ purpose: "narrative_bundle_generation" }),
    );
    expect(result.ok).toBe(true);
  });

  it("compiles the production decision prompt with continuity context and a body-free audit manifest", async () => {
    const complete = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify(validBundleResponse),
    });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete) });
    const base = makeWorldState();
    const focusNpcId = asNpcId("npc_1");
    const privateFactId = asFactId("fact_private");
    const publicFactId = asFactId("fact_public");
    const interactionHistory = Array.from({ length: 5 }, (_, index) => ({
      turnNumber: index + 1,
      actionId: `interaction_${index + 1}`,
      locationId: asLocationId("loc_0"),
      dialogueAct: "support" as const,
      topicSummary: `话题${index + 1}`,
      outcome: "positive" as const,
      relationshipDelta: 1,
      learnedFactIds: [] as const,
      summary: `第${index + 1}次结构化交互`,
    }));
    const worldState = withProjection(base, {
      worldFacts: [
        { factId: publicFactId, text: "公开账册记录了商队去向。", source: "generated", discovered: true },
        { factId: privateFactId, text: "DO_NOT_LEAK_OTHER_NPC_SECRET", source: "generated", discovered: true },
      ],
      npcs: [{
        id: focusNpcId,
        name: "老掌柜",
        role: "客栈掌柜",
        description: "言辞谨慎，重视承诺。",
        locationId: asLocationId("loc_0"),
        isCompanion: false,
        tags: [],
        met: true,
        memory: {
          npcId: focusNpcId,
          knownFactIds: [publicFactId],
          hiddenFactIds: [privateFactId],
          interactionHistory,
          relationship: { affinity: 25 },
          emotion: "guarded",
          goals: ["查清商队失踪原因"],
        },
      }],
    });
    const storyState: StoryState = {
      ...makeStoryState(),
      currentAct: 2,
      tension: 55,
      nextPacingNeed: "complicate",
      recentBeats: [{ turn: 4, kind: "fact_discovered", summary: "玩家查到旧账册。" }],
      contract: {
        version: 1,
        targetActs: 3,
        centralConflict: "商队失踪牵出门派内应",
        endingDirections: [
          { key: "trust", theme: "与旧友共同揭露真相" },
          { key: "doubt", theme: "独自追查并承担代价" },
        ],
      },
    };

    await source.generate({
      kind: "decision",
      worldState,
      storyState,
      job: makeJob(),
    });

    const [, messages, auditContext] = complete.mock.calls[0]!;
    const systemPrompt = (messages as readonly AiMessage[])[0]!.content as string;
    expect(systemPrompt.startsWith("[NARRATIVE_CONTEXT v1]")).toBe(true);
    expect(systemPrompt).toContain("## [story_contract]");
    expect(systemPrompt).toContain("## [focus_character]");
    expect(systemPrompt).toContain("## [relevant_events]");
    expect(systemPrompt).toContain("## [output_contract]");
    expect(systemPrompt).toContain("商队失踪牵出门派内应");
    expect(systemPrompt).toContain("currentAct=2");
    expect(systemPrompt).toContain("tension=55");
    expect(systemPrompt).toContain("nextPacingNeed=complicate");
    expect(systemPrompt).toContain("玩家查到旧账册");
    expect(systemPrompt).toContain("anchors 五个字段都必需");
    expect(systemPrompt).toContain("horizon");
    expect(systemPrompt).toContain("capabilityBoundaries");
    expect(systemPrompt).not.toContain('goals":["..."]');
    for (let index = 1; index <= 5; index += 1) {
      expect(systemPrompt).toContain(`interaction_${index}`);
    }
    expect(systemPrompt).not.toContain("DO_NOT_LEAK_OTHER_NPC_SECRET");
    expect(auditContext).toEqual(expect.objectContaining({
      narrativeContext: expect.objectContaining({
        compilerVersion: 1,
        maxEstimatedTokens: 8_000,
        overflowEstimatedTokens: 0,
        selected: expect.arrayContaining([
          expect.objectContaining({ id: "bundle:rules" }),
          expect.objectContaining({ id: "bundle:output-contract" }),
        ]),
      }),
    }));
    expect(JSON.stringify((auditContext as { narrativeContext: unknown }).narrativeContext))
      .not.toContain("商队失踪牵出门派内应");
    expect(JSON.stringify((auditContext as { narrativeContext: unknown }).narrativeContext))
      .not.toContain("DO_NOT_LEAK_OTHER_NPC_SECRET");
  });

  it("tells the provider whether each existing item is carried or still available at a location", async () => {
    const complete = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify(validBundleResponse),
    });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete) });
    const base = makeWorldState();
    const carriedId = asItemId("item_carried");
    const groundId = asItemId("item_ground");
    const worldState = withProjection(base, {
      items: [
        { id: carriedId, name: "旧铜钱", description: "一枚旧铜钱。", kind: "clue", tags: [] },
        { id: groundId, name: "燕字铁牌拓片", description: "一张拓片。", kind: "clue", tags: [] },
      ],
      inventory: [carriedId],
      locations: [{ ...base.locations[0]!, availableItemIds: [groundId] }],
    });

    await source.generate({
      kind: "decision",
      worldState,
      storyState: makeStoryState(),
      job: makeJob(),
    });

    const messages = complete.mock.calls[0]![1] as readonly AiMessage[];
    const systemPrompt = messages[0]!.content as string;
    expect(systemPrompt).toContain("旧铜钱（item_carried）：一枚旧铜钱。；玩家持有");
    expect(systemPrompt).toContain("燕字铁牌拓片（item_ground）：一张拓片。；位于=loc_0");
    expect(systemPrompt).toContain("尚未拾取的物品只能被观察、发现或拾取");
    expect(systemPrompt).toContain("不得写成玩家已经持有、拿出或使用");
  });

  it("returns failure when AI client is unavailable", async () => {
    const source = createNarrativeBundleSource({});
    const result = await source.generate({
      kind: "decision",
      worldState: makeWorldState(),
      storyState: makeStoryState(),
      job: makeJob(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("AI_CALL_FAILED");
    }
  });

  it("returns failure when AI returns invalid JSON", async () => {
    const complete = vi.fn().mockResolvedValue({
      ok: true,
      content: "not json",
    });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete) });

    const result = await source.generate({
      kind: "decision",
      worldState: makeWorldState(),
      storyState: makeStoryState(),
      job: makeJob(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("AI_RESPONSE_INVALID");
    }
  });

  it("normalizes legacy decision presentation fields without inventing narrative text", async () => {
    const legacy = {
      ...validBundleResponse,
      currentScene: {
        ...validBundleResponse.currentScene,
        npcLine: "我知道一些内情。",
        objectiveLink: { questId: "旧任务名称", objectiveText: "旧格式的提示" },
        choices: [
          { candidateId: "support", text: "相信他。" },
          { candidateId: "challenge", text: "质疑他。" },
        ],
      },
    };
    const complete = vi.fn().mockResolvedValue({ ok: true, content: JSON.stringify(legacy) });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete) });

    const result = await source.generate({
      kind: "decision",
      worldState: makeWorldState(),
      storyState: makeStoryState(),
      job: makeJob(),
    });

    expect(result).toMatchObject({ ok: true, kind: "decision" });
    if (!result.ok || result.kind !== "decision") return;
    expect(result.proposal.currentScene.npcLine).toMatchObject({ npcId: "npc_1", text: "我知道一些内情。" });
    expect(result.proposal.currentScene.objectiveLink).toBeNull();
    expect(result.proposal.currentScene.choices.map((choice) => choice.label)).toEqual(["相信他。", "质疑他。"]);
  });

  it("returns failure when AI returns an error", async () => {
    const complete = vi.fn().mockResolvedValue({
      ok: false,
      code: "rate_limited",
    });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete) });

    const result = await source.generate({
      kind: "decision",
      worldState: makeWorldState(),
      storyState: makeStoryState(),
      job: makeJob(),
    });

    expect(result.ok).toBe(false);
  });

  it("prompt contains symbolic reference whitelist and step graph alignment rules", async () => {
    const complete = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify(validBundleResponse),
    });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete) });

    await source.generate({
      kind: "decision",
      worldState: makeWorldState(),
      storyState: makeStoryState(),
      job: makeJob(),
    });

    const call = complete.mock.calls[0]!;
    const messages = call[1] as readonly AiMessage[];
    const systemPrompt = messages[0]!.content as string;
    expect(systemPrompt).toContain("@new.location");
    expect(systemPrompt).toContain("@new.npc");
    expect(systemPrompt).toContain("必须与第 8 条投影的步骤完全一致");
    expect(systemPrompt).toContain("不得投影之外自行规划未来步骤");
    expect(systemPrompt).toContain("current_scene");
    expect(systemPrompt).toContain("continuation_step");
    expect(systemPrompt).toContain("禁止鬼魂");
  });

  it("includes typed NPC creation anchors, goals, and directed relationship seeds in the bundle contract", async () => {
    const complete = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify(validBundleResponse),
    });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete) });

    await source.generate({
      kind: "decision",
      worldState: makeWorldState(),
      storyState: makeStoryState(),
      job: makeJob(),
    });

    const systemPrompt = (complete.mock.calls[0]![1] as readonly AiMessage[])[0]!.content as string;
    expect(systemPrompt).toContain('"relationshipSeeds"');
    expect(systemPrompt).toContain('"targetNpcId"');
    expect(systemPrompt).toContain("只能引用实体规则闭包中的既有 active NPC");
    expect(systemPrompt).toContain("不得提交 affinity、stage、evidence 或 actionId");
  });

  it("rejects an invalid dynamic NPC creation shape before returning a bundle proposal", async () => {
    const complete = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify({
        ...validBundleResponse,
        worldDelta: {
          beatSummary: "补充一名有旧交的信使",
          newNpc: {
            name: "新信使",
            role: "传讯人",
            description: "带来旧案消息的传讯人。",
            locationRef: { kind: "existing", id: "loc_0" },
            anchors: {
              selfConcept: "守住旧案的传讯人",
              values: ["守诺"],
              speechStyle: "谨慎直接",
              capabilityBoundaries: ["只说亲见之事"],
              taboos: [],
            },
            goals: [{ horizon: "short", description: "送达消息", priority: 3, reason: "受人所托" }],
            relationshipSeeds: [{ targetNpcId: "npc_1", stance: "ally", reason: "旧日相助", stage: "trusted" }],
          },
        },
      }),
    });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete) });

    const result = await source.generate({
      kind: "decision",
      worldState: makeWorldState(),
      storyState: makeStoryState(),
      job: makeJob(),
    });

    expect(result).toMatchObject({ ok: false, failure: { kind: "AI_RESPONSE_INVALID" } });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("projects current location, focus NPC, previous scene, chosen option, beats and objectiveLink", async () => {
    const complete = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify(validBundleResponse),
    });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete) });

    const worldState = makeWorldState();
    const npcId = asNpcId("npc_1");
    const worldWithNpc = withProjection(worldState, {
      npcs: [{
        id: npcId,
        name: "老掌柜",
        role: "客栈掌柜",
        description: "精瘦的老掌柜。",
        locationId: asLocationId("loc_0"),
        isCompanion: false,
        tags: [],
        met: true,
        memory: {
          npcId,
          knownFactIds: [],
          hiddenFactIds: [],
          interactionHistory: [],
          relationship: { affinity: 0 },
          emotion: "neutral",
          goals: [],
        } as NpcMemory,
      }],
    });
    const readyNarrative = makeStoryState().narrative;
    if (readyNarrative.status !== "ready") throw new Error("expected ready fixture");
    const storyState: StoryState = {
      ...makeStoryState(),
      narrative: {
        status: "provider_pending",
        mode: "ai",
        job: makeJob(),
        lastPresentedScene: readyNarrative.currentScene,
      },
    };
    const job: PendingNarrativeJob = {
      ...makeJob(),
      selectedDialogue: { dialogueAct: "support", label: "出示令牌，请他行个方便。" },
      objectiveTransition: {
        before: null,
        completed: [],
        after: { questId: "quest_0" as never, objectiveIndex: 1, label: "与老掌柜交谈" },
        mode: "progressed",
      },
      mandatoryBeats: [
        { beatId: "quest_progress_0", kind: "quest_progress", subjectIds: ["quest_0"], instruction: "完成了任务目标" },
        { beatId: "atmosphere", kind: "atmosphere", subjectIds: [], instruction: "氛围描写（可选，放在最后）" },
      ],
    };

    await source.generate({ kind: "decision", worldState: worldWithNpc, storyState, job });

    const systemPrompt = (complete.mock.calls[0]![1] as readonly AiMessage[])[0]!.content as string;
    expect(systemPrompt).toContain("玩家当前位置：小镇");
    expect(systemPrompt).toContain("本回合对话焦点 NPC：老掌柜（npc_1");
    expect(systemPrompt).toContain("上一场景旁白：测试场景。");
    expect(systemPrompt).toContain("玩家选择了选项：“出示令牌，请他行个方便。”");
    expect(systemPrompt).toContain('beatId="quest_progress_0"');
    expect(systemPrompt).toContain("currentScene.segments 的 beatId 只能是下列之一");
    expect(systemPrompt).toContain('"questId":"quest_0","objectiveIndex":1,"mode":"progress"');
  });

  it("projects the post-expansion arrival graph for a next-act response", async () => {
    const complete = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify(validBundleResponse),
    });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete) });
    const storyState = {
      ...makeStoryState(),
      currentAct: 2,
      evolution: { ...makeStoryState().evolution, status: "needs_next_act" as const },
    };

    await source.generate({
      kind: "decision",
      worldState: makeWorldState(),
      storyState,
      job: makeJob(),
    });

    const messages = complete.mock.calls[0]![1] as readonly AiMessage[];
    const systemPrompt = messages[0]!.content as string;
    const locationId = `loc_dyn_${storyState.evolution.nextLocationOrdinal}`;
    const npcId = `npc_dyn_${storyState.evolution.nextNpcOrdinal}`;
    expect(systemPrompt).toContain(`move:${locationId}`);
    expect(systemPrompt).toContain(`move:${locationId}_choice_1`);
    expect(systemPrompt).toContain(npcId);
    expect(systemPrompt).toContain('"kind":"continuation_step"');
    expect(systemPrompt).not.toContain('terminal: {"kind":"ending"}');
  });

  it("把已占用实体名称交给 provider，新实体撞名会让整包被服务端拒绝", async () => {
    const complete = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify(validBundleResponse),
    });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete) });
    const base = makeWorldState();
    const npcMemory: NpcMemory = {
      npcId: asNpcId("npc_7"),
      knownFactIds: [],
      hiddenFactIds: [],
      interactionHistory: [],
      relationship: { affinity: 0 },
      emotion: "neutral",
      goals: [],
    };
    const worldState = withProjection(base, {
      locations: [...base.locations, {
        ...base.locations[0]!,
        id: asLocationId("loc_9"),
        name: "山涧密林",
      }],
      npcs: [{
        id: asNpcId("npc_7"),
        name: "灰衣老者",
        role: "守林人",
        description: "沉默的守林人。",
        locationId: asLocationId("loc_0"),
        isCompanion: false,
        tags: [],
        met: true,
        memory: npcMemory,
      }],
      enemies: [{
        id: asEnemyId("enemy_7"),
        name: "黑衣暗哨",
        tier: "normal",
        stats: { hp: 50, attack: 12, defense: 4 },
        locationId: asLocationId("loc_0"),
        tags: [],
      }],
    });

    await source.generate({
      kind: "decision",
      worldState,
      storyState: makeStoryState(),
      job: makeJob(),
    });

    const messages = complete.mock.calls[0]![1] as readonly AiMessage[];
    const systemPrompt = messages[0]!.content as string;
    expect(systemPrompt).toContain("已占用实体名称");
    expect(systemPrompt).toContain("- 地点：小镇、山涧密林");
    expect(systemPrompt).toContain("- NPC：灰衣老者");
    expect(systemPrompt).toContain("- 敌人：黑衣暗哨");
    expect(systemPrompt).toContain("世界内实体名称唯一");
  });

  it("修复重试会把服务端拒绝码与细分理由写进提示", async () => {
    const complete = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify(validBundleResponse),
    });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete) });

    await source.generate({
      kind: "decision",
      worldState: makeWorldState(),
      storyState: makeStoryState(),
      job: makeJob(),
      contentRepair: {
        attempt: 1,
        reason: "approval_rejected",
        rejectionCode: "world_delta_rejected",
        detail: "duplicate_name:enemy:蒙面劫匪|item:旧令牌",
      },
    });

    const messages = complete.mock.calls[0]![1] as readonly AiMessage[];
    const systemPrompt = messages[0]!.content as string;
    expect(systemPrompt).toContain("上一轮提案已被服务端拒绝");
    expect(systemPrompt).toContain("拒绝码 world_delta_rejected，细分原因 duplicate_name:enemy:蒙面劫匪|item:旧令牌");
    expect(systemPrompt).toContain("上一轮新enemy名称“蒙面劫匪”已与世界中现有实体重复");
    expect(systemPrompt).toContain("上一轮新item名称“旧令牌”已与世界中现有实体重复");
  });

  it("契约类失败只给细分原因时，提示会点名终点步骤与候选选项要求", async () => {
    const complete = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify(validBundleResponse),
    });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete) });

    await source.generate({
      kind: "decision",
      worldState: makeWorldState(),
      storyState: makeStoryState(),
      job: makeJob(),
      contentRepair: {
        attempt: 1,
        reason: "invalid_schema",
        detail: "terminal_step_requires_two_choices（步骤 battle_resolved:victory:enemy_dyn_3）",
      },
    });

    const messages = complete.mock.calls[0]![1] as readonly AiMessage[];
    const systemPrompt = messages[0]!.content as string;
    expect(systemPrompt).toContain("细分原因 terminal_step_requires_two_choices（步骤 battle_resolved:victory:enemy_dyn_3）");
    expect(systemPrompt).toContain("终点步骤（terminal.target.stepKey 指向的那一步）必须给出该步骤列出的全部 candidateId 选项");
  });

  it("normalizes a flattened next-act continuation without changing its text", async () => {
    const nextLocationOrdinal = makeStoryState().evolution.nextLocationOrdinal;
    const complete = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify({
        worldDelta: {
          beatSummary: "旧案指向镇外。",
          newLocation: { name: "枯柳驿", description: "荒废驿站。", scale: "scene", placement: "world", connectFromLocationId: "小镇" },
          newNpc: {
            name: "老驼子", role: "守夜人", description: "警惕的守夜人。", locationRef: { kind: "new_location" },
            anchors: { selfConcept: "守着旧案秘密的老人", values: ["守诺"], speechStyle: "低声而谨慎", capabilityBoundaries: ["只知道亲身见闻"], taboos: [] },
            goals: [{ horizon: "short", description: "守住秘密", priority: 3, reason: "旧案仍不能落入旁人之手" }],
            relationshipSeeds: [],
          },
          newItem: { name: "半块令牌", description: "断裂的令牌。", locationRef: "new_location" },
          newEnemy: { name: "蒙面劫匪", tier: "normal", locationRef: "new_location" },
          newFact: null,
          nextMainQuest: { name: "枯柳驿线索", description: "前往荒废驿站。", objectiveText: "调查枯柳驿" },
          endingPair: null,
        },
        currentScene: {
          segments: [{ beatId: "closing", text: "柳三娘递来一枚铜钱。" }],
          npcLine: { npcId: "npc_1", text: "去枯柳驿看看。", emotion: "warm", answeredBeatIds: [], usedFactIds: [], usedInteractionActionIds: [] },
          objectiveLink: { questId: "nextMainQuest", text: "旧格式" },
          choices: [],
        },
        continuationScenes: [{
          segments: [{ beatId: "arrival", text: "你抵达枯柳驿。" }],
          npcLine: { npcId: "npc_dyn_1", text: "来者何人？", emotion: "guarded", answeredBeatIds: [], usedFactIds: [], usedInteractionActionIds: [] },
          objectiveLink: { questId: "nextMainQuest", text: "旧格式" },
          choices: [
            { candidateId: "wrong_1", label: "表明身份" },
            { candidateId: "wrong_2", label: "先行试探" },
          ],
          terminal: { kind: "next_decision", target: { kind: "continuation_step", stepKey: "wrong" } },
        }],
        terminal: { kind: "next_decision", target: { kind: "continuation_step", stepKey: `move:loc_dyn_${nextLocationOrdinal}` } },
      }),
    });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete) });
    const storyState = {
      ...makeStoryState(),
      currentAct: 2,
      evolution: { ...makeStoryState().evolution, status: "needs_next_act" as const },
    };

    const result = await source.generate({
      kind: "decision",
      worldState: makeWorldState(),
      storyState,
      job: makeJob(),
    });

    expect(result).toMatchObject({ ok: true, kind: "decision" });
    if (!result.ok || result.kind !== "decision") return;
    const stepKey = `move:loc_dyn_${storyState.evolution.nextLocationOrdinal}`;
    expect(result.proposal.continuationScenes[0]).toMatchObject({
      stepKey,
      scene: {
        segments: [{ text: "你抵达枯柳驿。" }],
        objectiveLink: null,
        choices: [
          { candidateId: `${stepKey}_choice_1`, label: "表明身份" },
          { candidateId: `${stepKey}_choice_2`, label: "先行试探" },
        ],
      },
    });
    expect(result.proposal.worldDelta).toMatchObject({
      newLocation: { connectFromLocationId: "loc_0" },
    });
  });

  it("canonicalizes an ending terminal that carries an unnecessary target object", async () => {
    const complete = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify({
        worldDelta: { endingPair: [] },
        currentScene: {
          segments: [{ beatId: "closing", text: "旧案终有了结。" }],
          npcLine: null,
          objectiveLink: null,
          choices: [{ candidateId: "wrong", label: "多余选项" }],
        },
        continuationScenes: [],
        terminal: { kind: "ending", target: { kind: "current_scene" } },
      }),
    });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete) });
    const storyState: StoryState = {
      ...makeStoryState(),
      evolution: { ...makeStoryState().evolution, status: "needs_ending_pair" },
    };

    const result = await source.generate({
      kind: "decision",
      worldState: makeWorldState(),
      storyState,
      job: makeJob(),
    });

    expect(result).toMatchObject({ ok: true, kind: "decision" });
    if (!result.ok || result.kind !== "decision") return;
    expect(result.proposal.terminal).toEqual({ kind: "ending" });
    expect(result.proposal.currentScene.choices).toEqual([]);
    expect(result.proposal.continuationScenes).toEqual([]);
  });

  it("丢弃投影之外的过度规划步骤，只保留服务端投影的到达步骤", async () => {
    const stepKey = `move:loc_dyn_${makeStoryState().evolution.nextLocationOrdinal}`;
    const complete = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify(nextActOverPlanResponse({ choicesAt: 0, totalScenes: 13 })),
    });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete) });

    const result = await source.generate({
      kind: "decision",
      worldState: makeWorldState(),
      storyState: makeNextActStoryState(),
      job: makeJob(),
    });

    expect(result).toMatchObject({ ok: true, kind: "decision" });
    if (!result.ok || result.kind !== "decision") return;
    expect(result.proposal.continuationScenes).toHaveLength(1);
    expect(result.proposal.continuationScenes[0]).toMatchObject({
      stepKey,
      scene: {
        segments: [{ text: "抵达新地点。" }],
        choices: [
          { candidateId: `${stepKey}_choice_1`, label: "上前施礼" },
          { candidateId: `${stepKey}_choice_2`, label: "按住刀柄" },
        ],
      },
    });
  });

  it("终点两选项落在更靠后的场景时，把它对齐回投影的终点步骤", async () => {
    const stepKey = `move:loc_dyn_${makeStoryState().evolution.nextLocationOrdinal}`;
    const complete = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify(nextActOverPlanResponse({ choicesAt: 4, totalScenes: 13 })),
    });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete) });

    const result = await source.generate({
      kind: "decision",
      worldState: makeWorldState(),
      storyState: makeNextActStoryState(),
      job: makeJob(),
    });

    expect(result).toMatchObject({ ok: true, kind: "decision" });
    if (!result.ok || result.kind !== "decision") return;
    expect(result.proposal.continuationScenes).toHaveLength(1);
    expect(result.proposal.continuationScenes[0]).toMatchObject({
      stepKey,
      scene: {
        segments: [{ text: "第 4 段。" }],
        choices: [{ candidateId: `${stepKey}_choice_1` }, { candidateId: `${stepKey}_choice_2` }],
      },
    });
  });

  it("过度规划且没有任何终点选项时仍然拒绝，但回传细分契约原因与步骤", async () => {
    const stepKey = `move:loc_dyn_${makeStoryState().evolution.nextLocationOrdinal}`;
    const complete = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify(nextActOverPlanResponse({ choicesAt: -1, totalScenes: 13 })),
    });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete) });

    const result = await source.generate({
      kind: "decision",
      worldState: makeWorldState(),
      storyState: makeNextActStoryState(),
      job: makeJob(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.repairReason).toBe("invalid_schema");
    expect(result.repairDetail).toBe(`terminal_step_requires_two_choices（步骤 ${stepKey}）`);
  });

  it("parses an opening proposal and emits the initialization audit link", async () => {
    const opening = await createFixtureOpeningCandidateSource().generate({
      gameType: "wuxia",
      gameLength: "short",
      seed: "opening-live-source",
    });
    const complete = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify({
        opening,
        currentScene: {
          segments: [{ beatId: "opening", text: "客栈里风声低沉。" }],
          npcLine: {
            npcId: "npc_0",
            text: "我等你很久了。",
            emotion: "guarded",
            answeredBeatIds: [],
            usedFactIds: ["fact_0"],
            usedInteractionActionIds: [],
          },
          objectiveLink: null,
          choices: [
            { candidateId: "support", label: "我愿意帮忙。" },
            { candidateId: "challenge", label: "先说清楚缘由。" },
          ],
        },
        continuationScenes: [],
        terminal: { kind: "next_decision", target: { kind: "current_scene" } },
      }),
    });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete) });

    const result = await source.generate({
      kind: "opening",
      jobId: asNarrativeJobId("job-opening"),
      input: { gameType: "wuxia", gameLength: "short", seed: "opening-live-source" },
      auditLink: { gameId: "game-opening", traceId: "trace-opening" },
    });

    expect(result).toMatchObject({ ok: true, kind: "opening" });
    expect(complete).toHaveBeenCalledWith(
      "narrative_bundle",
      expect.any(Array),
      expect.objectContaining({
        purpose: "narrative_bundle_generation",
        trigger: "initialization",
        gameId: "game-opening",
        traceId: "trace-opening",
        jobId: "job-opening",
        turnNumber: 0,
      }),
    );
    const prompt = (complete.mock.calls[0]![1] as readonly AiMessage[])[0]!.content as string;
    expect(prompt).toContain("backgroundSummary");
    expect(prompt).toContain('"targetActs": 3');
    expect(prompt).toContain('"scale": "town"');
  });

  it("requires opening NPC anchors and typed goal proposals without normalizer defaults", async () => {
    const opening = await createFixtureOpeningCandidateSource().generate({
      gameType: "wuxia",
      gameLength: "short",
      seed: "opening-live-contract",
    });
    const payload = JSON.parse(JSON.stringify({
      opening,
      currentScene: {
        segments: [{ beatId: "opening", text: "客栈里风声低沉。" }],
        npcLine: { npcId: "npc_0", text: "我等你很久了。", emotion: "guarded", answeredBeatIds: [], usedFactIds: [], usedInteractionActionIds: [] },
        objectiveLink: null,
        choices: [{ candidateId: "support", label: "我愿意帮忙。" }, { candidateId: "challenge", label: "先说清楚缘由。" }],
      },
      continuationScenes: [],
      terminal: { kind: "next_decision", target: { kind: "current_scene" } },
    })) as { opening: { opening: { npc: Record<string, unknown> } } };
    delete payload.opening.opening.npc.anchors;
    delete payload.opening.opening.npc.goals;
    const complete = vi.fn().mockResolvedValue({ ok: true, content: JSON.stringify(payload) });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete) });

    const result = await source.generate({
      kind: "opening",
      jobId: asNarrativeJobId("job-opening-contract"),
      input: { gameType: "wuxia", gameLength: "short", seed: "opening-live-contract" },
    });

    expect(result).toMatchObject({ ok: false, failure: { kind: "AI_RESPONSE_INVALID" } });
    expect(complete).toHaveBeenCalledTimes(1);
    const prompt = (complete.mock.calls[0]![1] as readonly AiMessage[])[0]!.content as string;
    for (const field of ["selfConcept", "values", "speechStyle", "capabilityBoundaries", "taboos", "horizon", "description", "priority", "reason"]) {
      expect(prompt).toContain(`\"${field}\"`);
    }
    expect(prompt).not.toContain('"goals": ["..."]');
  });
});
