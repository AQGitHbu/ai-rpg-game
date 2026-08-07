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
import { propagateKnownFacts } from "./propagateKnownFacts";
import { approveCandidateEvents } from "./approveCandidateEvents";
import { advanceStoryProgression } from "./advanceStoryProgression";
import { reconcileMaterializedView } from "@/game/domain/materializedView";
import type { RecentBeat, NpcContact } from "@/game/domain/materializedView";

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

  // blocked 状态：不推进任务/结局/张力，直接返回
  if (resolved.status === "blocked") {
    const resolvedEvent: ResolvedEvent = {
      actionId,
      status: "blocked",
      eventKind: eventKindForAction(action),
      stateChanges: [],
      facts: [],
      costs: [],
      rewards: [],
      triggeredEvents: [],
      rejectedEffects: [{ description: "被战斗阻止", reason: "battle_active" }],
      stateVersion: resolved.nextWorldState.eventLedger.length,
    };
    return { ok: true, nextWorldState: resolved.nextWorldState, nextStoryState: storyState, resolvedEvent };
  }

  // P4 Step 1: NPC knownFactIds 传播
  const propagatedWs = propagateKnownFacts(resolved.nextWorldState, resolved.facts);

  // P4 Step 2: 任务推进（使用传播后的 WS）
  const quests = reconcileQuests(propagatedWs, deps);
  const ending = resolveEnding(quests.nextWorldState, storyState, deps);

  // P4 Step 3: 幕推进 + endingAllowed 推导
  const progression = advanceStoryProgression(
    ending.nextWorldState,
    ending.nextStoryState,
    [...resolved.events, ...quests.events, ...ending.events],
  );

  // P4 Step 4: candidateEventPool 审批
  const approved = approveCandidateEvents(
    progression.nextStoryState,
    progression.nextStoryState.candidateEventPool,
  );

  // P4 Step 5: 张力更新（approved events 的张力已在 approveCandidateEvents 中处理，不重复计入）
  const gameEvents = [...resolved.events, ...quests.events, ...ending.events];
  const nextStoryState = updateStoryMetrics(approved.nextStoryState, gameEvents);

  // P4 Step 6: 物化视图增量归约
  const prevBeats = storyState.recentBeats as readonly RecentBeat[];
  const prevContacts = storyState.npcContacts as readonly NpcContact[];
  const prev = { recentBeats: prevBeats, npcContacts: prevContacts, reducedThroughEventCount: storyState.reducedThroughEventCount };
  const newView = reconcileMaterializedView(
    prev,
    ending.nextWorldState.eventLedger,
    ending.nextWorldState.currentLocationId,
  );

  const nextStoryStateWithView: StoryState = {
    ...nextStoryState,
    recentBeats: newView.recentBeats as readonly unknown[],
    npcContacts: newView.npcContacts as readonly unknown[],
    reducedThroughEventCount: newView.reducedThroughEventCount,
  };

  // 构建最终 ResolvedEvent
  const resolvedEvent: ResolvedEvent = {
    actionId,
    status: resolved.status,
    eventKind: eventKindForAction(action),
    stateChanges: resolved.stateChanges,
    facts: resolved.facts,
    costs: [],
    rewards: [],
    triggeredEvents: [...gameEvents.map((e) => e.type), ...approved.approvedEvents.map((e) => e.id)],
    rejectedEffects: [],
    stateVersion: ending.nextWorldState.eventLedger.length,
  };

  return { ok: true, nextWorldState: ending.nextWorldState, nextStoryState: nextStoryStateWithView, resolvedEvent };
}
