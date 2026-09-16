import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type {
  EvolutionNeed,
  WorldDeltaEntityContextClosure,
  WorldDeltaProposal,
  ApprovedWorldDelta,
} from "@/game/domain/worldDelta";
import type { NarrativeJobId } from "@/game/domain/events";
import { asEventId, asTurnId, type NarrativeEventDraft } from "@/game/domain/events";
import type {
  NarrativeBundleProposal,
  NarrativeBundleState,
  NarrativeBundleStepState,
  NarrativeBundleTerminalState,
  NarrativeBundleTrigger,
  BundleSceneProposal,
  BundleStepProposal,
} from "@/game/domain/narrativeBundle";
import { parseNarrativeBundleProposal } from "@/game/domain/narrativeBundle";
import type {
  NarrativeSceneState,
  NarrativeNpcLineState,
  NarrativeEventState,
} from "@/game/domain/narrative";
import { NPC_SCENE_PAGE_CHAR_BUDGET } from "@/game/domain/narrative";
import { normalizeNpcSpeech } from "@/game/domain/npcSpeech";
import { paginateSpeechText } from "@/game/domain/speechPagination";
import type { ApprovedChoice } from "@/game/domain/approvedChoice";
import { createApprovedChoice } from "@/game/domain/approvedChoice";
import type { EventCandidate } from "@/game/domain/candidateEvent";
import type { PreparedSceneSeedState } from "@/game/domain/preparedContinuation";
import type { ObjectiveTransition, MandatoryNarrativeBeat } from "@/game/domain/narrativeBeat";
import { ATMOSPHERE_BEAT_ID } from "@/game/domain/narrativeBeat";
import {
  approveWorldDelta,
  materializeWorldDelta,
  type WorldDeltaIdOverride,
} from "@/game/gameplay/rpg/worldEvolution";
import {
  buildNarrativeBundleDescriptors,
  validateNarrativeBundleCoverage,
  type BundleDescriptorGraph,
  type BundleStepDescriptor,
} from "@/game/gameplay/rpg/narrativeBundle";
import type { NarrativeBundleRejection } from "./narrativeBundleSource";
import type { AiTextAuditLink } from "./server/ai/textAuditTypes";
import { entitiesOfKind, getEntity, type EntityId, type NpcEntityRecord } from "@/game/domain/entity";
import { asFactId, asItemId, asNpcId, PLAYER_ENTITY_ID, type FactId } from "@/game/domain/worldEntity";
import {
  buildNpcSpeechAuthority,
  isValidNpcSpeechTarget,
  validateNpcSpeechReferences,
} from "./npcSpeechAuthority";
import { buildNarrativeScenePresentedDraft } from "./approveAndWriteScene";
import { sceneExpressionsOf, type SceneExpressionProposal, type ApprovedSceneExpression } from "@/game/domain/sceneExpression";
import {
  parseStoryInteractionProposal,
  type StoryCondition,
  type StoryInteraction,
  type StoryInteractionProposal,
} from "@/game/domain/storyInteraction";
import { applyEntityMutations, type EntityMutation } from "@/game/gameplay/rpg/entityWorld";
import { approveStoryConsequenceBindings } from "./approveStoryConsequenceBindings";

import type { TurnId } from "@/game/domain/events";
import { previewSceneDisclosure, projectSceneSpeechKnowledge } from "@/game/gameplay/rpg/ruleEngine";
import { deriveObjectiveTransition } from "@/game/gameplay/rpg/narrativeContext";
import { deriveStructuralEvolutionNeed } from "@/game/gameplay/rpg/worldEvolution";

// ---------------------------------------------------------------------------
// Task 4：原子审批叙事生成包。
// 纯函数：approveWorldDelta → materializeWorldDelta → buildDescriptors →
// resolve symbols → approve scenes → validate coverage → return one
// immutable ApprovedNarrativeBundle.
// 不调用 source/aiClient/repository——那些由上层编排。
// ---------------------------------------------------------------------------

export type ApprovedNarrativeBundle = {
  readonly objectiveTransition: ObjectiveTransition;
  readonly nextWorldState: WorldState;
  readonly nextStoryStatePreview: StoryState;
  readonly currentScene: NarrativeSceneState;
  readonly choiceRegistry: readonly ApprovedChoice[];
  readonly bundle: NarrativeBundleState;
  readonly candidateEventPool: readonly EventCandidate[];
  readonly eventDrafts: readonly NarrativeEventDraft[];
};

export type ApproveNarrativeBundleResult =
  | { readonly ok: true; readonly approved: ApprovedNarrativeBundle }
  | {
    readonly ok: false;
    readonly code: NarrativeBundleRejection | "STALE_CANDIDATE_REVIEW";
    /** 规则引擎给出的细分拒绝理由（如 duplicate_name:enemy）；供修复重试提示使用。 */
    readonly detail?: string;
  };

export type ApproveNarrativeBundleInput = {
  readonly proposal: NarrativeBundleProposal;
  readonly worldState: WorldState;
  readonly storyState: StoryState;
  readonly transition: ObjectiveTransition;
  readonly evolutionNeed: EvolutionNeed;
  readonly jobId: NarrativeJobId;
  readonly basedOnRevision: number;
  /** 本回合规则派生的强制节拍；currentScene 必须逐一覆盖。 */
  readonly mandatoryBeats: readonly MandatoryNarrativeBeat[];
  readonly idOverride?: WorldDeltaIdOverride;
  readonly entityContextClosure?: WorldDeltaEntityContextClosure;
  readonly now: () => string;
  readonly eventContext?: import("@/game/domain/worldDelta").WorldDeltaEventContext;
  readonly auditLink?: AiTextAuditLink;
  /** Server-owned identity of the candidate being approved. */
  readonly candidateVersion?: number;
  readonly candidateHash?: string;
  /** A semantic pass is valid only for the exact candidate being committed. */
  readonly candidateReview?: Readonly<{
    readonly ok?: true;
    readonly candidateVersion: number;
    readonly candidateHash: string;
  }>;
};

function eventForTrigger(trigger: NarrativeBundleTrigger): NarrativeEventState {
  switch (trigger.kind) {
    case "move":
    case "explore":
      return { kind: "travel", locationId: trigger.locationId };
    case "investigate":
      return { kind: "investigate", factId: trigger.factId };
    case "take_item":
      return { kind: "item", itemId: trigger.itemId };
    case "give_item":
      return { kind: "dialogue", focusNpcId: trigger.npcId };
    case "battle_started":
    case "battle_resolved":
      return { kind: "battle", enemyId: trigger.enemyId };
  }
}

function reclassifiedStageDirection(text: string): string {
  return text.trim()
    .replace(/^[…。，！？!?\s]+/u, "")
    .replace(/^（(.+)）$/u, "$1")
    .trim();
}

function normalizedSceneParts(proposal: BundleSceneProposal): {
  readonly expressions: readonly SceneExpressionProposal[];
  readonly segments: readonly { readonly beatId: string; readonly text: string; readonly referencedEntityIds?: readonly string[] }[];
  readonly npcLine: Extract<SceneExpressionProposal, { readonly kind: "npc_line" }> | null;
} {
  const expressions = sceneExpressionsOf(proposal);
  const segments = expressions
    .filter((expression): expression is Extract<SceneExpressionProposal, { readonly kind: "narration" }> => expression.kind === "narration")
    .map((expression) => ({
      beatId: expression.beatId,
      text: expression.text,
      referencedEntityIds: expression.referencedEntityIds,
    }));
  const line = expressions.find((expression): expression is Extract<SceneExpressionProposal, { readonly kind: "npc_line" }> => expression.kind === "npc_line");
  return {
    expressions,
    segments,
    npcLine: line === undefined ? null : line,
  };
}

function sceneSymbolBindings(
  worldState: WorldState,
  approvedDelta: ApprovedWorldDelta | undefined,
  focusNpcId: string | undefined,
): ReadonlyMap<string, string> {
  const bindings = new Map<string, string>([
    ["@current.location", String(worldState.currentLocationId)],
    ...(focusNpcId === undefined ? [] : [["@current.focus_npc", focusNpcId] as const]),
  ]);
  const first = (ids: readonly string[] | undefined): void => {
    const id = ids?.[0];
    if (id !== undefined) {
      // The binding values originate from already approved, branded IDs.
      bindings.set("@new.location", String(id));
    }
  };
  first(approvedDelta?.mintedLocationIds);
  if (approvedDelta?.mintedNpcIds[0] !== undefined) bindings.set("@new.npc", String(approvedDelta.mintedNpcIds[0]));
  if (approvedDelta?.mintedItemIds[0] !== undefined) bindings.set("@new.item", String(approvedDelta.mintedItemIds[0]));
  if (approvedDelta?.mintedEnemyIds[0] !== undefined) bindings.set("@new.enemy", String(approvedDelta.mintedEnemyIds[0]));
  if (approvedDelta?.mintedFactIds[0] !== undefined) bindings.set("@new.fact", String(approvedDelta.mintedFactIds[0]));
  if (approvedDelta?.mintedQuestIds[0] !== undefined) bindings.set("@new.quest", String(approvedDelta.mintedQuestIds[0]));
  return bindings;
}

