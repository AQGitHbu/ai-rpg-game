import { describe, expect, it, vi } from "vitest";
import { asEventId, asNarrativeJobId, asTurnId } from "./events";
import type { ResolvedEvent } from "./resolvedEvent";
import { asLocationId, asNpcId, asQuestId } from "./worldEntity";
import {
  PLAYER_UTTERANCE_MAX_LENGTH,
  createPendingNarrativeJob,
  parsePendingNarrativeJob,
  DECISION_BOUNDARY_KINDS,
  classifyProviderDecisionBoundary,
  type CreatePendingNarrativeJobInput,
  type PendingNarrativeJob,
  type StructuredActionSummary,
} from "./pendingNarrativeJob";
import { MAX_MANDATORY_BEATS, type MandatoryNarrativeBeat } from "./narrativeBeat";

function canonicalResolvedEvent(): ResolvedEvent {
  return {
    actionId: "action-1",
    status: "success",
    eventKind: "observe",
    facts: [],
    stateChanges: [],
    costs: [],
    rewards: [],
    triggeredEvents: [],
    rejectedEffects: [],
  };
}

const DEFAULT_INPUT: CreatePendingNarrativeJobInput = {
  jobId: asNarrativeJobId("job-1"),
  turnId: asTurnId("turn-1"),
  actionId: "action-1",
  expectedRevision: 41,
  turnNumber: 3,
  actionSummary: { kind: "talk", npcId: asNpcId("npc_1") },
  utterance: "我想打听矿坑的事",
  resolvedEvent: canonicalResolvedEvent(),
  domainEventIds: [asEventId("turn-1:event-12"), asEventId("turn-1:event-13"), asEventId("turn-1:event-14")],
  focusNpcId: asNpcId("npc_1"),
  requestedAt: "2026-08-08T08:00:00.000Z",
  objectiveTransition: { before: null, completed: [], after: null, mode: "unchanged" },
  mandatoryBeats: [],
  generationKind: "npc_fixed_choice",
  sceneRequestKind: "npc_response",
};

function createValidJob(
  overrides?: Partial<CreatePendingNarrativeJobInput>,
): PendingNarrativeJob {
  const result = createPendingNarrativeJob({ ...DEFAULT_INPUT, ...overrides });
  if (!result.ok) throw new Error("fixture 构造失败");
  return result.job;
}

function createResult(
  overrides?: Partial<CreatePendingNarrativeJobInput>,
): ReturnType<typeof createPendingNarrativeJob> {
  return createPendingNarrativeJob({ ...DEFAULT_INPUT, ...overrides });
}

