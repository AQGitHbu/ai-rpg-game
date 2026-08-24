import type { Action } from "@/game/domain/action";
import type { WorldState, InvestigationApproach } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { EventCandidate } from "@/game/domain/candidateEvent";
import { isExpiredCandidate } from "@/game/domain/candidateEvent";
import type { ActionChoiceMap } from "./actionConverter";
import { deriveRuntimeChoiceToken } from "./runtimeChoiceToken";
import { SKILL_ENERGY_COST } from "@/game/domain/combat";
import { currentObjectiveOf } from "@/game/gameplay/rpg/narrativeContext";
import { isObjectiveEntityReleased } from "@/game/gameplay/rpg/worldEvolution";

/**
 * Task 4：当前 discover_fact 主线目标事实的已审批调查方式。
 * 只投影"当前目标"的、位于当前地点、未发现且已释放（含无 reveal 的默认释放）
 * 的事实，且 approach 数量 ≥ 2 才构成可选的调查入口（与规则层
 * FACT_NOT_INVESTIGABLE 一致：少于两个方式的事实由自动揭示推进）。
 * 每个返回项带 opaque investigate Action（factId + approachId），
 * 客户端只能消费其 runtime token；正文/方式 id 不进入投影。
 */
export function currentInvestigationApproachChoices(
  ws: WorldState,
  ss: StoryState,
): readonly { action: Extract<Action, { type: "investigate" }>; approach: InvestigationApproach }[] {
  const objective = currentObjectiveOf(ws, ss);
  if (objective === null) return [];
  const quest = ws.quests.find((entry) => String(entry.id) === String(objective.questId));
  const target = quest?.objectives[objective.objectiveIndex];
  if (target?.kind !== "discover_fact") return [];
  const fact = ws.worldFacts.find((entry) => String(entry.factId) === String(target.factId));
  if (fact === undefined) return [];
  const approaches = fact.investigationApproaches ?? [];
  if (approaches.length < 2) return [];
  if (fact.locationId !== ws.currentLocationId) return [];
  if (fact.discovered) return [];
  if (!isObjectiveEntityReleased(ws, ss, (candidate) =>
    candidate.kind === "discover_fact" && String(candidate.factId) === String(fact.factId),
  )) return [];
  return approaches.map((approach) => ({
    action: { type: "investigate", factId: fact.factId, approachId: approach.approachId },
    approach,
  }));
}

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
        if (
          !worldState.inventory.includes(itemId)
          && isObjectiveEntityReleased(worldState, storyState, (objective) =>
            objective.kind === "obtain_item" && String(objective.itemId) === String(itemId))
        ) {
          addRuntimeAction({ type: "take_item", itemId });
        }
      }
    }

    // 当前 discover_fact 主线目标事实的已审批调查方式 → 每个 approach 一个
    // 互不相同的 opaque token；客户端只能看到 label/hint，正文与方式 id
    // 在行动结算后才由场景投影（Task 4）。
    for (const { action } of currentInvestigationApproachChoices(worldState, storyState)) {
      addRuntimeAction(action);
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

    // 探索：仅当前地点有可探索内容（未发现线索/未拾取物品或敌人/未满足目标/候选事件）
    // 时才作为合法世界行动（方案 1：无剧情钩子不显示探索）。
    if (hasExplorableContent(worldState, storyState) || needsWorldBoundaryPreparation(storyState)) {
      addRuntimeAction({ type: "explore" });
    }
  }

  // 叙事场景的固定选项：只从服务端 choiceRegistry 按 token 映射。
  // 不再解析 scene.choices 的 actionKey；未知/过期 token 不产生映射。
  const scene = readyNarrative?.currentScene;
  const registry = readyNarrative?.choiceRegistry;
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
    // 探索：只有当前地点有可探索内容时，AI 提案的探索选项才合法并投影。
    case "explore":
      return hasExplorableContent(worldState, storyState) || needsWorldBoundaryPreparation(storyState);
    case "investigate":
      // 只接受当前 discover_fact 目标事实的已审批 approach（Task 4）。
      return currentInvestigationApproachChoices(worldState, storyState).some((entry) =>
        String(entry.action.factId) === String(action.factId)
        && String(entry.action.approachId) === String(action.approachId),
      );
    case "ack_prologue":
    case "freeform":
      return false;
  }
}

