import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { EventCandidate } from "@/game/domain/candidateEvent";
import { isExpiredCandidate } from "@/game/domain/candidateEvent";
import { budgetAllowsExpansion, consumeExpansion } from "@/game/domain/storyBudget";
import type { GameEvent } from "@/game/domain/events";
import { asFactId } from "@/game/domain/scenarioBlueprint";

// ---------------------------------------------------------------------------
// 纯候选事件审批（Spec §11.2 / Task 19）
// 只做审批判定与池生命周期管理；审批通过后的编译由 compileCandidateEvent 完成。
// 纯函数：不读取时钟/随机数/AI/DB；时间由调用方注入 deps.now。
// ---------------------------------------------------------------------------

export type ApprovedEventCandidate = EventCandidate & { readonly approvedAtTurn: number };

export type CandidateRejection = {
  readonly candidate: EventCandidate;
  readonly reasonCode: string;
};

export type ApproveCandidateEventsInput = {
  readonly worldState: WorldState;
  readonly storyState: StoryState;
  readonly candidates: readonly EventCandidate[];
};

export type ApproveCandidateEventsResult = {
  readonly approvedCandidates: readonly ApprovedEventCandidate[];
  readonly rejected: readonly CandidateRejection[];
  /** 审批审计事件（approved/rejected/expired）。 */
  readonly events: readonly GameEvent[];
  readonly nextStoryState: StoryState;
};

export type ApproveCandidateEventsDeps = { readonly now: () => string };

/** MVP：每回合最多批准 1 条候选事件（Spec §11.3）。 */
export const MAX_CANDIDATE_APPROVED_PER_TURN = 1;

export function approveCandidateEvents(
  input: ApproveCandidateEventsInput,
  deps: ApproveCandidateEventsDeps,
): ApproveCandidateEventsResult {
  const { worldState, storyState, candidates } = input;
  if (candidates.length === 0) {
    return { approvedCandidates: [], rejected: [], events: [], nextStoryState: storyState };
  }

  const occurredAt = deps.now();
  const currentTurn = storyState.turnNumber;
  const events: GameEvent[] = [];
  const rejected: CandidateRejection[] = [];
  const approvedCandidates: ApprovedEventCandidate[] = [];
  let nextBudget = storyState.budget;

  // 1. 结局已抵达：一律拒绝（不激活任何反应事件）。
  if (storyState.endingProposed) {
    for (const candidate of candidates) {
      rejected.push({ candidate, reasonCode: "ending_reached" });
      events.push({
        type: "candidate_event_rejected",
        candidateId: candidate.id,
        kind: candidate.kind,
        reasonCode: "ending_reached",
        rejectedAtTurn: currentTurn,
        occurredAt,
      });
    }
    return {
      approvedCandidates,
      rejected,
      events,
      nextStoryState: { ...storyState, candidateEventPool: [] },
    };
  }

  const approvedIds = new Set<string>();
  const seenIds = new Set<string>();
  const kept: EventCandidate[] = [];

  for (const candidate of candidates) {
    // 同批内重复 ID → 拒绝（池本身由写回方去重，见 Task 20）
    if (seenIds.has(candidate.id)) {
      rejected.push({ candidate, reasonCode: "duplicate_id" });
      events.push({
        type: "candidate_event_rejected",
        candidateId: candidate.id,
        kind: candidate.kind,
        reasonCode: "duplicate_id",
        rejectedAtTurn: currentTurn,
        occurredAt,
      });
      continue;
    }
    seenIds.add(candidate.id);

    // 过期 → 拒绝并移除
    if (isExpiredCandidate(candidate, currentTurn)) {
      rejected.push({ candidate, reasonCode: "expired" });
      events.push({
        type: "candidate_event_expired",
        candidateId: candidate.id,
        kind: candidate.kind,
        expiredAtTurn: currentTurn,
        occurredAt,
      });
      continue;
    }

    // 预算不足 → 拒绝（保留，仍会移除？）——预算不足属于本轮拒绝，从池移除并审计。
    if (!budgetAllowsExpansion(nextBudget, "events")) {
      rejected.push({ candidate, reasonCode: "budget" });
      events.push({
        type: "candidate_event_rejected",
        candidateId: candidate.id,
        kind: candidate.kind,
        reasonCode: "budget",
        rejectedAtTurn: currentTurn,
        occurredAt,
      });
      continue;
    }

    // 已经批准 1 条 → 其余保留在池，等待后续回合。
    if (approvedCandidates.length >= MAX_CANDIDATE_APPROVED_PER_TURN) {
      kept.push(candidate);
      continue;
    }

    // 实体/前置条件校验
    const entityError = validateCandidateEntities(worldState, candidate);
    if (entityError !== null) {
      rejected.push({ candidate, reasonCode: entityError });
      events.push({
        type: "candidate_event_rejected",
        candidateId: candidate.id,
        kind: candidate.kind,
        reasonCode: entityError,
        rejectedAtTurn: currentTurn,
        occurredAt,
      });
      continue;
    }

    // 批准：最多一条；消耗事件预算，记审计，从池移除。
    approvedCandidates.push({ ...candidate, approvedAtTurn: currentTurn });
    approvedIds.add(candidate.id);
    nextBudget = consumeExpansion(nextBudget, "events");
    events.push({
      type: "candidate_event_approved",
      candidateId: candidate.id,
      kind: candidate.kind,
      approvedAtTurn: currentTurn,
      occurredAt,
    });
  }

  // 保留：既未被批准、也未被拒绝/过期的候选。
  const remaining = [
    ...kept,
    ...candidates.filter((c) => !approvedIds.has(c.id) && !seenIds.has(c.id)),
  ];

  if (approvedCandidates.length === 0 && events.length === 0) {
    return { approvedCandidates, rejected, events, nextStoryState: storyState };
  }

  const nextStoryState: StoryState = {
    ...storyState,
    budget: nextBudget,
    candidateEventPool: remaining,
  };

  return { approvedCandidates, rejected, events, nextStoryState };
}

