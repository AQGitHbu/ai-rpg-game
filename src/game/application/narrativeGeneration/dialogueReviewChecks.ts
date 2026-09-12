import { INQUIRY_ASPECTS, type ExpressionTask, type InquiryAspect } from "@/game/domain/expressionTask";
import type { SafeContext } from "./perspectiveContext";
import type { DialogueConsistencyVerdict, DialogueViolation } from "./dialogueConsistencyReview";

export type ReviewContract = Readonly<{ intent: string | null; brief?: string | null;
  inquiries: NonNullable<ExpressionTask["inquiries"]>; prerequisiteFactIds?: readonly string[] }>;
/** Already projected authorized content. Routing fields never enter the wire request. */
export type DialogueReviewSubject = Readonly<{
  unitKey: string; candidateId?: string; kind: "answer" | "option";
  intent: string | null; brief: string | null; inquiries: NonNullable<ExpressionTask["inquiries"]>;
  answers: NonNullable<ExpressionTask["answers"]>; prerequisiteFactIds: readonly string[];
  topicFactIds: readonly string[]; facts: SafeContext["visibleFacts"];
  text?: string; selected?: Readonly<{ label: string; historicalChoice: boolean; contract: ReviewContract | null; topicFactIds?: readonly string[] }>;
}>;
export type DialogueReviewInquiry = Readonly<{ inquiryId: string; factId: string; aspect: InquiryAspect }>;
export type DialogueReviewCheck = Readonly<{
  checkId: string; kind: "plan_answer" | "plan_option" | "selected" | "answer" | "option";
  intent: string | null; brief: string | null; inquiries: readonly DialogueReviewInquiry[];
  /** Reporting addresses only, never additional questions or knowledge. */
  inquiryTargets: readonly DialogueReviewInquiry[];
  answers: readonly (NonNullable<ExpressionTask["answers"]>[number] & { inquiryId: string })[];
  prerequisiteFactIds: readonly string[]; facts: SafeContext["visibleFacts"];
  text?: string; selectedText?: string; contractMissing?: boolean;
}>;
export type DialogueReviewRequest = Readonly<{ version: 1; checks: readonly DialogueReviewCheck[] }>;
export type DialogueReviewVerdict = Readonly<{ verdict: "pass" | "reject" | "uncertain";
  violations: readonly Readonly<{ checkId: string; type: DialogueViolation["type"]; inquiryId: string | null }>[] }>;
type Route = Readonly<{ scope: DialogueViolation["scope"]; unitKey: string; candidateId?: string }>;
export type CompiledDialogueReview = Readonly<{ request: DialogueReviewRequest; routes: ReadonlyMap<string, Route> }>;

/** Pure compiler: omitting text produces plan checks without fabricating approved expression output. */
export function compileDialogueReviewChecks(subjects: readonly DialogueReviewSubject[], phase: "all" | "planning" | "expression" = "all"): CompiledDialogueReview {
  const checks: DialogueReviewCheck[] = [];
  const routes = new Map<string, Route>();
  function add(subject: DialogueReviewSubject, kind: DialogueReviewCheck["kind"], scope: Route["scope"]) {
    const checkId = `check_${checks.length}`;
    const pairs = subject.inquiries.flatMap(q => q.aspects.map(aspect => ({ factId: q.factId, aspect })));
    const topics = [...new Set([...subject.topicFactIds, ...subject.prerequisiteFactIds,
      ...pairs.map(q => q.factId), ...subject.answers.map(a => a.factId)])];
    const inquiryTargets = topics.flatMap((factId, index) => INQUIRY_ASPECTS.map((aspect, aspectIndex) => ({
      inquiryId: `q${checks.length}_${index}_${aspectIndex}`, factId, aspect,
    })));
    const locate = (factId: string, aspect: InquiryAspect) => inquiryTargets.find(q => q.factId === factId && q.aspect === aspect)!;
    checks.push({ checkId, kind, intent: subject.intent, brief: subject.brief,
      inquiries: pairs.map(q => locate(q.factId, q.aspect)), inquiryTargets,
      answers: subject.answers.map(a => ({ ...a, inquiryId: locate(a.factId, a.aspect).inquiryId })),
      prerequisiteFactIds: subject.prerequisiteFactIds,
      facts: subject.facts.filter(f => topics.includes(f.id) || subject.answers.some(a => a.answerFactIds.includes(f.id))),
      ...((kind === "answer" || kind === "option" || kind === "selected") && subject.text !== undefined ? { text: subject.text } : {}),
      ...(subject.kind === "answer" && subject.selected !== undefined && kind !== "selected"
        ? { selectedText: subject.selected.label } : {}),
      ...(kind === "selected" ? { contractMissing: subject.intent === null } : {}),
    });
    routes.set(checkId, { scope, unitKey: subject.unitKey,
      ...(subject.candidateId === undefined ? {} : { candidateId: subject.candidateId }) });
  }
  for (const subject of subjects) {
    if (phase !== "planning" && subject.kind === "answer" && subject.selected?.historicalChoice) {
      const contract = subject.selected.contract;
      add({ ...subject, intent: contract?.intent ?? null, brief: contract?.brief ?? null,
        inquiries: contract?.inquiries ?? [], answers: [], prerequisiteFactIds: contract?.prerequisiteFactIds ?? [],
        topicFactIds: [...(subject.selected.topicFactIds ?? []), ...(contract?.inquiries.flatMap(q => q.factId) ?? []), ...(contract?.prerequisiteFactIds ?? [])],
        text: subject.selected.label }, "selected", "legacy");
    }
    if (phase !== "expression") add(subject, subject.kind === "answer" ? "plan_answer" : "plan_option", "planning");
    if (subject.text !== undefined) add(subject, subject.kind, "expression");
  }
  return { request: { version: 1, checks }, routes };
}

