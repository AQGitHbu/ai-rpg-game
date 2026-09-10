import { describe, expect, it } from "vitest";
import type { NarrativeBundleTerminal } from "@/game/domain/narrativeBundle";
import type {
  BundleDescriptorGraph,
  BundleStepDescriptor,
} from "./descriptors";
import { validateNarrativeBundleCoverage, validateStagedReadyCoverage } from "./coverage";
import type { PreparedChoiceCandidate } from "@/game/gameplay/rpg/preparedContinuation/candidates";

function step(overrides: Partial<BundleStepDescriptor> & { stepKey: string }): BundleStepDescriptor {
  return {
    objectiveKey: `obj:${overrides.stepKey}`,
    consumptionGroupKey: `grp:${overrides.stepKey}`,
    trigger: { kind: "move", locationId: "loc_1" as never },
    absorbedObjectiveIndexes: [],
    authority: {
      questId: "quest_1" as never,
      allowedEntityIds: [],
      visibleFactIds: [],
      objectiveIndex: 0,
    },
    choiceCandidates: [],
    nextStepKeys: [],
    ...overrides,
  } as unknown as BundleStepDescriptor;
}

function choice(candidateId: string): PreparedChoiceCandidate {
  return {
    candidateId,
    action: { type: "talk", npcId: "npc_1" as never, dialogueAct: "support" } as never,
  } as unknown as PreparedChoiceCandidate;
}

function graph(
  steps: readonly BundleStepDescriptor[],
  activeStepKeys: readonly string[],
  terminal: NarrativeBundleTerminal,
  currentChoiceCandidates: readonly PreparedChoiceCandidate[] = [],
): BundleDescriptorGraph {
  return { steps, activeStepKeys, currentChoiceCandidates, terminal };
}

const terminalStep = { kind: "next_decision" as const, target: { kind: "continuation_step" as const, stepKey: "leaf" } };
const twoChoices: readonly PreparedChoiceCandidate[] = [choice("c1"), choice("c2")];

describe("validateNarrativeBundleCoverage", () => {
  it("passes for a valid continuation_step terminal with two choices", () => {
    const g = graph(
      [step({ stepKey: "leaf", choiceCandidates: twoChoices })],
      ["leaf"],
      terminalStep,
    );
    expect(validateNarrativeBundleCoverage(g)).toEqual({ ok: true });
  });

  it("passes for an empty graph with current_scene terminal and two current choices", () => {
    const g = graph([], [], { kind: "next_decision", target: { kind: "current_scene" } }, twoChoices);
    expect(validateNarrativeBundleCoverage(g)).toEqual({ ok: true });
  });

  it("passes for an ending terminal with empty graph", () => {
    const g = graph([], [], { kind: "ending" });
    expect(validateNarrativeBundleCoverage(g)).toEqual({ ok: true });
  });

  it("rejects unknown edges (missing successor)", () => {
    const g = graph(
      [step({ stepKey: "a", nextStepKeys: ["ghost"] })],
      ["a"],
      terminalStep,
    );
    expect(validateNarrativeBundleCoverage(g)).toEqual({ ok: false, code: "unknown_edge" });
  });

  it("rejects cycles", () => {
    const g = graph(
      [
        step({ stepKey: "a", nextStepKeys: ["b"] }),
        step({ stepKey: "b", nextStepKeys: ["a"] }),
      ],
      ["a"],
      terminalStep,
    );
    expect(validateNarrativeBundleCoverage(g)).toEqual({ ok: false, code: "cycle" });
  });

  it("rejects graphs exceeding 12 steps", () => {
    const many: readonly BundleStepDescriptor[] = Array.from({ length: 13 }, (_, i) =>
      step({ stepKey: `s${i}`, choiceCandidates: i === 12 ? twoChoices : [], nextStepKeys: [] }),
    );
    const g = graph(many, ["s0"], terminalStep);
    expect(validateNarrativeBundleCoverage(g)).toEqual({ ok: false, code: "step_limit_exceeded" });
  });

  it("rejects unreachable steps", () => {
    const g = graph(
      [
        step({ stepKey: "a", choiceCandidates: twoChoices }),
        step({ stepKey: "orphan", choiceCandidates: twoChoices }),
      ],
      ["a"],
      terminalStep,
    );
    expect(validateNarrativeBundleCoverage(g)).toEqual({ ok: false, code: "unreachable_step" });
  });

  it("rejects a leaf that is not the declared terminal", () => {
    const g = graph(
      [
        step({ stepKey: "a", nextStepKeys: ["b"] }),
        step({ stepKey: "b", choiceCandidates: twoChoices }),
        step({ stepKey: "c", choiceCandidates: twoChoices }),
      ],
      ["a", "c"],
      { kind: "next_decision", target: { kind: "continuation_step", stepKey: "b" } },
    );
    // "c" is a leaf but not the terminal "b"
    expect(validateNarrativeBundleCoverage(g)).toEqual({ ok: false, code: "missing_terminal" });
  });

  it("rejects a terminal step with only one choice", () => {
    const g = graph(
      [step({ stepKey: "leaf", choiceCandidates: [choice("c1")] })],
      ["leaf"],
      terminalStep,
    );
    expect(validateNarrativeBundleCoverage(g)).toEqual({ ok: false, code: "invalid_terminal_choice_count" });
  });

  it("rejects a terminal step with three choices", () => {
    const g = graph(
      [step({ stepKey: "leaf", choiceCandidates: [choice("c1"), choice("c2"), choice("c3")] })],
      ["leaf"],
      terminalStep,
    );
    expect(validateNarrativeBundleCoverage(g)).toEqual({ ok: false, code: "invalid_terminal_choice_count" });
  });

  it("rejects ending terminal with executable steps", () => {
    const g = graph(
      [step({ stepKey: "a", choiceCandidates: twoChoices })],
      ["a"],
      { kind: "ending" },
    );
    expect(validateNarrativeBundleCoverage(g)).toEqual({ ok: false, code: "executable_after_ending" });
  });

  it("rejects current_scene terminal with continuation steps", () => {
    const g = graph(
      [step({ stepKey: "a", choiceCandidates: twoChoices })],
      ["a"],
      { kind: "next_decision", target: { kind: "current_scene" } },
    );
    expect(validateNarrativeBundleCoverage(g)).toEqual({ ok: false, code: "missing_terminal" });
  });

  it("rejects current_scene terminal with fewer than two current choices", () => {
    const g = graph(
      [],
      [],
      { kind: "next_decision", target: { kind: "current_scene" } },
      [choice("c1")],
    );
    expect(validateNarrativeBundleCoverage(g)).toEqual({ ok: false, code: "invalid_terminal_choice_count" });
  });

  it("rejects continuation_step terminal when the step does not exist", () => {
    const g = graph(
      [step({ stepKey: "a", choiceCandidates: twoChoices })],
      ["a"],
      { kind: "next_decision", target: { kind: "continuation_step", stepKey: "nonexistent" } },
    );
    expect(validateNarrativeBundleCoverage(g)).toEqual({ ok: false, code: "missing_terminal" });
  });
});

