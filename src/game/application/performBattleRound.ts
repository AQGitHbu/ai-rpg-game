import type { GameId } from "./server/persistence/gameRepository";
import type { GameRepository } from "./server/persistence/gameRepository";
import type { Action } from "@/game/domain/action";
import type { ResolvedEvent } from "@/game/domain/resolvedEvent";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { NarrativeRuntimeState, BattleNarrativeCheckpointState } from "@/game/domain/narrative";
import { resolveTurn } from "@/game/gameplay/rpg/ruleEngine";
import { commitState } from "./stateCommit";
import { asTurnId } from "@/game/domain/events";
import { consumeNarrativeBundle } from "./consumeNarrativeBundle";
import { consumePreparedContinuation } from "./consumePreparedContinuation";
import { projectEntityStore } from "@/game/domain/entity";
import { unresolvedStoryThreadIds } from "@/game/domain/storyThreads";

// ---------------------------------------------------------------------------
// Task 8: 专门处理活跃战斗回合的应用路径。
// - 不依赖 NarrativeBundleSource / PendingNarrativeJob / coordinator。
// - 非终结回合：只更新战斗状态，storyState 保持不变。
// - 失败/撤退：恢复 preBattleSnapshot + 叙事检查点，battle 设为 idle。
// - 胜利：消费 battle_resolved:victory prepared step。
// ---------------------------------------------------------------------------

export type PerformBattleRoundInput = {
  readonly gameId: GameId;
  readonly actionId: string;
  readonly interactionKind: string;
  readonly action: Action;
  readonly expectedRevision: number;
};

export type PerformBattleRoundResult =
  | { readonly ok: true; readonly revision: number; readonly resolvedEvent: ResolvedEvent; readonly outcome: "active" | "victory" | "defeat" | "withdraw" }
  | { readonly ok: false; readonly code: "NO_ACTIVE_GAME" | "STALE_GAME_REVISION" | "ACTION_REJECTED" | "NARRATIVE_CONTINUATION_MISSING" | "NARRATIVE_CONTINUATION_INVALID" | "INFRASTRUCTURE_FAILURE"; readonly feedback: string };

export type PerformBattleRoundDeps = {
  readonly repository: GameRepository;
  readonly now: () => string;
};

/** 叙事检查点：战斗开始前的完整叙事快照，用于失败/撤退时恢复。 */
function restoreNarrativeFromCheckpoint(
  beforeNarrative: NarrativeRuntimeState,
  checkpoint: BattleNarrativeCheckpointState,
): NarrativeRuntimeState {
  if (beforeNarrative.status !== "ready") return beforeNarrative;
  return {
    status: "ready",
    mode: beforeNarrative.mode,
    currentScene: checkpoint.currentScene,
    choiceRegistry: checkpoint.choiceRegistry,
    ...(checkpoint.bundle === undefined ? {} : { narrativeBundle: checkpoint.bundle }),
    ...(checkpoint.preparedContinuation === undefined ? {} : { preparedContinuation: checkpoint.preparedContinuation }),
    ...(checkpoint.dialogueSession === undefined ? {} : { dialogueSession: checkpoint.dialogueSession }),
    ...(checkpoint.dialogueResume === undefined ? {} : { dialogueResume: checkpoint.dialogueResume }),
  };
}