function resolveSceneReference(raw: string, bindings: ReadonlyMap<string, string>): string | null {
  if (!raw.startsWith("@")) return raw;
  return bindings.get(raw) ?? null;
}

type InteractionCompilation =
  | { readonly ok: true; readonly interactions: readonly StoryInteraction[]; readonly mutations: readonly EntityMutation[] }
  | { readonly ok: false; readonly detail: string };

function activeEntity(worldState: WorldState, id: string): EntityId | null {
  const record = getEntity(worldState.entityStore, id);
  return record?.core.lifecycle === "active" ? record.core.id : null;
}

function activeNpc(worldState: WorldState, id: string): EntityId | null {
  const record = getEntity(worldState.entityStore, id);
  return record?.core.kind === "npc" && record.core.lifecycle === "active" ? record.core.id : null;
}

function activeAudience(worldState: WorldState, id: string): EntityId | null {
  const record = getEntity(worldState.entityStore, id);
  if (record?.core.lifecycle !== "active") return null;
  return record.core.kind === "player_character" || record.core.kind === "npc" ? record.core.id : null;
}

function resolveInteractionCondition(
  condition: StoryCondition,
  bindings: ReadonlyMap<string, string>,
  worldState: WorldState,
): StoryCondition | null {
  const resolve = (raw: string): string | null => resolveSceneReference(raw, bindings);
  switch (condition.kind) {
    case "has_item": {
      const itemId = resolve(String(condition.itemId));
      const ownerId = resolve(String(condition.ownerId));
      if (itemId === null || ownerId === null
        || getEntity(worldState.entityStore, itemId)?.core.kind !== "item"
        || activeEntity(worldState, ownerId) === null) return null;
      return { kind: "has_item", itemId: asItemId(itemId), ownerId: ownerId as EntityId };
    }
    case "knows_fact": {
      const actorId = resolve(String(condition.actorId));
      const factId = resolve(String(condition.factId));
      if (actorId === null || factId === null
        || activeEntity(worldState, actorId) === null
        || getEntity(worldState.entityStore, factId)?.core.kind !== "fact") return null;
      return { kind: "knows_fact", actorId: actorId as EntityId, factId: asFactId(factId) };
    }
    case "promise_status": {
      const npcId = resolve(String(condition.npcId));
      if (npcId === null || activeNpc(worldState, npcId) === null) return null;
      return { ...condition, npcId: asNpcId(npcId) };
    }
    case "goal_status": {
      const npcId = resolve(String(condition.npcId));
      if (npcId === null || activeNpc(worldState, npcId) === null) return null;
      return { ...condition, npcId: asNpcId(npcId) };
    }
    case "investigation_observed": {
      const npcId = resolve(String(condition.npcId));
      const factId = resolve(String(condition.factId));
      if (npcId === null || factId === null || activeNpc(worldState, npcId) === null
        || getEntity(worldState.entityStore, factId)?.core.kind !== "fact") return null;
      return { ...condition, npcId: asNpcId(npcId), factId: asFactId(factId) };
    }
  }
}

function compileInteractionProposals(input: {
  readonly worldState: WorldState;
  readonly proposals: readonly StoryInteractionProposal[];
  readonly jobId: NarrativeJobId;
  readonly bindings: ReadonlyMap<string, string>;
}): InteractionCompilation {
  const { worldState, proposals, jobId, bindings } = input;
  const interactions: StoryInteraction[] = [];
  const mutations: EntityMutation[] = [];
  const seenKeys = new Set<string>();
  for (const [index, rawProposal] of proposals.entries()) {
    const parsed = parseStoryInteractionProposal(rawProposal, `interactionProposals[${index}]`);
    if (!parsed.ok) return { ok: false, detail: parsed.path };
    const proposal = parsed.value;
    if (seenKeys.has(proposal.proposalKey)) return { ok: false, detail: `duplicate:${proposal.proposalKey}` };
    seenKeys.add(proposal.proposalKey);

    const npcId = resolveSceneReference(String(proposal.npcId), bindings);
    if (npcId === null || activeNpc(worldState, npcId) === null) return { ok: false, detail: `npc:${String(proposal.npcId)}` };
    const condition: StoryCondition[] = [];
    for (const entry of proposal.condition) {
      const resolved = resolveInteractionCondition(entry, bindings, worldState);
      if (resolved === null) return { ok: false, detail: `condition:${entry.kind}` };
      condition.push(resolved);
    }
    const factIds: FactId[] = [];
    for (const rawFactId of proposal.factIds) {
      const factId = resolveSceneReference(String(rawFactId), bindings);
      const fact = factId === null ? undefined : getEntity(worldState.entityStore, factId);
      if (factId === null || fact?.core.kind !== "fact" || fact.core.lifecycle !== "active") {
        return { ok: false, detail: `fact:${String(rawFactId)}` };
      }
      factIds.push(asFactId(factId));
    }
    const audienceIds: EntityId[] = [];
    const audienceSet = new Set<string>();
    for (const rawAudienceId of proposal.audienceIds) {
      const audienceId = resolveSceneReference(String(rawAudienceId), bindings);
      const audience = audienceId === null ? null : activeAudience(worldState, audienceId);
      if (audienceId === null || audience === null || audienceSet.has(audienceId) || (proposal.operation !== "share_known_fact" && audienceId === npcId)) {
        return { ok: false, detail: `audience:${String(rawAudienceId)}` };
      }
      audienceSet.add(audienceId);
      audienceIds.push(audience);
    }
    const evidenceEventIds = proposal.evidenceEventIds.map((rawEventId) => {
      const eventId = resolveSceneReference(String(rawEventId), bindings);
      return eventId === null || !worldState.eventLedger.some((event) => String(event.eventId) === eventId)
        ? null
        : asEventId(eventId);
    });
    if (evidenceEventIds.some((eventId) => eventId === null)) return { ok: false, detail: "evidence" };
    if (audienceIds.length === 0) return { ok: false, detail: "audience_required" };
    if (proposal.operation !== "promise_confidentiality" && factIds.length === 0) {
      return { ok: false, detail: "facts_required" };
    }
    if (proposal.operation === "request_verification" && evidenceEventIds.length === 0) {
      return { ok: false, detail: "verification_requires_evidence" };
    }
    const npcRecord = getEntity(worldState.entityStore, npcId);
    if (npcRecord?.core.kind !== "npc") return { ok: false, detail: `npc:${npcId}` };
    const npc = npcRecord as NpcEntityRecord;
    const player = getEntity(worldState.entityStore, PLAYER_ENTITY_ID);
    const known = proposal.operation === "share_known_fact" && player?.core.kind === "player_character"
      ? (player as import("@/game/domain/entity").PlayerEntityRecord).knowledge.knownFactIds : npc.knowledge.entries.map((entry) => entry.factId);
    if (proposal.operation === "share_known_fact" && (!audienceIds.includes(asNpcId(npcId)) || audienceIds.some((id) => {
      const target = getEntity(worldState.entityStore, id);
      return target?.core.kind !== "npc" || (target as NpcEntityRecord).position.locationId !== npc.position.locationId;
    }))) return { ok: false, detail: "share_audience" };
    if (!factIds.every((factId) => known.includes(factId))) {
      return { ok: false, detail: "npc_knowledge" };
    }
    let confidentiality: StoryInteraction["confidentiality"];
    if (proposal.confidentiality !== undefined) {
      const protectedFactIds = proposal.confidentiality.protectedFactIds.map((id) => resolveSceneReference(String(id), bindings));
      const allowedAudienceIds = proposal.confidentiality.allowedAudienceIds.map((id) => resolveSceneReference(String(id), bindings));
      if (protectedFactIds.some((id) => id === null || !npc.knowledge.entries.some((entry) => String(entry.factId) === id))
        || allowedAudienceIds.some((id) => id === null || activeAudience(worldState, id) === null)
        || new Set(protectedFactIds).size !== protectedFactIds.length || new Set(allowedAudienceIds).size !== allowedAudienceIds.length
        || !allowedAudienceIds.includes(String(PLAYER_ENTITY_ID))) return { ok: false, detail: "confidentiality_references" };
      confidentiality = { protectedFactIds: protectedFactIds.map((id) => asFactId(id!)), allowedAudienceIds: allowedAudienceIds as EntityId[], fulfillment: { kind: "story_delivery" } };
    }
    const id = `interaction:${String(jobId)}:${proposal.proposalKey}`;
    const interaction: StoryInteraction = {
      id,
      npcId: asNpcId(npcId),
      operation: proposal.operation,
      ...(confidentiality === undefined ? {} : { confidentiality }),
      condition,
      factIds,
      goalIds: [...proposal.goalIds],
      promiseId: proposal.promiseId,
      audienceIds,
      evidenceEventIds: evidenceEventIds as import("@/game/domain/events").EventId[],
    };
    interactions.push(interaction);
    mutations.push({ kind: "install_story_interaction", npcId: interaction.npcId, interaction });
  }
  return { ok: true, interactions, mutations };
}

