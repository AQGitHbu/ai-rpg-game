import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { Action } from "@/game/domain/action";
import type { RuleEngineResult } from "@/game/gameplay/rpg/ruleEngine";
import { ruleEngine } from "@/game/gameplay/rpg/ruleEngine";
import { checkExpansionTrigger } from "./expansionTrigger";
import { approveExpansions } from "./approveExpansion";
import { applyApprovedExpansion } from "./applyExpansion";
import type { ExpansionProposal, ExpansionResult } from "./expansionTypes";

// ---------------------------------------------------------------------------
// Task 6：gameplay expansion/ 只保留纯 trigger/approve/apply/re-evaluate 决策；
// AI source 的 await 一律由 application 编排（performTurn 负责 await 与注入）。
// runExpansionProposer 接收已拉取的提案数组，不再接受/await ExpansionSource。
// ---------------------------------------------------------------------------

export type ExpansionDeps = { readonly now: () => string };

export { checkExpansionTrigger } from "./expansionTrigger";
export type { TriggerResult } from "./expansionTrigger";

/**
 * 纯函数触发→审批→应用→重演算编排。
 * 不执行任何 await：提案由调用方（application）先经 ExpansionSource 获取。
 * proposals === null 表示本轮没有可用提案（无 source / source 未产出），不等同于“提案被拒”。
 */
export function runExpansionProposer(
  initialResult: RuleEngineResult,
  ws: WorldState,
  ss: StoryState,
  action: Action,
  actionId: string,
  proposals: readonly ExpansionProposal[] | null,
  deps: ExpansionDeps,
): ExpansionResult {
  const trigger = checkExpansionTrigger(initialResult, ws, ss, action);
  if (!trigger.triggered || proposals === null) {
    return {
      triggered: false,
      reason: "no_trigger",
      approved: null,
      nextBudget: null,
      reEvaluatedResult: null,
      rejectedProposals: [],
    };
  }

  const idOverride = extractTargetIdOverride(action);

  const approval = approveExpansions(
    proposals,
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