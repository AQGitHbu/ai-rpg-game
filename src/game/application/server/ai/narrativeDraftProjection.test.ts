import { describe, expect, it } from "vitest";
import { parseNarrativeBundleProposal } from "@/game/domain/narrativeBundle";
import { createInitialWorldState } from "@/game/domain/worldState";
import { updateWorldStateFixture } from "@/game/domain/testing/worldStateFixture.testutil";
import { createInitialStoryState } from "@/game/domain/storyState";
import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { asGenerationId, asLocationId, asNpcId, asQuestId } from "@/game/domain/worldEntity";
import { compileNarrativeDraft, projectNarrativeDraft, type NarrativeDraftContext } from "./narrativeDraftProjection";

function context(status?: "needs_next_act" | "needs_ending_pair"): NarrativeDraftContext {
  const storyState = createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short", initialEntityCounts: { locations: 1, npcs: 0, quests: 1, events: 0 } });
  return {
    worldState: createInitialWorldState({
      generation: { generationId: asGenerationId("draft"), seed: "seed", templateVersion: "v1", inputDigest: "", gameType: "wuxia" },
      player: { name: "侠客", identity: "旅人", stats: { hp: 100, attack: 10, defense: 5 } },
      startingLocation: { id: asLocationId("loc_0"), name: "小镇", description: "山下。", kind: "main", connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [] },
      startingItemIds: [],
    }),
    storyState: status === undefined ? storyState : { ...storyState, evolution: { ...storyState.evolution, status } },
    job: { actionSummary: { kind: "talk", npcId: asNpcId("npc_1") }, objectiveTransition: { before: null, completed: [], after: { questId: asQuestId("quest_1"), objectiveIndex: 0, label: "交谈" }, mode: "unchanged" } },
  };
}

function scene(text: string, count: number) {
  return { segments: [{ beatId: "atmosphere", text }], npcLine: null, objectiveLink: null,
    choices: Array.from({ length: count }, (_, index) => ({ candidateId: `explicit_${index}`, label: `原文选择 ${index}，不换绑。` })) };
}