/** Opening and decision approvals share one installation gate. */
export function installStoryInteractionProposals(input: {
  readonly worldState: WorldState;
  readonly proposals: readonly StoryInteractionProposal[];
  readonly jobId: NarrativeJobId;
  readonly focusNpcId?: string;
}): { readonly ok: true; readonly worldState: WorldState } | { readonly ok: false; readonly detail: string } {
  const compiled = compileInteractionProposals({
    worldState: input.worldState,
    proposals: input.proposals,
    jobId: input.jobId,
    bindings: sceneSymbolBindings(input.worldState, undefined, input.focusNpcId),
  });
  if (!compiled.ok) return compiled;
  const applied = applyEntityMutations(input.worldState, compiled.mutations);
  return applied.ok
    ? applied
    : { ok: false, detail: applied.code };
}

/** Resolve and fail closed before any approved expression is materialized. */
function resolveSceneExpressions(
  scene: BundleSceneProposal,
  worldState: WorldState,
  approvedDelta: ApprovedWorldDelta | undefined,
  focusNpcId: string | undefined,
): BundleSceneProposal | null {
  if (scene.expressions === undefined) return scene;
  const bindings = sceneSymbolBindings(worldState, approvedDelta, focusNpcId);
  const resolved = [] as SceneExpressionProposal[];
  for (const expression of scene.expressions) {
    if (expression.kind === "narration") {
      const referencedEntityIds = expression.referencedEntityIds.map((raw) => {
        const id = resolveSceneReference(raw, bindings);
        if (id === null || getEntity(worldState.entityStore, id) === undefined) return null;
        return id;
      });
      if (referencedEntityIds.some((id) => id === null)) return null;
      resolved.push({
        ...expression,
        referencedEntityIds: referencedEntityIds as string[],
      });
      continue;
    }
    const npcId = resolveSceneReference(expression.npcId, bindings);
    const npc = npcId === null ? undefined : getEntity(worldState.entityStore, npcId);
    const audienceIds = expression.audienceIds.map((raw) => {
      const id = resolveSceneReference(raw, bindings);
      return id === null || getEntity(worldState.entityStore, id) === undefined ? null : id;
    });
    const factIds = expression.usedFactIds.map((raw) => {
      const id = resolveSceneReference(raw, bindings);
      const record = id === null ? undefined : getEntity(worldState.entityStore, id);
      return record?.core.kind === "fact" ? id : null;
    });
    const eventIds = expression.usedEventIds.map((raw) => {
      const id = resolveSceneReference(raw, bindings);
      return id !== null && worldState.eventLedger.some((event) => String(event.eventId) === id) ? id : null;
    });
    if (npc?.core.kind !== "npc"
      || audienceIds.some((id) => id === null)
      || factIds.some((id) => id === null)
      || eventIds.some((id) => id === null)) return null;
    resolved.push({
      ...expression,
      npcId: String(npc.core.id),
      audienceIds: audienceIds as string[],
      usedFactIds: factIds as string[],
      usedEventIds: eventIds as string[],
    });
  }
  return { ...scene, expressions: resolved };
}

function approvedExpressions(
  expressions: readonly SceneExpressionProposal[],
  worldState: WorldState,
): readonly ApprovedSceneExpression[] {
  return expressions.map((expression) => {
    if (expression.kind === "narration") {
      const referencedEntityIds: EntityId[] = [];
      for (const id of expression.referencedEntityIds) {
        const record = getEntity(worldState.entityStore, id);
        if (record === undefined) throw new Error("APPROVED_SCENE_REFERENCE_MISSING");
        referencedEntityIds.push(record.core.id);
      }
      return {
        kind: "narration" as const,
        beatId: expression.beatId,
        text: expression.text,
        referencedEntityIds,
      };
    }
    const npc = getEntity(worldState.entityStore, expression.npcId);
    const audienceIds: EntityId[] = [];
    for (const id of expression.audienceIds) {
      const record = getEntity(worldState.entityStore, id);
      if (record === undefined) throw new Error("APPROVED_SCENE_REFERENCE_MISSING");
      audienceIds.push(record.core.id);
    }
    const factIds: FactId[] = [];
    for (const id of expression.usedFactIds) {
      const record = getEntity(worldState.entityStore, id);
      if (record?.core.kind !== "fact") throw new Error("APPROVED_SCENE_REFERENCE_MISSING");
      factIds.push(record.core.id);
    }
    if (npc?.core.kind !== "npc"
    ) {
      throw new Error("APPROVED_SCENE_REFERENCE_MISSING");
    }
    return {
      kind: "npc_line" as const,
      npcId: npc.core.id,
      audienceIds,
      text: expression.text,
      emotion: expression.emotion,
      answeredBeatIds: [...expression.answeredBeatIds],
      usedFactIds: factIds,
      usedEventIds: expression.usedEventIds.map(asEventId),
    };
  });
}

/** Surface every existing-world naming collision in one repair hint. */
function duplicateNameDetail(proposal: WorldDeltaProposal, worldState: WorldState): string | undefined {
  const npcName = proposal.newNpc?.name;
  const locationName = proposal.newLocation?.name;
  const itemName = proposal.newItem?.name;
  const enemyName = proposal.newEnemy?.name;
  const questName = proposal.nextMainQuest?.name;
  const duplicates = [
    npcName !== undefined && worldState.npcs.some((entry) => entry.name === npcName)
      ? `npc:${npcName}` : null,
    locationName !== undefined && worldState.locations.some((entry) => entry.name === locationName)
      ? `location:${locationName}` : null,
    itemName !== undefined && worldState.items.some((entry) => entry.name === itemName)
      ? `item:${itemName}` : null,
    enemyName !== undefined && worldState.enemies.some((entry) => entry.name === enemyName)
      ? `enemy:${enemyName}` : null,
    questName !== undefined && worldState.quests.some((entry) => entry.name === questName)
      ? `quest:${questName}` : null,
  ].filter((entry): entry is string => entry !== null);
  return duplicates.length === 0 ? undefined : `duplicate_name:${duplicates.join("|")}`;
}

