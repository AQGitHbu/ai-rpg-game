import { expect, it } from "vitest";
import { createPendingDecisionRecord, makeDecisionPlan, withOfflineDrafts } from "@/game/domain/testing/stagedNarrativeFixture.testutil";
import { approvePlanningContext } from "@/game/application/narrativeGeneration/approvePlanningContext";
import { projectUnitContext } from "@/game/application/narrativeGeneration/perspectiveContext";
import { dialogueConsistencyReviewInput, validateJobDialogueConsistencyReview } from "@/game/application/narrativeGeneration/dialogueConsistencyReview";
import { createStagedHarness } from "@/game/application/testing/stagedNarrativeHarness.testutil";
import { createWorldStateFixtureWith } from "@/game/domain/testing/worldStateFixture.testutil";
import { asFactId, asQuestId } from "@/game/domain/worldEntity";
import type { PlanProposal } from "@/game/domain/narrativePlan";

it("final review retains confirmed quest evidence and terminal public knowledge without model instructions", async () => {
  const record = createPendingDecisionRecord();
  if (record.storyState.narrative.status !== "provider_pending") throw Error("fixture");
  const baseInput = { kind: "decision" as const, world: record.worldState, story: record.storyState, job: record.storyState.narrative.job };
  const event = baseInput.world.eventLedger[1]!;
  const questId = baseInput.world.quests[0]!.id;
  const eventInput = { ...baseInput, world: { ...baseInput.world, eventLedger: baseInput.world.eventLedger.map(entry => entry.eventId !== event.eventId ? entry : {
    ...event, kind: "quest_completed" as const, payload: { type: "quest_completed" as const, questId },
  }) }, job: { ...baseInput.job, domainEventIds: [event.eventId], objectiveTransition: {
    ...baseInput.job.objectiveTransition, before: { questId: asQuestId(String(questId)), objectiveIndex: 0, label: "完成交谈" }, mode: "progressed" as const,
    completed: [{ questId: asQuestId(String(questId)), objectiveIndex: 0, label: "完成交谈" }] },
    mandatoryBeats: [{ beatId: "progress", kind: "quest_progress" as const, subjectIds: [String(questId)], instruction: "目标完成" }],
  } };
  const eventBase = withOfflineDrafts({ ...makeDecisionPlan(true), units: makeDecisionPlan(true).units.map(unit => unit.stage === "narration" ? {
    ...unit, requiredBeats: [{ beatId: "progress", kind: "quest_progress" as const, factIds: [], evidence: [{ kind: "committed" as const, eventId: String(event.eventId) }], instruction: "MODEL_INSTRUCTION_PRIVATE_SENTINEL" }],
  } : unit) });
  const eventPlan: PlanProposal = { ...eventBase, units: eventBase.units.map(unit => unit.draft?.stage !== "narration" ? unit : { ...unit,
    draft: { ...unit.draft, parts: unit.draft.parts.map(part => ({ ...part, text: "这段交谈的任务目标已经完成。" })) } }) };
  const endingInput = { ...baseInput, world: createWorldStateFixtureWith({ generation: record.worldState.generation, base: record.worldState }, {
    worldFacts: [...record.worldState.worldFacts, { factId: asFactId("fact_public_resolution"), text: "密信上的落款确实属于北滩船主。", source: "generated", discovered: true }, { factId: asFactId("fact_hidden"), text: "PRIVATE_UNDISCOVERED_SENTINEL", source: "generated", discovered: false }],
    npcs: record.worldState.npcs.map(npc => ({ ...npc, memory: { ...npc.memory, knownFactIds: [...npc.memory.knownFactIds, asFactId("fact_hidden")], hiddenFactIds: [...npc.memory.hiddenFactIds, asFactId("fact_hidden")] } })), eventLedger: record.worldState.eventLedger,
  }), story: { ...baseInput.story, endingAllowed: true, currentAct: baseInput.story.targetActs, evolution: { ...baseInput.story.evolution, status: "needs_ending_pair" as const } },
  job: { ...baseInput.job, objectiveTransition: { ...baseInput.job.objectiveTransition, after: null, mode: "advanced_act" as const } } };
  const endingBase = withOfflineDrafts({ ...makeDecisionPlan(true), terminal: { kind: "ending" }, decision: null, worldDelta: {
    beatSummary: "等待表态", newLocation: null, newNpc: null, newItem: null, newEnemy: null, newFact: null, nextMainQuest: null,
    endingPair: [{ themeKey: "trust", name: "携手前行", description: "选择信任" }, { themeKey: "doubt", name: "独立求证", description: "选择质疑" }],
  } });
  const endingPlan: PlanProposal = { ...endingBase, units: endingBase.units.map(unit => unit.stage === "choices" ? { ...unit, draft: {
    stage: "choices", labels: [{ candidateId: "trust", label: "密信落款确实是北滩船主的，我愿意相信你。" }, { candidateId: "doubt", label: "我还要核实你的说法。" }],
  } } : unit) };
  for (const [input, proposal] of [[eventInput, eventPlan], [endingInput, endingPlan]] as const) {
    const approved = approvePlanningContext(input, proposal);
    if (!approved.ok) throw Error(approved.code);
    const h = createStagedHarness(); await h.startDecision(); const loaded = await h.readJob(); if (!loaded.ok) throw Error(loaded.code);
    const job = { ...loaded.value, input, units: approved.value.units.map(unit => ({ key: unit.key, unit, status: "approved" as const, attempts: 1, inputDigest: loaded.value.inputDigest, value: unit.draft! })) };
    const review = dialogueConsistencyReviewInput(job, approved.value); if (!review.ok || !review.value) throw Error(review.ok ? "missing" : review.code);
    const target = approved.value.units.find(unit => unit.stage === (input === eventInput ? "narration" : "choices"))!;
    const context = projectUnitContext({ plan: approved.value, unit: target, approved: new Map(approved.value.units.map(unit => [unit.key, unit.draft!])) }); if (!context.ok) throw Error(context.code);
    const item = review.value.request.items.find(item => item.stage === target.stage)!;
    if (input === eventInput) {
      expect(context.value.requiredBeats[0]?.evidence).toHaveLength(1);
      expect(item).toMatchObject({ authority: { events: [{ kind: "quest_completed", questId, objectives: [{ index: 0, label: "完成交谈" }] }] } });
      expect(JSON.stringify(item)).not.toContain("MODEL_INSTRUCTION_PRIVATE_SENTINEL");
      for (const change of ["uncommitted", "foreign_quest", "invented_event"] as const) {
        const invalid = change === "uncommitted" ? { ...eventInput, job: { ...eventInput.job, domainEventIds: [] } }
          : change === "foreign_quest" ? { ...eventInput, job: { ...eventInput.job, objectiveTransition: { ...eventInput.job.objectiveTransition, completed: [{ questId: asQuestId("foreign_quest"), objectiveIndex: 0, label: "PRIVATE_FOREIGN_OBJECTIVE" }] } } }
          : eventInput;
        const invalidPlan = change !== "invented_event" ? eventPlan : { ...eventPlan, units: eventPlan.units.map(unit => unit.stage !== "narration" ? unit : { ...unit, requiredBeats: unit.requiredBeats.map(beat => ({ ...beat, evidence: [{ kind: "committed" as const, eventId: "invented" }] })) }) };
        expect(approvePlanningContext(invalid, invalidPlan).ok).toBe(false);
      }
    } else {
      expect(context.value.visibleFacts.some(fact => fact.id === "fact_public_resolution")).toBe(true);
      expect(item.facts).toContainEqual({ id: "fact_public_resolution", text: "密信上的落款确实属于北滩船主。", certainty: "known" });
      expect(JSON.stringify(review.value.request)).not.toContain("PRIVATE_UNDISCOVERED_SENTINEL");
    }
  }
});

