import type { WorldState } from "@/game/domain/worldState";
import type { GameEvent } from "@/game/domain/events";
import type { ApprovedEventCandidate } from "./approveCandidateEvents";
import type { ProposedEffect } from "@/game/domain/candidateEvent";
import { applyEntityMutations, EntityMutationInvariantError } from "@/game/gameplay/rpg/entityWorld";

// ---------------------------------------------------------------------------
// 纯候选事件编译（Spec §11.2 / Task 19）
// 把已批准的候选事件逐 effect 编译为真实 GameEvent 和 WorldState 变化。
// effect 必须是封闭 union，禁止任意 path patch；旧存档中的未知 kind 丢弃。
// 纯函数：不读取时钟/随机数/AI/DB；时间由调用方注入 deps.now。
// ---------------------------------------------------------------------------

/**
 * actionId/turnNumber 由 resolveTurn 传入的**本回合真实行动**：candidate.id 与
 * deps.now() 都不是证据，绝不允许拿来充当。
 */
export type CompileCandidateEventDeps = {
  readonly now: () => string;
  readonly actionId: string;
  readonly turnNumber: number;
};

export type CompileCandidateEventResult = {
  readonly worldState: WorldState;
  /** 编译产生的真实领域事件 + candidate_event_activated 审计事件。 */
  readonly events: readonly GameEvent[];
  /** 旧存档携带不可再表示的 effect 时的稳定诊断。 */
  readonly dropReason?: CompileCandidateEventDropReason;
};

export type CompileCandidateEventDropReason = "stale_effect_kind";

export function compileCandidateEvent(
  worldState: WorldState,
  candidate: ApprovedEventCandidate,
  deps: CompileCandidateEventDeps,
): CompileCandidateEventResult {
  const occurredAt = deps.now();
  const events: GameEvent[] = [];
  let ws = worldState;

  for (const effect of candidate.proposedEffects) {
    const compiled = applyEffect(ws, effect, { occurredAt, actionId: deps.actionId, turnNumber: deps.turnNumber });
    if ("dropReason" in compiled) {
      return { worldState, events: [], dropReason: compiled.dropReason };
    }
    ws = compiled.worldState;
    events.push(...compiled.events);
  }

  // 激活审计事件：仅结构化索引，不带 AI 原文或隐藏事实正文。
  events.push({
    type: "candidate_event_activated",
    candidateId: candidate.id,
    kind: candidate.kind,
    activatedAtTurn: candidate.approvedAtTurn,
    occurredAt,
  });

  return { worldState: ws, events };
}

type CompileEffectContext = Readonly<{ occurredAt: string; actionId: string; turnNumber: number }>;

function applyEffect(
  ws: WorldState,
  effect: ProposedEffect,
  context: CompileEffectContext,
): { worldState: WorldState; events: readonly GameEvent[] } | { dropReason: CompileCandidateEventDropReason } {
  const { occurredAt } = context;
  const mutate = (mutation: Parameters<typeof applyEntityMutations>[1]) => {
    const applied = applyEntityMutations(ws, mutation);
    if (!applied.ok) throw new EntityMutationInvariantError(applied);
    return applied.worldState;
  };
  switch (effect.kind) {
    case "npc_reveals_fact": {
      const event: GameEvent = { type: "fact_discovered", factId: effect.factId, occurredAt };
      return {
        worldState: { ...mutate([{ kind: "discover_fact", factId: effect.factId }]), eventLedger: [...ws.eventLedger, event] },
        events: [event],
      };
    }
    case "hostile_force_acts": {
      // 结构化威胁事件：不直接修改世界事实，仅落账敌方行动，供下一场场景表现。
      const event: GameEvent = {
        type: "location_observed",
        locationId: effect.locationId,
        occurredAt,
      };
      return { worldState: { ...ws, eventLedger: [...ws.eventLedger, event] }, events: [event] };
    }
    case "enemy_appears": {
      const event: GameEvent = { type: "battle_started", enemyId: effect.enemyId, occurredAt };
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
          eventLedger: [...ws.eventLedger, event],
        },
        events: [event],
      };
    }
    case "thread_complicates": {
      const event: GameEvent = { type: "player_intent_expressed", intent: "thread_complicates", occurredAt };
      return { worldState: { ...ws, eventLedger: [...ws.eventLedger, event] }, events: [event] };
    }
    case "thread_resolves": {
      const event: GameEvent = { type: "player_intent_expressed", intent: "thread_resolves", occurredAt };
      return { worldState: { ...ws, eventLedger: [...ws.eventLedger, event] }, events: [event] };
    }
    case "location_state_changes": {
      const unlocked = effect.change === "unlocked";
      const event: GameEvent = unlocked
        ? { type: "location_unlocked", locationId: effect.locationId, occurredAt }
        : { type: "location_visited", locationId: effect.locationId, occurredAt };
      const next = mutate([unlocked
        ? { kind: "set_location_unlocked", locationId: effect.locationId, unlocked: true }
        : { kind: "set_location_visited", locationId: effect.locationId, visited: true },
      ]);
      const nextWs: WorldState = { ...next, eventLedger: [...next.eventLedger, event] };
      return { worldState: nextWs, events: [event] };
    }
    default: {
      const _exhaustive: never = effect;
      void _exhaustive;
      return { dropReason: "stale_effect_kind" };
    }
  }
}
