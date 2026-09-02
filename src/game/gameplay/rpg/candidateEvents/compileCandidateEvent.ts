import type { WorldState } from "@/game/domain/worldState";
import type { NarrativeEventDraft } from "@/game/domain/events";
import type { ApprovedEventCandidate } from "./approveCandidateEvents";
import type { ProposedEffect } from "@/game/domain/candidateEvent";
import { applyEntityMutations, EntityMutationInvariantError } from "@/game/gameplay/rpg/entityWorld";
import { PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";

// ---------------------------------------------------------------------------
// 纯候选事件编译（Spec §11.2 / Task 19）
// 把已批准的候选事件逐 effect 编译为真实 NarrativeEventDraft 和 WorldState 变化。
// effect 必须是封闭 union，禁止任意 path patch；旧存档中的未知 kind 丢弃。
// 纯函数：不读取时钟/随机数/AI/DB。
// ---------------------------------------------------------------------------

/**
 * actionId/turnNumber 由 resolveTurn 传入的**本回合真实行动**：candidate.id 不是证据，
 * 绝不允许拿来充当。
 */
export type CompileCandidateEventDeps = {
  readonly actionId: string;
  readonly turnNumber: number;
};

export type CompileCandidateEventResult = {
  readonly worldState: WorldState;
  /** 编译产生的真实领域事件 + candidate_event_activated 审计事件。 */
  readonly drafts: readonly NarrativeEventDraft[];
  /** 旧存档携带不可再表示的 effect 时的稳定诊断；同批返回一条 candidate_event_rejected 审计事件。 */
  readonly dropReason?: CompileCandidateEventDropReason;
};

export type CompileCandidateEventDropReason = "stale_effect_kind";

export function compileCandidateEvent(
  worldState: WorldState,
  candidate: ApprovedEventCandidate,
  deps: CompileCandidateEventDeps,
): CompileCandidateEventResult {
  const drafts: NarrativeEventDraft[] = [];
  let ws = worldState;

  for (const effect of candidate.proposedEffects) {
    const compiled = applyEffect(ws, effect, deps.turnNumber);
    if ("dropReason" in compiled) {
      return {
        worldState,
        drafts: [{
          eventKey: `candidate_event_rejected:${candidate.id}:stale`,
          episodeKey: "turn",
          actorIds: [],
          targetIds: [],
          locationId: null,
          causeKeys: [],
          factIds: [],
          questIds: [],
          outcome: "neutral",
          salience: 20,
          payload: { type: "candidate_event_rejected", candidateId: candidate.id, kind: candidate.kind, reasonCode: compiled.dropReason, rejectedAtTurn: deps.turnNumber },
        }],
        dropReason: compiled.dropReason,
      };
    }
    ws = compiled.worldState;
    drafts.push(...compiled.drafts);
  }

  // 激活审计事件：仅结构化索引，不带 AI 原文或隐藏事实正文。
  drafts.push({
    eventKey: `candidate_event_activated:${candidate.id}`,
    episodeKey: "turn",
    actorIds: [],
    targetIds: [],
    locationId: null,
    causeKeys: [],
    factIds: [],
    questIds: [],
    outcome: "neutral",
    salience: 30,
    payload: { type: "candidate_event_activated", candidateId: candidate.id, kind: candidate.kind, activatedAtTurn: candidate.approvedAtTurn },
  });

  return { worldState: ws, drafts };
}

function applyEffect(
  ws: WorldState,
  effect: ProposedEffect,
  turnNumber: number,
): { worldState: WorldState; drafts: readonly NarrativeEventDraft[] } | { dropReason: CompileCandidateEventDropReason } {
  const mutate = (mutation: Parameters<typeof applyEntityMutations>[1]) => {
    const applied = applyEntityMutations(ws, mutation);
    if (!applied.ok) throw new EntityMutationInvariantError(applied);
    return applied.worldState;
  };
  switch (effect.kind) {
    case "npc_reveals_fact": {
      const draft: NarrativeEventDraft = {
        eventKey: `fact_discovered:${effect.factId}`,
        episodeKey: "turn",
        actorIds: [PLAYER_ENTITY_ID],
        targetIds: [effect.npcId],
        locationId: ws.currentLocationId,
        causeKeys: [],
        factIds: [effect.factId],
        questIds: [],
        outcome: "success",
        salience: 65,
        payload: { type: "fact_discovered", factId: effect.factId },
      };
      return { worldState: mutate([{ kind: "discover_fact", factId: effect.factId }]), drafts: [draft] };
    }
    case "hostile_force_acts": {
      const draft: NarrativeEventDraft = {
        eventKey: `location_observed:${effect.locationId}:${turnNumber}`,
        episodeKey: "turn",
        actorIds: [PLAYER_ENTITY_ID],
        targetIds: [PLAYER_ENTITY_ID],
        locationId: effect.locationId,
        causeKeys: [],
        factIds: [],
        questIds: [],
        outcome: "neutral",
        salience: 20,
        payload: { type: "location_observed", locationId: effect.locationId },
      };
      return { worldState: ws, drafts: [draft] };
    }
    case "enemy_appears": {
      const draft: NarrativeEventDraft = {
        eventKey: `battle_started:${effect.enemyId}`,
        episodeKey: `battle:battle_started:${effect.enemyId}`,
        actorIds: [PLAYER_ENTITY_ID],
        targetIds: [effect.enemyId],
        locationId: ws.currentLocationId,
        causeKeys: [],
        factIds: [],
        questIds: [],
        outcome: "neutral",
        salience: 70,
        payload: { type: "battle_started", enemyId: effect.enemyId },
      };
      const enemy = ws.enemies.find((e) => e.id === effect.enemyId);
      return {
        worldState: {
          ...ws,
          battle: {
            status: "active",
            enemyId: effect.enemyId,
            playerHp: ws.player.stats.hp,
            enemyHp: enemy?.stats.hp ?? 0,
            round: 1,
            preBattleSnapshot: { entityStore: ws.entityStore, eventLedger: ws.eventLedger },
          },
        },
        drafts: [draft],
      };
    }
    case "thread_complicates": {
      const draft: NarrativeEventDraft = {
        eventKey: `player_intent_expressed:thread_complicates:${turnNumber}`,
        episodeKey: "turn",
        actorIds: [PLAYER_ENTITY_ID],
        targetIds: [PLAYER_ENTITY_ID],
        locationId: ws.currentLocationId,
        causeKeys: [],
        factIds: [],
        questIds: [],
        outcome: "neutral",
        salience: 15,
        payload: { type: "player_intent_expressed", intentCode: "thread_complicates" },
      };
      return { worldState: ws, drafts: [draft] };
    }
    case "thread_resolves": {
      const draft: NarrativeEventDraft = {
        eventKey: `player_intent_expressed:thread_resolves:${turnNumber}`,
        episodeKey: "turn",
        actorIds: [PLAYER_ENTITY_ID],
        targetIds: [PLAYER_ENTITY_ID],
        locationId: ws.currentLocationId,
        causeKeys: [],
        factIds: [],
        questIds: [],
        outcome: "neutral",
        salience: 15,
        payload: { type: "player_intent_expressed", intentCode: "thread_resolves" },
      };
      return { worldState: ws, drafts: [draft] };
    }
    case "location_state_changes": {
      const unlocked = effect.change === "unlocked";
      const draft: NarrativeEventDraft = unlocked
        ? {
            eventKey: `location_unlocked:${effect.locationId}`,
            episodeKey: "turn",
            actorIds: [PLAYER_ENTITY_ID],
            targetIds: [PLAYER_ENTITY_ID],
            locationId: effect.locationId,
            causeKeys: [],
            factIds: [],
            questIds: [],
            outcome: "neutral",
            salience: 40,
            payload: { type: "location_unlocked", locationId: effect.locationId },
          }
        : {
            eventKey: `location_visited:${effect.locationId}`,
            episodeKey: "turn",
            actorIds: [PLAYER_ENTITY_ID],
            targetIds: [PLAYER_ENTITY_ID],
            locationId: effect.locationId,
            causeKeys: [],
            factIds: [],
            questIds: [],
            outcome: "neutral",
            salience: 20,
            payload: { type: "location_visited", locationId: effect.locationId },
          };
      const next = mutate([unlocked
        ? { kind: "set_location_unlocked", locationId: effect.locationId, unlocked: true }
        : { kind: "set_location_visited", locationId: effect.locationId, visited: true },
      ]);
      return { worldState: next, drafts: [draft] };
    }
    default: {
      const _exhaustive: never = effect;
      void _exhaustive;
      return { dropReason: "stale_effect_kind" };
    }
  }
}
