import type { EndingId, EnemyId, FactId, GenerationMetadata, ItemId, LocationId, NpcId, QuestId, PlayerEntityId } from "./worldEntity";
import type { CombatActionResult, CombatActionKind } from "./combat";
import type { DialogueAct } from "./action";
import type { RelationshipSignal } from "./entity/npcComponents";

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
  /** 服务器铸造的本轮 action provenance；旧存档事件可缺省。 */
  readonly actionId?: string;
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
  /** 服务器铸造的本轮 action provenance；旧存档事件可缺省。 */
  readonly actionId?: string;
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

// ---------------------------------------------------------------------------
// Plan 4：Committed Narrative Event 体系（增量引入，不切换 WorldState.eventLedger）
// Task 1 只新增类型和 commit helper；Task 2 才把 WorldState.eventLedger 切到新形状。
// 旧 GameEvent 保留为 Task 2 cutover 前的源码兼容名。
// ---------------------------------------------------------------------------

declare const eventIdBrand: unique symbol;
declare const episodeIdBrand: unique symbol;

/** 稳定事件 ID：由 domain helper 从 turnId + eventKey 确定性铸造。 */
export type EventId = string & { readonly [eventIdBrand]: unique symbol };

/** 稳定 Episode ID：由 domain helper 从 turnId/episodeKey 确定性铸造。 */
export type EpisodeId = string & { readonly [episodeIdBrand]: unique symbol };

/** 纯品牌转换：不读时钟、随机数或 IO。 */
export function asEventId(raw: string): EventId {
  return raw as EventId;
}

/** 纯品牌转换：不读时钟、随机数或 IO。 */
export function asEpisodeId(raw: string): EpisodeId {
  return raw as EpisodeId;
}

/**
 * 确定性铸造 Event ID：同一 turnId + eventKey 永远得到同一 ID。
 * 不读时钟、随机数、环境变量或 IO。
 */
export function eventIdFor(turnId: TurnId, eventKey: string): EventId {
  return asEventId(`${turnId}:${eventKey}`);
}

/**
 * 确定性铸造 Episode ID（turn 聚合）：同一 turnId 永远得到同一 Episode ID。
 */
export function episodeIdForTurn(turnId: TurnId): EpisodeId {
  return asEpisodeId(`episode:${turnId}`);
}

// ---------------------------------------------------------------------------
// 新 payload union（Task 1 增量引入；Task 2 删除旧 GameEvent 后成为唯一 payload）
// 新增三种 NPC 规则事实 payload；收口旧遗留变体（narrative_choice 等）
// ---------------------------------------------------------------------------

/** NPC 交互记录：封闭 dialogueAct + npcId，不保存台词正文。 */
export type NpcInteractionRecordedPayload = Readonly<{
  readonly type: "npc_interaction_recorded";
  readonly npcId: NpcId;
  readonly dialogueAct: DialogueAct | "freeform";
}>;

/** NPC 知识变化：封闭 change + npcId + factId，不保存 Fact 正文。 */
export type NpcKnowledgeChangedPayload = Readonly<{
  readonly type: "npc_knowledge_changed";
  readonly npcId: NpcId;
  readonly factId: FactId;
  readonly change: "learned" | "certainty_upgraded" | "disclosure_changed";
}>;

/** NPC 关系变化：封闭 signal + from/to，不保存裸数值 delta。 */
export type NpcRelationshipChangedPayload = Readonly<{
  readonly type: "npc_relationship_changed";
  readonly fromNpcId: NpcId;
  readonly targetId: PlayerEntityId | NpcId;
  readonly signal: RelationshipSignal;
}>;

/**
 * narrative_scene_presented 的最小 payload（Plan 4 Canonical Contract）。
 * 地点与参与实体只放 envelope，避免双写漂移。
 */
export type NarrativeScenePresentedPayload = Readonly<{
  readonly type: "narrative_scene_presented";
  readonly sceneId: string;
  readonly focusNpcId: NpcId | null;
  readonly pacing: StoryPacing;
  readonly beatIds: readonly string[];
  readonly revealedFactIds: readonly FactId[];
}>;