/** 实体存在性与前置事实校验；返回稳定 reasonCode 或 null（通过）。 */
function validateCandidateEntities(
  ws: WorldState,
  candidate: EventCandidate,
): string | null {
  for (const effect of candidate.proposedEffects) {
    switch (effect.kind) {
      case "npc_reveals_fact":
        if (!ws.npcs.some((n) => n.id === effect.npcId)) return "entity_missing";
        if (!ws.worldFacts.some((f) => f.factId === effect.factId)) return "entity_missing";
        break;
      case "npc_changes_stance":
        if (!ws.npcs.some((n) => n.id === effect.npcId)) return "entity_missing";
        break;
      case "hostile_force_acts":
        if (!ws.locations.some((l) => l.id === effect.locationId)) return "entity_missing";
        break;
      case "enemy_appears":
        if (!ws.enemies.some((e) => e.id === effect.enemyId)) return "entity_missing";
        if (ws.defeatedEnemyIds.includes(effect.enemyId)) return "entity_dead";
        if (!ws.locations.some((l) => l.id === effect.locationId)) return "entity_missing";
        break;
      case "thread_complicates":
      case "thread_resolves":
        // thread ID 校验由故事状态负责，此处允许任意合法 thread 引用
        break;
      case "location_state_changes":
        if (!ws.locations.some((l) => l.id === effect.locationId)) return "entity_missing";
        break;
    }
  }

  // 前置事实必须已发现
  for (const factId of candidate.prerequisiteFactIds) {
    const fact = ws.worldFacts.find((f) => f.factId === asFactId(factId));
    if (fact === undefined) return "prerequisite_unmet";
    if (!fact.discovered) return "prerequisite_unmet";
  }

  return null;
}