function buildSceneFromProposal(
  proposal: BundleSceneProposal,
  sceneId: string,
  turn: number,
  worldState: WorldState,
  trigger?: NarrativeBundleTrigger,
  dialogueFocusNpcId?: NarrativeNpcLineState["npcId"],
): NarrativeSceneState {
  const parts = normalizedSceneParts(proposal);
  const normalizedNpcText = parts.npcLine === null
    ? null
    : normalizeNpcSpeech(parts.npcLine.text);
  const stageDirection = parts.npcLine !== null && normalizedNpcText === ""
    ? reclassifiedStageDirection(parts.npcLine.text)
    : "";
  const narration = [
    ...parts.segments.map((s) => s.text),
    ...(stageDirection === "" ? [] : [stageDirection]),
  ].join("\n");
  const npcLine: NarrativeNpcLineState | null = parts.npcLine === null
    || normalizedNpcText === ""
    ? null
    : {
        npcId: parts.npcLine.npcId as never,
        text: normalizedNpcText!,
        emotion: parts.npcLine.emotion,
        usedFactIds: parts.npcLine.usedFactIds.map((id: string) => id as never),
        usedEventIds: [...parts.npcLine.usedEventIds],
        answeredBeatIds: [...parts.npcLine.answeredBeatIds],
      };
  // The current-scene terminal is itself a formal NPC decision boundary.
  // Unlike continuation steps it has no trigger, so derive its dialogue
  // marker from the approved focused line and pair of server candidates.
  const event = trigger === undefined
    ? dialogueFocusNpcId !== undefined
      ? { kind: "dialogue" as const, focusNpcId: dialogueFocusNpcId }
      : npcLine !== null && proposal.choices.length === 2
        ? { kind: "dialogue" as const, focusNpcId: npcLine.npcId }
      : undefined
    : eventForTrigger(trigger);
  const npcDialogues = proposal.npcDialogues?.map((dialogue) => {
    const npc = worldState.npcs.find((candidate) => String(candidate.id) === dialogue.npcId);
    const text = normalizeNpcSpeech(dialogue.text, npc?.name);
    return {
      npcId: dialogue.npcId as never,
      npcName: npc?.name ?? dialogue.npcId,
      npcRole: npc?.role ?? "",
      speechPages: paginateSpeechText(text, NPC_SCENE_PAGE_CHAR_BUDGET),
      speechSource: "generated" as const,
      speechPurpose: dialogue.npcId === String(npcLine?.npcId) ? "focus" as const : "ambient" as const,
      usedFactIds: dialogue.usedFactIds.map(asFactId),
      usedEventIds: [...dialogue.usedEventIds],
    };
  });
  const expressionState = proposal.expressions === undefined
    ? undefined
    : approvedExpressions(parts.expressions, worldState);
  return {
    sceneId,
    turn,
    narration,
    usedFactIds: npcLine?.usedFactIds ?? [],
    npcLine,
    choices: [],
    source: "generated",
    ...(event === undefined ? {} : { event }),
    ...(proposal.handoffAcknowledgement === undefined
      ? {}
      : { handoffAcknowledgement: proposal.handoffAcknowledgement }),
    ...(npcDialogues === undefined ? {} : { npcDialogues }),
    ...(expressionState === undefined ? {} : { expressions: expressionState }),
  };
}

function buildStepState(
  proposal: BundleStepProposal,
  descriptor: BundleStepDescriptor,
  worldState: WorldState,
  currentEventIds: readonly import("@/game/domain/events").EventId[] = [],
): NarrativeBundleStepState | NarrativeBundleRejection {
  // The proposal stepKey must match the descriptor stepKey (after symbol resolution)
  if (proposal.stepKey !== descriptor.stepKey) {
    return "bundle_unknown_step";
  }
  const sceneLocationId = bundleSceneLocationId(descriptor.trigger, worldState);
  if (validateBundleSceneNpcSpeech(
    proposal.scene,
    worldState,
    descriptor.arrivalNpc?.id,
    presentNpcIdsAtLocation(worldState, sceneLocationId),
    currentEventIds,
  ) !== null) {
    return "bundle_invalid_scene";
  }

  const parts = normalizedSceneParts(proposal.scene);
  const event = eventForTrigger(descriptor.trigger);
  const normalizedNpcText = parts.npcLine === null
    ? null
    : normalizeNpcSpeech(parts.npcLine.text);
  const stageDirection = parts.npcLine !== null && normalizedNpcText === ""
    ? reclassifiedStageDirection(parts.npcLine.text)
    : "";
  const npcLine = parts.npcLine === null
    || normalizedNpcText === ""
    ? null
    : {
        npcId: parts.npcLine.npcId as never,
        text: normalizedNpcText!,
        emotion: parts.npcLine.emotion,
        usedFactIds: parts.npcLine.usedFactIds.map((id: string) => id as never),
        usedEventIds: [...parts.npcLine.usedEventIds],
        answeredBeatIds: [...parts.npcLine.answeredBeatIds],
      };

  const objectiveLink = proposal.scene.objectiveLink === null
    ? null
    : {
        questId: proposal.scene.objectiveLink.questId as never,
        objectiveIndex: proposal.scene.objectiveLink.objectiveIndex,
        mode: proposal.scene.objectiveLink.mode,
      };
  const npcDialogues = proposal.scene.npcDialogues?.map((dialogue) => {
    const npc = worldState.npcs.find((candidate) => String(candidate.id) === dialogue.npcId);
    const text = normalizeNpcSpeech(dialogue.text, npc?.name);
    return {
      npcId: dialogue.npcId as never,
      npcName: npc?.name ?? dialogue.npcId,
      npcRole: npc?.role ?? "",
      speechPages: paginateSpeechText(text, NPC_SCENE_PAGE_CHAR_BUDGET),
      speechSource: "generated" as const,
      speechPurpose: dialogue.npcId === String(npcLine?.npcId) ? "focus" as const : "ambient" as const,
      usedFactIds: dialogue.usedFactIds.map(asFactId),
      usedEventIds: [...dialogue.usedEventIds],
    };
  });

  // Build choice seeds from descriptor choice candidates and proposal choices
  const proposalChoiceMap = new Map(proposal.scene.choices.map((c: { candidateId: string; label: string }) => [c.candidateId, c.label]));
  const choiceSeeds = descriptor.choiceCandidates.map((candidate) => {
    const label = proposalChoiceMap.get(candidate.candidateId);
    if (label === undefined) return null;
    return { label, action: candidate.action };
  });
  if (choiceSeeds.some((seed) => seed === null)) {
    return "bundle_invalid_scene";
  }

  const scene: PreparedSceneSeedState = {
    segments: parts.segments.map((s, index) => ({
      beatId: s.beatId,
      text: stageDirection !== "" && index === parts.segments.length - 1
        ? `${s.text}\n${stageDirection}`
        : s.text,
      ...(s.referencedEntityIds === undefined ? {} : { referencedEntityIds: s.referencedEntityIds }),
    })),
    event,
    npcLine,
    ...(npcDialogues === undefined ? {} : { npcDialogues }),
    objectiveLink,
    choiceSeeds: choiceSeeds as NonNullable<typeof choiceSeeds[number]>[],
      source: "generated",
      ...(proposal.scene.expressions === undefined ? {} : { expressions: approvedExpressions(parts.expressions, worldState) }),
  };

  return {
    stepId: descriptor.stepKey,
    objectiveKey: descriptor.objectiveKey,
    consumptionGroupKey: descriptor.consumptionGroupKey,
    trigger: descriptor.trigger,
    scene,
    nextStepIds: [...descriptor.nextStepKeys],
  };
}

function resolveTerminalState(
  graph: BundleDescriptorGraph,
): NarrativeBundleTerminalState {
  const terminal = graph.terminal;
  if (terminal.kind === "ending") return { kind: "ending" };
  if (terminal.target.kind === "current_scene") {
    return { kind: "next_decision", target: { kind: "current_scene" } };
  }
  return {
    kind: "next_decision",
    target: { kind: "continuation_step", stepId: terminal.target.stepKey },
  };
}

function terminalsMatch(
  proposal: NarrativeBundleProposal["terminal"],
  graph: BundleDescriptorGraph["terminal"],
): boolean {
  if (proposal.kind !== graph.kind) return false;
  if (proposal.kind === "ending") return true;
  if (graph.kind === "ending") return false;
  if (proposal.target.kind !== graph.target.kind) return false;
  if (proposal.target.kind === "current_scene") return true;
  if (graph.target.kind !== "continuation_step") return false;
  return proposal.target.stepKey === graph.target.stepKey;
}

/** Provider aliases bind to an installed operation, never to an array position. */
function resolveInteractionChoiceAliases(
  scene: BundleSceneProposal,
  candidates: readonly BundleStepDescriptor["choiceCandidates"][number][],
  jobId: NarrativeJobId,
): BundleSceneProposal {
  return { ...scene, choices: scene.choices.map((choice) => {
    if (!choice.candidateId.startsWith("interaction:")) return choice;
    const interactionId = `interaction:${String(jobId)}:${choice.candidateId.slice("interaction:".length)}`;
    const candidate = candidates.find((candidate) => candidate.action.type === "talk"
      && candidate.action.interactionId === interactionId);
    return candidate === undefined ? choice : { ...choice, candidateId: candidate.candidateId };
  }) };
}

function hasExactChoiceCandidates(
  choices: BundleSceneProposal["choices"],
  candidates: readonly BundleStepDescriptor["choiceCandidates"][number][],
): boolean {
  if (choices.length !== 2 || candidates.length !== 2) return false;
  const choiceIds = choices.map((choice) => choice.candidateId);
  if (new Set(choiceIds).size !== 2) return false;
  const candidateIds = candidates.map((candidate) => candidate.candidateId);
  return candidateIds.every((candidateId) => choiceIds.includes(candidateId));
}

type SceneContentRejection = { readonly code: NarrativeBundleRejection; readonly detail?: string };

