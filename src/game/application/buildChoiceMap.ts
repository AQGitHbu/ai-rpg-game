import type { Action } from "@/game/domain/action";
import { isTravelTarget, type WorldState } from "@/game/domain/worldState";
import { locationScaleOf } from "@/game/domain/worldEntity";
import type { StoryState } from "@/game/domain/storyState";
import type { ActionChoiceMap } from "./actionConverter";
import { deriveRuntimeChoiceToken } from "./runtimeChoiceToken";
import { SKILL_ENERGY_COST } from "@/game/domain/combat";
import { currentObjectiveOf } from "@/game/gameplay/rpg/narrativeContext";
import { endingDecisionStances } from "@/game/gameplay/rpg/narrativeBundle";
import { isObjectiveEntityReleased, isTakeItemPrepared } from "@/game/gameplay/rpg/worldEvolution";

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
  const readyNarrative = storyState.narrative.status === "ready"
    ? storyState.narrative
    : null;
  const addRuntimeAction = (action: Action): void => {
    map.set(deriveRuntimeChoiceToken(action, currentRevision), action);
  };

  // 如果有活跃战斗，只允许 battle_action
  if (worldState.battle.status === "active") {
    const battle = worldState.battle;
    const actorId = battle.combatants?.[battle.turnIndex ?? -1]?.combatantId;
    const actor = actorId === undefined ? undefined : battle.combatants?.find((unit) => unit.combatantId === actorId);
    const targets = battle.combatants?.filter((unit) => unit.side === "enemies" && unit.hp > 0) ?? [];
    if (actor?.controller === "player" && actorId !== undefined && battle.combatants !== undefined) {
      addRuntimeAction({ type: "battle_action", action: "guard", command: { actorId } });
      for (const target of targets) {
        addRuntimeAction({ type: "battle_action", action: "attack", command: { actorId, targetId: target.combatantId } });
        if (actor.energy >= SKILL_ENERGY_COST) {
          addRuntimeAction({ type: "battle_action", action: "skill", command: { actorId, targetId: target.combatantId } });
        }
      }
    } else {
      // 旧存档尚未带队列时保留旧 token，保证历史客户端仍可继续战斗。
      addRuntimeAction({ type: "battle_action", action: "attack" });
      addRuntimeAction({ type: "battle_action", action: "guard" });
    }
  } else {
    // 当前地点 NPC → talk
    for (const npc of worldState.npcs) {
      if (
        npc.locationId === worldState.currentLocationId
        && isObjectiveEntityReleased(worldState, storyState, (objective) =>
          objective.kind === "talk_to_npc" && String(objective.npcId) === String(npc.id))
      ) {
        addRuntimeAction({ type: "talk", npcId: npc.id, dialogueAct: "ask" });
      }
    }

    // 交接场景中的新主线 NPC 尚未成为已持久化 scene focus 时，也必须提供
    // 两种正式回应。它们仍由服务器根据当前权威目标铸造并校验，客户端只能
    // 消费 opaque token，不能把“先点一次交谈”变成无意义的额外回合。
    const objective = currentObjectiveOf(worldState, storyState);
    const quest = objective === null
      ? undefined
      : worldState.quests.find((entry) => String(entry.id) === String(objective.questId));
    const objectiveTarget = objective === null
      ? undefined
      : quest?.objectives[objective.objectiveIndex];
    const sceneFocusNpcId = readyNarrative?.currentScene.event?.kind === "dialogue"
      ? readyNarrative.currentScene.event.focusNpcId
      : undefined;
    const dialogueNpcId = objectiveTarget?.kind === "talk_to_npc"
      ? objectiveTarget.npcId
      : sceneFocusNpcId;
    if (
      dialogueNpcId !== undefined
      && worldState.npcs.some((npc) =>
        npc.id === dialogueNpcId
          && npc.locationId === worldState.currentLocationId
          && isObjectiveEntityReleased(worldState, storyState, (candidate) =>
            candidate.kind === "talk_to_npc" && String(candidate.npcId) === String(dialogueNpcId)),
      )
    ) {
      addRuntimeAction({ type: "talk", npcId: dialogueNpcId, dialogueAct: "support" });
      addRuntimeAction({ type: "talk", npcId: dialogueNpcId, dialogueAct: "challenge" });
    }

    // 未到访地点要求相邻；已到访地点允许回访，避免回到上游地点后被地图锁死。
    const currentLoc = worldState.locations.find((l) => l.id === worldState.currentLocationId);
    if (currentLoc !== undefined) {
      for (const loc of worldState.locations) {
        if (isTravelTarget(worldState, loc.id)) {
          addRuntimeAction({ type: "move", locationId: loc.id });
        }
      }
    }

    // 当前地点可拾取物品 → take_item
    if (currentLoc !== undefined) {
      for (const itemId of currentLoc.availableItemIds) {
        if (
          !worldState.inventory.includes(itemId)
          && isTakeItemPrepared(storyState, itemId)
          && isObjectiveEntityReleased(worldState, storyState, (objective) =>
            objective.kind === "obtain_item" && String(objective.itemId) === String(itemId))
        ) {
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
        && isObjectiveEntityReleased(worldState, storyState, (objective) =>
          objective.kind === "defeat_enemy" && String(objective.enemyId) === String(enemy.id))
      ) {
        addRuntimeAction({ type: "attack", enemyId: enemy.id });
      }
    }

    const readyState = storyState.narrative.status === "ready" ? storyState.narrative.narrativeBundle : undefined;
    for (const stance of endingDecisionStances(worldState, storyState, readyState?.endingLabels)) addRuntimeAction(stance.action);
    // Internal explore exists only as an approved, concrete building arrival.
    if (townBuildingInvestigationTargetNpcId(worldState, storyState) !== null) {
      addRuntimeAction({ type: "explore" });
    }
  }

  // 叙事场景的固定选项：只从服务端 choiceRegistry 按 token 映射。
  // 不再解析 scene.choices 的 actionKey；未知/过期 token 不产生映射。
  const scene = readyNarrative?.currentScene;
  const registry = readyNarrative?.choiceRegistry;
  const dialogueResume = readyNarrative?.dialogueResume;
  if (dialogueResume !== undefined) {
    // 规则型 travel 会替换 currentScene，但未消费的正式 NPC 场景仍保存在
    // dialogueResume 中。按当前 revision 重铸其 talk token，允许恢复后的
    // 对话继续走同一条服务端 action/CAS 链。
    for (const entry of dialogueResume.choiceRegistry) {
      if (entry.action.type !== "talk") continue;
      if (!isCurrentlyLegalRegistryAction(entry.action, worldState, storyState, map, currentRevision)) continue;
      map.set(deriveRuntimeChoiceToken(entry.action, currentRevision), entry.action);
    }
  }
  if (scene !== undefined && registry !== undefined) {
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
        (npc) => npc.id === action.npcId
          && npc.locationId === worldState.currentLocationId
          && isObjectiveEntityReleased(worldState, storyState, (objective) =>
            objective.kind === "talk_to_npc" && String(objective.npcId) === String(action.npcId)),
      );
    case "move":
    case "take_item":
    case "give_item":
    case "attack":
    case "battle_action":
      return worldActionMap.has(deriveRuntimeChoiceToken(action, currentRevision));
    // 泛化探索不再是场景选项；具体建筑到达只由上面的运行时入口铸造。
    case "explore":
      return false;
    case "investigate":
      // 历史记录仍可由规则层结算，但当前客户端不再获得调查 token。
      return false;
    case "ack_prologue":
    case "freeform":
      return false;
  }
}

