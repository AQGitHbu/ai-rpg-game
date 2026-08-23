import { describe, expect, it } from "vitest";
import { asFactId, asLocationId, asNpcId, asQuestId } from "@/game/domain/worldEntity";
import { asNarrativeJobId, asTurnId } from "@/game/domain/events";
import { createPendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import type { SceneGenerationContext } from "@/game/application/sceneGenerationContext";
import { buildSelectableSceneCandidates } from "@/game/application/deterministicSceneSource";
import { buildStylePolicy } from "@/game/application/stylePolicy";
import { compileSceneNarrativeContext } from "./sceneNarrativeContext";

function makeSceneContext(): SceneGenerationContext {
  const pending = createPendingNarrativeJob({
    jobId: asNarrativeJobId("job_scene_1"),
    turnId: asTurnId("turn_scene_1"),
    actionId: "action_scene_1",
    expectedRevision: 7,
    turnNumber: 12,
    actionSummary: { kind: "talk", npcId: asNpcId("npc_focus") },
    utterance: "你刚才提到的镖局内应，到底是谁在接应？",
    resolvedEvent: {
      actionId: "action_scene_1",
      status: "success",
      eventKind: "dialogue",
      facts: [],
      stateChanges: [],
      costs: [],
      rewards: [],
      triggeredEvents: [],
      rejectedEffects: [],
    },
    domainEventRange: { fromLedgerIndex: 18, toLedgerIndexExclusive: 19 },
    focusNpcId: asNpcId("npc_focus"),
    requestedAt: "2026-08-23T08:00:00.000Z",
    objectiveTransition: {
      before: { questId: asQuestId("quest_main"), objectiveIndex: 0, label: "询问韩镖头" },
      completed: [{ questId: asQuestId("quest_main"), objectiveIndex: 0, label: "询问韩镖头" }],
      after: { questId: asQuestId("quest_main"), objectiveIndex: 1, label: "前往北巷旧道" },
      mode: "advanced_act",
    },
    mandatoryBeats: [
      {
        beatId: "player_utterance_1",
        kind: "player_utterance",
        subjectIds: ["npc_focus"],
        instruction: "先直接回应玩家对内应的追问",
      },
      {
        beatId: "quest_advanced_1",
        kind: "quest_advanced",
        subjectIds: ["quest_main", "loc_north_lane"],
        instruction: "把下一步明确交接到北巷旧道",
      },
    ],
    generationKind: "npc_free_text",
    sceneRequestKind: "npc_handoff",
  });
  if (!pending.ok) throw new Error("fixture job failed");

  return {
    gameType: "wuxia",
    generationSeed: "scene-seed-should-not-leak",
    worldPremise: "风雨将至的江南武林，各门派围绕失踪镖银暗中角力。",
    storyOpening: "镖银失踪牵出门派内应，主角在客栈与旧日镖头正面对质。",
    job: pending.job,
    player: {
      name: "沈墨",
      identity: "落魄镖师",
      knownFactCards: [
        { factId: asFactId("fact_player_1"), text: "你曾亲手押送过失踪前最后一趟镖银。" },
      ],
    },
    currentLocation: {
      id: asLocationId("loc_inn"),
      name: "临江客栈",
      description: "临水而建的旧客栈，梁柱间还留着旧镖局的刻痕。",
      kind: "main",
    },
    publicWorldFacts: [
      { factId: asFactId("fact_public_1"), text: "镖车最后一次露面是在北巷旧道附近。" },
      { factId: asFactId("fact_shared"), text: "公开旧线索：后门锁孔残留松脂。" },
    ],
    sceneVisibleFacts: [
      { factId: asFactId("fact_shared"), text: "当前场景可见线索：后门锁孔残留松脂。" },
      { factId: asFactId("fact_visible_2"), text: "窗边的湿泥脚印一路延向北巷。" },
    ],
    presentNpcs: [
      {
        id: asNpcId("npc_focus"),
        name: "韩镖头",
        role: "旧镖局镖头",
        publicProfile: "受伤后隐居客栈的前任镖头",
        knownFactCards: [
          { factId: asFactId("fact_focus_1"), text: "韩镖头认得失踪当夜留下的镖旗断口。" },
        ],
        hiddenFactCards: [
          { factId: asFactId("fact_focus_secret"), text: "只给焦点 NPC 自己的秘密，不给别人。" },
        ],
        sceneVisibleFactIds: [asFactId("fact_shared"), asFactId("fact_visible_2")],
        recentInteractionSummaries: [
          "support/先确认北巷脚印",
          "challenge/逼问镖旗断口",
          "ask/追问内应身份",
          "support/核对松脂来源",
          "challenge/质疑押镖名单",
        ],
        recentInteractionActionIds: [
          "interaction_1",
          "interaction_2",
          "interaction_3",
          "interaction_4",
          "interaction_5",
        ],
        relationship: { affinity: 18 },
        emotion: "guarded",
        goals: ["查出吞镖内应", "保住旧镖局幸存者"],
        forbiddenKnowledgeIds: [asFactId("fact_focus_secret")],
      },
      {
        id: asNpcId("npc_other"),
        name: "赵四",
        role: "码头脚夫",
        publicProfile: "经常替人跑腿的码头脚夫",
        knownFactCards: [],
        hiddenFactCards: [
          { factId: asFactId("fact_other_secret"), text: "DO_NOT_LEAK_OTHER_NPC_SECRET" },
        ],
        sceneVisibleFactIds: [],
        recentInteractionSummaries: [],
        recentInteractionActionIds: [],
        relationship: { affinity: -7 },
        emotion: "neutral",
        goals: ["保住自己在码头的活路"],
        forbiddenKnowledgeIds: [asFactId("fact_other_secret")],
      },
    ],
    story: {
      currentAct: 2,
      targetActs: 5,
      tension: 55,
      nextPacingNeed: "complicate",
      contract: {
        centralConflict: "镖银失踪牵出门派内应",
        endingDirections: [
          { key: "trust", theme: "与旧同袍联手揭出真凶" },
          { key: "doubt", theme: "独自追查并逼出真正内应" },
        ],
      },
      remainingBudget: {
        remainingLocations: 2,
        remainingNpcs: 1,
        remainingEvents: 3,
      },
      activeQuest: {
        questId: "quest_main",
        name: "失踪镖银",
        description: "追查失踪镖银与门派内应之间的牵连。",
        objectiveIndex: 1,
        objectiveLabel: "前往北巷旧道",
        objectiveKind: "visit_location",
      },
      unresolvedThreadSummaries: [
        "失踪镖银究竟落入谁手",
        "北巷旧道为何会出现旧镖局车辙",
      ],
      stylePolicy: buildStylePolicy({
        personalityTags: ["冷静", "克制"],
        narrativeStyle: "concise",
        contentIntensity: "normal",
      }),
    },
    recentBeats: [
      { turn: 11, kind: "fact_discovered", summary: "你在后门锁孔上发现了新鲜松脂痕迹。" },
    ],
    legalActionCandidates: [
      { kind: "talk", label: "继续追问韩镖头", targetId: "npc_focus" },
      { kind: "move", label: "前往北巷旧道", targetId: "loc_north_lane" },
    ],
    legalEventTargets: {
      locationIds: [asLocationId("loc_inn"), asLocationId("loc_north_lane")],
      factIds: [
        asFactId("fact_public_1"),
        asFactId("fact_shared"),
        asFactId("fact_visible_2"),
        asFactId("fact_focus_1"),
      ],
      itemIds: [],
      enemyIds: [],
    },
    worldConstraints: [
      "不得引入神魔、祭坛、圣光或跨题材奇幻元素。",
      "所有新线索必须能回扣到江湖镖局与门派内斗。",
    ],
    objectiveTransition: pending.job.objectiveTransition,
    mandatoryBeats: pending.job.mandatoryBeats,
    beatSubjects: [
      { id: "npc_focus", kind: "npc", name: "韩镖头", description: "受伤后隐居客栈的前任镖头" },
      { id: "loc_north_lane", kind: "location", name: "北巷旧道", description: "临江客栈外通向旧镖局的狭长旧道" },
      { id: "fact_shared", kind: "fact", name: "松脂锁孔", description: "后门锁孔残留的新鲜松脂" },
    ],
    narrativeReferenceIds: ["npc_focus", "loc_north_lane", "fact_shared", "fact_visible_2"],
    objectiveTarget: {
      questId: "quest_main",
      objectiveIndex: 1,
      entityId: "loc_north_lane",
      entityName: "北巷旧道",
    },
    focusNpcContext: {
      id: asNpcId("npc_focus"),
      name: "韩镖头",
      role: "旧镖局镖头",
      publicProfile: "受伤后隐居客栈的前任镖头",
      responsePolicy: {
        tier: "friendly",
        toneInstruction: "先接玩家的话，再给可核验线索。",
        initiative: "helpful",
        allowedDisclosureFactIds: [
          asFactId("fact_focus_1"),
          asFactId("fact_shared"),
        ],
        privateKnowledgeIds: [asFactId("fact_focus_secret")],
      },
      speakableFactCards: [
        { factId: asFactId("fact_focus_1"), text: "韩镖头认得失踪当夜留下的镖旗断口。" },
        { factId: asFactId("fact_shared"), text: "当前场景可见线索：后门锁孔残留松脂。" },
      ],
      recentInteractions: [
        {
          actionId: "interaction_1",
          dialogueAct: "support",
          topicSummary: "先确认北巷脚印",
          outcome: "positive",
          summary: "你同意先核对北巷脚印，韩镖头放低了戒心。",
        },
        {
          actionId: "interaction_2",
          dialogueAct: "challenge",
          topicSummary: "逼问镖旗断口",
          outcome: "mixed",
          summary: "你质疑他隐瞒了镖旗断口的来历，气氛骤然绷紧。",
        },
        {
          actionId: "interaction_3",
          dialogueAct: "ask",
          topicSummary: "追问内应身份",
          outcome: "neutral",
          summary: "你多次追问内应身份，但韩镖头只肯透露半句。",
        },
        {
          actionId: "interaction_4",
          dialogueAct: "support",
          topicSummary: "核对松脂来源",
          outcome: "positive",
          summary: "你提议先验松脂来源，双方暂时达成一致。",
        },
        {
          actionId: "interaction_5",
          dialogueAct: "challenge",
          topicSummary: "质疑押镖名单",
          outcome: "negative",
          summary: "你指出押镖名单被动过手脚，韩镖头明显回避。",
        },
      ],
      goals: ["查出吞镖内应", "保住旧镖局幸存者"],
      emotion: "guarded",
      thisTurn: { relationshipDelta: 2, outcome: "positive" },
    },
    currentInvestigationApproaches: [
      {
        approachId: "approach_tracks",
        label: "沿车辙追查",
        hint: "顺着湿泥里的车辙一路往北",
        evidenceQuality: "clean",
        tensionDelta: 2,
      },
    ],
    resolvedInvestigation: {
      factId: asFactId("fact_shared"),
      approachId: "approach_tracks",
      approachLabel: "沿车辙追查",
      evidenceQuality: "clean",
      tensionDelta: 2,
    },
    upcomingLinearObjectives: [
      {
        kind: "discover_fact",
        factId: asFactId("fact_shared"),
        investigationLabel: "沿车辙追查",
        factText: "后门锁孔残留的松脂与北巷旧道上的车辙痕迹彼此印证。",
        nextObjectiveEntityName: "北巷旧道",
      },
      {
        kind: "visit_location",
        locationId: asLocationId("loc_north_lane"),
        locationName: "北巷旧道",
      },
    ],
    previousDialogue: {
      npcId: asNpcId("npc_focus"),
      npcLine: "昨夜我亲眼看见有人把镖车往北巷旧道引去，可我没看清那人的脸。",
      usedFactIds: ["fact_focus_1", "fact_shared"],
      selectedChoice: {
        label: "把你看清的细节都告诉我。",
        dialogueAct: "ask",
        topic: { kind: "general" },
      },
    },
    repairAttempt: {
      attempt: 1,
      reason: "choices_stale_template",
    },
  };
}

describe("sceneNarrativeContext", () => {
  it("projects scene prompt blocks with safe scene-side context only", () => {
    const context = makeSceneContext();
    const selectable = buildSelectableSceneCandidates(context);
    const compilation = compileSceneNarrativeContext(context, selectable);
    const selectedById = new Map(compilation.context.selected.map((block) => [block.id, block]));

    expect(selectedById.get("scene:rules")).toEqual(expect.objectContaining({
      slot: "system_rules", authority: "rule", retention: "mandatory",
    }));
    expect(selectedById.get("scene:recent-events")?.slot).toBe("relevant_events");
    expect(selectedById.get("scene:previous-dialogue")?.slot).toBe("recent_scenes");
    expect(selectedById.get("scene:world-canon")).toBeDefined();
    expect(selectedById.get("scene:world-constraints")).toBeDefined();
    expect(selectedById.get("scene:story-contract")).toBeDefined();
    expect(selectedById.get("scene:current-state")).toBeDefined();
    expect(selectedById.get("scene:player")).toBeDefined();
    expect(selectedById.get("scene:visible-facts")).toBeDefined();
    expect(selectedById.get("scene:resolution")).toBeDefined();
    expect(selectedById.get("scene:location")).toBeDefined();
    expect(selectedById.get("scene:focus-npc")).toBeDefined();
    expect(selectedById.get("scene:non-focus-npcs")).toBeDefined();
    expect(selectedById.get("scene:style-policy")).toBeDefined();
    expect(selectedById.get("scene:linear-prefetch")).toBeDefined();
    expect(selectedById.get("scene:repair")).toBeDefined();
    expect(selectedById.get("scene:player-action")).toBeDefined();
    expect(selectedById.get("scene:legal-actions")).toBeDefined();
    expect(selectedById.get("scene:output-contract")).toBeDefined();
    expect(selectedById.get("scene:world-canon")?.content).toContain("世界背景=");
    expect(selectedById.get("scene:world-constraints")?.content).toContain("不得引入神魔");
    expect(selectedById.get("scene:story-contract")?.content).toContain("中心冲突=镖银失踪牵出门派内应");
    expect(selectedById.get("scene:story-contract")?.content).not.toContain("targetActs=");
    expect(selectedById.get("scene:current-state")?.content).toContain("activeQuest=");
    expect(selectedById.get("scene:resolution")?.content).toContain("先直接回应玩家对内应的追问");
    expect(selectedById.get("scene:focus-npc")?.content).toContain("thisTurn.outcome=positive");
    expect(selectedById.get("scene:output-contract")?.content).toContain("linearActionNarratives");
    expect(selectedById.get("scene:focus-npc")?.content).not.toContain("fact_focus_secret");
    expect(selectedById.get("scene:linear-prefetch")?.source.refs).toEqual(["loc_north_lane"]);
    expect(compilation.prompt).toContain("镖银失踪牵出门派内应");
    expect(compilation.prompt).toContain("currentAct=2");
    expect(compilation.prompt).toContain("tension=55");
    expect(compilation.prompt).toContain("complicate");
    expect(compilation.prompt).toContain("你在后门锁孔上发现了新鲜松脂痕迹。");
    for (const actionId of ["interaction_1", "interaction_2", "interaction_3", "interaction_4", "interaction_5"]) {
      expect(compilation.prompt).toContain(actionId);
    }
    expect(compilation.prompt).not.toContain("fact_focus_secret");
    expect(JSON.stringify(compilation.manifest)).not.toContain("fact_focus_secret");
    expect(compilation.prompt).not.toContain("DO_NOT_LEAK_OTHER_NPC_SECRET");
    expect(compilation.prompt).not.toContain("eventLedger");
    expect(compilation.prompt).not.toContain("affinity=18");
    expect(compilation.prompt).not.toContain(context.generationSeed ?? "seed-not-present");
  });

  it("keeps only safe location and arrival-NPC refs in the linear prefetch manifest", () => {
    const context = makeSceneContext();
    const discoverFact = context.upcomingLinearObjectives?.find((ref) => ref.kind === "discover_fact");
    const arrivalNpc = context.presentNpcs.find((npc) => String(npc.id) === "npc_other");
    if (discoverFact === undefined || arrivalNpc === undefined) throw new Error("fixture is incomplete");

    const compilation = compileSceneNarrativeContext({
      ...context,
      upcomingLinearObjectives: [
        discoverFact,
        {
          kind: "visit_location",
          locationId: asLocationId("loc_arrival"),
          locationName: "南门渡口",
          arrivalNpc,
        },
      ],
    }, []);
    const manifestEntry = compilation.manifest.selected.find((entry) => entry.id === "scene:linear-prefetch");

    expect(manifestEntry?.sourceRefs).toEqual(["loc_arrival", "npc_other"]);
    expect(manifestEntry?.sourceRefs).not.toContain(String(discoverFact.factId));
  });
});
