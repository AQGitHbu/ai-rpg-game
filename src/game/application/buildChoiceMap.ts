import type { Action } from "@/game/domain/action";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { EventCandidate } from "@/game/domain/candidateEvent";
import { isExpiredCandidate } from "@/game/domain/candidateEvent";
import type { ActionChoiceMap } from "./actionConverter";
import { deriveRuntimeChoiceToken } from "./runtimeChoiceToken";

// ---------------------------------------------------------------------------
// 服务端 choiceMap 构建器：从当前 WorldState + StoryState 派生所有合法行动的
// choiceToken → Action 映射。客户端只需发送 choiceToken（opaque token）。
//
// 世界行动候选也使用 opaque token；projector 与本映射共享同一铸造函数。
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
  const addRuntimeAction = (action: Action): void => {
    map.set(deriveRuntimeChoiceToken(action, currentRevision), action);
  };

  // 如果有活跃战斗，只允许 battle_action
  if (worldState.battle.status === "active") {
    addRuntimeAction({ type: "battle_action", action: "attack" });
    addRuntimeAction({ type: "battle_action", action: "guard" });
    addRuntimeAction({ type: "battle_action", action: "flee" });
  } else {
    // 当前地点 NPC → talk
    for (const npc of worldState.npcs) {
      if (npc.locationId === worldState.currentLocationId) {
        addRuntimeAction({ type: "talk", npcId: npc.id, dialogueAct: "ask" });
      }
    }

    // 连接且已解锁的地点 → move
    const currentLoc = worldState.locations.find((l) => l.id === worldState.currentLocationId);
    if (currentLoc !== undefined) {
      for (const locId of currentLoc.connectedLocationIds) {
        if (worldState.unlockedLocationIds.includes(locId)) {
          addRuntimeAction({ type: "move", locationId: locId });
        }
      }
    }

    // 当前地点可拾取物品 → take_item
    if (currentLoc !== undefined) {
      for (const itemId of currentLoc.availableItemIds) {
        if (!worldState.inventory.includes(itemId)) {
          addRuntimeAction({ type: "take_item", itemId });
        }
      }
    }

    // 背包物品 × 在场 NPC → give_item（正式给予入口）
    for (const npc of worldState.npcs) {
      if (npc.locationId !== worldState.currentLocationId) continue;
      for (const itemId of worldState.inventory) {
        addRuntimeAction({ type: "give_item", itemId, npcId: npc.id });
      }
    }

    // 当前地点敌人 → attack
    for (const enemy of worldState.enemies) {
      if (
        enemy.locationId === worldState.currentLocationId &&
        !worldState.defeatedEnemyIds.includes(enemy.id)
      ) {
        addRuntimeAction({ type: "attack", enemyId: enemy.id });
      }
    }

    // 探索：仅当前地点有可探索内容（未发现线索/未拾取物品/未满足目标/候选事件）
    // 时才作为合法世界行动（方案 1：无剧情钩子不显示探索）。
    if (hasExplorableContent(worldState, storyState)) {
      addRuntimeAction({ type: "explore" });
    }
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
      if (!isCurrentlyLegalRegistryAction(entry.action, worldState, storyState, map, currentRevision)) continue;
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
  storyState: StoryState,
  worldActionMap: ReadonlyMap<string, Action>,
  currentRevision: number,
): boolean {
  switch (action.type) {
    case "talk":
      return worldState.npcs.some(
        (npc) => npc.id === action.npcId && npc.locationId === worldState.currentLocationId,
      );
    case "move":
    case "take_item":
    case "give_item":
    case "attack":
    case "battle_action":
      return worldActionMap.has(deriveRuntimeChoiceToken(action, currentRevision));
    // 探索：只有当前地点有可探索内容时，AI 提案的探索选项才合法并投影。
    case "explore":
      return hasExplorableContent(worldState, storyState);
    case "investigate":
    case "ack_prologue":
    case "freeform":
      return false;
  }
}

// ---------------------------------------------------------------------------
// 可探索性判定（方案 1 修订）：探索选项只在存在"探索能推进"的剧情钩子时
// 对玩家可见/可执行。
// 钩子 = 当前地点仍有未发现的线索事实、未满足的地点相关目标、或候选事件池
// 中涉及当前地点的有效（未过期）候选事件。
// 注意：本地点有未拾取物品（availableItemIds）不构成探索钩子——探索动作
// 不拾取物品（拾取走独立 take_item 入口），有物品并不代表探索有剧情作用；
// 若把物品当作钩子，无剧情钩子的地点（如开局青石镇）会出现空转探索按钮。
// ---------------------------------------------------------------------------
export function hasExplorableContent(ws: WorldState, ss: StoryState): boolean {
  const currentId = ws.currentLocationId;

  // 1) 本地点仍有未发现的线索事实（含 NPC 私密事实：探索可引动揭示，不泄漏正文）。
  if (ws.worldFacts.some((f) => f.locationId === currentId && !f.discovered)) return true;

  // 2) 未满足的、指向本地点或其线索事实的任务目标（active 任务）。
  const hasUnmetLocationObjective = ws.quests.some((q) =>
    q.status === "active" &&
    q.objectives.some((o) => {
      if (o.kind === "visit_location") {
        return o.locationId === currentId && !ws.visitedLocationIds.includes(o.locationId);
      }
      if (o.kind === "discover_fact") {
        const fact = ws.worldFacts.find((f) => f.factId === o.factId);
        return fact !== undefined && fact.locationId === currentId && !fact.discovered;
      }
      return false;
    }),
  );
  if (hasUnmetLocationObjective) return true;

  // 3) 候选事件池中涉及当前地点的有效候选（探索是激活这些事件的手段之一）。
  return ss.candidateEventPool.some((candidate) =>
    !isExpiredCandidate(candidate, ss.turnNumber) &&
    candidateTouchesLocation(ws, candidate, currentId),
  );
}

function candidateTouchesLocation(
  ws: WorldState,
  candidate: EventCandidate,
  locationId: WorldState["currentLocationId"],
): boolean {
  // 防御：持久化数据可能含残缺候选（读模型投影对任意 record 稳健）。
  if (candidate.involvedEntityIds !== undefined && candidate.involvedEntityIds.includes(String(locationId))) return true;
  if (!Array.isArray(candidate.proposedEffects)) return false;
  return candidate.proposedEffects.some((effect) => {
    if ("locationId" in effect && effect.locationId === locationId) return true;
    if ("npcId" in effect) {
      const npc = ws.npcs.find((n) => n.id === effect.npcId);
      return npc !== undefined && npc.locationId === locationId;
    }
    return false;
  });
}
