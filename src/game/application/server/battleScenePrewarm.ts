import type { GameRecord } from "./persistence/gameRepository";
import type { GameLogger } from "@/game/logging";
import type { ScenePerformanceProposal, SceneSource } from "../sceneSource";
import { buildSceneGenerationContext } from "../sceneGenerationContext";
import { buildOutcomeBeats } from "@/game/gameplay/rpg/narrativeContext/buildOutcomeBeats";
import { deriveObjectiveTransition } from "@/game/gameplay/rpg/narrativeContext/deriveObjectiveTransition";
import { resolveTurn } from "@/game/gameplay/rpg/ruleEngine";
import { createPendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import { asNarrativeJobId, asTurnId } from "@/game/domain/events";
import type { Action } from "@/game/domain/action";
import type { WorldState } from "@/game/domain/worldState";
import { deriveEvolutionNeed } from "@/game/gameplay/rpg/worldEvolution";
import type { AiTextAuditLink } from "./ai/textAuditTypes";

export type BattleScenePrewarm = {
  readonly battleKey: string;
  readonly proposal: ScenePerformanceProposal;
};

/**
 * 战斗胜利后的权威状态如果已经提出幕推进/结局对需求，预热场景不能直接
 * 写回 idle；必须让 generatePendingScene 先完成世界演化，再基于新实体生成场景。
 */
export function battleVictoryRequiresWorldEvolution(
  record: Pick<GameRecord, "worldState" | "storyState">,
): boolean {
  return deriveEvolutionNeed(record.worldState, record.storyState).kind !== "none";
}

type PrewarmDeps = {
  readonly sceneSource: SceneSource;
  readonly logger?: GameLogger;
  readonly now: () => string;
  /** 仅用于关联 battle prewarm AI 审计事件，不进入场景 prompt 事实。 */
  readonly auditLink?: AiTextAuditLink;
};

function battleKeyOf(record: GameRecord): string | null {
  const battle = record.worldState.battle;
  return battle.status === "active" ? battle.battleKey ?? null : null;
}

/**
 * 将“胜利”作为只读预测分支推进一回合。战斗规则仍由最终玩家操作权威结算；
 * 这里仅把敌方生命压到 1，借规则引擎得到战后目标/节拍的预测上下文，绝不落库。
 */
function projectedVictoryRecord(record: GameRecord): { readonly record: GameRecord; readonly battleKey: string } | null {
  const battle = record.worldState.battle;
  if (battle.status !== "active" || battle.battleKey === undefined) return null;

  const actorId = battle.combatants?.[battle.turnIndex ?? -1]?.combatantId;
  const target = battle.combatants?.find((unit) => unit.side === "enemies" && unit.hp > 0);
  const action: Action = {
    type: "battle_action",
    action: "attack",
    ...(actorId === undefined ? {} : {
      command: {
        actorId,
        ...(target === undefined ? {} : { targetId: target.combatantId }),
      },
    }),
  };

  const projectedCombatants = battle.combatants?.map((unit) =>
    unit.side === "enemies" && unit.hp > 0 ? { ...unit, hp: 1 } : unit,
  );
  const projectedWorldState: WorldState = {
    ...record.worldState,
    battle: {
      ...battle,
      enemyHp: 1,
      ...(projectedCombatants === undefined ? {} : { combatants: projectedCombatants }),
    },
  };
  const actionId = `prewarm_${battle.battleKey}`;
  const resolved = resolveTurn(
    projectedWorldState,
    record.storyState,
    action,
    actionId,
    record.revision,
    asTurnId(actionId),
    "fixed_choice",
    { now: () => "prewarm" },
  );
  if (!resolved.ok || resolved.resolution.nextWorldState.battle.status !== "resolved"
    || resolved.resolution.nextWorldState.battle.outcome !== "victory") return null;

  const objectiveTransition = deriveObjectiveTransition({
    beforeWorldState: record.worldState,
    beforeStoryState: record.storyState,
    afterWorldState: resolved.resolution.nextWorldState,
    afterStoryState: resolved.resolution.nextStoryState,
  });
  const mandatoryBeats = buildOutcomeBeats({
    resolvedEvent: resolved.resolution.primaryResult,
    beforeWorldState: record.worldState,
    beforeStoryState: record.storyState,
    afterWorldState: resolved.resolution.nextWorldState,
    afterStoryState: resolved.resolution.nextStoryState,
  });
  const jobResult = createPendingNarrativeJob({
    jobId: asNarrativeJobId(`job_${actionId}`),
    turnId: asTurnId(actionId),
    actionId,
    expectedRevision: record.revision,
    turnNumber: resolved.resolution.turnNumber,
    actionSummary: { kind: "battle_action", action: "attack" },
    resolvedEvent: resolved.resolution.primaryResult,
    domainEventRange: {
      fromLedgerIndex: record.worldState.eventLedger.length,
      toLedgerIndexExclusive: resolved.resolution.nextWorldState.eventLedger.length,
    },
    requestedAt: "prewarm",
    objectiveTransition,
    mandatoryBeats,
    generationKind: "npc_fixed_choice",
    sceneRequestKind: "npc_response",
  });
  if (!jobResult.ok) return null;

  return {
    battleKey: battle.battleKey,
    record: {
      ...record,
      worldState: resolved.resolution.nextWorldState,
      storyState: {
        ...resolved.resolution.nextStoryState,
        narrative: {
          ...resolved.resolution.nextStoryState.narrative,
          generation: { status: "pending", job: jobResult.job },
        },
      },
    },
  };
}

export async function prewarmBattleVictoryScene(
  record: GameRecord,
  deps: PrewarmDeps,
): Promise<BattleScenePrewarm | null> {
  const battleKey = battleKeyOf(record);
  if (battleKey === null) return null;
  const projected = projectedVictoryRecord(record);
  if (projected === null) return null;

  try {
    const baseContext = buildSceneGenerationContext(projected.record);
    const sceneResult = await deps.sceneSource.generateScene({
      ...baseContext,
      auditLink: {
        ...deps.auditLink,
        gameId: String(record.gameId),
        jobId: String(baseContext.job.jobId),
        turnNumber: baseContext.job.turnNumber,
      },
      auditTrigger: "battle_prewarm",
    });
    if (!sceneResult.ok) {
      deps.logger?.warn("battle_scene_prewarm_failed", { battleKey, reason: sceneResult.failure.kind });
      return null;
    }
    const proposal = sceneResult.proposal;
    if (proposal.source !== "generated") {
      deps.logger?.warn("battle_scene_prewarm_not_live", { battleKey });
      return null;
    }
    deps.logger?.info("battle_scene_prewarm_ready", { battleKey });
    return { battleKey, proposal };
  } catch {
    deps.logger?.warn("battle_scene_prewarm_failed", { battleKey });
    return null;
  }
}
