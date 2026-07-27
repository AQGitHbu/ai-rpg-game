import type { FactId, LocationId, NpcId } from "@/game/domain";

// ---------------------------------------------------------------------------
// Phase 3 玩家意图：封闭 discriminated union。
// 浏览器只能从当前 read model 返回的 AvailableAction 中提交一种意图。
// 不得提交 freeText、seed、gameId、完整 state 或任何数值字段。
// ---------------------------------------------------------------------------

export type PlayerIntent =
  | { readonly type: "observe"; readonly locationId: LocationId }
  | { readonly type: "talk"; readonly npcId: NpcId }
  | { readonly type: "investigate"; readonly factId: FactId };
