import type { GameState, ScenarioBlueprint, LocationId } from "@/game/domain";
import type { PlayerIntent } from "./intents";

// ---------------------------------------------------------------------------
// 纯 intent 校验（Phase 3 Task 2，Phase 4 扩展 move）。
//
// 只读取 compiled blueprint + 当前 GameState，返回稳定验证码/参数，不改状态。
// 不依赖 application、repository、UI、Date、Math.random 或 AI。
// ---------------------------------------------------------------------------

export type ValidationCode =
  | "LOCATION_NOT_CURRENT"
  | "UNKNOWN_LOCATION"
  | "LOCATION_ALREADY_OBSERVED"
  | "LOCATION_ALREADY_CURRENT"
  | "LOCATION_NOT_CONNECTED"
  | "LOCATION_LOCKED"
  | "NPC_NOT_PRESENT"
  | "UNKNOWN_NPC"
  | "NPC_ALREADY_MET"
  | "FACT_NOT_INVESTIGABLE"
  | "UNKNOWN_FACT"
  | "FACT_ALREADY_DISCOVERED";

export type ValidateIntentResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: ValidationCode;
      readonly params: Record<string, string>;
    };

/** 检查事件账本中是否已有特定地点的观察事件。 */
function hasObservedLocation(state: GameState, locationId: LocationId): boolean {
  return state.eventLedger.some(
    (e) => e.type === "location_observed" && e.locationId === locationId,
  );
}

export function validateIntent(
  blueprint: ScenarioBlueprint,
  state: GameState,
  intent: PlayerIntent,
): ValidateIntentResult {
  switch (intent.type) {
    case "observe": {
      const location = blueprint.locations.find((l) => l.id === intent.locationId);
      if (location === undefined) {
        return { ok: false, code: "UNKNOWN_LOCATION", params: { locationId: intent.locationId } };
      }
      if (intent.locationId !== state.currentLocationId) {
        return {
          ok: false,
          code: "LOCATION_NOT_CURRENT",
          params: {
            currentLocationId: state.currentLocationId,
            targetLocationId: intent.locationId,
          },
        };
      }
      if (hasObservedLocation(state, intent.locationId)) {
        return { ok: false, code: "LOCATION_ALREADY_OBSERVED", params: { locationId: intent.locationId } };
      }
      return { ok: true };
    }

    case "talk": {
      const npc = blueprint.npcs.find((n) => n.id === intent.npcId);
      if (npc === undefined) {
        return { ok: false, code: "UNKNOWN_NPC", params: { npcId: intent.npcId } };
      }
      // 在场判断只看运行时 NPC 位置：opening scene 的 NPC 不得泄漏到其他地点。
      const npcState = state.npcs.find((n) => n.npcId === intent.npcId);
      const isPresent = npcState?.locationId === state.currentLocationId;
      if (!isPresent) {
        return {
          ok: false,
          code: "NPC_NOT_PRESENT",
          params: { npcId: intent.npcId, currentLocationId: state.currentLocationId },
        };
      }
      if (npcState?.met === true) {
        return { ok: false, code: "NPC_ALREADY_MET", params: { npcId: intent.npcId } };
      }
      return { ok: true };
    }

    case "investigate": {
      const fact = blueprint.world.facts.find((f) => f.id === intent.factId);
      if (fact === undefined) {
        return { ok: false, code: "UNKNOWN_FACT", params: { factId: intent.factId } };
      }
      // 事实必须在当前场景的可调查事实列表中；目前只有 opening 场景携带
      // 可调查列表，离开开场地点后不得泄漏到其他地点。
      const atOpeningLocation = state.currentLocationId === blueprint.openingScene.locationId;
      const investigableIds = blueprint.openingScene.investigableFactIds;
      if (!atOpeningLocation || !investigableIds.includes(intent.factId)) {
        return { ok: false, code: "FACT_NOT_INVESTIGABLE", params: { factId: intent.factId } };
      }
      const factState = state.worldFacts.find((f) => f.factId === intent.factId);
      if (factState?.discovered === true) {
        return { ok: false, code: "FACT_ALREADY_DISCOVERED", params: { factId: intent.factId } };
      }
      return { ok: true };
    }

    case "move": {
      const location = blueprint.locations.find((l) => l.id === intent.locationId);
      if (location === undefined) {
        return { ok: false, code: "UNKNOWN_LOCATION", params: { locationId: intent.locationId } };
      }
      if (intent.locationId === state.currentLocationId) {
        return {
          ok: false,
          code: "LOCATION_ALREADY_CURRENT",
          params: { locationId: intent.locationId },
        };
      }
      // 连通性只读当前地点蓝图的出边，不做反向推导。
      const currentLocation = blueprint.locations.find((l) => l.id === state.currentLocationId);
      if (currentLocation === undefined || !currentLocation.connectedLocationIds.includes(intent.locationId)) {
        return {
          ok: false,
          code: "LOCATION_NOT_CONNECTED",
          params: {
            currentLocationId: state.currentLocationId,
            targetLocationId: intent.locationId,
          },
        };
      }
      if (!state.unlockedLocationIds.includes(intent.locationId)) {
        return { ok: false, code: "LOCATION_LOCKED", params: { locationId: intent.locationId } };
      }
      return { ok: true };
    }
  }
}
