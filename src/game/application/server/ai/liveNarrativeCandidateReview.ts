import type { AiMessage } from "@ai-game/ai-transport";
import { parseStructuredJsonObject } from "@/game/core/json";
import type { GameLogger } from "@/game/logging";
import { candidateReviewMatches, type CandidateDefect, type CandidateDefectCode, type CandidateReviewResult, type CandidateReviewScope, type NarrativeCandidateReviewer } from "../../narrativeCandidateReview";
import type { NarrativeCandidateReviewInput } from "../../narrativeCandidateReview";
import type { RpgAiClient } from "./rpgAiClient";
import type { NarrativeRequestClient } from "./narrativeRequestClient";
import { compileDecisionNarrativeContext } from "./narrativeContext";

export type LiveNarrativeCandidateReviewDeps = Readonly<{
  readonly aiClient?: RpgAiClient;
  readonly requestClient?: NarrativeRequestClient;
  readonly logger?: GameLogger;
}>;

const SCOPES: readonly CandidateReviewScope[] = ["scene", "proposal", "npc_behavior"];
const CODES: readonly CandidateDefectCode[] = [
  "MISSED_INPUT", "UNSUPPORTED_FACT", "DISCLOSURE", "ACTION_MISMATCH", "BROKEN_CAUSALITY",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseDefects(
  value: unknown,
  input: NarrativeCandidateReviewInput,
): readonly CandidateDefect[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const defects: CandidateDefect[] = [];
  for (const entry of value) {
    if (!isRecord(entry)
      || !hasOnlyKeys(entry, ["scope", "code", "path", "reason"])
      || !SCOPES.includes(entry.scope as CandidateReviewScope)
      || !CODES.includes(entry.code as CandidateDefectCode)
      || !isNonEmptyString(entry.path)
      || !isNonEmptyString(entry.reason)) {
      return null;
    }
    defects.push({
      candidateVersion: input.candidateVersion,
      candidateHash: input.candidateHash,
      scope: entry.scope as CandidateReviewScope,
      code: entry.code as CandidateDefectCode,
      path: entry.path,
      reason: entry.reason,
    });
  }
  return defects;
}

function parseReviewVerdict(
  value: unknown,
  input: NarrativeCandidateReviewInput,
): { readonly pass: true } | { readonly pass: false; readonly defects: readonly CandidateDefect[] } | null {
  if (!isRecord(value)) return null;
  const review = isRecord(value.review) && hasOnlyKeys(value, ["review"]) ? value.review : value;
  if (!isRecord(review)) return null;
  if (review.verdict === "pass" && hasOnlyKeys(review, ["verdict"])) return { pass: true };
  if (review.verdict === "revise" && hasOnlyKeys(review, ["verdict", "defects"])) {
    const defects = parseDefects(review.defects, input);
    return defects === null ? null : { pass: false, defects };
  }
  if (hasOnlyKeys(review, ["defects"])) {
    const defects = parseDefects(review.defects, input);
    return defects === null ? null : { pass: false, defects };
  }
  return null;
}

function reviewJobMetadata(input: NarrativeCandidateReviewInput): { readonly jobId?: string; readonly gameId?: string; readonly actionId?: string; readonly turnNumber?: number } {
  if (input.context.kind === "opening") {
    return {
      jobId: String(input.context.jobId),
      ...(input.context.auditLink?.gameId === undefined ? {} : { gameId: input.context.auditLink.gameId }),
    };
  }
  return {
    jobId: String(input.context.job.jobId),
    ...(input.context.auditLink?.gameId === undefined ? {} : { gameId: input.context.auditLink.gameId }),
    actionId: input.context.job.actionId,
    turnNumber: input.context.job.turnNumber,
  };
}

function resultFailure(input: NarrativeCandidateReviewInput, failure: "PROVIDER_FAILURE" | "UNCERTAIN"): CandidateReviewResult {
  return {
    ok: false,
    candidateVersion: input.candidateVersion,
    candidateHash: input.candidateHash,
    failure,
  };
}

function publicReviewContext(input: NarrativeCandidateReviewInput): unknown {
  if (input.context.kind === "opening") {
    const { signal: _signal, reserveHttpAttempt: _reserveHttpAttempt, ...openingInput } = input.context.input;
    return {
      kind: "opening",
      jobId: input.context.jobId,
      candidateVersion: input.context.candidateVersion,
      input: openingInput,
    };
  }
  const compilation = compileDecisionNarrativeContext({
    worldState: input.context.worldState,
    storyState: input.context.storyState,
    job: input.context.job,
    ...(input.context.contentRepair === undefined ? {} : { contentRepair: input.context.contentRepair }),
  });
  return {
    kind: "decision",
    candidateVersion: input.context.candidateVersion,
    prompt: compilation.prompt,
    manifest: compilation.manifest,
  };
}

export function createLiveNarrativeCandidateReview(
  deps: LiveNarrativeCandidateReviewDeps = {},
): NarrativeCandidateReviewer {
  return {
    async reviewNarrativeCandidate(input): Promise<CandidateReviewResult> {
      if (deps.aiClient === undefined) return resultFailure(input, "PROVIDER_FAILURE");
      try {
        const metadata = reviewJobMetadata(input);
        const messages: readonly AiMessage[] = [
          {
            role: "system",
            content: [
              "你是 RPG 整场候选的逻辑语义审阅器。",
              "只检查当前输入是否被回应、事实依据、实际受众披露、选项动作与正文因果。",
              "不得改写候选、补造事实、授予知识或输出思维链。",
              "只返回 JSON：通过为 {\"verdict\":\"pass\"}，需修订为 {\"verdict\":\"revise\",\"defects\":[{\"scope\",\"code\",\"path\",\"reason\"}]}。",
            ].join("\n"),
          },
          {
            role: "user",
            content: JSON.stringify({
              candidateVersion: input.candidateVersion,
              candidateHash: input.candidateHash,
              context: publicReviewContext(input),
              proposal: input.proposal,
            }),
          },
        ];
        const auditContext = {
          purpose: "narrative_candidate_review",
          trigger: "narrative_candidate_review",
          revision: input.candidateVersion,
          ...metadata,
        } as const;
        const result = deps.requestClient === undefined
          ? await deps.aiClient.complete("narrative_bundle", messages, auditContext)
          : await deps.requestClient.completeNarrativeRequest({
              purpose: "review",
              messages,
              auditContext,
              signal: input.context.signal ?? new AbortController().signal,
              ...(input.context.reserveHttpAttempt === undefined ? {} : { reserveHttpAttempt: input.context.reserveHttpAttempt }),
            });
        if (!result.ok) return resultFailure(input, "PROVIDER_FAILURE");
        const parsed = parseStructuredJsonObject(result.content);
        if (!parsed.ok) return resultFailure(input, "UNCERTAIN");
        const verdict = parseReviewVerdict(parsed.value, input);
        if (verdict === null) return resultFailure(input, "UNCERTAIN");
        if (verdict.pass) {
          return { ok: true, candidateVersion: input.candidateVersion, candidateHash: input.candidateHash };
        }
        return {
          ok: false,
          candidateVersion: input.candidateVersion,
          candidateHash: input.candidateHash,
          defects: verdict.defects,
        };
      } catch (error) {
        deps.logger?.warn("narrative_candidate_review_failed", {
          error: error instanceof Error ? error.message : "unknown",
        });
        return resultFailure(input, "PROVIDER_FAILURE");
      }
    },
  };
}

export { candidateReviewMatches };
