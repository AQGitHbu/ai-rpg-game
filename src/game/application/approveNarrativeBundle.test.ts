import { describe, expect, it } from "vitest";
import { approveNarrativeBundle } from "./approveNarrativeBundle";
import type { ApproveNarrativeBundleInput } from "./approveNarrativeBundle";
import type { NarrativeBundleProposal } from "@/game/domain/narrativeBundle";
import type { ObjectiveTransition } from "@/game/domain/narrativeBeat";
import type { WorldState, NpcEntry } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { createInitialWorldState } from "@/game/domain/worldState";
import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import {
  asLocationId,
  asNpcId,
  asEnemyId,
  asGenerationId,
  asQuestId,
  asFactId,
} from "@/game/domain/worldEntity";
import { asNarrativeJobId } from "@/game/domain/events";

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

function worldState(): WorldState {
  const base = createInitialWorldState({
    generation: {
      generationId: asGenerationId("generation_1"),
      seed: "seed",
      templateVersion: "v1",
      inputDigest: "digest",
      gameType: "wuxia",
    },
    player: { name: "侠客", identity: "旅人", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: {
      id: locTown,
      name: "小镇",
      description: "山脚下的小镇。",
      kind: "main",
      connectedLocationIds: [locDyn1],
      npcIds: [],
      availableItemIds: [],
      tags: [],
    },
    startingItemIds: [],
  });
  const npc: NpcEntry = {
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
  return {
    ...base,
    locations: [
      base.locations[0]!,
      {
        id: locDyn1,
        name: "破庙",
        description: "一座破败的庙宇。",
        kind: "main",
        connectedLocationIds: [locTown],
        npcIds: [npcDyn1],
        availableItemIds: [],
        tags: [],
      },
    ],
    npcs: [npc],
    quests: [{
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
    }],
    worldFacts: [{
      factId: factTracks,
      text: "泥地上有杂乱的脚印。",
      source: "generated",
      discovered: false,
      locationId: locDyn1,
      investigationLabel: "查看脚印",
      investigationApproaches: [
        { approachId: "quiet", label: "安静观察", evidenceQuality: "clean", tensionDelta: 0 },
      ],
    }],
  };
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
      objectiveLink: null,
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
            usedInteractionActionIds: [],
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
        usedInteractionActionIds: [],
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
    now: () => "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

/** 自然幕边界：世界尚未扩张，storyState 需要下一幕，提案带完整 worldDelta。 */
function actBoundaryFixture() {
  const ws = worldState();
  const preExpansionWorld: WorldState = {
    ...ws,
    locations: [{ ...ws.locations[0]!, connectedLocationIds: [] }],
    npcs: [],
    items: [],
    enemies: [],
    worldFacts: [],
    quests: [{ ...ws.quests[0]!, status: "completed" }],
  };
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
      newNpc: { name: "老驼子", role: "守夜人", description: "守在驿站里的老人。", locationRef: { kind: "new_location" }, goals: ["守住秘密"] },
      newItem: { name: "半块令牌", description: "断裂的旧令牌。", locationRef: "new_location" },
      newEnemy: { name: "蒙面劫匪", tier: "normal", locationRef: "new_location" },
      newFact: null,
      nextMainQuest: { name: "枯柳驿线索", description: "前往枯柳驿调查。", objectiveText: "调查枯柳驿" },
      endingPair: null,
    },
    currentScene: {
      segments: [{ beatId: "closing", text: "旧人指向了镇外。" }],
      npcLine: null,
      objectiveLink: null,
      choices: [],
    },
    continuationScenes: [{
      stepKey: "move:loc_dyn_1",
      scene: {
        segments: [{ beatId: "arrival", text: "你来到枯柳驿。" }],
        npcLine: { npcId: "npc_dyn_1", text: "来者何人？", emotion: "guarded", answeredBeatIds: [], usedFactIds: [], usedInteractionActionIds: [] },
        objectiveLink: null,
        choices: [
          { candidateId: "move:loc_dyn_1_choice_1", label: "表明身份" },
          { candidateId: "move:loc_dyn_1_choice_2", label: "先行试探" },
        ],
      },
    }],
    terminal: { kind: "next_decision", target: { kind: "continuation_step", stepKey: "move:loc_dyn_1" } },
  };
  return { preExpansionWorld, ss, proposal };
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

  it("approves a current_scene terminal only when it provides both server candidates", () => {
    const ws = worldState();
    const directTalkWorld: WorldState = {
      ...ws,
      quests: [{
        ...ws.quests[0]!,
        objectives: [{ kind: "talk_to_npc", npcId: npcDyn1 }],
      }],
    };

    const result = approveNarrativeBundle(baseInput({
      proposal: currentSceneProposal(),
      worldState: directTalkWorld,
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.approved.choiceRegistry).toHaveLength(2);
    expect(result.approved.currentScene.choices).toHaveLength(2);
    expect(result.approved.currentScene.event).toEqual({ kind: "dialogue", focusNpcId: npcDyn1 });
  });

  it("normalizes whole-line quote wrappers before persisting generated NPC speech", () => {
    const ws = worldState();
    const directTalkWorld: WorldState = {
      ...ws,
      quests: [{
        ...ws.quests[0]!,
        objectives: [{ kind: "talk_to_npc", npcId: npcDyn1 }],
      }],
    };
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
      worldState: directTalkWorld,
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.approved.currentScene.npcLine?.text).toBe("账本、血手。");
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

  it("derives a dialogue boundary from server choices when the AI omits npcLine", () => {
    const ws = worldState();
    const directTalkWorld: WorldState = {
      ...ws,
      quests: [{ ...ws.quests[0]!, objectives: [{ kind: "talk_to_npc", npcId: npcDyn1 }] }],
    };
    const proposal = currentSceneProposal();
    const result = approveNarrativeBundle(baseInput({
      proposal: { ...proposal, currentScene: { ...proposal.currentScene, npcLine: null } },
      worldState: directTalkWorld,
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.approved.currentScene.event).toEqual({ kind: "dialogue", focusNpcId: npcDyn1 });
  });

  it("rejects a current_scene terminal that omits one of the two candidates", () => {
    const ws = worldState();
    const directTalkWorld: WorldState = {
      ...ws,
      quests: [{
        ...ws.quests[0]!,
        objectives: [{ kind: "talk_to_npc", npcId: npcDyn1 }],
      }],
    };
    const proposal = currentSceneProposal();
    const result = approveNarrativeBundle(baseInput({
      proposal: {
        ...proposal,
        currentScene: { ...proposal.currentScene, choices: [proposal.currentScene.choices[0]!] },
      },
      worldState: directTalkWorld,
    }));

    expect(result).toEqual({ ok: false, code: "bundle_invalid_scene" });
  });

  it("rejects a proposal terminal that does not match the server graph", () => {
    const ws = worldState();
    const directTalkWorld: WorldState = {
      ...ws,
      quests: [{
        ...ws.quests[0]!,
        objectives: [{ kind: "talk_to_npc", npcId: npcDyn1 }],
      }],
    };
    const proposal = currentSceneProposal();
    const result = approveNarrativeBundle(baseInput({
      proposal: {
        ...proposal,
        currentScene: { ...proposal.currentScene, choices: [] },
        terminal: { kind: "ending" },
      },
      worldState: directTalkWorld,
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
    const { preExpansionWorld, ss, proposal } = actBoundaryFixture();
    const worldWithSameNameEnemy: WorldState = {
      ...preExpansionWorld,
      enemies: [{
        id: asEnemyId("enemy_dyn_0"),
        name: "蒙面劫匪",
        tier: "normal",
        stats: { hp: 40, attack: 8, defense: 3 },
        locationId: locTown,
        tags: [],
      }],
    };

    const result = approveNarrativeBundle(baseInput({
      proposal,
      worldState: worldWithSameNameEnemy,
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
});
