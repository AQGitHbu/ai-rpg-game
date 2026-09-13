import { projectEntityStore } from "@/game/domain/entity";
import type { NarrativeBundleTerminal, NarrativeBundleTrigger } from "@/game/domain/narrativeBundle";
import { asLocationId } from "@/game/domain/worldEntity";
import type { PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import type { StoryState } from "@/game/domain/storyState";
import type { WorldState } from "@/game/domain/worldState";
import { buildNarrativeBundleDescriptors } from "@/game/gameplay/rpg/narrativeBundle";

export type NarrativeDraftContext = Readonly<{
  worldState: WorldState;
  storyState: StoryState;
  job: Pick<PendingNarrativeJob, "objectiveTransition" | "actionSummary">;
  includeDeliveryReturn?: boolean;
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
  const descriptorGraph = buildNarrativeBundleDescriptors({
    worldState, storyState: input.storyState, transition: input.job.objectiveTransition,
    includeDeliveryReturn: input.includeDeliveryReturn,
  });
  const ending = (input.storyState.evolution.status === "needs_ending_pair" && worldState.endings.length < 2)
    || (input.storyState.endingAllowed && worldState.endings.length >= 2)
    || input.job.actionSummary.kind === "abandon_quest";
  const nextActProjection = !ending && input.storyState.evolution.status === "needs_next_act"
    ? { locationId: `loc_dyn_${input.storyState.evolution.nextLocationOrdinal}`, npcId: `npc_dyn_${input.storyState.evolution.nextNpcOrdinal}` }
    : null;
  const stepKeys = ending ? [] : nextActProjection === null
    ? descriptorGraph.steps.map(step => step.stepKey) : [`move:${nextActProjection.locationId}`];
  const terminal: NarrativeBundleTerminal = ending ? { kind: "ending" } : nextActProjection === null
    ? descriptorGraph.terminal
    : { kind: "next_decision", target: { kind: "continuation_step", stepKey: stepKeys[0]! } };
  return { descriptorGraph, nextActProjection, stepKeys, terminal,
    slots: ["current", ...stepKeys].map(slotKey => ({
      slotKey,
      resolution: slotKey === "current" ? null : narrativeSlotResolution(nextActProjection !== null
        ? { kind: "move", locationId: asLocationId(nextActProjection.locationId) }
        : descriptorGraph.steps.find(step => step.stepKey === slotKey)!.trigger),
      choiceCount: terminal.kind === "next_decision"
        && (terminal.target.kind === "current_scene" ? slotKey === "current" : slotKey === terminal.target.stepKey) ? 2 : 0,
    })),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function compileNarrativeDraft(value: unknown, context: NarrativeDraftContext):
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly code: string; readonly path: string } {
  const fail = (code: string, path: string) => ({ ok: false as const, code, path });
  const raw = record(value);
  if (raw === null) return fail("invalid_draft", "$");
  const unknownKey = Object.keys(raw).find(key => !["worldDelta", "sceneDrafts", "endingOutcomes", "interactionProposals", "graph"].includes(key));
  if (unknownKey !== undefined) return fail("unknown_field", `$.${unknownKey}`);
  if (raw.graph !== undefined && raw.graph !== "default" && raw.graph !== "return_delivery") return fail("unknown_graph", "$.graph");
  const projection = projectNarrativeDraft({ ...context, includeDeliveryReturn: raw.graph === "return_delivery" });
  if (raw.graph === "return_delivery"
    && JSON.stringify(projection.stepKeys) === JSON.stringify(projectNarrativeDraft({ ...context, includeDeliveryReturn: false }).stepKeys)) {
    return fail("unavailable_graph", "$.graph");
  }
  if (!Array.isArray(raw.sceneDrafts)) return fail("invalid_slots", "$.sceneDrafts");
  const byKey = new Map<string, unknown>();
  for (let index = 0; index < raw.sceneDrafts.length; index += 1) {
    const entry = record(raw.sceneDrafts[index]);
    if (entry === null || typeof entry.slotKey !== "string" || record(entry.scene) === null) return fail("invalid_slot", `$.sceneDrafts[${index}]`);
    const extra = Object.keys(entry).find(key => key !== "slotKey" && key !== "scene");
    if (extra !== undefined) return fail("unknown_field", `$.sceneDrafts[${index}].${extra}`);
    const slot = projection.slots.find(slot => slot.slotKey === entry.slotKey);
    if (slot === undefined) return fail("unknown_slot", `$.sceneDrafts[${index}].slotKey`);
    if (byKey.has(entry.slotKey)) return fail("duplicate_slot", `$.sceneDrafts[${index}].slotKey`);
    const scene = record(entry.scene)!;
    if (!Array.isArray(scene.choices) || scene.choices.length !== slot.choiceCount) return fail("invalid_choice_count", `$.sceneDrafts[${index}].scene.choices`);
    const npcLine = record(scene.npcLine);
    byKey.set(entry.slotKey, npcLine === null ? entry.scene : { ...scene, npcLine: {
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
  return { ok: true, value: {
    worldDelta,
    ...(raw.interactionProposals === undefined ? {} : { interactionProposals: raw.interactionProposals }),
    currentScene: byKey.get("current"),
    continuationScenes: projection.stepKeys.map(stepKey => ({ stepKey, scene: byKey.get(stepKey) })),
    ...(endingOutcomes === undefined ? {} : { endingOutcomes }),
    terminal: projection.terminal,
  } };
}
