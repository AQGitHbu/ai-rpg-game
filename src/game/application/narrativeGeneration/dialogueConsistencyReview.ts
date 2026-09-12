import { fail, hasOnlyKeys, isPlainRecord, type Check, type Unit, type UnitOutput } from "@/game/domain/narrativeUnit";
import { readyUnits, type ApprovedPlan } from "@/game/gameplay/rpg/narrativePlanning";
import type { StoredJob } from "../server/persistence/narrativeJobRepository";
import { approveUnit } from "./approveUnit";
import { projectUnitContext, type SafeContext } from "./perspectiveContext";
import { narrativeInputDigest } from "./narrativeInputDigest";
import { isLegacyStoredDialogueReview } from "./legacyDialogueReview";
export { parseDialogueConsistencyVerdict, type DialogueViolation, type DialogueConsistencyVerdict } from "./legacyDialogueReview";

export const DIALOGUE_REVIEW_VERSION = 2;
export const DIALOGUE_REVIEW_POLICY_REVISION = 8;
export const DIALOGUE_REVIEW_MAX_ATTEMPTS = 2;
export const DIALOGUE_REVIEW_CONTEXT_LIMIT = 24_000;
export type PolishReviewVerdict = Readonly<{ verdict: "pass" | "reject" | "uncertain"; failedIds: readonly string[] }>;
export type DialogueConsistencyReviewRequest = Readonly<{ items: readonly Readonly<{
  id: string; stage: "narration" | "character" | "choices"; draft: string; text: string;
  facts: readonly Readonly<{ id: string; text: string; certainty: "known" | "suspected" }>[];
  scene?: SafeContext["scene"]; speaker?: string; selectedLabel?: string;
  authority?: Readonly<{
    publicRole?: string;
    addresseeRole?: Readonly<{ id: string; name: string; role: string }>;
    actions?: readonly Readonly<{ actorId: string; kind: "pause" | "look" | "gesture"; objectId: string | null }>[];
    events?: readonly Readonly<{ kind: "quest_completed"; questId: string; objectives: readonly Readonly<{ index: number; label: string }>[] }>[];
  }>;
}>[] }>;
export function shouldReviewDialogueConsistency(plan: ApprovedPlan): boolean { return plan.units.length > 0; }

export function parsePolishReviewVerdict(value: unknown, request: DialogueConsistencyReviewRequest): Check<PolishReviewVerdict> {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["verdict", "failedIds"])
    || !["pass", "reject", "uncertain"].includes(String(value.verdict)) || !Array.isArray(value.failedIds)
    || value.failedIds.some(id => typeof id !== "string" || !request.items.some(item => item.id === id))
    || new Set(value.failedIds).size !== value.failedIds.length
    || (value.verdict === "reject" ? value.failedIds.length === 0 : value.failedIds.length !== 0))
    return fail("dialogue_consistency_review_invalid");
  return { ok: true, value: { verdict: value.verdict as PolishReviewVerdict["verdict"], failedIds: value.failedIds } };
}

/** Only already-approved public identity, selected cosmetic actions and current rule evidence. */
function reviewAuthority(job: StoredJob, plan: ApprovedPlan, unit: Unit, context: SafeContext, draft: UnitOutput): DialogueConsistencyReviewRequest["items"][number]["authority"] {
  const keys = draft.stage === "narration" ? draft.actionKeys : draft.stage === "character" ? draft.actions.map(action => action.key) : [];
  const actions = context.allowedActions.filter(action => keys.includes(action.key)).map(({ actorId, kind, objectId }) => ({ actorId, kind, objectId }));
  const events: NonNullable<NonNullable<DialogueConsistencyReviewRequest["items"][number]["authority"]>["events"]>[number][] = [];
  if (job.input.kind === "decision" && unit.stage === "narration" && unit.point.stepKey === "current") {
    const input = job.input;
    const ids = new Set(context.requiredBeats.flatMap(beat => beat.evidence.flatMap(ref => ref.kind === "committed"
      && plan.currentBeatEvidence?.[beat.beatId]?.includes(ref.eventId) ? [ref.eventId] : [])));
    for (const event of input.world.eventLedger) {
      if (!ids.has(String(event.eventId)) || !input.job.domainEventIds.includes(event.eventId) || event.payload.type !== "quest_completed") continue;
      const questId = event.payload.questId;
      const transition = input.job.objectiveTransition;
      const completed = transition.completed.filter(objective => objective.questId === questId);
      if (completed.length === 0 && transition.mode === "ready_for_ending" && transition.before?.questId === questId) completed.push(transition.before);
      if (completed.length > 0) events.push({ kind: "quest_completed", questId: String(questId),
        objectives: completed.map(({ objectiveIndex, label }) => ({ index: objectiveIndex, label })) });
    }
  }
  const publicRole = context.persona?.publicRole.text;
  const addresseeRole = context.dialogue?.addresseeRole === undefined ? undefined : {
    id: context.dialogue.addresseeId, name: context.dialogue.addresseeName, role: context.dialogue.addresseeRole,
  };
  return publicRole === undefined && addresseeRole === undefined && actions.length === 0 && events.length === 0 ? undefined : {
    ...(publicRole === undefined ? {} : { publicRole }), ...(addresseeRole === undefined ? {} : { addresseeRole }), ...(actions.length === 0 ? {} : { actions }), ...(events.length === 0 ? {} : { events }),
  };
}

