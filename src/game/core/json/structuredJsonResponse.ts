export type StructuredJsonObjectResult =
  | {
      readonly ok: true;
      readonly value: Record<string, unknown>;
      readonly normalization: "none" | "json_fence";
    }
  | {
      readonly ok: false;
      readonly reason: "invalid_json" | "root_not_object";
    };

/**
 * Parse a provider response only when the whole response is JSON or one JSON
 * code fence. Deliberately do not search prose for an embedded object.
 */
export function parseStructuredJsonObject(text: string): StructuredJsonObjectResult {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const normalization = fenced === null ? "none" : "json_fence";

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "root_not_object" };
  }
  return {
    ok: true,
    value: parsed as Record<string, unknown>,
    normalization,
  };
}