describe("narrative draft projection and compilation", () => {
  it("validates an expressions draft body without imposing an ending's zero-choice contract", () => {
    const current = { expressions: [{ kind: "narration", beatId: "atmosphere", text: "继续交谈。", referencedEntityIds: [] }],
      objectiveLink: null, choices: [{ candidateId: "first", label: "问询" }, { candidateId: "second", label: "倾听" }] };
    const compiled = compileNarrativeDraft({ worldDelta: null, sceneDrafts: [{ slotKey: "current", scene: current }] }, context());
    expect(compiled).toMatchObject({ ok: true, value: { currentScene: current } });
    if (compiled.ok) expect(parseNarrativeBundleProposal(compiled.value).ok).toBe(true);
  });
  it("preserves top-level consequence bindings for approval without a world delta", () => {
    const consequenceBindings = [{ kind: "bind_talk_completion", questRef: "quest_0", npcRef: "npc_0", conditions: [{ kind: "goal_status", npcId: "npc_0", goalOrdinal: 0, status: "completed" }] }];
    const result = compileNarrativeDraft({ worldDelta: null, consequenceBindings, sceneDrafts: [{ slotKey: "current", scene: scene("原文。", 2) }] }, context());
    expect(result).toMatchObject({ ok: true, value: { consequenceBindings } });
    if (result.ok) expect(parseNarrativeBundleProposal(result.value).ok).toBe(true);
  });

  it("drops an invalid legacy objective completion mode before strict bundle parsing", () => {
    const current = {
      ...scene("交付已结算。", 2),
      objectiveLink: { questId: "quest_1", objectiveIndex: 0, mode: "complete" },
    };
    const result = compileNarrativeDraft({ worldDelta: null, sceneDrafts: [{ slotKey: "current", scene: current }] }, context());
    expect(result).toMatchObject({ ok: true, value: { currentScene: { objectiveLink: null } } });
    if (result.ok) expect(parseNarrativeBundleProposal(result.value).ok).toBe(true);
  });
  it.each(["@current.location", "小镇", "loc_explicit"])("resolves only the explicit current-location symbol: %s", connectFromLocationId => {
    const input = context();
    const worldDelta = { newLocation: { name: "原名", description: "原文。", connectFromLocationId } };
    const currentScene = scene("场景原文。", 2);
    expect(compileNarrativeDraft({ worldDelta, sceneDrafts: [{ slotKey: "current", scene: currentScene }] }, input)).toMatchObject({ ok: true, value: {
      worldDelta: { newLocation: { ...worldDelta.newLocation, connectFromLocationId: connectFromLocationId === "@current.location" ? "loc_0" : connectFromLocationId } }, currentScene,
    } });
    expect(worldDelta.newLocation.connectFromLocationId).toBe(connectFromLocationId);
  });

  it("projects the ordinary current decision and preserves all authored fields", () => {
    const input = context();
    expect(projectNarrativeDraft(input)).toMatchObject({ stepKeys: [], slots: [{ slotKey: "current", choiceCount: 2 }], terminal: { kind: "next_decision", target: { kind: "current_scene" } } });
    const currentScene = scene("  原文\n第二行，标点。  ", 2);
    const interactionProposals = [{ proposalKey: "explicit" }];
    expect(compileNarrativeDraft({ worldDelta: null, sceneDrafts: [{ slotKey: "current", scene: currentScene }], interactionProposals }, input)).toEqual({ ok: true, value: { worldDelta: null, currentScene, continuationScenes: [], terminal: { kind: "next_decision", target: { kind: "current_scene" } }, interactionProposals } });
  });

  it("orders next-act slots by explicit keys while preserving scene text and candidate bindings", () => {
    const input = context("needs_next_act");
    const stepKey = `move:loc_dyn_${input.storyState.evolution.nextLocationOrdinal}`;
    expect(projectNarrativeDraft(input)).toMatchObject({ stepKeys: [stepKey], slots: [{ slotKey: "current", choiceCount: 0 }, { slotKey: stepKey, choiceCount: 2 }], terminal: { kind: "next_decision", target: { kind: "continuation_step", stepKey } } });
    const currentScene = scene("旧幕原文\n  不删空白。", 0);
    const arrival = scene("抵达原文——句号。", 2);
    const worldDelta = { beatSummary: "作者世界增量，原样保留。" };
    const result = compileNarrativeDraft({ worldDelta, sceneDrafts: [{ slotKey: stepKey, scene: arrival }, { slotKey: "current", scene: currentScene }] }, input);
    expect(result).toEqual({ ok: true, value: { worldDelta, currentScene, continuationScenes: [{ stepKey, scene: arrival }], terminal: { kind: "next_decision", target: { kind: "continuation_step", stepKey } } } });
  });

  it("projects ending as one choice-free current scene without creating world facts", () => {
    const input = context("needs_ending_pair");
    expect(projectNarrativeDraft(input)).toMatchObject({ slots: [{ slotKey: "current", choiceCount: 0 }], stepKeys: [], terminal: { kind: "ending" } });
    const currentScene = scene("结局原文。", 0);
    const endingOutcomes = [{ themeKey: "trust", choiceLabel: "相信", scene: scene("共同收束。", 0) }, { themeKey: "doubt", choiceLabel: "存疑", scene: scene("独自收束。", 0) }];
    expect(compileNarrativeDraft({ worldDelta: null, sceneDrafts: [{ slotKey: "current", scene: currentScene }], endingOutcomes }, input)).toEqual({ ok: true, value: { worldDelta: null, currentScene, continuationScenes: [], endingOutcomes, terminal: { kind: "ending" } } });
  });

  it("projects the ending handoff without another world delta when an approved pair already exists", () => {
    const base = context();
    const input: NarrativeDraftContext = {
      ...base,
      worldState: { ...base.worldState, endings: [
        { id: "ending_trust", name: "信任", description: "", theme: "trust", requirements: [] },
        { id: "ending_doubt", name: "存疑", description: "", theme: "doubt", requirements: [] },
      ] as never },
      storyState: { ...base.storyState, endingAllowed: true },
    };
    expect(projectNarrativeDraft(input)).toMatchObject({
      slots: [{ slotKey: "current", choiceCount: 0 }],
      terminal: { kind: "ending" },
    });
    expect(compileNarrativeDraft({ worldDelta: null, sceneDrafts: [{ slotKey: "current", scene: scene("终幕回应。", 0) }], endingOutcomes: [{ themeKey: "trust", choiceLabel: "相信", scene: scene("共同结果。", 0) }, { themeKey: "doubt", choiceLabel: "存疑", scene: scene("独自结果。", 0) }] }, input))
      .toMatchObject({ ok: true, value: { worldDelta: null, terminal: { kind: "ending" } } });
  });

  it("rejects missing, unknown and duplicate slots with their precise paths", () => {
    const input = context();
    const current = { slotKey: "current", scene: scene("正文", 2) };
    expect(compileNarrativeDraft({ worldDelta: null, sceneDrafts: [] }, input)).toEqual({ ok: false, code: "missing_slot", path: "$.sceneDrafts[slotKey=current]" });
    expect(compileNarrativeDraft({ worldDelta: null, sceneDrafts: [current, { ...current, slotKey: "invented" }] }, input)).toEqual({ ok: false, code: "unknown_slot", path: "$.sceneDrafts[1].slotKey" });
    expect(compileNarrativeDraft({ worldDelta: null, sceneDrafts: [current, current] }, input)).toEqual({ ok: false, code: "duplicate_slot", path: "$.sceneDrafts[1].slotKey" });
  });

  it.each([0, 1, 3])("rejects %i choices at a decision slot", count => {
    expect(compileNarrativeDraft({ worldDelta: null, sceneDrafts: [{ slotKey: "current", scene: scene("正文", count) }] }, context())).toEqual({ ok: false, code: "invalid_choice_count", path: "$.sceneDrafts[0].scene.choices" });
  });

  it("rejects choices on a nonterminal slot and a missing next-act arrival", () => {
    const input = context("needs_next_act");
    expect(compileNarrativeDraft({ worldDelta: null, sceneDrafts: [{ slotKey: "current", scene: scene("正文", 2) }] }, input)).toMatchObject({ ok: false, code: "invalid_choice_count" });
    expect(compileNarrativeDraft({ worldDelta: null, sceneDrafts: [{ slotKey: "current", scene: scene("正文", 0) }] }, input)).toEqual({ ok: false, code: "missing_slot", path: `$.sceneDrafts[slotKey=move:loc_dyn_${input.storyState.evolution.nextLocationOrdinal}]` });
  });

  it.each(["return_delivery", "objective_return", "invented"])("rejects unavailable or unknown graph %s", graph => {
    expect(compileNarrativeDraft({ graph, worldDelta: null, sceneDrafts: [{ slotKey: "current", scene: scene("正文", 2) }] }, context())).toEqual({ ok: false, code: graph === "invented" ? "unknown_graph" : "unavailable_graph", path: "$.graph" });
  });

  it("compiles an explicitly selected return to the unfinished objective without forcing it into the default dialogue", () => {
    const base = context();
    const locationId = asLocationId("loc_return");
    const npcId = asNpcId("npc_return");
    const worldState = updateWorldStateFixture(base.worldState, {
      locations: [{ ...base.worldState.locations[0]!, connectedLocationIds: [locationId] },
        { id: locationId, name: "接应处", description: "已到过的地点。", kind: "main", connectedLocationIds: [asLocationId("loc_0")], npcIds: [npcId], availableItemIds: [], tags: [] }],
      visitedLocationIds: [asLocationId("loc_0"), locationId], unlockedLocationIds: [asLocationId("loc_0"), locationId],
      npcs: [{ id: npcId, name: "接应人", role: "接应", description: "等候证据。", locationId, isCompanion: false, met: true, tags: [],
        memory: { npcId, knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] } }],
      quests: [{ id: asQuestId("quest_1"), name: "交接", description: "回到接应人处。", kind: "main", stage: 1, status: "active", tags: [],
        objectives: [{ kind: "talk_to_npc", npcId }], onSuccess: { kind: "advance_story" }, onFailure: { kind: "closed" } }],
    });
    const input = { ...base, worldState };
    expect(projectNarrativeDraft(input).stepKeys).toEqual([]);
    const currentScene = scene("你决定回去。", 0);
    const arrival = scene("你实际抵达后。", 2);
    const result = compileNarrativeDraft({ graph: "objective_return", worldDelta: null,
      sceneDrafts: [{ slotKey: "current", scene: currentScene }, { slotKey: "move:loc_return", scene: arrival }] }, input);
    expect(result).toMatchObject({ ok: true, value: { currentScene,
      continuationScenes: [{ stepKey: "move:loc_return", scene: arrival }],
      terminal: { kind: "next_decision", target: { kind: "continuation_step", stepKey: "move:loc_return" } } } });
    expect(input.worldState.currentLocationId).toBe("loc_0");
  });
});


