import type {
  CommittedNarrativeEvent,
  NarrativeEventDraft,
  EventId,
  TurnId,
} from "./events";
import { canonicalOpeningThreadEnvelopeFactIds, eventIdFor, asEpisodeId, asTurnId, episodeIdForTurn, parseCommittedEventLedger } from "./events";
import type {
  LocationId,
  GenerationMetadata,
} from "./worldEntity";
import { PLAYER_ENTITY_ID } from "./worldEntity";
import type { EntityStore } from "./entity/entityStore";
import { isNarrativeEventPayload } from "./eventPayloadValidation";

// ---------------------------------------------------------------------------
// EventCommitSource：提交入口所需的权威元数据
// ---------------------------------------------------------------------------

/** 提交来源：明确提供 turnId/actionId/turnNumber/committedAt。 */
export type EventCommitSource = Readonly<{
  readonly turnId: TurnId;
  readonly turnNumber: number;
  readonly committedAt: string;
  /** 玩家/规则行动事件有 actionId；初始化 source 无。 */
  readonly actionId?: string;
}>;

// ---------------------------------------------------------------------------
// 错误码
// ---------------------------------------------------------------------------

export type EventCommitError =
  | { readonly ok: false; readonly code: "DUPLICATE_EVENT_KEY" }
  | { readonly ok: false; readonly code: "CAUSE_FUTURE_EVENT" }
  | { readonly ok: false; readonly code: "CAUSE_NOT_FOUND" }
  | { readonly ok: false; readonly code: "INVALID_SALIENCE" }
  | { readonly ok: false; readonly code: "INVALID_REFS" }
  | { readonly ok: false; readonly code: "UNKNOWN_PAYLOAD_TYPE" }
  | { readonly ok: false; readonly code: "INVALID_PAYLOAD" }
  | { readonly ok: false; readonly code: "INVALID_LEDGER" }
  | { readonly ok: false; readonly code: "EVENT_ID_CONFLICT" }
  | { readonly ok: false; readonly code: "INVALID_ENTITY_REF" };

export type EventCommitResult =
  | Readonly<{
      readonly ok: true;
      readonly appended: readonly CommittedNarrativeEvent[];
      readonly ledger: readonly CommittedNarrativeEvent[];
      readonly eventIdByKey: ReadonlyMap<string, EventId>;
    }>
  | EventCommitError;

/**
 * 初始化事件的唯一构造入口。开局调用方只提供已编译的世界 store，
 * 不再各自手工拼出 game_initialized payload。
 */
export function commitInitializationEvent(input: {
  readonly generation: GenerationMetadata;
  readonly locationId: LocationId;
  readonly entityStore: EntityStore;
  readonly committedAt: string;
  readonly backgroundDrafts?: readonly NarrativeEventDraft[];
}): EventCommitResult {
  const turnId = asTurnId(`init:${input.generation.generationId}`);
  return commitEventDrafts({
    ledger: [],
    drafts: [{
      eventKey: "game_initialized",
      episodeKey: "initialization",
      actorIds: [PLAYER_ENTITY_ID],
      targetIds: [PLAYER_ENTITY_ID],
      locationId: input.locationId,
      causeKeys: [],
      factIds: [],
      questIds: [],
      outcome: "neutral",
      salience: 100,
      payload: { type: "game_initialized", generation: input.generation },
    }, ...(input.backgroundDrafts ?? [])],
    source: {
      turnId,
      turnNumber: 0,
      committedAt: input.committedAt,
    },
    entityStore: input.entityStore,
  });
}

// ---------------------------------------------------------------------------
// 引用校验辅助
// ---------------------------------------------------------------------------

/** EntityStore 的投影实体 ID 集合（用于校验 actor/target/location/fact/quest 引用）。 */
function buildEntityIdSet(store: EntityStore): Set<string> {
  const ids = new Set<string>();
  for (const record of store.records) {
    ids.add(record.core.id);
  }
  return ids;
}

function isValidRef(id: string, entityIdSet: Set<string>): boolean {
  return entityIdSet.has(id);
}

function episodeIdForDraft(source: EventCommitSource, draft: NarrativeEventDraft): ReturnType<typeof asEpisodeId> {
  if (draft.episodeKey === "turn" || draft.episodeKey === "normal" || draft.episodeKey === "initialization") {
    return episodeIdForTurn(source.turnId);
  }
  return asEpisodeId(`episode:${draft.episodeKey}`);
}

