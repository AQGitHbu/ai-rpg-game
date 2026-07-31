import type { GameEvent } from "./events";
import type { NarrativeRuntimeState } from "./narrative";
import type { RelationshipValue } from "./relationship";
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
import type { StoryMemoryState } from "./storyMemory";
import type { TownPlanSource, TownSemanticPlan } from "./townSnapshot";

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
  // Phase 13：可选关系值；旧存档缺省时回退到 { affinity: 0 }（中立）
  readonly relationship?: RelationshipValue;
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

// Town 层：scale="town" 地点首次进入时懒生成的小镇规划。只存 plan+seed，
// 快照由 generateTown 在 read model 中确定性重建（存档小、同 seed 深度相等）。
export type TownRuntimeState = {
  readonly locationId: LocationId;
  readonly seed: string;
  readonly plan: TownSemanticPlan;
  readonly planSource: TownPlanSource;
  readonly generatorVersion: string;
};

// Town 层：AI 小镇规划生成状态；pending 由 town/ensure 轮询消费（镜像
// narrative.generation 的 pending/ensure/CAS 模式）。
export type TownGenerationState =
  | { readonly status: "idle" }
  | { readonly status: "pending"; readonly locationId: LocationId; readonly requestedAt: string };

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
  /** Phase 10：运行时叙事场景状态。 */
  readonly narrative: NarrativeRuntimeState;
  /** Town 层：已生成的小镇规划（按地点懒生成，每地点至多一条）。 */
  readonly towns: readonly TownRuntimeState[];
  /** Town 层：AI 小镇规划生成状态。 */
  readonly townGeneration: TownGenerationState;
  /**
   * Phase 11：结构化剧情记忆。可选以兼容旧 v1 存档（缺失时读取安全回退为空记忆）；
   * 由纯 reducer 从 eventLedger 归约，AI 文案不入记忆。
   */
  readonly storyMemory?: StoryMemoryState;
  /** 追加式事件账本：初始条目必须是 game_initialized。 */
  readonly eventLedger: readonly GameEvent[];
};
