import type { QuestDefinition, QuestObjective, ScenarioBlueprint } from "@/game/domain";
import { asLocationId } from "@/game/domain";
import type { PlayerIntent } from "@/game/gameplay/rpg/actions";
import { performAction } from "../performAction";
import type { GameRepository } from "@/game/application/index.v1";

const FIXED_ACTION_TIME = "2026-08-04T00:00:00.000Z";

function isMainQuest(quest: QuestDefinition): quest is Extract<QuestDefinition, { kind: "main" }> {
  return quest.kind === "main";
}

/** 蓝图连通图上的最短移动路径（BFS；不含起点、含终点）。不可达 ⇒ 抛错。 */
function movePath(blueprint: ScenarioBlueprint, fromId: string, toId: string): readonly string[] {
  if (fromId === toId) return [];
  const previous = new Map<string, string>();
  const visited = new Set<string>([fromId]);
  const queue: string[] = [fromId];
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    const location = blueprint.locations.find((entry) => entry.id === current);
    if (location === undefined) throw new Error(`蓝图缺少地点：${current}`);
    for (const next of location.connectedLocationIds) {
      if (visited.has(next)) continue;
      visited.add(next);
      previous.set(next, current);
      if (next === toId) {
        const path: string[] = [];
        let cursor: string = toId;
        while (cursor !== fromId) {
          path.unshift(cursor);
          const step = previous.get(cursor);
          if (step === undefined) throw new Error(`路径回溯失败：${fromId} → ${toId}`);
          cursor = step;
        }
        return path;
      }
      queue.push(next);
    }
  }
  throw new Error(`蓝图地点不连通：${fromId} → ${toId}`);
}

/** 把途中每一步转成 move intent，返回终点。 */
function appendTravel(
  blueprint: ScenarioBlueprint,
  intents: PlayerIntent[],
  fromId: string,
  toId: string,
): string {
  for (const step of movePath(blueprint, fromId, toId)) {
    intents.push({ type: "move", locationId: asLocationId(step) } as PlayerIntent);
  }
  return toId;
}

/**
 * 由蓝图定位 objective 目标所在 locationId；找不到即缺陷蓝图，抛错中止。
 * fact 只在 openingScene 可调查，目标地点固定为 openingScene.locationId。
 */
function objectiveTargetLocation(blueprint: ScenarioBlueprint, objective: QuestObjective): string {
  switch (objective.kind) {
    case "visit_location":
      return objective.locationId;
    case "talk_to_npc": {
      const npc = blueprint.npcs.find((entry) => entry.id === objective.npcId);
      if (npc === undefined) throw new Error(`蓝图缺少 NPC：${objective.npcId}`);
      return npc.locationId;
    }
    case "obtain_item": {
      const stocked = blueprint.locations.find((entry) =>
        entry.availableItemIds.includes(objective.itemId)
      );
      if (stocked === undefined) throw new Error(`没有地点预置物品：${objective.itemId}`);
      return stocked.id;
    }
    case "discover_fact":
      if (!blueprint.openingScene.investigableFactIds.includes(objective.factId)) {
        throw new Error(`开场场景不可调查的事实：${objective.factId}`);
      }
      return blueprint.openingScene.locationId;
    case "defeat_enemy": {
      const enemy = blueprint.enemies.find((entry) => entry.id === objective.enemyId);
      if (enemy === undefined) throw new Error(`蓝图缺少敌人：${objective.enemyId}`);
      return enemy.locationId;
    }
    default: {
      const unknown = objective as { readonly kind?: unknown };
      throw new Error(`未知 objective kind：${String(unknown.kind)}`);
    }
  }
}

/**
 * 泛化全主线：stage 1..mainActs-1 的 objectives 逐类映射为 intent，
 * 推到最后一幕 active 并抵达 boss 所在地点。若缺陷蓝图缺目标 throw。
 * （fallback 主线的 defeat_enemy 只出现在终幕，由测试在旅程外驱动战斗；
 * 若未来中幕出现该目标，映射的 start_battle 会在 performRuleSequence 内直接结算。）
 */
export function buildEndToEndRuleJourney(blueprint: ScenarioBlueprint, bossLocationId: string): {
  intents: readonly PlayerIntent[];
  endLocationId: string;
} {
  const mainQuests = blueprint.quests.filter(isMainQuest)
    .sort((a, b) => a.stage - b.stage);
  const mainActs = mainQuests.length;
  const intents: PlayerIntent[] = [];
  let at: string = blueprint.player.startingLocationId;
  for (let stage = 1; stage < mainActs; stage += 1) {
    const quest = mainQuests[stage - 1];
    for (const objective of quest.objectives) {
      const target = objectiveTargetLocation(blueprint, objective);
      if (target !== at) at = appendTravel(blueprint, intents, at, target);
      switch (objective.kind) {
        case "visit_location":
          break;
        case "talk_to_npc":
          intents.push({ type: "talk", npcId: objective.npcId } as PlayerIntent);
          break;
        case "obtain_item":
          intents.push({ type: "take_item", itemId: objective.itemId } as PlayerIntent);
          break;
        case "discover_fact":
          intents.push({ type: "investigate", factId: objective.factId } as PlayerIntent);
          break;
        case "defeat_enemy":
          intents.push({ type: "start_battle", enemyId: objective.enemyId } as PlayerIntent);
          break;
      }
    }
  }
  if (at !== bossLocationId) at = appendTravel(blueprint, intents, at, bossLocationId);
  return { intents, endLocationId: at };
}

/** 从蓝图找到 boss 敌人完整定义。 */
export function findBossEnemy(blueprint: ScenarioBlueprint): ScenarioBlueprint["enemies"][number] {
  const boss = blueprint.enemies.find((entry) => entry.tier === "boss");
  if (boss === undefined) throw new Error("蓝图缺少 boss 敌人");
  return boss;
}

/** 依次执行必须成功的行动（= phase4c performSequence 泛化），返回最新 revision。 */
export async function performRuleSequence(
  repository: GameRepository,
  intents: readonly PlayerIntent[],
  startRevision: number,
): Promise<number> {
  let revision = startRevision;
  for (const intent of intents) {
    const result = await performAction(
      { intent, expectedRevision: revision },
      { repository, now: () => FIXED_ACTION_TIME },
    );
    if (!result.ok) {
      throw new Error(`前置行动应当成功：${JSON.stringify(intent)} → ${JSON.stringify(result)}`);
    }
    revision = result.view.revision;
  }
  return revision;
}