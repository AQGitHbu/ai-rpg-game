import { describe, it, expect, vi } from "vitest";
import {
  createLiveScenePerformanceSource,
  buildLiveScenePrompt,
  LIVE_SCENE_MAX_TOKENS,
  LIVE_SCENE_TIMEOUT_MS,
} from "./liveScenePerformanceSource";
import type { AiTransport, AiTransportConfig } from "@ai-game/ai-transport";
import type { SceneGenerationContext } from "../../sceneGenerationContext";
import { buildSelectableSceneCandidates } from "../../deterministicSceneSource";
import { buildStylePolicy } from "../../stylePolicy";
import { asLocationId, asNpcId, asFactId, asQuestId } from "@/game/domain/worldEntity";
import { asNarrativeJobId, asTurnId } from "@/game/domain/events";
import { createPendingNarrativeJob, type PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import type { MandatoryNarrativeBeat, ObjectiveTransition } from "@/game/domain/narrativeBeat";
import { ATMOSPHERE_BEAT_ID } from "../../approveAndWriteScene";

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
    domainEventRange: { fromLedgerIndex: 0, toLedgerIndexExclusive: 1 },
    focusNpcId: overrides.focusNpcId !== undefined ? asNpcId(overrides.focusNpcId) : asNpcId("npc_1"),
    requestedAt: "2026-01-02",
    objectiveTransition: overrides.transition ?? { before: null, completed: [], after: null, mode: "unchanged" },
    mandatoryBeats: overrides.beats ?? [],
  });
  if (!result.ok) throw new Error("fixture job 构造失败");
  return result.job;
}

