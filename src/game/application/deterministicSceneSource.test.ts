import { describe, it, expect } from "vitest";
import {
  createDeterministicSceneSource,
  buildEventState,
  buildSelectableSceneCandidates,
  buildSceneChoices,
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
    actionId: "act_test",
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
    const second = await source.generateScene(context);
    expect(first.sceneId).toBe("scene-job_7");
    expect(second.sceneId).toBe("scene-job_7");
  });

  it("is fully deterministic: same context → same proposal package", async () => {
    const context = makeContext(makeJob({ jobId: "job_det" }));
    const first = await source.generateScene(context);
    const second = await source.generateScene(context);
    expect(first).toEqual(second);
    expect(first.choices).toHaveLength(2);
  });

  it("produces a performance proposal with segments, two distinct legal choices and source=fallback", async () => {
    const result = await source.generateScene(makeContext(makeJob({ eventKind: "travel" })));
    expect(result.segments.length).toBeGreaterThan(0);
    expect(result.source).toBe("fallback");
    expect(result.choices).toHaveLength(2);
    expect(result.choices[0].candidateId).not.toBe(result.choices[1].candidateId);
    expect(result.choices.every((choice) => choice.label.length > 0)).toBe(true);
  });

  it("deterministic proposal passes the same approval used for generated scenes", async () => {
    const context = makeContext(makeJob({ eventKind: "travel" }));
    const proposal = await source.generateScene(context);
    const approved = approveScenePerformance({
      context,
      proposal,
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
    expect(result.npcLine?.npcId).toBe("npc_1");
  });

  it("turns an advanced-act talk result into a task handoff instead of reopening the old NPC choices", () => {
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
      focusNpcContext: {
        ...makeFocusContext("neutral"),
        id: asNpcId("npc_2"),
        name: "客人",
      },
    };

    expect(buildEventState(context)).toEqual({ kind: "observe", locationId: asLocationId("loc_1") });
    const candidates = buildSelectableSceneCandidates(context);
    expect(candidates.map((candidate) => candidate.label)).toEqual([
      "回应客人：“我先相信你，但请把知道的说清楚。”",
      "默默不作声，先观察四周",
    ]);
    expect(candidates[0]?.action).toEqual({ type: "talk", npcId: asNpcId("npc_2"), dialogueAct: "support" });
    expect(candidates[1]?.action).toEqual({ type: "explore" });
    expect(buildSceneChoices(context)[0]?.label).toBe("回应客人：“我先相信你，但请把知道的说清楚。”");
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

  it("talk job keeps focusNpcId; player_utterance segment echoes the utterance and the NPC line answers the beat", async () => {
    const utterance = "请问关于失踪的商队有什么线索吗？";
    const job = makeJob({
      eventKind: "dialogue",
      summary: { kind: "talk", npcId: asNpcId("npc_1") },
      focusNpcId: "npc_1",
      utterance,
      beats: [{ beatId: "player_utterance", kind: "player_utterance", subjectIds: ["npc_1"], instruction: "直接回应" }],
    });
    const result = await source.generateScene(makeContext(job, makeFocusContext("trusted")));
    const utteranceSegment = result.segments.find((s) => s.beatId === "player_utterance");
    expect(utteranceSegment?.text).toContain(utterance);
    expect(result.npcLine?.npcId).toBe("npc_1");
    expect(result.npcLine?.answeredBeatIds).toContain("player_utterance");
  });

  it("does not rewrite partial_success/failure/blocked: the NPC line keeps the status tone", async () => {
    for (const status of ["partial_success", "failure", "blocked"] as const) {
      const result = await source.generateScene(makeContext(makeJob({ status, eventKind: "dialogue", summary: { kind: "talk", npcId: asNpcId("npc_1") }, focusNpcId: "npc_1" })));
      expect(result.npcLine?.text).toBeTruthy();
      if (status === "partial_success") {
        expect(result.npcLine?.text).toContain("不方便");
        expect(result.npcLine?.text).toContain("全说");
      } else {
        expect(result.npcLine?.text).not.toContain("欢迎光临");
      }
    }
  });

  it("keeps NPC presentation data as proposal fields; ready pages are built only after approval", async () => {
    const result = await source.generateScene(makeContext(makeJob({ eventKind: "dialogue", summary: { kind: "talk", npcId: asNpcId("npc_1") }, focusNpcId: "npc_1" })));
    expect(result.npcLine?.npcId).toBe("npc_1");
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
    expect(withAfter.objectiveLink).toEqual({ questId: "quest_0", objectiveIndex: 1, mode: "progress" });
    const withoutAfter = await source.generateScene(makeContext(makeJob()));
    expect(withoutAfter.objectiveLink).toBeNull();
  });

  it("segments cover every mandatory beat with its beatId, in order, plus optional atmosphere last", async () => {
    const job = makeJob({
      beats: [
        { beatId: "item_0", kind: "item_obtained", subjectIds: ["item_1"], instruction: "获得物品「盟誓印谱」" },
        { beatId: "atmosphere", kind: "atmosphere", subjectIds: [], instruction: "氛围" },
      ],
    });
    const result = await source.generateScene(makeContext(job));
    expect(result.segments.map((s) => s.beatId)).toEqual(["item_0", "atmosphere"]);
    expect(result.segments[0]?.text).toContain("盟誓印谱");
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
    const segment = proposal.segments.find((s) => s.beatId === "qa");
    expect(segment?.text).toContain("信使");
    const approved = approveScenePerformance({ context, proposal, basedOnRevision: 1, existingCandidateEventPool: [] });
    expect(approved.ok).toBe(true);
  });

  it("choices include a move action toward a reachable location", async () => {
    const context = makeContext(makeJob());
    const result = await source.generateScene(context);
    const selectable = buildSelectableSceneCandidates(context);
    const actions = result.choices.map((choice) => selectable.find((c) => c.candidateId === choice.candidateId)?.action);
    expect(actions.some((a) => a?.type === "move" && String(a.locationId) === "loc_2")).toBe(true);
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
    const selectable = buildSelectableSceneCandidates(context);
    const actions = result.choices.map((choice) => selectable.find((c) => c.candidateId === choice.candidateId)?.action);
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
    const selectable = buildSelectableSceneCandidates(context);
    const chosenLabels = result.choices.map((choice) => selectable.find((c) => c.candidateId === choice.candidateId)?.label);
    expect(chosenLabels).toContain("前往街道");
  });

  // ── Task 5 Step 1 + 4：档位感知台词 + 玩家原话应答 ──────────────────────

  it("hostile 与 trusted 对同一 talk action 产出肉眼可辨的不同台词", async () => {
    const hostile = await source.generateScene(makeUtteranceContext("hostile"));
    const trusted = await source.generateScene(makeUtteranceContext("trusted"));
    expect(hostile.npcLine?.text).not.toBe(trusted.npcLine?.text);
    expect(hostile.npcLine?.text).toBeTruthy();
    expect(trusted.npcLine?.text).toBeTruthy();
  });

  it("hostile 档位 NPC 的台词为冷淡拒绝式", async () => {
    const result = await source.generateScene(makeUtteranceContext("hostile"));
    expect(result.npcLine?.text).toMatch(/不关你的事|不想回答/);
    expect(result.npcLine?.text).not.toMatch(/答道|说道|看了你一眼/);
    expect(result.npcLine?.emotion).toBe("angry");
  });

  it("trusted 档位 NPC 的台词为坦诚主动式", async () => {
    const result = await source.generateScene(makeUtteranceContext("trusted"));
    expect(result.npcLine?.text).toMatch(/来龙去脉|想和你谈/);
    expect(result.npcLine?.text).not.toMatch(/坦诚地说|说道|答道/);
    expect(result.npcLine?.emotion).toBe("warm");
  });

  it("neutral fallback explicitly refers to the current player question instead of saying only 我知道了", async () => {
    const job = makeJob({
      eventKind: "dialogue",
      summary: { kind: "talk", npcId: asNpcId("npc_1") },
      focusNpcId: "npc_1",
      utterance: "商队失踪的事你知道吗？",
      beats: [{ beatId: "player_utterance", kind: "player_utterance", subjectIds: ["npc_1"], instruction: "直接回应" }],
    });
    const result = await source.generateScene(makeContext(job, makeFocusContext("neutral")));
    expect(result.npcLine?.text).toContain("商队失踪的事你知道吗");
    expect(result.npcLine?.text).not.toBe("我知道了。");
    expect(result.npcLine?.text).not.toMatch(/如实答道|说道|答道/);
  });

  it("有 player_utterance 节拍时 npcLine 的 answeredBeatIds 包含该节拍 ID", async () => {
    const result = await source.generateScene(makeUtteranceContext("trusted"));
    expect(result.npcLine?.answeredBeatIds).toEqual(["player_utterance"]);
  });

  it("无 player_utterance 节拍时 answeredBeatIds 为空数组", async () => {
    const context = makeContext(makeJob({
      eventKind: "travel",
      summary: { kind: "move", locationId: asLocationId("loc_2") },
    }));
    const result = await source.generateScene(context);
    expect(result.npcLine?.answeredBeatIds).toEqual([]);
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
    const darkCtx: SceneGenerationContext = {
      ...makeContext(makeJob()),
      story: { ...makeContext(makeJob()).story, stylePolicy: buildStylePolicy({ contentIntensity: "dark" }) },
    };
    const dark = await source.generateScene(darkCtx);
    const normalAtmos = normal.segments.find((s) => s.beatId === "atmosphere")?.text ?? "";
    const darkAtmos = dark.segments.find((s) => s.beatId === "atmosphere")?.text ?? "";
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
    const b = await source.generateScene(darkCtx);
    expect(a.choices).toEqual(b.choices);
    expect(a.objectiveLink).toEqual(b.objectiveLink);
    expect(a.npcLine).toEqual(b.npcLine);
    expect(a.segments.map((s) => s.text)).not.toEqual(b.segments.map((s) => s.text));
  });

  it("冲动标签的玩家原话 segment 措辞含冲动特征前缀", async () => {
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
    const utteranceSegment = result.segments.find((s) => s.beatId === "player_utterance");
    expect(utteranceSegment?.text).toContain("没多想");
    expect(utteranceSegment?.text).toContain(utterance);
  });
});
