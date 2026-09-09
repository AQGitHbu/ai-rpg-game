import { describe, expect, it } from "vitest";
import { approveNarrativeBundle } from "./approveNarrativeBundle";
import type { ApproveNarrativeBundleInput } from "./approveNarrativeBundle";
import type { NarrativeBundleProposal } from "@/game/domain/narrativeBundle";
import type { ObjectiveTransition } from "@/game/domain/narrativeBeat";
import type {
  LocationEntry, NpcEntry, QuestEntry, WorldFactEntry, WorldState,
} from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import { createInitialStoryState } from "@/game/domain/storyState";
import type { GenerationMetadata } from "@/game/domain/worldEntity";
import type { EntityCompatibilityProjection } from "@/game/domain/entity/entityProjection";
import {
  createWorldStateFixtureWith,
  type WorldStateFixtureOverrides,
} from "@/game/domain/testing/worldStateFixture.testutil";
import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import {
  asLocationId,
  asNpcId,
  asEnemyId,
  asGenerationId,
  asQuestId,
  asFactId,
} from "@/game/domain/worldEntity";
import { asNarrativeJobId, CommittedNarrativeEvent } from "@/game/domain/events";

const locTown = asLocationId("loc_0");
const locDyn1 = asLocationId("loc_dyn_1");
const npcDyn1 = asNpcId("npc_dyn_1");
const questId = asQuestId("quest_1");
const factTracks = asFactId("fact_tracks");

function storyState(): StoryState {
  return createInitialStoryState({
    initialNarrative: createFixtureNarrativeRuntimeState(),
    gameLength: "short",
    initialEntityCounts: { locations: 2, npcs: 1, quests: 1, events: 0 },
  });
}

const GENERATION: GenerationMetadata = {
  generationId: asGenerationId("generation_1"),
  seed: "seed",
  templateVersion: "v1",
  inputDigest: "digest",
  gameType: "wuxia",
};

const townLocation: LocationEntry = {
  id: locTown,
  name: "小镇",
  description: "山脚下的小镇。",
  kind: "main",
  connectedLocationIds: [locDyn1],
  npcIds: [],
  availableItemIds: [],
  tags: [],
};

const templeLocation: LocationEntry = {
  id: locDyn1,
  name: "破庙",
  description: "一座破败的庙宇。",
  kind: "main",
  connectedLocationIds: [locTown],
  npcIds: [npcDyn1],
  availableItemIds: [],
  tags: [],
};

const templeNpc: NpcEntry = {
  id: npcDyn1,
  name: "老乞丐",
  role: "破庙守夜人",
  description: "一个白发苍苍的老乞丐。",
  locationId: locDyn1,
  isCompanion: false,
  tags: [],
  met: false,
  memory: {
    npcId: npcDyn1,
    knownFactIds: [],
    hiddenFactIds: [],
    interactionHistory: [],
    relationship: { affinity: 0 },
    emotion: "neutral",
    goals: [],
  },
};

const mainQuest: QuestEntry = {
  id: questId,
  name: "主线",
  description: "追查破庙异状。",
  objectives: [
    { kind: "visit_location", locationId: locDyn1 },
    { kind: "discover_fact", factId: factTracks },
    { kind: "talk_to_npc", npcId: npcDyn1 },
  ],
  onSuccess: { kind: "advance_story" },
  onFailure: { kind: "closed" },
  tags: [],
  kind: "main",
  stage: 1,
  status: "active",
};

const tracksFact: WorldFactEntry = {
  factId: factTracks,
  text: "泥地上有杂乱的脚印。",
  source: "generated",
  discovered: false,
  locationId: locDyn1,
  investigationLabel: "查看脚印",
  investigationApproaches: [
    { approachId: "quiet", label: "安静观察", evidenceQuality: "clean", tensionDelta: 0 },
  ],
};

