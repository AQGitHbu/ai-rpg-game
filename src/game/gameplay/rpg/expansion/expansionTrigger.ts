import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { Action } from "@/game/domain/action";
import type { RuleEngineResult, ValidationCode } from "@/game/gameplay/rpg/ruleEngine";
import { budgetAllowsExpansion } from "@/game/domain/storyBudget";
import type { ExpansionTriggerReason } from "./expansionTypes";

const ENTITY_NOT_FOUND_CODES: ReadonlySet<ValidationCode> = new Set([
  "UNKNOWN_LOCATION",
  "UNKNOWN_NPC",
  "UNKNOWN_FACT",
  "UNKNOWN_ITEM",
  "UNKNOWN_ENEMY",
]);

export type TriggerResult = {
  readonly triggered: boolean;
  readonly reason: ExpansionTriggerReason | "no_trigger";
};

export function checkExpansionTrigger(
  initialResult: RuleEngineResult,
  _ws: WorldState,
  ss: StoryState,
  _action: Action,
): TriggerResult {
  if (!initialResult.ok && ENTITY_NOT_FOUND_CODES.has(initialResult.code)) {
    const budgetDim = budgetDimForCode(initialResult.code);
    if (budgetDim !== null && !budgetAllowsExpansion(ss.budget, budgetDim)) {
      return { triggered: false, reason: "no_trigger" };
    }
    return { triggered: true, reason: "entity_not_found" };
  }
  return { triggered: false, reason: "no_trigger" };
}

function budgetDimForCode(code: ValidationCode): "locations" | "npcs" | "quests" | "events" | null {
  switch (code) {
    case "UNKNOWN_LOCATION": return "locations";
    case "UNKNOWN_NPC": return "npcs";
    default: return null;
  }
}
