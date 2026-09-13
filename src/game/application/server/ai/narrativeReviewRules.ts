import { entitiesOfKind } from "@/game/domain/entity";
import { PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import type { NarrativeCandidateReviewInput, CandidateRuleEvidence, CandidateRuleImpact } from "../../narrativeCandidateReview";
import { buildNpcSpeechAuthority } from "../../npcSpeechAuthority";
import { buildEntityContextProjection } from "../../entityContextProjection";
import { narrativeSlotResolution, projectNarrativeDraft } from "./narrativeDraftProjection";
import { OPENING_SEMANTIC_CONTRACT } from "./openingSemanticContract";

export type NarrativeRuleBasis = Readonly<{
  key: string;
  kind: "input" | "action" | "step" | "item" | "fact" | "permission" | "opening_contract";
  impacts: readonly CandidateRuleImpact[];
  /** Server projection, never a model-supplied assertion of authority. */
  value: unknown;
}>;

/** Reference permission and readable fact text are deliberately separate. */
export function buildNarrativeReviewRules(input: NarrativeCandidateReviewInput): readonly NarrativeRuleBasis[] {
  const catalog: NarrativeRuleBasis[] = [];
  const add = (key: string, kind: NarrativeRuleBasis["kind"], impacts: readonly CandidateRuleImpact[], value: unknown) => {
    if (!catalog.some(entry => entry.key === key)) catalog.push({ key, kind, impacts, value });
  };
  const context = input.context;
  if (context.kind === "opening") {
    const { signal: _signal, reserveHttpAttempt: _reserve, ...openingInput } = context.input;
    add("opening:input", "input", ["input_response"], openingInput);
    add("opening:contract", "opening_contract", ["action_binding", "fact_claim", "disclosure", "interaction_effect"], OPENING_SEMANTIC_CONTRACT);
    if ("opening" in input.proposal) {
      const opening = input.proposal.opening;
      opening.world.publicFacts.forEach((fact, index) => add(`fact:fact_${index}`, "fact", ["fact_claim", "disclosure"], {
        id: `fact_${index}`, key: fact.key,
        referencePermitted: true,
        disclosure: opening.opening.npc.privateFactKeys.includes(fact.key) ? "secret" : "public",
        // Opening establishes its world; the candidate contains the directory text.
      }));
    }
    return catalog;
  }
  const { worldState, storyState, job } = context;
  add(`input:${job.actionId}`, "input", ["input_response"], { utterance: job.utterance, selectedDialogue: job.selectedDialogue });
  add(`action:${job.actionId}`, "action", ["action_binding", "interaction_effect"], { action: job.actionSummary, result: job.resolvedEvent });
  const projection = projectNarrativeDraft({ worldState, storyState, job });
  const alternatives = [projection, projectNarrativeDraft({ worldState, storyState, job, includeDeliveryReturn: true })];
  for (const graph of alternatives) {
    for (const candidate of graph.descriptorGraph.currentChoiceCandidates) {
      add(`action:${candidate.candidateId}`, "action", ["action_binding", "interaction_effect"], candidate);
    }
    for (const step of graph.descriptorGraph.steps) {
      add(`step:${step.stepKey}`, "step", step.trigger.kind === "take_item" || step.trigger.kind === "give_item"
        ? ["step_order", "item_state"] : ["step_order"], {
        stepKey: step.stepKey, generationLocationId: worldState.currentLocationId,
        resolution: narrativeSlotResolution(step.trigger),
      });
      for (const candidate of step.choiceCandidates) add(`action:${candidate.candidateId}`, "action", ["action_binding", "interaction_effect"], candidate);
    }
  }
  if (projection.nextActProjection !== null) {
    const { locationId, npcId } = projection.nextActProjection;
    add(`step:move:${locationId}`, "step", ["step_order"], { stepKey: `move:${locationId}`, currentLocationId: worldState.currentLocationId, locationId, npcId });
    for (const [index, dialogueAct] of ["support", "challenge"].entries()) {
      const candidateId = `move:${locationId}_choice_${index + 1}`;
      add(`action:${candidateId}`, "action", ["action_binding", "interaction_effect"], { candidateId, action: { type: "talk", npcId, dialogueAct } });
    }
  }
  const closure = buildEntityContextProjection({ worldState, storyState, job });
  for (const item of [...closure.mandatory, ...closure.optional].filter(entry => entry.kind === "item")) {
    add(`item:${item.id}`, "item", ["item_state"], item);
  }
  const visibleIds = entitiesOfKind(worldState.entityStore, "fact").filter(fact => fact.fact.discovered).map(fact => fact.core.id);
  const authority = job.focusNpcId === undefined ? null : buildNpcSpeechAuthority({
    store: worldState.entityStore, speakerNpcId: job.focusNpcId, sceneVisibleFactIds: visibleIds,
    eventLedger: worldState.eventLedger, targetContext: { targetId: PLAYER_ENTITY_ID, currentEventIds: job.domainEventIds },
  });
  const references = new Set<string>(visibleIds);
  for (const id of [...(authority?.allowedFactIds ?? []), ...(authority?.withheldFactIds ?? [])]) references.add(id);
  for (const outward of context.npcOutward ?? []) {
    add(`permission:${outward.npcId}`, "permission", ["disclosure", "interaction_effect"], outward);
    for (const id of outward.discloseFactIds) references.add(id);
    for (const proposal of outward.interactionProposals) {
      add(`action:interaction:${proposal.proposalKey}`, "action", ["action_binding", "interaction_effect"], proposal);
      for (const id of [...proposal.factIds, ...(proposal.confidentiality?.protectedFactIds ?? [])]) references.add(id);
    }
  }
  for (const id of references) {
    const fact = entitiesOfKind(worldState.entityStore, "fact").find(entry => entry.core.id === id);
    if (fact === undefined) continue;
    const card = authority?.allowedFactCards.find(entry => entry.factId === id);
    add(`fact:${id}`, "fact", ["fact_claim", "disclosure"], {
      id, exists: true,
      playerVisible: visibleIds.includes(fact.core.id),
      speakerMayDisclose: authority?.allowedFactIds.includes(fact.core.id) ?? false,
      // Merely naming an ID in an authorized proposal does not reveal its text.
      ...(card === undefined ? {} : { discloseableText: card.text }),
      authorizedProposalKeys: (context.npcOutward ?? []).flatMap(outward => outward.interactionProposals)
        .filter(proposal => proposal.factIds.includes(fact.core.id) || proposal.confidentiality?.protectedFactIds.includes(fact.core.id))
        .map(proposal => proposal.proposalKey),
    });
  }
  return catalog;
}

export function parseRuleEvidence(value: unknown, catalog: readonly NarrativeRuleBasis[]): CandidateRuleEvidence | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !["basisKey", "impact", "detail"].includes(key))) return null;
  if (typeof record.basisKey !== "string" || typeof record.impact !== "string"
    || typeof record.detail !== "string" || record.detail.trim().length === 0 || record.detail.length > 2000) return null;
  const basis = catalog.find(entry => entry.key === record.basisKey);
  if (basis === undefined || !basis.impacts.includes(record.impact as CandidateRuleImpact)) return null;
  return { basisKey: record.basisKey, impact: record.impact as CandidateRuleImpact, detail: record.detail };
}

/** Accept only concrete object/array paths, never selectors or guessed fields. */
export function resolveCandidatePath(candidate: unknown, path: string): boolean {
  const normalized = path.replace(/^\$\.?/, "");
  if (!/^[A-Za-z_][A-Za-z_0-9]*(?:\[\d+\]|\.[A-Za-z_][A-Za-z_0-9]*)*$/.test(normalized)) return false;
  let current: unknown = candidate;
  for (const key of normalized.replace(/\[(\d+)\]/g, ".$1").split(".")) {
    if (current === null || typeof current !== "object" || !Object.prototype.hasOwnProperty.call(current, key)) return false;
    current = (current as Record<string, unknown>)[key];
  }
  return true;
}
