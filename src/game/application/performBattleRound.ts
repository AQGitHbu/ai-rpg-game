import type { GameId } from "./server/persistence/gameRepository";
import type { GameRepository } from "./server/persistence/gameRepository";
import type { Action } from "@/game/domain/action";
import type { ResolvedEvent } from "@/game/domain/resolvedEvent";
import type { WorldState, BattleStartSnapshot } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { NarrativeRuntimeState, NarrativeSceneState } from "@/game/domain/narrative";
import type { ApprovedChoice } from "@/game/domain/approvedChoice";
import { resolveTurn } from "@/game/gameplay/rpg/ruleEngine";
import { commitState } from "./stateCommit";
import { asTurnId } from "@/game/domain/events";

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
  | { readonly ok: false; readonly code: "NO_ACTIVE_GAME" | "STALE_GAME_REVISION" | "ACTION_REJECTED" | "NARRATIVE_CONTINUATION_MISSING" | "INFRASTRUCTURE_FAILURE"; readonly feedback: string };

export type PerformBattleRoundDeps = {
  readonly repository: GameRepository;
  readonly now: () => string;
};

/** 叙事检查点：战斗开始前的完整叙事快照，用于失败/撤退时恢复。 */
export type BattleNarrativeCheckpoint = {
  readonly scene: NarrativeSceneState;
  readonly choiceRegistry: readonly ApprovedChoice[];
};

function restoreNarrativeFromCheckpoint(
  beforeNarrative: NarrativeRuntimeState,
  checkpoint: BattleNarrativeCheckpoint,
): NarrativeRuntimeState {
  if (beforeNarrative.status !== "ready") return beforeNarrative;
  return {
    status: "ready",
    mode: beforeNarrative.mode,
    currentScene: checkpoint.scene,
    choiceRegistry: checkpoint.choiceRegistry,
    ...(beforeNarrative.dialogueSession === undefined ? {} : { dialogueSession: beforeNarrative.dialogueSession }),
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

  // Capture narrative checkpoint if battle is active (for potential restoration)
  const narrativeCheckpoint: BattleNarrativeCheckpoint | undefined =
    beforeNarrative.status === "ready"
      ? { scene: beforeNarrative.currentScene, choiceRegistry: beforeNarrative.choiceRegistry }
      : undefined;

  const resolved = resolveTurn(
    beforeWorldState,
    beforeStoryState,
    input.action,
    input.actionId,
    record.revision,
    asTurnId(input.actionId),
    input.interactionKind as "fixed_choice" | "free_text",
    { now: deps.now },
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

      // Restore world state: player stats, defeated IDs, event ledger, battle → idle
      const restoredWorldState: WorldState = preBattleSnapshot !== undefined
        ? {
            ...afterWorldState,
            player: { ...afterWorldState.player, stats: preBattleSnapshot.playerStats },
            defeatedEnemyIds: preBattleSnapshot.defeatedEnemyIds,
            eventLedger: preBattleSnapshot.eventLedger,
            battle: { status: "idle" as const },
          }
        : { ...afterWorldState, battle: { status: "idle" as const } };

      const restoredStoryState: StoryState = {
        ...beforeStoryState,
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

    // Victory: commit the resolved state, clear checkpoint
    const victoryWorldState: WorldState = {
      ...afterWorldState,
      battle: { status: "idle" as const },
    };

    const commitResult = await commitState(deps.repository, {
      gameId: input.gameId,
      expectedRevision: record.revision,
      nextWorldState: victoryWorldState,
      nextStoryState: afterStoryState,
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
