import type { EndingId, EnemyId, FactId, GenerationMetadata, ItemId, LocationId, NpcId, QuestId } from "./worldEntity";
import type { CombatActionResult, CombatActionKind } from "./combat";

export type StoryPacing = "setup" | "develop" | "turn" | "climax" | "resolution";

declare const turnContextIdBrand: unique symbol;
type BrandedTurnContextId<Name extends string> = string & {
  readonly [turnContextIdBrand]: Name;
};

/** 一次规则回合的稳定标识；具体生成策略由领域外调用方决定。 */
export type TurnId = BrandedTurnContextId<"TurnId">;

/** 一个可恢复叙事任务的稳定标识；具体生成策略由领域外调用方决定。 */
export type NarrativeJobId = BrandedTurnContextId<"NarrativeJobId">;

/** 纯品牌转换：不读取时钟、随机数、环境变量或其它 IO。 */
export function asTurnId(raw: string): TurnId {
  return raw as TurnId;
}

/** 纯品牌转换：不读取时钟、随机数、环境变量或其它 IO。 */
export function asNarrativeJobId(raw: string): NarrativeJobId {
  return raw as NarrativeJobId;
}

// 领域事件：纯数据，时间戳等外部信息由调用方传入（domain 不读取时钟）。
// Phase 3 扩展：行动 resolver 产出地点观察、NPC 初次交谈和事实发现三种事件。
// Phase 4 扩展：move 行动成功时追加地点到访事件；任务 reconciliation 产出任务完成与解锁事件。
// Phase 5 扩展：take_item 行动成功时追加物品取得事件。

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
  // Phase 13：可选交互类型，reconcileStoryMemory 据此生成 lastInteractionSummary。
  // 旧存档缺省时回退到 undefined，reducer 安全跳过。
  readonly interactionKind?: "greet" | "ask_main_quest";
};

/**
 * 一名 NPC 的正式多轮对话会话已经完成。`npc_met` 只表示接触发生；任务和
 * 后续目标必须以本事件或当前 completed dialogueSession 作为历史完成事实。
 */
export type NpcDialogueCompletedEvent = {
  readonly type: "npc_dialogue_completed";
  readonly npcId: NpcId;
  readonly occurredAt: string;
};

/** 玩家发现世界事实：由 investigate 行动成功时追加；重复调查不产生此事件。 */
export type FactDiscoveredEvent = {
  readonly type: "fact_discovered";
  readonly factId: FactId;
  readonly occurredAt: string;
  /** 在场目击的 NPC（scene_witness 传播来源）；缺省 = 无人目击，不自动传播。 */
  readonly witnessNpcIds?: readonly NpcId[];
  /** 玩家所选调查方式；自动揭示或旧事件缺省，不参与事实裁决。 */
  readonly approachId?: string;
  /** 证据质量；旧事件/自动揭示缺省时按 "clean" 读取。 */
  readonly evidenceQuality?: "clean" | "noisy";
  /** 本方式声明的额外张力；旧事件/自动揭示缺省时按 0 的额外张力读取，保留既有 fact_discovered 基础张力。 */
  readonly tensionDelta?: number;
};

/** 玩家移动到达地点：由 move 行动成功时追加；重复到访照常追加事件。 */
export type LocationVisitedEvent = {
  readonly type: "location_visited";
  readonly locationId: LocationId;
  readonly occurredAt: string;
};