function validateBundleNpcSpeech(
  line: {
    readonly npcId: string;
    readonly audienceIds?: readonly string[];
    readonly usedFactIds: readonly string[];
    readonly usedEventIds: readonly string[];
  },
  worldState: WorldState,
  presentNpcIds?: ReadonlySet<string>,
  currentEventIds: readonly import("@/game/domain/events").EventId[] = [],
): SceneContentRejection | null {
  const visibleFactIds = entitiesOfKind(worldState.entityStore, "fact")
    .filter((fact) => fact.fact.discovered)
    .map((fact) => fact.core.id);
  const audienceIds = line.audienceIds ?? [String(PLAYER_ENTITY_ID)];
  if (audienceIds.length === 0) return { code: "bundle_invalid_scene", detail: "invalid_target" };


  for (const targetId of audienceIds) {
    if (!isValidNpcSpeechTarget(worldState.entityStore, targetId as never)) {
      return { code: "bundle_invalid_scene", detail: "invalid_target" };
    }
    if (targetId !== String(PLAYER_ENTITY_ID)
      && presentNpcIds !== undefined
      && !presentNpcIds.has(targetId)) {
      return { code: "bundle_invalid_scene", detail: "missing_speaker" };
    }
    const authority = buildNpcSpeechAuthority({
      store: worldState.entityStore,
      speakerNpcId: line.npcId as never,
      sceneVisibleFactIds: visibleFactIds,
      eventLedger: worldState.eventLedger,
      targetContext: { targetId: targetId as never, currentEventIds },
    });
    if (authority === null) return { code: "bundle_invalid_scene", detail: "missing_speaker" };
    const result = validateNpcSpeechReferences({
      authority,
      usedFactIds: line.usedFactIds,
      usedEventIds: line.usedEventIds,
      eventLedger: worldState.eventLedger,
      speakerNpcId: line.npcId as never,
    });
    if (!result.ok) return { code: "bundle_invalid_scene", detail: result.code };
  }
  return null;
}

function validateBundleSceneNpcSpeech(
  scene: BundleSceneProposal,
  worldState: WorldState,
  expectedNpcId?: string,
  presentNpcIds?: ReadonlySet<string>,
  currentEventIds: readonly import("@/game/domain/events").EventId[] = [],
): SceneContentRejection | null {
  const parts = normalizedSceneParts(scene);
  const dialogues = scene.npcDialogues ?? [];
  const expressionLines = parts.expressions.filter((expression): expression is Extract<SceneExpressionProposal, { readonly kind: "npc_line" }> => expression.kind === "npc_line");
  const legacySpeakers = scene.expressions === undefined
    ? [
        ...(parts.npcLine === null ? [] : [parts.npcLine.npcId]),
        ...dialogues.map((dialogue) => dialogue.npcId),
      ]
    : dialogues.map((dialogue) => dialogue.npcId);
  if (new Set(legacySpeakers).size !== legacySpeakers.length) {
    return { code: "bundle_invalid_scene", detail: "duplicate_speaker" };
  }
  const speakers = [
    ...expressionLines.map((line) => line.npcId),
    ...legacySpeakers,
  ];
  if (presentNpcIds !== undefined && speakers.some((npcId) => !presentNpcIds.has(npcId))) {
    return { code: "bundle_invalid_scene", detail: "missing_speaker" };
  }
  if (scene.expressions !== undefined) {
    let speechWorld = worldState;
    for (const line of expressionLines) {
      const rejection = validateBundleNpcSpeech(
        {
          npcId: line.npcId,
          audienceIds: line.audienceIds,
          usedFactIds: line.usedFactIds,
          usedEventIds: line.usedEventIds,
        },
        speechWorld,
        presentNpcIds,
        currentEventIds,
      );
      if (rejection !== null) return rejection;
      speechWorld = projectSceneSpeechKnowledge(speechWorld, line);
    }
  } else if (parts.npcLine !== null) {
    if (expectedNpcId !== undefined && parts.npcLine.npcId !== expectedNpcId) {
      return { code: "bundle_invalid_scene", detail: "missing_speaker" };
    }
    const rejection = validateBundleNpcSpeech(parts.npcLine, worldState, presentNpcIds, currentEventIds);
    if (rejection !== null) return rejection;
  }
  for (const dialogue of dialogues) {
    const rejection = validateBundleNpcSpeech({
      npcId: dialogue.npcId,
      usedFactIds: dialogue.usedFactIds,
      usedEventIds: dialogue.usedEventIds,
    }, worldState, presentNpcIds, currentEventIds);
    if (rejection !== null) return rejection;
  }
  return null;
}

/** Shared opening gate for the same ordered body used by decision bundles. */
export function validateNarrativeSceneExpressions(
  expressions: readonly ApprovedSceneExpression[],
  worldState: WorldState,
): SceneContentRejection | null {
  return validateBundleSceneNpcSpeech({
    expressions: expressions.map((expression): SceneExpressionProposal => expression.kind === "narration"
      ? {
          kind: "narration",
          beatId: expression.beatId,
          text: expression.text,
          referencedEntityIds: expression.referencedEntityIds,
        }
      : {
          kind: "npc_line",
          npcId: expression.npcId,
          audienceIds: expression.audienceIds,
          text: expression.text,
          emotion: expression.emotion,
          answeredBeatIds: expression.answeredBeatIds,
          usedFactIds: expression.usedFactIds,
          usedEventIds: expression.usedEventIds,
        }),
    objectiveLink: null,
    choices: [],
  }, worldState, undefined, presentNpcIdsAtLocation(worldState, String(worldState.currentLocationId)));
}

function presentNpcIdsAtLocation(worldState: WorldState, locationId: string): ReadonlySet<string> {
  return new Set(
    worldState.npcs
      .filter((npc) => String(npc.locationId) === locationId)
      .map((npc) => String(npc.id)),
  );
}

function bundleSceneLocationId(
  trigger: NarrativeBundleTrigger,
  worldState: WorldState,
): string {
  switch (trigger.kind) {
    case "move":
    case "explore":
      return String(trigger.locationId);
    case "give_item":
      return String(worldState.npcs.find((npc) => npc.id === trigger.npcId)?.locationId ?? worldState.currentLocationId);
    default:
      return String(worldState.currentLocationId);
  }
}

/**
 * 当前场景内容闸门：提案的 currentScene 必须直接承接本回合的规则结果。
 * 缺失时拒绝整包并回传细分拒因，由修复重试要求 provider 纠正，
 * 绝不让脱离当前情境的场景冒充成功写回。
 */
function validateCurrentSceneContent(input: {
  readonly scene: BundleSceneProposal;
  readonly mandatoryBeats: readonly MandatoryNarrativeBeat[];
  readonly currentEventIds: readonly import("@/game/domain/events").EventId[];
  readonly dialogueFocusNpcId: string | undefined;
  readonly transition: ObjectiveTransition;
  readonly worldState: WorldState;
}): SceneContentRejection | null {
  const { scene, mandatoryBeats, dialogueFocusNpcId, transition, worldState } = input;
  const parts = normalizedSceneParts(scene);

  // 节拍契约：强制节拍逐一覆盖（各恰好一次，顺序不限），
  // 不得自创节拍；最多追加一个 atmosphere 段且必须置于最后。
  const requiredBeats = mandatoryBeats.filter((beat) => beat.beatId !== ATMOSPHERE_BEAT_ID);
  const segmentBeatIds = parts.segments.map((segment) => segment.beatId);
  const allowedBeatIds = new Set([
    ...requiredBeats.map((beat) => beat.beatId),
    ATMOSPHERE_BEAT_ID,
  ]);
  for (const beatId of segmentBeatIds) {
    if (!allowedBeatIds.has(beatId)) {
      return { code: "invented_beat_id", detail: beatId };
    }
  }
  for (const beat of requiredBeats) {
    if (segmentBeatIds.filter((id) => id === beat.beatId).length !== 1) {
      return { code: "missing_mandatory_beat", detail: `${beat.beatId}（${beat.kind}）` };
    }
  }
  if (segmentBeatIds.filter((id) => id === ATMOSPHERE_BEAT_ID).length > 1) {
    return { code: "out_of_order_beats", detail: "至多一个 atmosphere 段" };
  }
  const atmosphereIndex = segmentBeatIds.indexOf(ATMOSPHERE_BEAT_ID);
  if (atmosphereIndex !== -1 && atmosphereIndex !== segmentBeatIds.length - 1) {
    return { code: "out_of_order_beats", detail: "atmosphere 段必须置于最后" };
  }

  // player_utterance 节拍必须由焦点 NPC 的台词显式应答。
  const utteranceBeat = mandatoryBeats.find((beat) => beat.kind === "player_utterance");
  if (utteranceBeat !== undefined) {
    const focusNpcId = utteranceBeat.subjectIds[0];
    if (
      parts.npcLine === null
      || parts.npcLine.npcId !== focusNpcId
      || !parts.npcLine.answeredBeatIds.includes(utteranceBeat.beatId)
    ) {
      return { code: "player_utterance_unanswered", detail: focusNpcId };
    }
  }

  // 正式对话决策点：两个选项都指向同一焦点 NPC 时，场景必须带该 NPC 的直接台词，
  // 玩家不能面对一组没有任何回应支撑的选项。
  if (dialogueFocusNpcId !== undefined && parts.npcLine === null) {
    return { code: "dialogue_focus_line_missing", detail: dialogueFocusNpcId };
  }

  // 台词说话人必须是世界内已存在的 NPC。
  if (
    parts.npcLine !== null
    && !worldState.npcs.some((npc) => String(npc.id) === parts.npcLine!.npcId)
  ) {
    return { code: "bundle_invalid_scene", detail: `npcLine 说话人 ${parts.npcLine.npcId} 不存在` };
  }
  if (dialogueFocusNpcId !== undefined
    && parts.npcLine !== null
    && parts.npcLine.npcId !== dialogueFocusNpcId) {
    return { code: "bundle_invalid_scene", detail: "missing_speaker" };
  }

  const speechRejection = validateBundleSceneNpcSpeech(
    scene,
    worldState,
    undefined,
    presentNpcIdsAtLocation(worldState, String(worldState.currentLocationId)),
    input.currentEventIds,
  );
  if (speechRejection !== null) return speechRejection;

  // objectiveLink 必须与权威 ObjectiveTransition 一致（无 after 时为 null）。
  const after = transition.after;
  if (after === null) {
    if (scene.objectiveLink !== null) {
      return { code: "objective_link_mismatch", detail: "after 为空时 objectiveLink 必须为 null" };
    }
  } else if (
    scene.objectiveLink === null
    || scene.objectiveLink.questId !== String(after.questId)
    || scene.objectiveLink.objectiveIndex !== after.objectiveIndex
  ) {
    return { code: "objective_link_mismatch", detail: `期望 ${String(after.questId)}:${after.objectiveIndex}` };
  }

  return null;
}

