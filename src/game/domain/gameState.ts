import type { GameEvent } from "./events";
import type {
  EndingId,
  EnemyId,
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

// Phase 6：轻量战斗运行时状态。idle = 无战斗；active = 战斗中；
// resolved = 战斗已结束（胜利/失败/撤退），等待后续结算。
export type BattleStatus = "idle" | "active" | "resolved";

export type BattleState =
  | { readonly status: "idle" }
  | {
      readonly status: "active";
      readonly enemyId: EnemyId;
      readonly playerHp: number;
      readonly enemyHp: number;
      readonly round: number;
    }
  | {
      readonly status: "resolved";
      readonly enemyId: EnemyId;
      readonly outcome: "victory" | "defeat" | "withdraw";
    };

// Phase 6：结局运行时状态。null = 未抵达结局；写入后不可变更。
export type EndingState = {
  readonly endingId: EndingId;
  readonly outcome: "success" | "failure";
} | null;

export type GameState = {
  readonly stateVersion: 1;
  readonly generation: GenerationMetadata;
  readonly player: PlayerState;
  readonly currentLocationId: LocationId;
  readonly unlockedLocationIds: readonly LocationId[];
  /** 已到访地点（含开场地点）：Phase 4 任务 reconciliation 读取的 visit 事实。 */
  readonly visitedLocationIds: readonly LocationId[];
  readonly npcs: readonly NpcRuntimeState[];
  readonly quests: readonly QuestRuntimeState[];
  readonly inventory: readonly ItemId[];
  readonly worldFacts: readonly WorldFactState[];
  /** Phase 6：已击败敌人 ID 列表；defeat_enemy objective 读取此事实。 */
  readonly defeatedEnemyIds: readonly EnemyId[];
  /** Phase 6：战斗运行时状态。 */
  readonly battle: BattleState;
  /** Phase 6：结局运行时状态；null 表示未抵达结局。 */
  readonly ending: EndingState;
  /** 追加式事件账本：初始条目必须是 game_initialized。 */
  readonly eventLedger: readonly GameEvent[];
};
