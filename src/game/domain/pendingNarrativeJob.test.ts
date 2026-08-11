import { describe, expect, it, vi } from "vitest";
import { asNarrativeJobId, asTurnId } from "./events";
import type { ResolvedEvent } from "./resolvedEvent";
import { asLocationId, asNpcId, asQuestId } from "./worldEntity";
import {
  PLAYER_UTTERANCE_MAX_LENGTH,
  createPendingNarrativeJob,
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
  domainEventRange: { fromLedgerIndex: 12, toLedgerIndexExclusive: 15 },
  focusNpcId: asNpcId("npc_1"),
  requestedAt: "2026-08-08T08:00:00.000Z",
  objectiveTransition: { before: null, completed: [], after: null, mode: "unchanged" },
  mandatoryBeats: [],
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
      "domainEventRange",
      "focusNpcId",
      "jobId",
      "mandatoryBeats",
      "objectiveTransition",
      "requestedAt",
      "resolvedEvent",
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
    expect(job.domainEventRange).toEqual({ fromLedgerIndex: 12, toLedgerIndexExclusive: 15 });
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

  it("拒绝无效 ledger range", () => {
    expect(createResult({ domainEventRange: { fromLedgerIndex: 3, toLedgerIndexExclusive: 3 } }).ok).toBe(false);
    expect(createResult({ domainEventRange: { fromLedgerIndex: 5, toLedgerIndexExclusive: 2 } }).ok).toBe(false);
  });

  it("拒绝负数 ledger index", () => {
    expect(createResult({ domainEventRange: { fromLedgerIndex: -1, toLedgerIndexExclusive: 2 } }).ok).toBe(false);
    expect(createResult({ domainEventRange: { fromLedgerIndex: 0, toLedgerIndexExclusive: -1 } }).ok).toBe(false);
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
});