it("review public persona and selected approved actions are scoped, not private persona or unused actions", async () => {
  const { dialogueReviewHarness } = await import("./dialogueConsistencyFixture.testutil");
  const { h, plan } = await dialogueReviewHarness(false); const loaded = await h.readJob(); if (!loaded.ok) throw Error(loaded.code);
  const npc = plan.units.find(unit => unit.stage === "character")!;
  const action = { key: "visible_pause", actorId: npc.speakerId!, point: npc.point, kind: "pause" as const, objectId: null, audienceIds: ["player_0"] };
  const proposal = { ...plan, actions: [action, { ...action, key: "unused_action", kind: "look" as const }], units: plan.units.map(unit => unit.draft?.stage !== "character" ? unit : { ...unit, draft: { ...unit.draft, actions: [action] } }) };
  const approved = approvePlanningContext(loaded.value.input, proposal); if (!approved.ok) throw Error(approved.code);
  const job = { ...loaded.value, units: approved.value.units.map(unit => ({ key: unit.key, unit, status: "approved" as const, attempts: 1, inputDigest: loaded.value.inputDigest, value: unit.draft! })) };
  const built = dialogueConsistencyReviewInput(job, approved.value); if (!built.ok || !built.value) throw Error("review");
  const item = built.value.request.items.find(item => item.stage === "character")!;
  const context = projectUnitContext({ plan: approved.value, unit: approved.value.units.find(unit => unit.stage === "character")!, approved: new Map(approved.value.units.map(unit => [unit.key, unit.draft!])) }); if (!context.ok) throw Error(context.code);
  expect(item).toMatchObject({ authority: { publicRole: context.value.persona!.publicRole.text, actions: [{ kind: "pause", actorId: npc.speakerId, objectId: null }] } });
  expect(item.authority?.actions).toHaveLength(1);
  const choice = built.value.request.items.find(item => item.stage === "choices")!;
  expect(choice.authority?.addresseeRole).toEqual({ id: npc.speakerId, name: context.value.persona!.publicName, role: context.value.persona!.publicRole.text });
  expect(choice.authority?.publicRole).toBeUndefined();
  expect(JSON.stringify(item)).not.toContain("unused_action");
  expect(item).not.toHaveProperty("persona");
  const receipt = { ...job, dialogueConsistencyReview: { version: 2 as const, cycle: job.cycle, attempts: 1, status: "approved" as const,
    inputDigest: built.value.digest, passDigest: built.value.digest } };
  expect(validateJobDialogueConsistencyReview(receipt, approved.value).ok).toBe(true);
  const changed = { ...receipt, units: receipt.units.map(stored => stored.value.stage !== "character" ? stored : {
    ...stored, value: { ...stored.value, emotion: "warm" as const },
  }) };
  expect(validateJobDialogueConsistencyReview(changed, approved.value).ok).toBe(false);
  expect(built.value.request.items.filter(item => item.stage === "choices").map(item => item.facts.map(fact => fact.id))).toEqual([["fact_notice"], []]);
});
