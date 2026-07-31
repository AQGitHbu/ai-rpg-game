import {
  generatePendingNarrativeScene,
  type GeneratePendingNarrativeSceneDependencies,
} from "../../generatePendingNarrativeScene";
import { NOOP_GAME_LOGGER, type GameLogger } from "@/game/logging";
import {
  BackgroundEnsureCoordinator,
  type EnsureResult,
} from "./_shared/ensureCoordinator";

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
        if (
          record.state.narrative.generation.status !== "pending" ||
          record.state.narrative.currentScene !== null ||
          record.state.ending !== null ||
          record.state.battle.status === "active"
        ) {
          return { ok: false, result: "not_pending" };
        }
        return { ok: true, key: String(record.gameId) };
      },
      run: () => generatePendingNarrativeScene(deps),
    });
  }

  ensure(): Promise<NarrativeEnsureResult> {
    return this.coordinator.ensure();
  }
}
