import { parsePlanProposal, type PlanProposal } from "./narrativePlan";
import { fail, hasOnlyKeys, isPlainRecord, parseUnitOutput, type Check } from "./narrativeUnit";

/** A strict mechanical wire adapter. Never infers references or creates missing prose. */
export function parseLiveDraftPlan(raw: unknown): Check<PlanProposal> {
  if (!isPlainRecord(raw) || !Array.isArray(raw.units)) return fail("plan_units_invalid");
  if (raw.opening !== null && raw.opening !== undefined
    && (!isPlainRecord(raw.opening) || !isPlainRecord(raw.opening.player)
      || !Object.hasOwn(raw.opening.player, "knownFactKeys"))) return fail("opening_player_known_facts_missing");
  const units: Record<string, unknown>[] = [];
  for (const unit of raw.units) {
    if (!isPlainRecord(unit) || Object.hasOwn(unit, "task") || Object.hasOwn(unit, "taskFactIds"))
      return fail("plan_duplicate_content");
    const draft = parseUnitOutput(unit.draft);
    if (!draft.ok) return fail("plan_draft_invalid");
    if (draft.value.stage !== unit.stage || (draft.value.stage === "character" && draft.value.speakerId !== unit.speakerId))
      return fail("plan_draft_identity_mismatch");
    units.push({ ...unit, draft: draft.value, taskFactIds: draft.value.stage === "choices" ? []
      : [...new Set(draft.value.parts.flatMap(part => part.facts.map(fact => fact.factId)))] });
  }
  let decision = raw.decision;
  const choices = units.filter(unit => unit.stage === "choices");
  if (choices.length !== 1) return fail("plan_draft_choices_invalid");
  const draft = parseUnitOutput(choices[0]!.draft);
  if (!draft.ok || draft.value.stage !== "choices") return fail("plan_draft_choices_invalid");
  const labels = draft.value.labels;
  if (isPlainRecord(decision)) {
    if (!Array.isArray(decision.options)) return fail("decision_options_count_invalid");
    const options: Record<string, unknown>[] = [];
    for (const option of decision.options) {
      if (!isPlainRecord(option) || Object.hasOwn(option, "task") || !isPlainRecord(option.publicIntent)
        || !hasOnlyKeys(option.publicIntent, ["facts", "evidence", "beatIds"])) return fail("plan_duplicate_content");
      const matched = labels.filter(label => label.candidateId === option.candidateId);
      if (matched.length !== 1) return fail("plan_draft_candidate_mismatch");
      options.push({ ...option, publicIntent: { ...option.publicIntent, text: matched[0]!.label } });
    }
    if (options.length !== labels.length) return fail("plan_draft_candidate_mismatch");
    decision = { ...decision, options };
  } else if (!isPlainRecord(raw.terminal) || raw.terminal.kind !== "ending"
    || labels[0]?.candidateId !== "trust" || labels[1]?.candidateId !== "doubt") return fail("plan_draft_candidate_mismatch");
  return parsePlanProposal({ ...raw, units, decision });
}
