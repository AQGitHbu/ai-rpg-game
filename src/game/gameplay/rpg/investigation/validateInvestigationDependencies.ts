import { getEntity, type NpcEntityRecord } from "@/game/domain/entity";
import type { StoryCondition } from "@/game/domain/storyInteraction";
import type { FactId } from "@/game/domain/worldEntity";
import type { WorldState } from "@/game/domain/worldState";
import { evaluateStoryCondition } from "@/game/gameplay/rpg/storyInteraction";

/**
 * Reject closed evidence prerequisite cycles in the materialized slice.
 * This is not a world path solver: item/promise and automatic-fact prerequisites
 * retain their existing acquisition rules. A future location is not required to
 * be the player's current location, and an available alternative breaks a cycle.
 */
export function validateInvestigationDependencies(worldState: WorldState):
  | { readonly ok: true }
  | { readonly ok: false; readonly factId: FactId; readonly code: "investigation_dependency_cycle" } {
  function conditionsPossible(conditions: readonly StoryCondition[], path: ReadonlySet<string>): boolean {
    return conditions.every((condition) => conditionPossible(condition, path));
  }

  function factPossible(factId: FactId, path: ReadonlySet<string>, quality?: "clean" | "noisy"): boolean {
    const fact = worldState.worldFacts.find((candidate) => candidate.factId === factId);
    if (fact === undefined || fact.discovered || fact.discoveryMode !== "investigation") return true;
    const key = `fact:${factId}:${quality ?? "any"}`;
    if (path.has(key)) return false;
    const nextPath = new Set([...path, key]);
    return (fact.investigationApproaches ?? []).some((approach) =>
      (quality === undefined || approach.evidenceQuality === quality)
      && conditionsPossible(approach.requirements ?? [], nextPath));
  }

  function conditionPossible(condition: StoryCondition, path: ReadonlySet<string>): boolean {
    if (evaluateStoryCondition(worldState, condition)) return true;
    switch (condition.kind) {
      case "knows_fact":
        // A reachable investigation can subsequently be shared with the NPC.
        return factPossible(condition.factId, path);
      case "investigation_observed":
        return factPossible(condition.factId, path, condition.evidenceQuality);
      case "goal_status": {
        const record = getEntity(worldState.entityStore, condition.npcId);
        const goal = record?.core.kind === "npc"
          ? (record as NpcEntityRecord).dynamicState.goals.find((candidate) => candidate.goalId === condition.goalId)
          : undefined;
        if (goal === undefined || goal.status === "completed" || goal.status === "abandoned") return false;
        // Unbound narrative goals have no status producer; the goal reconciler
        // never abandons a goal and empty completion/block lists never fire.
        if (goal.resolution === undefined || condition.status === "abandoned") return false;
        if (condition.status === "active") return true;
        const conditions = condition.status === "completed" ? goal.resolution.completeWhen : goal.resolution.blockWhen;
        if (conditions.length === 0) return false;
        const key = `goal:${condition.npcId}:${condition.goalId}:${condition.status}`;
        if (path.has(key)) return false;
        return conditionsPossible(conditions, new Set([...path, key]));
      }
      case "has_item":
      case "promise_status":
        return true;
    }
  }

  for (const fact of worldState.worldFacts) {
    if (!factPossible(fact.factId, new Set())) {
      return { ok: false, factId: fact.factId, code: "investigation_dependency_cycle" };
    }
  }
  return { ok: true };
}
