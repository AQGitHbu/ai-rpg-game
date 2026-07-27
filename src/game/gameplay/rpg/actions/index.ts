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
// Phase 4：talk 目标改由运行时 NPC 位置投影，新增 move 目标投影。
// ---------------------------------------------------------------------------

export type AvailableAction =
  | { readonly type: "observe"; readonly locationId: LocationId; readonly label: string }
  | { readonly type: "talk"; readonly npcId: NpcId; readonly label: string }
  | { readonly type: "investigate"; readonly factId: FactId; readonly label: string }
  | { readonly type: "move"; readonly locationId: LocationId; readonly label: string };

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

  // talk：运行时位于当前地点且尚未见过的 NPC（不再读 opening scene 名单）
  for (const npcState of state.npcs) {
    if (npcState.locationId !== state.currentLocationId || npcState.met) {
      continue;
    }
    const npc = blueprint.npcs.find((n) => n.id === npcState.npcId);
    if (npc !== undefined) {
      actions.push({
        type: "talk",
        npcId: npcState.npcId,
        label: `与${npc.name}交谈`,
      });
    }
  }

  // investigate：当前场景可调查且尚未发现的事实（只有 opening 地点携带可调查列表）
  if (state.currentLocationId === blueprint.openingScene.locationId) {
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
  }

  // move：当前地点连通 ∩ 已解锁的非当前地点
  const currentLocation = blueprint.locations.find((l) => l.id === state.currentLocationId);
  for (const targetId of currentLocation?.connectedLocationIds ?? []) {
    if (targetId === state.currentLocationId || !state.unlockedLocationIds.includes(targetId)) {
      continue;
    }
    const target = blueprint.locations.find((l) => l.id === targetId);
    if (target !== undefined) {
      actions.push({
        type: "move",
        locationId: targetId,
        label: `前往${target.name}`,
      });
    }
  }

  return actions;
}
