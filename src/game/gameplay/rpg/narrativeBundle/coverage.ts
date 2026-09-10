import type { BundleDescriptorGraph } from "./descriptors";
import type { Unit } from "@/game/domain/narrativeUnit";

export type BundleCoverageErrorCode =
  | "step_limit_exceeded"
  | "cycle"
  | "unknown_edge"
  | "unreachable_step"
  | "missing_terminal"
  | "invalid_terminal_choice_count"
  | "executable_after_ending";

export type BundleCoverageResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: BundleCoverageErrorCode };

import { MAX_NARRATIVE_BUNDLE_STEPS } from "@/game/domain/narrativeBundle";

// ---------------------------------------------------------------------------
// 分阶段生成的 ready coverage（Plan 2026-09-09 / Task 9）
// ---------------------------------------------------------------------------

export type StagedCoverageErrorCode =
  | "ready_unit_missing"
  | "ready_unit_not_approved"
  | "scene_narration_missing"
  | "ending_choices_missing"
  | "ending_choices_not_approved";

export type StagedReadyCoverageResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: StagedCoverageErrorCode };

/**
 * 发布前的最后一道覆盖校验：计划里的每个表达单元都必须已批准，每个场景
 * 至少有一段旁白，终幕包的 choices 单元计入必需单元——它失败即阻止整个
 * 终幕包发布（没有安全语义的终幕立场就不能进终幕）。
 */
export function validateStagedReadyCoverage(input: Readonly<{
  units: readonly Unit[];
  approvedKeys: ReadonlySet<string>;
  terminalKind: "ending" | "next_decision";
}>): StagedReadyCoverageResult {
  const { units, approvedKeys } = input;
  if (units.length === 0) return { ok: false, code: "ready_unit_missing" };
  // 终幕包先查：终幕立场单元失败要给出专属码，它阻止的是整个终幕包发布。
  if (input.terminalKind === "ending") {
    const endingChoices = units.filter((unit) => unit.stage === "choices");
    if (endingChoices.length === 0) return { ok: false, code: "ending_choices_missing" };
    if (!endingChoices.every((unit) => approvedKeys.has(unit.key))) {
      return { ok: false, code: "ending_choices_not_approved" };
    }
  }
  for (const unit of units) {
    if (!approvedKeys.has(unit.key)) return { ok: false, code: "ready_unit_not_approved" };
  }
  const narratedSteps = new Set(
    units.filter((unit) => unit.stage === "narration").map((unit) => unit.point.stepKey),
  );
  const allSteps = new Set(units.map((unit) => unit.point.stepKey));
  for (const stepKey of allSteps) {
    if (!narratedSteps.has(stepKey)) return { ok: false, code: "scene_narration_missing" };
  }
  return { ok: true };
}

/**
 * Validates that every reachable leaf in the descriptor graph is either a
 * next-decision boundary or an ending, and that the terminal declaration
 * matches the graph topology.
 */
export function validateNarrativeBundleCoverage(
  graph: BundleDescriptorGraph,
): BundleCoverageResult {
  const steps = graph.steps;
  if (steps.length === 0) {
    const terminal = graph.terminal;
    // Empty graph with ending terminal is valid
    if (terminal.kind === "ending") {
      return { ok: true };
    }
    // Empty graph with current_scene terminal requires exactly two current choices
    if (terminal.kind === "next_decision" && terminal.target.kind === "current_scene") {
      if (graph.currentChoiceCandidates.length !== 2) {
        return { ok: false, code: "invalid_terminal_choice_count" };
      }
      return { ok: true };
    }
    return { ok: false, code: "missing_terminal" };
  }

  // Step limit
  if (steps.length > MAX_NARRATIVE_BUNDLE_STEPS) {
    return { ok: false, code: "step_limit_exceeded" };
  }

  const byKey = new Map(steps.map((s) => [s.stepKey, s]));
  const allKeys = new Set(steps.map((s) => s.stepKey));

  // Unknown edges
  for (const step of steps) {
    for (const nextKey of step.nextStepKeys) {
      if (!allKeys.has(nextKey)) {
        return { ok: false, code: "unknown_edge" };
      }
    }
  }

  // Cycle detection
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string): boolean => {
    if (visiting.has(key)) return false;
    if (visited.has(key)) return true;
    visiting.add(key);
    const step = byKey.get(key);
    if (step === undefined) return true;
    if (!step.nextStepKeys.every(visit)) return false;
    visiting.delete(key);
    visited.add(key);
    return true;
  };
  if (!steps.every((s) => visit(s.stepKey))) {
    return { ok: false, code: "cycle" };
  }

  // Find leaves (steps with no successors)
  const leaves = steps.filter((s) => s.nextStepKeys.length === 0);

  // Reachability from active roots
  const reachable = new Set<string>();
  const reach = (key: string): void => {
    if (reachable.has(key)) return;
    reachable.add(key);
    const step = byKey.get(key);
    if (step === undefined) return;
    step.nextStepKeys.forEach(reach);
  };
  graph.activeStepKeys.forEach(reach);

  // Unreachable steps
  for (const step of steps) {
    if (!reachable.has(step.stepKey)) {
      return { ok: false, code: "unreachable_step" };
    }
  }

  // Terminal validation
  const terminal = graph.terminal;

  if (terminal.kind === "ending") {
    // No executable steps allowed after ending (empty graph handled above)
    return { ok: false, code: "executable_after_ending" };
  }

  if (terminal.kind === "next_decision" && terminal.target.kind === "current_scene") {
    // Non-empty graph with current_scene terminal is invalid
    return { ok: false, code: "missing_terminal" };
  }

  if (terminal.kind === "next_decision" && terminal.target.kind === "continuation_step") {
    // The terminal step must exist
    if (!allKeys.has(terminal.target.stepKey)) {
      return { ok: false, code: "missing_terminal" };
    }
    // The terminal step must be a leaf with exactly two choices for one focus NPC
    const terminalStep = byKey.get(terminal.target.stepKey);
    if (terminalStep === undefined) {
      return { ok: false, code: "missing_terminal" };
    }
    if (terminalStep.choiceCandidates.length !== 2) {
      return { ok: false, code: "invalid_terminal_choice_count" };
    }
    // Every reachable leaf must be the declared terminal
    for (const leaf of leaves) {
      if (leaf.stepKey !== terminal.target.stepKey) {
        return { ok: false, code: "missing_terminal" };
      }
    }
  }

  return { ok: true };
}
