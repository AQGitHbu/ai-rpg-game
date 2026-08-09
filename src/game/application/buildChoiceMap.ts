import type { Action } from "@/game/domain/action";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { ActionChoiceMap } from "./actionConverter";

// ---------------------------------------------------------------------------
// 服务端 choiceMap 构建器：从当前 WorldState + StoryState 派生所有合法行动的
// choiceToken → Action 映射。客户端只需发送 choiceToken（opaque token）。
//
// 世界行动候选（actionKey 格式，规则直判，不经 AI）：
//   talk:<npcId>            → { type: "talk", npcId, dialogueAct: "ask" }
//   move:<locationId>      → { type: "move", locationId }
//   explore                → { type: "explore" }
//   rest                   → { type: "rest" }
//   take_item:<itemId>     → { type: "take_item", itemId }
//   use_item:<itemId>      → { type: "use_item", itemId }
//   attack:<enemyId>       → { type: "attack", enemyId }
//   battle_action:<action> → { type: "battle_action", action }
//   ack_prologue           → { type: "ack_prologue" }
//
// 场景固定选项只从持久化 choiceRegistry（ApprovedChoice）按 token 映射，
// 不再解析 scene.choices 的 actionKey（Spec §8.3：客户端不可构造 actionKey）。
// registry 条目必须匹配当前 sceneId 与（可选）当前 record revision 才有效。
// ---------------------------------------------------------------------------

export function buildChoiceMap(
  worldState: WorldState,
  storyState: StoryState,
  currentRevision: number,
): ActionChoiceMap {
  const map = new Map<string, Action>();

  // 如果有活跃战斗，只允许 battle_action
  if (worldState.battle.status === "active") {
    map.set("battle_action:attack", { type: "battle_action", action: "attack" });
    map.set("battle_action:guard", { type: "battle_action", action: "guard" });
    map.set("battle_action:flee", { type: "battle_action", action: "flee" });
  } else {
    // 当前地点 NPC → talk
    for (const npc of worldState.npcs) {
      if (npc.locationId === worldState.currentLocationId) {
        const key = `talk:${String(npc.id)}`;
        map.set(key, { type: "talk", npcId: npc.id, dialogueAct: "ask" });
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
  }

  // 叙事场景的固定选项：只从服务端 choiceRegistry 按 token 映射。
  // 不再解析 scene.choices 的 actionKey；未知/过期 token 不产生映射。
  const scene = storyState.narrative.currentScene;
  const registry = storyState.narrative.choiceRegistry;
  if (scene !== null && registry !== undefined) {
    const currentSceneTokens = new Set(scene.choices.map((choice) => choice.choiceToken));
    for (const entry of registry) {
      if (entry.sceneId !== scene.sceneId) continue;
      if (entry.basedOnRevision !== currentRevision) continue;
      if (!currentSceneTokens.has(entry.choiceToken)) continue;
      if (!isCurrentlyLegalRegistryAction(entry.action, worldState, map)) continue;
      if (!map.has(entry.choiceToken)) {
        map.set(entry.choiceToken, entry.action);
      }
    }
  }

  return map;
}

function isCurrentlyLegalRegistryAction(
  action: Action,
  worldState: WorldState,
  worldActionMap: ReadonlyMap<string, Action>,
): boolean {
  switch (action.type) {
    case "talk":
      return worldState.npcs.some(
        (npc) => npc.id === action.npcId && npc.locationId === worldState.currentLocationId,
      );
    case "move": return worldActionMap.has(`move:${String(action.locationId)}`);
    case "explore": return worldActionMap.has("explore");
    case "take_item": return worldActionMap.has(`take_item:${String(action.itemId)}`);
    case "attack": return worldActionMap.has(`attack:${String(action.enemyId)}`);
    case "rest": return worldActionMap.has("rest");
    case "battle_action": return worldActionMap.has(`battle_action:${action.action}`);
    case "investigate":
    case "ack_prologue":
    case "freeform":
      return false;
  }
}
