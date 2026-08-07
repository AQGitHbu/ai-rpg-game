import type { ExpansionSource } from "@/game/gameplay/rpg/expansion/expansionSource";

// ---------------------------------------------------------------------------
// Fixture ExpansionSource：离线确定性提案，测试用。
// 类型定义在 gameplay 层的 expansion/expansionSource.ts。
// ---------------------------------------------------------------------------

export function createFixtureExpansionSource(): ExpansionSource {
  return {
    async propose(ctx) {
      if (ctx.action.type === "move") {
        return {
          proposals: [{
            kind: "location",
            name: "未知之地",
            description: "一片尚未探索的神秘区域，充满了未知的危险。",
            scale: "scene",
            connectFromLocationId: String(ctx.worldState.currentLocationId),
            reason: "玩家要求前往未知地点",
          }],
        };
      }
      if (ctx.action.type === "talk") {
        return {
          proposals: [{
            kind: "npc",
            name: "陌生人",
            role: "路人",
            description: "一个你不认识的人，出现在了这里。",
            locationId: String(ctx.worldState.currentLocationId),
          }],
        };
      }
      return { proposals: [] };
    },
  };
}
