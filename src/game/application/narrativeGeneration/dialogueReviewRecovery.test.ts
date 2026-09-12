import { expect, it } from "vitest";
import { prepareReviewAttempt, reviewOutcome } from "./dialogueReviewRecovery";
import { isStoredDialogueReview } from "./dialogueConsistencyReview";
import { isStoredPlanningDialogueReviews } from "./planningDialogueReview";
import { compileDialogueReviewChecks, validateDialogueReviewVerdict, reviewProtocolDetail } from "./dialogueReviewChecks";
import { realReviewSubjects } from "./dialogueReviewRealFailures.testutil";
import type { StoredJob } from "../server/persistence/narrativeJobRepository";
import { createAiSourceFailure } from "../aiGenerationRetry";
const base: NonNullable<StoredJob["dialogueConsistencyReview"]> = { version: 1, cycle: 0,
  inputDigest: "a".repeat(64), attempts: 1, status: "failed", protocolCorrections: 0, contentRepairs: 0,
  lastFailure: "protocol_error", protocolIssue: { code: "unknown_checkId", path: "$.violations[0].checkId" } };
it("same-cycle changed digest and restarted correction never restore allowance", () => {
  const first = prepareReviewAttempt(base);
  if (!first.ok) throw Error(first.code);
  expect(first.receipt).toMatchObject({ attempts: 2, protocolCorrections: 1 });
  for (const status of ["running", "unknown", "failed"] as const) {
    expect(prepareReviewAttempt({ ...first.receipt, inputDigest: "b".repeat(64), status }).ok).toBe(false);
  }
  expect(prepareReviewAttempt({ ...first.receipt, status: "failed", lastFailure: "content_recheck", contentRepairs: 1 }))
    .toMatchObject({ ok: true, receipt: { attempts: 3, protocolCorrections: 1, contentRepairs: 1 } });
});
it("legacy nonzero receipts cannot acquire new correction or content allowances", () => {
  const { protocolCorrections: _p, contentRepairs: _c, ...legacy } = base;
  expect(isStoredDialogueReview(legacy)).toBe(true);
  expect(prepareReviewAttempt(legacy).ok).toBe(false);
});
it.each([
  { protocolCorrections: -1 }, { contentRepairs: 2 }, { protocolCorrections: undefined },
  { attempts: 3, protocolCorrections: 0, contentRepairs: 0 },
  { protocolIssue: { code: "private_secret", path: "$" } },
  { protocolIssue: { code: "invalid_schema", path: "$.private_secret_key" } },
  { lastFailure: "model_instruction" },
])("invalid durable counters or diagnostics rejected by both receipt schemas: %j", patch => {
  const receipt = { ...base, ...patch };
  expect(isStoredDialogueReview(receipt)).toBe(false);
  expect(isStoredPlanningDialogueReviews({ unit: receipt })).toBe(false);
});
it("unknown check, foreign inquiry, duplicate plan witnesses have safe actionable paths", () => {
  const request = compileDialogueReviewChecks(realReviewSubjects.unknown).request;
  const plan = request.checks.find(c => c.kind === "plan_answer")!;
  const witness = { checkId: plan.checkId, type: "missing_response", inquiryId: plan.inquiries[0]!.inquiryId };
  const cases = [
    { violations: [{ ...witness, checkId: "PRIVATE_VALUE" }], code: "unknown_checkId", path: "checkId" },
    { violations: [{ ...witness, inquiryId: "PRIVATE_VALUE" }], code: "foreign_inquiryId", path: "inquiryId" },
    { violations: [witness, witness], code: "duplicate_plan_checkId", path: "checkId" },
    { violations: [{ ...witness, PRIVATE_KEY: "PRIVATE_VALUE" }], code: "invalid_schema", path: "violations" },
  ];
  for (const sample of cases) {
    const result = validateDialogueReviewVerdict({ verdict: "reject", violations: sample.violations }, request);
    if (result.ok) throw Error("expected invalid");
    expect(result.issue.code).toBe(sample.code);
    expect(result.issue.path).toContain(sample.path);
    expect(reviewProtocolDetail(result.issue)).not.toContain("PRIVATE");
  }
});
it("provider diagnostic is distinct and arbitrary source detail never becomes feedback", () => {
  const request = compileDialogueReviewChecks(realReviewSubjects.unknown).request;
  expect(reviewOutcome(createAiSourceFailure("scene", "transport", "provider_failure", "network_error"), request))
    .toEqual({ verdict: null, failure: "provider_failure" });
  const invalid = reviewOutcome(createAiSourceFailure("scene", "invalid_schema", "invalid_schema", "PRIVATE_INSTRUCTION"), request);
  expect(JSON.stringify(invalid)).not.toContain("PRIVATE");
  expect(invalid).toMatchObject({ failure: "protocol_error", issue: { code: "invalid_schema", path: "$" } });
});
