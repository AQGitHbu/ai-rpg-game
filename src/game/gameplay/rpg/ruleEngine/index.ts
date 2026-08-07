import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { Action } from "@/game/domain/action";
import type { ResolvedEvent } from "@/game/domain/resolvedEvent";
import type { NarrativeEventKind } from "@/game/domain/narrative";
import { validateAction, type ValidationCode } from "./validateAction";
import { resolveByType, type ResolveDeps } from "./resolveByType";
import { reconcileQuests } from "./reconcileQuests";
import { resolveEnding } from "./resolveEnding";
import { updateStoryMetrics } from "./updateStoryMetrics";

export type RuleEngineResult =
  | { readonly ok: true; readonly nextWorldState: WorldState; readonly nextStoryState: StoryState; readonly resolvedEvent: ResolvedEvent }
  | { readonly ok: false; readonly code: ValidationCode; readonly feedback: string };

export type RuleEngineDeps = ResolveDeps;

function eventKindForAction(action: Action): NarrativeEventKind {
  switch (action.type) {
    case "move": return "travel";
    case "talk": return "dialogue";
    case "investigate": return "investigate";
    case "take_item": case "use_item": case "give_item": return "item";
    case "attack": case "battle_action": return "battle";
    default: return "observe";
  }
}

export function ruleEngine(
  worldState: WorldState,
  storyState: StoryState,
  action: Action,
  actionId: string,
  deps: RuleEngineDeps,
): RuleEngineResult {
  const validation = validateAction(worldState, action);
  if (!validation.ok) {
    return { ok: false, code: validation.code, feedback: `Action rejected: ${validation.code}` };
  }

  const resolved = resolveByType(worldState, action, deps);
  if (!resolved.ok) {
    return { ok: false, code: "INTENT_NOT_ROUTED", feedback: resolved.feedback };
  }

  const quests = reconcileQuests(resolved.nextWorldState, deps);
  const ending = resolveEnding(quests.nextWorldState, storyState, deps);
  const allEvents = [...resolved.events, ...quests.events, ...ending.events];
  const nextStoryState = updateStoryMetrics(ending.nextStoryState, allEvents);

  const resolvedEvent: ResolvedEvent = {
    actionId,
    status: "success",
    eventKind: eventKindForAction(action),
    stateChanges: [],
    facts: [],
    costs: [],
    rewards: [],
    triggeredEvents: allEvents.map((e) => e.type),
    rejectedEffects: [],
    stateVersion: ending.nextWorldState.eventLedger.length,
  };

  return { ok: true, nextWorldState: ending.nextWorldState, nextStoryState, resolvedEvent };
}
