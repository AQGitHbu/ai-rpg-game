import { finalMainActOf } from "@/game/domain";
import type { EnemyId, GameState, ScenarioBlueprint, FactId, ItemId, LocationId, NpcId } from "@/game/domain";

// ---------------------------------------------------------------------------
// actions facade（Phase 3 Task 2）：application 可用的唯一 actions 入口。
// application 不能 deep import actions 内部文件。
// ---------------------------------------------------------------------------

export type { PlayerIntent, AckPrologueIntent } from "./intents";
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
// 对话布局重构：确定性 NPC 对白组合。
export { composeNpcSpeech } from "./npcSpeech";
// NPC 自由输入：纯规则分类器（零 AI）。
export { classifyFreeDialogue } from "./classifyFreeDialogue";
export { classifyDialogueTone } from "./classifyFreeDialogue";
export type { DialogueTone } from "./classifyFreeDialogue";
// NPC 自由输入：确定性闲聊回应（零 AI，与 composeNpcSpeech 并列）。
export { composeNpcCasualReply } from "./npcCasualReply";
// Phase 13：NPC 关系交互摘要投影。
export { projectRelationshipSummary } from "./relationshipSummary";

// ---------------------------------------------------------------------------
// 可用行动投影：由已编译蓝图和当前 GameState 投影。
// UI 不得自己猜测哪些目标可行动。
// Phase 4：talk 目标改由运行时 NPC 位置投影，新增 move 目标投影。
// Phase 5：新增 take_item 目标投影（当前地点预置且未拥有的物品）。
// ---------------------------------------------------------------------------

export type AvailableAction =
  | { readonly type: "observe"; readonly locationId: LocationId; readonly label: string }
  | { readonly type: "talk"; readonly npcId: NpcId; readonly label: string }
  | { readonly type: "investigate"; readonly factId: FactId; readonly label: string }
  | { readonly type: "move"; readonly locationId: LocationId; readonly label: string }
  | { readonly type: "take_item"; readonly itemId: ItemId; readonly label: string }
  | { readonly type: "start_battle"; readonly enemyId: EnemyId; readonly label: string }
  | { readonly type: "battle_action"; readonly action: "attack" | "guard" | "withdraw"; readonly label: string };

/**
 * Investigable facts used to share the generic label "调查线索", which made
 * two legal choices look identical in the player-facing scene and in quality
 * review. Do not expose fact text before the investigate action resolves it;
 * stable ordinal labels preserve the knowledge boundary while distinguishing
 * the available choices.
 */
function investigationLabel(index: number): string {
  return `调查第${index + 1}条线索`;
}

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
    for (const [index, factId] of blueprint.openingScene.investigableFactIds.entries()) {
      const factState = state.worldFacts.find((f) => f.factId === factId);
      if (factState !== undefined && !factState.discovered) {
        actions.push({
          type: "investigate",
          factId,
          label: investigationLabel(index),
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

  // take_item：当前地点预置且背包尚未拥有的物品
  for (const itemId of currentLocation?.availableItemIds ?? []) {
    if (state.inventory.includes(itemId)) {
      continue;
    }
    const item = blueprint.items.find((i) => i.id === itemId);
    if (item !== undefined) {
      actions.push({
        type: "take_item",
        itemId,
        label: `拾取${item.name}`,
      });
    }
  }

  // Phase 6: start_battle — 位于敌人地点、敌人是 active stage 3 defeat_enemy 目标、未已击败
  if (state.battle.status === "idle" && state.ending === null) {
    for (const enemy of blueprint.enemies) {
      if (enemy.locationId !== state.currentLocationId) continue;
      if (state.defeatedEnemyIds.includes(enemy.id)) continue;
      // 只投影 active 终幕 defeat_enemy 目标
      const isStage3Target = blueprint.quests.some((quest) => {
        if (quest.kind !== "main" || quest.stage !== finalMainActOf(blueprint)) return false;
        const questState = state.quests.find((qs) => qs.questId === quest.id);
        return questState?.status === "active" &&
          quest.objectives.some((obj) => obj.kind === "defeat_enemy" && obj.enemyId === enemy.id);
      });
      if (isStage3Target) {
        actions.push({
          type: "start_battle",
          enemyId: enemy.id,
          label: `挑战${enemy.name}`,
        });
      }
    }
  }

  // Phase 6: battle_action — 战斗中才投影
  if (state.battle.status === "active") {
    actions.push({ type: "battle_action", action: "attack", label: "攻击" });
    actions.push({ type: "battle_action", action: "guard", label: "防御" });
    actions.push({ type: "battle_action", action: "withdraw", label: "撤退" });
  }

  return actions;
}
