import type { EnemyId, FactId, ItemId, LocationId, NpcId } from "@/game/domain";
import type { DialogueChoiceIntent } from "./dialogueChoices";

// ---------------------------------------------------------------------------
// 玩家意图：封闭 discriminated union。
// 浏览器只能从当前 read model 返回的 AvailableAction 中提交一种意图。
// 不得提交 freeText、seed、gameId、完整 state 或任何数值字段。
// Phase 4 扩展：move 移动到连通且已解锁的地点。
// Phase 5 扩展：take_item 取得当前地点预置的物品。
// Phase 6 扩展：start_battle 开始 boss 战斗；battle_action 执行战斗行动。
// Phase 7 扩展：dialogue_choice 从封闭的对话选择枚举中提交一项。
// ---------------------------------------------------------------------------

export type PlayerIntent =
  | { readonly type: "observe"; readonly locationId: LocationId }
  | { readonly type: "talk"; readonly npcId: NpcId }
  | { readonly type: "investigate"; readonly factId: FactId }
  | { readonly type: "move"; readonly locationId: LocationId }
  | { readonly type: "take_item"; readonly itemId: ItemId }
  | { readonly type: "start_battle"; readonly enemyId: EnemyId }
  | { readonly type: "battle_action"; readonly action: "attack" | "guard" | "withdraw" }
  | DialogueChoiceIntent;