/** Exact wire schema, then check-local type and inquiry allowlists. No model-owned repair routing. */
export function parseDialogueReviewVerdict(value: unknown, request: DialogueReviewRequest): DialogueReviewVerdict | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (Object.keys(r).some(k => !["verdict", "violations"].includes(k))
    || !["pass", "reject", "uncertain"].includes(r.verdict as string) || !Array.isArray(r.violations)
    || r.violations.length > 8 || (r.verdict === "reject" ? r.violations.length === 0 : r.violations.length !== 0)) return null;
  const planWitnesses = new Set<string>();
  for (const v of r.violations) {
    if (v === null || typeof v !== "object" || Array.isArray(v)
      || Object.keys(v).length !== 3 || Object.keys(v).some(k => !["checkId", "type", "inquiryId"].includes(k))) return null;
    const check = request.checks.find(c => c.checkId === v.checkId);
    if (check === undefined || !["extra_inquiry", "missing_response", "answer_mismatch", "intent_mismatch"].includes(v.type)) return null;
    if (check.kind === "plan_answer" || check.kind === "plan_option") {
      if (planWitnesses.has(check.checkId)) return null;
      planWitnesses.add(check.checkId);
    }
    if (v.type === "intent_mismatch") { if (v.inquiryId !== null) return null; continue; }
    if (typeof v.inquiryId !== "string") return null;
    const required = check.inquiries.some(q => q.inquiryId === v.inquiryId);
    if (v.type === "extra_inquiry") {
      if (required || !check.inquiryTargets.some(q => q.inquiryId === v.inquiryId)) return null;
    } else if (!required || (v.type === "answer_mismatch" && check.kind !== "answer" && check.kind !== "plan_answer")) return null;
  }
  return r as unknown as DialogueReviewVerdict;
}

/** The runner revalidates before calling this mapper; only server-compiled routes survive. */
export function routeDialogueReviewVerdict(verdict: DialogueReviewVerdict, compiled: CompiledDialogueReview): DialogueConsistencyVerdict {
  return { verdict: verdict.verdict, violations: verdict.violations.map(v => {
    const route = compiled.routes.get(v.checkId)!;
    const check = compiled.request.checks.find(c => c.checkId === v.checkId)!;
    return { scope: route.scope, ...(route.candidateId === undefined ? { unitKey: route.unitKey } : { candidateId: route.candidateId }),
      ...(v.inquiryId === null ? {} : { factId: check.inquiryTargets.find(q => q.inquiryId === v.inquiryId)!.factId }),
      type: v.type, aspect: v.inquiryId === null ? null : check.inquiryTargets.find(q => q.inquiryId === v.inquiryId)!.aspect };
  }) };
}