// ---------------------------------------------------------------------------
// commitEventDrafts：唯一的事件提交入口
// ---------------------------------------------------------------------------

/**
 * 纯函数：铸造 ID、校验引用与因果、一次追加。
 * 不读时钟、DB、随机数。committedAt 由 source 注入。
 * 同一 turnId + eventKey 重放得到相同 ID；已存在且完全等价时幂等返回空 appended。
 */
export function commitEventDrafts(input: {
  readonly ledger: readonly CommittedNarrativeEvent[];
  readonly drafts: readonly NarrativeEventDraft[];
  readonly source: EventCommitSource;
  readonly entityStore: EntityStore;
}): EventCommitResult {
  const { ledger, drafts, source, entityStore } = input;
  if (!parseCommittedEventLedger(ledger).ok) return { ok: false, code: "INVALID_LEDGER" };
  const entityIdSet = buildEntityIdSet(entityStore);

  // Phase 1: 预铸 ID、校验单个 draft、检测同批重复 eventKey
  const batchKeys = new Map<string, { draft: NarrativeEventDraft; eventId: EventId }>();
  const batchKeyOrder: string[] = [];

  for (const draft of drafts) {
    // salience 校验
    if (
      !Number.isInteger(draft.salience) ||
      draft.salience < 0 ||
      draft.salience > 100
    ) {
      return { ok: false, code: "INVALID_SALIENCE" };
    }

    // actorIds 校验：非空字符串
    for (const a of draft.actorIds) {
      if (!a || a.length === 0) return { ok: false, code: "INVALID_REFS" };
    }
    for (const t of draft.targetIds) {
      if (!t || t.length === 0) return { ok: false, code: "INVALID_REFS" };
    }

    // payload type 必须在 union 内（通过检查 type 字段是否已知）
    const knownPayloadTypes = new Set([
      "game_initialized",
      "opening_history_established",
      "opening_thread_established",
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
    if (
      typeof draft.payload !== "object" ||
      draft.payload === null ||
      typeof draft.payload.type !== "string" ||
      !knownPayloadTypes.has(draft.payload.type)
    ) {
      return { ok: false, code: "UNKNOWN_PAYLOAD_TYPE" };
    }
    if (!isNarrativeEventPayload(draft.payload)) return { ok: false, code: "INVALID_PAYLOAD" };
    if (draft.payload.type === "opening_history_established"
      && (draft.payload.factIds.length !== draft.factIds.length
        || draft.payload.factIds.some((factId, index) => factId !== draft.factIds[index]))) {
      return { ok: false, code: "INVALID_REFS" };
    }
    if (draft.payload.type === "opening_thread_established") {
      const payloadFactIds = canonicalOpeningThreadEnvelopeFactIds(draft.payload);
      if (payloadFactIds.length !== draft.factIds.length
        || payloadFactIds.some((factId, index) => factId !== draft.factIds[index])) {
        return { ok: false, code: "INVALID_REFS" };
      }
    }

    // 引用校验：actorIds/targetIds/locationId/factIds/questIds
    for (const a of draft.actorIds) {
      if (!isValidRef(String(a), entityIdSet)) {
        return { ok: false, code: "INVALID_ENTITY_REF" };
      }
    }
    for (const t of draft.targetIds) {
      if (!isValidRef(String(t), entityIdSet)) {
        return { ok: false, code: "INVALID_ENTITY_REF" };
      }
    }
    if (draft.locationId !== null) {
      if (!isValidRef(String(draft.locationId), entityIdSet)) {
        return { ok: false, code: "INVALID_ENTITY_REF" };
      }
    }
    for (const f of draft.factIds) {
      if (!isValidRef(String(f), entityIdSet)) {
        return { ok: false, code: "INVALID_ENTITY_REF" };
      }
    }
    for (const q of draft.questIds) {
      if (!isValidRef(String(q), entityIdSet)) {
        return { ok: false, code: "INVALID_ENTITY_REF" };
      }
    }

    // 预铸 ID
    const eventId = eventIdFor(source.turnId, draft.eventKey);

    // 同批重复 eventKey
    if (batchKeys.has(draft.eventKey)) {
      return { ok: false, code: "DUPLICATE_EVENT_KEY" };
    }
    batchKeys.set(draft.eventKey, { draft, eventId });
    batchKeyOrder.push(draft.eventKey);
  }

  // Phase 2: 因果校验
  for (let i = 0; i < batchKeyOrder.length; i++) {
    const key = batchKeyOrder[i]!;
    const entry = batchKeys.get(key)!;
    for (const causeKey of entry.draft.causeKeys) {
      if (causeKey.kind === "same_batch") {
        // 必须指向本批更早的 draft
        const causeIdx = batchKeyOrder.indexOf(causeKey.eventKey);
        if (causeIdx === -1) {
          return { ok: false, code: "CAUSE_NOT_FOUND" };
        }
        if (causeIdx >= i) {
          return { ok: false, code: "CAUSE_FUTURE_EVENT" };
        }
      } else if (causeKey.kind === "event_id") {
        // 必须指向 ledger 中已有的更早事件
        const found = ledger.some((e) => e.eventId === causeKey.eventId);
        if (!found) {
          return { ok: false, code: "CAUSE_NOT_FOUND" };
        }
      }
    }
  }

  // Phase 3: 幂等检查 + 追加
  const appended: CommittedNarrativeEvent[] = [];
  const newLedger = [...ledger];
  const eventIdByKey = new Map<string, EventId>();

  for (const key of batchKeyOrder) {
    const entry = batchKeys.get(key)!;
    const draft = entry.draft;
    const eventId = entry.eventId;
    const episodeId = episodeIdForDraft(source, draft);

    const causeEventIds: EventId[] = [];
    for (const causeKey of draft.causeKeys) {
      if (causeKey.kind === "event_id") {
        causeEventIds.push(causeKey.eventId);
      } else if (causeKey.kind === "same_batch") {
        const causeEntry = batchKeys.get(causeKey.eventKey);
        if (causeEntry) causeEventIds.push(causeEntry.eventId);
      }
    }

    // 检查 ID 是否已在 ledger 中
    const existing = newLedger.find((e) => e.eventId === eventId);
    if (existing !== undefined) {
      // 幂等：只有 payload/refs/metadata 完全等价时才视为 retry，不比较 committedAt
      if (
        existing.kind === draft.payload.type &&
        existing.turnId === source.turnId &&
        existing.turnNumber === source.turnNumber &&
        (existing.actionId ?? undefined) === (source.actionId ?? undefined) &&
        existing.actorIds.length === draft.actorIds.length &&
        existing.actorIds.every((a, i) => a === draft.actorIds[i]) &&
        existing.targetIds.length === draft.targetIds.length &&
        existing.targetIds.every((t, i) => t === draft.targetIds[i]) &&
        existing.locationId === draft.locationId &&
        existing.episodeId === episodeId &&
        existing.causeEventIds.length === causeEventIds.length &&
        existing.causeEventIds.every((causeId, i) => causeId === causeEventIds[i]) &&
        existing.factIds.length === draft.factIds.length &&
        existing.factIds.every((f, i) => f === draft.factIds[i]) &&
        existing.questIds.length === draft.questIds.length &&
        existing.questIds.every((q, i) => q === draft.questIds[i]) &&
        existing.outcome === draft.outcome &&
        existing.salience === draft.salience &&
        JSON.stringify(existing.payload) === JSON.stringify(draft.payload)
      ) {
        // 幂等返回，不追加
        eventIdByKey.set(key, eventId);
        continue;
      } else {
        return { ok: false, code: "EVENT_ID_CONFLICT" };
      }
    }

    const event: CommittedNarrativeEvent = {
      eventId,
      sequence: newLedger.length,
      turnId: source.turnId,
      ...(source.actionId !== undefined ? { actionId: source.actionId } : {}),
      turnNumber: source.turnNumber,
      episodeId,
      kind: draft.payload.type,
      actorIds: [...draft.actorIds],
      targetIds: [...draft.targetIds],
      locationId: draft.locationId,
      causeEventIds,
      factIds: [...draft.factIds],
      questIds: [...draft.questIds],
      outcome: draft.outcome,
      salience: draft.salience,
      committedAt: source.committedAt,
      payload: structuredClone(draft.payload),
    };

    appended.push(event);
    newLedger.push(event);
    eventIdByKey.set(key, eventId);
  }

  if (!parseCommittedEventLedger(newLedger).ok) return { ok: false, code: "INVALID_LEDGER" };
  return { ok: true, appended, ledger: newLedger, eventIdByKey };
}
