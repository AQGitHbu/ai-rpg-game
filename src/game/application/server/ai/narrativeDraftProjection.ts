import type { SceneStructuralIssue } from "@/game/domain/sceneExpression";
import { getEntity, projectEntityStore, type NpcEntityRecord } from "@/game/domain/entity";
import type { NarrativeBundleTerminal, NarrativeBundleTrigger } from "@/game/domain/narrativeBundle";
import { asLocationId, asNpcId } from "@/game/domain/worldEntity";
import { findNpc } from "@/game/domain/worldState";
import type { PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import type { StoryState } from "@/game/domain/storyState";
import type { WorldState } from "@/game/domain/worldState";
import { buildNarrativeBundleDescriptors, hasPendingDeliveryEvidenceClosure, isP3EvidenceClosureContract, narrativeBundleTriggerKey } from "@/game/gameplay/rpg/narrativeBundle";
import { projectEndingResolutions } from "./endingResolutionProjection";
import { previewNarrativeDisclosure } from "../../approveNarrativeBundle";
import { parseNarrativeBundleProposal } from "@/game/domain/narrativeBundle";
import { asTurnId } from "@/game/domain/events";
import { isStoryConsequenceBindingsProposal } from "@/game/domain/storyConsequenceBindings";

export type NarrativeDraftContext = Readonly<{
  worldState: WorldState;
  storyState: StoryState;
  job: Pick<PendingNarrativeJob, "objectiveTransition" | "actionSummary"> & Partial<Pick<PendingNarrativeJob, "turnId" | "actionId" | "turnNumber" | "domainEventIds">>;
  includeDeliveryReturn?: boolean;
  includeObjectiveReturn?: boolean;
}>;

/** A continuation is displayed after this rule trigger, not before the action. */
export function narrativeSlotResolution(trigger: NarrativeBundleTrigger) {
  const settledOutcome = (() => {
    switch (trigger.kind) {
      case "move": return `玩家已经抵达 ${trigger.locationId}，不是尚待出发。`;
      case "take_item": return `物品 ${trigger.itemId} 已由规则交给玩家持有；不能仍写成留在原处、等待拾取或禁止玩家伸手。`;
      case "give_item": return `玩家已将物品 ${trigger.itemId} 交给 ${trigger.npcId}，不能仍写成尚未交付。`;
      case "battle_started": return `与 ${trigger.enemyId} 的战斗已开始，尚未判定胜负。`;
      case "battle_resolved": return `玩家已战胜 ${trigger.enemyId}，胜利已经结算，而非仍在等待开战。`;
      case "investigate": return `玩家已完成对 ${trigger.factId} 的核验，按该步骤授权事实回应结果。`;
      case "explore": return `玩家已在 ${trigger.locationId} 完成该次探索，按该步骤授权事实回应结果。`;
    }
  })();
  return { displayTiming: "after_successful_trigger" as const, trigger, settledOutcome };
}

/** This projection owns routing only. Every word and action label remains authored. */
export function projectNarrativeDraft(input: NarrativeDraftContext) {
  const worldState = { ...input.worldState, ...projectEntityStore(input.worldState.entityStore) };
  const p3EvidenceClosureSettled = isP3EvidenceClosureContract(worldState)
    && input.storyState.delivery !== undefined
    && worldState.eventLedger.some((event) => event.outcome === "success"
      && event.payload.type === "fact_discovered" && event.payload.evidenceQuality !== undefined)
    && !hasPendingDeliveryEvidenceClosure(worldState, input.storyState);
  const descriptorGraph = buildNarrativeBundleDescriptors({
    worldState, storyState: input.storyState, transition: input.job.objectiveTransition,
    includeDeliveryReturn: input.includeDeliveryReturn,
    includeObjectiveReturn: input.includeObjectiveReturn ?? p3EvidenceClosureSettled,
  });
  const ending = (input.storyState.evolution.status === "needs_ending_pair" && worldState.endings.length < 2)
    || (input.storyState.endingAllowed && worldState.endings.length >= 2)
    || input.job.actionSummary.kind === "abandon_quest";
  const nextActProjection = !ending && input.storyState.evolution.status === "needs_next_act"
    ? { locationId: `loc_dyn_${input.storyState.evolution.nextLocationOrdinal}`, npcId: `npc_dyn_${input.storyState.evolution.nextNpcOrdinal}` }
    : null;
  const closureGiver = input.storyState.delivery === undefined
    ? undefined
    : findNpc(worldState, input.storyState.delivery.giverNpcId);
  const evidenceClosurePending = nextActProjection !== null
    && hasPendingDeliveryEvidenceClosure(worldState, input.storyState)
    && closureGiver !== undefined;
  const nextActReturnToGiver = nextActProjection !== null
    && evidenceClosurePending
    && closureGiver !== undefined
    && closureGiver.locationId !== worldState.currentLocationId;
  const nextActAtGiver = evidenceClosurePending
    && closureGiver!.locationId === worldState.currentLocationId;
  // The next-act NPC is bound by materialization to the final recipient. Keep
  // the author/compiler slots identical to that approval preview's move/give
  // graph, before the new entity exists in the current store.
  const nextActDelivery = nextActProjection !== null
    && input.storyState.currentAct >= input.storyState.targetActs
    && input.storyState.contract.delivery !== undefined
    && input.storyState.delivery !== undefined
    && worldState.inventory.includes(input.storyState.delivery.itemId)
    ? { kind: "give_item" as const, itemId: input.storyState.delivery.itemId, npcId: asNpcId(nextActProjection.npcId) }
    : null;
  const nextActTriggers: readonly NarrativeBundleTrigger[] = nextActProjection === null || nextActAtGiver ? [] : nextActReturnToGiver
    ? [{ kind: "move", locationId: closureGiver!.locationId }]
    : [
      { kind: "move", locationId: asLocationId(nextActProjection.locationId) },
      ...(nextActDelivery === null ? [] : [nextActDelivery]),
    ];
  const nextActStepNpcIds = nextActTriggers.map((trigger) =>
    nextActReturnToGiver && trigger.kind === "move" ? String(closureGiver!.id) : nextActProjection?.npcId ?? "",
  );
  const stepKeys = ending ? [] : nextActProjection === null
    ? descriptorGraph.steps.map(step => step.stepKey) : [
      ...nextActTriggers.map((trigger) => narrativeBundleTriggerKey(trigger)),
    ];
  // A next-act delta can be generated while the evidence contract still
  // requires a return to the original giver. The current scene must remain a
  // real decision boundary so share/verify can complete before later travel.
  const nextActGiverDecision = nextActProjection !== null && nextActAtGiver;
  const terminal: NarrativeBundleTerminal = ending ? { kind: "ending" } : nextActGiverDecision
    ? { kind: "next_decision", target: { kind: "current_scene" } }
    : nextActProjection === null || stepKeys.length === 0
      ? descriptorGraph.terminal
      : { kind: "next_decision", target: { kind: "continuation_step", stepKey: stepKeys.at(-1)! } };
  return { descriptorGraph, nextActProjection, stepKeys, terminal,
    nextActStepNpcIds,
    endingResolutions: ending && input.job.actionSummary.kind !== "abandon_quest"
      ? projectEndingResolutions(worldState, input.storyState) : [],
    slots: ["current", ...stepKeys].map((slotKey, index) => ({
      slotKey,
      resolution: slotKey === "current" ? null : narrativeSlotResolution(nextActProjection !== null
        ? nextActTriggers[index - 1]!
        : descriptorGraph.steps.find(step => step.stepKey === slotKey)!.trigger),
      choiceCount: terminal.kind === "next_decision"
        && (terminal.target.kind === "current_scene" ? slotKey === "current" : slotKey === terminal.target.stepKey) ? 2 : 0,
    })),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function normalizeLegacyObjectiveLink(value: unknown, worldState: WorldState): unknown {
  const link = record(value);
  if (link === null
    || !worldState.quests.some((quest) => String(quest.id) === link.questId)
    || typeof link.objectiveIndex !== "number"
    || (link.mode !== "hint" && link.mode !== "progress")) return null;
  return link;
}

function p3EvidenceGoalBinding(context: NarrativeDraftContext, raw: Record<string, unknown>): Record<string, unknown> | null {
  const worldState = { ...context.worldState, ...projectEntityStore(context.worldState.entityStore) };
  if (!isP3EvidenceClosureContract(worldState) || !hasPendingDeliveryEvidenceClosure(worldState, context.storyState)) return null;
  const delivery = context.storyState.delivery;
  if (delivery === undefined) return null;
  const evidenceFactId = worldState.eventLedger.find((event) => event.outcome === "success"
    && event.payload.type === "fact_discovered" && event.payload.evidenceQuality !== undefined)?.payload;
  if (evidenceFactId?.type !== "fact_discovered") return null;
  const giver = getEntity(worldState.entityStore, delivery.giverNpcId);
  if (giver?.core.kind !== "npc") return null;
  const goals = (giver as NpcEntityRecord).dynamicState.goals;
  const goalOrdinal = goals.findIndex((goal) => goal.status === "active" && goal.resolution === undefined);
  if (goalOrdinal < 0) return null;
  const existingBindings = [
    ...(Array.isArray(record(raw.worldDelta)?.consequenceBindings) ? record(raw.worldDelta)!.consequenceBindings as unknown[] : []),
    ...(Array.isArray(raw.consequenceBindings) ? raw.consequenceBindings : []),
  ];
  if (existingBindings.some((entry) => {
    const binding = record(entry);
    return binding?.kind === "bind_goal_resolution"
      && String(binding.npcRef) === String(delivery.giverNpcId)
      && binding.goalOrdinal === goalOrdinal;
  })) return null;
  return {
    kind: "bind_goal_resolution",
    npcRef: String(delivery.giverNpcId),
    goalOrdinal,
    resolution: {
      completeWhen: [{ kind: "knows_fact", actorId: String(delivery.giverNpcId), factId: String(evidenceFactId.factId) }],
      blockWhen: [],
    },
  };
}

export function compileNarrativeDraft(value: unknown, context: NarrativeDraftContext):
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly code: string; readonly path: string; readonly allowedKeys?: readonly string[] } {
  const fail = (code: string, path: string) => ({ ok: false as const, code, path });
  const raw = record(value);
  if (raw === null) return fail("invalid_draft", "$");
  const unknownKey = Object.keys(raw).find(key => !["worldDelta", "consequenceBindings", "sceneDrafts", "endingOutcomes", "interactionProposals", "graph"].includes(key));
  if (unknownKey !== undefined) return fail("unknown_field", `$.${unknownKey}`);
  if (raw.graph !== undefined && (typeof raw.graph !== "string" || !["default", "return_delivery", "objective_return"].includes(raw.graph))) return fail("unknown_graph", "$.graph");
  if (!Array.isArray(raw.sceneDrafts)) return fail("invalid_slots", "$.sceneDrafts");
  const keys = new Set<string>();
  for (const [index, value] of raw.sceneDrafts.entries()) {
    const entry = record(value);
    if (entry === null || typeof entry.slotKey !== "string" || record(entry.scene) === null) return fail("invalid_slot", `$.sceneDrafts[${index}]`);
    if (keys.has(entry.slotKey)) return fail("duplicate_slot", `$.sceneDrafts[${index}].slotKey`);
    keys.add(entry.slotKey);
  }
  const current = record(raw.sceneDrafts.find(value => record(value)?.slotKey === "current"))?.scene;
  if (current === undefined) return fail("missing_slot", "$.sceneDrafts[slotKey=current]");
  if (record(current)?.expressions !== undefined) {
    // Only validate the body here. Actual choice cardinality belongs to the
    // routing computed below, and a legal draft may already have two choices.
    let structuralIssue: SceneStructuralIssue | undefined;
    const parsed = parseNarrativeBundleProposal({ worldDelta: null, currentScene: { ...record(current), choices: [] }, continuationScenes: [], terminal: { kind: "ending" } }, issue => { structuralIssue ??= issue; });
    if (!parsed.ok) {
      if (structuralIssue !== undefined) {
        const index = raw.sceneDrafts.findIndex(entry => record(entry)?.slotKey === "current");
        return { ...fail("unknown_field", structuralIssue.path.replace("$.currentScene", `$.sceneDrafts[${index}].scene`)), allowedKeys: structuralIssue.allowedKeys };
      }
      return fail("invalid_current_scene", "$.sceneDrafts[slotKey=current].scene");
    }
    const bindings = [...(Array.isArray(record(raw.worldDelta)?.consequenceBindings) ? record(raw.worldDelta)!.consequenceBindings as unknown[] : []), ...(Array.isArray(raw.consequenceBindings) ? raw.consequenceBindings : [])];
    if (!isStoryConsequenceBindingsProposal(bindings)) return fail("invalid_bindings", "$.consequenceBindings");
    const preview = previewNarrativeDisclosure({ scene: parsed.proposal.currentScene,
      bindings,
      worldState: context.worldState, storyState: context.storyState, transition: context.job.objectiveTransition,
      source: { turnId: context.job.turnId ?? asTurnId("draft-preview"), actionId: context.job.actionId ?? "draft-preview", turnNumber: context.job.turnNumber ?? context.storyState.turnNumber },
      currentEventIds: context.job.domainEventIds });
    if (!preview.ok) return fail(preview.detail ?? preview.code, "$.sceneDrafts[slotKey=current].scene");
    context = { ...context, worldState: preview.worldState, storyState: preview.storyState,
      job: { ...context.job, objectiveTransition: preview.transition } };
  }
  const projection = projectNarrativeDraft({ ...context,
    includeDeliveryReturn: raw.graph === "return_delivery" ? true : raw.graph === undefined ? undefined : false,
    includeObjectiveReturn: raw.graph === "objective_return" ? true : raw.graph === undefined ? undefined : false,
  });
  if ((raw.graph === "return_delivery" || raw.graph === "objective_return")
    && JSON.stringify(projection.stepKeys) === JSON.stringify(projectNarrativeDraft({ ...context, includeDeliveryReturn: false, includeObjectiveReturn: false }).stepKeys)) {
    return fail("unavailable_graph", "$.graph");
  }
  if (!Array.isArray(raw.sceneDrafts)) return fail("invalid_slots", "$.sceneDrafts");
  // Providers sometimes keep the pre-return scene in `current` and put the
  // actual giver conversation in a synthetic `move:<current location>` slot.
  // During the P3 evidence closure this move is already physically complete:
  // the player is at the giver's location and the descriptor graph exposes a
  // current-scene decision. Promote that authored scene into current so the
  // rules can continue to the share/verify interaction instead of rejecting
  // an otherwise usable candidate as an unavailable extra move.
  let draftEntries = raw.sceneDrafts;
  const currentSlot = raw.sceneDrafts.find(value => record(value)?.slotKey === "current");
  const currentSlotScene = record(currentSlot)?.scene;
  const currentChoices = record(currentSlotScene)?.choices;
  const p3CurrentDecision = hasPendingDeliveryEvidenceClosure(context.worldState, context.storyState)
    && projection.terminal.kind === "next_decision"
    && projection.terminal.target.kind === "current_scene"
    && projection.slots.length === 1
    && Array.isArray(currentChoices)
    && currentChoices.length === 0;
  if (p3CurrentDecision) {
    const returnSlotKey = `move:${String(context.worldState.currentLocationId)}`;
    const returnSlot = raw.sceneDrafts.find(value => record(value)?.slotKey === returnSlotKey);
    const returnScene = record(returnSlot)?.scene;
    const returnChoices = record(returnScene)?.choices;
    if (returnSlot !== undefined && Array.isArray(returnChoices) && returnChoices.length === 2) {
      draftEntries = [
        { slotKey: "current", scene: returnScene },
      ];
    }
  }
  const byKey = new Map<string, unknown>();
  for (let index = 0; index < draftEntries.length; index += 1) {
    const entry = record(draftEntries[index]);
    if (entry === null || typeof entry.slotKey !== "string" || record(entry.scene) === null) return fail("invalid_slot", `$.sceneDrafts[${index}]`);
    const extra = Object.keys(entry).find(key => key !== "slotKey" && key !== "scene");
    if (extra !== undefined) return fail("unknown_field", `$.sceneDrafts[${index}].${extra}`);
    const slot = projection.slots.find(slot => slot.slotKey === entry.slotKey);
    if (slot === undefined) return fail("unknown_slot", `$.sceneDrafts[${index}].slotKey`);
    if (byKey.has(entry.slotKey)) return fail("duplicate_slot", `$.sceneDrafts[${index}].slotKey`);
    const scene = record(entry.scene)!;
    if (!Array.isArray(scene.choices) || scene.choices.length !== slot.choiceCount) return fail("invalid_choice_count", `$.sceneDrafts[${index}].scene.choices`);
    const npcLine = record(scene.npcLine);
    const normalizedScene = scene.expressions === undefined
      ? { ...scene, objectiveLink: normalizeLegacyObjectiveLink(scene.objectiveLink, context.worldState) }
      : scene;
    byKey.set(entry.slotKey, npcLine === null ? normalizedScene : { ...normalizedScene, npcLine: {
      emotion: "neutral", answeredBeatIds: [], usedFactIds: [], usedEventIds: [], ...npcLine,
    } });
  }
  const missing = projection.slots.find(slot => !byKey.has(slot.slotKey));
  if (missing !== undefined) return fail("missing_slot", `$.sceneDrafts[slotKey=${missing.slotKey}]`);
  let endingOutcomes: unknown = undefined;
  if (projection.terminal.kind === "ending" && context.job.actionSummary.kind !== "abandon_quest") {
    if (!Array.isArray(raw.endingOutcomes) || raw.endingOutcomes.length !== 2) {
      const delta = record(raw.worldDelta);
      if (typeof delta?.beatSummary === "string" && delta.beatSummary.trim() !== "" || context.worldState.endings.length >= 2) {
        return fail("invalid_ending_outcomes", "$.endingOutcomes");
      }
    } else {
    const themes = new Set<string>();
    const normalized = [];
    for (let index = 0; index < raw.endingOutcomes.length; index += 1) {
      const outcome = record(raw.endingOutcomes[index]);
      if (outcome === null || !["trust", "doubt"].includes(String(outcome.themeKey))
        || typeof outcome.choiceLabel !== "string" || outcome.choiceLabel.trim() === ""
        || record(outcome.scene) === null) return fail("invalid_ending_outcome", `$.endingOutcomes[${index}]`);
      const extra = Object.keys(outcome).find(key => !["themeKey", "choiceLabel", "scene"].includes(key));
      if (extra !== undefined) return fail("unknown_field", `$.endingOutcomes[${index}].${extra}`);
      if (themes.has(String(outcome.themeKey))) return fail("duplicate_ending_theme", `$.endingOutcomes[${index}].themeKey`);
      themes.add(String(outcome.themeKey));
      const scene = record(outcome.scene)!;
      if (!Array.isArray(scene.choices) || scene.choices.length !== 0) return fail("invalid_choice_count", `$.endingOutcomes[${index}].scene.choices`);
      const npcLine = record(scene.npcLine);
      normalized.push({ themeKey: outcome.themeKey, choiceLabel: outcome.choiceLabel, scene: npcLine === null ? outcome.scene : { ...scene, npcLine: {
        emotion: "neutral", answeredBeatIds: [], usedFactIds: [], usedEventIds: [], ...npcLine,
      } } });
    }
      endingOutcomes = normalized;
    }
  } else if (raw.endingOutcomes !== undefined) return fail("unexpected_ending_outcomes", "$.endingOutcomes");
  if (!("worldDelta" in raw)) return fail("missing_field", "$.worldDelta");
  const delta = record(raw.worldDelta);
  const location = record(delta?.newLocation);
  const worldDelta = location?.connectFromLocationId === "@current.location"
    ? { ...delta, newLocation: { ...location, connectFromLocationId: String(context.worldState.currentLocationId) } }
    : raw.worldDelta;
  const automaticP3GoalBinding = p3EvidenceGoalBinding(context, raw);
  const consequenceBindings = automaticP3GoalBinding === null
    ? raw.consequenceBindings
    : [...(Array.isArray(raw.consequenceBindings) ? raw.consequenceBindings : []), automaticP3GoalBinding];
  return { ok: true, value: {
    worldDelta,
    ...(consequenceBindings === undefined ? {} : { consequenceBindings }),
    ...(raw.interactionProposals === undefined ? {} : { interactionProposals: raw.interactionProposals }),
    currentScene: byKey.get("current"),
    continuationScenes: projection.stepKeys.map(stepKey => ({ stepKey, scene: byKey.get(stepKey) })),
    ...(endingOutcomes === undefined ? {} : { endingOutcomes }),
    terminal: projection.terminal,
  } };
}