/**
 * player_intent_expressed 的封闭 payload：
 * 只保存 intentCode，不保存 Action.intent 字符串或玩家原文。
 */
export type PlayerIntentExpressedPayload = Readonly<{
  readonly type: "player_intent_expressed";
  readonly intentCode: "unmapped_freeform" | "thread_complicates" | "thread_resolves";
}>;

/**
 * 新 payload union：保留仍有生产语义的封闭变体，新增 NPC payload，
 * 收口遗留变体（删除 narrative_choice / narrative_dialogue_choice /
 * candidate_event_proposed 等无生产路径的变体）。
 * 时间只在 envelope（committedAt），payload 不再含 occurredAt。
 */
export type NarrativeEventPayload =
  | GameInitializedPayload
  | LocationObservedPayload
  | NpcMetPayload
  | NpcDialogueCompletedPayload
  | FactDiscoveredPayload
  | LocationVisitedPayload
  | LocationExploredPayload
  | QuestCompletedPayload
  | QuestUnlockedPayload
  | LocationUnlockedPayload
  | ItemObtainedPayload
  | ItemGivenPayload
  | BattleStartedPayload
  | BattleRoundResolvedPayload
  | BattleResolvedPayload
  | EnemyDefeatedPayload
  | QuestFailedPayload
  | EndingReachedPayload
  | BlueprintExpandedPayload
  | NarrativeScenePresentedPayload
  | PlayerIntentExpressedPayload
  | CandidateEventApprovedPayload
  | CandidateEventRejectedPayload
  | CandidateEventExpiredPayload
  | CandidateEventActivatedPayload
  | NpcInteractionRecordedPayload
  | NpcKnowledgeChangedPayload
  | NpcRelationshipChangedPayload;

// 新 payload 类型（不再含 occurredAt）

export type GameInitializedPayload = Readonly<{
  readonly type: "game_initialized";
  readonly generation: GenerationMetadata;
}>;

export type LocationObservedPayload = Readonly<{
  readonly type: "location_observed";
  readonly locationId: LocationId;
}>;

export type NpcMetPayload = Readonly<{
  readonly type: "npc_met";
  readonly npcId: NpcId;
  readonly interactionKind?: "greet" | "ask_main_quest";
}>;

export type NpcDialogueCompletedPayload = Readonly<{
  readonly type: "npc_dialogue_completed";
  readonly npcId: NpcId;
}>;

export type FactDiscoveredPayload = Readonly<{
  readonly type: "fact_discovered";
  readonly factId: FactId;
  readonly witnessNpcIds?: readonly NpcId[];
  readonly approachId?: string;
  readonly evidenceQuality?: "clean" | "noisy";
  readonly tensionDelta?: number;
}>;

export type LocationVisitedPayload = Readonly<{
  readonly type: "location_visited";
  readonly locationId: LocationId;
}>;

export type LocationExploredPayload = Readonly<{
  readonly type: "location_explored";
  readonly locationId: LocationId;
}>;

export type QuestCompletedPayload = Readonly<{
  readonly type: "quest_completed";
  readonly questId: QuestId;
}>;

export type QuestUnlockedPayload = Readonly<{
  readonly type: "quest_unlocked";
  readonly questId: QuestId;
}>;

export type LocationUnlockedPayload = Readonly<{
  readonly type: "location_unlocked";
  readonly locationId: LocationId;
}>;

export type ItemObtainedPayload = Readonly<{
  readonly type: "item_obtained";
  readonly itemId: ItemId;
  readonly locationId: LocationId;
}>;

export type ItemGivenPayload = Readonly<{
  readonly type: "item_given";
  readonly itemId: ItemId;
  readonly npcId: NpcId;
  readonly locationId: LocationId;
}>;

export type BattleStartedPayload = Readonly<{
  readonly type: "battle_started";
  readonly enemyId: EnemyId;
  readonly enemyIds?: readonly EnemyId[];
}>;

export type BattleRoundResolvedPayload = Readonly<{
  readonly type: "battle_round_resolved";
  readonly enemyId: EnemyId;
  readonly round: number;
  readonly playerHp: number;
  readonly enemyHp: number;
  readonly action: CombatActionKind | "withdraw";
  readonly results?: readonly CombatActionResult[];
}>;

