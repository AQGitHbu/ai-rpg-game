/**
 * Durable accounting for one narrative-generation epoch.
 *
 * The domain owns only shape and bounded transitions. Time, UUIDs and
 * persistence remain application/server concerns so a recovery worker cannot
 * silently recreate a candidate or refund a request that may have been sent.
 */

export const MAX_NARRATIVE_CANDIDATE_VERSIONS = 3 as const;
export const MAX_NARRATIVE_HTTP_ATTEMPTS = 24 as const;

export type NarrativeGenerationAttemptStatus = "idle" | "running" | "failed";

export type NarrativeGenerationAttempt = Readonly<{
  readonly epoch: number;
  /** 0 means no candidate has been reserved in this epoch. */
  readonly candidateVersion: number;
  /** Null while a reserved candidate has not returned a valid response. */
  readonly candidateHash: string | null;
  readonly leaseId: string | null;
  readonly leaseExpiresAt: string | null;
  readonly httpAttempts: number;
  readonly status: NarrativeGenerationAttemptStatus;
}>;

export type ParseNarrativeGenerationAttemptResult =
  | { readonly ok: true; readonly value: NarrativeGenerationAttempt }
  | { readonly ok: false; readonly code: "INVALID_NARRATIVE_GENERATION_ATTEMPT" };

export function createNarrativeGenerationAttempt(): NarrativeGenerationAttempt {
  return {
    epoch: 0,
    candidateVersion: 0,
    candidateHash: null,
    leaseId: null,
    leaseExpiresAt: null,
    httpAttempts: 0,
    status: "idle",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key))
    && keys.every((key) => key in value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoTimestamp(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

export function parseNarrativeGenerationAttempt(value: unknown): ParseNarrativeGenerationAttemptResult {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "epoch", "candidateVersion", "candidateHash", "leaseId", "leaseExpiresAt", "httpAttempts", "status",
  ])) {
    return { ok: false, code: "INVALID_NARRATIVE_GENERATION_ATTEMPT" };
  }
  const leasePairIsNull = value.leaseId === null && value.leaseExpiresAt === null;
  const leasePairIsPresent = isNonEmptyString(value.leaseId) && isIsoTimestamp(value.leaseExpiresAt);
  if (
    typeof value.epoch !== "number" || !Number.isInteger(value.epoch) || value.epoch < 0
    || typeof value.candidateVersion !== "number"
    || !Number.isInteger(value.candidateVersion)
    || value.candidateVersion < 0
    || value.candidateVersion > MAX_NARRATIVE_CANDIDATE_VERSIONS
    || (value.candidateVersion === 0 && value.candidateHash !== null)
    || (value.candidateHash !== null && !isNonEmptyString(value.candidateHash))
    || (!leasePairIsNull && !leasePairIsPresent)
    || (value.status === "running" && !leasePairIsPresent)
    || (value.status !== "running" && !leasePairIsNull)
    || typeof value.httpAttempts !== "number"
    || !Number.isInteger(value.httpAttempts)
    || value.httpAttempts < 0
    || value.httpAttempts > MAX_NARRATIVE_HTTP_ATTEMPTS
    || (value.status !== "idle" && value.status !== "running" && value.status !== "failed")
  ) {
    return { ok: false, code: "INVALID_NARRATIVE_GENERATION_ATTEMPT" };
  }
  return {
    ok: true,
    value: value as NarrativeGenerationAttempt,
  };
}

/** Reserve a new candidate before any provider call. The reservation is never refunded. */
export function reserveNextNarrativeCandidate(
  attempt: NarrativeGenerationAttempt,
  leaseId: string,
  leaseExpiresAt: string,
): NarrativeGenerationAttempt {
  if (attempt.candidateVersion >= MAX_NARRATIVE_CANDIDATE_VERSIONS) {
    throw new RangeError("candidate versions exhausted");
  }
  if (!isNonEmptyString(leaseId) || !isIsoTimestamp(leaseExpiresAt)) {
    throw new RangeError("candidate reservation requires a valid lease");
  }
  return {
    ...attempt,
    candidateVersion: attempt.candidateVersion + 1,
    candidateHash: null,
    leaseId,
    leaseExpiresAt,
    status: "running",
  };
}

/** A manual retry starts a fresh budget epoch while retaining the same job id. */
export function advanceNarrativeGenerationEpoch(
  attempt: NarrativeGenerationAttempt,
): NarrativeGenerationAttempt {
  return {
    epoch: attempt.epoch + 1,
    candidateVersion: 0,
    candidateHash: null,
    leaseId: null,
    leaseExpiresAt: null,
    httpAttempts: 0,
    status: "idle",
  };
}