/** 玩家探索当前地点：由 explore 行动成功时追加（Spec §7/Task 29，不得 success + 空事件）。 */
export type LocationExploredEvent = {
  readonly type: "location_explored";
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

/** 地点解锁：由任务 outcome（unlock_quests 携带 locationIds）将 locked 地点解锁时追加。
 *  地点解锁只能来自规则 outcome/事实/权限/物品/批准候选事件，禁止交给 worldEvolution。 */
export type LocationUnlockedEvent = {
  readonly type: "location_unlocked";
  readonly locationId: LocationId;
  readonly occurredAt: string;
};

/** 玩家取得地点预置物品：由 take_item 行动成功时追加；locationId 为取得时所在地点。 */
export type ItemObtainedEvent = {
  readonly type: "item_obtained";
  readonly itemId: ItemId;
  readonly locationId: LocationId;
  readonly occurredAt: string;
};

/** 玩家将背包物品移交给在场 NPC：由 give_item 行动成功时追加。 */
export type ItemGivenEvent = {
  readonly type: "item_given";
  readonly itemId: ItemId;
  readonly npcId: NpcId;
  readonly locationId: LocationId;
  readonly occurredAt: string;
};

/** Phase 6：战斗开始——由 start_battle 成功时追加。 */
export type BattleStartedEvent = {
  readonly type: "battle_started";
  readonly enemyId: EnemyId;
  /** 多敌人遭遇的扩展字段；旧单敌人事件仍可读取 enemyId。 */
  readonly enemyIds?: readonly EnemyId[];
  readonly occurredAt: string;
};

/** Phase 6：单回合结算——由 battle_action 成功时追加，含回合后双方剩余生命。 */
export type BattleRoundResolvedEvent = {
  readonly type: "battle_round_resolved";
  readonly enemyId: EnemyId;
  readonly round: number;
  readonly playerHp: number;
  readonly enemyHp: number;
  readonly action: CombatActionKind | "withdraw";
  readonly results?: readonly CombatActionResult[];
  readonly occurredAt: string;
};

/** Phase 6：战斗结束——胜利、失败或撤退。 */
export type BattleResolvedEvent = {
  readonly type: "battle_resolved";
  readonly enemyId: EnemyId;
  readonly enemyIds?: readonly EnemyId[];
  readonly outcome: "victory" | "defeat" | "withdraw";
  readonly occurredAt: string;
};

/** Phase 6：敌人被击败——胜利战斗后追加，写入 defeatedEnemyIds。 */
export type EnemyDefeatedEvent = {
  readonly type: "enemy_defeated";
  readonly enemyId: EnemyId;
  readonly occurredAt: string;
};

/** Phase 6：任务失败——由显式 failQuest 入口将 active quest 置为 failed 时追加。 */
export type QuestFailedEvent = {
  readonly type: "quest_failed";
  readonly questId: QuestId;
  readonly occurredAt: string;
};

/** Phase 6：结局抵达——由 ending resolver 在满足结局条件后追加，结局状态只能写入一次。 */
export type EndingReachedEvent = {
  readonly type: "ending_reached";
  readonly endingId: EndingId;
  readonly outcome: "success" | "failure";
  readonly occurredAt: string;
};

/** Phase 10：叙事选择——玩家在 AI 导演场景中做出的选择。 */
export type NarrativeChoiceEvent = {
  readonly type: "narrative_choice";
  readonly choiceToken: string;
  readonly actionKey: string;
  readonly sceneId: string;
  readonly occurredAt: string;
};

/** 玩家在 NPC 对话场景中选择的回应；不直接触发规则行动。 */
export type NarrativeDialogueChoiceEvent = {
  readonly type: "narrative_dialogue_choice";
  readonly choiceToken: string;
  readonly dialogueIntent: string;
  readonly npcId: NpcId;
  readonly sceneId: string;
  readonly occurredAt: string;
};

/**
 * Phase 11：场景提交事件——玩家已看见一幕及其安全结构索引的审计事实。
 * 只携带结构索引（场景 ID、地点、焦点 NPC、已向玩家呈现的已发现事实 ID、节奏标签），
 * 绝不携带 narration、NPC 台词、choiceToken、actionKey 或 AI provenance。
 */
export type NarrativeScenePresentedEvent = {
  readonly type: "narrative_scene_presented";
  readonly sceneId: string;
  readonly locationId: LocationId;
  readonly focusNpcId: NpcId | null;
  readonly revealedFactIds: readonly FactId[];
  readonly pacing: StoryPacing;
  readonly occurredAt: string;
};

/** 蓝图动态化：运行时蓝图扩展落账——记录本次追加的实体 ID，供回放与调试。 */
export type BlueprintExpandedEvent = {
  readonly type: "blueprint_expanded";
  readonly newLocationIds: readonly LocationId[];
  readonly newNpcIds: readonly NpcId[];
  readonly newFactIds?: readonly FactId[];
  readonly newItemIds?: readonly ItemId[];
  readonly newEnemyIds?: readonly EnemyId[];
  readonly newQuestIds?: readonly QuestId[];
  readonly newEndingIds?: readonly EndingId[];
  readonly occurredAt: string;
};

/**
 * Task 9：玩家自由输入未映射为规则行动时表达意图的结构化审计事件。
 * 只携带解析结果 intent 兜底标，绝不携带玩家原文（原文只允许出现在
 * PendingNarrativeJob.utterance，供叙事回应）。
 */
export type PlayerIntentExpressedEvent = {
  readonly type: "player_intent_expressed";
  readonly intent: string;
  readonly occurredAt: string;
};

// ---------------------------------------------------------------------------
// R4（Task 18）：AI 候选事件生命周期审计事件
// 只携带结构化索引（candidateId/kind/turn/code），绝不携带完整 AI 原文或隐藏事实正文。
// ---------------------------------------------------------------------------

/** 候选事件进入池：由 SceneWriteBack 追加候选时写入。 */
export type CandidateEventProposedEvent = {
  readonly type: "candidate_event_proposed";
  readonly candidateId: string;
  readonly kind: string;
  readonly proposedAtTurn: number;
  readonly expiresAtTurn: number;
  readonly occurredAt: string;
};

/** 候选事件审批通过：由下一回合纯规则审批成功后写入。 */
export type CandidateEventApprovedEvent = {
  readonly type: "candidate_event_approved";
  readonly candidateId: string;
  readonly kind: string;
  readonly approvedAtTurn: number;
  readonly occurredAt: string;
};

/** 候选事件审批拒绝：原因用稳定 code，不携带冲突正文。 */
export type CandidateEventRejectedEvent = {
  readonly type: "candidate_event_rejected";
  readonly candidateId: string;
  readonly kind: string;
  readonly reasonCode: string;
  readonly rejectedAtTurn: number;
  readonly occurredAt: string;
};

/** 候选事件过期：当前回合超过 expiresAtTurn 且未审批时写入。 */
export type CandidateEventExpiredEvent = {
  readonly type: "candidate_event_expired";
  readonly candidateId: string;
  readonly kind: string;
  readonly expiredAtTurn: number;
  readonly occurredAt: string;
};

/** 候选事件激活：审批通过后编译为真实领域事件与状态变化时写入。 */
export type CandidateEventActivatedEvent = {
  readonly type: "candidate_event_activated";
  readonly candidateId: string;
  readonly kind: string;
  readonly activatedAtTurn: number;
  readonly occurredAt: string;
};

export type GameEvent =
  | GameInitializedEvent
  | LocationObservedEvent
  | NpcMetEvent
  | NpcDialogueCompletedEvent
  | FactDiscoveredEvent
  | LocationVisitedEvent
  | LocationExploredEvent
  | QuestCompletedEvent
  | QuestUnlockedEvent
  | LocationUnlockedEvent
  | ItemObtainedEvent
  | ItemGivenEvent
  | BattleStartedEvent
  | BattleRoundResolvedEvent
  | BattleResolvedEvent
  | EnemyDefeatedEvent
  | QuestFailedEvent
  | EndingReachedEvent
  | NarrativeChoiceEvent
  | NarrativeDialogueChoiceEvent
  | NarrativeScenePresentedEvent
  | BlueprintExpandedEvent
  | PlayerIntentExpressedEvent
  | CandidateEventProposedEvent
  | CandidateEventApprovedEvent
  | CandidateEventRejectedEvent
  | CandidateEventExpiredEvent
  | CandidateEventActivatedEvent;