const BASE_PROJECTION: EntityCompatibilityProjection = {
  player: { name: "侠客", identity: "旅人", stats: { hp: 100, attack: 10, defense: 5 } },
  locations: [townLocation, templeLocation],
  currentLocationId: locTown,
  unlockedLocationIds: [locTown],
  visitedLocationIds: [locTown],
  npcs: [templeNpc],
  items: [],
  inventory: [],
  worldFacts: [tracksFact],
  quests: [mainQuest],
  enemies: [],
  defeatedEnemyIds: [],
  factions: [],
};

function buildWorld(overrides: WorldStateFixtureOverrides = {}): WorldState {
  return createWorldStateFixtureWith(
    { generation: GENERATION, base: BASE_PROJECTION },
    { eventLedger: [{ type: "game_initialized", generation: GENERATION  as unknown as CommittedNarrativeEvent} as unknown as CommittedNarrativeEvent], ...overrides },
  );
}

function worldState(): WorldState {
  return buildWorld();
}

/** 权威目标已切到交谈：当前地点名册里的 NPC 即焦点，终端回到 current_scene 决策点。 */
function directTalkWorld(): WorldState {
  return buildWorld({
    locations: [
      { ...townLocation, npcIds: [npcDyn1] },
      { ...templeLocation, npcIds: [] },
    ],
    npcs: [{ ...templeNpc, locationId: locTown }],
    quests: [{ ...mainQuest, objectives: [{ kind: "talk_to_npc", npcId: npcDyn1 }] }],
  });
}

function transition(objectiveIndex: number): ObjectiveTransition {
  return {
    before: null,
    completed: [],
    after: { questId, objectiveIndex, label: "test" },
    mode: "progressed",
  };
}

function validProposal(): NarrativeBundleProposal {
  return {
    worldDelta: null,
    currentScene: {
      segments: [{ beatId: "atmosphere", text: "你沿着山路走向破庙。" }],
      npcLine: null,
      objectiveLink: { questId: String(questId), objectiveIndex: 0, mode: "progress" },
      choices: [],
    },
    continuationScenes: [
      {
        stepKey: "move:loc_dyn_1",
        scene: {
          segments: [
            { beatId: "atmosphere", text: "破庙前，一个老乞丐坐在台阶上。" },
          ],
          npcLine: {
            npcId: String(npcDyn1),
            text: "后生，这里不是你该来的地方。",
            emotion: "guarded",
            answeredBeatIds: [],
            usedFactIds: [],
            usedEventIds: [],
          },
          objectiveLink: { questId: String(questId), objectiveIndex: 0, mode: "hint" },
          choices: [
            { candidateId: "move:loc_dyn_1_choice_1", label: "老丈，昨夜来的是谁？" },
            { candidateId: "move:loc_dyn_1_choice_2", label: "你若隐瞒，我只能自己搜。" },
          ],
        },
      },
    ],
    terminal: {
      kind: "next_decision",
      target: { kind: "continuation_step", stepKey: "move:loc_dyn_1" },
    },
  };
}

function currentSceneProposal(): NarrativeBundleProposal {
  return {
    worldDelta: null,
    currentScene: {
      segments: [{ beatId: "atmosphere", text: "老乞丐抬眼看向你。" }],
      npcLine: {
        npcId: String(npcDyn1),
        text: "你想问什么？",
        emotion: "guarded",
        answeredBeatIds: [],
        usedFactIds: [],
        usedEventIds: [],
      },
      objectiveLink: { questId: String(questId), objectiveIndex: 0, mode: "hint" },
      choices: [
        { candidateId: "current_scene_choice_1", label: "坦诚询问" },
        { candidateId: "current_scene_choice_2", label: "试探追问" },
      ],
    },
    continuationScenes: [],
    terminal: { kind: "next_decision", target: { kind: "current_scene" } },
  };
}

