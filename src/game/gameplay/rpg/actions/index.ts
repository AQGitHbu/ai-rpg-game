import type { GameState, ScenarioBlueprint, FactId, LocationId, NpcId } from "@/game/domain";

// ---------------------------------------------------------------------------
// actions facade（Phase 3 Task 2）：application 可用的唯一 actions 入口。
// application 不能 deep import actions 内部文件。
// ---------------------------------------------------------------------------

export type { PlayerIntent } from "./intents";
export {
  validateIntent,
  type ValidateIntentResult,
  type ValidationCode,
} from "./validateIntent";
export {
  resolveAction,
  type ResolveActionResult,
  type ResolveActionDependencies,
  type ActionFeedback,
} from "./resolveAction";

// ---------------------------------------------------------------------------
// 可用行动投影：由已编译蓝图和当前 GameState 投影。
// UI 不得自己猜测哪些目标可行动。
// ---------------------------------------------------------------------------

export type AvailableAction =
  | { readonly type: "observe"; readonly locationId: LocationId; readonly label: string }
  | { readonly type: "talk"; readonly npcId: NpcId; readonly label: string }
  | { readonly type: "investigate"; readonly factId: FactId; readonly label: string };

/** 检查事件账本中是否已有特定地点的观察事件。 */
function hasObservedLocation(state: GameState, locationId: LocationId): boolean {
  return state.eventLedger.some(
    (e) => e.type === "location_observed" && e.locationId === locationId,
  );
}

export function projectAvailableActions(
  blueprint: ScenarioBlueprint,
  state: GameState,
): AvailableAction[] {
  const actions: AvailableAction[] = [];

  // observe：当前地点尚未观察过时可用
  if (!hasObservedLocation(state, state.currentLocationId)) {
    const location = blueprint.locations.find((l) => l.id === state.currentLocationId);
    if (location !== undefined) {
      actions.push({
        type: "observe",
        locationId: state.currentLocationId,
        label: `观察${location.name}`,
      });
    }
  }

  // talk：当前地点在场且尚未见过的 NPC
  for (const npcId of blueprint.openingScene.presentNpcIds) {
    const npcState = state.npcs.find((n) => n.npcId === npcId);
    if (npcState !== undefined && !npcState.met) {
      const npc = blueprint.npcs.find((n) => n.id === npcId);
      if (npc !== undefined) {
        actions.push({
          type: "talk",
          npcId,
          label: `与${npc.name}交谈`,
        });
      }
    }
  }

  // investigate：当前场景可调查且尚未发现的事实
  for (const factId of blueprint.openingScene.investigableFactIds) {
    const factState = state.worldFacts.find((f) => f.factId === factId);
    if (factState !== undefined && !factState.discovered) {
      actions.push({
        type: "investigate",
        factId,
        label: `调查线索`,
      });
    }
  }

  return actions;
}
