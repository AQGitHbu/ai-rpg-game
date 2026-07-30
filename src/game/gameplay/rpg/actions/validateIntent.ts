import type { GameState, ScenarioBlueprint, LocationId } from "@/game/domain";
import type { PlayerIntent } from "./intents";
import { parseDialogueChoiceKind, projectDialogueChoices } from "./dialogueChoices";

// ---------------------------------------------------------------------------
// 纯 intent 校验（Phase 3 Task 2，Phase 4 扩展 move，Phase 5 扩展 take_item，
// Phase 7 扩展 dialogue_choice）。
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
  | "FACT_ALREADY_DISCOVERED"
  | "UNKNOWN_ITEM"
  | "ITEM_NOT_AVAILABLE_HERE"
  | "ITEM_ALREADY_OWNED"
  // Phase 7：封闭对话选择——伪造/变形 choiceId 与当前不可用的 choice 分开拒绝。
  | "INVALID_DIALOGUE_CHOICE"
  | "DIALOGUE_CHOICE_UNAVAILABLE"
  // Phase 6：战斗 intent 由 application 路由到 battle facade，不应进入 actions facade。
  | "INTENT_NOT_ROUTED";

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

    case "take_item": {
      const item = blueprint.items.find((i) => i.id === intent.itemId);
      if (item === undefined) {
        return { ok: false, code: "UNKNOWN_ITEM", params: { itemId: intent.itemId } };
      }
      // 可取得性只看蓝图中当前地点的预置清单；未配置到任何地点的物品同样拒绝。
      const currentLocation = blueprint.locations.find((l) => l.id === state.currentLocationId);
      if (currentLocation === undefined || !currentLocation.availableItemIds.includes(intent.itemId)) {
        return {
          ok: false,
          code: "ITEM_NOT_AVAILABLE_HERE",
          params: { itemId: intent.itemId, currentLocationId: state.currentLocationId },
        };
      }
      if (state.inventory.includes(intent.itemId)) {
        return { ok: false, code: "ITEM_ALREADY_OWNED", params: { itemId: intent.itemId } };
      }
      return { ok: true };
    }
    case "dialogue_choice": {
      const npc = blueprint.npcs.find((n) => n.id === intent.npcId);
      if (npc === undefined) {
        return { ok: false, code: "UNKNOWN_NPC", params: { npcId: intent.npcId } };
      }
      // 封闭枚举：choiceId 必须与 makeDialogueChoiceId 产出完全相等。
      const kind = parseDialogueChoiceKind(intent.npcId, intent.choiceId);
      if (kind === null) {
        return {
          ok: false,
          code: "INVALID_DIALOGUE_CHOICE",
          params: { npcId: intent.npcId, choiceId: intent.choiceId },
        };
      }
      // 在场判断与 talk 一致：只看运行时 NPC 位置。
      const npcState = state.npcs.find((n) => n.npcId === intent.npcId);
      const isPresent = npcState?.locationId === state.currentLocationId;
      if (!isPresent) {
        return {
          ok: false,
          code: "NPC_NOT_PRESENT",
          params: { npcId: intent.npcId, currentLocationId: state.currentLocationId },
        };
      }
      // 形式合法但当前未投影（已结识/互斥替代）→ 稳定拒绝。
      const available = projectDialogueChoices(blueprint, state, intent.npcId);
      if (!available.some((choice) => choice.choiceId === intent.choiceId)) {
        return {
          ok: false,
          code: "DIALOGUE_CHOICE_UNAVAILABLE",
          params: { npcId: intent.npcId, choiceId: intent.choiceId },
        };
      }
      return { ok: true };
    }
    // Phase 6：战斗 intent 由 application 路由到 battle facade，不应进入 actions facade。
    case "start_battle":
    case "battle_action":
    case "narrative_choice":
      return { ok: false, code: "INTENT_NOT_ROUTED", params: {} };
  }
}
