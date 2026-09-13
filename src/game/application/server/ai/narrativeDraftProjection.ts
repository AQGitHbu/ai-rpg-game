import { projectEntityStore } from "@/game/domain/entity";
import type { NarrativeBundleTerminal } from "@/game/domain/narrativeBundle";
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

/** This projection owns routing only. Every word and action label remains authored. */
export function projectNarrativeDraft(input: NarrativeDraftContext) {
  const worldState = { ...input.worldState, ...projectEntityStore(input.worldState.entityStore) };
  const descriptorGraph = buildNarrativeBundleDescriptors({
    worldState, storyState: input.storyState, transition: input.job.objectiveTransition,
    includeDeliveryReturn: input.includeDeliveryReturn,
  });
  const ending = (input.storyState.evolution.status === "needs_ending_pair" && worldState.endings.length < 2)
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
  const unknownKey = Object.keys(raw).find(key => !["worldDelta", "sceneDrafts", "interactionProposals", "graph"].includes(key));
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
    byKey.set(entry.slotKey, entry.scene);
  }
  const missing = projection.slots.find(slot => !byKey.has(slot.slotKey));
  if (missing !== undefined) return fail("missing_slot", `$.sceneDrafts[slotKey=${missing.slotKey}]`);
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
    terminal: projection.terminal,
  } };
}