function makeContext(overrides: {
  job?: PendingNarrativeJob;
  presentNpcs?: SceneGenerationContext["presentNpcs"];
  legalActionCandidates?: SceneGenerationContext["legalActionCandidates"];
  objectiveTarget?: SceneGenerationContext["objectiveTarget"];
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
      recentInteractionSummaries: ["ask 询问线索 / negative"], recentInteractionActionIds: ["inter_1"],
      relationship: { affinity: 20 }, emotion: "warm",
      goals: ["查清矿坑"], forbiddenKnowledgeIds: [asFactId("fact_secret")],
    }],
    story: {
      currentAct: 1, targetActs: 3, tension: 30, nextPacingNeed: "reveal",
      remainingBudget: { remainingLocations: 1, remainingNpcs: 1, remainingEvents: 1 },
      unresolvedThreadSummaries: ["商队失踪"],
      stylePolicy: buildStylePolicy({ personalityTags: ["冷静"], narrativeStyle: "concise", contentIntensity: "normal" }),
    },
    recentBeats: [
      { turn: 0, kind: "npc_met", summary: "NPC met: npc_1" },
    ],
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
    objectiveTarget: overrides.objectiveTarget ?? null,
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
      recentInteractions: [{ actionId: "inter_1", dialogueAct: "ask", topicSummary: "询问线索", outcome: "negative", summary: "氛围紧张" }],
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
          chat_template_kwargs: { enable_thinking: false },
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
    expect(proposal.source).toBe("generated");
    const itemSegment = proposal.segments.find((s) => s.beatId === "item_0");
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
    const battleSegment = proposal.segments.find((s) => s.beatId === "battle_0");
    expect(battleSegment).toBeDefined();
    expect(battleSegment!.text).toContain("击败");
    expect(battleSegment!.text).toContain("80");
    expect(battleSegment!.text).not.toContain("败北");
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
        { beatId: "quest_adv_0", text: "主线推进，接下来要获取盟誓印谱。" },
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
    const advanced = proposal.segments.find((s) => s.beatId === "quest_adv_0");
    expect(advanced).toBeDefined();
    expect(advanced!.text).toContain("盟誓印谱");
    expect(proposal.objectiveLink).toEqual({ questId: "quest_0", objectiveIndex: 1, mode: "handoff" });
    expect(proposal.objectiveLink!.questId).toBe(String(context.objectiveTransition.after!.questId));
    expect(proposal.objectiveLink!.objectiveIndex).toBe(context.objectiveTransition.after!.objectiveIndex);
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
    expect(prompt).toContain("candidate_1");
    expect(prompt).toContain("candidate_2");
    expect(prompt).toContain("客栈");
    expect(prompt).toContain("与老板交谈"); // 目标 label
    expect(prompt).toContain("老板"); // 焦点 NPC
    expect(prompt).toContain("已知线索"); // 允许披露事实正文可写进台词
    expect(prompt).not.toContain("绝不外泄的私密"); // 私密事实正文绝不出现
    expect(prompt).not.toContain("eventLedger");
    // Task 8：政策指令作为【风格政策】段落整体出现
    const policy = buildStylePolicy({ personalityTags: ["冷静"], narrativeStyle: "concise", contentIntensity: "normal" });
    expect(prompt).toContain(policy.narrationInstruction);
    expect(prompt).toContain(policy.intensityInstruction);
  });

  it("开局没有强制节拍时，prompt 明确要求唯一合法的 atmosphere 段，避免空 segments 降级", () => {
    const context = makeContext({ job: makeJob({ beats: [] }) });

    const prompt = buildLiveScenePrompt(context, buildSelectableSceneCandidates(context));

    expect(prompt).toContain("当前没有其他强制节拍");
    expect(prompt).toContain("beatId 为 atmosphere");
    expect(prompt).toContain("不得返回空数组");
  });

  it("AI 返回不可解析 JSON → 回退确定性 source（source=fallback）", async () => {
    const context = makeContext();
    const transport = stubTransport(null, "这不是 JSON");
    const source = createLiveScenePerformanceSource({ transport, config });
    const proposal = await source.generateScene(context);
    expect(proposal.source).toBe("fallback");
    expect(proposal.segments.length).toBeGreaterThan(0);
  });

  it("最终结构非法时只记录安全形状，不记录模型文本", async () => {
    const logger = { warn: vi.fn() };
    const source = createLiveScenePerformanceSource({
      transport: stubTransport({ segments: [], npcLine: null, objectiveLink: null, choices: [] }),
      config,
      logger: logger as never,
    });

    await source.generateScene(makeContext());

    expect(logger.warn).toHaveBeenLastCalledWith("scene_generation_invalid_data", {
      object: true,
      keys: "choices,npcLine,objectiveLink,segments",
      segmentCount: 0,
      npcLineKind: "null",
      choiceCount: 0,
      objectiveLinkKind: "null",
    });
  });

  it("JSON mode 把合格的字符串 NPC 台词与服务器节拍/选项机械合成为 generated 场景", async () => {
    const context = makeContext({
      job: makeJob({
        utterance: "商队失踪的事你知道吗？",
        beats: [{ beatId: "player_utterance", kind: "player_utterance", subjectIds: ["npc_1"], instruction: "直接回应玩家" }],
      }),
    });
    const logger = { info: vi.fn() };
    const transport = stubTransport({
      segments: [{ beatId: "invented", text: "不采用的旁白" }],
      npcLine: "商队离开前，有人用松脂封住了后门的锁孔。去巷口找那枚沾松脂的铜钱，它能证明谁来过。",
      objectiveLink: null,
      choices: ["继续问", "观察", "离开"],
    });

    const proposal = await createLiveScenePerformanceSource({ transport, config, logger: logger as never }).generateScene(context);

    expect(proposal.source).toBe("generated");
    expect(proposal.npcLine?.text).toContain("松脂");
    expect(proposal.npcLine?.answeredBeatIds).toEqual(["player_utterance"]);
    expect(proposal.choices).toHaveLength(2);
    expect(logger.info).toHaveBeenCalledWith("scene_generation_repaired", { kind: "npc_line_only" });
  });

  it("首个 AI 响应为空时重试一次；第二个有效提案仍作为 generated 采用", async () => {
    const context = makeContext();
    let attempts = 0;
    const transport: AiTransport = {
      complete: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) return { ok: false as const, code: "empty_response" as const, retryable: false, latencyMs: 1 };
        return {
          ok: true as const,
          content: JSON.stringify({
            segments: [{ beatId: ATMOSPHERE_BEAT_ID, text: "暮色渐沉。" }],
            npcLine: null,
            objectiveLink: null,
            choices: [
              { candidateId: "candidate_1", label: "继续交谈" },
              { candidateId: "candidate_2", label: "观察四周" },
            ],
          }),
          latencyMs: 1,
        };
      }),
    } as unknown as AiTransport;

    const proposal = await createLiveScenePerformanceSource({ transport, config }).generateScene(context);

    expect(attempts).toBe(2);
    expect(proposal.source).toBe("generated");
  });

  it("AI 返回非法选项 ID → 回退确定性 source", async () => {
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
    expect(proposal.source).toBe("fallback");
  });

  it("AI 返回带叙述前缀的通用确认句 → 清理后仍判定为无上下文并回退", async () => {
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
        usedInteractionActionIds: [],
      },
      objectiveLink: null,
      choices: [
        { candidateId: "candidate_1", label: "支持老板" },
        { candidateId: "candidate_2", label: "质疑老板" },
      ],
    });
    const source = createLiveScenePerformanceSource({ transport, config });
    const proposal = await source.generateScene(context);
    expect(proposal.source).toBe("fallback");
    expect(proposal.npcLine?.text).toContain("有人故意把线索引到这里");
    expect(proposal.npcLine?.text).not.toContain("你刚才问的");
    expect(proposal.npcLine?.text).not.toContain("如实答道");
  });

  it("AI 返回脱离角色身份的通用问候 → 回退到角色化 NPC 台词", async () => {
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
        usedInteractionActionIds: [],
      },
      objectiveLink: null,
      choices: [
        { candidateId: "candidate_1", label: "支持顾砚" },
        { candidateId: "candidate_2", label: "质疑顾砚" },
      ],
    });
    const proposal = await createLiveScenePerformanceSource({ transport, config }).generateScene(context);
    expect(proposal.source).toBe("fallback");
    expect(proposal.npcLine?.text).toContain("线索");
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
        usedInteractionActionIds: [],
      },
      objectiveLink: null,
      choices: [
        { candidateId: "candidate_1", label: "支持老板" },
        { candidateId: "candidate_2", label: "质疑老板" },
      ],
    });
    const source = createLiveScenePerformanceSource({ transport, config });
    const proposal = await source.generateScene(context);
    expect(proposal.source).toBe("generated");
    expect(proposal.npcLine?.text).toBe("商队离开前，有人用松脂封住了后门的锁孔。去巷口找那枚沾松脂的铜钱，它能证明谁来过。");
  });

  it("AI 只用空泛追问接话时回退到角色化台词", async () => {
    const context = makeContext({ job: makeJob({ utterance: "商队失踪的事你知道吗？" }) });
    const transport = stubTransport({
      segments: [{ beatId: ATMOSPHERE_BEAT_ID, text: "暮色渐沉。" }],
      npcLine: {
        npcId: "npc_1",
        text: "关于商队失踪的事，我先说我确定的部分。你还想从哪一段继续追问？",
        emotion: "neutral",
        answeredBeatIds: [],
        usedFactIds: [],
        usedInteractionActionIds: [],
      },
      objectiveLink: null,
      choices: [
        { candidateId: "candidate_1", label: "支持老板" },
        { candidateId: "candidate_2", label: "暂不回应，先观察现场" },
      ],
    });

    const proposal = await createLiveScenePerformanceSource({ transport, config }).generateScene(context);

    expect(proposal.source).toBe("fallback");
    expect(proposal.npcLine?.text).not.toContain("你还想从哪一段");
  });

  it("焦点 NPC 只返回一句对白时回退到多轮角色化台词", async () => {
    const context = makeContext({ job: makeJob({ utterance: "商队失踪的事你知道吗？" }) });
    const transport = stubTransport({
      segments: [{ beatId: ATMOSPHERE_BEAT_ID, text: "暮色渐沉。" }],
      npcLine: {
        npcId: "npc_1",
        text: "关于商队失踪的事，我先说我确定的部分。",
        emotion: "neutral",
        answeredBeatIds: [],
        usedFactIds: [],
        usedInteractionActionIds: [],
      },
      objectiveLink: null,
      choices: [
        { candidateId: "candidate_1", label: "支持老板" },
        { candidateId: "candidate_2", label: "暂不回应，先观察现场" },
      ],
    });
    const proposal = await createLiveScenePerformanceSource({ transport, config }).generateScene(context);
    expect(proposal.source).toBe("fallback");
    expect(proposal.npcLine?.text).toContain("有人故意把线索引到这里");
    expect(proposal.npcLine?.text).toContain("把手里的证据带上");
  });
});
