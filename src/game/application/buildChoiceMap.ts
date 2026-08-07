import type { Action } from "@/game/domain/action";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { ActionChoiceMap } from "./actionConverter";
import { asNpcId, asLocationId, asItemId, asEnemyId } from "@/game/domain/scenarioBlueprint";

// ---------------------------------------------------------------------------
// 服务端 choiceMap 构建器：从当前 WorldState + StoryState 派生所有合法行动的
// choiceToken → Action 映射。客户端只需发送 choiceToken（actionKey 格式）。
//
// actionKey 格式：
//   talk:<npcId>     → { type: "talk", npcId }
//   move:<locationId> → { type: "move", locationId }
//   explore           → { type: "explore" }
//   rest              → { type: "rest" }
//   take_item:<itemId> → { type: "take_item", itemId }
//   attack:<enemyId>  → { type: "attack", enemyId }
//   battle_action:<action> → { type: "battle_action", action }
//   ack_prologue      → { type: "ack_prologue" }
// ---------------------------------------------------------------------------

export function buildChoiceMap(worldState: WorldState, storyState: StoryState): ActionChoiceMap {
  const map = new Map<string, Action>();

  // 如果有活跃战斗，只允许 battle_action
  if (worldState.battle.status === "active") {
    map.set("battle_action:attack", { type: "battle_action", action: "attack" });
    map.set("battle_action:guard", { type: "battle_action", action: "guard" });
    map.set("battle_action:flee", { type: "battle_action", action: "flee" });
    return map;
  }

  // 当前地点 NPC → talk
  for (const npc of worldState.npcs) {
    if (npc.locationId === worldState.currentLocationId) {
      const key = `talk:${String(npc.id)}`;
      map.set(key, { type: "talk", npcId: npc.id });
    }
  }

  // 连接且已解锁的地点 → move
  const currentLoc = worldState.locations.find((l) => l.id === worldState.currentLocationId);
  if (currentLoc !== undefined) {
    for (const locId of currentLoc.connectedLocationIds) {
      if (worldState.unlockedLocationIds.includes(locId)) {
        const key = `move:${String(locId)}`;
        map.set(key, { type: "move", locationId: locId });
      }
    }
  }

  // 当前地点可拾取物品 → take_item
  if (currentLoc !== undefined) {
    for (const itemId of currentLoc.availableItemIds) {
      if (!worldState.inventory.includes(itemId)) {
        const key = `take_item:${String(itemId)}`;
        map.set(key, { type: "take_item", itemId });
      }
    }
  }

  // 当前地点敌人 → attack
  for (const enemy of worldState.enemies) {
    if (
      enemy.locationId === worldState.currentLocationId &&
      !worldState.defeatedEnemyIds.includes(enemy.id)
    ) {
      const key = `attack:${String(enemy.id)}`;
      map.set(key, { type: "attack", enemyId: enemy.id });
    }
  }

  // 通用行动
  map.set("explore", { type: "explore" });
  map.set("rest", { type: "rest" });

  // 叙事场景的固定选项也加入 choiceMap
  const scene = storyState.narrative.currentScene;
  if (scene !== null) {
    for (const choice of scene.choices) {
      // choiceToken 已经是 actionKey 格式，或独立格式——两者都映射
      if (!map.has(choice.choiceToken)) {
        const parsed = parseActionKey(choice.actionKey);
        if (parsed !== null) {
          map.set(choice.choiceToken, parsed);
        }
      }
    }
  }

  return map;
}

function parseActionKey(actionKey: string): Action | null {
  const colonIdx = actionKey.indexOf(":");
  if (colonIdx === -1) {
    // 无参数行动
    switch (actionKey) {
      case "explore": return { type: "explore" };
      case "rest": return { type: "rest" };
      case "ack_prologue": return { type: "ack_prologue" };
      default: return null;
    }
  }
  const prefix = actionKey.slice(0, colonIdx);
  const arg = actionKey.slice(colonIdx + 1);
  switch (prefix) {
    case "talk": return { type: "talk", npcId: asNpcId(arg) };
    case "move": return { type: "move", locationId: asLocationId(arg) };
    case "take_item": return { type: "take_item", itemId: asItemId(arg) };
    case "attack": return { type: "attack", enemyId: asEnemyId(arg) };
    case "battle_action":
      if (arg === "attack" || arg === "guard" || arg === "flee") {
        return { type: "battle_action", action: arg };
      }
      return null;
    default: return null;
  }
}
