import { type WorldState } from "@/game/domain/worldState";
import { locationScaleOf } from "@/game/domain/worldEntity";
import type { Action } from "@/game/domain/action";
import type { StoryState } from "@/game/domain/storyState";
import { isExplicitInvestigation } from "@/game/domain/investigation";
import { getEntity, type EntityRecord, type NpcEntityRecord } from "@/game/domain/entity";
import { evaluateStoryCondition } from "@/game/gameplay/rpg/storyInteraction";
import { isActionReleased } from "@/game/gameplay/rpg/worldEvolution";
import type { FactId, NpcId } from "@/game/domain/worldEntity";
import type { InvestigationApproach } from "@/game/domain/worldEntries";

export type InvestigationOpportunity = Readonly<{
  factId: FactId;
  approachId: string;
  label: string;
  hint?: string;
  action: Extract<Action, { type: "investigate" }>;
}>;

function isNpcRecord(record: EntityRecord | undefined): record is NpcEntityRecord {
  return record?.core.kind === "npc";
}

function activeNpcAt(worldState: WorldState, npcId: NpcId, locationId: WorldState["currentLocationId"]): boolean {
  const record: EntityRecord | undefined = getEntity(worldState.entityStore, npcId);
  if (!isNpcRecord(record)) return false;
  return record.core.lifecycle === "active" && record.position.locationId === locationId;
}

function approachIsAvailable(
  worldState: WorldState,
  approach: InvestigationApproach,
): boolean {
  if (!(approach.requirements ?? []).every((condition) => evaluateStoryCondition(worldState, condition))) return false;
  return (approach.witnessNpcIds ?? []).every((npcId) => activeNpcAt(worldState, npcId, worldState.currentLocationId));
}

export function isInvestigationActionAvailable(input: {
  worldState: WorldState;
  factId: FactId;
  approachId: string;
}): boolean {
  const { worldState, factId, approachId } = input;
  const location = worldState.locations.find((entry) => entry.id === worldState.currentLocationId);
  const fact = worldState.worldFacts.find((entry) => entry.factId === factId);
  if (location === undefined || locationScaleOf(location) !== "scene"
    || fact === undefined
    || !isExplicitInvestigation(fact)
    || fact.discovered
    || fact.locationId !== worldState.currentLocationId
    || fact.investigationApproaches === undefined
    || fact.investigationApproaches.length < 2
    || fact.investigationApproaches.length > 3) return false;
  const approach = fact.investigationApproaches.find((entry) => entry.approachId === approachId);
  return approach !== undefined && approachIsAvailable(worldState, approach);
}

/**
 * Project only server-approved, currently executable investigation methods.
 * The fact body is deliberately absent so this projection is safe for UI and prompts.
 */
export function availableInvestigations(input: {
  worldState: WorldState;
  storyState: StoryState;
}): readonly InvestigationOpportunity[] {
  const { worldState, storyState } = input;
  const location = worldState.locations.find((entry) => entry.id === worldState.currentLocationId);
  if (location === undefined || locationScaleOf(location) !== "scene") return [];
  return worldState.worldFacts.flatMap((fact) => {
    if (!isExplicitInvestigation(fact)
      || fact.discovered
      || fact.locationId !== worldState.currentLocationId
      || fact.investigationApproaches === undefined
      || fact.investigationApproaches.length < 2
      || fact.investigationApproaches.length > 3) return [];
    return fact.investigationApproaches
      .filter((approach) => isInvestigationActionAvailable({ worldState, factId: fact.factId, approachId: approach.approachId }))
      .filter((approach) => isActionReleased(worldState, storyState, {
        type: "investigate", factId: fact.factId, approachId: approach.approachId,
      }))
      .map((approach): InvestigationOpportunity => ({
        factId: fact.factId,
        approachId: approach.approachId,
        label: approach.label,
        ...(approach.hint === undefined ? {} : { hint: approach.hint }),
        action: { type: "investigate", factId: fact.factId, approachId: approach.approachId },
      }));
  });
}

/**
 * Gate for existing disclosure paths. It never grants disclosure by itself; it only
 * prevents an undiscovered investigation fact from being revealed through another path.
 */
export function canRevealFactWithoutInvestigation(input: {
  worldState: WorldState;
  factId: FactId;
}): boolean {
  const fact = input.worldState.worldFacts.find((entry) => entry.factId === input.factId);
  if (fact === undefined) return false;
  return !isExplicitInvestigation(fact) || fact.discovered;
}