describe("validateStagedReadyCoverage", () => {
  const narration = {
    key: "narration_current", stage: "narration" as const, speakerId: null,
    dependencies: [], taskFactIds: [], requiredObservationKeys: [], requiredBeats: [],
    point: { stepKey: "current", order: 1 },
  };
  const choices = {
    ...narration, key: "choices_current", stage: "choices" as const,
    point: { stepKey: "current", order: 2 },
  };

  it("全部单元已批准时通过", () => {
    expect(validateStagedReadyCoverage({
      units: [narration, choices],
      approvedKeys: new Set(["narration_current", "choices_current"]),
      terminalKind: "next_decision",
    })).toEqual({ ok: true });
  });

  it("有单元未批准时拒绝", () => {
    expect(validateStagedReadyCoverage({
      units: [narration, choices],
      approvedKeys: new Set(["narration_current"]),
      terminalKind: "next_decision",
    })).toEqual({ ok: false, code: "ready_unit_not_approved" });
  });

  it("空计划拒绝", () => {
    expect(validateStagedReadyCoverage({
      units: [], approvedKeys: new Set(), terminalKind: "next_decision",
    })).toEqual({ ok: false, code: "ready_unit_missing" });
  });

  it("终幕包缺 choices 单元时拒绝——终幕立场失败阻止整个终幕包发布", () => {
    expect(validateStagedReadyCoverage({
      units: [narration],
      approvedKeys: new Set(["narration_current"]),
      terminalKind: "ending",
    })).toEqual({ ok: false, code: "ending_choices_missing" });
  });

  it("终幕包 choices 单元未批准时拒绝", () => {
    expect(validateStagedReadyCoverage({
      units: [narration, choices],
      approvedKeys: new Set(["narration_current"]),
      terminalKind: "ending",
    })).toEqual({ ok: false, code: "ending_choices_not_approved" });
  });

  it("场景缺旁白单元时拒绝", () => {
    expect(validateStagedReadyCoverage({
      units: [{ ...choices, key: "character_only", stage: "character" as const, speakerId: "npc_0" }],
      approvedKeys: new Set(["character_only"]),
      terminalKind: "next_decision",
    })).toEqual({ ok: false, code: "scene_narration_missing" });
  });
});
