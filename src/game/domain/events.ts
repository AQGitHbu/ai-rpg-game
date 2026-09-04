import type { EndingId, EnemyId, FactId, GenerationMetadata, ItemId, LocationId, NpcId, QuestId, PlayerEntityId } from "./worldEntity";
import type { CombatActionResult, CombatActionKind } from "./combat";
import type { DialogueAct } from "./action";
import type { RelationshipSignal } from "./entity/npcComponents";
import { isNarrativeEventPayload } from "./eventPayloadValidation";

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

// ---------------------------------------------------------------------------
// 稳定 ID 体系
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

/** 持久化/跨边界输入的最小 EventId 形状校验。 */
export function isWellFormedEventId(raw: string): boolean {
  const separatorIndex = raw.indexOf(":");
  return raw.trim() === raw
    && raw.length > 0
    && separatorIndex > 0
    && separatorIndex < raw.length - 1
    && !/\s/.test(raw);
}

/**
 * 确定性铸造 Episode ID（turn 聚合）：同一 turnId 永远得到同一 Episode ID。
 */
export function episodeIdForTurn(turnId: TurnId): EpisodeId {
  return asEpisodeId(`episode:${turnId}`);
}

/**
 * 确定性铸造战斗 Episode ID：同一 battleKey 永远得到同一 Episode ID。
 * 战斗的 started/round/resolved/defeated/relationship 事件共享此 Episode。
 */
export function episodeIdForBattle(battleKey: string): EpisodeId {
  return asEpisodeId(`episode:battle:${battleKey}`);
}

// ---------------------------------------------------------------------------
// Payload union：封闭 discriminated union，禁止万能 Record<string, unknown>
// payload 不再含 occurredAt；时间只在 envelope（committedAt）
// ---------------------------------------------------------------------------

/** 初始事件 payload：记录本局的生成元数据。 */
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
  readonly targetIds: readonly (PlayerEntityId | NpcId | EnemyId)[];
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

// ---------------------------------------------------------------------------
// parseCommittedEventLedger：持久化层唯一的 ledger parser
// ---------------------------------------------------------------------------

const PAYLOAD_TYPE_KEYS: ReadonlySet<string> = new Set<NarrativeEventPayload["type"]>([
  "game_initialized",
  "location_observed",
  "npc_met",
  "npc_dialogue_completed",
  "fact_discovered",
  "location_visited",
  "location_explored",
  "quest_completed",
  "quest_unlocked",
  "location_unlocked",
  "item_obtained",
  "item_given",
  "battle_started",
  "battle_round_resolved",
  "battle_resolved",
  "enemy_defeated",
  "quest_failed",
  "ending_reached",
  "blueprint_expanded",
  "narrative_scene_presented",
  "player_intent_expressed",
  "candidate_event_approved",
  "candidate_event_rejected",
  "candidate_event_expired",
  "candidate_event_activated",
  "npc_interaction_recorded",
  "npc_knowledge_changed",
  "npc_relationship_changed",
]);

export type ParseCommittedEventLedgerResult =
  | { readonly ok: true; readonly value: readonly CommittedNarrativeEvent[] }
  | { readonly ok: false; readonly code: "INVALID_LEDGER" };

/**
 * 持久化层唯一的 committed event ledger parser。
 * 验证完整封闭 payload、envelope、连续序号与较早因果；实体引用由提交/持久化边界另行校验。
 */
export function parseCommittedEventLedger(value: unknown): ParseCommittedEventLedgerResult {
  if (!Array.isArray(value)) return { ok: false, code: "INVALID_LEDGER" };
  const result: CommittedNarrativeEvent[] = [];
  const seenIds = new Set<string>();
  const keys = new Set(["eventId", "sequence", "turnId", "actionId", "turnNumber", "episodeId", "kind", "actorIds", "targetIds", "locationId", "causeEventIds", "factIds", "questIds", "outcome", "salience", "committedAt", "payload"]);
  const validId = (id: unknown): id is string => typeof id === "string" && id.trim().length > 0;
  const validRefs = (refs: unknown): refs is string[] => Array.isArray(refs) && refs.every(validId) && new Set(refs).size === refs.length;
  for (let i = 0; i < value.length; i++) {
    const entry = value[i];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, code: "INVALID_LEDGER" };
    }
    const e = entry as Record<string, unknown>;
    if (Object.keys(e).some((key) => !keys.has(key))
      || !validId(e.eventId) || !isWellFormedEventId(e.eventId) || seenIds.has(e.eventId)
      || !validId(e.turnId) || !validId(e.episodeId) || !e.episodeId.startsWith("episode:")
      || e.episodeId.length <= "episode:".length
      || !validRefs(e.actorIds) || !validRefs(e.targetIds) || !validRefs(e.factIds) || !validRefs(e.questIds)
      || !validRefs(e.causeEventIds) || e.causeEventIds.some((id) => !seenIds.has(id))
      || !validId(e.committedAt) || !Number.isFinite(Date.parse(e.committedAt))
      || !isNarrativeEventPayload(e.payload)) {
      return { ok: false, code: "INVALID_LEDGER" };
    }
    if (
      typeof e.eventId !== "string" ||
      typeof e.sequence !== "number" || !Number.isInteger(e.sequence) || e.sequence < 0 || e.sequence !== i ||
      typeof e.turnId !== "string" ||
      typeof e.turnNumber !== "number" || !Number.isInteger(e.turnNumber) || e.turnNumber < 0 ||
      typeof e.episodeId !== "string" ||
      typeof e.kind !== "string" || !PAYLOAD_TYPE_KEYS.has(e.kind) ||
      !Array.isArray(e.actorIds) ||
      !Array.isArray(e.targetIds) ||
      (e.locationId !== null && typeof e.locationId !== "string") ||
      !Array.isArray(e.causeEventIds) ||
      !Array.isArray(e.factIds) ||
      !Array.isArray(e.questIds) ||
      typeof e.outcome !== "string" || !["success", "failure", "mixed", "neutral"].includes(e.outcome) ||
      typeof e.salience !== "number" || !Number.isInteger(e.salience) || e.salience < 0 || e.salience > 100 ||
      typeof e.committedAt !== "string" ||
      typeof e.payload !== "object" || e.payload === null || Array.isArray(e.payload) ||
      typeof (e.payload as Record<string, unknown>).type !== "string" ||
      (e.payload as Record<string, unknown>).type !== e.kind
    ) {
      return { ok: false, code: "INVALID_LEDGER" };
    }
    if (e.actionId !== undefined && typeof e.actionId !== "string") {
      return { ok: false, code: "INVALID_LEDGER" };
    }
    seenIds.add(e.eventId);
    result.push(e as unknown as CommittedNarrativeEvent);
  }
  return { ok: true, value: result };
}
