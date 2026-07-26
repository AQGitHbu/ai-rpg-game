import type { GameEvent } from "./events";
import type {
  FactId,
  GenerationMetadata,
  ItemId,
  LocationId,
  NpcId,
  QuestId,
  StatBlock
} from "./scenarioBlueprint";

// Phase 1 最小运行时状态：纯数据类型，不含行动 resolver 或任何方法。
// 状态只能由已编译蓝图初始化（Task 5 的 initializeGameState）。

export type PlayerState = {
  readonly name: string;
  readonly identity: string;
  readonly stats: StatBlock;
};

export type NpcRuntimeState = {
  readonly npcId: NpcId;
  readonly locationId: LocationId;
  readonly met: boolean;
};

export type QuestStatus = "locked" | "active" | "completed" | "failed" | "closed";

export type QuestRuntimeState = {
  readonly questId: QuestId;
  readonly status: QuestStatus;
};

export type WorldFactState = {
  readonly factId: FactId;
  readonly discovered: boolean;
};

export type GameState = {
  readonly stateVersion: 1;
  readonly generation: GenerationMetadata;
  readonly player: PlayerState;
  readonly currentLocationId: LocationId;
  readonly unlockedLocationIds: readonly LocationId[];
  readonly npcs: readonly NpcRuntimeState[];
  readonly quests: readonly QuestRuntimeState[];
  readonly inventory: readonly ItemId[];
  readonly worldFacts: readonly WorldFactState[];
  /** 追加式事件账本：初始条目必须是 game_initialized。 */
  readonly eventLedger: readonly GameEvent[];
};
