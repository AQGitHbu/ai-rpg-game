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
  PLAYER_ENTITY_ID,
} from "@/game/domain/worldEntity";
import type { NpcMemory } from "@/game/domain/worldState";
import { asNarrativeJobId, asEventId, asTurnId } from "@/game/domain/events";
import { makeCommittedEvent } from "@/game/domain/testing/committedEventFactory";
import { rebuildEpisodicMemory } from "@/game/domain/episodicMemory";
import { createFixtureOpeningCandidateSource } from "../../createGame";
import { createWorldStateFixture } from "@/game/domain/testing/worldStateFixture.testutil";
import { NARRATIVE_BUNDLE_CONTEXT_MAX_ESTIMATED_TOKENS } from "./narrativeContext/narrativeBundleContext";
import type { NarrativeMemoryContext } from "@/game/domain/narrativeMemoryContext";
import { prepareNarrativeMemory } from "../../prepareNarrativeMemory";
import { asGameId } from "../persistence/gameRepository";
import type { HistoryEntry } from "@/game/domain/narrativeHistory";

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

function withProjection(base: WorldState, overrides: Partial<EntityCompatibilityProjection> & Readonly<{
  readonly eventLedger?: readonly WorldState["eventLedger"][number][];
}>): WorldState {
  const { eventLedger = base.eventLedger, ...projectionOverrides } = overrides;
  const projection = { ...projectEntityStore(base.entityStore), ...projectionOverrides };
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
    eventLedger,
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
    domainEventIds: [asEventId("turn-1:event-1")],
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
      usedEventIds: [],
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
  it("rejects missing drafts and legacy positional scenes by default", async () => {
    const complete = vi.fn();
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete) });
    const context: NarrativeBundleSourceContext = { kind: "decision", worldState: makeWorldState(), storyState: makeNextActStoryState(), job: makeJob() };
    for (const [payload, repairDetail] of [
      [{ worldDelta: null }, "invalid_slots at $.sceneDrafts"],
      [nextActOverPlanResponse({ choicesAt: 4, totalScenes: 13 }), "unknown_field at $.currentScene"],
    ] as const) {
      complete.mockResolvedValue({ ok: true, content: JSON.stringify(payload) });
      expect(await source.generate(context)).toMatchObject({ ok: false, repairReason: "invalid_schema", repairDetail });
    }
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("compiles a new draft by slotKey and exposes unknown-slot repair paths", async () => {
    const stepKey = `move:loc_dyn_${makeStoryState().evolution.nextLocationOrdinal}`;
    const currentScene = { ...validBundleResponse.currentScene, npcLine: null, choices: [] };
    const arrival = { ...validBundleResponse.currentScene, npcLine: { ...validBundleResponse.currentScene.npcLine, npcId: `npc_dyn_${makeStoryState().evolution.nextNpcOrdinal}` }, choices: [
      { candidateId: `${stepKey}_choice_1`, label: "表明身份。" },
      { candidateId: `${stepKey}_choice_2`, label: "先问来意。" },
    ] };
    const draft = { worldDelta: null, sceneDrafts: [{ slotKey: stepKey, scene: arrival }, { slotKey: "current", scene: currentScene }] };
    const complete = vi.fn().mockResolvedValue({ ok: true, content: JSON.stringify(draft) });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete) });
    const context: NarrativeBundleSourceContext = { kind: "decision", worldState: makeWorldState(), storyState: makeNextActStoryState(), job: makeJob() };
    const result = await source.generate(context);
    expect(result).toMatchObject({ ok: true, kind: "decision", proposal: { currentScene, continuationScenes: [{ stepKey, scene: arrival }], terminal: { kind: "next_decision", target: { kind: "continuation_step", stepKey } } } });
    complete.mockResolvedValue({ ok: true, content: JSON.stringify({ ...draft, sceneDrafts: [...draft.sceneDrafts, { slotKey: "invented", scene: currentScene }] }) });
    expect(await source.generate(context)).toMatchObject({ ok: false, repairReason: "invalid_schema", repairDetail: "unknown_slot at $.sceneDrafts[2].slotKey" });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("calls aiClient.complete with narrative_bundle role exactly once", async () => {
    const complete = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify(validBundleResponse),
    });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete), allowLegacyDecisionDto: true });

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
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete), allowLegacyDecisionDto: true });
    const base = makeWorldState();
    const focusNpcId = asNpcId("npc_1");
    const privateFactId = asFactId("fact_private");
    const publicFactId = asFactId("fact_public");
    const interactionHistory = Array.from({ length: 5 }, (_, index) => ({
      eventId: asEventId(`evt:interact:${index + 1}`),
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
      eventLedger: [
        ...base.eventLedger,
        ...interactionHistory.map((interaction) => makeCommittedEvent({
          type: "npc_interaction_recorded",
          npcId: focusNpcId,
          dialogueAct: interaction.dialogueAct,
        }, {
          eventId: interaction.eventId,
          turnNumber: interaction.turnNumber,
          actorIds: [PLAYER_ENTITY_ID],
          targetIds: [focusNpcId],
          locationId: interaction.locationId,
          actionId: interaction.actionId,
        })),
        makeCommittedEvent({ type: "fact_discovered", factId: publicFactId }, {
          sequence: base.eventLedger.length + interactionHistory.length,
          turnId: asTurnId("turn:4"), eventId: asEventId("turn:4:fact_discovered"),
          turnNumber: 4, locationId: asLocationId("loc_0"), factIds: [publicFactId], actorIds: [focusNpcId],
        }),
      ],
    });
    const storyState: StoryState = {
      ...makeStoryState(),
      currentAct: 2,
      tension: 55,
      nextPacingNeed: "complicate",
      memory: rebuildEpisodicMemory(worldState.eventLedger),
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
    expect(systemPrompt).toContain("fact_discovered");
    expect(systemPrompt).toContain("本回合 worldDelta 必须为 null");
    expect(systemPrompt).toContain("仅提供 investigationApproaches 不会开启调查");
    expect(systemPrompt).toContain("当前主线要求玩家先选择主动调查方法时");
    expect(systemPrompt).toContain("不能用 automatic 事实或仅在文字中提供 approaches 代替");
    expect(systemPrompt).not.toContain('goals":["..."]');
    for (let index = 1; index <= 5; index += 1) {
      expect(systemPrompt).toContain(`evt:interact:${index}`);
    }
    expect(systemPrompt).not.toContain("DO_NOT_LEAK_OTHER_NPC_SECRET");
    expect(auditContext).toEqual(expect.objectContaining({
      narrativeContext: expect.objectContaining({
        compilerVersion: 1,
        maxEstimatedTokens: NARRATIVE_BUNDLE_CONTEXT_MAX_ESTIMATED_TOKENS,
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
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete), allowLegacyDecisionDto: true });
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
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete), allowLegacyDecisionDto: true });

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
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete), allowLegacyDecisionDto: true });

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
    expect(systemPrompt).toContain("sceneDrafts 必须与本节槽位投影完全一致");
    expect(systemPrompt).toContain("不得投影之外自行规划未来步骤");
    expect(systemPrompt).toContain('slotKey:"current"');
    expect(systemPrompt).toContain('slotKey:"精确服务端步骤key"');
    expect(systemPrompt).toContain("不得输出 currentScene、continuationScenes 或 terminal，服务器按槽投影组装它们");
    expect(systemPrompt).toContain("禁止鬼魂");
    expect(systemPrompt).toContain("只能是 scene 或 npc_gift");
    expect(systemPrompt).toContain("该 NPC 的约定对话完成后由规则交给玩家");
    expect(systemPrompt).toContain("不能提交 giver ID、giftFromNpcId");
  });

  it("includes typed NPC creation anchors, goals, and directed relationship seeds in the bundle contract", async () => {
    const complete = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify(validBundleResponse),
    });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete), allowLegacyDecisionDto: true });

    await source.generate({
      kind: "decision",
      worldState: makeWorldState(),
      storyState: { ...makeStoryState(), evolution: { ...makeStoryState().evolution, status: "needs_next_act" } },
      job: makeJob(),
    });

    const systemPrompt = (complete.mock.calls[0]![1] as readonly AiMessage[])[0]!.content as string;
    expect(systemPrompt).toContain('"relationshipSeeds"');
    expect(systemPrompt).toContain("horizon");
    expect(systemPrompt).toContain("capabilityBoundaries");
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
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete), allowLegacyDecisionDto: true });

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
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete), allowLegacyDecisionDto: true });

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

  it("constrains dialogue-only turns to a single atmosphere segment", async () => {
    const complete = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify(validBundleResponse),
    });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete), allowLegacyDecisionDto: true });

    await source.generate({
      kind: "decision",
      worldState: makeWorldState(),
      storyState: makeStoryState(),
      job: {
        ...makeJob(),
        mandatoryBeats: [
          { beatId: "atmosphere", kind: "atmosphere", subjectIds: [], instruction: "氛围描写（可选，放在最后）" },
        ],
      },
    });

    const systemPrompt = (complete.mock.calls[0]![1] as readonly AiMessage[])[0]!.content as string;
    expect(systemPrompt).toContain("本回合没有其他强制叙事节拍");
    expect(systemPrompt).toContain('currentScene.segments 可以省略；若返回，必须且只能包含一条氛围段，固定使用 beatId="atmosphere"');
    expect(systemPrompt).toContain("不得出现 dialogue、narration、response、player_utterance");
    expect(systemPrompt).not.toContain("currentScene.segments 的 beatId 只能是下列之一");
  });

  it("projects the post-expansion arrival graph for a next-act response", async () => {
    const complete = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify(validBundleResponse),
    });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete), allowLegacyDecisionDto: true });
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
    expect(systemPrompt).toContain(`下一幕场景骨架（逐槽填写正文，不改变选择数量）：[{"slotKey":"move:${locationId}","scene":`);
    expect(systemPrompt).not.toContain('下一幕抵达场景骨架：{"stepKey"');
    expect(systemPrompt).toContain(`move:${locationId}_choice_1`);
    expect(systemPrompt).toContain(npcId);
    expect(systemPrompt).toContain('"kind":"continuation_step"');
    expect(systemPrompt).not.toContain('terminal: {"kind":"ending"}');
  });

  it("rejects a P3 first-act bundle without an executable scene investigation", async () => {
    const complete = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify(validBundleResponse),
    });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete), allowLegacyDecisionDto: true });
    const base = makeWorldState();
    const worldState: WorldState = {
      ...base,
      generation: {
        ...base.generation,
        setup: {
          characterName: "沈砚",
          characterIdentity: "受托保管旧契的旅人",
          characterProfile: "谨慎、守信。",
          personalityTags: ["谨慎"],
          worldPremise: "渡口保存一份需要核验的旧契，见证方式会影响交付。",
          storyOpening: "第一幕推进时必须实际创建 scene 调查事实，并用 consequenceBindings.bind_investigation 激活方法。",
          narrativeStyle: "novel",
          contentIntensity: "normal",
        },
      },
    };
    const storyState: StoryState = {
      ...makeStoryState(),
      currentAct: 2,
      evolution: { ...makeStoryState().evolution, status: "needs_next_act" },
    };

    const result = await source.generate({ worldState, storyState, job: makeJob(), kind: "decision" });

    expect(result).toMatchObject({
      ok: false,
      repairReason: "invalid_schema",
      repairDetail: "p3_scene_investigation_missing",
    });
    const prompt = (complete.mock.calls[0]![1] as readonly AiMessage[])[0]!.content as string;
    expect(prompt).toContain("P3 首幕调查");
    expect(prompt).toContain("worldDelta.newFact 与 worldDelta.consequenceBindings");
  });

  it("把已占用实体名称交给 provider，新实体撞名会让整包被服务端拒绝", async () => {
    const complete = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify(validBundleResponse),
    });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete), allowLegacyDecisionDto: true });
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
    expect(systemPrompt).toContain("- 地点：山涧密林、小镇");
    expect(systemPrompt).toContain("- NPC：灰衣老者");
    expect(systemPrompt).toContain("- 敌人：黑衣暗哨");
    expect(systemPrompt).toContain("世界内实体名称唯一");
  });

  it("修复重试会把服务端拒绝码与细分理由写进提示", async () => {
    const complete = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify(validBundleResponse),
    });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete), allowLegacyDecisionDto: true });

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
    expect(systemPrompt).toContain("上一轮生成未完成");
    expect(systemPrompt).toContain("拒绝码=world_delta_rejected");
    expect(systemPrompt).toContain("细分原因=duplicate_name:enemy:蒙面劫匪|item:旧令牌");
    expect(systemPrompt).toContain("上一轮新enemy名称“蒙面劫匪”已与世界中现有实体重复");
    expect(systemPrompt).toContain("上一轮新item名称“旧令牌”已与世界中现有实体重复");
  });

  it("契约类失败只给细分原因时，提示会点名终点步骤与候选选项要求", async () => {
    const complete = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify(validBundleResponse),
    });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete), allowLegacyDecisionDto: true });

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
    expect(systemPrompt).toContain("细分原因=terminal_step_requires_two_choices（步骤 battle_resolved:victory:enemy_dyn_3）");
    expect(systemPrompt).toContain("选择槽必须有两个合法 candidateId 和中文 label；其他槽 choices=[]");
  });

  it.each(["scene", "npc_gift"])("preserves %s acquisition while normalizing a next-act continuation", async (acquisition) => {
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
          newItem: { name: "半块令牌", description: "断裂的令牌。", locationRef: "new_location", acquisition },
          newEnemy: { name: "蒙面劫匪", tier: "normal", locationRef: "new_location" },
          newFact: null,
          nextMainQuest: { name: "枯柳驿线索", description: "前往荒废驿站。", objectiveText: "调查枯柳驿" },
          endingPair: null,
        },
        currentScene: {
          segments: [{ beatId: "closing", text: "柳三娘递来一枚铜钱。" }],
          npcLine: { npcId: "npc_1", text: "去枯柳驿看看。", emotion: "warm", answeredBeatIds: [], usedFactIds: [], usedEventIds: [] },
          objectiveLink: { questId: "nextMainQuest", text: "旧格式" },
          choices: [],
        },
        continuationScenes: [{
          segments: [{ beatId: "arrival", text: "你抵达枯柳驿。" }],
          npcLine: { npcId: "npc_dyn_1", text: "来者何人？", emotion: "guarded", answeredBeatIds: [], usedFactIds: [], usedEventIds: [] },
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
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete), allowLegacyDecisionDto: true });
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
          { candidateId: "wrong_1", label: "表明身份" },
          { candidateId: "wrong_2", label: "先行试探" },
        ],
      },
    });
    expect(result.proposal.worldDelta).toMatchObject({
      newLocation: { connectFromLocationId: "loc_0" },
      newItem: { acquisition },
    });
  });

  it("does not misdiagnose a generic world delta rejection as an optional newFact failure", async () => {
    const complete = vi.fn().mockResolvedValue({ ok: true, content: JSON.stringify(validBundleResponse) });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete), allowLegacyDecisionDto: true });
    await source.generate({ kind: "decision", worldState: makeWorldState(), storyState: { ...makeStoryState(), evolution: { ...makeStoryState().evolution, status: "needs_next_act" } }, job: makeJob(),
      contentRepair: { attempt: 1, reason: "invalid_schema", detail: "world_delta_invalid" } });
    const prompt = (complete.mock.calls[0]![1] as readonly AiMessage[])[0]!.content as string;
    expect(prompt).toContain("不能假定错误来自 newFact");
    expect(prompt).toContain("worldDelta.beatSummary 必须是非空字符串");
  });

  it.each([undefined, null, "", "   "])("reports the exact missing/invalid ending beatSummary path (%s)", async beatSummary => {
    const complete = vi.fn().mockResolvedValue({ ok: true, content: JSON.stringify({
      worldDelta: { ...(beatSummary === undefined ? {} : { beatSummary }), endingPair: [
        { themeKey: "trust", name: "共担真相", description: "公开证据。" }, { themeKey: "doubt", name: "独行", description: "追查到底。" },
      ] }, sceneDrafts: [{ slotKey: "current", scene: { segments: [{ beatId: "closing", text: "终局。" }], npcLine: null, objectiveLink: null, choices: [] } }],
    }) });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete) });
    const result = await source.generate({ kind: "decision", worldState: makeWorldState(), storyState: { ...makeStoryState(), evolution: { ...makeStoryState().evolution, status: "needs_ending_pair" } }, job: makeJob() });
    expect(result).toMatchObject({ ok: false, repairDetail: "world_delta_invalid at $.worldDelta.beatSummary: expected non-empty string" });
    const prompt = (complete.mock.calls[0]![1] as readonly AiMessage[])[0]!.content as string;
    expect(prompt).toContain("非空 beatSummary");
    expect(prompt).toContain("这两个字段都不能置于顶层");
  });

  it("canonicalizes an ending terminal that carries an unnecessary target object", async () => {
    const complete = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify({
        worldDelta: {
          beatSummary: "旧案终有了结。",
          newLocation: null,
          newNpc: null,
          newItem: null,
          newEnemy: null,
          newFact: null,
          nextMainQuest: null,
          endingPair: [
            { themeKey: "trust", name: "共担真相", description: "与可信之人公开证据。" },
            { themeKey: "doubt", name: "独行求证", description: "只凭自己的判断追查到底。" },
          ],
        },
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
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete), allowLegacyDecisionDto: true });
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
    expect(result.proposal.worldDelta).toMatchObject({ endingPair: [{ themeKey: "trust" }, { themeKey: "doubt" }] });
  });

  it("puts source-linked player memory into the actual author prompt and manifest", async () => {
    const complete = vi.fn().mockResolvedValue({ ok: true, content: JSON.stringify(validBundleResponse) });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete), allowLegacyDecisionDto: true });
    const memoryContext: NarrativeMemoryContext = {
      observerId: PLAYER_ENTITY_ID,
      coveredThroughSequence: 49,
      overviewHistoryIds: [],
      overviewEventIds: [],
      uncovered: [{ id: "history:old", segmentId: "segment:old", sequence: 50, actionId: "old", jobId: null, sceneId: "old", revision: 50, turnNumber: 50, kind: "narration", text: "委托人说过：先核对封口，再把信交给渡口的人。", speakerId: PLAYER_ENTITY_ID, audienceIds: [PLAYER_ENTITY_ID], entityIds: [PLAYER_ENTITY_ID], factIds: [], eventIds: [], choiceToken: null }],
      recalled: [],
      requiredEvents: [],
      referencedEntityIds: [PLAYER_ENTITY_ID],
      ambiguousEntityIds: [],
      manifest: [{ ref: "history:old", reason: "uncovered", mandatory: true }],
    };
    await source.generate({ kind: "decision", worldState: makeWorldState(), storyState: makeStoryState(), job: makeJob(), memoryContext });
    const [, messages, auditContext] = complete.mock.calls[0]! as [string, readonly AiMessage[], { readonly narrativeContext?: unknown }];
    expect(messages[0]!.content).toContain("委托人说过：先核对封口，再把信交给渡口的人。");
    expect(JSON.stringify(auditContext.narrativeContext)).toContain("bundle:source-linked-memory");
  });

  it("retrieves a quote omitted by the overview and carries distinct event payloads into the actual author request once", async () => {
    const complete = vi.fn().mockResolvedValue({ ok: true, content: JSON.stringify(validBundleResponse) });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete), allowLegacyDecisionDto: true });
    const base = makeWorldState();
    const events = ["first", "second", "overview"].map((id, index) => makeCommittedEvent({ type: "npc_interaction_recorded", npcId: asNpcId("npc_1"), dialogueAct: "support" }, {
      eventId: asEventId(`memory:${id}`), sequence: 100 + index, actorIds: [PLAYER_ENTITY_ID], targetIds: [], locationId: base.currentLocationId,
    }));
    const worldState = { ...base, eventLedger: events };
    const quote = "封口完好才交付，破损就先回来找我。";
    const entries: HistoryEntry[] = Array.from({ length: 20 }, (_, sequence) => ({
      id: `recall:${sequence}`, segmentId: `segment:${sequence}`, sequence, actionId: null, jobId: null,
      sceneId: `scene:${sequence}`, revision: 0, turnNumber: 1, kind: "narration", speakerId: null, audienceIds: [PLAYER_ENTITY_ID],
      entityIds: sequence === 0 || sequence === 5 ? [base.currentLocationId] : [], factIds: [],
      eventIds: sequence === 0 ? [events[2]!.eventId] : [], choiceToken: null,
      text: sequence === 5 ? quote : `独立历史片段${sequence}`,
    }));
    const storyState = { ...makeStoryState(), history: { entries } };
    const job = { ...makeJob(), utterance: "接下来怎么办", domainEventIds: events.slice(0, 2).map(event => event.eventId) };
    const result = await prepareNarrativeMemory({
      record: { gameId: asGameId("memory:actual-prompt"), createdAt: "2026-01-01", revision: 1, worldState, storyState },
      observerId: PLAYER_ENTITY_ID, job,
      source: { select: async () => { throw new Error("No new summary needed"); } },
      repository: { load: async () => ({ summaryRevision: 1, state: {
        formatVersion: 1, observerId: PLAYER_ENTITY_ID, policyVersion: "memory-p2/1", summaryRevision: 1,
        coveredThroughSequence: 9, coveredSourceFingerprint: "validated-by-repository", batches: [],
        overview: { historyIds: ["recall:0"], eventIds: [events[2]!.eventId] },
      } }), publish: async () => ({ ok: true }) },
      policy: { threshold: 50, batchSize: 10, rawSoftEstimatedTokens: 24_000, summarySourceMaxEstimatedTokens: 24_000, overviewMaxEstimatedTokens: 6_000, promptMaxEstimatedTokens: 64_000 },
      summaries: "enabled", signal: new AbortController().signal, reserveBatchUpdate: async () => false, reserveSummaryHttpAttempt: async () => false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.recalled.map(entry => entry.id)).toContain("recall:5");
    expect(result.context.requiredEvents.map(event => event.eventId)).toEqual(events.slice(0, 2).map(event => event.eventId));
    await source.generate({ kind: "decision", worldState, storyState, job, memoryContext: result.context });
    const messages = complete.mock.calls[0]![1] as readonly AiMessage[];
    const prompt = messages.map(message => message.content).join("\n");
    expect(prompt.split(quote)).toHaveLength(2);
    for (const event of events) expect(prompt).toContain(`eventId=${event.eventId}; sequence=${event.sequence}`);
    expect(prompt).toContain(`payload=${JSON.stringify(events[2]!.payload)}`);
  });

  it("rejects a complete decision context over the frozen prompt budget before transport", async () => {
    const complete = vi.fn().mockResolvedValue({ ok: true, content: JSON.stringify(validBundleResponse) });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete), allowLegacyDecisionDto: true });

    const result = await source.generate({
      kind: "decision",
      worldState: makeWorldState(),
      storyState: makeStoryState(),
      job: makeJob(),
      maxEstimatedTokens: 1,
    });

    expect(result).toMatchObject({ ok: false, repairReason: "context_budget_exceeded" });
    expect(complete).not.toHaveBeenCalled();
  });

  it("reports an unknown worldDelta field at its exact path and preserves the raw author draft", async () => {
    const rawDraft = {
      ...validBundleResponse,
      worldDelta: {
        beatSummary: "船坞出现新的争执。",
        newLocation: null,
        newNpc: { existingFactIds: ["fact_0", "fact_1"] },
        newItem: null,
        newEnemy: null,
        newFact: null,
        nextMainQuest: null,
        endingPair: null,
        newFact2: null,
      },
    };
    const complete = vi.fn().mockResolvedValue({ ok: true, content: JSON.stringify(rawDraft) });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete), allowLegacyDecisionDto: true });

    const result = await source.generate({
      kind: "decision",
      worldState: makeWorldState(),
      storyState: makeStoryState(),
      job: makeJob(),
    });

    expect(result).toMatchObject({
      ok: false,
      repairReason: "invalid_schema",
      repairDetail: "world_delta_invalid at $.worldDelta.newFact2: unknown field",
      rejectedDraft: rawDraft,
    });

    complete.mockResolvedValueOnce({ ok: true, content: JSON.stringify(validBundleResponse) });
    await source.generate({
      kind: "decision",
      worldState: makeWorldState(),
      storyState: makeStoryState(),
      job: makeJob(),
      contentRepair: { attempt: 1, reason: "invalid_schema", detail: "world_delta_invalid at $.worldDelta.newFact2: unknown field" },
      authorDraftRevision: {
        candidateVersion: 1,
        draft: rawDraft,
        findings: [],
      },
    });
    const secondAuthorRequest = (complete.mock.calls[1]![1] as readonly AiMessage[])[0]!.content as string;
    expect(secondAuthorRequest).toContain("existingFactIds");
    expect(secondAuthorRequest).toContain("newFact2");
    expect(secondAuthorRequest).toContain("未经编译、审批或授权");
  });

  it("authors a choice-free ending handoff without regenerating an existing ending pair", async () => {
    const complete = vi.fn().mockResolvedValue({ ok: true, content: JSON.stringify({
      worldDelta: null,
      currentScene: { segments: [{ beatId: "closing", text: "众人等你表明最后立场。" }], npcLine: null, objectiveLink: null, choices: [] },
      continuationScenes: [],
      terminal: { kind: "ending" },
    }) });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete), allowLegacyDecisionDto: true });
    const worldState: WorldState = { ...makeWorldState(), endings: [
      { id: "ending_trust", name: "信任", description: "", theme: "trust", requirements: [] },
      { id: "ending_doubt", name: "存疑", description: "", theme: "doubt", requirements: [] },
    ] as never };
    const storyState: StoryState = {
      ...makeStoryState(),
      endingAllowed: true,
      evolution: { ...makeStoryState().evolution, status: "needs_ending_pair" },
    };

    const result = await source.generate({ kind: "decision", worldState, storyState, job: makeJob() });

    expect(result).toMatchObject({ ok: true, kind: "decision", proposal: {
      worldDelta: null, terminal: { kind: "ending" }, currentScene: { choices: [] }, continuationScenes: [],
    } });
    const prompt = (complete.mock.calls[0]![1] as readonly AiMessage[])[0]!.content as string;
    expect(prompt).toContain("本回合不需要世界演化：worldDelta 必须为 null");
  });

  it("为 story_exit 归一化无 NPC 的退出终局，不把 provider 选项变成第二次行动", async () => {
    const complete = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify({
        worldDelta: null,
        currentScene: {
          segments: [{ beatId: "atmosphere", text: "你转身离开了这段委托。" }],
          npcLine: null,
          objectiveLink: null,
          choices: [{ candidateId: "untrusted", label: "继续" }],
        },
        continuationScenes: [],
        terminal: { kind: "next_decision", target: { kind: "current_scene" } },
      }),
    });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete), allowLegacyDecisionDto: true });

    const result = await source.generate({
      kind: "decision",
      worldState: makeWorldState(),
      storyState: makeStoryState(),
      job: {
        ...makeJob(),
        actionSummary: { kind: "abandon_quest", questId: "quest_exit" as never },
        focusNpcId: undefined,
        generationKind: "story_exit",
        sceneRequestKind: "story_exit",
      },
    });

    expect(result).toMatchObject({ ok: true, kind: "decision" });
    if (!result.ok || result.kind !== "decision") return;
    expect(result.proposal.currentScene.choices).toEqual([]);
    expect(result.proposal.terminal).toEqual({ kind: "ending" });
  });

  it("drops only a malformed optional investigation list while keeping a valid next-act delta", async () => {
    const stepKey = `move:loc_dyn_${makeNextActStoryState().evolution.nextLocationOrdinal}`;
    const complete = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify({
        worldDelta: {
          beatSummary: "旧案线索指向枯柳驿。",
          newLocation: { name: "枯柳驿", description: "荒废的驿站。", scale: "scene", placement: "world", connectFromLocationId: "小镇" },
          newNpc: {
            name: "老驼子", role: "守夜人", description: "警惕的守夜人。", locationRef: { kind: "new_location" },
            anchors: { selfConcept: "守着旧案秘密的老人", values: ["守诺"], speechStyle: "低声而谨慎", capabilityBoundaries: ["只知道亲身见闻"], taboos: [] },
            goals: [{ horizon: "short", description: "守住秘密", priority: 3, reason: "旧案仍不能落入旁人之手" }],
            relationshipSeeds: [],
          },
          newItem: null,
          newEnemy: null,
          newFact: {
            text: "驿站后墙留有不属于当地镖师的车辙。",
            visibility: "public",
            investigationApproaches: [
              { approachId: "single_approach", label: "查看车辙方向", evidenceQuality: "clean", tensionDelta: 4 },
            ],
          },
          nextMainQuest: { name: "枯柳驿线索", description: "前往荒废驿站。", objectiveText: "调查枯柳驿" },
          endingPair: null,
        },
        currentScene: {
          segments: [{ beatId: "closing", text: "线索指向枯柳驿。" }],
          npcLine: { npcId: "npc_1", text: "去枯柳驿看看。", emotion: "warm", answeredBeatIds: [], usedFactIds: [], usedEventIds: [] },
          objectiveLink: null,
          choices: [],
        },
        continuationScenes: [{
          stepKey,
          scene: {
            segments: [{ beatId: "arrival", text: "你抵达枯柳驿。" }],
            npcLine: { npcId: "npc_dyn_1", text: "来者何人？", emotion: "guarded", answeredBeatIds: [], usedFactIds: [], usedEventIds: [] },
            objectiveLink: null,
            choices: [
              { candidateId: `${stepKey}_choice_1`, label: "表明身份" },
              { candidateId: `${stepKey}_choice_2`, label: "先行试探" },
            ],
          },
        }],
        terminal: { kind: "next_decision", target: { kind: "continuation_step", stepKey } },
      }),
    });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete), allowLegacyDecisionDto: true });

    const result = await source.generate({
      kind: "decision",
      worldState: makeWorldState(),
      storyState: makeNextActStoryState(),
      job: makeJob(),
    });

    expect(result).toMatchObject({ ok: true, kind: "decision" });
    if (!result.ok || result.kind !== "decision") return;
    expect(result.proposal.worldDelta).toMatchObject({
      newLocation: { name: "枯柳驿" },
      newNpc: { name: "老驼子" },
      nextMainQuest: { name: "枯柳驿线索" },
      newFact: null,
    });
  });

  it("丢弃投影之外的过度规划步骤，只保留服务端投影的到达步骤", async () => {
    const stepKey = `move:loc_dyn_${makeStoryState().evolution.nextLocationOrdinal}`;
    const complete = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify(nextActOverPlanResponse({ choicesAt: 0, totalScenes: 13 })),
    });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete), allowLegacyDecisionDto: true });

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
          { candidateId: "wrong_1", label: "上前施礼" },
          { candidateId: "wrong_2", label: "按住刀柄" },
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
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete), allowLegacyDecisionDto: true });

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
        choices: [{ candidateId: "wrong_1" }, { candidateId: "wrong_2" }],
      },
    });
  });

  it("过度规划且没有任何终点选项时仍然拒绝，但回传细分契约原因与步骤", async () => {
    const stepKey = `move:loc_dyn_${makeStoryState().evolution.nextLocationOrdinal}`;
    const complete = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify(nextActOverPlanResponse({ choicesAt: -1, totalScenes: 13 })),
    });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete), allowLegacyDecisionDto: true });

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
            usedEventIds: [],
          },
          objectiveLink: null,
          choices: [
            { candidateId: "ask_lead", label: "把线索告诉我。" },
            { candidateId: "challenge_lead", label: "先说清楚缘由。" },
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
    expect(prompt).toContain("situation.responses 或同包 interactionProposals");
    expect(prompt).toContain("opening.consequenceBindings");
    expect(prompt).toContain("bind_investigation");
    expect(prompt).toContain("witnessNpcIds");
    expect(prompt).not.toContain('"consequenceBindings":[{"kind":"bind_investigation"');
  });

  it("accepts an automatic opening and defers investigation to first-act scene evolution", async () => {
    const opening = await createFixtureOpeningCandidateSource().generate({
      gameType: "wuxia", gameLength: "short", seed: "opening-required-investigation",
    });
    const complete = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify({
        opening,
        currentScene: {
          segments: [{ beatId: "opening", text: "渡口的风压过旧纸。" }],
          npcLine: { npcId: "npc_0", text: "先把规矩说清。", emotion: "guarded", answeredBeatIds: [], usedFactIds: [], usedEventIds: [] },
          objectiveLink: null,
          choices: opening.opening.situation.responses.map((response) => ({ candidateId: response.key, label: response.key })),
        },
        continuationScenes: [],
        terminal: { kind: "next_decision", target: { kind: "current_scene" } },
      }),
    });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete) });

    const result = await source.generate({
      kind: "opening",
      jobId: asNarrativeJobId("job-opening-required-investigation"),
      input: {
        gameType: "wuxia", gameLength: "short", seed: "opening-required-investigation",
        setup: {
          characterName: "陆遥", characterIdentity: "流浪剑客", characterProfile: "谨慎守诺。",
          personalityTags: ["谨慎"], worldPremise: "渡口保存需要核验的旧契，见证方式会影响交付。",
          storyOpening: "请先选择查验方法。本协议要求实际创建可主动调查的事实，并用 consequenceBindings.bind_investigation 激活方法；仅写 investigationApproaches 不满足。",
          narrativeStyle: "novel", contentIntensity: "normal",
        },
      },
    });

    expect(result).toMatchObject({ ok: true, kind: "opening" });
  });

  it("normalizes a provider response that flattens opening creation fields", async () => {
    const opening = await createFixtureOpeningCandidateSource().generate({
      gameType: "wuxia", gameLength: "short", seed: "opening-flat-shape",
    });
    const flatOpening = {
      world: opening.world,
      player: opening.player,
      prologue: opening.prologue,
      storyContract: opening.storyContract,
      ...opening.opening,
    };
    const complete = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify({
        opening: flatOpening,
        currentScene: {
          segments: [{ beatId: "opening", text: "渡口的风压过旧纸。" }],
          npcLine: { npcId: "npc_0", text: "先把规矩说清。", emotion: "guarded", answeredBeatIds: [], usedFactIds: [], usedEventIds: [] },
          objectiveLink: null,
          choices: opening.opening.situation.responses.map((response) => ({ candidateId: response.key, label: response.key })),
        },
        continuationScenes: [],
        terminal: { kind: "next_decision", target: { kind: "current_scene" } },
      }),
    });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete) });

    const result = await source.generate({
      kind: "opening",
      jobId: asNarrativeJobId("job-opening-flat-shape"),
      input: { gameType: "wuxia", gameLength: "short", seed: "opening-flat-shape" },
    });

    expect(result).toMatchObject({ ok: true, kind: "opening" });
  });

  it("normalizes a provider repair response that wraps the complete opening bundle", async () => {
    const opening = await createFixtureOpeningCandidateSource().generate({
      gameType: "wuxia", gameLength: "short", seed: "opening-wrapped-shape",
    });
    const currentScene = {
      segments: [{ beatId: "opening", text: "渡口的风压过旧纸。" }],
      npcLine: { npcId: "npc_0", text: "先把规矩说清。", emotion: "guarded", answeredBeatIds: [], usedFactIds: [], usedEventIds: [] },
      objectiveLink: null,
      choices: opening.opening.situation.responses.map((response) => ({ candidateId: response.key, label: response.key })),
    };
    const complete = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify({
        opening: { ...opening, currentScene, continuationScenes: [], terminal: { kind: "next_decision", target: { kind: "current_scene" } } },
      }),
    });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete) });

    const result = await source.generate({
      kind: "opening",
      jobId: asNarrativeJobId("job-opening-wrapped-shape"),
      input: { gameType: "wuxia", gameLength: "short", seed: "opening-wrapped-shape" },
    });

    expect(result).toMatchObject({ ok: true, kind: "opening" });
  });

  it("preserves structurally valid opening interaction proposals and candidate bindings", async () => {
    const opening = await createFixtureOpeningCandidateSource().generate({
      gameType: "wuxia", gameLength: "short", seed: "opening-interaction-source",
    });
    const complete = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify({
        opening,
        interactionProposals: [{
          proposalKey: "verify_identity",
          npcId: "npc_0",
          operation: "request_verification",
          condition: [],
          factIds: ["fact_0"],
          goalIds: [],
          promiseId: null,
          audienceIds: ["player_0"],
          evidenceEventIds: ["turn:existing-evidence"],
        }],
        currentScene: {
          segments: [{ beatId: "opening", text: "客栈里风声低沉。" }],
          npcLine: { npcId: "npc_0", text: "先核对这份证词。", emotion: "guarded", answeredBeatIds: [], usedFactIds: ["fact_0"], usedEventIds: [] },
          objectiveLink: null,
          choices: [
            { candidateId: "interaction:verify_identity", label: "先核验身份。" },
            { candidateId: "challenge_lead", label: "先说清楚缘由。" },
          ],
        },
        continuationScenes: [],
        terminal: { kind: "next_decision", target: { kind: "current_scene" } },
      }),
    });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete) });

    const result = await source.generate({
      kind: "opening",
      jobId: asNarrativeJobId("job-opening-interaction"),
      input: { gameType: "wuxia", gameLength: "short", seed: "opening-interaction-source" },
    });

    expect(result).toMatchObject({ ok: true, kind: "opening" });
    if (!result.ok || result.kind !== "opening") return;
    expect(result.proposal.interactionProposals?.[0]?.proposalKey).toBe("verify_identity");
    expect(result.proposal.currentScene.choices[0]?.candidateId).toBe("interaction:verify_identity");
  });

  it("passes the full opening setup and bounded latest novelty through the actual AI messages", async () => {
    const opening = await createFixtureOpeningCandidateSource().generate({
      gameType: "science_fiction", gameLength: "short", seed: "opening-context-transport",
    });
    const complete = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify({
        opening,
        currentScene: {
          segments: [{ beatId: "opening", text: "船坞的警示灯扫过检修台。" }],
          npcLine: { npcId: "npc_0", text: "这份清单上的签名，你认得吗？", emotion: "neutral", answeredBeatIds: [], usedFactIds: [], usedEventIds: [] },
          objectiveLink: null,
          choices: opening.opening.situation.responses.map((response, index) => ({ candidateId: response.key, label: index === 0 ? "先核对清单来源。" : "指出签名并非本人所留。" })),
        },
        continuationScenes: [],
        terminal: { kind: "next_decision", target: { kind: "current_scene" } },
      }),
    });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete) });
    const novelty = (summary: string, createdAt: string) => ({
      gameType: "science_fiction" as const, fingerprint: summary, semanticFingerprint: summary,
      semanticText: summary, summary, createdAt,
      profile: { sceneFrame: "other" as const, npcArchetype: "other" as const, leadType: "other" as const, conflictMode: "other" as const },
    });

    await source.generate({
      kind: "opening",
      jobId: asNarrativeJobId("job-opening-context-transport"),
      input: {
        gameType: "science_fiction", gameLength: "short", seed: "opening-context-transport",
        setup: {
          characterName: "林舟", characterIdentity: "领航员", characterProfile: "曾在船厂修理引擎。",
          personalityTags: ["冷静", "多疑"], worldPremise: "殖民卫星依靠轨道港补给。",
          storyOpening: "一份陌生维修清单写着林舟的名字。", narrativeStyle: "cinematic", contentIntensity: "dark",
        },
        novelty: { attempt: 1, recent: [
          novelty("过旧的样本", "2026-09-01"), novelty("上次为码头商人交接清单", "2026-09-05"),
          novelty("第二新的样本", "2026-09-04"), novelty("第三新的样本", "2026-09-03"),
        ] },
      },
    });

    expect(complete).toHaveBeenCalledTimes(1);
    const prompt = (complete.mock.calls[0]![1] as readonly AiMessage[])[0]!.content as string;
    for (const text of ["曾在船厂修理引擎。", "冷静", "多疑", "cinematic", "dark", "上次为码头商人交接清单"]) {
      expect(prompt).toContain(text);
    }
    expect(prompt).not.toContain("过旧的样本");
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
        npcLine: { npcId: "npc_0", text: "我等你很久了。", emotion: "guarded", answeredBeatIds: [], usedFactIds: [], usedEventIds: [] },
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

  it("rejects unknown opening response and NPC relationship/runtime fields", async () => {
    const opening = await createFixtureOpeningCandidateSource().generate({
      gameType: "wuxia",
      gameLength: "short",
      seed: "opening-live-unknown-fields",
    });
    const basePayload = {
      opening,
      currentScene: {
        segments: [{ beatId: "opening", text: "客栈里风声低沉。" }],
        npcLine: { npcId: "npc_0", text: "我等你很久了。", emotion: "guarded", answeredBeatIds: [], usedFactIds: [], usedEventIds: [] },
        objectiveLink: null,
        choices: [{ candidateId: "support", label: "我愿意帮忙。" }, { candidateId: "challenge", label: "先说清楚缘由。" }],
      },
      continuationScenes: [],
      terminal: { kind: "next_decision", target: { kind: "current_scene" } },
    };
    const mutations: readonly ((payload: Record<string, unknown>) => void)[] = [
      (payload) => { payload.extra = true; },
      (payload) => { ((payload.opening as Record<string, unknown>).opening as Record<string, unknown>).npc = {
        ...((payload.opening as Record<string, unknown>).opening as Record<string, unknown>).npc as Record<string, unknown>,
        relationshipSeeds: [{ targetNpcId: "npc_1", stance: "ally", reason: "旧识" }],
      }; },
      (payload) => { ((payload.opening as Record<string, unknown>).opening as Record<string, unknown>).npc = {
        ...((payload.opening as Record<string, unknown>).opening as Record<string, unknown>).npc as Record<string, unknown>,
        affinity: 10,
      }; },
      (payload) => { ((payload.opening as Record<string, unknown>).opening as Record<string, unknown>).npc = {
        ...((payload.opening as Record<string, unknown>).opening as Record<string, unknown>).npc as Record<string, unknown>,
        stage: "trusted",
      }; },
      (payload) => { ((payload.opening as Record<string, unknown>).opening as Record<string, unknown>).npc = {
        ...((payload.opening as Record<string, unknown>).opening as Record<string, unknown>).npc as Record<string, unknown>,
        evidence: [],
      }; },
      (payload) => { ((payload.opening as Record<string, unknown>).opening as Record<string, unknown>).npc = {
        ...((payload.opening as Record<string, unknown>).opening as Record<string, unknown>).npc as Record<string, unknown>,
        actionId: "action_1",
      }; },
    ];

    for (const mutate of mutations) {
      const payload = JSON.parse(JSON.stringify(basePayload)) as Record<string, unknown>;
      mutate(payload);
      const complete = vi.fn().mockResolvedValue({ ok: true, content: JSON.stringify(payload) });
      const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete) });
      const result = await source.generate({
        kind: "opening",
        jobId: asNarrativeJobId("job-opening-unknown-fields"),
        input: { gameType: "wuxia", gameLength: "short", seed: "opening-live-unknown-fields" },
      });
      expect(result).toMatchObject({ ok: false, failure: { kind: "AI_RESPONSE_INVALID" } });
      expect(complete).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects missing situation, invalid response references, and choice keys not declared by responses", async () => {
    const opening = await createFixtureOpeningCandidateSource().generate({
      gameType: "wuxia", gameLength: "short", seed: "opening-live-invalid-situation",
    });
    const basePayload = {
      opening,
      currentScene: {
        segments: [{ beatId: "opening", text: "檐下有人等候回应。" }],
        npcLine: { npcId: "npc_0", text: "你怎么看？", emotion: "neutral", answeredBeatIds: [], usedFactIds: [], usedEventIds: [] },
        objectiveLink: null,
        choices: opening.opening.situation.responses.map((response) => ({ candidateId: response.key, label: response.key })),
      },
      continuationScenes: [],
      terminal: { kind: "next_decision", target: { kind: "current_scene" } },
    };
    const mutations: readonly ((payload: typeof basePayload) => void)[] = [
      (payload) => { delete (payload.opening.opening as unknown as Record<string, unknown>).situation; },
      (payload) => { (payload.opening.world.publicFacts[0] as unknown as Record<string, unknown>).investigationApproaches = ["细看告示", "打听来历"]; },
      (payload) => { (payload.opening.opening.situation as unknown as Record<string, unknown>).npcConnection = { familiarity: "stranger", stance: "wary", basisHistoryKeys: [] }; },
      (payload) => { (payload.opening.opening.situation.responses[0] as { topic: { key: string } }).topic.key = "unknown_fact"; },
      (payload) => { (payload.currentScene.choices[0] as { candidateId: string }).candidateId = "unknown_response"; },
    ];

    for (const mutate of mutations) {
      const payload = structuredClone(basePayload);
      mutate(payload);
      const complete = vi.fn().mockResolvedValue({ ok: true, content: JSON.stringify(payload) });
      const result = await createNarrativeBundleSource({ aiClient: mockAiClient(complete) }).generate({
        kind: "opening",
        jobId: asNarrativeJobId("job-opening-invalid-situation"),
        input: { gameType: "wuxia", gameLength: "short", seed: "opening-live-invalid-situation" },
      });
      expect(result).toMatchObject({ ok: false, failure: { kind: "AI_RESPONSE_INVALID" } });
      expect(result).toHaveProperty("repairDetail", expect.any(String));
      expect(complete).toHaveBeenCalledTimes(1);
    }
  });
});
