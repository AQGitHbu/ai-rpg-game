import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { Action } from "@/game/domain/action";
import type { RuleEngineResult } from "@/game/gameplay/rpg/ruleEngine";
import { ruleEngine } from "@/game/gameplay/rpg/ruleEngine";
import type { ExpansionSource } from "./expansionSource";
import { checkExpansionTrigger } from "./expansionTrigger";
import { approveExpansions } from "./approveExpansion";
import { applyApprovedExpansion } from "./applyExpansion";
import type { ExpansionResult } from "./expansionTypes";

export type ExpansionDeps = { readonly now: () => string };

export async function runExpansionProposer(
  initialResult: RuleEngineResult,
  ws: WorldState,
  ss: StoryState,
  action: Action,
  actionId: string,
  source: ExpansionSource | null,
  deps: ExpansionDeps,
): Promise<ExpansionResult> {
  const trigger = checkExpansionTrigger(initialResult, ws, ss, action);
  if (!trigger.triggered || source === null) {
    return {
      triggered: false,
      reason: "no_trigger",
      approved: null,
      nextBudget: null,
      reEvaluatedResult: null,
      rejectedProposals: [],
    };
  }

  const sourceResult = await source.propose({
    worldState: ws,
    storyState: ss,
    action,
    triggerReason: trigger.reason,
  });

  const idOverride = extractTargetIdOverride(action);

  const approval = approveExpansions(
    sourceResult.proposals,
    ws,
    ss.budget,
    { genId: (prefix) => `${prefix}_${ws.eventLedger.length + 1}` },
    idOverride,
  );

  if (approval.approved.newLocations.length === 0 &&
      approval.approved.newNpcs.length === 0 &&
      approval.approved.newItems.length === 0 &&
      approval.approved.newEnemies.length === 0 &&
      approval.approved.newFacts.length === 0) {
    return {
      triggered: true,
      reason: trigger.reason,
      approved: null,
      nextBudget: null,
      reEvaluatedResult: null,
      rejectedProposals: approval.rejected,
    };
  }

  const expandedWs = applyApprovedExpansion(ws, approval.approved, deps.now());

  const expandedSs: StoryState = {
    ...ss,
    budget: approval.nextBudget,
  };

  const reEvaluatedResult = ruleEngine(expandedWs, expandedSs, action, actionId, { now: deps.now });

  return {
    triggered: true,
    reason: trigger.reason,
    approved: approval.approved,
    nextBudget: approval.nextBudget,
    reEvaluatedResult,
    rejectedProposals: approval.rejected,
  };
}

function extractTargetIdOverride(action: Action): { kind: "location" | "npc"; id: string } | undefined {
  switch (action.type) {
    case "move": return { kind: "location", id: String(action.locationId) };
    case "talk": return { kind: "npc", id: String(action.npcId) };
    default: return undefined;
  }
}
