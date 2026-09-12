import type {
  NarrativeBundleProposal,
  NarrativeNpcOutwardProposal,
} from "@/game/domain/narrativeBundle";
import type { OpeningNarrativeBundleProposal, NarrativeBundleSourceContext } from "./narrativeBundleSource";

export type CandidateReviewScope = "scene" | "proposal" | "npc_behavior";

export type CandidateDefectCode =
  | "MISSED_INPUT"
  | "UNSUPPORTED_FACT"
  | "DISCLOSURE"
  | "ACTION_MISMATCH"
  | "BROKEN_CAUSALITY";

export type CandidateDefect = Readonly<{
  readonly candidateVersion: number;
  readonly candidateHash: string;
  readonly scope: CandidateReviewScope;
  readonly code: CandidateDefectCode;
  readonly path: string;
  readonly reason: string;
}>;

export type CandidateReviewResult =
  | { readonly ok: true; readonly candidateVersion: number; readonly candidateHash: string }
  | { readonly ok: false; readonly candidateVersion: number; readonly candidateHash: string; readonly defects: readonly CandidateDefect[] }
  | { readonly ok: false; readonly candidateVersion: number; readonly candidateHash: string; readonly failure: "PROVIDER_FAILURE" | "UNCERTAIN" };

export type NarrativeCandidateReviewInput = Readonly<{
  readonly context: NarrativeBundleSourceContext;
  readonly proposal: NarrativeBundleProposal | OpeningNarrativeBundleProposal;
  readonly candidateVersion: number;
  readonly candidateHash: string;
}>;

export type NarrativeCandidateReviewer = Readonly<{
  reviewNarrativeCandidate(input: NarrativeCandidateReviewInput): Promise<CandidateReviewResult>;
}>;

/**
 * Stable, server-owned content identity. Object keys are sorted while arrays
 * retain their authored order because expression order and audience order are
 * part of the disclosure contract. The hash deliberately includes outward
 * NPC proposals instead of trusting an AI-supplied digest.
 */
export function hashNarrativeCandidate(
  proposal: NarrativeBundleProposal | OpeningNarrativeBundleProposal,
): string {
  const normalized = JSON.stringify(sortObjectKeys(proposal));
  let hash = 2166136261;
  for (const char of normalized) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `candidate_${hash.toString(16).padStart(8, "0")}`;
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => [key, sortObjectKeys(record[key])]),
  );
}

/** Approval is allowed to consume a pass only for the exact candidate it reviewed. */
export function candidateReviewMatches(
  review: Pick<CandidateReviewResult, "candidateVersion" | "candidateHash">,
  candidateVersion: number,
  candidateHash: string,
): boolean {
  return review.candidateVersion === candidateVersion && review.candidateHash === candidateHash;
}

/** Keep the type import visible to reviewers of this boundary. */
export type { NarrativeNpcOutwardProposal };
