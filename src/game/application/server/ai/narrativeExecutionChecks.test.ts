import { describe, expect, it, vi } from "vitest";
import { createWorldStateFixtureWith, emptyProjection } from "@/game/domain/testing/worldStateFixture.testutil";
import { createInitialStoryState } from "@/game/domain/storyState";
import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { asGenerationId, asLocationId, asNpcId, asItemId } from "@/game/domain/worldEntity";
import { asNarrativeJobId } from "@/game/domain/events";
import type { PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import type { NarrativeBundleProposal } from "@/game/domain/narrativeBundle";
import { hashNarrativeCandidate, type NarrativeCandidateReviewInput } from "../../narrativeCandidateReview";
import { buildNarrativeExecutionChecks, validateNarrativeExecutionChecks } from "./narrativeExecutionChecks";
import { buildNarrativeProgressRequirements } from "./narrativeProgressContract";
import { createLiveNarrativeCandidateReview } from "./liveNarrativeCandidateReview";
import { fixtureNarrativeReviewPass } from "./testing/narrativeReviewFixture.testutil";
import type { RpgAiClient } from "./rpgAiClient";
import { makeCommittedEvent } from "@/game/domain/testing/committedEventFactory";
import { projectEntityStore } from "@/game/domain/entity";
import { PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";

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
  });
});