describe("PendingNarrativeJob", () => {
  it("保存场景生成恢复所需的全部因果字段", () => {
    const job = createValidJob();

    expect(Object.keys(job).sort()).toEqual([
      "actionId",
      "actionSummary",
      "basedOnRevision",
      "domainEventIds",
      "focusNpcId",
      "generationKind",
      "jobId",
      "mandatoryBeats",
      "objectiveTransition",
      "requestedAt",
      "resolvedEvent",
      "sceneRequestKind",
      "turnId",
      "turnNumber",
      "utterance",
    ]);
    expect(job.jobId).toBe("job-1");
    expect(job.turnId).toBe("turn-1");
    expect(job.actionId).toBe("action-1");
    expect(job.turnNumber).toBe(3);
    expect(job.actionSummary).toEqual({ kind: "talk", npcId: "npc_1" });
    expect(job.resolvedEvent).toEqual(canonicalResolvedEvent());
    expect(job.domainEventIds).toEqual([
      asEventId("turn-1:event-12"),
      asEventId("turn-1:event-13"),
      asEventId("turn-1:event-14"),
    ]);
    expect(job.requestedAt).toBe("2026-08-08T08:00:00.000Z");
  });

  it("basedOnRevision 等于 expectedRevision + 1（显式推导）", () => {
    expect(createValidJob({ expectedRevision: 41 }).basedOnRevision).toBe(42);
    expect(createValidJob({ expectedRevision: 0 }).basedOnRevision).toBe(1);
    expect(createValidJob({ expectedRevision: 99 }).basedOnRevision).toBe(100);
  });

  it("talk/free text job 可携带 bounded utterance 和 focusNpcId", () => {
    const job = createValidJob({
      actionSummary: { kind: "talk", npcId: asNpcId("npc_2") },
      utterance: "请问矿坑里有什么？",
      focusNpcId: asNpcId("npc_2"),
    });

    expect(job.utterance).toBe("请问矿坑里有什么？");
    expect(job.focusNpcId).toBe("npc_2");
    expect(job.actionSummary).toEqual({ kind: "talk", npcId: "npc_2" });
  });

  it("保存固定选项的结构化对白上下文，供下一幕承接上一轮", () => {
    const job = createValidJob({
      selectedDialogue: {
        dialogueAct: "challenge",
        topic: { kind: "thread", threadId: "main_thread" },
        label: "追问线人：哪件证物能证明？",
      },
    });
    expect(job.selectedDialogue).toEqual({
      dialogueAct: "challenge",
      topic: { kind: "thread", threadId: "main_thread" },
      label: "追问线人：哪件证物能证明？",
    });
  });

  it("move job 可不带 utterance 和 focusNpcId", () => {
    const job = createValidJob({
      actionSummary: { kind: "move", locationId: asLocationId("loc_2") },
      utterance: undefined,
      focusNpcId: undefined,
    });

    expect(job.utterance).toBeUndefined();
    expect(job.focusNpcId).toBeUndefined();
    expect(job.actionSummary).toEqual({ kind: "move", locationId: "loc_2" });
  });

  it("JSON round-trip 后信息不丢失", () => {
    const job = createValidJob();

    expect(JSON.parse(JSON.stringify(job))).toEqual(job);
  });

  it("玩家原文只存在于 job.utterance，不进 ResolvedEvent 字段", () => {
    const job = createValidJob({ utterance: "我想去废弃矿坑" });

    expect(job.utterance).toBe("我想去废弃矿坑");
    expect(Object.keys(job.resolvedEvent)).not.toContain("utterance");
  });

  it("actionSummary 是封闭 union，拒绝任意 path patch", () => {
    // @ts-expect-error actionSummary 不允许任意 path patch
    const patch: StructuredActionSummary = { path: "npc_1.affinity", value: -10 };
    // @ts-expect-error 未知 kind 拒绝
    const unknownKind: StructuredActionSummary = { kind: "unlicensed" };

    expect([patch, unknownKind]).toHaveLength(2);
  });

  it("job 不保存完整 World State（仅结构化摘要）", () => {
    const job = createValidJob();

    expect(Object.keys(job)).not.toContain("worldState");
    expect(Object.keys(job)).not.toContain("state");
    expect(job.actionSummary).not.toHaveProperty("patch");
  });

  it("拒绝空 actionId", () => {
    expect(createResult({ actionId: "" }).ok).toBe(false);
    expect(createResult({ actionId: "   " }).ok).toBe(false);

    const result = createResult({ actionId: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual({ code: "EMPTY_ACTION_ID" });
    }
  });

  it("拒绝空、重复、格式错误和旧范围事件引用", () => {
    expect(createResult({ domainEventIds: [] }).ok).toBe(false);
    expect(createResult({ domainEventIds: [asEventId("turn-1:event-1"), asEventId("turn-1:event-1")] }).ok).toBe(false);
    expect(createResult({ domainEventIds: [asEventId("")] }).ok).toBe(false);
    expect(createResult({ domainEventIds: ["not-an-event-id"] as never }).ok).toBe(false);
    expect(createResult({ domainEventIds: undefined, domainEventRange: { fromLedgerIndex: 0, toLedgerIndexExclusive: 1 } } as never).ok).toBe(false);
  });

  it("拒绝超长 utterance（上限引用统一常量）", () => {
    const tooLong = "田".repeat(PLAYER_UTTERANCE_MAX_LENGTH + 1);
    const result = createResult({ utterance: tooLong });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual({ code: "UTTERANCE_TOO_LONG" });
    }
  });

  it("接受恰好等于上限的 utterance", () => {
    const boundary = "田".repeat(PLAYER_UTTERANCE_MAX_LENGTH);

    expect(createResult({ utterance: boundary }).ok).toBe(true);
  });

  it("拒绝负数或非整数 expectedRevision", () => {
    expect(createResult({ expectedRevision: -1 }).ok).toBe(false);
    expect(createResult({ expectedRevision: 1.5 }).ok).toBe(false);
  });

  it("构造过程不读取时钟或随机数", () => {
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("Date.now must be injected outside domain");
    });
    const random = vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("randomness must be injected outside domain");
    });

    try {
      expect(createValidJob().basedOnRevision).toBe(42);
      expect(dateNow).not.toHaveBeenCalled();
      expect(random).not.toHaveBeenCalled();
    } finally {
      dateNow.mockRestore();
      random.mockRestore();
    }
  });

  it("job 携带 objectiveTransition（纯容器，默认 unchanged）", () => {
    const job = createValidJob();
    expect(job.objectiveTransition).toEqual({
      before: null, completed: [], after: null, mode: "unchanged",
    });

    const advanced = createValidJob({
      objectiveTransition: {
        before: { questId: asQuestId("quest_0"), objectiveIndex: 0, label: "与老板交谈" },
        completed: [{ questId: asQuestId("quest_0"), objectiveIndex: 0, label: "与老板交谈" }],
        after: { questId: asQuestId("quest_dyn_1"), objectiveIndex: 0, label: "与信使交谈" },
        mode: "advanced_act",
      },
    });
    expect(advanced.objectiveTransition.mode).toBe("advanced_act");
    expect(advanced.objectiveTransition.after?.questId).toBe("quest_dyn_1");
  });

  it("job 携带 mandatoryBeats 且 JSON round-trip 完整", () => {
    const beats: MandatoryNarrativeBeat[] = [
      { beatId: "item_0", kind: "item_obtained", subjectIds: ["item_seal"], instruction: "获得物品「盟誓印谱」" },
      { beatId: "battle_0", kind: "battle_started", subjectIds: ["enemy_wolf"], instruction: "遭遇了野狼" },
    ];
    const job = createValidJob({ mandatoryBeats: beats });
    expect(job.mandatoryBeats).toEqual(beats);
    expect(JSON.parse(JSON.stringify(job))).toEqual(job);
  });

  it("拒绝超过上限的 mandatoryBeats", () => {
    const beats: MandatoryNarrativeBeat[] = Array.from({ length: MAX_MANDATORY_BEATS + 1 }, (_, i) => ({
      beatId: `b${i}`, kind: "player_utterance" as const, subjectIds: [], instruction: "i",
    }));
    const result = createResult({ mandatoryBeats: beats });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual({ code: "MANDATORY_BEATS_OVER_CAP" });
    }
  });

  it("接受恰好等于上限的 mandatoryBeats", () => {
    const beats: MandatoryNarrativeBeat[] = Array.from({ length: MAX_MANDATORY_BEATS }, (_, i) => ({
      beatId: `b${i}`, kind: "player_utterance" as const, subjectIds: [], instruction: "i",
    }));
    expect(createResult({ mandatoryBeats: beats }).ok).toBe(true);
  });

  it("拒绝非法 mandatoryBeat 形状（空 instruction / 空 beatId / 未知 kind / 非字符串 subject）", () => {
    for (const beat of [
      { beatId: "b", kind: "item_obtained", subjectIds: [], instruction: "" },
      { beatId: "", kind: "item_obtained", subjectIds: [], instruction: "i" },
      { beatId: "b", kind: "unlicensed", subjectIds: [], instruction: "i" },
      { beatId: "b", kind: "item_obtained", subjectIds: [42], instruction: "i" },
    ]) {
      expect(createResult({ mandatoryBeats: [beat as never] }).ok).toBe(false);
    }
  });

  it("拒绝非法 objectiveTransition（未知 mode / 残缺 completed）", () => {
    for (const transition of [
      { before: null, completed: [], after: null, mode: "nope" },
      { before: null, completed: [{ questId: "quest_0", objectiveIndex: 0 }], after: null, mode: "progressed" },
    ] as const) {
      expect(createResult({ objectiveTransition: transition as never }).ok).toBe(false);
    }
  });

  it("generationKind 和 sceneRequestKind 持久化到 job", () => {
    const job = createValidJob();
    expect(job.generationKind).toBe("npc_fixed_choice");
    expect(job.sceneRequestKind).toBe("npc_response");
  });

  it("opening + opening 配对合法", () => {
    expect(createResult({
      generationKind: "opening",
      sceneRequestKind: "opening",
      actionSummary: { kind: "freeform" },
    }).ok).toBe(true);
  });

  it("story_exit + story_exit 是弃置任务的唯一生成配对，且不需要焦点 NPC", () => {
    const result = createResult({
      actionSummary: { kind: "abandon_quest", questId: asQuestId("quest_main") },
      focusNpcId: undefined,
      generationKind: "story_exit" as never,
      sceneRequestKind: "story_exit" as never,
    });
    expect(result.ok).toBe(true);
  });

  it("npc_fixed_choice + npc_handoff 配对合法", () => {
    expect(createResult({
      generationKind: "npc_fixed_choice",
      sceneRequestKind: "npc_handoff",
    }).ok).toBe(true);
  });

  it("npc_free_text + npc_response 配对合法", () => {
    expect(createResult({
      generationKind: "npc_free_text",
      sceneRequestKind: "npc_response",
    }).ok).toBe(true);
  });

  it("非 provider pending job 接受 null/null metadata", () => {
    const result = createResult({
      actionSummary: { kind: "move", locationId: asLocationId("loc_2") },
      generationKind: null as never,
      sceneRequestKind: null as never,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.job.generationKind).toBeNull();
      expect(result.job.sceneRequestKind).toBeNull();
    }
  });

  it("拒绝非白名单 generationKind", () => {
    expect(createResult({
      generationKind: "prepared_action" as never,
      sceneRequestKind: "npc_response",
    }).ok).toBe(false);
  });

  it("拒绝交叉配对（opening + npc_response）", () => {
    expect(createResult({
      generationKind: "opening",
      sceneRequestKind: "npc_response",
    }).ok).toBe(false);
  });

  it("拒绝交叉配对（npc_fixed_choice + opening）", () => {
    expect(createResult({
      generationKind: "npc_fixed_choice",
      sceneRequestKind: "opening",
    }).ok).toBe(false);
  });

  it("拒绝半空配对（null + npc_response）", () => {
    expect(createResult({
      generationKind: null as never,
      sceneRequestKind: "npc_response",
    }).ok).toBe(false);
  });

  it("parsePendingNarrativeJob 从 JSON 重建合法 job", () => {
    const job = createValidJob();
    const parsed = parsePendingNarrativeJob(JSON.parse(JSON.stringify(job)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.job).toEqual(job);
    }
  });

  it("parsePendingNarrativeJob 拒绝未知 generationKind", () => {
    const job = createValidJob();
    const raw = JSON.parse(JSON.stringify(job)) as Record<string, unknown>;
    raw.generationKind = "prepared_action";
    expect(parsePendingNarrativeJob(raw).ok).toBe(false);
  });

  it("parsePendingNarrativeJob 拒绝交叉配对", () => {
    const job = createValidJob();
    const raw = JSON.parse(JSON.stringify(job)) as Record<string, unknown>;
    raw.generationKind = "opening";
    raw.sceneRequestKind = "npc_response";
    expect(parsePendingNarrativeJob(raw).ok).toBe(false);
  });

  it("parsePendingNarrativeJob 接受 null/null metadata", () => {
    const job = createValidJob({
      actionSummary: { kind: "move", locationId: asLocationId("loc_2") },
      generationKind: null as never,
      sceneRequestKind: null as never,
    });
    const parsed = parsePendingNarrativeJob(JSON.parse(JSON.stringify(job)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.job.generationKind).toBeNull();
      expect(parsed.job.sceneRequestKind).toBeNull();
    }
  });

  it("parsePendingNarrativeJob 拒绝非对象输入", () => {
    expect(parsePendingNarrativeJob(null).ok).toBe(false);
    expect(parsePendingNarrativeJob("hello").ok).toBe(false);
    expect(parsePendingNarrativeJob(42).ok).toBe(false);
  });
});

