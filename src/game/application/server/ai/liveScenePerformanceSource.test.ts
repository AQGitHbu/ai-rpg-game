import { describe, it, expect, vi } from "vitest";
import {
  createLiveScenePerformanceSource,
  compileLiveScenePrompt,
  buildLiveScenePrompt,
  LIVE_SCENE_MAX_TOKENS,
  LIVE_SCENE_TIMEOUT_MS,
  parseScenePerformanceJson,
} from "./liveScenePerformanceSource";
import { approveScenePerformance } from "../../approveAndWriteScene";
import type { ScenePerformanceProposal } from "../../sceneSource";
import type { AiTransport, AiTransportConfig } from "@ai-game/ai-transport";
import type { SceneGenerationContext } from "../../sceneGenerationContext";
import { buildSelectableSceneCandidates } from "../../sceneChoiceCandidates";
import { buildStylePolicy } from "../../stylePolicy";
import { asLocationId, asNpcId, asFactId, asQuestId } from "@/game/domain/worldEntity";
import {asNarrativeJobId, asTurnId, asEventId} from "@/game/domain/events";
import { createPendingNarrativeJob, type PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import type { MandatoryNarrativeBeat, ObjectiveTransition } from "@/game/domain/narrativeBeat";
import { ATMOSPHERE_BEAT_ID } from "../../approveAndWriteScene";
import type { NpcSpeechAuthority } from "../../npcSpeechAuthority";

const FIXTURE_NPC_SPEECH_AUTHORITY: NpcSpeechAuthority = {
  speakerNpcId: asNpcId("npc_1"),
  responseTier: "neutral",
  allowedFactIds: [asFactId("fact_a")],
  withheldFactIds: [],
  allowedFactCards: [{ factId: asFactId("fact_a"), text: "已知线索" }],
  allowedEventIds: [asEventId("turn-1:interaction-1")],
  recentInteractions: [],
  identityAnchors: {
    selfConcept: "谨慎的掌柜",
    values: ["守诺"],
    speechStyle: "克制",
    capabilityBoundaries: ["不替人定罪"],
    taboos: [],
  },
  activeGoals: [],
  relationships: [],
  evidenceKeys: [],
};

const OTHER_NPC_SPEECH_AUTHORITY: NpcSpeechAuthority = {
  ...FIXTURE_NPC_SPEECH_AUTHORITY,
  speakerNpcId: asNpcId("npc_2"),
  allowedFactIds: [],
  allowedFactCards: [],
  allowedEventIds: [],
};

function makeJob(overrides: {
  eventKind?: PendingNarrativeJob["resolvedEvent"]["eventKind"];
  beats?: readonly MandatoryNarrativeBeat[];
  transition?: ObjectiveTransition;
  utterance?: string;
  summary?: PendingNarrativeJob["actionSummary"];
  focusNpcId?: string;
} = {}): PendingNarrativeJob {
  const result = createPendingNarrativeJob({
    jobId: asNarrativeJobId("job_1"),
    turnId: asTurnId("turn_1"),
    actionId: "act_1",
    expectedRevision: 0,
    turnNumber: 1,
    actionSummary: overrides.summary ?? { kind: "talk", npcId: asNpcId("npc_1") },
    utterance: overrides.utterance,
    resolvedEvent: {
      actionId: "act_1",
      status: "success",
      eventKind: overrides.eventKind ?? "dialogue",
      facts: [],
      stateChanges: [],
      costs: [],
      rewards: [],
      triggeredEvents: [],
      rejectedEffects: [],
    },
    domainEventIds: [asEventId("turn-1:event-1")],
    focusNpcId: overrides.focusNpcId !== undefined ? asNpcId(overrides.focusNpcId) : asNpcId("npc_1"),
    requestedAt: "2026-01-02",
    objectiveTransition: overrides.transition ?? { before: null, completed: [], after: null, mode: "unchanged" },
    mandatoryBeats: overrides.beats ?? [],
    generationKind: "npc_fixed_choice",
    sceneRequestKind: "npc_response",
  });
  if (!result.ok) throw new Error("fixture job 构造失败");
  return result.job;
}

function makeContext(overrides: {
  job?: PendingNarrativeJob;
  presentNpcs?: SceneGenerationContext["presentNpcs"];
  legalActionCandidates?: SceneGenerationContext["legalActionCandidates"];
  objectiveTarget?: SceneGenerationContext["objectiveTarget"];
  dialogueSessionCompleted?: boolean;
} = {}): SceneGenerationContext {
  const job = overrides.job ?? makeJob();
  return {
    job,
    player: { name: "侠客", identity: "剑客", knownFactCards: [] },
    currentLocation: { id: asLocationId("loc_1"), name: "客栈", description: "一间简朴的客栈", kind: "main" },
    publicWorldFacts: [],
    sceneVisibleFacts: [],
    presentNpcs: overrides.presentNpcs ?? [{
      id: asNpcId("npc_1"), name: "老板", role: "客栈老板", publicProfile: "热情的老板",
      knownFactCards: [{ factId: asFactId("fact_a"), text: "已知线索" }],
      hiddenFactCards: [{ factId: asFactId("fact_secret"), text: "绝不外泄的私密" }],
      sceneVisibleFactIds: [asFactId("fact_vis")],
      speechAuthority: FIXTURE_NPC_SPEECH_AUTHORITY,
      recentInteractionSummaries: ["ask 询问线索 / negative"], recentInteractionActionIds: ["turn-1:interaction-1"],
      relationship: { affinity: 20 }, emotion: "warm",
      goals: ["查清矿坑"], forbiddenKnowledgeIds: [asFactId("fact_secret")],
    }],
    story: {
      currentAct: 1, targetActs: 3, tension: 30, nextPacingNeed: "reveal",
      contract: {
        centralConflict: "商队失踪案背后的内应",
        endingDirections: [
          { key: "trust", theme: "共同揭露" },
          { key: "doubt", theme: "独自追查" },
        ],
      },
      remainingBudget: { remainingLocations: 1, remainingNpcs: 1, remainingEvents: 1 },
      unresolvedThreadSummaries: ["商队失踪"],
      stylePolicy: buildStylePolicy({ personalityTags: ["冷静"], narrativeStyle: "concise", contentIntensity: "normal" }),
    },
    legalActionCandidates: overrides.legalActionCandidates ?? [
      { kind: "talk", label: "与老板交谈", targetId: "npc_1" },
      { kind: "explore", label: "查看四周" },
    ],
    legalEventTargets: {
      locationIds: [asLocationId("loc_1")],
      factIds: [asFactId("fact_a")],
      itemIds: [],
      enemyIds: [],
    },
    worldConstraints: [],
    objectiveTransition: job.objectiveTransition,
    mandatoryBeats: job.mandatoryBeats,
    beatSubjects: [
      { id: "item_seal", kind: "item", name: "盟誓印谱", description: "刻着盟约的印谱" },
      { id: "npc_1", kind: "npc", name: "老板", description: "客栈老板" },
    ],
    narrativeReferenceIds: ["item_seal", "npc_1", "fact_a", "fact_vis"],
    objectiveTarget: overrides.objectiveTarget ?? null,
    ...(overrides.dialogueSessionCompleted === undefined
      ? {}
      : { dialogueSessionCompleted: overrides.dialogueSessionCompleted }),
    focusNpcContext: {
      id: asNpcId("npc_1"),
      name: "老板",
      role: "客栈老板",
      publicProfile: "热情的老板",
      responsePolicy: {
        tier: "friendly",
        toneInstruction: "温和友好，乐于帮忙。",
        initiative: "helpful",
        allowedDisclosureFactIds: [asFactId("fact_a")],
        privateKnowledgeIds: [asFactId("fact_secret")],
      },
      speakableFactCards: [{ factId: asFactId("fact_a"), text: "已知线索" }],
      recentInteractions: [{ eventId: asEventId("turn-1:interaction-1"), actionId: "inter_1", dialogueAct: "ask", topicSummary: "询问线索", outcome: "negative", summary: "氛围紧张" }],
      goals: ["查清矿坑"],
      emotion: "warm",
      thisTurn: { relationshipDelta: 0, outcome: "neutral" },
    },
  };
}

function stubTransport(payload: unknown, content: string | null = null): AiTransport {
  return {
    complete: vi.fn(async () => ({
      ok: true,
      content: content ?? JSON.stringify(payload),
      latencyMs: 1,
    })),
  } as unknown as AiTransport;
}

const config: AiTransportConfig = { baseUrl: "x", apiKey: "k", model: "m" };

describe("liveScenePerformanceSource（Task 6）", () => {
  it("live 非焦点 NPC 引用另一个 NPC 已发现但未获授权的 Fact 时拒绝整场", () => {
    const focusNpc = makeContext().presentNpcs[0]!;
    const otherNpc = {
      ...focusNpc,
      id: asNpcId("npc_2"),
      name: "过客",
      knownFactCards: [{ factId: asFactId("fact_secret"), text: "另一 NPC 的私密事实" }],
      sceneVisibleFactIds: [asFactId("fact_secret")],
      speechAuthority: OTHER_NPC_SPEECH_AUTHORITY,
      recentInteractionActionIds: [],
    };
    const context = makeContext({ presentNpcs: [focusNpc, otherNpc] });
    const result = parseScenePerformanceJson({
      segments: [{ beatId: ATMOSPHERE_BEAT_ID, text: "炉火在风里轻响。" }],
      npcLine: {
        npcId: "npc_1",
        text: "我会把眼前的事说清楚。你先听我把来龙去脉讲完。",
        emotion: "neutral",
        answeredBeatIds: [],
        usedFactIds: [],
        usedEventIds: [],
      },
      npcDialogues: [{
        npcId: "npc_2",
        text: "那件私事我不该提起，但它确实发生过。",
        usedFactIds: ["fact_secret"],
        usedEventIds: [],
      }],
      objectiveLink: null,
      choices: [
        { candidateId: "candidate_1", label: "继续听" },
        { candidateId: "candidate_2", label: "暂且作罢" },
      ],
    }, context, buildSelectableSceneCandidates(context));

    expect(result).toEqual({ ok: false, reason: "npc_dialogues_invalid" });
  });

  it("live proposal 进入 approval 时，未授权非焦点 Fact 不得写回 scene", () => {
    const focusNpc = makeContext().presentNpcs[0]!;
    const otherNpc = {
      ...focusNpc,
      id: asNpcId("npc_2"),
      name: "过客",
      knownFactCards: [{ factId: asFactId("fact_secret"), text: "另一 NPC 的私密事实" }],
      sceneVisibleFactIds: [asFactId("fact_secret")],
      speechAuthority: OTHER_NPC_SPEECH_AUTHORITY,
      recentInteractionActionIds: [],
    };
    const context = makeContext({ presentNpcs: [focusNpc, otherNpc] });
    const proposal: ScenePerformanceProposal = {
      sceneId: "scene-live-authority",
      segments: [{ beatId: ATMOSPHERE_BEAT_ID, text: "炉火在风里轻响。" }],
      npcLine: {
        npcId: "npc_1",
        text: "我会把眼前的事说清楚。你先听我把来龙去脉讲完。",
        emotion: "neutral",
        answeredBeatIds: [],
        usedFactIds: [],
        usedEventIds: [],
      },
      npcDialogues: [{
        npcId: "npc_2",
        text: "那件私事我不该提起，但它确实发生过。",
        usedFactIds: ["fact_secret"],
        usedEventIds: [],
      }],
      objectiveLink: null,
      choices: [
        { candidateId: "candidate_1", label: "继续听" },
        { candidateId: "candidate_2", label: "暂且作罢" },
      ],
      preparedContinuations: [],
      source: "generated",
    };

    const approved = approveScenePerformance({
      context,
      proposal,
      basedOnRevision: 1,
      existingCandidateEventPool: [],
    });

    expect(approved).toEqual({ ok: false, code: "npc_uses_forbidden_fact" });
  });

  it("prepared live line rejects descriptor visibleFactIds without speaker authority", () => {
    const arrivalNpcId = asNpcId("npc_arrival");
    const context: SceneGenerationContext = {
      ...makeContext(),
      preparedStepDescriptors: [{
        stepId: "prepared_1",
        objectiveKey: "quest_1:0",
        consumptionGroupKey: "quest_1:0:move",
        trigger: { kind: "move", locationId: asLocationId("loc_arrival") },
        authority: {
          questId: asQuestId("quest_1"),
          objectiveIndex: 0,
          allowedEntityIds: [String(arrivalNpcId)],
          visibleFactIds: [asFactId("fact_secret")],
        },
        arrivalNpc: {
          id: arrivalNpcId,
          name: "抵达者",
          role: "守门人",
          publicProfile: "守在新地点的人",
          knownFactCards: [{ factId: asFactId("fact_secret"), text: "不应由此人披露的事实" }],
          sceneVisibleFactIds: [asFactId("fact_secret")],
          goals: ["确认来者身份"],
        },
        choiceCandidates: [
          { candidateId: "prepared_choice_1", action: { type: "talk", npcId: arrivalNpcId, dialogueAct: "support" } },
          { candidateId: "prepared_choice_2", action: { type: "talk", npcId: arrivalNpcId, dialogueAct: "challenge" } },
        ],
        nextStepIds: [],
      }],
    };

    const result = parseScenePerformanceJson({
      segments: [{ beatId: ATMOSPHERE_BEAT_ID, text: "风穿过新地点的门廊。" }],
      npcLine: null,
      objectiveLink: null,
      choices: [
        { candidateId: "candidate_1", label: "继续观察" },
        { candidateId: "candidate_2", label: "先离开这里" },
      ],
      preparedContinuations: [{
        stepId: "prepared_1",
        segments: [{ beatId: "atmosphere", text: "你抵达门廊。" }],
        npcLine: {
          npcId: String(arrivalNpcId),
          text: "我知道那件不该外泄的事。你先听我把来龙去脉说完。",
          emotion: "guarded",
          answeredBeatIds: [],
          usedFactIds: ["fact_secret"],
          usedEventIds: [],
        },
        objectiveLink: null,
        choices: [
          { candidateId: "prepared_choice_1", label: "请继续说" },
          { candidateId: "prepared_choice_2", label: "我会听着" },
        ],
      }],
    }, context, buildSelectableSceneCandidates(context));

    expect(result).toEqual({ ok: false, reason: "prepared_continuations_invalid" });
  });

  it("passes the exact compiled narrative manifest to AI text audit without prompt text", async () => {
    const complete = vi.fn(async (_role: "scene", _messages: readonly unknown[], _ctx?: unknown) =>
      ({ ok: false as const, code: "empty_response" as const, retryable: false, latencyMs: 1 }));
    const source = createLiveScenePerformanceSource({
      aiClient: {
        complete,
        policy: () => ({
          thinking: "off" as const, timeoutMs: 45_000, maxTokens: 3_000,
          jsonMode: "prompt_only" as const, maxAttempts: 2,
        }),
      },
    });

    await source.generateScene(makeContext());

    const auditContext = complete.mock.calls[0]?.[2] as { readonly narrativeContext?: unknown };
    expect(auditContext.narrativeContext).toEqual(expect.objectContaining({
      compilerVersion: 1,
      maxEstimatedTokens: 8_000,
      selectedEstimatedTokens: expect.any(Number),
      overflowEstimatedTokens: expect.any(Number),
      selected: expect.arrayContaining([expect.objectContaining({ id: "scene:rules" })]),
      dropped: expect.any(Array),
    }));
    expect(JSON.stringify(auditContext.narrativeContext)).not.toContain("绝不外泄的私密");
    expect(JSON.stringify(auditContext.narrativeContext)).not.toContain("fact_secret");
  });

  it("reserves enough completion budget for provider reasoning and scene JSON", () => {
    expect(LIVE_SCENE_MAX_TOKENS).toBeGreaterThanOrEqual(3_000);
    expect(LIVE_SCENE_TIMEOUT_MS).toBe(45_000);
  });

  it("生产候选投影：抵达当前主线 NPC 时只提供该 NPC 的两项对白", () => {
    const context = makeContext({
      job: makeJob({
        eventKind: "travel",
        summary: { kind: "move", locationId: asLocationId("loc_2") },
      }),
      legalActionCandidates: [
        { kind: "talk", label: "与老板交谈", targetId: "npc_1" },
        { kind: "move", label: "离开客栈", targetId: "loc_2" },
      ],
      objectiveTarget: {
        questId: asQuestId("quest_0"),
        objectiveIndex: 0,
        entityId: asNpcId("npc_1"),
        entityName: "老板",
      },
    });

    const candidates = buildSelectableSceneCandidates(context);

    expect(candidates).toHaveLength(2);
    expect(candidates.every((candidate) =>
      candidate.action.type === "talk" && String(candidate.action.npcId) === "npc_1",
    )).toBe(true);
  });

  it("生产候选投影：抵达调查地点时不再注入调查方式选项", () => {
    const context = makeContext({
      job: makeJob({
        eventKind: "travel",
        summary: { kind: "move", locationId: asLocationId("loc_2") },
      }),
      objectiveTarget: {
        questId: asQuestId("quest_0"),
        objectiveIndex: 0,
        entityId: asFactId("fact_a"),
        entityName: "门前令牌的来历",
      },
    });
    const candidates = buildSelectableSceneCandidates(context);
    expect(candidates.some((candidate) => candidate.action.type === "investigate")).toBe(false);
  });

  it("bounds live scene generation before deterministic fallback", async () => {
    const context = makeContext();
    const transport = stubTransport(null, "not-json");
    const source = createLiveScenePerformanceSource({ transport, config });

    await source.generateScene(context);

    expect(transport.complete).toHaveBeenCalledWith(
      config,
      expect.any(Array),
      {
        timeoutMs: LIVE_SCENE_TIMEOUT_MS,
        temperature: 0.2,
        extraBody: {
          thinking: { type: "disabled" },
          max_tokens: LIVE_SCENE_MAX_TOKENS,
        },
      },
    );
    expect(LIVE_SCENE_TIMEOUT_MS).toBe(45_000);
  });

  it("uses JSON object mode only when the factory explicitly enables it", async () => {
    const transport = stubTransport(null, "not-json");
    const source = createLiveScenePerformanceSource({ transport, config, jsonMode: "json_object" });

    await source.generateScene(makeContext());

    expect(transport.complete).toHaveBeenCalledWith(
      config,
      expect.any(Array),
      expect.objectContaining({
        extraBody: expect.objectContaining({ response_format: { type: "json_object" } }),
      }),
    );
  });

  it("item 获得：segment 点名精确物品并携带其节拍 ID", async () => {
    const job = makeJob({
      beats: [
        { beatId: "item_0", kind: "item_obtained", subjectIds: ["item_seal"], instruction: "获得物品「盟誓印谱」" },
        { beatId: ATMOSPHERE_BEAT_ID, kind: "atmosphere", subjectIds: [], instruction: "氛围" },
      ],
    });
    const context = makeContext({ job });
    const transport = stubTransport({
      segments: [
        { beatId: "item_0", text: "你获得了盟誓印谱。" },
        { beatId: ATMOSPHERE_BEAT_ID, text: "暮色渐沉。" },
      ],
      npcLine: null,
      objectiveLink: null,
      choices: [
        { candidateId: "candidate_1", label: "支持老板" },
        { candidateId: "candidate_2", label: "质疑老板" },
      ],
    });
    const source = createLiveScenePerformanceSource({ transport, config });
    const proposal = await source.generateScene(context);
    if (!proposal.ok) throw new Error("expected success");
    expect(proposal.proposal.source).toBe("generated");
    const itemSegment = proposal.proposal.segments.find((s) => s.beatId === "item_0");
    expect(itemSegment).toBeDefined();
    expect(itemSegment!.text).toContain("盟誓印谱");
  });

  it("battle 结算：segment 表述胜利/撤退并携带当前 HP，不与规则结果矛盾", async () => {
    const job = makeJob({
      eventKind: "battle",
      summary: { kind: "battle_action", action: "attack" },
      beats: [
        { beatId: "battle_0", kind: "battle_resolved", subjectIds: ["enemy_1"], instruction: "与野狼的战斗以胜利告终" },
        { beatId: ATMOSPHERE_BEAT_ID, kind: "atmosphere", subjectIds: [], instruction: "氛围" },
      ],
    });
    const context = makeContext({
      job,
      legalActionCandidates: [
        { kind: "battle_action", label: "攻击", targetId: "attack" },
        { kind: "battle_action", label: "防守", targetId: "guard" },
        { kind: "battle_action", label: "撤退", targetId: "flee" },
      ],
    });
    const transport = stubTransport({
      segments: [
        { beatId: "battle_0", text: "你击败了野狼，当前生命值 80。" },
        { beatId: ATMOSPHERE_BEAT_ID, text: "风渐渐平息。" },
      ],
      npcLine: null,
      objectiveLink: null,
      choices: [
        { candidateId: "candidate_1", label: "继续探索" },
        { candidateId: "candidate_2", label: "前往街道" },
      ],
    });
    const source = createLiveScenePerformanceSource({ transport, config });
    const proposal = await source.generateScene(context);
    if (!proposal.ok) throw new Error("expected success");
    const battleSegment = proposal.proposal.segments.find((s) => s.beatId === "battle_0");
    expect(battleSegment).toBeDefined();
    expect(battleSegment!.text).toContain("击败");
    expect(battleSegment!.text).toContain("80");
    expect(battleSegment!.text).not.toContain("败北");
  });

  it("current_resolution 先于 recentBeats，且 parser 只接受当前 mandatory beat ID", () => {
    const job = makeJob({
      beats: [{
        beatId: "item_0",
        kind: "item_obtained",
        subjectIds: ["item_seal"],
        instruction: "服务端已结算：玩家获得盟誓印谱",
      }],
    });
    const context: SceneGenerationContext = {
      ...makeContext({ job }),
    };
    const prompt = buildLiveScenePrompt(context, buildSelectableSceneCandidates(context));

    const currentResolutionIndex = prompt.indexOf("## [current_resolution]");
    expect(currentResolutionIndex).toBeGreaterThanOrEqual(0);
    expect(currentResolutionIndex).toBeLessThan(prompt.indexOf("## [current_location]"));
    expect(prompt).toContain("服务端已结算");
    expect(prompt).toContain("不得改写已结算结果");

    const parsed = parseScenePerformanceJson({
      segments: [{ beatId: "old_memory", text: "仍未获得。" }],
      npcLine: null,
      npcDialogues: [],
      objectiveLink: null,
      choices: [
        { candidateId: "candidate_1", label: "继续核对" },
        { candidateId: "candidate_2", label: "查看四周" },
      ],
    }, context, buildSelectableSceneCandidates(context));
    expect(parsed).toEqual({ ok: false, reason: "segment_unknown_beat" });
  });

  it("任务推进：segment 点名下一目标实体，objectiveLink 与 HUD 目标一致", async () => {
    const transition: ObjectiveTransition = {
      before: { questId: asQuestId("quest_0"), objectiveIndex: 0, label: "与老板交谈" },
      completed: [],
      after: { questId: asQuestId("quest_0"), objectiveIndex: 1, label: "获取盟誓印谱" },
      mode: "advanced_act",
    };
    const job = makeJob({
      eventKind: "travel",
      summary: { kind: "move", locationId: asLocationId("loc_2") },
      transition,
      beats: [
        { beatId: "quest_adv_0", kind: "quest_advanced", subjectIds: ["quest_0"], instruction: "主线推进，当前目标：获取盟誓印谱" },
        { beatId: ATMOSPHERE_BEAT_ID, kind: "atmosphere", subjectIds: [], instruction: "氛围" },
      ],
    });
    const context = makeContext({
      job,
      objectiveTarget: { questId: "quest_0", objectiveIndex: 1, entityId: "item_seal", entityName: "盟誓印谱" },
      legalActionCandidates: [
        { kind: "explore", label: "查看四周" },
        { kind: "move", label: "前往街道", targetId: "loc_2" },
      ],
    });
    const transport = stubTransport({
      segments: [
        {
          beatId: "quest_adv_0",
          text: "线索沿着旧道延伸，下一步需要核对现场。",
          referencedEntityIds: ["item_seal"],
        },
        { beatId: ATMOSPHERE_BEAT_ID, text: "暮色渐沉。" },
      ],
      npcLine: null,
      objectiveLink: { questId: "quest_0", objectiveIndex: 1, mode: "handoff" },
      choices: [
        { candidateId: "candidate_1", label: "查看四周" },
        { candidateId: "candidate_2", label: "前往街道" },
      ],
    });
    const source = createLiveScenePerformanceSource({ transport, config });
    const proposal = await source.generateScene(context);
    if (!proposal.ok) throw new Error("expected success");
    const advanced = proposal.proposal.segments.find((s) => s.beatId === "quest_adv_0");
    expect(advanced).toBeDefined();
    expect(advanced!.text).not.toContain("盟誓印谱");
    expect(advanced!.referencedEntityIds).toEqual(["item_seal"]);
    expect(proposal.proposal.objectiveLink).toEqual({ questId: "quest_0", objectiveIndex: 1, mode: "handoff" });
    expect(proposal.proposal.objectiveLink!.questId).toBe(String(context.objectiveTransition.after!.questId));
    expect(proposal.proposal.objectiveLink!.objectiveIndex).toBe(context.objectiveTransition.after!.objectiveIndex);
  });

  it("对话收尾使用本地 acknowledgement，不生成可执行选项", () => {
    const transition: ObjectiveTransition = {
      before: { questId: asQuestId("quest_0"), objectiveIndex: 0, label: "与老板交谈" },
      completed: [{ questId: asQuestId("quest_0"), objectiveIndex: 0, label: "与老板交谈" }],
      after: { questId: asQuestId("quest_0"), objectiveIndex: 1, label: "前往街道" },
      mode: "progressed",
    };
    const context = makeContext({ job: makeJob({ transition }), dialogueSessionCompleted: true });
    const response = {
      segments: [{ beatId: ATMOSPHERE_BEAT_ID, text: "老板把声音压低了。" }],
      npcLine: {
        npcId: "npc_1", text: "线索就在街道尽头。你现在过去，正好能赶上留下的痕迹。",
        emotion: "neutral", answeredBeatIds: [], usedFactIds: [], usedEventIds: [],
      },
      objectiveLink: { questId: "quest_0", objectiveIndex: 1, mode: "progress" },
      handoffAcknowledgement: "（你向老板抱拳道谢，转身前往街道。）",
    };
    const valid = parseScenePerformanceJson({
      ...response,
      choices: [],
    }, context, buildSelectableSceneCandidates(context));
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.proposal.choices).toHaveLength(0);
      expect(valid.proposal.handoffAcknowledgement).toBe(response.handoffAcknowledgement);
    }
    const extraChoice = parseScenePerformanceJson({
      ...response,
      choices: [
        { candidateId: "candidate_1", label: "我这就去街道核对。" },
        { candidateId: "candidate_2", label: "知道了" },
      ],
    }, context, buildSelectableSceneCandidates(context));
    expect(extraChoice).toEqual({ ok: false, reason: "choices_invalid" });
  });

  it("幕交接解析旧焦点 NPC 台词与同次 API 生成的非焦点 NPC 闲聊", () => {
    const transition: ObjectiveTransition = {
      before: { questId: asQuestId("quest_0"), objectiveIndex: 0, label: "与老周交谈" },
      completed: [],
      after: { questId: asQuestId("quest_0"), objectiveIndex: 1, label: "与赵四交谈" },
      mode: "advanced_act",
    };
    const job = makeJob({
      transition,
      beats: [
        { beatId: "quest_adv_0", kind: "quest_advanced", subjectIds: ["quest_0"], instruction: "交接到赵四" },
        { beatId: ATMOSPHERE_BEAT_ID, kind: "atmosphere", subjectIds: [], instruction: "氛围" },
      ],
    });
    const context: SceneGenerationContext = {
      ...makeContext({
        job,
        presentNpcs: [
          makeContext().presentNpcs[0]!,
          {
            ...makeContext().presentNpcs[0]!,
            id: asNpcId("npc_2"),
            name: "赵四",
            role: "客栈掌柜",
            recentInteractionActionIds: [],
          },
        ],
        objectiveTarget: { questId: "quest_0", objectiveIndex: 1, entityId: "npc_2", entityName: "赵四" },
      }),
      narrativeReferenceIds: ["npc_1", "npc_2", "quest_0"],
      focusNpcContext: {
        ...makeContext().focusNpcContext!,
        id: asNpcId("npc_1"),
        name: "老板",
      },
    };
    const result = parseScenePerformanceJson({
      segments: [
        { beatId: "quest_adv_0", text: "线索把你引向赵四。", referencedEntityIds: ["npc_2"] },
        { beatId: ATMOSPHERE_BEAT_ID, text: "暮色渐沉。" },
      ],
      npcLine: {
        npcId: "npc_1",
        text: "旧案的线索我会说清楚。你去客栈找赵四，他见过那晚的来客。",
        emotion: "neutral",
        answeredBeatIds: [],
        usedFactIds: [],
        usedEventIds: [],
      },
      npcDialogues: [{
        npcId: "npc_2",
        text: "客官若要打听旧案，先坐下喝口热茶。店里的出入我记得几分。",
        usedFactIds: [],
        usedEventIds: [],
      }],
      objectiveLink: { questId: "quest_0", objectiveIndex: 1, mode: "handoff" },
      choices: [
        { candidateId: "candidate_1", label: "去客栈找赵四" },
        { candidateId: "candidate_2", label: "先在路边观察" },
      ],
    }, context, buildSelectableSceneCandidates(context));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal.npcLine?.npcId).toBe("npc_1");
    expect(result.proposal.npcDialogues).toEqual([
      {
        npcId: "npc_2",
        text: "客官若要打听旧案，先坐下喝口热茶。店里的出入我记得几分。",
        usedFactIds: [],
        usedEventIds: [],
      },
    ]);
  });

  it("非焦点 NPC 对白不能静默接受未知、重复或焦点 NPC 条目", () => {
    const context = makeContext({
      presentNpcs: [
        makeContext().presentNpcs[0]!,
        { ...makeContext().presentNpcs[0]!, id: asNpcId("npc_2"), name: "赵四" },
      ],
    });
    const base = {
      segments: [{ beatId: ATMOSPHERE_BEAT_ID, text: "炉火轻响。" }],
      npcLine: { npcId: "npc_1", text: "旧案我会说清楚。你先听我把线索交代完。", emotion: "neutral", answeredBeatIds: [], usedFactIds: [], usedEventIds: [] },
      objectiveLink: null,
      choices: [
        { candidateId: "candidate_1", label: "继续追问" },
        { candidateId: "candidate_2", label: "先观察" },
      ],
    };
    for (const npcDialogues of [
      [{ npcId: "ghost", text: "我不在这里。" }],
      [{ npcId: "npc_2", text: "我在。" }, { npcId: "npc_2", text: "又来一遍。" }],
      [{ npcId: "npc_1", text: "焦点不应重复。" }],
    ]) {
      const result = parseScenePerformanceJson({ ...base, npcDialogues }, context, buildSelectableSceneCandidates(context));
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe("npc_dialogues_invalid");
    }
  });

  it("prompt 包含必需安全段落：玩家原话、合法选项 ID、目标、焦点 NPC；不泄漏私密正文/账本", async () => {
    const job = makeJob({
      utterance: "商队失踪的事你知道吗？",
      transition: {
        before: null,
        completed: [],
        after: { questId: asQuestId("quest_0"), objectiveIndex: 0, label: "与老板交谈" },
        mode: "unchanged",
      },
      beats: [{ beatId: "player_utterance", kind: "player_utterance", subjectIds: ["npc_1"], instruction: "直接回应玩家" }],
    });
    const context = makeContext({ job });
    const selectable = buildSelectableSceneCandidates(context);
    const prompt = buildLiveScenePrompt(context, selectable);
    expect(prompt).toContain("商队失踪的事你知道吗？"); // 当前玩家原话 TEXT 进入提示词
    expect(prompt).toContain("玩家角色=侠客（剑客）");
    expect(prompt).toContain("玩家只能被称为“侠客”");
    expect(prompt).toContain("candidate_1");
    expect(prompt).toContain("candidate_2");
    const candidateSection = prompt.match(/## \[legal_actions\] 合法候选动作\n([\s\S]*?)(?=\n## |$)/u)?.[1] ?? "";
    expect(candidateSection).toContain("candidate_1");
    expect(candidateSection).toContain("candidate_2");
    expect(candidateSection).not.toContain("请把你刚才提到的这条线索");
    expect(candidateSection).not.toContain("哪一件原始证物");
    expect(prompt).toContain("客栈");
    expect(prompt).toContain("与老板交谈"); // 目标 label
    expect(prompt).toContain("老板"); // 焦点 NPC
    expect(prompt).toContain("已知线索"); // 允许披露事实正文可写进台词
    expect(prompt).toContain("商队失踪案背后的内应");
    expect(prompt).toContain("currentAct=1");
    expect(prompt).toContain("tension=30");
    expect(prompt).toContain("nextPacingNeed=reveal");
    expect(prompt).toContain("历史交互 Event IDs（不可引用）=[turn-1:interaction-1]");
    expect(prompt).toContain("turn-1:interaction-1");
    expect(prompt).not.toContain("绝不外泄的私密"); // 私密事实正文绝不出现
    expect(prompt).not.toContain("eventLedger");
    // Task 8：政策指令作为【风格政策】段落整体出现
    const policy = buildStylePolicy({ personalityTags: ["冷静"], narrativeStyle: "concise", contentIntensity: "normal" });
    expect(prompt).toContain(policy.narrationInstruction);
    expect(prompt).toContain(policy.intensityInstruction);
    expect(prompt).toContain("不得输出“主线推进到第X幕”“已完成：”“当前目标：”等系统元话术");
    expect(prompt).toContain("先完成 npcLine，再根据本轮 npcLine 的文本和 usedFactIds 生成 choices");
  });

  it("prompt retains all five structured focus interactions", () => {
    const base = makeContext();
    const interactionIds = ["evt:perf:0", "evt:perf:1", "evt:perf:2", "evt:perf:3", "evt:perf:4"];
    const context: SceneGenerationContext = {
      ...base,
      focusNpcContext: {
        ...base.focusNpcContext!,
        recentInteractions: interactionIds.map((actionId, index) => ({
          eventId: asEventId(`evt:perf:${index}`),
          actionId,
          dialogueAct: "ask" as const,
          topicSummary: `主题${index + 1}`,
          outcome: "neutral" as const,
          summary: `交互摘要${index + 1}`,
        })),
      },
    };

    const prompt = buildLiveScenePrompt(context, buildSelectableSceneCandidates(context));
    for (const actionId of interactionIds) expect(prompt).toContain(actionId);
  });

  it("解析场景时只保留服务端允许的结构化叙事引用，不把未知 ID 传给审批层", () => {
    const context = makeContext();
    const result = parseScenePerformanceJson(
      {
        segments: [
          {
            beatId: ATMOSPHERE_BEAT_ID,
            text: "炉火在风里轻响。",
            referencedEntityIds: ["item_seal", "not_allowed", "item_seal"],
          },
        ],
        npcLine: null,
        objectiveLink: null,
        choices: [
          { candidateId: "candidate_1", label: "查看四周" },
          { candidateId: "candidate_2", label: "与老板交谈" },
        ],
      },
      context,
      buildSelectableSceneCandidates(context),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal.segments[0]!.referencedEntityIds).toEqual(["item_seal"]);
  });

  it("开局没有强制节拍时，prompt 明确要求唯一合法的 atmosphere 段，避免空 segments 降级", () => {
    const context = makeContext({ job: makeJob({ beats: [] }) });

    const prompt = buildLiveScenePrompt(context, buildSelectableSceneCandidates(context));

    expect(prompt).toContain("当前没有其他强制节拍");
    expect(prompt).toContain("beatId 为 atmosphere");
    expect(prompt).toContain("不得返回空数组");
  });

  it("成功生成合法场景时只调用一次 AI complete", async () => {
    const complete = vi.fn(async () => ({
      ok: true as const,
      content: JSON.stringify({
        segments: [{ beatId: ATMOSPHERE_BEAT_ID, text: "炉火映亮桌角。" }],
        npcLine: {
          npcId: "npc_1",
          text: "旧案我会说明。你先核对账册。",
          emotion: "neutral",
          answeredBeatIds: [],
          usedFactIds: [],
          usedEventIds: [],
        },
        npcDialogues: [],
        objectiveLink: null,
        choices: [
          { candidateId: "candidate_1", label: "请说清旧案" },
          { candidateId: "candidate_2", label: "（查看账册）" },
        ],
      }),
      latencyMs: 1,
    }));
    const aiClient = {
      complete,
      policy: () => ({
        thinking: "off" as const,
        timeoutMs: 45_000,
        maxTokens: 3_000,
        jsonMode: "prompt_only" as const,
        maxAttempts: 1,
      }),
    };

    const result = await createLiveScenePerformanceSource({ aiClient }).generateScene(makeContext());

    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.proposal.source).toBe("generated");
    expect(result.proposal.segments).toEqual([{ beatId: ATMOSPHERE_BEAT_ID, text: "炉火映亮桌角。" }]);
    expect(result.proposal.npcLine).toEqual({
      npcId: "npc_1",
      text: "旧案我会说明。你先核对账册。",
      emotion: "neutral",
      answeredBeatIds: [],
      usedFactIds: [],
      usedEventIds: [],
    });
  });

  it("后续对话 prompt 注入上一句 NPC 台词、玩家选项和结构化主题", () => {
    const context: SceneGenerationContext = {
      ...makeContext(),
      previousDialogue: {
        npcId: asNpcId("npc_1"),
        npcLine: "北巷的车轮印还在泥里，赶车人的左手缠着血布。",
        selectedChoice: {
          label: "我愿意继续查。",
          dialogueAct: "support",
          topic: { kind: "thread", threadId: "main_thread" },
        },
      },
    };
    const prompt = buildLiveScenePrompt(context, buildSelectableSceneCandidates(context));
    expect(prompt).toContain("上一轮 NPC 原话=北巷的车轮印还在泥里，赶车人的左手缠着血布。");
    expect(prompt).toContain("玩家上一轮选择=我愿意继续查。");
    expect(prompt).toContain("主题=thread");
    expect(prompt).toContain("若有上一轮 NPC 原话，必须先直接承接");
  });

  it("解析 live 场景时按本轮 npcLine 重建 talk 选项，而不是沿用上一轮锚点", () => {
    const previousLine = "告示的这案子，镇上没人敢多嘴。";
    const currentLine = "墙上只留一个血写的‘崖’字。官府说是山匪所为，可江湖上谁信呢？";
    const context: SceneGenerationContext = {
      ...makeContext(),
      previousDialogue: {
        npcId: asNpcId("npc_1"),
        npcLine: previousLine,
        selectedChoice: { dialogueAct: "support", topic: { kind: "general" } },
      },
    };
    const result = parseScenePerformanceJson(
      {
        segments: [{ beatId: ATMOSPHERE_BEAT_ID, text: "炉火在风里轻响。" }],
        npcLine: {
          npcId: "npc_1",
          text: currentLine,
          emotion: "neutral",
          answeredBeatIds: [],
          usedFactIds: [],
          usedEventIds: [],
        },
        objectiveLink: null,
        choices: [
          { candidateId: "candidate_1", label: "旧标签一" },
          { candidateId: "candidate_2", label: "旧标签二" },
        ],
      },
      context,
      buildSelectableSceneCandidates(context),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const labels = result.proposal.choices.map((choice) => choice.label).join(" ");
    expect(labels).not.toContain(previousLine);
    expect(labels).not.toContain(currentLine);
    expect(labels).toContain("旧标签一");
    expect(labels).toContain("旧标签二");
  });

  it("AI 复用上一轮 fallback 选项时只返回可修复原因，不在 source 内重试", async () => {
    const logger = { warn: vi.fn() };
    const context: SceneGenerationContext = {
      ...makeContext(),
      previousDialogue: {
        npcId: asNpcId("npc_1"),
        npcLine: "我知道一些风声，但还不能替你下结论。",
        selectedChoice: { dialogueAct: "support", topic: { kind: "general" } },
      },
    };
    const staleLabels = buildSelectableSceneCandidates(context).map((choice) => ({
      candidateId: choice.candidateId,
      label: choice.label,
    }));
    let attempts = 0;
    const transport: AiTransport = {
      complete: vi.fn(async () => {
        attempts += 1;
        return {
          ok: true as const,
          content: JSON.stringify({
            segments: [{ beatId: ATMOSPHERE_BEAT_ID, text: "酒肆里的火苗轻轻一晃。" }],
            npcLine: {
              npcId: "npc_1",
              text: "这把刀上的旧痕确实与旧案有关，但来历还要当面核对。你若要查，就先说明自己为何认得这道痕。",
              emotion: "neutral",
              answeredBeatIds: [],
              usedFactIds: ["fact_a"],
              usedEventIds: [],
            },
            objectiveLink: null,
            choices: attempts === 1
              ? staleLabels
              : [
                  { candidateId: "candidate_1", label: "这道痕确实来自我曾押镖的地方，你先把你知道的案情说清楚。" },
                  { candidateId: "candidate_2", label: "你若只是试探我，就先说清这道痕和旧案究竟有什么关系。" },
                ],
          }),
          latencyMs: 1,
        };
      }),
    } as unknown as AiTransport;

    const proposal = await createLiveScenePerformanceSource({
      transport,
      config,
      logger: logger as never,
    }).generateScene(context);

    expect(attempts).toBe(1);
    expect(proposal.ok).toBe(false);
    if (proposal.ok) throw new Error("expected repairable failure");
    expect(proposal.repairReason).toBe("choices_stale_template");
    expect(logger.warn).not.toHaveBeenCalledWith("scene_generation_content_retry", expect.anything());
  });

  it("非法 beatId 返回字段级修复原因，供自动重试精准修复", async () => {
    const source = createLiveScenePerformanceSource({
      transport: stubTransport({
        segments: [{ beatId: "act_1", text: "错误节拍" }],
        npcLine: null,
        objectiveLink: null,
        choices: [
          { candidateId: "candidate_1", label: "继续核对" },
          { candidateId: "candidate_2", label: "先观察现场" },
        ],
      }),
      config,
    });

    const proposal = await source.generateScene(makeContext());

    expect(proposal.ok).toBe(false);
    if (proposal.ok) throw new Error("expected repairable failure");
    expect(proposal.repairReason).toBe("segment_unknown_beat");
  });

  it("新 NPC 首次回应也拒绝当前场景的 fallback 选项模板", () => {
    const context = makeContext();
    const staleLabels = buildSelectableSceneCandidates(context).map((choice) => ({
      candidateId: choice.candidateId,
      label: choice.label,
    }));
    const result = parseScenePerformanceJson(
      {
        segments: [{ beatId: ATMOSPHERE_BEAT_ID, text: "门外风声一紧。" }],
        npcLine: {
          npcId: "npc_1",
          text: "那面旗确实有人见过，但我不会只凭传闻替你下结论。你若要查，就先说清楚要从哪一步开始。",
          emotion: "neutral",
          answeredBeatIds: [],
          usedFactIds: ["fact_a"],
          usedEventIds: [],
        },
        objectiveLink: null,
        choices: staleLabels,
      },
      context,
      buildSelectableSceneCandidates(context),
    );

    expect(result).toEqual({ ok: false, reason: "choices_stale_template" });
  });

  it("AI 返回不可解析 JSON → 返回稳定格式失败，不调用 deterministic source", async () => {
    const context = makeContext();
    const transport = stubTransport(null, "这不是 JSON");
    const source = createLiveScenePerformanceSource({ transport, config });
    const proposal = await source.generateScene(context);
    expect(proposal.ok).toBe(false);
    if (proposal.ok) throw new Error("expected failure");
    expect(proposal.failure.kind).toBe("AI_RESPONSE_INVALID");
  });

  it("最终结构非法时只记录安全形状，不记录模型文本", async () => {
    const logger = { warn: vi.fn() };
    const source = createLiveScenePerformanceSource({
      transport: stubTransport({ segments: [], npcLine: null, objectiveLink: null, choices: [] }),
      config,
      logger: logger as never,
    });

    await source.generateScene(makeContext());

    expect(logger.warn).toHaveBeenCalledWith("scene_generation_invalid_data", {
      reason: "segments_empty",
      object: true,
      keys: "choices,npcLine,objectiveLink,segments",
      segmentCount: 0,
      npcLineKind: "null",
      choiceCount: 0,
      objectiveLinkKind: "null",
    });
  });

  it("解析场景候选时返回具体的契约失败原因", () => {
    const result = parseScenePerformanceJson(
      {
        segments: [{ beatId: "invented", text: "不采用的旁白" }],
        npcLine: null,
        objectiveLink: null,
        choices: [],
      },
      makeContext(),
      buildSelectableSceneCandidates(makeContext()),
    );

    expect(result).toEqual({ ok: false, reason: "segment_unknown_beat" });
  });

  it("parses linearActionNarratives for upcoming investigate/move objectives", () => {
    const context: SceneGenerationContext = {
      ...makeContext(),
      upcomingLinearObjectives: [
        {
          kind: "discover_fact",
          factId: asFactId("fact_wheel"),
          investigationLabel: "酒楼后巷的车轮印",
          factText: "车轮印在后巷泥水中断续向北延伸，指向北巷旧道深处的旧镖局废墟。",
          nextObjectiveEntityName: "北巷旧道",
        },
        {
          kind: "visit_location",
          locationId: asLocationId("loc_north_lane"),
          locationName: "北巷旧道",
        },
      ],
    };
    const selectable = buildSelectableSceneCandidates(context);
    const valid = parseScenePerformanceJson(
      {
        segments: [{ beatId: ATMOSPHERE_BEAT_ID, text: "暮色渐沉。" }],
        npcLine: null,
        objectiveLink: null,
        choices: [
          { candidateId: "candidate_1", label: "支持老板" },
          { candidateId: "candidate_2", label: "质疑老板" },
        ],
        linearActionNarratives: [
          { actionKind: "investigate", factId: "fact_wheel", narration: "泥水里的车轮印断续向北，直指北巷旧道。" },
          { actionKind: "move", locationId: "loc_north_lane", narration: "你沿旧道向北行去。" },
        ],
      },
      context,
      selectable,
    );
    expect(valid.ok).toBe(true);
    if (!valid.ok) return;
    expect(valid.proposal.preparedContinuations).toEqual([]);

    const invalid = parseScenePerformanceJson(
      {
        segments: [{ beatId: ATMOSPHERE_BEAT_ID, text: "暮色渐沉。" }],
        npcLine: null,
        objectiveLink: null,
        choices: [
          { candidateId: "candidate_1", label: "支持老板" },
          { candidateId: "candidate_2", label: "质疑老板" },
        ],
        linearActionNarratives: [
          { actionKind: "investigate", factId: "invented_fact", narration: "捏造的证物。" },
        ],
      },
      context,
      selectable,
    );
    expect(invalid.ok).toBe(true);
    if (!invalid.ok) return;
    expect(invalid.proposal.preparedContinuations).toEqual([]);

    const moveOnly: SceneGenerationContext = {
      ...makeContext(),
      upcomingLinearObjectives: [
        {
          kind: "visit_location",
          locationId: asLocationId("loc_north_lane"),
          locationName: "北巷旧道",
        },
      ],
    };
    const partialLogger = { warn: vi.fn() };
    const partiallyValid = parseScenePerformanceJson(
      {
        segments: [{ beatId: ATMOSPHERE_BEAT_ID, text: "暮色渐沉。" }],
        npcLine: null,
        objectiveLink: null,
        choices: [
          { candidateId: "candidate_1", label: "支持老板" },
          { candidateId: "candidate_2", label: "质疑老板" },
        ],
        linearActionNarratives: [
          { actionKind: "investigate", factId: "fact_1", narration: "不在当前目标链中的调查。" },
          { actionKind: "move", locationId: "loc_north_lane", narration: "你沿旧道向北行去。" },
        ],
      },
      moveOnly,
      buildSelectableSceneCandidates(moveOnly),
      partialLogger,
    );
    expect(partiallyValid.ok).toBe(true);
    if (!partiallyValid.ok) return;
    expect(partiallyValid.proposal.preparedContinuations).toEqual([]);
    /*
      { actionKind: "move", locationId: "loc_north_lane", narration: "你沿旧道向北行去。" },
    ]);
    expect(partialLogger.warn).toHaveBeenCalledWith("linear_narrative_entries_ignored", {
      sceneId: "scene-job_1",
      ignoredCount: 1,
      acceptedCount: 1,
    }); */
  });

  it("requires and preserves the target NPC dialogue on a pre-generated move", () => {
    const context: SceneGenerationContext = {
      ...makeContext(),
      upcomingLinearObjectives: [{
        kind: "visit_location",
        locationId: asLocationId("loc_iron_flag_bureau"),
        locationName: "铁旗镖局旧址",
        nextObjectiveEntityName: "老镖师赵铁山",
        arrivalNpc: {
          id: asNpcId("npc_zhaotieshan"),
          name: "老镖师赵铁山",
          role: "老镖师",
          publicProfile: "守在旧址附近的老镖师",
          knownFactCards: [{ factId: asFactId("fact_escort"), text: "亲眼见过镖局出事当晚的经过" }],
          sceneVisibleFactIds: [],
          goals: ["查明镖局旧案"],
        },
      }],
    };
    const selectable = buildSelectableSceneCandidates(context);
    const response = {
      segments: [{ beatId: ATMOSPHERE_BEAT_ID, text: "暮色压在旧道尽头。" }],
      npcLine: null,
      objectiveLink: null,
      choices: [
        { candidateId: "candidate_1", label: "观察旧址" },
        { candidateId: "candidate_2", label: "整理线索" },
      ],
      linearActionNarratives: [{
        actionKind: "move",
        locationId: "loc_iron_flag_bureau",
        narration: "你沿着旧道赶往铁旗镖局旧址。",
        arrivalNpcLine: {
          npcId: "npc_zhaotieshan",
          text: "你就是来查旧镖局的人吧。镖局出事那晚，我亲眼见过一件关键的事。",
          emotion: "guarded",
          usedFactIds: ["fact_escort"],
        },
      }],
    };
    const valid = parseScenePerformanceJson(response, context, selectable);
    expect(valid.ok).toBe(true);
    if (!valid.ok) return;
    expect(valid.proposal.preparedContinuations).toEqual([]);
    /*
      actionKind: "move",
      locationId: "loc_iron_flag_bureau",
      narration: "你沿着旧道赶往铁旗镖局旧址。",
      arrivalNpcLine: {
        npcId: "npc_zhaotieshan",
        text: "你就是来查旧镖局的人吧。镖局出事那晚，我亲眼见过一件关键的事。",
        emotion: "guarded",
        usedFactIds: ["fact_escort"],
      },
    }]); */

    const missing = parseScenePerformanceJson({
      ...response,
      linearActionNarratives: [{
        actionKind: "move",
        locationId: "loc_iron_flag_bureau",
        narration: "你沿着旧道赶往铁旗镖局旧址。",
      }],
    }, context, selectable);
    expect(missing.ok).toBe(true);
    if (missing.ok) expect(missing.proposal.preparedContinuations).toEqual([]);
  });

  it("does not expose the superseded single-line prompt contract", () => {
    const context: SceneGenerationContext = {
      ...makeContext(),
      upcomingLinearObjectives: [{
        kind: "visit_location",
        locationId: asLocationId("loc_iron_flag_bureau"),
        locationName: "铁旗镖局旧址",
        arrivalNpc: {
          id: asNpcId("npc_zhaotieshan"),
          name: "老镖师赵铁山",
          role: "老镖师",
          publicProfile: "守在旧址附近的老镖师",
          knownFactCards: [{ factId: asFactId("fact_escort"), text: "亲眼见过镖局出事当晚的经过" }],
          sceneVisibleFactIds: [],
          goals: ["查明镖局旧案"],
        },
      }],
    };
    const prompt = buildLiveScenePrompt(context, buildSelectableSceneCandidates(context));
    expect(prompt).toContain("preparedContinuations");
    expect(prompt).not.toContain("arrivalNpcLine");
    expect(prompt).not.toContain("linearActionNarratives");
  });

  it("prompt 统一要求 preparedContinuations，不再要求 linearActionNarratives", () => {
    const withLinear: SceneGenerationContext = {
      ...makeContext(),
      upcomingLinearObjectives: [
        {
          kind: "discover_fact",
          factId: asFactId("fact_wheel"),
          investigationLabel: "酒楼后巷的车轮印",
          factText: "车轮印在后巷泥水中断续向北延伸，指向北巷旧道深处的旧镖局废墟。",
          nextObjectiveEntityName: "北巷旧道",
        },
        {
          kind: "visit_location",
          locationId: asLocationId("loc_north_lane"),
          locationName: "北巷旧道",
        },
      ],
    };
    const prompt = buildLiveScenePrompt(withLinear, buildSelectableSceneCandidates(withLinear));
    expect(prompt).toContain("preparedContinuations");
    expect(prompt).not.toContain("linearActionNarratives");

    const moveOnly: SceneGenerationContext = {
      ...makeContext(),
      upcomingLinearObjectives: [
        {
          kind: "visit_location",
          locationId: asLocationId("loc_north_lane"),
          locationName: "北巷旧道",
        },
      ],
    };
    const moveOnlyPrompt = buildLiveScenePrompt(moveOnly, buildSelectableSceneCandidates(moveOnly));
    expect(moveOnlyPrompt).toContain("preparedContinuations");
    expect(moveOnlyPrompt).not.toContain('"actionKind":"move"');

    const plain = buildLiveScenePrompt(makeContext(), buildSelectableSceneCandidates(makeContext()));
    expect(plain).toContain("preparedContinuations");
    expect(plain).not.toContain("单线行动预告（AI 预生成");
  });

  it("契约失败时返回 typed repair reason，由外层决定是否重试", async () => {
    const logger = { warn: vi.fn() };
    let attempts = 0;
    const transport: AiTransport = {
      complete: vi.fn(async () => {
        attempts += 1;
        if (attempts === 2) {
          return {
            ok: true as const,
            content: JSON.stringify({
              segments: [{ beatId: ATMOSPHERE_BEAT_ID, text: "修复后的旁白。" }],
              npcLine: null,
              objectiveLink: null,
              choices: [
                { candidateId: "candidate_1", label: "继续核对" },
                { candidateId: "candidate_2", label: "先观察现场" },
              ],
            }),
            latencyMs: 1,
          };
        }
        return {
          ok: true as const,
          content: JSON.stringify({
            segments: [],
            npcLine: null,
            objectiveLink: null,
            choices: [],
          }),
          latencyMs: 1,
        };
      }),
    } as unknown as AiTransport;

    const proposal = await createLiveScenePerformanceSource({
      transport,
      config,
      logger: logger as never,
    }).generateScene(makeContext());

    expect(proposal.ok).toBe(false);
    if (proposal.ok) throw new Error("expected repairable failure");
    expect(proposal.repairReason).toBe("segments_empty");
    expect(attempts).toBe(1);
    expect(logger.warn).not.toHaveBeenCalledWith("scene_generation_content_retry", expect.anything());
  });

  it("内容契约失败只请求一次并返回稳定失败", async () => {
    const logger = { warn: vi.fn() };
    let attempts = 0;
    const transport: AiTransport = {
      complete: vi.fn(async () => {
        attempts += 1;
        return {
          ok: true as const,
          content: JSON.stringify({
            segments: [],
            npcLine: null,
            objectiveLink: null,
            choices: [],
          }),
          latencyMs: 1,
        };
      }),
    } as unknown as AiTransport;

    const proposal = await createLiveScenePerformanceSource({
      transport,
      config,
      logger: logger as never,
    }).generateScene(makeContext());

    expect(proposal.ok).toBe(false);
    if (proposal.ok) throw new Error("expected failure");
    expect(proposal.failure.kind).toBe("AI_RESPONSE_INVALID");
    expect(attempts).toBe(1);
    expect(proposal.repairReason).toBe("segments_empty");
    expect(logger).toMatchObject({ warn: expect.any(Function) });
    expect(logger.warn).toHaveBeenCalledWith("scene_generation_invalid_data", {
      reason: "segments_empty",
      object: true,
      keys: "choices,npcLine,objectiveLink,segments",
      segmentCount: 0,
      npcLineKind: "null",
      choiceCount: 0,
      objectiveLinkKind: "null",
    });
  });

  it("JSON mode 返回非法字符串字段时返回稳定格式失败", async () => {
    const context = makeContext({
      job: makeJob({
        utterance: "商队失踪的事你知道吗？",
        beats: [{ beatId: "player_utterance", kind: "player_utterance", subjectIds: ["npc_1"], instruction: "直接回应玩家" }],
      }),
    });
    const logger = { info: vi.fn(), warn: vi.fn() };
    const transport = stubTransport({
      segments: [{ beatId: "invented", text: "不采用的旁白" }],
      npcLine: "商队离开前，有人用松脂封住了后门的锁孔。去巷口找那枚沾松脂的铜钱，它能证明谁来过。",
      objectiveLink: null,
      choices: ["继续问", "观察", "离开"],
    });

    const proposal = await createLiveScenePerformanceSource({ transport, config, logger: logger as never }).generateScene(context);
    expect(proposal.ok).toBe(false);
    if (proposal.ok) throw new Error("expected failure");
    expect(proposal.failure.kind).toBe("AI_RESPONSE_INVALID");
  });

  it("局部 live 修复仍失败时不写入 fallback 选项", async () => {
    const raw = {
      segments: [{ beatId: "invented", text: "不采用的旁白" }],
      npcLine: "商队离开前，有人用松脂封住了后门的锁孔。去巷口找那枚沾松脂的铜钱，它能证明谁来过。",
      objectiveLink: null,
      choices: ["继续问", "观察", "离开"],
    };
    const source = createLiveScenePerformanceSource({ transport: stubTransport(raw), config });
    const first = await source.generateScene(makeContext({
      job: makeJob(),
    }));
    expect(first.ok).toBe(false);
    if (first.ok) throw new Error("expected failure");
    const second = await source.generateScene(makeContext({
      job: { ...makeJob(), actionId: "act_2", turnNumber: 2 },
    }));
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("expected failure");
    expect(first.failure.kind).toBe("AI_RESPONSE_INVALID");
    expect(second.failure.kind).toBe("AI_RESPONSE_INVALID");
  });

  it("首个 AI 响应为空时只返回可修复原因", async () => {
    const context = makeContext();
    let attempts = 0;
    const transport: AiTransport = {
      complete: vi.fn(async () => {
        attempts += 1;
        if (attempts === 2) {
          return {
            ok: true as const,
            content: JSON.stringify({
              segments: [{ beatId: ATMOSPHERE_BEAT_ID, text: "修复后的旁白。" }],
              npcLine: null,
              objectiveLink: null,
              choices: [
                { candidateId: "candidate_1", label: "继续核对" },
                { candidateId: "candidate_2", label: "先观察现场" },
              ],
            }),
            latencyMs: 1,
          };
        }
        return { ok: false as const, code: "empty_response" as const, retryable: false, latencyMs: 1 };
      }),
    } as unknown as AiTransport;

    const proposal = await createLiveScenePerformanceSource({ transport, config }).generateScene(context);
    expect(proposal.ok).toBe(false);
    if (proposal.ok) throw new Error("expected repairable failure");
    expect(attempts).toBe(1);
    expect(proposal.repairReason).toBe("empty_response");
  });

  it("AI 返回非法选项 ID → 返回稳定格式失败", async () => {
    const context = makeContext();
    const transport = stubTransport({
      segments: [{ beatId: ATMOSPHERE_BEAT_ID, text: "旁白" }],
      npcLine: null,
      objectiveLink: null,
      choices: [
        { candidateId: "invented", label: "A" },
        { candidateId: "candidate_1", label: "B" },
      ],
    });
    const source = createLiveScenePerformanceSource({ transport, config });
    const proposal = await source.generateScene(context);
    expect(proposal.ok).toBe(false);
    if (proposal.ok) throw new Error("expected failure");
    expect(proposal.failure.kind).toBe("AI_RESPONSE_INVALID");
  });

  it("AI 返回带叙述前缀的通用确认句 → 返回稳定格式失败", async () => {
    const context = makeContext({
      job: makeJob({
        utterance: "商队失踪的事你知道吗？",
        beats: [{ beatId: "player_utterance", kind: "player_utterance", subjectIds: ["npc_1"], instruction: "直接回应玩家" }],
      }),
    });
    const transport = stubTransport({
      segments: [{ beatId: "player_utterance", text: "你提出了问题。" }],
      npcLine: {
        npcId: "npc_1",
        text: "老板如实答道：\"我知道了。\"",
        emotion: "neutral",
        answeredBeatIds: ["player_utterance"],
        usedFactIds: [],
        usedEventIds: [],
      },
      objectiveLink: null,
      choices: [
        { candidateId: "candidate_1", label: "支持老板" },
        { candidateId: "candidate_2", label: "质疑老板" },
      ],
    });
    const source = createLiveScenePerformanceSource({ transport, config });
    const proposal = await source.generateScene(context);
    expect(proposal.ok).toBe(false);
    if (proposal.ok) throw new Error("expected failure");
    expect(proposal.failure.kind).toBe("AI_RESPONSE_INVALID");
  });

  it("AI 返回脱离上下文的通用问候 → 返回稳定格式失败", async () => {
    const baseContext = makeContext({
      presentNpcs: [{
        id: asNpcId("npc_1"), name: "顾砚", role: "旧案传讯人", publicProfile: "带着旧案线索的人",
        knownFactCards: [], hiddenFactCards: [], sceneVisibleFactIds: [],
        recentInteractionSummaries: [], recentInteractionActionIds: [],
        relationship: { affinity: 0 }, emotion: "neutral", goals: [], forbiddenKnowledgeIds: [],
      }],
    });
    const context: SceneGenerationContext = {
      ...baseContext,
      focusNpcContext: {
        ...baseContext.focusNpcContext!,
        name: "顾砚",
        role: "旧案传讯人",
        publicProfile: "带着旧案线索的人",
      },
    };
    const transport = stubTransport({
      segments: [{ beatId: ATMOSPHERE_BEAT_ID, text: "铁器声停了一瞬。" }],
      npcLine: {
        npcId: "npc_1",
        text: "你是来打听事情的吧？想知道什么，直接问我。",
        emotion: "neutral",
        answeredBeatIds: [],
        usedFactIds: [],
        usedEventIds: [],
      },
      objectiveLink: null,
      choices: [
        { candidateId: "candidate_1", label: "支持顾砚" },
        { candidateId: "candidate_2", label: "质疑顾砚" },
      ],
    });
    const proposal = await createLiveScenePerformanceSource({ transport, config }).generateScene(context);
    expect(proposal.ok).toBe(false);
    if (proposal.ok) throw new Error("expected failure");
    expect(proposal.failure.kind).toBe("AI_RESPONSE_INVALID");
  });

  it("AI 返回带叙述前缀的具体回应 → 持久化前归一化为直接台词", async () => {
    const context = makeContext({
      job: makeJob({ utterance: "商队失踪的事你知道吗？" }),
    });
    const transport = stubTransport({
      segments: [{ beatId: ATMOSPHERE_BEAT_ID, text: "暮色渐沉。" }],
      npcLine: {
        npcId: "npc_1",
        text: "老板说道：\"商队离开前，有人用松脂封住了后门的锁孔。去巷口找那枚沾松脂的铜钱，它能证明谁来过。\"",
        emotion: "neutral",
        answeredBeatIds: [],
        usedFactIds: [],
        usedEventIds: [],
      },
      objectiveLink: null,
      choices: [
        { candidateId: "candidate_1", label: "支持老板" },
        { candidateId: "candidate_2", label: "质疑老板" },
      ],
    });
    const source = createLiveScenePerformanceSource({ transport, config });
    const proposal = await source.generateScene(context);
    if (!proposal.ok) throw new Error("expected success");
    expect(proposal.proposal.source).toBe("generated");
    expect(proposal.proposal.npcLine?.text).toBe("商队离开前，有人用松脂封住了后门的锁孔。去巷口找那枚沾松脂的铜钱，它能证明谁来过。");
  });

  it("AI 只用空泛追问接话时返回稳定格式失败", async () => {
    const context = makeContext({ job: makeJob({ utterance: "商队失踪的事你知道吗？" }) });
    const transport = stubTransport({
      segments: [{ beatId: ATMOSPHERE_BEAT_ID, text: "暮色渐沉。" }],
      npcLine: {
        npcId: "npc_1",
        text: "关于商队失踪的事，我先说我确定的部分。你还想从哪一段继续追问？",
        emotion: "neutral",
        answeredBeatIds: [],
        usedFactIds: [],
        usedEventIds: [],
      },
      objectiveLink: null,
      choices: [
        { candidateId: "candidate_1", label: "支持老板" },
        { candidateId: "candidate_2", label: "暂不回应，先观察现场" },
      ],
    });

    const proposal = await createLiveScenePerformanceSource({ transport, config }).generateScene(context);
    expect(proposal.ok).toBe(false);
    if (proposal.ok) throw new Error("expected failure");
    expect(proposal.failure.kind).toBe("AI_RESPONSE_INVALID");
  });

  it("焦点 NPC 只返回一句对白时返回稳定格式失败", async () => {
    const context = makeContext({ job: makeJob({ utterance: "商队失踪的事你知道吗？" }) });
    const transport = stubTransport({
      segments: [{ beatId: ATMOSPHERE_BEAT_ID, text: "暮色渐沉。" }],
      npcLine: {
        npcId: "npc_1",
        text: "关于商队失踪的事，我先说我确定的部分。",
        emotion: "neutral",
        answeredBeatIds: [],
        usedFactIds: [],
        usedEventIds: [],
      },
      objectiveLink: null,
      choices: [
        { candidateId: "candidate_1", label: "支持老板" },
        { candidateId: "candidate_2", label: "暂不回应，先观察现场" },
      ],
    });
    const proposal = await createLiveScenePerformanceSource({ transport, config }).generateScene(context);
    expect(proposal.ok).toBe(false);
    if (proposal.ok) throw new Error("expected failure");
    expect(proposal.failure.kind).toBe("AI_RESPONSE_INVALID");
  });

  // ── Task 5：调查方法结果反馈链 ─────────────────────────────────────────

  it("buildLiveScenePrompt 引用服务端已结算的调查方式与下一目标，禁止 AI 再裁决发现与否", () => {
    const context: SceneGenerationContext = {
      ...makeContext({ job: makeJob({ eventKind: "investigate", summary: { kind: "investigate", factId: asFactId("fact_1") } }) }),
      resolvedInvestigation: {
        factId: asFactId("fact_1"),
        approachId: "follow",
        approachLabel: "沿痕迹追查",
        evidenceQuality: "clean",
        tensionDelta: 4,
      },
      objectiveTarget: { questId: "quest_0", objectiveIndex: 2, entityId: "loc_2", entityName: "北巷旧道" },
    };
    const prompt = buildLiveScenePrompt(context, buildSelectableSceneCandidates(context));
    expect(prompt).toContain("沿痕迹追查");
    expect(prompt).toContain("证据质量");
    expect(prompt).toContain("北巷旧道");
  });

  it("battle prompt 只表演服务端已结算 outcome/HP，不引入 battle snapshot 语义", () => {
    const job = makeJob({
      eventKind: "battle",
      summary: { kind: "battle_action", action: "attack" },
      beats: [{
        beatId: "battle_0",
        kind: "battle_resolved",
        subjectIds: ["enemy_1"],
        instruction: "服务端已结算：玩家胜利，当前 HP=80",
      }],
    });
    const context = makeContext({ job });
    const compilation = compileLiveScenePrompt(context, buildSelectableSceneCandidates(context));

    expect(compilation.context.selected.find((block) => block.id === "scene:resolution")?.content)
      .toContain("当前 HP=80");
    expect(compilation.prompt).toContain("服务端已结算：玩家胜利，当前 HP=80");
    expect(compilation.prompt).not.toContain("preBattleSnapshot");
    expect(compilation.prompt).not.toContain("BattleStartSnapshot");
  });

  it("已结算调查结果随提案携带，且不泄漏 tensionDelta", async () => {
    const job = makeJob({
      eventKind: "investigate",
      summary: { kind: "investigate", factId: asFactId("fact_1") },
      beats: [
        { beatId: "fact_discovered_0", kind: "fact_discovered", subjectIds: ["fact_1"], instruction: "发现了线索：泥地里的车轮印向北延伸" },
        { beatId: ATMOSPHERE_BEAT_ID, kind: "atmosphere", subjectIds: [], instruction: "氛围" },
      ],
    });
    const context: SceneGenerationContext = {
      ...makeContext({ job }),
      resolvedInvestigation: {
        factId: asFactId("fact_1"),
        approachId: "follow",
        approachLabel: "沿痕迹追查",
        evidenceQuality: "clean",
        tensionDelta: 4,
      },
      objectiveTarget: { questId: "quest_0", objectiveIndex: 2, entityId: "loc_2", entityName: "北巷旧道" },
    };
    const transport = stubTransport({
      segments: [
        { beatId: "fact_discovered_0", text: "你按「沿痕迹追查」的方式仔细查证，泥地里的车轮印向北延伸。这次查证干净利落，没有惊动任何人。" },
        { beatId: ATMOSPHERE_BEAT_ID, text: "暮色渐沉。" },
      ],
      npcLine: null,
      objectiveLink: null,
      choices: [
        { candidateId: "candidate_1", label: "支持老板" },
        { candidateId: "candidate_2", label: "质疑老板" },
      ],
    });
    const source = createLiveScenePerformanceSource({ transport, config });
    const proposal = await source.generateScene(context);
    if (!proposal.ok) throw new Error("expected success");
    expect(proposal.proposal.source).toBe("generated");
    expect(proposal.proposal.investigationResult).toEqual({
      factId: "fact_1",
      approachLabel: "沿痕迹追查",
      evidenceQuality: "clean",
      nextObjectiveLabel: "北巷旧道",
    });
    expect(JSON.stringify(proposal)).not.toContain("tensionDelta");
  });
});