function baseInput(overrides: Partial<ApproveNarrativeBundleInput> = {}): ApproveNarrativeBundleInput {
  return {
    proposal: validProposal(),
    worldState: worldState(),
    storyState: storyState(),
    transition: transition(0),
    evolutionNeed: { kind: "none" },
    jobId: asNarrativeJobId("job_1"),
    basedOnRevision: 1,
    mandatoryBeats: [],
    now: () => "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * 幕边界前的世界：主线已收束、地点尚未扩张。
 * 旧夹具让这条已完成主线继续指向 loc_dyn_1 / fact_tracks / npc_dyn_1——正是待审批
 * worldDelta 才具象化的实体；当前投影要求任务目标引用必须可解析，因此以空目标列表
 * 表达同一条已完成主线，下一幕首个目标由具象化后的新任务供给。
 */
function preExpansionWorld(overrides: WorldStateFixtureOverrides = {}): WorldState {
  return buildWorld({
    locations: [{ ...townLocation, connectedLocationIds: [] }],
    npcs: [],
    items: [],
    enemies: [],
    worldFacts: [],
    quests: [{ ...mainQuest, objectives: [], status: "completed" }],
    ...overrides,
  });
}

/** 自然幕边界：世界尚未扩张，storyState 需要下一幕，提案带完整 worldDelta；overrides 扩张幕前世界。 */
function actBoundaryFixture(overrides: WorldStateFixtureOverrides = {}) {
  const ss: StoryState = {
    ...storyState(),
    currentAct: 2,
    targetActs: 3,
    evolution: {
      ...storyState().evolution,
      nextLocationOrdinal: 1,
      nextNpcOrdinal: 1,
      nextItemOrdinal: 1,
      nextEnemyOrdinal: 1,
      nextQuestOrdinal: 1,
      status: "needs_next_act",
    },
  };
  const proposal: NarrativeBundleProposal = {
    worldDelta: {
      beatSummary: "旧案把侠客引向镇外。",
      newLocation: { name: "枯柳驿", description: "镇外荒废的驿站。", scale: "scene", placement: "world", connectFromLocationId: "loc_0" },
      newNpc: {
        name: "老驼子", role: "守夜人", description: "守在驿站里的老人。", locationRef: { kind: "new_location" },
        anchors: { selfConcept: "守着旧案秘密的老人", values: ["守诺"], speechStyle: "低声而谨慎", capabilityBoundaries: ["只知道亲身见闻"], taboos: [] },
        goals: [{ horizon: "short", description: "守住秘密", priority: 3, reason: "旧案仍不能落入旁人之手" }],
        relationshipSeeds: [],
      },
      newItem: { name: "半块令牌", description: "断裂的旧令牌。", locationRef: "new_location" },
      newEnemy: { name: "蒙面劫匪", tier: "normal", locationRef: "new_location" },
      newFact: null,
      nextMainQuest: { name: "枯柳驿线索", description: "前往枯柳驿调查。", objectiveText: "调查枯柳驿" },
      endingPair: null,
    },
    currentScene: {
      segments: [{ beatId: "atmosphere", text: "旧人指向了镇外。" }],
      npcLine: null,
      objectiveLink: null,
      choices: [],
    },
    continuationScenes: [{
      stepKey: "move:loc_dyn_1",
      scene: {
        segments: [{ beatId: "arrival", text: "你来到枯柳驿。" }],
        npcLine: { npcId: "npc_dyn_1", text: "来者何人？", emotion: "guarded", answeredBeatIds: [], usedFactIds: [], usedEventIds: [] },
        objectiveLink: null,
        choices: [
          { candidateId: "move:loc_dyn_1_choice_1", label: "表明身份" },
          { candidateId: "move:loc_dyn_1_choice_2", label: "先行试探" },
        ],
      },
    }],
    terminal: { kind: "next_decision", target: { kind: "continuation_step", stepKey: "move:loc_dyn_1" } },
  };
  return { preExpansionWorld: preExpansionWorld(overrides), ss, proposal };
}

describe("approveNarrativeBundle", () => {
  it("approves a valid bundle with continuation_step terminal", () => {
    const result = approveNarrativeBundle(baseInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.approved.bundle.steps).toHaveLength(1);
    expect(result.approved.bundle.steps[0]?.stepId).toBe("move:loc_dyn_1");
    expect(result.approved.bundle.activeStepIds).toEqual(["move:loc_dyn_1"]);
    expect(result.approved.choiceRegistry).toHaveLength(2);
    expect(result.approved.currentScene.source).toBe("generated");
  });

  it("rejects an unknown step key not in the descriptor graph", () => {
    const base = validProposal();
    const proposal: NarrativeBundleProposal = {
      ...base,
      continuationScenes: [
        { ...base.continuationScenes[0]!, stepKey: "move:nonexistent" },
      ],
      terminal: {
        kind: "next_decision",
        target: { kind: "continuation_step", stepKey: "move:nonexistent" },
      },
    };
    const result = approveNarrativeBundle(baseInput({ proposal }));
    expect(result).toEqual({ ok: false, code: "bundle_unknown_step" });
  });

  it("rejects a missing continuation scene", () => {
    const proposal: NarrativeBundleProposal = {
      ...validProposal(),
      continuationScenes: [],
    };
    const result = approveNarrativeBundle(baseInput({ proposal }));
    expect(result.ok).toBe(false);
  });

  it("rejects a duplicate step key", () => {
    const base = validProposal();
    const proposal: NarrativeBundleProposal = {
      ...base,
      continuationScenes: [base.continuationScenes[0]!, { ...base.continuationScenes[0]! }],
    };
    const result = approveNarrativeBundle(baseInput({ proposal }));
    expect(result.ok).toBe(false);
  });

  it("rejects current-scene dialogue from an NPC absent from the current scene", () => {
    const proposal = {
      ...validProposal(),
      currentScene: {
        ...validProposal().currentScene,
        npcDialogues: [{
          npcId: String(npcDyn1),
          text: "老乞丐不该在这里说话。",
          usedFactIds: [],
          usedEventIds: [],
        }],
      },
    } satisfies NarrativeBundleProposal;

    const result = approveNarrativeBundle(baseInput({ proposal }));

    expect(result).toEqual({ ok: false, code: "bundle_invalid_scene", detail: "missing_speaker" });
  });

  it("rejects duplicate NPC dialogue IDs atomically before bundle writeback", () => {
    const dialogue = {
      npcId: String(npcDyn1),
      text: "同一个人在场景里只能说一段闲聊。",
      usedFactIds: [],
      usedEventIds: [],
    };
    const proposal = {
      ...validProposal(),
      currentScene: {
        ...validProposal().currentScene,
        npcDialogues: [dialogue, { ...dialogue }],
      },
    } satisfies NarrativeBundleProposal;

    const result = approveNarrativeBundle(baseInput({ proposal }));

    expect(result).toEqual({ ok: false, code: "bundle_invalid_scene", detail: "duplicate_speaker" });
  });

  it("rejects undisclosed facts and foreign interactions through the bundle authority gate", () => {
    const factProposal = validProposal();
    const factResult = approveNarrativeBundle(baseInput({
      proposal: {
        ...factProposal,
        continuationScenes: [{
          ...factProposal.continuationScenes[0]!,
          scene: {
            ...factProposal.continuationScenes[0]!.scene,
            npcLine: {
              ...factProposal.continuationScenes[0]!.scene.npcLine!,
              usedFactIds: [String(factTracks)],
            },
          },
        }],
      },
    }));
    expect(factResult).toEqual({ ok: false, code: "bundle_invalid_scene" });
    expect("approved" in factResult).toBe(false);

    const interactionProposal = validProposal();
    const interactionResult = approveNarrativeBundle(baseInput({
      proposal: {
        ...interactionProposal,
        continuationScenes: [{
          ...interactionProposal.continuationScenes[0]!,
          scene: {
            ...interactionProposal.continuationScenes[0]!.scene,
            npcLine: {
              ...interactionProposal.continuationScenes[0]!.scene.npcLine!,
              usedEventIds: ["npc_other:trade"],
            },
          },
        }],
      },
    }));
    expect(interactionResult).toEqual({ ok: false, code: "bundle_invalid_scene" });
    expect("approved" in interactionResult).toBe(false);
  });

  it("approves a current_scene terminal only when it provides both server candidates", () => {
    const result = approveNarrativeBundle(baseInput({
      proposal: currentSceneProposal(),
      worldState: directTalkWorld(),
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.approved.choiceRegistry).toHaveLength(2);
    expect(result.approved.currentScene.choices).toHaveLength(2);
    expect(result.approved.currentScene.event).toEqual({ kind: "dialogue", focusNpcId: npcDyn1 });
  });

  it("normalizes whole-line quote wrappers before persisting generated NPC speech", () => {
    const proposal = currentSceneProposal();
    const result = approveNarrativeBundle(baseInput({
      proposal: {
        ...proposal,
        currentScene: {
          ...proposal.currentScene,
          npcLine: {
            ...proposal.currentScene.npcLine!,
            text: "‘账本、血手。’",
          },
        },
      },
      worldState: directTalkWorld(),
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.approved.currentScene.npcLine?.text).toBe("账本、血手。");
  });

  it("preserves a direct answer containing an ordinary colon through approval", () => {
    const proposal = currentSceneProposal();
    const answer = "你既问到这里，我就把我知道的都说清楚：药是救人的，规矩也是救人的。";
    const result = approveNarrativeBundle(baseInput({
      proposal: {
        ...proposal,
        currentScene: {
          ...proposal.currentScene,
          npcLine: { ...proposal.currentScene.npcLine!, text: answer },
        },
      },
      worldState: directTalkWorld(),
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.approved.currentScene.npcLine?.text).toBe(answer);
  });

  it("reclassifies a continuation's pure NPC stage direction as generated narration", () => {
    const proposal = validProposal();
    const result = approveNarrativeBundle(baseInput({
      proposal: {
        ...proposal,
        continuationScenes: [{
          ...proposal.continuationScenes[0]!,
          scene: {
            ...proposal.continuationScenes[0]!.scene,
            npcLine: {
              ...proposal.continuationScenes[0]!.scene.npcLine!,
              text: "……（哑巴张沉默地看着你，指了指地上的铁莲花镖囊，喉咙里发出含混的啊啊声。）",
            },
          },
        }],
      },
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.approved.bundle.steps[0]?.scene.npcLine).toBeNull();
    expect(result.approved.bundle.steps[0]?.scene.segments[0]?.text).toContain("哑巴张沉默地看着你");
  });

  it("rejects a dialogue boundary whose current scene omits the focus NPC line", () => {
    const proposal = currentSceneProposal();
    const result = approveNarrativeBundle(baseInput({
      proposal: { ...proposal, currentScene: { ...proposal.currentScene, npcLine: null } },
      worldState: directTalkWorld(),
    }));

    expect(result).toEqual({ ok: false, code: "dialogue_focus_line_missing", detail: String(npcDyn1) });
  });

  it("rejects a current_scene terminal that omits one of the two candidates", () => {
    const proposal = currentSceneProposal();
    const result = approveNarrativeBundle(baseInput({
      proposal: {
        ...proposal,
        currentScene: { ...proposal.currentScene, choices: [proposal.currentScene.choices[0]!] },
      },
      worldState: directTalkWorld(),
    }));

    expect(result).toEqual({ ok: false, code: "bundle_invalid_scene" });
  });

  it("rejects a proposal terminal that does not match the server graph", () => {
    const proposal = currentSceneProposal();
    const result = approveNarrativeBundle(baseInput({
      proposal: {
        ...proposal,
        currentScene: { ...proposal.currentScene, choices: [] },
        terminal: { kind: "ending" },
      },
      worldState: directTalkWorld(),
    }));

    expect(result).toEqual({ ok: false, code: "bundle_invalid_terminal" });
  });

  it("anchors an act-boundary bundle at the newly materialized first objective", () => {
    const { preExpansionWorld, ss, proposal } = actBoundaryFixture();

    const result = approveNarrativeBundle(baseInput({
      proposal,
      worldState: preExpansionWorld,
      storyState: ss,
      transition: { before: null, completed: [], after: null, mode: "advanced_act" },
      evolutionNeed: { kind: "next_act", act: 2 },
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.approved.bundle.activeStepIds).toEqual(["move:loc_dyn_1"]);
    expect(result.approved.choiceRegistry).toHaveLength(2);
  });

  it("撞名的下一幕提案带规则引擎理由被拒，供修复重试指明方向", () => {
    const { preExpansionWorld, ss, proposal } = actBoundaryFixture({
      enemies: [{
        id: asEnemyId("enemy_dyn_0"),
        name: "蒙面劫匪",
        tier: "normal",
        stats: { hp: 40, attack: 8, defense: 3 },
        locationId: locTown,
        tags: [],
      }],
    });

    const result = approveNarrativeBundle(baseInput({
      proposal,
      worldState: preExpansionWorld,
      storyState: ss,
      transition: { before: null, completed: [], after: null, mode: "advanced_act" },
      evolutionNeed: { kind: "next_act", act: 2 },
    }));

    expect(result).toEqual({ ok: false, code: "world_delta_rejected", detail: "duplicate_name:enemy:蒙面劫匪" });
  });

  it("does not expose partial result on failure", () => {
    const base = validProposal();
    const proposal: NarrativeBundleProposal = {
      ...base,
      continuationScenes: [
        { ...base.continuationScenes[0]!, stepKey: "move:nonexistent" },
      ],
      terminal: {
        kind: "next_decision",
        target: { kind: "continuation_step", stepKey: "move:nonexistent" },
      },
    };
    const result = approveNarrativeBundle(baseInput({ proposal }));
    expect(result.ok).toBe(false);
    expect("approved" in result).toBe(false);
    expect("nextWorldState" in result).toBe(false);
  });

  it("rejects a current scene that invents beat ids outside the mandatory list", () => {
    const proposal = validProposal();
    const result = approveNarrativeBundle(baseInput({
      proposal: {
        ...proposal,
        currentScene: {
          ...proposal.currentScene,
          segments: [{ beatId: "reflection", text: "你回想起镇口的告示。" }],
        },
      },
    }));

    expect(result).toEqual({ ok: false, code: "invented_beat_id", detail: "reflection" });
  });

  it("rejects a current scene that skips a mandatory beat", () => {
    const proposal = validProposal();
    const result = approveNarrativeBundle(baseInput({
      proposal: {
        ...proposal,
        currentScene: { ...proposal.currentScene, segments: [] },
      },
      mandatoryBeats: [
        { beatId: "quest_progress_0", kind: "quest_progress", subjectIds: [String(questId)], instruction: "完成了任务目标" },
        { beatId: "atmosphere", kind: "atmosphere", subjectIds: [], instruction: "氛围描写（可选，放在最后）" },
      ],
    }));

    expect(result).toEqual({ ok: false, code: "missing_mandatory_beat", detail: "quest_progress_0（quest_progress）" });
  });

  it("keeps atmosphere optional when it is the only listed beat", () => {
    const proposal = validProposal();
    const result = approveNarrativeBundle(baseInput({
      proposal: {
        ...proposal,
        currentScene: { ...proposal.currentScene, segments: [] },
      },
      mandatoryBeats: [
        { beatId: "atmosphere", kind: "atmosphere", subjectIds: [], instruction: "氛围描写（可选，放在最后）" },
      ],
    }));

    expect(result.ok).toBe(true);
  });

  it("approves a single atmosphere segment when atmosphere is the only listed beat", () => {
    const proposal = validProposal();
    const result = approveNarrativeBundle(baseInput({
      proposal: {
        ...proposal,
        currentScene: {
          ...proposal.currentScene,
          segments: [{ beatId: "atmosphere", text: "暮色四合。" }],
        },
      },
      mandatoryBeats: [
        { beatId: "atmosphere", kind: "atmosphere", subjectIds: [], instruction: "氛围描写（可选，放在最后）" },
      ],
    }));

    expect(result.ok).toBe(true);
  });

  it("keeps atmosphere optional when mandatory beats are absent", () => {
    const proposal = validProposal();
    const result = approveNarrativeBundle(baseInput({
      proposal: {
        ...proposal,
        currentScene: { ...proposal.currentScene, segments: [] },
      },
      mandatoryBeats: [],
    }));

    expect(result.ok).toBe(true);
  });

  it("requires the focus NPC to answer the player_utterance beat", () => {
    const proposal = validProposal();
    const result = approveNarrativeBundle(baseInput({
      proposal: {
        ...proposal,
        currentScene: {
          ...proposal.currentScene,
          segments: [{ beatId: "player_utterance", text: "你开口追问。" }],
          npcLine: null,
        },
      },
      mandatoryBeats: [
        { beatId: "player_utterance", kind: "player_utterance", subjectIds: [String(npcDyn1)], instruction: "直接回应玩家刚说的话" },
      ],
    }));

    expect(result).toEqual({ ok: false, code: "player_utterance_unanswered", detail: String(npcDyn1) });
  });

  it("approves when the focus NPC answers the player_utterance beat", () => {
    const proposal = currentSceneProposal();
    const result = approveNarrativeBundle(baseInput({
      proposal: {
        ...proposal,
        currentScene: {
          ...proposal.currentScene,
          segments: [{ beatId: "player_utterance", text: "你开口问起镖局的旧事。" }],
          npcLine: {
            npcId: String(npcDyn1),
            text: "这事说来话长。",
            emotion: "guarded",
            answeredBeatIds: ["player_utterance"],
            usedFactIds: [],
            usedEventIds: [],
          },
        },
      },
      mandatoryBeats: [
        { beatId: "player_utterance", kind: "player_utterance", subjectIds: [String(npcDyn1)], instruction: "直接回应玩家刚说的话" },
      ],
      worldState: directTalkWorld(),
    }));

    expect(result.ok).toBe(true);
  });

  it("rejects an objectiveLink that does not mirror the authoritative transition", () => {
    const proposal = validProposal();
    const result = approveNarrativeBundle(baseInput({
      proposal: {
        ...proposal,
        currentScene: { ...proposal.currentScene, objectiveLink: null },
      },
    }));

    expect(result).toEqual({ ok: false, code: "objective_link_mismatch", detail: `期望 ${String(questId)}:0` });
  });

  it("covers mandatory beats regardless of segment order", () => {
    const proposal = validProposal();
    const result = approveNarrativeBundle(baseInput({
      proposal: {
        ...proposal,
        currentScene: {
          ...proposal.currentScene,
          segments: [
            { beatId: "quest_advanced_1", text: "主线推进。" },
            { beatId: "quest_progress_0", text: "目标达成。" },
            { beatId: "atmosphere", text: "暮色四合。" },
          ],
        },
      },
      mandatoryBeats: [
        { beatId: "quest_progress_0", kind: "quest_progress", subjectIds: [String(questId)], instruction: "完成了任务目标" },
        { beatId: "quest_advanced_1", kind: "quest_advanced", subjectIds: [String(questId)], instruction: "主线推进" },
        { beatId: "atmosphere", kind: "atmosphere", subjectIds: [], instruction: "氛围描写（可选，放在最后）" },
      ],
    }));

    expect(result.ok).toBe(true);
  });

  it("rejects an arrival terminal step that omits the arrival NPC line", () => {
    const { preExpansionWorld, ss, proposal } = actBoundaryFixture();
    const hollowed: NarrativeBundleProposal = {
      ...proposal,
      continuationScenes: [{
        ...proposal.continuationScenes[0]!,
        scene: { ...proposal.continuationScenes[0]!.scene, npcLine: null },
      }],
    };

    const result = approveNarrativeBundle(baseInput({
      proposal: hollowed,
      worldState: preExpansionWorld,
      storyState: ss,
      transition: { before: null, completed: [], after: null, mode: "advanced_act" },
      evolutionNeed: { kind: "next_act", act: 2 },
    }));

    expect(result).toEqual({ ok: false, code: "dialogue_focus_line_missing", detail: "npc_dyn_1" });
  });
});