/** Current-scene symbols never inherit the NPC of a future travel slot. */
function currentSceneFocusNpcId(worldState: WorldState, storyState: StoryState, transition: ObjectiveTransition): string | undefined {
  const narrative = storyState.narrative;
  const jobFocus = narrative.status === "provider_pending" || narrative.status === "provider_failed" ? narrative.job.focusNpcId : undefined;
  const present = (id: string | undefined): boolean => id !== undefined && worldState.npcs.some((npc) => String(npc.id) === id
    && npc.locationId === worldState.currentLocationId && getEntity(worldState.entityStore, npc.id)?.core.lifecycle === "active");
  if (present(jobFocus)) return String(jobFocus);
  const graph = buildNarrativeBundleDescriptors({ worldState, storyState, transition });
  const choice = graph.currentChoiceCandidates.find((candidate) => candidate.action.type === "talk" && present(String(candidate.action.npcId)));
  return choice?.action.type === "talk" ? String(choice.action.npcId) : undefined;
}

/** Only the ordered current scene may cause knowledge changes. Future slots never enter this preview. */
export function previewNarrativeDisclosure(input: {
  scene: BundleSceneProposal; worldState: WorldState; storyState: StoryState;
  transition: ObjectiveTransition; source: { actionId: string; turnId: TurnId; turnNumber: number };
  currentEventIds?: readonly import("@/game/domain/events").EventId[];
  bindings?: import("@/game/domain/storyConsequenceBindings").StoryConsequenceBindingsProposal;
}) {
  const fail = (detail: string) => ({ ok: false as const, code: "bundle_invalid_scene" as const, detail });
  let { worldState } = input;
  const { storyState, source } = input;
  if (!input.scene.expressions?.some(line => line.kind === "npc_line" && line.usedFactIds.length > 0
    && line.audienceIds.some(id => id !== String(PLAYER_ENTITY_ID) && id !== line.npcId))) {
    return { ok: true as const, worldState, storyState, scene: input.scene, drafts: [] as NarrativeEventDraft[], transition: input.transition };
  }
  const focusNpcId = currentSceneFocusNpcId(worldState, storyState, input.transition);
  // Bind rules for existing entities before applying the current scene. Rules
  // involving newly minted entities are validated after delta materialization.
  const containsNewSymbol = (value: unknown): boolean => typeof value === "string" ? value.startsWith("@new.")
    : Array.isArray(value) ? value.some(containsNewSymbol)
      : value !== null && typeof value === "object" ? Object.values(value).some(containsNewSymbol) : false;
  const bindings = approveStoryConsequenceBindings({ proposal: (input.bindings ?? []).filter(binding => !containsNewSymbol(binding)),
    worldState, storyState, symbols: sceneSymbolBindings(worldState, undefined, focusNpcId) });
  if (!bindings.ok) return fail(`${bindings.code}:${bindings.path}`);
  worldState = bindings.worldState;
  const scene = resolveSceneExpressions(input.scene, worldState, undefined, focusNpcId);
  if (scene === null) return fail("current_scene_reference");
  const rejection = validateBundleSceneNpcSpeech(scene, worldState, undefined,
    presentNpcIdsAtLocation(worldState, String(worldState.currentLocationId)), input.currentEventIds ?? []);
  if (rejection !== null) return { ok: false as const, ...rejection };
  const consequences = previewSceneDisclosure({ worldState, storyState, expressions: sceneExpressionsOf(scene), source });
  if (!consequences.ok) return fail(consequences.code);
  if (consequences.drafts.length === 0) return { ...consequences, scene, transition: input.transition };
  return { ok: true as const, worldState: consequences.worldState, storyState: consequences.storyState, scene,
    drafts: consequences.drafts, transition: deriveObjectiveTransition({ beforeWorldState: worldState,
      beforeStoryState: storyState, afterWorldState: consequences.worldState, afterStoryState: consequences.storyState }) };
}