describe("draft NPC line metadata defaults", () => {
  function compile(npcLine: unknown) {
    return compileNarrativeDraft({ worldDelta: null, sceneDrafts: [{ slotKey: "current", scene: { ...scene("原文", 2), npcLine } }] }, context());
  }
  it("fills only absent neutral metadata without mutating input or inventing text/IDs", () => {
    const line = { npcId: "npc_1", text: "原话" };
    const result = compile(line);
    expect(result).toMatchObject({ ok: true, value: { currentScene: { npcLine: { ...line, emotion: "neutral", answeredBeatIds: [], usedFactIds: [], usedEventIds: [] } } } });
    expect(line).toEqual({ npcId: "npc_1", text: "原话" });
    if (!result.ok) throw new Error("compile failed");
    expect(parseNarrativeBundleProposal(result.value).ok).toBe(true);
    for (const incomplete of [{ text: "原话" }, { npcId: "npc_1" }]) {
      const missing = compile(incomplete);
      expect(missing.ok && parseNarrativeBundleProposal(missing.value).ok).toBe(false);
    }
  });
  it.each(["emotion", "answeredBeatIds", "usedFactIds", "usedEventIds"])("retains explicit null/invalid %s for strict parser rejection", field => {
    for (const value of [null, 123]) {
      const line = { npcId: "npc_1", text: "原话", [field]: value };
      const result = compile(line);
      expect(result).toMatchObject({ ok: true, value: { currentScene: { npcLine: { [field]: value } } } });
      expect(result.ok && parseNarrativeBundleProposal(result.value).ok).toBe(false);
    }
  });
});
