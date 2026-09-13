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
  if ("currentScene" in input.proposal) {
    const reviewState = context.reviewWorldState ?? worldState;
    const reviewVisibleIds = entitiesOfKind(reviewState.entityStore, "fact")
      .filter(fact => fact.fact.discovered).map(fact => fact.core.id);
    const scenes = context.reviewScenes ?? [input.proposal.currentScene, ...input.proposal.continuationScenes.map(step => step.scene)];
    scenes.forEach((scene, sceneIndex) => {
      const incoming = new Map<string, Set<string>>();
      type ReviewLine = Readonly<{ npcId: string; audienceIds?: readonly string[]; usedFactIds: readonly string[] }>;
      const expressionLines: readonly ReviewLine[] = scene.expressions?.flatMap((expression) => {
        if (expression.kind !== "npc_line") return [];
        const line = expression as { npcId: unknown; audienceIds: readonly unknown[]; usedFactIds: readonly unknown[] };
        return [{ npcId: String(line.npcId), audienceIds: line.audienceIds.map(String), usedFactIds: line.usedFactIds.map(String) }];
      }) ?? [];
      const legacyLines = scene.expressions === undefined
        ? [...(scene.npcLine == null ? [] : [scene.npcLine]), ...(scene.npcDialogues ?? [])]
          .map((line): ReviewLine => ({ npcId: String(line.npcId), usedFactIds: line.usedFactIds.map(String) }))
        : [...(scene.npcDialogues ?? [])]
          .map((line): ReviewLine => ({ npcId: String(line.npcId), usedFactIds: line.usedFactIds.map(String) }));
      for (const [lineIndex, line] of [...expressionLines, ...legacyLines].entries()) {
        if (line === undefined) continue;
        const audienceIds: readonly string[] = "audienceIds" in line && Array.isArray(line.audienceIds)
          ? line.audienceIds as readonly string[] : [String(PLAYER_ENTITY_ID)];
        const receivesEarlierExpressionFacts = scene.expressions !== undefined && lineIndex < expressionLines.length;
        const allowedByAudience = audienceIds.map(targetId => {
          const lineAuthority = buildNpcSpeechAuthority({
            store: reviewState.entityStore, speakerNpcId: line.npcId as never,
            sceneVisibleFactIds: reviewVisibleIds, eventLedger: reviewState.eventLedger,
            targetContext: { targetId: targetId as never, currentEventIds: job.domainEventIds },
          });
          return {
            targetId,
            allowedFactIds: [...new Set([
              ...(lineAuthority?.allowedFactIds ?? []).map(String),
              ...(receivesEarlierExpressionFacts ? incoming.get(String(line.npcId)) ?? [] : []),
            ])],
          };
        });
        add(`permission:scene:${sceneIndex}:line:${lineIndex}:${line.npcId}`, "permission", ["disclosure"], {
          speakerNpcId: line.npcId, audienceIds, allowedByAudience,
        });
        line.usedFactIds.forEach(factId => references.add(factId));
        if (scene.expressions !== undefined) {
          for (const targetId of audienceIds) {
            if (targetId === String(PLAYER_ENTITY_ID)) continue;
            const facts = incoming.get(targetId) ?? new Set<string>();
            line.usedFactIds.forEach(factId => facts.add(factId));
            incoming.set(targetId, facts);
          }
        }
      }
    });
  }
  for (const id of references) {
    const factState = context.reviewWorldState ?? worldState;
    const fact = entitiesOfKind(factState.entityStore, "fact").find(entry => entry.core.id === id);
    if (fact === undefined) continue;
    const card = authority?.allowedFactCards.find(entry => entry.factId === id);
    add(`fact:${id}`, "fact", ["fact_claim", "disclosure"], {
      id, exists: true,
      playerVisible: visibleIds.includes(fact.core.id),
      focusSpeakerNpcId: job.focusNpcId,
      focusSpeakerMayDisclose: authority?.allowedFactIds.includes(fact.core.id) ?? false,
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

/** One explicit request-envelope prefix is accepted; output is candidate-relative. */
export function canonicalCandidatePath(candidate: unknown, path: string): string | null {
  let normalized = path.startsWith("$.") ? path.slice(2) : path;
  if (normalized.startsWith("proposal.")) normalized = normalized.slice("proposal.".length);
  if (!/^[A-Za-z_][A-Za-z_0-9]*(?:\[\d+\]|\.[A-Za-z_][A-Za-z_0-9]*)*$/.test(normalized)) return null;
  let current: unknown = candidate;
  for (const token of normalized.match(/[A-Za-z_][A-Za-z_0-9]*|\[\d+\]/g) ?? []) {
    const indexed = token.startsWith("[");
    const key = indexed ? token.slice(1, -1) : token;
    if (current === null || typeof current !== "object" || Array.isArray(current) !== indexed
      || !Object.prototype.hasOwnProperty.call(current, key)) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return normalized;
}

/** Accept only concrete object/array paths, never selectors or guessed fields. */
export function resolveCandidatePath(candidate: unknown, path: string): boolean {
  return canonicalCandidatePath(candidate, path) !== null;
}