// ---------------------------------------------------------------------------
// 可探索性判定（方案 1 修订）：探索选项只在存在"探索能推进"的剧情钩子时
// 对玩家可见/可执行。
// 钩子 = 当前地点仍有未发现的线索事实、可拾取物品、未击败敌人、未满足的
// 地点相关目标，或候选事件池中涉及当前地点的有效（未过期）候选事件。
// 注意：探索不会代替拾取或攻击（它们仍走独立入口），但场景中存在未处理实体
// 时允许先观察现场；没有任何实体或线索的地点仍不显示探索，避免空转按钮。
// ---------------------------------------------------------------------------
export function hasExplorableContent(ws: WorldState, ss: StoryState): boolean {
  const currentId = ws.currentLocationId;

  // 物品与敌人都是场景中可被观察、靠近和处理的实体；有它们时“探索”不是
  // 空转，而是允许玩家先观察现场，再决定拾取或开战。
  const currentLocation = ws.locations.find((location) => location.id === currentId);
  if (currentLocation !== undefined) {
    const hasAvailableItem = currentLocation.availableItemIds.some((itemId) =>
      !ws.inventory.includes(itemId)
      && isObjectiveEntityReleased(ws, ss, (objective) =>
        objective.kind === "obtain_item" && String(objective.itemId) === String(itemId)),
    );
    const hasUndefeatedEnemy = ws.enemies.some((enemy) =>
      enemy.locationId === currentId
      && !ws.defeatedEnemyIds.includes(enemy.id)
      && isObjectiveEntityReleased(ws, ss, (objective) =>
        objective.kind === "defeat_enemy" && String(objective.enemyId) === String(enemy.id)),
    );
    if (hasAvailableItem || hasUndefeatedEnemy) return true;
  }

  // 对话场景始终提供一个非对白的“暂不回应，先观察”分支。它仍是
  // 正式 explore 回合，不是零写入闲聊旁路；固定选项因此明确覆盖
  // “玩家口吻对白 / 玩家动作”两种输入类型。
  if (ss.narrative.status === "ready"
    && ss.narrative.currentScene.event?.kind === "dialogue") return true;

  // 1) 本地点仍有未发现的线索事实（含 NPC 私密事实：探索可引动揭示，不泄漏正文）。
  //    有已审批调查方式（≥2 条）的事实已有正式调查入口，不再叠加一个无分支的
  //    explore（避免"调查方式"与"探索"两个意义重叠的按钮）；无方式的事实仍由
  //    探索观察或规则自动揭示推进。
  if (ws.worldFacts.some((f) =>
    f.locationId === currentId
    && !f.discovered
    && (f.investigationApproaches ?? []).length < 2
    && isObjectiveEntityReleased(ws, ss, (objective) =>
      objective.kind === "discover_fact" && String(objective.factId) === String(f.factId)),
  )) return true;

  // 2) 未满足的、指向本地点或其线索事实的任务目标（active 任务）。
  const hasUnmetLocationObjective = ws.quests.some((q) =>
    q.status === "active" &&
    q.objectives.some((o) => {
      if (o.kind === "visit_location") {
        return o.locationId === currentId
          && !ws.visitedLocationIds.includes(o.locationId)
          && isObjectiveEntityReleased(ws, ss, (candidate) =>
            candidate.kind === "visit_location" && String(candidate.locationId) === String(o.locationId));
      }
      if (o.kind === "discover_fact") {
        const fact = ws.worldFacts.find((f) => f.factId === o.factId);
        return fact !== undefined
          && fact.locationId === currentId
          && !fact.discovered
          // 有已审批调查方式的事实走正式调查入口，不再叠加 explore 死按钮。
          && (fact.investigationApproaches ?? []).length < 2
          && isObjectiveEntityReleased(ws, ss, (candidate) =>
            candidate.kind === "discover_fact" && String(candidate.factId) === String(o.factId));
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

/** 当前幕已结算但下一幕/结局尚未装配时，允许玩家提交一次边界编排行动。 */
export function needsWorldBoundaryPreparation(ss: StoryState): boolean {
  return ss.evolution.status === "needs_next_act" || ss.evolution.status === "needs_ending_pair";
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
