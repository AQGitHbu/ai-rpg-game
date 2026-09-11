import { createHash } from "node:crypto";

/** Persisted plan/output parsers may reorder object fields; candidate and unit array order remains significant. */
export function narrativeInputDigest(input: unknown): string {
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value)
      .filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, v]) => [key, canonical(v)]));
    return value;
  }
  return createHash("sha256").update(JSON.stringify(canonical(input))).digest("hex");
}