/**
 * 返回当前城镇中承载事实目标的建筑 NPC。town_building 复用城镇容器的
 * currentLocationId，因此没有 visit_location 可消费；只有在建筑绑定的下一
 * 个 NPC 与当前 discover_fact 连续时，进入该建筑才允许提交一次 explore。
 */
export function townBuildingInvestigationTargetNpcId(
  ws: WorldState,
  ss: StoryState,
): string | null {
  const currentLocation = ws.locations.find((location) => location.id === ws.currentLocationId);
  if (currentLocation === undefined || locationScaleOf(currentLocation) !== "town" || currentLocation.town === undefined) {
    return null;
  }

  const narrative = ss.narrative;
  if (narrative.status !== "ready" || ws.battle.status === "active") return null;
  const bundle = narrative.narrativeBundle;
  if (bundle === undefined || bundle.activeStepIds.length !== 1) return null;
  const step = bundle.steps.find(entry => entry.stepId === bundle.activeStepIds[0]);
  if (step?.trigger.kind !== "explore" || step.trigger.locationId !== ws.currentLocationId) return null;
  const objectiveRef = currentObjectiveOf(ws, ss);
  if (objectiveRef === null) return null;
  const quest = ws.quests.find(entry => entry.id === objectiveRef.questId);
  const objective = quest?.objectives[objectiveRef.objectiveIndex];
  if (quest === undefined || objective?.kind !== "discover_fact") return null;
  if (step.objectiveKey !== `${String(quest.id)}:${objectiveRef.objectiveIndex}`) return null;
  const fact = ws.worldFacts.find(entry => entry.factId === objective.factId);
  if (fact === undefined || fact.discovered || (fact.locationId !== undefined && fact.locationId !== ws.currentLocationId)) return null;
  for (const next of quest.objectives.slice(objectiveRef.objectiveIndex + 1)) {
    if (next.kind === "talk_to_npc") {
      const npc = ws.npcs.find(entry => entry.id === next.npcId && entry.locationId === ws.currentLocationId);
      return npc === undefined ? null : String(npc.id);
    }
    if (next.kind !== "discover_fact" && next.kind !== "obtain_item") return null;
  }
  return null;
}