export async function performBattleRound(
  input: PerformBattleRoundInput,
  deps: PerformBattleRoundDeps,
): Promise<PerformBattleRoundResult> {
  const current = await deps.repository.getCurrentGame();
  if (!current.ok) return { ok: false, code: "INFRASTRUCTURE_FAILURE", feedback: "Infrastructure error" };
  if (current.status === "none") return { ok: false, code: "NO_ACTIVE_GAME", feedback: "No active game" };
  if (current.status === "corrupt") return { ok: false, code: "INFRASTRUCTURE_FAILURE", feedback: "Corrupt game" };

  const { record } = current;
  if (record.revision !== input.expectedRevision) {
    return { ok: false, code: "STALE_GAME_REVISION", feedback: "Stale revision" };
  }

  // Only ready narrative can accept battle actions
  if (record.storyState.narrative.status !== "ready") {
    return { ok: false, code: "ACTION_REJECTED", feedback: "正在编排下一幕，请稍候。" };
  }

  // Only battle_action or attack tokens are valid during active battle
  if (input.action.type !== "battle_action" && input.action.type !== "attack") {
    return { ok: false, code: "ACTION_REJECTED", feedback: "战斗中只能使用战斗指令。" };
  }

  const beforeWorldState = record.worldState;
  const beforeStoryState = record.storyState;
  const beforeNarrative = beforeStoryState.narrative;
  if (beforeNarrative.status !== "ready") {
    return { ok: false, code: "ACTION_REJECTED", feedback: "正在编排下一幕，请稍候。" };
  }

  const narrativeCheckpoint = beforeNarrative.status === "ready"
    ? beforeNarrative.battleCheckpoint
    : undefined;

  const resolved = resolveTurn(
    beforeWorldState,
    beforeStoryState,
    input.action,
    input.actionId,
    record.revision,
    asTurnId(input.actionId),
    input.interactionKind as "fixed_choice" | "free_text",
    { now: deps.now, turnId: asTurnId(input.actionId) },
  );

  if (!resolved.ok) return { ok: false, code: "ACTION_REJECTED", feedback: resolved.feedback };

  const { resolution } = resolved;

  // Blocked: zero writes
  if (resolution.primaryResult.status === "blocked") {
    return { ok: false, code: "ACTION_REJECTED", feedback: "被战斗阻止" };
  }

  const afterWorldState = resolution.nextWorldState;
  const afterStoryState = resolution.nextStoryState;

  // Active (non-terminal) round: only commit battle state changes, storyState stays the same
  if (afterWorldState.battle.status === "active") {
    const commitResult = await commitState(deps.repository, {
      gameId: input.gameId,
      expectedRevision: record.revision,
      nextWorldState: afterWorldState,
      // Keep story state exactly as before — battle rounds don't change narrative
      nextStoryState: beforeStoryState,
    });
    if (!commitResult.ok) {
      return {
        ok: false,
        code: commitResult.code === "STALE_GAME_REVISION" ? "STALE_GAME_REVISION" : "INFRASTRUCTURE_FAILURE",
        feedback: "Commit failed",
      };
    }
    return {
      ok: true,
      revision: commitResult.record.revision,
      resolvedEvent: resolution.primaryResult,
      outcome: "active",
    };
  }

  // Battle resolved — check outcome
  if (afterWorldState.battle.status === "resolved") {
    const outcome = afterWorldState.battle.outcome;

    if (outcome === "defeat" || outcome === "withdraw") {
      // Restore pre-battle state from checkpoint
      const preBattleSnapshot = beforeWorldState.battle.status === "active" ? beforeWorldState.battle.preBattleSnapshot : undefined;
      const restoredNarrative = narrativeCheckpoint !== undefined
        ? restoreNarrativeFromCheckpoint(beforeNarrative, narrativeCheckpoint)
        : beforeNarrative;

      // 恢复完整的权威 entity store，再投影全部 legacy 兼容字段；不能只恢复 HP/击败索引。
      const restoredWorldState: WorldState = preBattleSnapshot !== undefined
        ? {
            ...afterWorldState,
            entityStore: preBattleSnapshot.entityStore,
            ...projectEntityStore(preBattleSnapshot.entityStore),
            eventLedger: preBattleSnapshot.eventLedger,
            battle: { status: "idle" as const },
          }
        : { ...afterWorldState, battle: { status: "idle" as const } };

      const restoredStoryBase: Omit<StoryState, "narrative"> = narrativeCheckpoint === undefined
        ? {
            ...beforeStoryState,
            ...(preBattleSnapshot?.history === undefined ? {} : { history: preBattleSnapshot.history }),
          }
        : { ...narrativeCheckpoint.storySnapshot };
      const restoredStoryState: StoryState = {
        ...restoredStoryBase,
        ...(preBattleSnapshot?.threads === undefined
          ? {}
          : {
              threads: preBattleSnapshot.threads,
              unresolvedThreads: unresolvedStoryThreadIds(preBattleSnapshot.threads),
            }),
        ...(preBattleSnapshot?.dialogueFocus === undefined
          ? {}
          : { dialogueFocus: preBattleSnapshot.dialogueFocus }),
        narrative: restoredNarrative,
      };

      const commitResult = await commitState(deps.repository, {
        gameId: input.gameId,
        expectedRevision: record.revision,
        nextWorldState: restoredWorldState,
        nextStoryState: restoredStoryState,
      });
      if (!commitResult.ok) {
        return {
          ok: false,
          code: commitResult.code === "STALE_GAME_REVISION" ? "STALE_GAME_REVISION" : "INFRASTRUCTURE_FAILURE",
          feedback: "Commit failed",
        };
      }
      return {
        ok: true,
        revision: commitResult.record.revision,
        resolvedEvent: resolution.primaryResult,
        outcome,
      };
    }

    // Victory consumes the already-approved battle_resolved:victory step. It
    // never creates a provider job and never invents a post-battle scene.
    const victoryWorldState: WorldState = {
      ...afterWorldState,
      battle: { status: "idle" as const },
    };
    const withCompanionSignals = victoryWorldState;

    // Offline fixture worlds can exercise rule-only battle paths without a
    // prepared continuation graph. Keep the victory atomic and clear the
    // battle checkpoint; live AI worlds still require the approved bundle.
    if (beforeNarrative.mode === "offline" && beforeNarrative.narrativeBundle === undefined) {
      const hasPreparedContinuation = (beforeNarrative.preparedContinuation?.steps.length ?? 0) > 0;
      if (hasPreparedContinuation) {
        const continued = consumePreparedContinuation({
          beforeWorldState,
          beforeStoryState,
          resolvedWorldState: withCompanionSignals,
          resolvedStoryState: afterStoryState,
          action: input.action,
          postCommitRevision: record.revision + 1,
          resolvedEvent: resolution.primaryResult,
          domainEvents: resolution.domainEvents,
          now: deps.now,
        });
        if (!continued.ok) return { ok: false, code: continued.code, feedback: "当前战斗没有可消费的预备叙事。" };
        const commitResult = await commitState(deps.repository, {
          gameId: input.gameId,
          expectedRevision: record.revision,
          nextWorldState: continued.nextWorldState,
          nextStoryState: continued.nextStoryState,
        });
        if (!commitResult.ok) {
          return {
            ok: false,
            code: commitResult.code === "STALE_GAME_REVISION" ? "STALE_GAME_REVISION" : "INFRASTRUCTURE_FAILURE",
            feedback: "Commit failed",
          };
        }
        return {
          ok: true,
          revision: commitResult.record.revision,
          resolvedEvent: resolution.primaryResult,
          outcome: "victory",
        };
      }
      if (afterStoryState.narrative.status !== "ready") {
        return { ok: false, code: "NARRATIVE_CONTINUATION_INVALID", feedback: "当前战斗叙事状态无效。" };
      }
      const { battleCheckpoint: _checkpoint, ...narrativeWithoutCheckpoint } = afterStoryState.narrative;
      const nextStoryState: StoryState = {
        ...afterStoryState,
        narrative: { ...narrativeWithoutCheckpoint, status: "ready" },
      };
      const commitResult = await commitState(deps.repository, {
        gameId: input.gameId,
        expectedRevision: record.revision,
        nextWorldState: withCompanionSignals,
        nextStoryState,
      });
      if (!commitResult.ok) {
        return {
          ok: false,
          code: commitResult.code === "STALE_GAME_REVISION" ? "STALE_GAME_REVISION" : "INFRASTRUCTURE_FAILURE",
          feedback: "Commit failed",
        };
      }
      return {
        ok: true,
        revision: commitResult.record.revision,
        resolvedEvent: resolution.primaryResult,
        outcome: "victory",
      };
    }

    const continued = consumeNarrativeBundle({
      beforeStoryState,
      resolvedWorldState: withCompanionSignals,
      resolvedStoryState: afterStoryState,
      action: input.action,
      actionId: input.actionId,
      postCommitRevision: record.revision + 1,
      resolvedEvent: resolution.primaryResult,
      domainEvents: resolution.domainEvents,
    });
    if (!continued.ok) return { ok: false, code: continued.code, feedback: "当前战斗没有可消费的预备叙事。" };
    const commitResult = await commitState(deps.repository, {
      gameId: input.gameId,
      expectedRevision: record.revision,
      nextWorldState: continued.nextWorldState,
      nextStoryState: continued.nextStoryState,
    });
    if (!commitResult.ok) {
      return {
        ok: false,
        code: commitResult.code === "STALE_GAME_REVISION" ? "STALE_GAME_REVISION" : "INFRASTRUCTURE_FAILURE",
        feedback: "Commit failed",
      };
    }
    return {
      ok: true,
      revision: commitResult.record.revision,
      resolvedEvent: resolution.primaryResult,
      outcome: "victory",
    };
  }

  // Unknown battle state — reject
  return { ok: false, code: "ACTION_REJECTED", feedback: "未知的战斗状态" };
}
