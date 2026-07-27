import type { FactId, GenerationMetadata, LocationId, NpcId, QuestId } from "./scenarioBlueprint";

// 领域事件：纯数据，时间戳等外部信息由调用方传入（domain 不读取时钟）。
// Phase 3 扩展：行动 resolver 产出地点观察、NPC 初次交谈和事实发现三种事件。
// Phase 4 扩展：move 行动成功时追加地点到访事件；任务 reconciliation 产出任务完成与解锁事件。

/** 初始事件账本条目：记录本局的生成元数据（Task 5 初始化时写入）。 */
export type GameInitializedEvent = {
  readonly type: "game_initialized";
  readonly generation: GenerationMetadata;
};

/** 玩家观察当前地点：由 observe 行动成功时追加。 */
export type LocationObservedEvent = {
  readonly type: "location_observed";
  readonly locationId: LocationId;
  /** ISO 8601 时间戳：由 resolver 从注入的时钟获取，domain 不读时钟。 */
  readonly occurredAt: string;
};

/** 玩家初次与 NPC 交谈：由 talk 行动成功时追加；重复交谈不产生此事件。 */
export type NpcMetEvent = {
  readonly type: "npc_met";
  readonly npcId: NpcId;
  readonly occurredAt: string;
};

/** 玩家发现世界事实：由 investigate 行动成功时追加；重复调查不产生此事件。 */
export type FactDiscoveredEvent = {
  readonly type: "fact_discovered";
  readonly factId: FactId;
  readonly occurredAt: string;
};

/** 玩家移动到达地点：由 move 行动成功时追加；重复到访照常追加事件。 */
export type LocationVisitedEvent = {
  readonly type: "location_visited";
  readonly locationId: LocationId;
  readonly occurredAt: string;
};

/** 任务完成：由任务 reconciliation 在 active 任务全部 objective 满足时追加。 */
export type QuestCompletedEvent = {
  readonly type: "quest_completed";
  readonly questId: QuestId;
  readonly occurredAt: string;
};

/** 任务解锁：由已完成任务的 onSuccess.unlock_quests 将 locked 任务置为 active 时追加。 */
export type QuestUnlockedEvent = {
  readonly type: "quest_unlocked";
  readonly questId: QuestId;
  readonly occurredAt: string;
};

export type GameEvent =
  | GameInitializedEvent
  | LocationObservedEvent
  | NpcMetEvent
  | FactDiscoveredEvent
  | LocationVisitedEvent
  | QuestCompletedEvent
  | QuestUnlockedEvent;
