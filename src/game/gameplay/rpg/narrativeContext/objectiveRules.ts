import type { WorldState } from "@/game/domain/worldState";
import { findNpc, findLocation, findItem } from "@/game/domain/worldState";

// 内部共享规则：目标满足判定与稳定展示标签（与 ruleEngine/reconcileQuests 语义一致）。

export type QuestObjective = WorldState["quests"][number]["objectives"][number];

export function isObjectiveSatisfied(ws: WorldState, objective: QuestObjective): boolean {
  switch (objective.kind) {
    case "visit_location": return ws.visitedLocationIds.includes(objective.locationId);
    case "talk_to_npc": return ws.npcs.find((n) => n.id === objective.npcId)?.met ?? false;
    case "obtain_item": return ws.inventory.includes(objective.itemId);
    case "discover_fact": return ws.worldFacts.find((f) => f.factId === objective.factId)?.discovered ?? false;
    case "defeat_enemy": return ws.defeatedEnemyIds.includes(objective.enemyId);
  }
}

// 从当前世界状态出稳定标签，绝不在客户端泄漏实体 ID 或玩家原文。
export function objectiveLabel(ws: WorldState, objective: QuestObjective | undefined): string {
  if (!objective) return "探寻新的线索";
  switch (objective.kind) {
    case "visit_location": {
      const loc = findLocation(ws, objective.locationId);
      return loc ? `前往${loc.name}` : "前往某地";
    }
    case "talk_to_npc": {
      const npc = findNpc(ws, objective.npcId);
      return npc ? `与${npc.name}交谈` : "与某人交谈";
    }
    case "obtain_item": {
      const item = findItem(ws, objective.itemId);
      return item ? `获取${item.name}` : "获取某物";
    }
    case "discover_fact": {
      const fact = ws.worldFacts.find((f) => f.factId === objective.factId);
      // 未发现的事实正文绝不进入标签（最小权限；发现后与事件卡同文案）。
      return fact?.discovered === true ? `查明：${fact.text}` : "查明某件往事";
    }
    case "defeat_enemy": {
      const enemy = ws.enemies.find((e) => e.id === objective.enemyId);
      return enemy ? `击败${enemy.name}` : "击败强敌";
    }
  }
}
