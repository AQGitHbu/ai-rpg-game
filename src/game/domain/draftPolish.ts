import { fail, hasOnlyKeys, isPlainRecord, parseUnitOutput, type Check, type UnitOutput } from "./narrativeUnit";

/** Only text is provider-owned. All reference and action metadata stays with its draft part. */
export function applyPolish(draft: UnitOutput, payload: unknown): Check<UnitOutput> {
  if (!isPlainRecord(payload)) return fail("polish_payload_invalid");
  if (draft.stage === "choices") {
    if (!hasOnlyKeys(payload, ["labels"])) return fail("polish_payload_invalid");
    const parsed = parseUnitOutput({ stage: "choices", labels: payload.labels });
    if (!parsed.ok || parsed.value.stage !== "choices") return parsed;
    if (parsed.value.labels.some((label, i) => label.candidateId !== draft.labels[i]?.candidateId))
      return fail("polish_candidate_mismatch");
    return parsed;
  }
  if (!hasOnlyKeys(payload, ["texts"]) || !Array.isArray(payload.texts)
    || payload.texts.length !== draft.parts.length || payload.texts.some(text => typeof text !== "string"))
    return fail("polish_texts_invalid");
  const texts = payload.texts;
  return parseUnitOutput({ ...draft, parts: draft.parts.map((part, i) => ({ ...part, text: texts[i] })) });
}
