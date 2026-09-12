import { expect, it } from "vitest";
import { compileDialogueReviewChecks, validateDialogueReviewVerdict } from "./dialogueReviewChecks";
import { semanticReviewSamples } from "./dialogueReviewSemanticFailures.testutil";

it("planning excludes expression and selected checks even when subjects already have text", () => {
  const subjects = semanticReviewSamples.flatMap(s => s.subjects).map(s => ({ ...s, text: s.brief!,
    selected: { label: "历史原话", historicalChoice: true, contract: null } }));
  const compiled = compileDialogueReviewChecks(subjects, "planning");
  expect(compiled.request.checks).toHaveLength(subjects.length);
  expect(compiled.request.checks.every(c => c.kind.startsWith("plan_"))).toBe(true);
  expect(compiled.request.checks.every(c => c.text === undefined)).toBe(true);
  expect([...compiled.routes.values()].every(r => r.scope === "planning")).toBe(true);
});

it.each(["planning", "expression"] as const)("%s never routes NPC questions as extra player inquiries", phase => {
  const subject = semanticReviewSamples[0]!.subjects[0]!;
  const { request } = compileDialogueReviewChecks([{ ...subject, text: subject.brief! }], phase);
  const check = request.checks[0]!;
  const verdict = { verdict: "reject", violations: [{ checkId: check.checkId, type: "extra_inquiry",
    inquiryId: check.inquiryTargets.find(q => q.aspect === "cause")!.inquiryId }] };
  expect(validateDialogueReviewVerdict(verdict, request)).toEqual({ ok: false,
    issue: { code: "invalid_type", path: "$.violations[0].type" } });
  expect(validateDialogueReviewVerdict({ verdict: "reject", violations: [{ checkId: check.checkId,
    type: "intent_mismatch", inquiryId: null }] }, request).ok).toBe(true);
});

it.each(["missing_response", "answer_mismatch"])("NPC %s still enforces already asked dimensions", type => {
  const subject = semanticReviewSamples[0]!.subjects[0]!;
  const { request } = compileDialogueReviewChecks([{ ...subject, text: "不清楚来源。",
    inquiries: [{ factId: "fact_1", aspects: ["source"] }],
    answers: [{ factId: "fact_1", aspect: "source", outcome: "unknown", answerFactIds: [] }] }]);
  for (const check of request.checks) {
    const verdict = (inquiryId: string) => ({ verdict: "reject", violations: [{ checkId: check.checkId, type, inquiryId }] });
    expect(validateDialogueReviewVerdict(verdict(check.inquiries[0]!.inquiryId), request).ok).toBe(true);
    expect(validateDialogueReviewVerdict(verdict(check.inquiryTargets.find(q => q.aspect === "time")!.inquiryId), request).ok).toBe(false);
  }
});

it("original safe samples preserve their questions and facts without adjacent-dimension padding", () => {
  for (const sample of semanticReviewSamples) {
    const { request } = compileDialogueReviewChecks(sample.subjects, sample.phase);
    expect(sample.source).toContain("tmp/staged-final-retest-20260912/");
    for (const aspect of sample.unsupportedAspects)
      expect(request.checks[0]!.inquiries.map(q => q.aspect)).not.toContain(aspect);
    expect(request.checks[0]!.facts).toEqual(sample.subjects[0]!.facts);
    expect(JSON.stringify(request)).not.toMatch(/jobId|inputDigest|unitKey|candidateId|apiKey/);
  }
  expect(semanticReviewSamples.filter(s => s.ambiguity !== null).map(s => s.id))
    .toEqual(["investigation_occurrence", "signal_origin"]);
});

it("an inquiry address grants neither another check's answer obligation nor its facts", () => {
  const subjects = [semanticReviewSamples[0]!.subjects[0]!, semanticReviewSamples[3]!.subjects[0]!];
  const { request } = compileDialogueReviewChecks(subjects, "planning");
  const [answer, option] = request.checks;
  expect(answer!.inquiries).toEqual([]);
  expect(answer!.facts).toEqual(subjects[0]!.facts);
  expect(answer!.facts.some(f => f.text.includes("加密求救信号"))).toBe(false);
  expect(validateDialogueReviewVerdict({ verdict: "reject", violations: [{ checkId: answer!.checkId,
    type: "missing_response", inquiryId: option!.inquiries[0]!.inquiryId }] }, request))
    .toEqual({ ok: false, issue: { code: "foreign_inquiryId", path: "$.violations[0].inquiryId" } });
});
