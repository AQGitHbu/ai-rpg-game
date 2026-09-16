import { describe, expect, it, vi } from "vitest";
import { createWorldStateFixtureWith, emptyProjection, updateWorldStateFixture } from "@/game/domain/testing/worldStateFixture.testutil";
import { createInitialStoryState } from "@/game/domain/storyState";
import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { asGenerationId, asLocationId, asNpcId, asItemId, asQuestId, asFactId } from "@/game/domain/worldEntity";
import { asNarrativeJobId } from "@/game/domain/events";
import type { PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import type { NarrativeBundleProposal } from "@/game/domain/narrativeBundle";
import { hashNarrativeCandidate, type NarrativeCandidateReviewInput } from "../../narrativeCandidateReview";
import { buildNarrativeExecutionChecks, validateNarrativeExecutionChecks } from "./narrativeExecutionChecks";
import { buildNarrativeProgressRequirements } from "./narrativeProgressContract";
import { buildNarrativeReviewRules } from "./narrativeReviewRules";
import { createLiveNarrativeCandidateReview } from "./liveNarrativeCandidateReview";
import { fixtureNarrativeReviewPass } from "./testing/narrativeReviewFixture.testutil";
import type { RpgAiClient } from "./rpgAiClient";
import { makeCommittedEvent } from "@/game/domain/testing/committedEventFactory";
import { projectEntityStore } from "@/game/domain/entity";
import { PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import { projectNarrativeDraft } from "./narrativeDraftProjection";
import { compileDecisionNarrativeContext } from "./narrativeContext/narrativeBundleContext";

function input(ending = true): NarrativeCandidateReviewInput {
  const locationId = asLocationId("inner_hall");
  const remote = asLocationId("dock");
  const npcId = asNpcId("host");
  const worldState = createWorldStateFixtureWith({ generation: { generationId: asGenerationId("checks"), seed: "checks", templateVersion: "1", inputDigest: "", gameType: "wuxia" }, base: emptyProjection({
    player: { name: "客人", identity: "旅人", stats: { hp: 10, attack: 1, defense: 1 } }, currentLocationId: locationId,
    locations: [locationId, remote].map(id => ({ id, name: String(id), description: "", kind: "main", connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [] })),
  }) }, {
    npcs: [npcId, asNpcId("boatman")].map(id => ({ id, name: String(id), role: "见证人", description: "", locationId: id === npcId ? locationId : remote, isCompanion: false, met: true, tags: [], memory: { npcId: id, knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] } })),
    items: [{ id: asItemId("letter"), name: "信", description: "", kind: "quest", tags: [] }],
    inventory: [asItemId("letter")],
  });
  const story = createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short", initialEntityCounts: { locations: 2, npcs: 2, quests: 0, events: 0 } });
  const job = { jobId: asNarrativeJobId("checks"), actionId: "talk", turnNumber: 1, actionSummary: { kind: "talk", npcId }, resolvedEvent: { actionId: "talk", status: "success", eventKind: "dialogue", facts: [], stateChanges: [], costs: [], rewards: [], triggeredEvents: [], rejectedEffects: [] }, domainEventIds: [], focusNpcId: npcId, objectiveTransition: { before: null, completed: [], after: null, mode: "unchanged" }, mandatoryBeats: [], generationKind: "npc_fixed_choice" } as unknown as PendingNarrativeJob;
  const scene = { segments: [{ beatId: "atmosphere", text: "你仍在内堂，准备日后再去渡口。" }], npcLine: { npcId, text: "你可以先说出你的疑虑。", emotion: "neutral" as const, usedFactIds: ["fact_reference"], usedEventIds: [], answeredBeatIds: [] }, choices: [], objectiveLink: null };
  const proposal: NarrativeBundleProposal = { currentScene: scene, continuationScenes: [], worldDelta: { beatSummary: "你陈述了疑虑，尚未出门。", ...(ending ? { endingPair: ["doubt", "trust"].map(themeKey => ({ themeKey, name: "立场", description: "双方保留异议，偿债条件仍待完成。" })) } : {}) },
    terminal: { kind: "ending" }, ...(ending ? { endingOutcomes: (["doubt", "trust"] as const).map(themeKey => ({ themeKey, choiceLabel: "当面表达立场", scene })) } : {}),
  };
  return { context: { kind: "decision", worldState, storyState: { ...story, endingAllowed: ending, evolution: { ...story.evolution, status: ending ? "needs_ending_pair" : "stable" } }, job }, proposal, candidateVersion: 2, candidateHash: hashNarrativeCandidate(proposal) };
}
function response(value: NarrativeCandidateReviewInput) {
  return fixtureNarrativeReviewPass([{ content: "" }, { content: JSON.stringify({ context: { kind: "decision", executionChecks: buildNarrativeExecutionChecks(value), progressRequirements: buildNarrativeProgressRequirements(value) } }) }]);
}
function validate(value: NarrativeCandidateReviewInput, verdict: ReturnType<typeof response>) { return validateNarrativeExecutionChecks(verdict.executionChecks, verdict.progressChecks, value); }

describe("server-bound narrative execution extraction", () => {
  it("gives an approved objective return its movement basis without moving the current scene", () => {
    const original = input(false);
    if (original.context.kind !== "decision" || "opening" in original.proposal) throw new Error("decision expected");
    const worldState = updateWorldStateFixture(original.context.worldState, {
      locations: original.context.worldState.locations.map(location => ({ ...location,
        connectedLocationIds: [asLocationId(location.id === "dock" ? "inner_hall" : "dock")] })),
      visitedLocationIds: [asLocationId("inner_hall"), asLocationId("dock")],
      unlockedLocationIds: [asLocationId("inner_hall"), asLocationId("dock")],
      quests: [{ id: asQuestId("return_quest"), name: "交接", description: "返回渡口接应人处。", kind: "main", stage: 1, status: "active", tags: [],
        objectives: [{ kind: "talk_to_npc", npcId: asNpcId("boatman") }], onSuccess: { kind: "advance_story" }, onFailure: { kind: "closed" } }],
    });
    const value: NarrativeCandidateReviewInput = { ...original,
      context: { ...original.context, worldState, job: { ...original.context.job,
        objectiveTransition: { ...original.context.job.objectiveTransition,
          after: { questId: asQuestId("return_quest"), objectiveIndex: 0, label: "返回渡口" } } } },
      proposal: { ...original.proposal, worldDelta: null,
        continuationScenes: [{ stepKey: "move:dock", scene: { ...original.proposal.currentScene,
          segments: [{ beatId: "atmosphere", text: "你回到渡口，船夫仍在岸边。" }],
          npcLine: { ...original.proposal.currentScene.npcLine!, npcId: asNpcId("boatman") } } }],
        terminal: { kind: "next_decision", target: { kind: "continuation_step", stepKey: "move:dock" } } },
    };
    const checks = buildNarrativeExecutionChecks(value);
    expect(checks.find(check => check.path === "currentScene.segments[0].text")!.states[0]!.locationId).toBe("inner_hall");
    const arrival = checks.find(check => check.path === "continuationScenes[0].scene.segments[0].text")!;
    expect(arrival.states).toContainEqual(expect.objectContaining({ locationId: "dock",
      npcLocations: expect.arrayContaining([{ npcId: "boatman", locationId: "dock" }]) }));
    expect(arrival.prerequisiteBasisKeys).toContain("step:move:dock");
    expect(buildNarrativeReviewRules(value)).toContainEqual(expect.objectContaining({ key: "step:move:dock", kind: "step" }));
  });
  it("enumerates prose including both reordered ending themes and summaries, never reference arrays", () => {
    const value = input();
    const before = JSON.stringify(value);
    const checks = buildNarrativeExecutionChecks(value);
    expect(checks.some(check => /usedFactIds|beatId|npcId/.test(check.path))).toBe(false);
    expect(checks.find(check => check.path === "endingOutcomes[0].choiceLabel")?.basisKey).toBe("ending:doubt");
    expect(checks.find(check => check.path === "worldDelta.endingPair[1].description")?.basisKey).toBe("ending:trust");
    expect(checks.find(check => check.path === "worldDelta.beatSummary")?.prerequisiteBasisKeys).not.toContain("ending:trust");
    expect(validate(value, response(value))).toEqual([]);
    expect(JSON.stringify(value)).toBe(before);
  });
  it.each(["missing", "duplicate", "quote", "path", "theme", "progress", "premature_basis", "ambiguous"])("fails closed on %s", fault => {
    const value = input();
    const verdict = response(value);
    const checks = verdict.executionChecks!;
    if (fault === "missing") checks.pop();
    if (fault === "duplicate") checks[1] = checks[0]!;
    if (fault === "quote") checks[0]!.quote = "从未出现的引文";
    if (fault === "path") checks[0]!.path = "currentScene.missing";
    if (fault === "theme") checks.find(check => check.basisKey === "ending:doubt")!.basisKey = "ending:trust";
    if (fault === "progress") verdict.progressChecks!.pop();
    if (fault === "premature_basis") Object.assign(checks[0]!, { completedPrerequisites: [{ quote: checks[0]!.quote, claim: "立场结果已发生", basisKey: "ending:trust" }] });
    if (fault === "ambiguous") checks[0]!.playerLocation.kind = "maybe";
    expect(validate(value, verdict)).toBeNull();
  });
  it.each(["outside", "at", "npc", "transfer", "prerequisite"])("turns explicit %s rule violations into candidate-bound ACTION_MISMATCH", fault => {
    const value = input();
    const verdict = response(value);
    const check = verdict.executionChecks!.find(check => check.basisKey === "ending:trust")!;
    if (fault === "outside") check.playerLocation.kind = "outside_known_location";
    if (fault === "at") Object.assign(check.playerLocation, { kind: "at", locationId: "dock" });
    if (fault === "npc") Object.assign(check, { participants: [{ quote: check.quote, npcId: "boatman", locationId: "inner_hall" }] });
    if (fault === "transfer") Object.assign(check, { itemTransfers: [{ quote: check.quote, itemId: "letter", ownerId: "player", basisKey: null }] });
    if (fault === "prerequisite") Object.assign(check, { completedPrerequisites: [{ quote: check.quote, claim: "所有欠款已偿还，韩先生委托的话已转达", basisKey: null }] });
    expect(validate(value, verdict)).toEqual([expect.objectContaining({ code: "ACTION_MISMATCH", candidateVersion: 2, candidateHash: value.candidateHash, path: check.path })]);
  });
  it("keeps legal local gestures and future intentions, while violated progression uses causal defects", () => {
    const value = input();
    const verdict = response(value);
    const check = verdict.executionChecks![0]!;
    Object.assign(check, { participants: [{ quote: check.quote, npcId: "host", locationId: "inner_hall" }] });
    expect(validate(value, verdict)).toEqual([]);
    Object.assign(verdict.progressChecks![1]!, { status: "violated", reason: "委托并未处理，只重复引路，核心分歧没有得到回应。" });
    expect(validate(value, verdict)).toEqual([expect.objectContaining({ code: "BROKEN_CAUSALITY", evidence: expect.objectContaining({ basisKey: "progress:ending:doubt" }) })]);
  });
  it("rejects naked decision pass through the live boundary", async () => {
    const complete = vi.fn().mockResolvedValue({ ok: true, content: '{"verdict":"pass"}' });
    const result = await createLiveNarrativeCandidateReview({ aiClient: { complete } as unknown as RpgAiClient }).reviewNarrativeCandidate(input());
    expect(result).toMatchObject({ ok: false, failure: "UNCERTAIN" });
    expect(complete).toHaveBeenCalledTimes(2);
  });
  it("repairs cross-path review quotations once on the same candidate without bypassing execution checks", async () => {
    const value = input(false);
    const valid = response(value);
    const malformed = structuredClone(valid);
    Object.assign(malformed.executionChecks![0]!, { participants: [{ quote: "另一段的动作", npcId: "host", locationId: "inner_hall" }] });
    const complete = vi.fn()
      .mockResolvedValueOnce({ ok: true, content: JSON.stringify(malformed) })
      .mockResolvedValueOnce({ ok: true, content: JSON.stringify(valid) });
    const result = await createLiveNarrativeCandidateReview({ aiClient: { complete } as unknown as RpgAiClient }).reviewNarrativeCandidate(value);
    expect(result).toMatchObject({ ok: true, candidateHash: value.candidateHash });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1]![1].slice(0, 2)).toEqual(complete.mock.calls[0]![1]);
    expect(complete.mock.calls[1]![2].retry).toMatchObject({ mechanism: "content_repair", attempt: 1, reason: "invalid_schema" });
  });
  it("returns an actual action violation immediately instead of asking the reviewer for a pass", async () => {
    const value = input(false);
    const invalid = response(value);
    Object.assign(invalid.executionChecks![0]!.playerLocation, { kind: "at", locationId: "dock" });
    const complete = vi.fn().mockResolvedValue({ ok: true, content: JSON.stringify(invalid) });
    const result = await createLiveNarrativeCandidateReview({ aiClient: { complete } as unknown as RpgAiClient }).reviewNarrativeCandidate(value);
    expect(result).toMatchObject({ ok: false, defects: [expect.objectContaining({ code: "ACTION_MISMATCH" })] });
    expect(complete).toHaveBeenCalledTimes(1);
  });
  it("accepts an actual earlier delivery recap, but excludes unobserved transfers of the same visible item", () => {
    const original = input();
    if (original.context.kind !== "decision") throw new Error("decision expected");
    const store = structuredClone(original.context.worldState.entityStore);
    const letter = store.records.find(record => record.core.id === "letter")!;
    if (!("possession" in letter)) throw new Error("item expected");
    Object.assign(letter, { possession: { ...letter.possession, owner: { kind: "npc", npcId: asNpcId("host") } } });
    const event = makeCommittedEvent({ type: "item_given", itemId: asItemId("letter"), npcId: asNpcId("host"), locationId: asLocationId("inner_hall") }, { outcome: "success", actorIds: [PLAYER_ENTITY_ID] });
    const unseen = makeCommittedEvent({ type: "item_given", itemId: asItemId("letter"), npcId: asNpcId("boatman"), locationId: asLocationId("dock") }, { outcome: "success", actorIds: [asNpcId("host")], targetIds: [asNpcId("boatman")] });
    const value = { ...original, context: { ...original.context, storyState: { ...original.context.storyState, delivery: { itemId: asItemId("letter"), giverNpcId: asNpcId("boatman"), recipientNpcId: asNpcId("host") } }, worldState: { ...original.context.worldState, ...projectEntityStore(store), entityStore: store, eventLedger: [event, unseen] } } };
    const checks = buildNarrativeExecutionChecks(value);
    expect(checks[0]!.states[0]!.transfers).toEqual([{ itemId: "letter", ownerId: "host", basisKey: `event:${event.eventId}` }]);
    const verdict = response(value);
    const check = verdict.executionChecks!.find(check => check.basisKey === "ending:trust")!;
    Object.assign(check, { itemTransfers: [{ quote: check.quote, itemId: "letter", ownerId: "host", basisKey: `event:${event.eventId}` }] });
    expect(validate(value, verdict)).toEqual([]);
  });
  it("projects next-act movement only into its real continuation slot, never current or summary", () => {
    const original = input(false);
    if (original.context.kind !== "decision" || "opening" in original.proposal) throw new Error("decision expected");
    const value = { ...original, context: { ...original.context, storyState: { ...original.context.storyState, evolution: { ...original.context.storyState.evolution, status: "needs_next_act" as const, nextLocationOrdinal: 1 } } },
      proposal: { ...original.proposal, continuationScenes: [{ stepKey: "move:loc_dyn_1", scene: original.proposal.currentScene }] } };
    const checks = buildNarrativeExecutionChecks(value);
    expect(checks.find(check => check.path === "currentScene.segments[0].text")!.states[0]!.locationId).toBe("inner_hall");
    expect(checks.find(check => check.path === "continuationScenes[0].scene.segments[0].text")!.states[0]!.locationId).toBe("loc_dyn_1");
    expect(checks.find(check => check.path === "worldDelta.beatSummary")!.prerequisiteBasisKeys).not.toContain("step:move:loc_dyn_1");
    const verdict = response(value);
    expect(validate(value, verdict)).toEqual([]);
    const summary = verdict.executionChecks!.find(check => check.path === "worldDelta.beatSummary")!;
    Object.assign(summary, { playerLocation: { kind: "at", locationId: "loc_dyn_1" }, completedPrerequisites: [{ quote: summary.quote, claim: "玩家已抵达下一处地点", basisKey: null }] });
    expect(validate(value, verdict)).toContainEqual(expect.objectContaining({ code: "ACTION_MISMATCH", path: "worldDelta.beatSummary" }));
  });
  it("shares current fact timing with author and reviewer even without conditional endings", () => {
    const original = input(false);
    if (original.context.kind !== "decision") throw new Error("decision expected");
    const context = { ...original.context, storyState: { ...original.context.storyState, evolution: { ...original.context.storyState.evolution, status: "needs_next_act" as const, nextLocationOrdinal: 1 } } };
    const before = JSON.stringify(context);
    const author = compileDecisionNarrativeContext({ ...context, consumer: "author" });
    const reviewer = compileDecisionNarrativeContext({ ...context, consumer: "reviewer" });
    const timing = author.context.selected.find(block => block.id === "bundle:temporal-scope");
    expect(timing).toBeDefined();
    expect(timing).toEqual(reviewer.context.selected.find(block => block.id === "bundle:temporal-scope"));
    expect(timing).toMatchObject({ retention: "mandatory", authority: "rule" });
    expect(timing!.content).toContain('"basisKey":"action:talk"');
    expect(timing!.content).toContain('"playerLocationId":"inner_hall"');
    expect(timing!.content).toContain('"fields":["currentScene","worldDelta.beatSummary"]');
    expect(timing!.content).toContain('"basisKey":"step:move:loc_dyn_1"');
    expect(author.context.selected.some(block => block.id === "bundle:ending-resolution")).toBe(false);
    expect(JSON.stringify(context)).toBe(before);
  });
  it("does not advertise a world delta schema or require a summary during an ordinary dialogue repair", () => {
    const value = input(false);
    if (value.context.kind !== "decision") throw new Error("decision expected");
    const author = compileDecisionNarrativeContext({ ...value.context,
      contentRepair: { attempt: 1, reason: "invalid_schema", detail: "world_delta_invalid" } });
    expect(author.prompt).toContain("本回合 worldDelta 必须为 null");
    expect(author.prompt).not.toContain("worldDelta.beatSummary 必须是非空字符串");
    expect(author.context.selected.find(block => block.id === "bundle:output-contract")!.content).not.toContain('"newLocation":{');
    expect(author.context.selected.find(block => block.id === "bundle:temporal-scope")!.content).toContain('"fields":["currentScene"]');
  });
  it.each([false, true])("admits only the descriptor's unmet arrival NPC after visit→discover→talk (delivery=%s)", delivery => {
    const original = input(false);
    if (original.context.kind !== "decision" || "opening" in original.proposal) throw new Error("decision expected");
    const npcId = asNpcId("boatman");
    const locationId = asLocationId("dock");
    const questId = asQuestId("arrival_quest");
    const factId = asFactId("tracks");
    const worldState = createWorldStateFixtureWith({ generation: original.context.worldState.generation, base: projectEntityStore(original.context.worldState.entityStore) }, {
      npcs: [...original.context.worldState.npcs.map(npc => ({ ...npc, met: npc.id !== npcId })),
        { ...original.context.worldState.npcs[1]!, id: asNpcId("hidden_bystander"), met: false, memory: { ...original.context.worldState.npcs[1]!.memory, npcId: asNpcId("hidden_bystander") } }],
      locations: original.context.worldState.locations.map(location => ({ ...location, npcIds: location.id === locationId ? [npcId, asNpcId("hidden_bystander")] : [asNpcId("host")] })),
      worldFacts: [{ factId, text: "码头留下脚印。", source: "generated", discovered: false, locationId }],
      quests: [{ id: questId, name: "找到船工", description: "前往码头查看脚印并与船工谈话。", objectives: [
        { kind: "visit_location", locationId }, { kind: "discover_fact", factId }, { kind: "talk_to_npc", npcId },
      ], onSuccess: { kind: "advance_story" }, onFailure: { kind: "closed" }, tags: [], kind: "main", stage: 1, status: "active" }],
    });
    const storyState = { ...original.context.storyState, ...(delivery ? { currentAct: original.context.storyState.targetActs,
      delivery: { itemId: asItemId("letter"), giverNpcId: asNpcId("host"), recipientNpcId: npcId },
      contract: { ...original.context.storyState.contract, delivery: { itemKey: "letter", recipientKey: "boatman", verificationFactKeys: [] } },
    } : {}) };
    const context = { ...original.context, worldState, storyState, job: { ...original.context.job,
      objectiveTransition: { before: null, completed: [], after: { questId, objectiveIndex: 0, label: "抵达码头" }, mode: "progressed" as const },
    } };
    const projection = projectNarrativeDraft(context);
    expect(projection.descriptorGraph.steps[0]!.arrivalNpc?.id).toBe(npcId);
    expect(projection.stepKeys).toEqual(delivery ? ["move:dock", "give_item:letter:boatman"] : ["move:dock"]);
    const value = { ...original, context, proposal: { ...original.proposal, terminal: projection.terminal,
      continuationScenes: projection.stepKeys.map(stepKey => ({ stepKey, scene: { segments: [{ beatId: "atmosphere", text: "船工在码头向你点头。" }], npcLine: null, objectiveLink: null, choices: [] } })),
    } };
    const before = JSON.stringify(value);
    const checks = buildNarrativeExecutionChecks(value);
    for (const check of checks) {
      const ids = check.states[0]!.npcLocations.map(npc => npc.npcId);
      expect(ids).not.toContain("hidden_bystander");
      if (check.path.startsWith("continuationScenes")) expect(ids).toContain(npcId);
      else expect(ids).not.toContain(npcId);
    }
    const verdict = response(value);
    for (const check of verdict.executionChecks!) if (check.path.startsWith("continuationScenes")) {
      Object.assign(check, { participants: [{ quote: check.quote, npcId, locationId }] });
    }
    expect(validate(value, verdict)).toEqual([]);
    for (const path of ["currentScene.segments[0].text", "worldDelta.beatSummary"]) {
      const premature = structuredClone(verdict);
      const check = premature.executionChecks!.find(check => check.path === path)!;
      Object.assign(check, { participants: [{ quote: check.quote, npcId, locationId }] });
      expect(validate(value, premature)).toEqual([expect.objectContaining({ path, code: "ACTION_MISMATCH" })]);
    }
    expect(JSON.stringify(value)).toBe(before);
  });
});