export type BattleResolvedPayload = Readonly<{
  readonly type: "battle_resolved";
  readonly enemyId: EnemyId;
  readonly enemyIds?: readonly EnemyId[];
  readonly outcome: "victory" | "defeat" | "withdraw";
}>;

export type EnemyDefeatedPayload = Readonly<{
  readonly type: "enemy_defeated";
  readonly enemyId: EnemyId;
}>;

export type QuestFailedPayload = Readonly<{
  readonly type: "quest_failed";
  readonly questId: QuestId;
}>;

export type EndingReachedPayload = Readonly<{
  readonly type: "ending_reached";
  readonly endingId: EndingId;
  readonly outcome: "success" | "failure";
}>;

export type BlueprintExpandedPayload = Readonly<{
  readonly type: "blueprint_expanded";
  readonly newLocationIds: readonly LocationId[];
  readonly newNpcIds: readonly NpcId[];
  readonly newFactIds?: readonly FactId[];
  readonly newItemIds?: readonly ItemId[];
  readonly newEnemyIds?: readonly EnemyId[];
  readonly newQuestIds?: readonly QuestId[];
  readonly newEndingIds?: readonly EndingId[];
}>;

export type CandidateEventApprovedPayload = Readonly<{
  readonly type: "candidate_event_approved";
  readonly candidateId: string;
  readonly kind: string;
  readonly approvedAtTurn: number;
}>;

export type CandidateEventRejectedPayload = Readonly<{
  readonly type: "candidate_event_rejected";
  readonly candidateId: string;
  readonly kind: string;
  readonly reasonCode: string;
  readonly rejectedAtTurn: number;
}>;

export type CandidateEventExpiredPayload = Readonly<{
  readonly type: "candidate_event_expired";
  readonly candidateId: string;
  readonly kind: string;
  readonly expiredAtTurn: number;
}>;

export type CandidateEventActivatedPayload = Readonly<{
  readonly type: "candidate_event_activated";
  readonly candidateId: string;
  readonly kind: string;
  readonly activatedAtTurn: number;
}>;

// ---------------------------------------------------------------------------
// Committed Event Envelope 与 Draft
// ---------------------------------------------------------------------------

/** 带稳定身份的不可变事件账本条目：append-only 权威事实。 */
export type CommittedNarrativeEvent<P extends NarrativeEventPayload = NarrativeEventPayload> = Readonly<{
  readonly eventId: EventId;
  readonly sequence: number;
  readonly turnId: TurnId;
  readonly actionId?: string;
  readonly turnNumber: number;
  readonly episodeId: EpisodeId;
  readonly kind: P["type"];
  readonly actorIds: readonly (PlayerEntityId | NpcId)[];
  readonly targetIds: readonly (PlayerEntityId | NpcId | NpcId | EnemyId)[];
  readonly locationId: LocationId | null;
  readonly causeEventIds: readonly EventId[];
  readonly factIds: readonly FactId[];
  readonly questIds: readonly QuestId[];
  readonly outcome: "success" | "failure" | "mixed" | "neutral";
  readonly salience: number;
  readonly committedAt: string;
  readonly payload: P;
}>;

/** 提交前的事件草稿：规则层产生，由 commitEventDrafts 铸造 ID 和 sequence。 */
export type NarrativeEventDraft<P extends NarrativeEventPayload = NarrativeEventPayload> = Readonly<{
  readonly eventKey: string;
  readonly episodeKey: string;
  readonly actorIds: readonly (PlayerEntityId | NpcId)[];
  readonly targetIds: readonly (PlayerEntityId | NpcId | EnemyId)[];
  readonly locationId: LocationId | null;
  readonly causeKeys: readonly EventCauseKey[];
  readonly factIds: readonly FactId[];
  readonly questIds: readonly QuestId[];
  readonly outcome: CommittedNarrativeEvent["outcome"];
  readonly salience: number;
  readonly payload: P;
}>;

/** 因果引用键：指向已有 ledger 事件或同批更早 draft。 */
export type EventCauseKey =
  | Readonly<{ kind: "event_id"; eventId: EventId }>
  | Readonly<{ kind: "same_batch"; eventKey: string }>;
