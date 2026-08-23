import { describe, it, expect } from "vitest";
import {
  createDeterministicSceneSource,
  buildEventState,
  buildSelectableSceneCandidates,
  buildSceneChoices,
  formatSceneChoiceLabel,
  buildInvestigationOutcomeNarrative,
} from "./deterministicSceneSource";
import { buildStylePolicy } from "./stylePolicy";
import { approveScenePerformance } from "./approveAndWriteScene";
import type { LocationEntry, NpcEntry } from "@/game/domain/worldState";
import { createInitialStoryState, type StoryState } from "@/game/domain/storyState";
import { asLocationId, asNpcId, asFactId, asQuestId } from "@/game/domain/worldEntity";
import { asNarrativeJobId, asTurnId } from "@/game/domain/events";
import { createPendingNarrativeJob, type PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import type { ResolvedEvent, ResolvedEventStatus } from "@/game/domain/resolvedEvent";
import type { SceneGenerationContext } from "./sceneGenerationContext";
import type { NarrativeEventKind } from "@/game/domain/narrative";
import type { FocusNpcContext } from "./focusNpcContext";
import type { RelationshipTier } from "@/game/domain/relationship";
import type { ObjectiveTransition } from "@/game/domain/narrativeBeat";

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
const npc2: NpcEntry = {
  id: asNpcId("npc_2"), name: "客人", role: "酒客", description: "t",
  locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
  memory: { npcId: asNpcId("npc_2"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
};

function makeStory(): StoryState {
  return createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 2, npcs: 2, quests: 0, events: 0 } });
}

function makeResolvedEvent(
  status: ResolvedEventStatus = "success",
  eventKind: NarrativeEventKind = "observe",
  facts: ResolvedEvent["facts"] = [],
): ResolvedEvent {
  return {
    actionId: "act_test",
    status,
    eventKind,
    facts,
    stateChanges: [],
    costs: [],
    rewards: [],
    triggeredEvents: [],
    rejectedEffects: [],
  };
}

type JobOverrides = {
  jobId?: string;
  actionId?: string;
  status?: ResolvedEventStatus;
  eventKind?: NarrativeEventKind;
  summary?: PendingNarrativeJob["actionSummary"];
  utterance?: string;
  focusNpcId?: string;
  beats?: PendingNarrativeJob["mandatoryBeats"];
  transition?: ObjectiveTransition;
};

function makeJob(overrides: JobOverrides = {}): PendingNarrativeJob {
  const result = createPendingNarrativeJob({
    jobId: asNarrativeJobId(overrides.jobId ?? "job_1"),
    turnId: asTurnId("turn_1"),
    actionId: overrides.actionId ?? "act_test",
    expectedRevision: 0,
    turnNumber: 1,
    actionSummary: overrides.summary ?? { kind: "move", locationId: asLocationId("loc_2") },
    utterance: overrides.utterance,
    resolvedEvent: makeResolvedEvent(overrides.status, overrides.eventKind),
    domainEventRange: { fromLedgerIndex: 1, toLedgerIndexExclusive: 2 },
    focusNpcId: overrides.focusNpcId !== undefined ? asNpcId(overrides.focusNpcId) : undefined,
    requestedAt: "2026-01-02",
    objectiveTransition: overrides.transition ?? { before: null, completed: [], after: null, mode: "unchanged" },
    mandatoryBeats: overrides.beats ?? [],
  });
  if (!result.ok) throw new Error("fixture job 构造失败");
  return result.job;
}

function makeFocusContext(tier: RelationshipTier): FocusNpcContext {
  return {
    id: asNpcId("npc_1"),
    name: "老板",
    role: "客栈老板",
    publicProfile: "热情的老板",
    responsePolicy: {
      tier,
      toneInstruction: tier === "hostile" ? "简短冷淡，拒绝配合" : "坦诚相待",
      initiative: tier === "hostile" ? "refuse" : "proactive",
      allowedDisclosureFactIds: tier === "hostile" ? [] : [asFactId("fact_1")],
      privateKnowledgeIds: [],
    },
    speakableFactCards: tier === "hostile" ? [] : [{ factId: asFactId("fact_1"), text: "矿坑里藏着密道" }],
    recentInteractions: [],
    goals: [],
    emotion: tier === "hostile" ? "angry" : "warm",
    thisTurn: { relationshipDelta: tier === "hostile" ? -2 : 2, outcome: tier === "hostile" ? "negative" : "positive" },
  };
}

// 最小上下文构造：直接按 SceneGenerationContext 契约组装（不引用完整的 record）。
function makeContext(job: PendingNarrativeJob, focus?: FocusNpcContext): SceneGenerationContext {
  const ss = makeStory();
  return {
    job,
    player: { name: "侠客", identity: "剑客", knownFactCards: [] },
    currentLocation: { id: loc1.id, name: loc1.name, description: loc1.description, kind: "main" },
    publicWorldFacts: [],
    sceneVisibleFacts: [],
    presentNpcs: [npc1, npc2].map((n) => ({
      id: n.id, name: n.name, role: n.role, publicProfile: n.description,
      knownFactCards: [], hiddenFactCards: [], sceneVisibleFactIds: [],
      recentInteractionSummaries: [], recentInteractionActionIds: [],
      relationship: { affinity: 0 }, emotion: "neutral",
      goals: [], forbiddenKnowledgeIds: [],
    })),
    story: {
      currentAct: ss.currentAct, targetActs: ss.targetActs, tension: ss.tension,
      nextPacingNeed: ss.nextPacingNeed,
      contract: {
        centralConflict: "商队失踪案背后的内应",
        endingDirections: [
          { key: "trust", theme: "共同揭露" },
          { key: "doubt", theme: "独自追查" },
        ],
      },
      remainingBudget: { remainingLocations: 1, remainingNpcs: 1, remainingEvents: 1 },
      unresolvedThreadSummaries: [],
      stylePolicy: buildStylePolicy(),
    },
    recentBeats: [],
    legalActionCandidates: [
      { kind: "move", label: `前往${loc2.name}`, targetId: loc2.id },
      { kind: "explore", label: "查看四周" },
    ],
    legalEventTargets: {
      locationIds: [loc1.id, loc2.id], factIds: [], itemIds: [], enemyIds: [],
    },
    worldConstraints: [],
    objectiveTransition: job.objectiveTransition,
    mandatoryBeats: job.mandatoryBeats,
    beatSubjects: [],
    objectiveTarget: null,
    ...(focus !== undefined ? { focusNpcContext: focus } : {}),
  };
}

