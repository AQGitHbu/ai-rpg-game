import type { WorldState } from "@/game/domain/worldState";
import type { ItemId } from "@/game/domain/worldEntity";
import { findNpc, findLocation, findItem } from "@/game/domain/worldState";

// 内部共享规则：目标满足判定与稳定展示标签（与 ruleEngine/reconcileQuests 语义一致）。

export type QuestObjective = WorldState["quests"][number]["objectives"][number];

function hasObtainedItem(ws: WorldState, itemId: ItemId): boolean {
  return ws.inventory.includes(itemId)
    || ws.eventLedger.some((event) => event.type === "item_obtained" && event.itemId === itemId);
}

export function isObjectiveSatisfied(ws: WorldState, objective: QuestObjective): boolean {
  switch (objective.kind) {
    case "visit_location": return ws.visitedLocationIds.includes(objective.locationId);
    case "talk_to_npc": {
      const completed = ws.eventLedger.some((event) =>
        event.type === "npc_dialogue_completed" && event.npcId === objective.npcId);
      if (completed) return true;
      // 旧存档没有 dialogue-completed 事件；在当前会话规则介入前仍按 met
      // 兼容读取。新运行时的当前 NPC 总会由 dialogueSession 覆盖此结果。
      return ws.npcs.find((n) => n.id === objective.npcId)?.met ?? false;
    }
    // 物品取得是历史事实：玩家可能先拾取、再按剧情交给 NPC，不能因为
    // 当前背包为空就把已经完成的“获取”目标重新打开。
    case "obtain_item": return hasObtainedItem(ws, objective.itemId);
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
      if (!npc) return "与某人交谈";
      // 前往和交谈是两个可观察、可释放的阶段，不能再把它们压成一句
      // 任务文本；否则玩家会看到一个尚未抵达的人物已经“可交谈”。
      return `与${npc.name}交谈`;
    }
    case "obtain_item": {
      const item = findItem(ws, objective.itemId);
      return item ? `获取${item.name}` : "获取某物";
    }
    case "discover_fact": {
      const fact = ws.worldFacts.find((f) => f.factId === objective.factId);
      // 未发现的事实正文绝不进入标签；调查提示可以指向现场，但不能给答案。
      return fact?.discovered === true
        ? `查明：${fact.text}`
        : `调查${fact?.investigationLabel ?? "现场线索"}`;
    }
    case "defeat_enemy": {
      const enemy = ws.enemies.find((e) => e.id === objective.enemyId);
      return enemy ? `击败${enemy.name}` : "击败强敌";
    }
  }
}
