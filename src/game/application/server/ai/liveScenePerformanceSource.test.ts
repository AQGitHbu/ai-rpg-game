import { describe, it, expect, vi } from "vitest";
import {
  createLiveScenePerformanceSource,
  buildLiveScenePrompt,
  LIVE_SCENE_MAX_TOKENS,
  LIVE_SCENE_TIMEOUT_MS,
  parseScenePerformanceJson,
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
    narrativeReferenceIds: ["item_seal", "npc_1", "fact_a", "fact_vis"],
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
  it("reserves enough completion budget for provider reasoning and scene JSON", () => {
    expect(LIVE_SCENE_MAX_TOKENS).toBeGreaterThanOrEqual(3_000);
    expect(LIVE_SCENE_TIMEOUT_MS).toBe(45_000);
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
    const advanced = proposal.segments.find((s) => s.beatId === "quest_adv_0");
    expect(advanced).toBeDefined();
    expect(advanced!.text).not.toContain("盟誓印谱");
    expect(advanced!.referencedEntityIds).toEqual(["item_seal"]);
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
    expect(prompt).toContain("玩家角色=侠客（剑客）");
    expect(prompt).toContain("玩家只能被称为“侠客”");
    expect(prompt).toContain("candidate_1");
    expect(prompt).toContain("candidate_2");
    const candidateSection = prompt.match(/候选动作=([^\n]*)/u)?.[1] ?? "";
    expect(candidateSection).toContain("candidate_1");
    expect(candidateSection).toContain("candidate_2");
    expect(candidateSection).not.toContain("请把你刚才提到的这条线索");
    expect(candidateSection).not.toContain("哪一件原始证物");
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
    expect(prompt).toContain("不得输出“主线推进到第X幕”“已完成：”“当前目标：”等系统元话术");
    expect(prompt).toContain("先完成 npcLine，再根据本轮 npcLine 的文本和 usedFactIds 生成 choices");
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
          usedInteractionActionIds: [],
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

  it("AI 复用上一轮 fallback 选项时触发内容修复，而不是直接保存 generated", async () => {
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
              usedInteractionActionIds: [],
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

    expect(attempts).toBe(2);
    expect(proposal.source).toBe("generated");
    expect(proposal.choices.map((choice) => choice.label).join(" ")).not.toContain("既然你愿意继续说");
    expect(logger.warn).toHaveBeenCalledWith("scene_generation_content_retry", {
      reason: "choices_stale_template",
      attempt: 1,
    });
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
    expect(valid.proposal.linearActionNarratives).toEqual([
      { actionKind: "investigate", factId: "fact_wheel", narration: "泥水里的车轮印断续向北，直指北巷旧道。" },
      { actionKind: "move", locationId: "loc_north_lane", narration: "你沿旧道向北行去。" },
    ]);

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
    expect(invalid.proposal.linearActionNarratives).toBeUndefined();
  });

  it("prompt 在 upcomingLinearObjectives 非空时要求预生成 linearActionNarratives，为空时要求省略该字段", () => {
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
    expect(prompt).toContain("linearActionNarratives");
    expect(prompt).toContain("车轮印在后巷泥水中断续向北延伸"); // 权威正文进入 prompt
    expect(prompt).toContain("北巷旧道"); // 下一地点实体名照抄服务端下发
    expect(prompt).toContain("不得捏造新事实");
    expect(prompt).not.toContain("省略 linearActionNarratives");

    const plain = buildLiveScenePrompt(makeContext(), buildSelectableSceneCandidates(makeContext()));
    expect(plain).toContain("省略 linearActionNarratives");
    expect(plain).not.toContain("单线行动预告（AI 预生成");
  });

  it("契约失败时带失败原因重试一次，修复成功则保留 generated", async () => {
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

    expect(proposal.source).toBe("generated");
    expect(proposal.contentRepairAttempt).toBe(1);
    expect(attempts).toBe(2);
    expect(logger.warn).toHaveBeenCalledWith("scene_generation_content_retry", {
      reason: "segments_empty",
      attempt: 1,
    });
  });

  it("内容修复仍失败时最多两次请求后才回退，并记录第二次的脱敏原因", async () => {
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

    expect(proposal.source).toBe("fallback");
    expect(attempts).toBe(2);
    expect(logger).toMatchObject({ warn: expect.any(Function) });
    expect(logger.warn).toHaveBeenLastCalledWith("scene_generation_invalid_data", {
      reason: "segments_empty",
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
    const logger = { info: vi.fn(), warn: vi.fn() };
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

  it("局部 live 修复沿用带回合上下文的 fallback 选项，不重复整组对白", async () => {
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
    const second = await source.generateScene(makeContext({
      job: { ...makeJob(), actionId: "act_2", turnNumber: 2 },
    }));

    expect(first.source).toBe("generated");
    expect(second.source).toBe("generated");
    expect(first.choices).toHaveLength(2);
    expect(second.choices).toHaveLength(2);
    const firstLabels = first.choices.map((choice) => choice.label).join(" ");
    const secondLabels = second.choices.map((choice) => choice.label).join(" ");
    expect(firstLabels).not.toContain("商队离开前，有人用松脂封住了后门的锁孔");
    expect(secondLabels).not.toContain("商队离开前，有人用松脂封住了后门的锁孔");
    expect(firstLabels).toContain("线索");
    expect(firstLabels).toContain("证物");
    expect(secondLabels).toContain("线索");
    expect(secondLabels).toContain("证物");
  });

  it("首个 AI 响应为空时用修复提示重试一次", async () => {
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

    expect(attempts).toBe(2);
    expect(proposal.source).toBe("generated");
    expect(proposal.contentRepairAttempt).toBe(1);
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
    expect(proposal.npcLine?.text).toContain("眼前这条线索");
    expect(proposal.npcLine?.text).not.toMatch(/门闩|松脂|车辙/u);
    expect(proposal.npcLine?.text).not.toContain("你刚才问的");
    expect(proposal.npcLine?.text).not.toContain("如实答道");
  });

  it("AI 返回脱离上下文的通用问候 → 回退到不编造事实的安全台词", async () => {
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
    expect(proposal.npcLine?.text).toContain("只回答亲眼见过或已经核对的部分");
    expect(proposal.npcLine?.text).not.toMatch(/盟誓铁印|无灯马车|告示|松脂|车辙/u);
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
    expect(proposal.npcLine?.text).toContain("眼前这条线索");
    expect(proposal.npcLine?.text).not.toMatch(/门闩|松脂|车辙/u);
    expect(proposal.npcLine?.text).toContain("把手里的证据带上");
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
    expect(proposal.source).toBe("generated");
    expect(proposal.investigationResult).toEqual({
      factId: "fact_1",
      approachLabel: "沿痕迹追查",
      evidenceQuality: "clean",
      nextObjectiveLabel: "北巷旧道",
    });
    expect(JSON.stringify(proposal)).not.toContain("tensionDelta");
  });
});