/** talk job + 玩家原话 + 焦点 NPC 上下文的快速构造。 */
function makeUtteranceContext(tier: RelationshipTier): SceneGenerationContext {
  const job = makeJob({
    eventKind: "dialogue",
    summary: { kind: "talk", npcId: asNpcId("npc_1") },
    focusNpcId: "npc_1",
    utterance: "你知道商队失踪的事吗？",
    beats: [{ beatId: "player_utterance", kind: "player_utterance", subjectIds: ["npc_1"], instruction: "直接回应玩家" }],
  });
  return makeContext(job, makeFocusContext(tier));
}

describe("deterministicSceneSource", () => {
  const source = createDeterministicSceneSource();

  it("derives sceneId purely from the job: scene-<jobId>, identical across calls", async () => {
    const context = makeContext(makeJob({ jobId: "job_7" }));
    const first = await source.generateScene(context);
    if (!first.ok) throw new Error("expected success");
    const second = await source.generateScene(context);
    if (!second.ok) throw new Error("expected success");
    expect(first.proposal.sceneId).toBe("scene-job_7");
    expect(second.proposal.sceneId).toBe("scene-job_7");
  });

  it("is fully deterministic: same context → same proposal package", async () => {
    const context = makeContext(makeJob({ jobId: "job_det" }));
    const first = await source.generateScene(context);
    if (!first.ok) throw new Error("expected success");
    const second = await source.generateScene(context);
    if (!second.ok) throw new Error("expected success");
    expect(first).toEqual(second);
    expect(first.proposal.choices).toHaveLength(2);
  });

  it("produces a performance proposal with segments, two distinct legal choices and source=fallback", async () => {
    const result = await source.generateScene(makeContext(makeJob({ eventKind: "travel" })));
    if (!result.ok) throw new Error("expected success");
    expect(result.proposal.segments.length).toBeGreaterThan(0);
    expect(result.proposal.source).toBe("fallback");
    expect(result.proposal.choices).toHaveLength(2);
    expect(result.proposal.choices[0].candidateId).not.toBe(result.proposal.choices[1].candidateId);
    expect(result.proposal.choices.every((choice) => choice.label.length > 0)).toBe(true);
  });

  it("deterministic proposal passes the same approval used for generated scenes", async () => {
    const context = makeContext(makeJob({ eventKind: "travel" }));
    const sceneResult = await source.generateScene(context);
    if (!sceneResult.ok) throw new Error("expected success");
    const approved = approveScenePerformance({
      context,
      proposal: sceneResult.proposal,
      basedOnRevision: 1,
      existingCandidateEventPool: [],
    });
    expect(approved.ok).toBe(true);
    if (approved.ok) {
      expect(approved.scene.source).toBe("fallback");
      expect(approved.scene.narration.length).toBeGreaterThan(0);
    }
  });

  it("maps a move/travel job to a travel event state", async () => {
    const context = makeContext(makeJob({ eventKind: "travel", summary: { kind: "move", locationId: asLocationId("loc_2") } }));
    expect(buildEventState(context)).toEqual({ kind: "travel", locationId: asLocationId("loc_1") });
  });

  it("maps a talk job to a dialogue event state focused on the job NPC", async () => {
    const context = makeContext(makeJob({
      eventKind: "dialogue",
      summary: { kind: "talk", npcId: asNpcId("npc_1") },
      focusNpcId: "npc_1",
    }));
    expect(buildEventState(context)).toEqual({ kind: "dialogue", focusNpcId: asNpcId("npc_1") });
    const result = await source.generateScene(context);
    if (!result.ok) throw new Error("expected success");
    expect(result.proposal.npcLine?.npcId).toBe("npc_1");
  });

  it("keeps the old NPC as the speaker during an advanced-act handoff while exposing the new objective", async () => {
    const transition: ObjectiveTransition = {
      before: { questId: asQuestId("quest_0"), objectiveIndex: 0, label: "与客栈老板交谈" },
      completed: [],
      after: { questId: asQuestId("quest_1"), objectiveIndex: 0, label: "与客人交谈" },
      mode: "advanced_act",
    };
    const context: SceneGenerationContext = {
      ...makeContext(makeJob({
        eventKind: "dialogue",
        summary: { kind: "talk", npcId: asNpcId("npc_1") },
        focusNpcId: "npc_1",
        transition,
      })),
      legalActionCandidates: [
        { kind: "talk", label: "与客栈老板交谈", targetId: "npc_1" },
        { kind: "talk", label: "与客人交谈", targetId: "npc_2" },
      ],
      objectiveTarget: {
        questId: "quest_1",
        objectiveIndex: 0,
        entityId: "npc_2",
        entityName: "客人",
      },
      focusNpcContext: makeFocusContext("neutral"),
    };

    expect(buildEventState(context)).toEqual({ kind: "observe", locationId: asLocationId("loc_1") });
    const candidates = buildSelectableSceneCandidates(context);
    expect(candidates.map((candidate) => candidate.label)).toEqual([
      "与客栈老板交谈",
      "与客人交谈",
    ]);
    expect(candidates[0]?.action).toEqual({ type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "ask" });
    expect(candidates[1]?.action).toEqual({ type: "talk", npcId: asNpcId("npc_2"), dialogueAct: "ask" });
    expect(buildSceneChoices(context)[0]?.label).toBe("与客人交谈");
    const result = await source.generateScene(context);
    if (!result.ok) throw new Error("expected success");
    expect(result.proposal.npcLine?.npcId).toBe("npc_1");
  });

  it("dialogue choices use structured facts rather than NPC role keywords", () => {
    const base = makeContext(makeJob({
      eventKind: "dialogue",
      summary: { kind: "talk", npcId: asNpcId("npc_1") },
      focusNpcId: "npc_1",
    }), makeFocusContext("neutral"));
    const context: SceneGenerationContext = {
      ...base,
      focusNpcContext: {
        ...makeFocusContext("neutral"),
        role: "失踪镖队幸存者",
        name: "苏绾",
      },
      presentNpcs: base.presentNpcs.map((npc) => npc.id === asNpcId("npc_1")
        ? { ...npc, name: "苏绾", role: "失踪镖队幸存者" }
        : npc),
    };
    const choices = buildSelectableSceneCandidates(context);
    expect(choices[0]?.label).toContain("线索");
    expect(choices[0]?.action.type).toBe("talk");
    expect(choices[1]?.action.type).toBe("talk");
    expect(choices[1]?.label).toContain("证物");
    const sameFactsWithAnotherRole = buildSelectableSceneCandidates({
      ...context,
      focusNpcContext: { ...context.focusNpcContext!, role: "完全不同的身份" },
      presentNpcs: context.presentNpcs.map((npc) => npc.id === asNpcId("npc_1")
        ? { ...npc, role: "完全不同的身份" }
        : npc),
    });
    expect(sameFactsWithAnotherRole.map((choice) => choice.label)).toEqual(choices.map((choice) => choice.label));
  });

  it("dialogue choice copy varies with the structured conversation context", () => {
    const base = makeContext(makeJob({
      actionId: "act_dialogue_0",
      eventKind: "dialogue",
      summary: { kind: "talk", npcId: asNpcId("npc_1") },
      focusNpcId: "npc_1",
    }));
    const contextA: SceneGenerationContext = {
      ...base,
      generationSeed: "dialogue-variation-test",
      focusNpcContext: {
        ...makeFocusContext("neutral"),
        role: "旧案传讯人",
        name: "顾砚",
      },
      presentNpcs: base.presentNpcs.map((npc) => npc.id === asNpcId("npc_1")
        ? { ...npc, name: "顾砚", role: "旧案传讯人" }
        : npc),
    };
    const contextB: SceneGenerationContext = {
      ...contextA,
      job: { ...contextA.job, actionId: "act_dialogue_1", turnNumber: contextA.job.turnNumber + 1 },
    };
    const contextC: SceneGenerationContext = {
      ...contextA,
      generationSeed: "different-opening-seed",
    };

    const labelsA = buildSelectableSceneCandidates(contextA).map((choice) => choice.label);
    const labelsB = buildSelectableSceneCandidates(contextB).map((choice) => choice.label);
    const labelsC = buildSelectableSceneCandidates(contextC).map((choice) => choice.label);
    expect(labelsA).toHaveLength(2);
    expect(labelsB).toHaveLength(2);
    expect(labelsC).toHaveLength(2);
    expect(labelsA).not.toEqual(labelsB);
    expect(labelsA).not.toEqual(labelsC);
    expect(labelsA.join(" ")).not.toContain("顾砚");
    expect(labelsB.join(" ")).not.toContain("顾砚");
  });

  it("后续对话选项优先承接结构化的上一轮回应状态", () => {
    const base = makeContext(makeJob({
      eventKind: "dialogue",
      summary: { kind: "talk", npcId: asNpcId("npc_1") },
      focusNpcId: "npc_1",
    }));
    const continued: SceneGenerationContext = {
      ...base,
      previousDialogue: {
        npcId: asNpcId("npc_1"),
        npcLine: "北巷的车轮印还在泥里，赶车人的左手缠着血布。",
        selectedChoice: { label: "我愿意继续查。", dialogueAct: "support", topic: { kind: "general" } },
      },
    };
    const choices = buildSelectableSceneCandidates(continued);
    expect(choices).toHaveLength(2);
    const labels = choices.map((choice) => choice.label).join(" ");
    expect(labels).not.toContain("赶车人的左手缠着血布");
    expect(labels).toContain("下一步");
    expect(labels).toContain("证物");
    expect(choices.every((choice) => choice.action.type === "talk")).toBe(true);
  });

  it("后续场景用本轮新生成的 NPC 台词重建选项，不沿用上一轮台词锚点", async () => {
    const base = makeContext(makeJob({
      eventKind: "dialogue",
      summary: { kind: "talk", npcId: asNpcId("npc_1") },
      focusNpcId: "npc_1",
    }));
    const previousLine = "告示的这案子，镇上没人敢多嘴。";
    const currentLine = "墙上只留一个血写的‘崖’字。官府说是山匪所为，可江湖上谁信呢？";
    const continued: SceneGenerationContext = {
      ...base,
      previousDialogue: {
        npcId: asNpcId("npc_1"),
        npcLine: previousLine,
        selectedChoice: { dialogueAct: "support", topic: { kind: "general" } },
      },
    };

    const choices = buildSelectableSceneCandidates(continued, currentLine);
    expect(choices).toHaveLength(2);
    const labels = choices.map((choice) => choice.label).join(" ");
    expect(labels).not.toContain(previousLine);
    expect(labels).not.toContain(currentLine);
    expect(labels).not.toContain("江湖上谁信呢");
    expect(labels).toContain("下一步");
    expect(labels).toContain("证物");

    const generated = await source.generateScene(continued);
    if (!generated.ok) throw new Error("expected success");
    expect(generated.proposal.npcLine?.text).toBeTruthy();
    const generatedAnchor = generated.proposal.npcLine?.text
      .replace(/[“”"「」『』。！？!?\s]/gu, "")
      .slice(-14);
    expect(generatedAnchor).toBeTruthy();
    expect(generated.proposal.choices.every((choice) => !choice.label.includes(generatedAnchor ?? ""))).toBe(true);
  });

  it("本轮 NPC 有结构化事实引用时，不再优先复用上一轮 support 模板", () => {
    const base = makeContext(makeJob({
      eventKind: "dialogue",
      summary: { kind: "talk", npcId: asNpcId("npc_1") },
      focusNpcId: "npc_1",
    }), makeFocusContext("neutral"));
    const continued: SceneGenerationContext = {
      ...base,
      previousDialogue: {
        npcId: asNpcId("npc_1"),
        npcLine: "我知道一些风声，但还不能替你下结论。",
        selectedChoice: { dialogueAct: "support", topic: { kind: "general" } },
      },
    };

    const choices = buildSelectableSceneCandidates(continued, {
      text: "这把刀上的旧痕确实与旧案有关，但来历还要当面核对。",
      usedFactIds: ["fact_1"],
    });
    const labels = choices.map((choice) => choice.label).join(" ");
    expect(labels).not.toContain("既然你愿意继续说");
    expect(labels).not.toContain("我可以继续听");
    expect(labels).toContain("线索");
    expect(labels).toContain("证物");
  });

  it("开场选项不再按 NPC 台词关键词分类，而是使用结构化事实池", () => {
    const context = makeContext(makeJob({
      eventKind: "dialogue",
      summary: { kind: "talk", npcId: asNpcId("npc_1") },
      focusNpcId: "npc_1",
    }));
    const currentLine = "客官，代写书信，还是问路？这镇子不大，但消息倒是不少。";
    const labels = buildSelectableSceneCandidates(context, currentLine)
      .map((choice) => choice.label)
      .join(" ");

    expect(labels).not.toContain(currentLine);
    expect(labels).not.toContain("路这镇子不大，但消息倒是不少");
    expect(labels).toContain("线索");
    expect(labels).toContain("证物");
  });

  it("keeps a player utterance addressed to the original NPC during a handoff without quoting it back", async () => {
    const job = makeJob({
      eventKind: "dialogue",
      summary: { kind: "talk", npcId: asNpcId("npc_1") },
      focusNpcId: "npc_1",
      utterance: "你说的旧案是不是和镖队有关？",
    });
    const focus = makeFocusContext("neutral");
    const result = await source.generateScene({
      ...makeContext(job, focus),
      presentNpcs: [
        ...makeContext(job).presentNpcs.filter((npc) => npc.id === asNpcId("npc_1")),
        { ...makeContext(job).presentNpcs[1]!, id: asNpcId("npc_2"), name: "苏绾", role: "失踪镖队幸存者" },
      ],
    });
    if (!result.ok) throw new Error("expected success");
    expect(result.proposal.npcLine?.npcId).toBe("npc_1");
    expect(result.proposal.npcLine?.text).toContain("眼前能确认的范围");
    expect(result.proposal.npcLine?.text).toContain("眼前这条线索");
    expect(result.proposal.npcLine?.text).not.toContain("你说的旧案是不是和镖队有关");
    expect(result.proposal.npcLine?.text).not.toContain("你刚才问的");
  });

  it("offers two explicit and mutually exclusive dialogue decisions when the ending pair is ready", () => {
    const context = makeContext(makeJob({
      eventKind: "dialogue",
      summary: { kind: "talk", npcId: asNpcId("npc_1") },
      focusNpcId: "npc_1",
      transition: {
        before: null,
        completed: [],
        after: null,
        mode: "ready_for_ending",
      },
    }), makeFocusContext("trusted"));

    const choices = buildSelectableSceneCandidates(context);
    expect(choices.map((choice) => choice.action)).toEqual([
      { type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "support", topic: { kind: "general" } },
      { type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "challenge", topic: { kind: "general" } },
    ]);
    expect(choices.map((choice) => choice.label).join(" ")).toMatch(/真相/);
  });

  it("does not keep a side NPC focused while another present NPC is the current talk objective", () => {
    const transition: ObjectiveTransition = {
      before: { questId: asQuestId("quest_1"), objectiveIndex: 0, label: "与客人交谈" },
      completed: [],
      after: { questId: asQuestId("quest_1"), objectiveIndex: 0, label: "与客人交谈" },
      mode: "unchanged",
    };
    const context: SceneGenerationContext = {
      ...makeContext(makeJob({
        eventKind: "dialogue",
        summary: { kind: "talk", npcId: asNpcId("npc_1") },
        focusNpcId: "npc_1",
        transition,
      })),
      legalActionCandidates: [
        { kind: "talk", label: "与客栈老板交谈", targetId: "npc_1" },
        { kind: "talk", label: "与客人交谈", targetId: "npc_2" },
      ],
      objectiveTarget: {
        questId: "quest_1",
        objectiveIndex: 0,
        entityId: "npc_2",
        entityName: "客人",
      },
    };

    expect(buildEventState(context)).toEqual({ kind: "observe", locationId: asLocationId("loc_1") });
    expect(buildSceneChoices(context)[0]?.label).toBe("与客人交谈");
  });

  it("talk job keeps focusNpcId; player_utterance segment summarizes the question and the NPC line answers the beat", async () => {
    const utterance = "请问关于失踪的商队有什么线索吗？";
    const job = makeJob({
      eventKind: "dialogue",
      summary: { kind: "talk", npcId: asNpcId("npc_1") },
      focusNpcId: "npc_1",
      utterance,
      beats: [{ beatId: "player_utterance", kind: "player_utterance", subjectIds: ["npc_1"], instruction: "直接回应" }],
    });
    const result = await source.generateScene(makeContext(job, makeFocusContext("trusted")));
    if (!result.ok) throw new Error("expected success");
    const utteranceSegment = result.proposal.segments.find((s) => s.beatId === "player_utterance");
    expect(utteranceSegment?.text).not.toContain(utterance);
    expect(utteranceSegment?.text).toContain("能核查");
    expect(result.proposal.npcLine?.npcId).toBe("npc_1");
    expect(result.proposal.npcLine?.answeredBeatIds).toContain("player_utterance");
  });

  it("does not rewrite partial_success/failure/blocked: the NPC line keeps the status tone", async () => {
    for (const status of ["partial_success", "failure", "blocked"] as const) {
      const result = await source.generateScene(makeContext(makeJob({ status, eventKind: "dialogue", summary: { kind: "talk", npcId: asNpcId("npc_1") }, focusNpcId: "npc_1" })));
      if (!result.ok) throw new Error("expected success");
      expect(result.proposal.npcLine?.text).toBeTruthy();
      if (status === "partial_success") {
        expect(result.proposal.npcLine?.text).toContain("不方便");
        expect(result.proposal.npcLine?.text).toContain("全说");
      } else {
        expect(result.proposal.npcLine?.text).not.toContain("欢迎光临");
      }
    }
  });

  it("keeps NPC presentation data as proposal fields; ready pages are built only after approval", async () => {
    const result = await source.generateScene(makeContext(makeJob({ eventKind: "dialogue", summary: { kind: "talk", npcId: asNpcId("npc_1") }, focusNpcId: "npc_1" })));
    if (!result.ok) throw new Error("expected success");
    expect(result.proposal.npcLine?.npcId).toBe("npc_1");
    expect("npcDialogues" in result).toBe(false);
  });

  it("objectiveLink follows objectiveTransition.after; null when no after", async () => {
    const transition: ObjectiveTransition = {
      before: { questId: asQuestId("quest_0"), objectiveIndex: 0, label: "与客栈老板交谈" },
      completed: [],
      after: { questId: asQuestId("quest_0"), objectiveIndex: 1, label: "获取盟誓印谱" },
      mode: "progressed",
    };
    const withAfter = await source.generateScene(makeContext(makeJob({ transition })));
    if (!withAfter.ok) throw new Error("expected success");
    expect(withAfter.proposal.objectiveLink).toEqual({ questId: "quest_0", objectiveIndex: 1, mode: "progress" });
    const withoutAfter = await source.generateScene(makeContext(makeJob()));
    if (!withoutAfter.ok) throw new Error("expected success");
    expect(withoutAfter.proposal.objectiveLink).toBeNull();
  });

  it("segments cover every mandatory beat with its beatId, in order, plus optional atmosphere last", async () => {
    const job = makeJob({
      beats: [
        { beatId: "item_0", kind: "item_obtained", subjectIds: ["item_1"], instruction: "获得物品「盟誓印谱」" },
        { beatId: "atmosphere", kind: "atmosphere", subjectIds: [], instruction: "氛围" },
      ],
    });
    const result = await source.generateScene(makeContext(job));
    if (!result.ok) throw new Error("expected success");
    expect(result.proposal.segments.map((s) => s.beatId)).toEqual(["item_0", "atmosphere"]);
    expect(result.proposal.segments[0]?.text).toContain("盟誓印谱");
    expect(result.proposal.segments[0]?.text).toContain("收好");
  });

  it("turns concise combat beat labels into readable scene sentences", async () => {
    const job = makeJob({
      beats: [{ beatId: "battle_0", kind: "battle_resolved", subjectIds: ["enemy_1"], instruction: "与灰狼的战斗以胜利告终" }],
    });
    const result = await source.generateScene(makeContext(job));
    if (!result.ok) throw new Error("expected success");
    expect(result.proposal.segments[0]?.text).toContain("与灰狼的战斗以胜利告终。");
    expect(result.proposal.segments[0]?.text).toContain("重新确认眼前留下的线索");
  });

  it("investigate fallback: fact segment appends the next-target movement handoff derived from objectiveTarget", async () => {
    const job = makeJob({
      eventKind: "investigate",
      summary: { kind: "investigate", factId: asFactId("fact_1") },
      beats: [{
        beatId: "fact_discovered_0",
        kind: "fact_discovered",
        subjectIds: ["fact_1"],
        instruction: "发现了线索：泥地里的车轮印向北延伸",
      }],
    });
    const context: SceneGenerationContext = {
      ...makeContext(job),
      objectiveTarget: { questId: "quest_0", objectiveIndex: 2, entityId: "loc_2", entityName: "北巷旧道" },
      story: {
        ...makeContext(job).story,
        activeQuest: {
          questId: "quest_0",
          name: "追查车轮印",
          description: "查明车轮印的去向。",
          objectiveIndex: 2,
          objectiveLabel: "前往北巷旧道",
          objectiveKind: "visit_location",
        },
      },
    };
    const proposal = await source.generateScene(context);
    if (!proposal.ok) throw new Error("expected success");
    const segment = proposal.proposal.segments.find((s) => s.beatId === "fact_discovered_0");
    expect(segment?.text).toContain("泥地里的车轮印向北延伸");
    expect(segment?.text).toContain("接下来去北巷旧道核对现场");
    const approved = approveScenePerformance({ context, proposal: proposal.proposal, basedOnRevision: 1, existingCandidateEventPool: [] });
    expect(approved.ok).toBe(true);
  });

  // ── Task 4：已结算调查结果的确定性旁白 ──────────────────────────────────

  it("buildInvestigationOutcomeNarrative 组合 采取方式 → 发现事实 → 证据质量/动静代价 → 下一目标", () => {
    const narrative = buildInvestigationOutcomeNarrative({
      approachLabel: "翻查附近杂物",
      evidenceQuality: "noisy",
      factText: "泥地里的车轮印向北延伸",
      nextObjectiveLabel: "北巷旧道",
    });
    expect(narrative).toContain("翻查附近杂物");
    expect(narrative).toContain("泥地里的车轮印向北延伸");
    expect(narrative).toMatch(/动静|惊动/);
    expect(narrative).toContain("北巷旧道");
  });

  it("buildInvestigationOutcomeNarrative：clean 与 noisy 的动静代价表达不同", () => {
    const clean = buildInvestigationOutcomeNarrative({ approachLabel: "沿痕迹追查", evidenceQuality: "clean", factText: "密函露出边角" });
    const noisy = buildInvestigationOutcomeNarrative({ approachLabel: "翻查附近杂物", evidenceQuality: "noisy", factText: "密函露出边角" });
    expect(clean).not.toBe(noisy);
    expect(clean).toMatch(/干净|没有惊动/);
    expect(noisy).toMatch(/动静|惊动/);
  });

  it("buildInvestigationOutcomeNarrative：baseNarrative 优先作为已结算叙事，approach/evidence/下一目标随后", () => {
    const narrative = buildInvestigationOutcomeNarrative({
      approachLabel: "沿痕迹追查",
      evidenceQuality: "clean",
      factText: "泥地里的车轮印向北延伸",
      baseNarrative: "你蹲下身，把泥土里的车辙与门口的方向核对了一遍。",
      nextObjectiveLabel: "北巷旧道",
    });
    expect(narrative.startsWith("你蹲下身，把泥土里的车辙与门口的方向核对了一遍。")).toBe(true);
    expect(narrative).toContain("北巷旧道");
  });

  it("fact_discovered segment 使用已结算的 approach/evidence 组合确定性旁白", async () => {
    const job = makeJob({
      eventKind: "investigate",
      summary: { kind: "investigate", factId: asFactId("fact_1") },
      beats: [{
        beatId: "fact_discovered_0",
        kind: "fact_discovered",
        subjectIds: ["fact_1"],
        instruction: "发现了线索：泥地里的车轮印向北延伸",
      }],
    });
    const context: SceneGenerationContext = {
      ...makeContext(job),
      objectiveTarget: { questId: "quest_0", objectiveIndex: 2, entityId: "loc_2", entityName: "北巷旧道" },
      resolvedInvestigation: {
        factId: asFactId("fact_1"),
        approachId: "search",
        approachLabel: "翻查附近杂物",
        evidenceQuality: "noisy",
        tensionDelta: 12,
      },
    };
    const proposal = await source.generateScene(context);
    if (!proposal.ok) throw new Error("expected success");
    const segment = proposal.proposal.segments.find((s) => s.beatId === "fact_discovered_0");
    expect(segment?.text).toContain("翻查附近杂物");
    expect(segment?.text).toContain("泥地里的车轮印向北延伸");
    expect(segment?.text).toMatch(/动静|惊动/);
    expect(segment?.text).toContain("北巷旧道");
    const approved = approveScenePerformance({ context, proposal: proposal.proposal, basedOnRevision: 1, existingCandidateEventPool: [] });
    expect(approved.ok).toBe(true);
  });

  it("幕边界 fallback：quest_advanced segment 以权威 objectiveTarget 点名，可通过审批", async () => {
    const job = makeJob({
      beats: [{
        beatId: "qa",
        kind: "quest_advanced",
        subjectIds: [],
        instruction: "主线推进到第2幕。已完成：先前的目标；当前目标：新的线索",
      }],
      transition: {
        before: { questId: asQuestId("quest_0"), objectiveIndex: 0, label: "与客栈老板交谈" },
        completed: [],
        after: null,
        mode: "advanced_act",
      },
    });
    const context: SceneGenerationContext = {
      ...makeContext(job),
      objectiveTransition: {
        ...job.objectiveTransition,
        after: { questId: asQuestId("quest_0"), objectiveIndex: 1, label: "与信使交谈" },
      },
      objectiveTarget: { questId: asQuestId("quest_0"), objectiveIndex: 1, entityId: "npc_dyn_1", entityName: "信使" },
    };
    const proposal = await source.generateScene(context);
    if (!proposal.ok) throw new Error("expected success");
    const segment = proposal.proposal.segments.find((s) => s.beatId === "qa");
    expect(segment?.text).toContain("信使");
    const approved = approveScenePerformance({ context, proposal: proposal.proposal, basedOnRevision: 1, existingCandidateEventPool: [] });
    expect(approved.ok).toBe(true);
  });

  it("choices include a move action toward a reachable location", async () => {
    const context = makeContext(makeJob());
    const result = await source.generateScene(context);
    if (!result.ok) throw new Error("expected success");
    const selectable = buildSelectableSceneCandidates(context);
    const actions = result.proposal.choices.map((choice) => selectable.find((c) => c.candidateId === choice.candidateId)?.action);
    expect(actions.some((a) => a?.type === "move" && String(a.locationId) === "loc_2")).toBe(true);
  });

  it("arrival at the objective NPC keeps both selectable choices in dialogue", () => {
    const context = {
      ...makeContext(
        makeJob({
          eventKind: "travel",
          summary: { kind: "move", locationId: loc2.id },
          transition: {
            before: null,
            completed: [],
            after: {
              questId: asQuestId("quest_0"),
              objectiveIndex: 0,
              label: "与客栈老板交谈",
            },
            mode: "unchanged",
          },
        }),
        makeFocusContext("neutral"),
      ),
      legalActionCandidates: [
        { kind: "talk", label: "与客栈老板交谈", targetId: npc1.id },
        { kind: "move", label: "前往街道", targetId: loc2.id },
      ] as const,
      objectiveTarget: {
        questId: asQuestId("quest_0"),
        objectiveIndex: 0,
        entityId: npc1.id,
        entityName: "客栈老板",
      },
    };

    const candidates = buildSelectableSceneCandidates(context);

    expect(candidates).toHaveLength(2);
    expect(candidates.every((candidate) => candidate.action.type === "talk")).toBe(true);
    expect(
      candidates.every(
        (candidate) => candidate.action.type === "talk" && candidate.action.npcId === npc1.id,
      ),
    ).toBe(true);
  });

  it("玩家对白不带角色前缀，攻击动作使用括号且仍绑定真实 attack action", () => {
    const talkLabel = formatSceneChoiceLabel(
      { type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "support" },
      "回应孙瘸子：“请把这件事的来龙去脉说清楚。”",
    );
    expect(talkLabel).toBe("请把这件事的来龙去脉说清楚。");

    const context = makeContext(makeJob({ eventKind: "travel" }));
    const choices = buildSelectableSceneCandidates({
      ...context,
      legalActionCandidates: [
        { kind: "attack", label: "挑战黑衣人", targetId: "enemy_1" },
        { kind: "move", label: "前往街道", targetId: "loc_2" },
      ],
    });
    expect(choices[0]).toMatchObject({
      label: "（拔出兵器，向黑衣人发起攻击）",
      action: { type: "attack", enemyId: "enemy_1" },
    });
  });

  it("active battle fallback proposes two distinct executable battle actions", async () => {
    const context: SceneGenerationContext = {
      ...makeContext(makeJob({ eventKind: "battle" })),
      legalActionCandidates: [
        { kind: "battle_action", label: "攻击", targetId: "attack" },
        { kind: "battle_action", label: "防守", targetId: "guard" },
        { kind: "battle_action", label: "撤退", targetId: "flee" },
      ],
    };
    const result = await source.generateScene(context);
    if (!result.ok) throw new Error("expected success");
    const selectable = buildSelectableSceneCandidates(context);
    const actions = result.proposal.choices.map((choice) => selectable.find((c) => c.candidateId === choice.candidateId)?.action);
    expect(actions).toEqual([
      { type: "battle_action", action: "attack" },
      { type: "battle_action", action: "guard" },
    ]);
  });

  it("prefers an objective-progress-capable choice when after exists", async () => {
    const transition: ObjectiveTransition = {
      before: null,
      completed: [],
      after: { questId: asQuestId("quest_0"), objectiveIndex: 0, label: "前往街道" },
      mode: "unchanged",
    };
    const context: SceneGenerationContext = {
      ...makeContext(makeJob({ transition })),
      legalActionCandidates: [
        { kind: "explore", label: "查看四周" },
        { kind: "move", label: "前往街道", targetId: "loc_2" },
      ],
      objectiveTarget: { questId: "quest_0", objectiveIndex: 0, entityId: "loc_2", entityName: "街道" },
    };
    const result = await source.generateScene(context);
    if (!result.ok) throw new Error("expected success");
    const selectable = buildSelectableSceneCandidates(context);
    const chosenLabels = result.proposal.choices.map((choice) => selectable.find((c) => c.candidateId === choice.candidateId)?.label);
    expect(chosenLabels).toContain("（前往街道）");
  });

  // ── Task 5 Step 1 + 4：档位感知台词 + 玩家原话应答 ──────────────────────

  it("hostile 与 trusted 对同一 talk action 产出肉眼可辨的不同台词", async () => {
    const hostile = await source.generateScene(makeUtteranceContext("hostile"));
    if (!hostile.ok) throw new Error("expected success");
    const trusted = await source.generateScene(makeUtteranceContext("trusted"));
    if (!trusted.ok) throw new Error("expected success");
    expect(hostile.proposal.npcLine?.text).not.toBe(trusted.proposal.npcLine?.text);
    expect(hostile.proposal.npcLine?.text).toBeTruthy();
    expect(trusted.proposal.npcLine?.text).toBeTruthy();
  });

  it("hostile 档位 NPC 的台词为冷淡拒绝式", async () => {
    const result = await source.generateScene(makeUtteranceContext("hostile"));
    if (!result.ok) throw new Error("expected success");
    expect(result.proposal.npcLine?.text).toMatch(/不关你的事|不想回答/);
    expect(result.proposal.npcLine?.text).not.toMatch(/答道|说道|看了你一眼/);
    expect(result.proposal.npcLine?.emotion).toBe("angry");
  });

  it("trusted 档位 NPC 的台词为坦诚主动式", async () => {
    const result = await source.generateScene(makeUtteranceContext("trusted"));
    if (!result.ok) throw new Error("expected success");
    expect(result.proposal.npcLine?.text).toMatch(/来龙去脉|想和你谈/);
    expect(result.proposal.npcLine?.text).not.toMatch(/坦诚地说|说道|答道/);
    expect(result.proposal.npcLine?.emotion).toBe("warm");
  });

  it("neutral fallback gives a structured handoff instead of inventing role-specific evidence", async () => {
    const job = makeJob({
      eventKind: "dialogue",
      summary: { kind: "talk", npcId: asNpcId("npc_1") },
      focusNpcId: "npc_1",
      utterance: "商队失踪的事你知道吗？",
      beats: [{ beatId: "player_utterance", kind: "player_utterance", subjectIds: ["npc_1"], instruction: "直接回应" }],
    });
    const result = await source.generateScene(makeContext(job, makeFocusContext("neutral")));
    if (!result.ok) throw new Error("expected success");
    expect(result.proposal.npcLine?.text).toContain("眼前这条线索");
    expect(result.proposal.npcLine?.text).not.toMatch(/门闩|松脂|车辙|半枚官印|腰牌背纹/u);
    expect(result.proposal.npcLine?.text).not.toBe("我知道了。");
    expect(result.proposal.npcLine?.text).not.toContain("你刚才问的");
    expect(result.proposal.npcLine?.text).not.toMatch(/如实答道|说道|答道/);
  });

  it("uses the current fixed dialogue stance to hand off the structured objective", async () => {
    const job = makeJob({
      actionId: "act_support",
      eventKind: "dialogue",
      summary: { kind: "talk", npcId: asNpcId("npc_1") },
      focusNpcId: "npc_1",
    });
    const focus = {
      ...makeFocusContext("friendly"),
      role: "旧案卷宗保管人",
      recentInteractions: [{
        actionId: "act_support",
        dialogueAct: "support" as const,
        topicSummary: "旧案",
        outcome: "positive" as const,
        summary: "愿意继续查案",
      }],
    };
    const base = makeContext(job, focus);
    const result = await source.generateScene({
      ...base,
      story: {
        ...base.story,
        activeQuest: {
          questId: "quest_1",
          name: "循迹",
          description: "核对下一处现场",
          objectiveIndex: 0,
          objectiveLabel: "前往北巷",
          objectiveKind: "visit_location",
        },
      },
      objectiveTarget: {
        questId: "quest_1",
        objectiveIndex: 0,
        entityId: "loc_north_lane",
        entityName: "北巷",
      },
      previousDialogue: {
        npcId: asNpcId("npc_1"),
        npcLine: "刚才那桩旧案还有一处需要核对。",
        selectedChoice: { dialogueAct: "support", topic: { kind: "general" } },
      },
    });
    if (!result.ok) throw new Error("expected success");
    expect(result.proposal.npcLine?.text).toContain("接下来去北巷核对现场");
    expect(result.proposal.npcLine?.text).not.toMatch(/半枚官印|腰牌背纹|门闩|松脂|车辙/u);
    expect(result.proposal.npcLine?.text).not.toContain("你来得正好");
  });

  it("有 player_utterance 节拍时 npcLine 的 answeredBeatIds 包含该节拍 ID", async () => {
    const result = await source.generateScene(makeUtteranceContext("trusted"));
    if (!result.ok) throw new Error("expected success");
    expect(result.proposal.npcLine?.answeredBeatIds).toEqual(["player_utterance"]);
  });

  it("无 player_utterance 节拍时 answeredBeatIds 为空数组", async () => {
    const context = makeContext(makeJob({
      eventKind: "travel",
      summary: { kind: "move", locationId: asLocationId("loc_2") },
    }));
    const result = await source.generateScene(context);
    if (!result.ok) throw new Error("expected success");
    expect(result.proposal.npcLine?.answeredBeatIds).toEqual([]);
  });

  it("buildSceneChoices returns exactly two distinct candidate IDs from the legal set", () => {
    const context = makeContext(makeJob({ eventKind: "travel" }));
    const choices = buildSceneChoices(context);
    expect(choices).toHaveLength(2);
    expect(choices[0].candidateId).not.toBe(choices[1].candidateId);
  });

  // ── Task 8：呈现政策影响的确定性变体 ──────────────────────────────────────

  it("dark intensity 的氛围 segment 与 normal 不同（暗色意象 vs 含蓄）", async () => {
    const normal = await source.generateScene(makeContext(makeJob()));
    if (!normal.ok) throw new Error("expected success");
    const darkCtx: SceneGenerationContext = {
      ...makeContext(makeJob()),
      story: { ...makeContext(makeJob()).story, stylePolicy: buildStylePolicy({ contentIntensity: "dark" }) },
    };
    const dark = await source.generateScene(darkCtx);
    if (!dark.ok) throw new Error("expected success");
    const normalAtmos = normal.proposal.segments.find((s) => s.beatId === "atmosphere")?.text ?? "";
    const darkAtmos = dark.proposal.segments.find((s) => s.beatId === "atmosphere")?.text ?? "";
    expect(normalAtmos).not.toBe(darkAtmos);
    expect(darkAtmos).toContain("阴影");
  });

  it("呈现政策不改变规则部分：不同政策下 choices/objectiveLink 相同，仅叙述文本不同", async () => {
    const baseCtx = makeContext(makeJob());
    const darkCtx: SceneGenerationContext = {
      ...baseCtx,
      story: { ...baseCtx.story, stylePolicy: buildStylePolicy({ personalityTags: ["多疑"], contentIntensity: "dark" }) },
    };
    const a = await source.generateScene(baseCtx);
    if (!a.ok) throw new Error("expected success");
    const b = await source.generateScene(darkCtx);
    if (!b.ok) throw new Error("expected success");
    expect(a.proposal.choices).toEqual(b.proposal.choices);
    expect(a.proposal.objectiveLink).toEqual(b.proposal.objectiveLink);
    expect(a.proposal.npcLine).toEqual(b.proposal.npcLine);
    expect(a.proposal.segments.map((s) => s.text)).not.toEqual(b.proposal.segments.map((s) => s.text));
  });

  it("冲动标签的玩家追问 segment 保留冲动特征前缀，但不回显原话", async () => {
    const utterance = "商队失踪的事你知道吗？";
    const impJob = makeJob({
      eventKind: "dialogue", summary: { kind: "talk", npcId: asNpcId("npc_1") }, focusNpcId: "npc_1",
      utterance,
      beats: [{ beatId: "player_utterance", kind: "player_utterance", subjectIds: ["npc_1"], instruction: "直接回应" }],
    });
    const impCtx: SceneGenerationContext = {
      ...makeContext(makeJob({ eventKind: "dialogue", summary: { kind: "talk", npcId: asNpcId("npc_1") }, focusNpcId: "npc_1", utterance, beats: [{ beatId: "player_utterance", kind: "player_utterance", subjectIds: ["npc_1"], instruction: "直接回应" }] })),
      story: { ...makeContext(makeJob()).story, stylePolicy: buildStylePolicy({ personalityTags: ["冲动"] }) },
      job: impJob,
    };
    const result = await source.generateScene(impCtx);
    if (!result.ok) throw new Error("expected success");
    const utteranceSegment = result.proposal.segments.find((s) => s.beatId === "player_utterance");
    expect(utteranceSegment?.text).toContain("没多想");
    expect(utteranceSegment?.text).not.toContain(utterance);
  });
});