describe("decision boundary classification", () => {
  it("DECISION_BOUNDARY_KINDS 只包含三种语义明确的触发点", () => {
    expect(DECISION_BOUNDARY_KINDS).toEqual([
      "initialization",
      "narrative_choice",
      "npc_free_text",
    ]);
  });

  it("正式剧情二选一分类为 narrative_choice", () => {
    const result = classifyProviderDecisionBoundary({
      action: { type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "support" },
      interactionKind: "fixed_choice",
      fixedChoiceIsCurrentFormalDecision: true,
      focusedNpcId: asNpcId("npc_1"),
    });
    expect(result).toBe("narrative_choice");
  });

  it("正式放弃主线分类为 narrative_choice", () => {
    const result = classifyProviderDecisionBoundary({
      action: { type: "abandon_quest", questId: "quest_main" as never },
      interactionKind: "fixed_choice",
      fixedChoiceIsCurrentFormalDecision: true,
      focusedNpcId: null,
    });
    expect(result).toBe("narrative_choice");
  });

  it("当前焦点 NPC 自定义输入分类为 npc_free_text", () => {
    const result = classifyProviderDecisionBoundary({
      action: { type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "ask" },
      interactionKind: "free_text",
      fixedChoiceIsCurrentFormalDecision: false,
      focusedNpcId: asNpcId("npc_1"),
    });
    expect(result).toBe("npc_free_text");
  });

  it("free_text 发给非焦点 NPC 返回 null", () => {
    const result = classifyProviderDecisionBoundary({
      action: { type: "talk", npcId: asNpcId("npc_2"), dialogueAct: "ask" },
      interactionKind: "free_text",
      fixedChoiceIsCurrentFormalDecision: false,
      focusedNpcId: asNpcId("npc_1"),
    });
    expect(result).toBeNull();
  });

  it("fixed_choice 但不是当前正式决策返回 null", () => {
    const result = classifyProviderDecisionBoundary({
      action: { type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "support" },
      interactionKind: "fixed_choice",
      fixedChoiceIsCurrentFormalDecision: false,
      focusedNpcId: asNpcId("npc_1"),
    });
    expect(result).toBeNull();
  });

  it("移动行动返回 null", () => {
    const result = classifyProviderDecisionBoundary({
      action: { type: "move", locationId: asLocationId("loc_2") as never },
      interactionKind: null,
      fixedChoiceIsCurrentFormalDecision: false,
      focusedNpcId: null,
    });
    expect(result).toBeNull();
  });

  it("探索行动返回 null", () => {
    const result = classifyProviderDecisionBoundary({
      action: { type: "explore" },
      interactionKind: null,
      fixedChoiceIsCurrentFormalDecision: false,
      focusedNpcId: null,
    });
    expect(result).toBeNull();
  });

  it("调查行动返回 null", () => {
    const result = classifyProviderDecisionBoundary({
      action: { type: "investigate", factId: "fact_1" as never },
      interactionKind: null,
      fixedChoiceIsCurrentFormalDecision: false,
      focusedNpcId: null,
    });
    expect(result).toBeNull();
  });

  it("拾取物品行动返回 null", () => {
    const result = classifyProviderDecisionBoundary({
      action: { type: "take_item", itemId: "item_1" as never },
      interactionKind: null,
      fixedChoiceIsCurrentFormalDecision: false,
      focusedNpcId: null,
    });
    expect(result).toBeNull();
  });

  it("交付物品行动返回 null", () => {
    const result = classifyProviderDecisionBoundary({
      action: { type: "give_item", itemId: "item_1" as never, npcId: asNpcId("npc_1") },
      interactionKind: null,
      fixedChoiceIsCurrentFormalDecision: false,
      focusedNpcId: null,
    });
    expect(result).toBeNull();
  });

  it("攻击行动返回 null", () => {
    const result = classifyProviderDecisionBoundary({
      action: { type: "attack", enemyId: "enemy_1" as never },
      interactionKind: null,
      fixedChoiceIsCurrentFormalDecision: false,
      focusedNpcId: null,
    });
    expect(result).toBeNull();
  });

  it("战斗回合行动返回 null", () => {
    const result = classifyProviderDecisionBoundary({
      action: { type: "battle_action", action: "attack" },
      interactionKind: null,
      fixedChoiceIsCurrentFormalDecision: false,
      focusedNpcId: null,
    });
    expect(result).toBeNull();
  });

  it("合成 talk token（无正式交互）返回 null", () => {
    const result = classifyProviderDecisionBoundary({
      action: { type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "ask" },
      interactionKind: null,
      fixedChoiceIsCurrentFormalDecision: false,
      focusedNpcId: asNpcId("npc_1"),
    });
    expect(result).toBeNull();
  });
});
