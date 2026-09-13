import { entitiesOfKind } from "@/game/domain/entity";
import { PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import { createAiSourceFailure, type AiSourceFailure } from "./aiGenerationRetry";
import type { NarrativeBundleRepairReason, NarrativeBundleSourceContext } from "./narrativeBundleSource";
import type { NpcDeliberationSource } from "./npcDeliberationSource";
import { authorizeNpcDeliberationOutward } from "./npcSpeechAuthority";
import { currentNpcPlayerExpressions, projectNpcDeliberation } from "./projectNpcDeliberation";

/** One focused NPC may deliberate; this function never mutates committed state. */
export async function prepareNpcNarrativeContext(
  context: NarrativeBundleSourceContext,
  source: NpcDeliberationSource,
): Promise<{ readonly ok: true; readonly context: NarrativeBundleSourceContext } | AiSourceFailure<NarrativeBundleRepairReason>> {
  if (context.kind !== "decision") return { ok: true, context };
  const fail = (reason: NarrativeBundleRepairReason, detail: string): AiSourceFailure<NarrativeBundleRepairReason> =>
    createAiSourceFailure("scene", reason === "provider_failure" ? "transport" : "invalid_reference", reason, detail);
  if (context.signal?.aborted) return fail("provider_failure", "aborted");
  const focus = context.job.focusNpcId;
  if (focus === undefined) return { ok: true, context };
  const npc = entitiesOfKind(context.worldState.entityStore, "npc").find(record => record.core.id === focus);
  if (npc === undefined || npc.core.lifecycle !== "active"
    || npc.position.locationId !== context.worldState.currentLocationId) {
    return { ok: true, context };
  }
  const text = (context.job.utterance ?? context.job.selectedDialogue?.label
    ?? currentNpcPlayerExpressions(context.storyState, context.job, focus).map(entry => entry.text).join("\n")).trim();
  // A salutation alone is not a new interaction proposal. These checks select
  // whether to call a source; they never infer or commit an action from prose.
  const greetingOnly = /^(你好|您好|嗨|在吗|hello|hi)[！!。.?？\s]*$/iu.test(text);
  const goals = npc.dynamicState.goals.filter(goal => goal.status === "active" || goal.status === "blocked");
  const needsJudgment = npc.knowledge.entries.some(entry => entry.disclosure === "conditional")
    || npc.relationships.outgoing.some(edge => edge.commitments.some(commitment => commitment.status === "open"))
    || goals.length > 1
    || /核验|核实|验证|身份|引荐|保密|承诺|条件|请求|交付|verify|introduc|promise|confidential/iu.test(text);
  if (greetingOnly || !needsJudgment) return { ok: true, context };
  try {
    const input = projectNpcDeliberation({
      worldState: context.worldState, storyState: context.storyState,
      npcId: focus, jobId: context.job.jobId, candidateVersion: context.candidateVersion ?? 1,
    });
    const result = await source.generate({
      ...input,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
      ...(context.reserveHttpAttempt === undefined ? {} : { reserveHttpAttempt: context.reserveHttpAttempt }),
    });
    if (context.signal?.aborted) return fail("provider_failure", "aborted");
    if (!result.ok) return fail(result.code === "PROVIDER_FAILURE" ? "provider_failure" : "invalid_reference", result.code);
    if (result.proposal.npcId !== focus) return fail("invalid_reference", "npc_deliberation_speaker_mismatch");
    const player = entitiesOfKind(context.worldState.entityStore, "player_character").find(record => record.core.id === PLAYER_ENTITY_ID);
    const authorized = authorizeNpcDeliberationOutward({
      store: context.worldState.entityStore, speakerNpcId: focus,
      sceneVisibleFactIds: player?.knowledge.knownFactIds ?? [],
      eventLedger: context.worldState.eventLedger, targetContext: { targetId: PLAYER_ENTITY_ID, currentEventIds: context.job.domainEventIds },
      proposal: result.proposal,
    });
    if (!authorized.ok) return fail("invalid_reference", authorized.code);
    return { ok: true, context: { ...context, npcOutward: [authorized.projection] } };
  } catch {
    return fail("provider_failure", "npc_deliberation_failed");
  }
}
