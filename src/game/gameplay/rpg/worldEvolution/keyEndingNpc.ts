import type { WorldState } from "@/game/domain/worldState";
import type { NpcId } from "@/game/domain/worldEntity";

/**
 * 结局分歧的关键 NPC：取 stage 最大的主线任务中第一个 talk_to_npc 目标。
 * 中后期主线的交谈对象承载了玩家最新的情感积累，比“开局首位 NPC”更贴合
 * trust/doubt 分歧的叙事含义；无任何主线交谈目标时回退开局首位 NPC（旧行为）。
 */
export function deriveKeyEndingNpcId(ws: WorldState): NpcId | undefined {
  const mainQuests = ws.quests
    .filter((quest) => quest.kind === "main")
    // stage 为可选字段（QuestEntry.stage?: number），缺省按 0 处理；
    // stage 并列时优先仍在推进的 active 任务（失败重铸的同 stage 旧任务不抢占锚点）。
    .sort((a, b) => {
      const stageDiff = (b.stage ?? 0) - (a.stage ?? 0);
      if (stageDiff !== 0) return stageDiff;
      return Number(b.status === "active") - Number(a.status === "active");
    });
  for (const quest of mainQuests) {
    const talkObjective = quest.objectives.find((objective) => objective.kind === "talk_to_npc");
    if (talkObjective !== undefined) return talkObjective.npcId;
  }
  return ws.npcs[0]?.id;
}
