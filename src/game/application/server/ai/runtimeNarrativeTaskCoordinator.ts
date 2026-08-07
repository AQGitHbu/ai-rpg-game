import {
  generatePendingNarrativeScene,
  type GeneratePendingNarrativeSceneDependencies,
} from "../../generatePendingNarrativeScene";
import { NOOP_GAME_LOGGER, type GameLogger } from "@/game/logging";
import {
  BackgroundEnsureCoordinator,
  type EnsureResult,
} from "./_shared/ensureCoordinator";

const MAX_STALE_REVISION_RETRIES = 2;

export type NarrativeEnsureResult = EnsureResult;

/**
 * Process-local de-duplication only. Pending work itself is persisted in the
 * game state, so a fresh process can resume it through the same ensure call.
 *
 * 薄封装 BackgroundEnsureCoordinator：仅注入 narrative 的 pending 判定与执行体。
 */
export class RuntimeNarrativeTaskCoordinator {
  private readonly coordinator: BackgroundEnsureCoordinator;

  constructor(
    deps: GeneratePendingNarrativeSceneDependencies,
    logger: GameLogger = NOOP_GAME_LOGGER,
  ) {
    this.coordinator = new BackgroundEnsureCoordinator({
      logKey: "runtime_narrative_task",
      logger,
      async loadPending() {
        const loaded = await deps.repository.getCurrentGame();
        if (!loaded.ok || loaded.status !== "active") {
          return { ok: false, result: "unavailable" };
        }
        const { record } = loaded;
        const generation = record.state.narrative.generation;
        const followupBridgeActive =
          generation.status === "pending" &&
          generation.triggerContext?.kind === "dialogue_response";
        if (
          generation.status !== "pending" ||
          (record.state.narrative.currentScene !== null && !followupBridgeActive) ||
          record.state.ending !== null ||
          record.state.battle.status === "active"
        ) {
          return { ok: false, result: "not_pending" };
        }
        return { ok: true, key: String(record.gameId) };
      },
      run: async (traceId) => {
        let result: Awaited<ReturnType<typeof generatePendingNarrativeScene>> = "stale";
        for (let retry = 0; retry <= MAX_STALE_REVISION_RETRIES; retry += 1) {
          result = await generatePendingNarrativeScene({
            ...deps,
            traceId: retry === 0
              ? traceId
              : `${traceId ?? deps.newTraceId()}-stale-retry-${retry}`,
          });
          if (result !== "stale") return result;
        }
        return result;
      },
    });
  }

  ensure(traceId?: string): Promise<NarrativeEnsureResult> {
    return this.coordinator.ensure(traceId);
  }
}
