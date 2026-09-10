import { describe, expect, it } from "vitest";
import { MAX_NARRATIVE_BUNDLE_STEPS } from "./narrativeBundle";
import { MAX_PLAN_UNITS, parsePlanProposal, type PlanProposal, type Unit } from "./narrativePlan";
import type { BranchOption } from "./narrativeBranch";
import { makeStagedPlan } from "./testing/stagedNarrativeFixture.testutil";

function unit(overrides: Partial<Unit> = {}): Unit {
  return {
    key: "narration_1",
    stage: "narration",
    point: { stepKey: "current", order: 1 },
    speakerId: null,
    dependencies: [],
    taskFactIds: [],
    requiredObservationKeys: [],
    requiredBeats: [],
    ...overrides,
  };
}

function branchOption(candidateId: string, locationId: string): BranchOption {
  return {
    candidateId,
    dialogueAct: "offer",
    topic: { kind: "general" },
    target: { kind: "visit_location", locationId },
    publicIntent: { text: `我跟你去${locationId}。`, facts: [], evidence: [], beatIds: [] },
    deferredLocation: null,
  };
}

const base: PlanProposal = {
  opening: null,
  worldDelta: null,
  steps: [],
  units: [],
  observations: [],
  actions: [],
  decision: null,
  terminal: { kind: "ending" },
};

function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...base, ...overrides };
}

describe("parsePlanProposal", () => {
  it("accepts the minimal closed proposal", () => {
    expect(parsePlanProposal(raw()).ok).toBe(true);
  });

  it("rejects unknown keys instead of silently dropping them", () => {
    expect(parsePlanProposal(raw({ hiddenPrompt: "leak" })).ok).toBe(false);
  });

  it("accepts the shared staged fixture without relaxing any rule", () => {
    const result = parsePlanProposal(makeStagedPlan());
    expect(result.ok).toBe(true);
  });

  it("rejects a decision that is not an ordinary two-option decision", () => {
    const decision = {
      kind: "ordinary",
      point: { stepKey: "current", order: 2 },
      npcId: "npc_0",
      options: [branchOption("a", "loc_1")],
    };
    expect(parsePlanProposal(raw({ decision })).ok).toBe(false);
  });

  it("accepts an ordinary decision with two distinct options", () => {
    const decision = {
      kind: "ordinary",
      point: { stepKey: "current", order: 2 },
      npcId: "npc_0",
      options: [branchOption("a", "loc_1"), branchOption("b", "loc_2")],
    };
    expect(parsePlanProposal(raw({ decision })).ok).toBe(true);
  });

  it("rejects a unit depending on an unknown unit key", () => {
    expect(parsePlanProposal(raw({ units: [unit({ dependencies: ["missing"] })] })).ok).toBe(false);
  });

  it("rejects a unit depending on itself", () => {
    expect(parsePlanProposal(raw({ units: [unit({ dependencies: ["narration_1"] })] })).ok).toBe(false);
  });

  it("rejects a dependency cycle between units", () => {
    const units: readonly Unit[] = [
      unit({ key: "a", dependencies: ["b"] }),
      unit({ key: "b", dependencies: ["a"] }),
    ];
    expect(parsePlanProposal(raw({ units })).ok).toBe(false);
  });

  it("rejects duplicate unit keys", () => {
    const units: readonly Unit[] = [unit({ key: "a" }), unit({ key: "a" })];
    expect(parsePlanProposal(raw({ units })).ok).toBe(false);
  });

  it("accepts a unit whose whole dependency closure is acyclic", () => {
    const units: readonly Unit[] = [
      unit({ key: "a", dependencies: [] }),
      unit({ key: "b", dependencies: ["a"] }),
      unit({ key: "c", dependencies: ["a", "b"] }),
    ];
    expect(parsePlanProposal(raw({ units })).ok).toBe(true);
  });

  it("rejects more expression units than the cap", () => {
    const units = Array.from({ length: MAX_PLAN_UNITS + 1 }, (_, index) =>
      unit({ key: `unit_${index}`, dependencies: [] }));
    expect(parsePlanProposal(raw({ units })).ok).toBe(false);
  });

  it("rejects more consecutive steps than the bundle cap", () => {
    const steps = Array.from({ length: MAX_NARRATIVE_BUNDLE_STEPS + 1 }, (_, index) => ({
      key: `step_${index}`,
      trigger: { kind: "move", locationId: "loc_1" },
      next: [] as readonly string[],
    }));
    expect(parsePlanProposal(raw({ steps })).ok).toBe(false);
  });

  it("rejects a step successor pointing at an unknown step", () => {
    const steps = [{ key: "step_0", trigger: { kind: "move", locationId: "loc_1" }, next: ["step_9"] }];
    expect(parsePlanProposal(raw({ steps })).ok).toBe(false);
  });

  it("rejects a step with an unknown trigger kind", () => {
    const steps = [{ key: "step_0", trigger: { kind: "teleport" }, next: [] }];
    expect(parsePlanProposal(raw({ steps })).ok).toBe(false);
  });

  it("rejects a unit stage of planning", () => {
    expect(parsePlanProposal(raw({ units: [unit({ stage: "planning" as "narration" })] })).ok).toBe(false);
  });

  it("rejects an observation with an unknown key from the plan surface", () => {
    const observations = [{ key: "obs_1", point: { stepKey: "current", order: 1 }, audienceIds: ["npc_0"], fact: { factId: "fact_0", certainty: "known" }, source: { kind: "witness" } }];
    expect(parsePlanProposal(raw({ observations })).ok).toBe(true);
    expect(parsePlanProposal(raw({ observations: [{ ...observations[0]!, extra: 1 }] })).ok).toBe(false);
  });

  it("rejects an unknown terminal kind", () => {
    expect(parsePlanProposal(raw({ terminal: { kind: "cliffhanger" } })).ok).toBe(false);
  });
});