/** One item per complete utterance or candidate; reference scope remains independently approved. */
export function dialogueConsistencyReviewInput(job: StoredJob, plan: ApprovedPlan): Check<{
  request: DialogueConsistencyReviewRequest; digest: string; routes: ReadonlyMap<string, string>;
} | null> {
  if (!shouldReviewDialogueConsistency(plan)) return { ok: true, value: null }; // explicit legacy/offline data only
  const approved = new Map<string, UnitOutput>();
  const items: DialogueConsistencyReviewRequest["items"][number][] = [];
  const contexts: SafeContext[] = [];
  const routes = new Map<string, string>();
  while (approved.size < plan.units.length) {
    const ready = readyUnits(plan.units, new Set(approved.keys()));
    if (ready.length === 0) return fail("staged_dependency_unmet");
    for (const unit of ready) {
      const stored = job.units.find(stored => stored.key === unit.key);
      if (stored?.status !== "approved" || stored.value === null || !("stage" in stored.value)) return fail("assemble_unit_missing");
      const projected = projectUnitContext({ plan, unit, approved });
      if (!projected.ok) return projected;
      const context = projected.value;
      const draft = context.draft;
      if (draft === undefined) return fail("plan_draft_missing");
      const output = stored.value;
      const valid = approveUnit({ unit, context, output });
      if (!valid.ok) return valid;
      contexts.push(context);
      const authority = reviewAuthority(job, plan, unit, context, draft);
      const add = (draftText: string, text: string, factIds?: readonly string[]) => {
        const id = `polish_${items.length}`;
        routes.set(id, unit.key);
        items.push({ id, stage: unit.stage, draft: draftText, text,
          ...(authority === undefined ? {} : { authority }),
          facts: context.visibleFacts.filter(fact => factIds === undefined || factIds.includes(fact.id))
            .map(({ id, text, certainty }) => ({ id, text, certainty })),
          scene: context.scene, speaker: context.dialogue?.speakerName ?? context.persona?.publicName ?? context.scene?.playerName,
          ...(context.playerUtterance === null ? {} : { selectedLabel: context.playerUtterance }) });
      };
      if (draft.stage === "choices" && output.stage === "choices") {
        for (const label of draft.labels) {
          const final = output.labels.find(candidate => candidate.candidateId === label.candidateId);
          if (final === undefined) return fail("unit_output_candidate_missing");
          const option = context.options.find(option => option.candidateId === label.candidateId);
          add(label.label, final.label, context.choiceKind === "ordinary" ? option?.publicIntent.facts.map(fact => fact.factId) : undefined);
        }
      } else if (draft.stage !== "choices" && output.stage !== "choices") {
        add(draft.parts.map(part => part.text).join("\n"), output.parts.map(part => part.text).join("\n"));
      } else return fail("unit_output_stage_mismatch");
      approved.set(unit.key, output);
    }
  }
  const request = { items };
  if ([...JSON.stringify(request)].length > DIALOGUE_REVIEW_CONTEXT_LIMIT) return fail("dialogue_consistency_context_limit");
  const digest = narrativeInputDigest({ version: DIALOGUE_REVIEW_VERSION, policyRevision: DIALOGUE_REVIEW_POLICY_REVISION,
    cycle: job.cycle, inputDigest: job.inputDigest, proposal: plan.proposal, contexts, request,
    units: job.units.map(unit => ({ key: unit.key, inputDigest: unit.inputDigest, value: unit.value })) });
  return { ok: true, value: { request, digest, routes } };
}
export function validateJobDialogueConsistencyReview(job: StoredJob, plan: ApprovedPlan): Check<true> {
  const input = dialogueConsistencyReviewInput(job, plan);
  if (!input.ok) return input;
  if (input.value === null) return { ok: true, value: true };
  const receipt = job.dialogueConsistencyReview;
  return receipt?.version === DIALOGUE_REVIEW_VERSION && receipt.cycle === job.cycle
    && receipt.status === "approved" && receipt.attempts > 0 && receipt.attempts <= DIALOGUE_REVIEW_MAX_ATTEMPTS
    && receipt.inputDigest === input.value.digest && receipt.passDigest === input.value.digest
    ? { ok: true, value: true } : fail("dialogue_consistency_review_required");
}
export function isStoredDialogueReview(value: unknown): boolean {
  if (value === undefined || (isPlainRecord(value) && value.version === 1)) return isLegacyStoredDialogueReview(value);
  if (!isPlainRecord(value)) return false;
  return hasOnlyKeys(value, ["version", "cycle", "inputDigest", "attempts", "status", "passDigest", "failedIds", "lastFailure"])
    && value.version === 2 && Number.isInteger(value.cycle) && Number(value.cycle) >= 0
    && Number.isInteger(value.attempts) && Number(value.attempts) >= 0 && Number(value.attempts) <= 2
    && typeof value.inputDigest === "string" && /^[a-f0-9]{64}$/.test(value.inputDigest)
    && ["pending", "running", "approved", "failed", "unknown"].includes(String(value.status))
    && (value.passDigest === undefined || (value.status === "approved" && value.passDigest === value.inputDigest))
    && (value.failedIds === undefined || (Array.isArray(value.failedIds) && value.failedIds.every(id => typeof id === "string" && /^polish_\d+$/.test(id))))
    && (value.lastFailure === undefined || ["protocol_error", "provider_failure", "uncertain", "outcome_unknown", "content_recheck", "exhausted"].includes(String(value.lastFailure)));
}