export function approveNarrativeBundle(
  input: ApproveNarrativeBundleInput,
): ApproveNarrativeBundleResult {
  const { proposal, jobId, basedOnRevision, now } = input;
  let { worldState, storyState, transition, evolutionNeed } = input;
  if (input.candidateReview !== undefined
    && (input.candidateVersion === undefined
      || input.candidateHash === undefined
      || input.candidateReview.candidateVersion !== input.candidateVersion
      || input.candidateReview.candidateHash !== input.candidateHash)) {
    return { ok: false, code: "STALE_CANDIDATE_REVIEW" };
  }
  const eventContext = input.eventContext ?? {
    turnId: asTurnId(String(jobId)),
    turnNumber: basedOnRevision,
    domainEventIds: [],
    episodeKey: String(jobId),
  };
  let worldEventDrafts: readonly NarrativeEventDraft[] = [];

  // Step 1: Parse the proposal
  const parsed = parseNarrativeBundleProposal(proposal);
  if (!parsed.ok) return { ok: false, code: "bundle_invalid_scene" };

  const disclosure = previewNarrativeDisclosure({ scene: proposal.currentScene, worldState, storyState, transition,
    bindings: [...((proposal.worldDelta as WorldDeltaProposal | null)?.consequenceBindings ?? []), ...(proposal.consequenceBindings ?? [])],
    source: { actionId: input.eventContext?.actionId ?? String(jobId), turnId: eventContext.turnId, turnNumber: eventContext.turnNumber },
    currentEventIds: eventContext.domainEventIds });
  if (!disclosure.ok) return disclosure;
  worldState = disclosure.worldState;
  storyState = disclosure.storyState;
  transition = disclosure.transition;
  worldEventDrafts = disclosure.drafts;
  if (disclosure.drafts.length > 0) evolutionNeed = deriveStructuralEvolutionNeed(worldState, storyState);
  if (disclosure.drafts.length > 0 && evolutionNeed.kind !== "none" && proposal.worldDelta === null) {
    return { ok: false, code: "world_delta_rejected", detail: `missing_${evolutionNeed.kind}_after_disclosure` };
  }

  // Step 2: Approve worldDelta (if present)
  let previewWorldState = worldState;
  let previewStoryState = storyState;
  let approvedDelta: ApprovedWorldDelta | undefined;

  if (proposal.worldDelta !== null) {
    const parsedDelta = proposal.worldDelta as WorldDeltaProposal;
    const duplicateDetail = duplicateNameDetail(parsedDelta, worldState);
    if (duplicateDetail !== undefined) {
      return { ok: false, code: "world_delta_rejected", detail: duplicateDetail };
    }
    const worldApproval = approveWorldDelta({
      proposal: parsedDelta,
      need: evolutionNeed,
      ws: worldState,
      ss: storyState,
      idOverride: input.idOverride,
      entityContextClosure: input.entityContextClosure,
    });
    if (!worldApproval.ok) {
      const duplicateName = worldApproval.code === "duplicate_name"
        ? (() => {
            const delta = parsedDelta;
            switch (worldApproval.reason) {
              case "npc": return delta.newNpc?.name;
              case "location": return delta.newLocation?.name;
              case "item": return delta.newItem?.name;
              case "enemy": return delta.newEnemy?.name;
              case "quest": return delta.nextMainQuest?.name;
              default: return undefined;
            }
          })()
        : undefined;
      return {
        ok: false,
        code: "world_delta_rejected",
        detail: `${worldApproval.code}:${worldApproval.reason}${duplicateName === undefined ? "" : `:${duplicateName}`}`,
      };
    }

    approvedDelta = materializeWorldDelta({
      approved: worldApproval.approved,
      need: evolutionNeed,
      ws: worldState,
      ss: storyState,
      now,
      eventContext,
    });
    previewWorldState = approvedDelta.previewWorldState;
    previewStoryState = approvedDelta.previewStoryState;
    worldEventDrafts = [...worldEventDrafts, ...approvedDelta.eventDrafts];
  }

  const consequenceBindings = approveStoryConsequenceBindings({
    proposal: [
      ...((proposal.worldDelta === null ? undefined : (proposal.worldDelta as WorldDeltaProposal).consequenceBindings) ?? []),
      ...(proposal.consequenceBindings ?? []),
    ],
    worldState: previewWorldState,
    storyState: previewStoryState,
    symbols: sceneSymbolBindings(previewWorldState, approvedDelta, undefined),
  });
  if (!consequenceBindings.ok) {
    return { ok: false, code: "bundle_invalid_reference", detail: `${consequenceBindings.code}:${consequenceBindings.path}` };
  }
  previewWorldState = consequenceBindings.worldState;
  previewStoryState = consequenceBindings.storyState;

  // Interaction definitions are compiled against the candidate preview, then
  // installed through the same atomic entity mutation language as all runtime
  // consequences. Provider ids remain local proposal keys until this point.
  const interactionFocusNpcId = (() => {
    const after = transition.after;
    if (after === null) return undefined;
    const quest = previewWorldState.quests.find((entry) => entry.id === after.questId);
    const objective = quest?.objectives[after.objectiveIndex];
    return objective?.kind === "talk_to_npc" ? String(objective.npcId) : undefined;
  })();
  const interactionBindings = sceneSymbolBindings(
    previewWorldState,
    approvedDelta,
    interactionFocusNpcId,
  );
  const interactionCompilation = compileInteractionProposals({
    worldState: previewWorldState,
    proposals: proposal.interactionProposals ?? [],
    jobId,
    bindings: interactionBindings,
  });
  if (!interactionCompilation.ok) {
    return { ok: false, code: "bundle_invalid_reference", detail: interactionCompilation.detail };
  }
  const installedInteractions = applyEntityMutations(previewWorldState, interactionCompilation.mutations);
  if (!installedInteractions.ok) {
    return { ok: false, code: "bundle_invalid_reference", detail: installedInteractions.code };
  }
  previewWorldState = installedInteractions.worldState;

  // Step 3: Build descriptors from preview state.  At a natural act boundary
  // the rule turn has no `after` objective yet; materializing the approved
  // next-act delta is what supplies that first objective.  Re-root the
  // descriptor projection at the server-owned reveal cursor so the newly
  // created arrival step is validated rather than being mistaken for an end.
  const nextActReveal = previewStoryState.reveal;
  const descriptorTransition: ObjectiveTransition = transition.after === null
    && evolutionNeed.kind === "next_act"
    && nextActReveal !== null
    && nextActReveal !== undefined
    ? {
        ...transition,
        after: {
          questId: nextActReveal.questId,
          objectiveIndex: nextActReveal.visibleObjectiveIndex,
          label: "next_act_arrival",
        },
        mode: "advanced_act",
      }
    : transition;
  // The candidate explicitly chooses which installed operations it presents.
  // Prioritize only those aliases for descriptor projection; preserve stored
  // interaction order/state and still evaluate every rule condition normally.
  const selectedInteractionIds = new Set([
    ...proposal.currentScene.choices,
    ...proposal.continuationScenes.flatMap((step) => step.scene.choices),
  ].filter((choice) => choice.candidateId.startsWith("interaction:"))
    .map((choice) => `interaction:${String(jobId)}:${choice.candidateId.slice("interaction:".length)}`));
  const descriptorWorld = selectedInteractionIds.size === 0 ? previewWorldState : {
    ...previewWorldState,
    entityStore: { ...previewWorldState.entityStore, records: previewWorldState.entityStore.records.map((record) => {
      if (record.core.kind !== "npc") return record;
      const npc = record as NpcEntityRecord;
      return npc.interactions === undefined ? npc : { ...npc, interactions: [...npc.interactions].sort((a, b) =>
        Number(selectedInteractionIds.has(b.id)) - Number(selectedInteractionIds.has(a.id))) };
    }) },
  };
  const deliveryReturn = previewStoryState.delivery;
  const returnItem = deliveryReturn === undefined ? undefined : getEntity(previewWorldState.entityStore, deliveryReturn.itemId);
  const returnGiver = deliveryReturn === undefined ? undefined : getEntity(previewWorldState.entityStore, deliveryReturn.giverNpcId);
  const returnOwner = returnItem?.core.kind === "item" ? (returnItem as import("@/game/domain/entity").ItemEntityRecord).possession.owner : undefined;
  const includeDeliveryReturn = deliveryReturn !== undefined
    && returnOwner?.kind === "player" && returnOwner.playerId === PLAYER_ENTITY_ID
    && returnGiver?.core.kind === "npc" && returnGiver.core.lifecycle === "active" && (returnGiver as NpcEntityRecord).position.locationId === previewWorldState.currentLocationId
    && proposal.continuationScenes.some((step) => step.stepKey === `give_item:${deliveryReturn.itemId}:${deliveryReturn.giverNpcId}`);
  const graph = buildNarrativeBundleDescriptors({
    worldState: descriptorWorld,
    storyState: previewStoryState,
    includeDeliveryReturn,
    includeObjectiveReturn: proposal.continuationScenes.some((step) => step.stepKey.startsWith("move:")),
    transition: descriptorTransition,
  });

  const symbolFocusNpcId = currentSceneFocusNpcId(previewWorldState, previewStoryState, descriptorTransition);
  let resolvedCurrentScene = resolveSceneExpressions(
    disclosure.scene,
    previewWorldState,
    approvedDelta,
    symbolFocusNpcId,
  );
  if (resolvedCurrentScene === null) return { ok: false, code: "bundle_invalid_scene" };
  const endingOutcomeStates = proposal.endingOutcomes?.map((outcome) => {
    const resolved = resolveSceneExpressions(outcome.scene, previewWorldState, approvedDelta, symbolFocusNpcId);
    const ending = previewWorldState.endings.find((candidate) => candidate.requirements.some((requirement) =>
      outcome.themeKey === "trust" ? requirement.kind === "npc_affinity_at_least" : requirement.kind === "npc_affinity_at_most"));
    if (resolved === null || ending === undefined || resolved.objectiveLink !== null
      || validateBundleSceneNpcSpeech(
        resolved,
        previewWorldState,
        undefined,
        presentNpcIdsAtLocation(previewWorldState, String(previewWorldState.currentLocationId)),
        eventContext.domainEventIds,
      ) !== null) return null;
    return {
      themeKey: outcome.themeKey,
      endingId: String(ending.id),
      choiceLabel: outcome.choiceLabel,
      scene: buildSceneFromProposal(resolved, `${`scene-${String(jobId)}`}-ending-${outcome.themeKey}`, previewStoryState.turnNumber, previewWorldState),
    };
  });
  if (endingOutcomeStates !== undefined && endingOutcomeStates.some((outcome) => outcome === null)) {
    return { ok: false, code: "bundle_invalid_scene", detail: "ending_outcomes_missing_or_misbound" };
  }
  resolvedCurrentScene = resolveInteractionChoiceAliases(resolvedCurrentScene, graph.currentChoiceCandidates, jobId);
  const resolvedContinuationScenes: BundleStepProposal[] = [];
  for (const proposalStep of proposal.continuationScenes) {
    const resolvedScene = resolveSceneExpressions(
      proposalStep.scene,
      previewWorldState,
      approvedDelta,
      symbolFocusNpcId,
    );
    if (resolvedScene === null) return { ok: false, code: "bundle_invalid_scene" };
    resolvedContinuationScenes.push({ ...proposalStep, scene: resolveInteractionChoiceAliases(
      resolvedScene, graph.steps.find((step) => step.stepKey === proposalStep.stepKey)?.choiceCandidates ?? [], jobId,
    ) });
  }

  // Step 4: Validate coverage
  const coverage = validateNarrativeBundleCoverage(graph);
  if (!coverage.ok) {
    return { ok: false, code: coverage.code };
  }

  // Step 5: Resolve continuation scenes against descriptors
  const descriptorByKey = new Map(graph.steps.map((d) => [d.stepKey, d]));
  const stepStates: NarrativeBundleStepState[] = [];

  // Check for duplicate step keys in proposal
  const proposalStepKeys = proposal.continuationScenes.map((s) => s.stepKey);
  if (new Set(proposalStepKeys).size !== proposalStepKeys.length) {
    return { ok: false, code: "bundle_duplicate_step" };
  }

  // Check every proposal step has a matching descriptor
  for (const [index, proposalStep] of proposal.continuationScenes.entries()) {
    const descriptor = descriptorByKey.get(proposalStep.stepKey);
    if (descriptor === undefined) {
      return { ok: false, code: "bundle_unknown_step" };
    }
    const resolvedStep = resolvedContinuationScenes[index]!;
    const stepResult = buildStepState(
      { ...proposalStep, scene: resolvedStep.scene! },
      descriptor,
      previewWorldState,
      eventContext.domainEventIds,
    );
    if (typeof stepResult === "string") {
      return { ok: false, code: stepResult };
    }
    stepStates.push(stepResult);
  }

  // Check every descriptor has a matching proposal step
  for (const descriptor of graph.steps) {
    if (!proposalStepKeys.includes(descriptor.stepKey)) {
      return { ok: false, code: "bundle_missing_step" };
    }
  }

  // The terminal step is the next formal dialogue boundary: it must carry the
  // arrival NPC's direct line, otherwise players face choices without speech.
  if (graph.terminal.kind === "next_decision" && graph.terminal.target.kind === "continuation_step") {
    const targetStepKey = graph.terminal.target.stepKey;
    const terminalDescriptor = descriptorByKey.get(targetStepKey);
    const terminalProposal = resolvedContinuationScenes.find((step) => step.stepKey === targetStepKey);
    // A written stage direction still counts as authored content (it is
    // reclassified into narration); only a fully omitted line is rejected.
    if (
      terminalDescriptor?.arrivalNpc !== undefined
      && (terminalProposal === undefined
        || normalizedSceneParts(terminalProposal.scene).npcLine === null
        || normalizedSceneParts(terminalProposal.scene).npcLine!.npcId !== terminalDescriptor.arrivalNpc.id)
    ) {
      return { ok: false, code: "dialogue_focus_line_missing", detail: String(terminalDescriptor.arrivalNpc.id) };
    }
  }

  if (!terminalsMatch(proposal.terminal, graph.terminal)) {
    return { ok: false, code: "bundle_invalid_terminal" };
  }

  // Step 6: Build current scene
  const sceneId = `scene-${String(jobId)}`;
  const firstCurrentChoice = graph.currentChoiceCandidates[0];
  const currentDialogueFocusNpcId = graph.terminal.kind === "next_decision"
    && graph.terminal.target.kind === "current_scene"
    && graph.currentChoiceCandidates.length === 2
    && graph.currentChoiceCandidates.every((candidate) => candidate.action.type === "talk")
    && firstCurrentChoice?.action.type === "talk"
    ? firstCurrentChoice.action.npcId
    : undefined;
  const contentRejection = validateCurrentSceneContent({
    scene: resolvedCurrentScene,
    currentEventIds: eventContext.domainEventIds,
    mandatoryBeats: input.mandatoryBeats,
    dialogueFocusNpcId: currentDialogueFocusNpcId === undefined
      ? undefined
      : String(currentDialogueFocusNpcId),
    transition,
    worldState: previewWorldState,
  });
  if (contentRejection !== null) {
    return { ok: false, code: contentRejection.code, ...(contentRejection.detail === undefined ? {} : { detail: contentRejection.detail }) };
  }
  const currentScene = buildSceneFromProposal(
    resolvedCurrentScene,
    sceneId,
    basedOnRevision,
    previewWorldState,
    undefined,
    currentDialogueFocusNpcId,
  );

  // Step 7: Build choice registry from terminal
  const choiceRegistry: ApprovedChoice[] = [];
  const terminal = graph.terminal;

  if (terminal.kind === "next_decision" && terminal.target.kind === "continuation_step") {
    const targetStepKey = terminal.target.stepKey;
    const terminalDescriptor = descriptorByKey.get(targetStepKey);
    if (terminalDescriptor === undefined) {
      return { ok: false, code: "bundle_invalid_terminal" };
    }
    const terminalProposal = resolvedContinuationScenes
      .find((step) => step.stepKey === targetStepKey);
    if (terminalProposal === undefined
      || !hasExactChoiceCandidates(terminalProposal.scene.choices, terminalDescriptor.choiceCandidates)) {
      return { ok: false, code: "bundle_invalid_scene" };
    }
    const proposalChoiceMap = new Map(terminalProposal.scene.choices
      .map((choice) => [choice.candidateId, choice.label]));
    for (const candidate of terminalDescriptor.choiceCandidates) {
      const label = proposalChoiceMap.get(candidate.candidateId);
      if (label === undefined) {
        return { ok: false, code: "bundle_invalid_scene" };
      }
      const approved = createApprovedChoice({
        sceneId: `${sceneId}-${targetStepKey}`,
        basedOnRevision,
        label,
        action: candidate.action,
      });
      if (!approved.ok) {
        return { ok: false, code: "bundle_invalid_scene" };
      }
      choiceRegistry.push(approved.choice);
    }
  } else if (terminal.kind === "next_decision" && terminal.target.kind === "current_scene") {
    if (!hasExactChoiceCandidates(resolvedCurrentScene.choices, graph.currentChoiceCandidates)) {
      return { ok: false, code: "bundle_invalid_scene" };
    }
    const proposalChoiceMap = new Map(resolvedCurrentScene.choices
      .map((choice) => [choice.candidateId, choice.label]));
    for (const matchingCandidate of graph.currentChoiceCandidates) {
      const label = proposalChoiceMap.get(matchingCandidate.candidateId);
      if (label === undefined) return { ok: false, code: "bundle_invalid_scene" };
      const approved = createApprovedChoice({
        sceneId,
        basedOnRevision,
        label,
        action: matchingCandidate.action,
      });
      if (!approved.ok) {
        return { ok: false, code: "bundle_invalid_scene" };
      }
      choiceRegistry.push(approved.choice);
    }
  }

  // Build the final bundle state
  const terminalState = resolveTerminalState(graph);
  const bundle: NarrativeBundleState = {
    contractVersion: 3,
    originJobId: jobId,
    ...(input.candidateVersion === undefined || input.candidateHash === undefined
      ? {}
      : { candidateVersion: input.candidateVersion, candidateHash: input.candidateHash }),
    steps: stepStates,
    activeStepIds: [...graph.activeStepKeys],
    ...(endingOutcomeStates === undefined ? {} : { endingOutcomes: endingOutcomeStates.filter((outcome): outcome is NonNullable<typeof outcome> => outcome !== null) }),
    terminal: terminalState,
  };

  // Build the current scene with choices if terminal is current_scene
  const finalScene: NarrativeSceneState = terminal.kind === "next_decision" && terminal.target.kind === "current_scene"
    ? {
        ...currentScene,
        choices: choiceRegistry.map((c) => ({
          choiceToken: c.choiceToken,
          label: c.label,
        })),
      }
    : currentScene;

  return {
    ok: true,
    approved: {
      objectiveTransition: descriptorTransition,
      nextWorldState: previewWorldState,
      nextStoryStatePreview: previewStoryState,
      currentScene: finalScene,
      choiceRegistry,
      bundle,
      candidateEventPool: [],
      eventDrafts: [
        ...worldEventDrafts,
        buildNarrativeScenePresentedDraft({
          turnId: eventContext.turnId,
          domainEventIds: eventContext.domainEventIds,
          currentLocationId: previewWorldState.currentLocationId,
          nextPacingNeed: previewStoryState.nextPacingNeed,
          mandatoryBeats: input.mandatoryBeats,
          objectiveTransition: transition,
          scene: finalScene,
        }),
      ],
    },
  };
}
