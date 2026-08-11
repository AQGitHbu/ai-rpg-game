import { describe, it, expect } from "vitest";
import {
  approveSceneEventProposals,
  approveScenePerformance,
  POOL_MAX_CANDIDATES,
  ATMOSPHERE_BEAT_ID,
} from "./approveAndWriteScene";
import type { EventCandidate } from "@/game/domain/candidateEvent";
import type { ScenePerformanceProposal } from "./sceneSource";
import { asEnemyId, asLocationId, asNpcId, asFactId, asQuestId } from "@/game/domain/worldEntity";
import type { SceneGenerationContext } from "./sceneGenerationContext";
import { createPendingNarrativeJob, type PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import { asNarrativeJobId, asTurnId } from "@/game/domain/events";
import type { MandatoryNarrativeBeat, ObjectiveTransition } from "@/game/domain/narrativeBeat";

function validCandidate(id: string): EventCandidate {
  return {
    id,
    kind: "enemy_appears",
    involvedEntityIds: ["enemy_1", "loc_1"],
    prerequisiteFactIds: [],
    proposedEffects: [{ kind: "enemy_appears", enemyId: asEnemyId("enemy_1"), locationId: asLocationId("loc_1") }],
    intendedPacing: "complicate",
    reason: "敌人在起点现身",
    proposedAtTurn: 3,
    expiresAtTurn: 6,
  };
}

describe("approveSceneEventProposals (Task 21)", () => {
  it("空提议保持池不变，accept 0", () => {
    const result = approveSceneEventProposals({ existingPool: [], proposals: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextCandidateEventPool).toEqual([]);
    expect(result.acceptedIds).toEqual([]);
  });

  it("合法候选追加进池", () => {
    const result = approveSceneEventProposals({ existingPool: [], proposals: [validCandidate("ce-1")] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextCandidateEventPool.map((c) => c.id)).toEqual(["ce-1"]);
    expect(result.acceptedIds).toEqual(["ce-1"]);
  });

  it("非法候选丢弃，不拖垮整个合法场景；仅合法候选入池", () => {
    const malformed = { ...validCandidate("ce-bad"), proposedEffects: [] };
    const ok = validCandidate("ce-good");
    const result = approveSceneEventProposals({ existingPool: [], proposals: [malformed, ok] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextCandidateEventPool.map((c) => c.id)).toEqual(["ce-good"]);
    expect(result.rejected.some((r) => r.id === "ce-bad")).toBe(true);
  });

  it("夹带 path patch 的候选被拒绝并分类为 path_patch", () => {
    const pathPatch = {
      ...validCandidate("ce-patch"),
      proposedEffects: [{ kind: "arbitrary_patch", path: "worldState.player.stats.hp", value: 999 }],
    } as unknown as EventCandidate;
    const result = approveSceneEventProposals({ existingPool: [], proposals: [pathPatch] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextCandidateEventPool).toEqual([]);
    expect(result.rejected.some((r) => r.id === "ce-patch" && r.reasonCode === "path_patch")).toBe(true);
  });

  it("FIFO 上限 8：超出部分从池头裁剪", () => {
    const existing = Array.from({ length: POOL_MAX_CANDIDATES }, (_, i) => validCandidate(`old-${i}`));
    const fresh = validCandidate("new-1");
    const result = approveSceneEventProposals({ existingPool: existing, proposals: [fresh] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextCandidateEventPool.length).toBe(POOL_MAX_CANDIDATES);
    expect(result.nextCandidateEventPool.map((c) => c.id)).not.toContain("old-0");
    expect(result.nextCandidateEventPool.map((c) => c.id)).toContain("new-1");
  });

  it("同 ID 去重：已存在于池中的候选不再追加", () => {
    const existing = [validCandidate("ce-dup")];
    const result = approveSceneEventProposals({ existingPool: existing, proposals: [validCandidate("ce-dup")] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const count = result.nextCandidateEventPool.filter((c) => c.id === "ce-dup").length;
    expect(count).toBe(1);
  });

  it("函数只返回池与采纳记录，绝不改动 World State/tension/任务/关系", () => {
    const result = approveSceneEventProposals({ existingPool: [], proposals: [validCandidate("ce-1")] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect("worldState" in result).toBe(false);
    expect("storyState" in result).toBe(false);
  });
});

// ── Task 6：场景表演审批（approveScenePerformance）────────────────────────

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
    currentLocation: { id: asLocationId("loc_1"), name: "客栈", description: "t", kind: "main" },
    publicWorldFacts: [],
    sceneVisibleFacts: [],
    presentNpcs: overrides.presentNpcs ?? [{
      id: asNpcId("npc_1"), name: "老板", role: "路人", publicProfile: "t",
      knownFactCards: [{ factId: asFactId("fact_a"), text: "已知" }],
      hiddenFactCards: [], sceneVisibleFactIds: [asFactId("fact_vis")],
      recentInteractionSummaries: [], recentInteractionActionIds: ["inter_1"],
      relationship: { affinity: 0 }, emotion: "neutral",
      goals: [], forbiddenKnowledgeIds: [],
    }],
    story: {
      currentAct: 1, targetActs: 3, tension: 30, nextPacingNeed: "reveal",
      remainingBudget: { remainingLocations: 1, remainingNpcs: 1, remainingEvents: 1 },
      unresolvedThreadSummaries: [],
      style: { personalityTags: ["冷静"], narrativeStyle: "concise", contentIntensity: "normal" },
    },
    recentBeats: [],
    legalActionCandidates: overrides.legalActionCandidates ?? [
      { kind: "talk", label: "与老板交谈", targetId: "npc_1" },
      { kind: "explore", label: "查看四周" },
    ],
    legalEventTargets: {
      locationIds: [asLocationId("loc_1"), asLocationId("loc_2")],
      factIds: [asFactId("fact_a"), asFactId("fact_vis")],
      itemIds: ["item_1" as never],
      enemyIds: [asEnemyId("enemy_1")],
    },
    worldConstraints: [],
    objectiveTransition: job.objectiveTransition,
    mandatoryBeats: job.mandatoryBeats,
    beatSubjects: [],
    objectiveTarget: overrides.objectiveTarget ?? null,
  };
}

function makeProposal(overrides?: Partial<ScenePerformanceProposal>): ScenePerformanceProposal {
  return {
    sceneId: "scene-1",
    segments: [{ beatId: ATMOSPHERE_BEAT_ID, text: "场景旁白" }],
    npcLine: null,
    objectiveLink: null,
    choices: [
      { candidateId: "candidate_1", label: "支持老板" },
      { candidateId: "candidate_2", label: "质疑老板" },
    ],
    source: "generated",
    ...overrides,
  };
}

const progressionTransition: ObjectiveTransition = {
  before: { questId: asQuestId("quest_0"), objectiveIndex: 0, label: "与老板交谈" },
  completed: [{ questId: asQuestId("quest_0"), objectiveIndex: 0, label: "与老板交谈" }],
  after: { questId: asQuestId("quest_0"), objectiveIndex: 1, label: "获取盟誓印谱" },
  mode: "progressed",
};

describe("approveScenePerformance (Task 6)", () => {
  it("合法提案重建 ready scene + registry：narration 由 segment 按顺序拼接，token 绑定写回后 revision", () => {
    const result = approveScenePerformance({
      context: makeContext(),
      proposal: makeProposal(),
      basedOnRevision: 8,
      existingCandidateEventPool: [validCandidate("pool-1")],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.narration).toBe("场景旁白");
    expect(JSON.stringify(result.scene)).not.toContain("actionKey");
    expect(result.scene.event?.kind).toBe("dialogue");
    expect(result.choiceRegistry).toHaveLength(2);
    expect(new Set(result.choiceRegistry.map((x) => x.choiceToken)).size).toBe(2);
    expect(result.choiceRegistry.every((x) => x.basedOnRevision === 8)).toBe(true);
    // 场景表演契约不含候选事件：candidateEventPool 原样保留
    expect(result.candidateEventPool.map((c) => c.id)).toEqual(["pool-1"]);
  });

  it("segments 为空 → 整场拒绝 empty_segments", () => {
    const result = approveScenePerformance({
      context: makeContext(),
      proposal: makeProposal({ segments: [] }),
      basedOnRevision: 8,
      existingCandidateEventPool: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("empty_segments");
  });

  it("遗漏强制节拍 → 整场拒绝 missing_mandatory_beat", () => {
    const job = makeJob({
      beats: [
        { beatId: "item_0", kind: "item_obtained", subjectIds: ["item_1"], instruction: "获得物品「盟誓印谱」" },
        { beatId: ATMOSPHERE_BEAT_ID, kind: "atmosphere", subjectIds: [], instruction: "氛围" },
      ],
    });
    const result = approveScenePerformance({
      context: makeContext({ job }),
      proposal: makeProposal({ segments: [{ beatId: ATMOSPHERE_BEAT_ID, text: "氛围描写" }] }),
      basedOnRevision: 8,
      existingCandidateEventPool: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("missing_mandatory_beat");
  });

  it("自创节拍 ID（不在服务端提供的集合）→ 整场拒绝 invented_beat_id", () => {
    const job = makeJob({
      beats: [{ beatId: "item_0", kind: "item_obtained", subjectIds: ["item_1"], instruction: "获得物品" }],
    });
    const result = approveScenePerformance({
      context: makeContext({ job }),
      proposal: makeProposal({ segments: [{ beatId: "hallucinated_beat", text: "编造的节拍" }] }),
      basedOnRevision: 8,
      existingCandidateEventPool: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invented_beat_id");
  });

  it("节拍乱序（不符合服务端顺序）→ 整场拒绝 out_of_order_beats", () => {
    const job = makeJob({
      beats: [
        { beatId: "item_0", kind: "item_obtained", subjectIds: ["item_1"], instruction: "获得物品" },
        { beatId: "battle_0", kind: "battle_resolved", subjectIds: ["enemy_1"], instruction: "战斗胜利" },
      ],
    });
    const result = approveScenePerformance({
      context: makeContext({ job }),
      proposal: makeProposal({ segments: [
        { beatId: "battle_0", text: "战斗胜利" },
        { beatId: "item_0", text: "获得物品" },
      ] }),
      basedOnRevision: 8,
      existingCandidateEventPool: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("out_of_order_beats");
  });

  it("atmosphere 节拍为可选且必须放在最后", () => {
    const job = makeJob({
      beats: [
        { beatId: "item_0", kind: "item_obtained", subjectIds: ["item_1"], instruction: "获得物品" },
        { beatId: ATMOSPHERE_BEAT_ID, kind: "atmosphere", subjectIds: [], instruction: "氛围" },
      ],
    });
    // 省略 atmosphere → 合法
    const without = approveScenePerformance({
      context: makeContext({ job }),
      proposal: makeProposal({ segments: [{ beatId: "item_0", text: "获得物品" }] }),
      basedOnRevision: 8,
      existingCandidateEventPool: [],
    });
    expect(without.ok).toBe(true);
    // 放在最后 → 合法
    const withFlavor = approveScenePerformance({
      context: makeContext({ job }),
      proposal: makeProposal({ segments: [
        { beatId: "item_0", text: "获得物品" },
        { beatId: ATMOSPHERE_BEAT_ID, text: "暮色渐沉" },
      ] }),
      basedOnRevision: 8,
      existingCandidateEventPool: [],
    });
    expect(withFlavor.ok).toBe(true);
  });

  it("台词 NPC 不在场 → 整场拒绝 unknown_dialogue_npc", () => {
    const result = approveScenePerformance({
      context: makeContext(),
      proposal: makeProposal({
        npcLine: { npcId: "ghost", text: "你是谁", emotion: "neutral", answeredBeatIds: [], usedFactIds: [], usedInteractionActionIds: [] },
      }),
      basedOnRevision: 8,
      existingCandidateEventPool: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("unknown_dialogue_npc");
  });

  it("NPC 使用 forbidden/unknown fact → 整场拒绝 npc_uses_forbidden_fact", () => {
    const result = approveScenePerformance({
      context: makeContext(),
      proposal: makeProposal({
        npcLine: { npcId: "npc_1", text: "这是秘密", emotion: "neutral", answeredBeatIds: [], usedFactIds: ["fact_forbidden"], usedInteractionActionIds: [] },
      }),
      basedOnRevision: 8,
      existingCandidateEventPool: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("npc_uses_forbidden_fact");
  });

  it("NPC 使用自己 known/scene-visible fact → 通过", () => {
    const result = approveScenePerformance({
      context: makeContext(),
      proposal: makeProposal({
        npcLine: { npcId: "npc_1", text: "我知道这个", emotion: "neutral", answeredBeatIds: [], usedFactIds: ["fact_a"], usedInteractionActionIds: [] },
      }),
      basedOnRevision: 8,
      existingCandidateEventPool: [],
    });
    expect(result.ok).toBe(true);
  });

  it("引用其他 NPC 的交互（不在本 NPC recentInteractionActionIds）→ 整场拒绝 wrong_npc_interaction", () => {
    const result = approveScenePerformance({
      context: makeContext(),
      proposal: makeProposal({
        npcLine: { npcId: "npc_1", text: "上次你问我的事……", emotion: "neutral", answeredBeatIds: [], usedFactIds: [], usedInteractionActionIds: ["other_npc_action"] },
      }),
      basedOnRevision: 8,
      existingCandidateEventPool: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("wrong_npc_interaction");
  });

  it("引用本 NPC 自己的交互 → 通过", () => {
    const result = approveScenePerformance({
      context: makeContext(),
      proposal: makeProposal({
        npcLine: { npcId: "npc_1", text: "上次你问我的事……", emotion: "neutral", answeredBeatIds: [], usedFactIds: [], usedInteractionActionIds: ["inter_1"] },
      }),
      basedOnRevision: 8,
      existingCandidateEventPool: [],
    });
    expect(result.ok).toBe(true);
  });

  // ── Task 5 扩展：player_utterance 应答 ─────────────────────────────────

  function utteranceContext() {
    return makeContext({
      job: makeJob({
        utterance: "商队失踪的事你知道吗？",
        beats: [
          { beatId: "player_utterance", kind: "player_utterance", subjectIds: ["npc_1"], instruction: "直接回应玩家" },
          { beatId: ATMOSPHERE_BEAT_ID, kind: "atmosphere", subjectIds: [], instruction: "氛围" },
        ],
      }),
    });
  }

  it("有 player_utterance 节拍但提案没有 NPC 台词 → 整场拒绝 player_utterance_unanswered", () => {
    const result = approveScenePerformance({
      context: utteranceContext(),
      proposal: makeProposal({
        segments: [
          { beatId: "player_utterance", text: "你提出了你的疑问。" },
          { beatId: ATMOSPHERE_BEAT_ID, text: "暮色渐沉" },
        ],
        npcLine: null,
      }),
      basedOnRevision: 8,
      existingCandidateEventPool: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("player_utterance_unanswered");
  });

  it("有 player_utterance 节拍但台词来自错误 NPC → 整场拒绝 player_utterance_unanswered", () => {
    const other: SceneGenerationContext["presentNpcs"][number] = {
      id: asNpcId("npc_2"), name: "客人", role: "酒客", publicProfile: "t",
      knownFactCards: [], hiddenFactCards: [], sceneVisibleFactIds: [],
      recentInteractionSummaries: [], recentInteractionActionIds: [],
      relationship: { affinity: 0 }, emotion: "neutral",
      goals: [], forbiddenKnowledgeIds: [],
    };
    const result = approveScenePerformance({
      context: makeContext({
        presentNpcs: [makeContext().presentNpcs[0]!, other],
        job: utteranceContext().job,
      }),
      proposal: makeProposal({
        segments: [
          { beatId: "player_utterance", text: "你提出了你的疑问。" },
          { beatId: ATMOSPHERE_BEAT_ID, text: "暮色渐沉" },
        ],
        npcLine: { npcId: "npc_2", text: "这件事交给他", emotion: "neutral", answeredBeatIds: ["player_utterance"], usedFactIds: [], usedInteractionActionIds: [] },
      }),
      basedOnRevision: 8,
      existingCandidateEventPool: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("player_utterance_unanswered");
  });

  it("有 player_utterance 节拍且台词命中焦点 NPC + 应答 ID → 通过", () => {
    const result = approveScenePerformance({
      context: utteranceContext(),
      proposal: makeProposal({
        segments: [
          { beatId: "player_utterance", text: "你提出了你的疑问。" },
          { beatId: ATMOSPHERE_BEAT_ID, text: "暮色渐沉" },
        ],
        npcLine: { npcId: "npc_1", text: "这件事我也正想说。", emotion: "warm", answeredBeatIds: ["player_utterance"], usedFactIds: [], usedInteractionActionIds: [] },
      }),
      basedOnRevision: 8,
      existingCandidateEventPool: [],
    });
    expect(result.ok).toBe(true);
  });

  // ── 目标一致性 ─────────────────────────────────────────────────────────

  it("after 存在但 objectiveLink 缺失/不匹配 → 整场拒绝 stale_objective_link", () => {
    const job = makeJob({ transition: progressionTransition });
    const context = makeContext({
      job,
      objectiveTarget: { questId: "quest_0", objectiveIndex: 1, entityId: "item_1", entityName: "盟誓印谱" },
    });
    const missing = approveScenePerformance({
      context,
      proposal: makeProposal({ objectiveLink: null }),
      basedOnRevision: 8,
      existingCandidateEventPool: [],
    });
    const mismatch = approveScenePerformance({
      context,
      proposal: makeProposal({ objectiveLink: { questId: "quest_9", objectiveIndex: 0, mode: "hint" } }),
      basedOnRevision: 8,
      existingCandidateEventPool: [],
    });
    for (const result of [missing, mismatch]) {
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("stale_objective_link");
    }
  });

  it("after 不存在但提案带 objectiveLink → 整场拒绝 stale_objective_link", () => {
    const result = approveScenePerformance({
      context: makeContext(),
      proposal: makeProposal({ objectiveLink: { questId: "quest_0", objectiveIndex: 0, mode: "hint" } }),
      basedOnRevision: 8,
      existingCandidateEventPool: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("stale_objective_link");
  });

  it("after 存在且匹配 → objectiveLink 通过（推进类选项命中目标时）", () => {
    const job = makeJob({
      eventKind: "dialogue",
      transition: progressionTransition,
    });
    const result = approveScenePerformance({
      context: makeContext({
        job,
        objectiveTarget: { questId: "quest_0", objectiveIndex: 1, entityId: "npc_1", entityName: "老板" },
      }),
      proposal: makeProposal({ objectiveLink: { questId: "quest_0", objectiveIndex: 1, mode: "progress" } }),
      basedOnRevision: 8,
      existingCandidateEventPool: [],
    });
    expect(result.ok).toBe(true);
  });

  it("choices 使用重复 candidateId → 整场拒绝 duplicate_candidate_ids", () => {
    const result = approveScenePerformance({
      context: makeContext(),
      proposal: makeProposal({ choices: [
        { candidateId: "candidate_1", label: "A" },
        { candidateId: "candidate_1", label: "B" },
      ] }),
      basedOnRevision: 8,
      existingCandidateEventPool: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("duplicate_candidate_ids");
  });

  it("choices 引用非服务端合法 candidateId → 整场拒绝 illegal_choice_target", () => {
    const result = approveScenePerformance({
      context: makeContext(),
      proposal: makeProposal({ choices: [
        { candidateId: "invented_1", label: "A" },
        { candidateId: "candidate_2", label: "B" },
      ] }),
      basedOnRevision: 8,
      existingCandidateEventPool: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("illegal_choice_target");
  });

  it("after 存在且有可推进选项，但提案未选择任何推进选项 → 整场拒绝 no_objective_progress_choices", () => {
    const job = makeJob({
      eventKind: "travel",
      summary: { kind: "move", locationId: asLocationId("loc_2") },
      transition: {
        before: null,
        completed: [],
        after: { questId: asQuestId("quest_0"), objectiveIndex: 0, label: "前往街道" },
        mode: "unchanged",
      },
    });
    const context = makeContext({
      job,
      objectiveTarget: { questId: "quest_0", objectiveIndex: 0, entityId: "loc_2", entityName: "街道" },
      legalActionCandidates: [
        { kind: "move", label: "前往客栈", targetId: "loc_1" },
        { kind: "move", label: "前往街道", targetId: "loc_2" },
        { kind: "explore", label: "查看四周" },
      ],
    });
    const result = approveScenePerformance({
      context,
      proposal: makeProposal({
        objectiveLink: { questId: "quest_0", objectiveIndex: 0, mode: "hint" },
        choices: [
          { candidateId: "candidate_1", label: "前往客栈" },
          { candidateId: "candidate_3", label: "查看四周" },
        ],
      }),
      basedOnRevision: 8,
      existingCandidateEventPool: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("no_objective_progress_choices");
  });

  it("after 存在且有可推进选项，提案选择推进选项 → 通过", () => {
    const job = makeJob({
      eventKind: "travel",
      summary: { kind: "move", locationId: asLocationId("loc_2") },
      transition: {
        before: null,
        completed: [],
        after: { questId: asQuestId("quest_0"), objectiveIndex: 0, label: "前往街道" },
        mode: "unchanged",
      },
    });
    const context = makeContext({
      job,
      objectiveTarget: { questId: "quest_0", objectiveIndex: 0, entityId: "loc_2", entityName: "街道" },
      legalActionCandidates: [
        { kind: "move", label: "前往客栈", targetId: "loc_1" },
        { kind: "move", label: "前往街道", targetId: "loc_2" },
      ],
    });
    const result = approveScenePerformance({
      context,
      proposal: makeProposal({
        objectiveLink: { questId: "quest_0", objectiveIndex: 0, mode: "hint" },
        choices: [
          { candidateId: "candidate_2", label: "前往街道" },
          { candidateId: "candidate_1", label: "前往客栈" },
        ],
      }),
      basedOnRevision: 8,
      existingCandidateEventPool: [],
    });
    expect(result.ok).toBe(true);
  });

  it("幕推进时 quest_advanced 节拍未点名新目标实体 → 整场拒绝 quest_advanced_unnamed", () => {
    const job = makeJob({
      eventKind: "travel",
      summary: { kind: "move", locationId: asLocationId("loc_2") },
      transition: {
        before: { questId: asQuestId("quest_0"), objectiveIndex: 0, label: "与老板交谈" },
        completed: [],
        after: { questId: asQuestId("quest_0"), objectiveIndex: 1, label: "获取盟誓印谱" },
        mode: "advanced_act",
      },
      beats: [
        { beatId: "quest_adv_0", kind: "quest_advanced", subjectIds: ["quest_0"], instruction: "主线推进，当前目标：获取盟誓印谱" },
        { beatId: ATMOSPHERE_BEAT_ID, kind: "atmosphere", subjectIds: [], instruction: "氛围" },
      ],
    });
    const result = approveScenePerformance({
      context: makeContext({
        job,
        objectiveTarget: { questId: "quest_0", objectiveIndex: 1, entityId: "item_seal", entityName: "盟誓印谱" },
      }),
      proposal: makeProposal({
        objectiveLink: { questId: "quest_0", objectiveIndex: 1, mode: "handoff" },
        segments: [
          { beatId: "quest_adv_0", text: "主线推进到新阶段。" },
          { beatId: ATMOSPHERE_BEAT_ID, text: "暮色渐沉" },
        ],
      }),
      basedOnRevision: 8,
      existingCandidateEventPool: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("quest_advanced_unnamed");
  });

  it("幕推进时 quest_advanced 节拍点名新目标实体 → 通过", () => {
    const job = makeJob({
      eventKind: "travel",
      summary: { kind: "move", locationId: asLocationId("loc_2") },
      transition: {
        before: { questId: asQuestId("quest_0"), objectiveIndex: 0, label: "与老板交谈" },
        completed: [],
        after: { questId: asQuestId("quest_0"), objectiveIndex: 1, label: "获取盟誓印谱" },
        mode: "advanced_act",
      },
      beats: [
        { beatId: "quest_adv_0", kind: "quest_advanced", subjectIds: ["quest_0"], instruction: "主线推进，当前目标：获取盟誓印谱" },
        { beatId: ATMOSPHERE_BEAT_ID, kind: "atmosphere", subjectIds: [], instruction: "氛围" },
      ],
    });
    const result = approveScenePerformance({
      context: makeContext({
        job,
        objectiveTarget: { questId: "quest_0", objectiveIndex: 1, entityId: "item_seal", entityName: "盟誓印谱" },
      }),
      proposal: makeProposal({
        objectiveLink: { questId: "quest_0", objectiveIndex: 1, mode: "handoff" },
        segments: [
          { beatId: "quest_adv_0", text: "主线推进，接下来要获取盟誓印谱。" },
          { beatId: ATMOSPHERE_BEAT_ID, text: "暮色渐沉" },
        ],
      }),
      basedOnRevision: 8,
      existingCandidateEventPool: [],
    });
    expect(result.ok).toBe(true);
  });

  it("非法提案不铸造 registry/writeback", () => {
    const result = approveScenePerformance({
      context: makeContext(),
      proposal: makeProposal({ segments: [] }),
      basedOnRevision: 8,
      existingCandidateEventPool: [],
    });
    expect(result.ok).toBe(false);
    expect("choiceRegistry" in result).toBe(false);
    expect("scene" in result).toBe(false);
  });
});
