import {
  generatePendingTownPlan,
  type GeneratePendingTownPlanDependencies,
} from "../../generatePendingTownPlan";
import { NOOP_GAME_LOGGER, type GameLogger } from "@/game/logging";
import {
  BackgroundEnsureCoordinator,
  type EnsureResult,
} from "./_shared/ensureCoordinator";

export type TownEnsureResult = EnsureResult;

/**
 * Process-local de-duplication only（镜像 RuntimeNarrativeTaskCoordinator）。
 * pending 本身持久化在 game state 中，进程重启后同一 ensure 调用可恢复。
 *
 * 薄封装 BackgroundEnsureCoordinator：仅注入 town plan 的 pending 判定与执行体。
 */
export class TownPlanTaskCoordinator {
  private readonly coordinator: BackgroundEnsureCoordinator;

  constructor(
    deps: GeneratePendingTownPlanDependencies,
    logger: GameLogger = NOOP_GAME_LOGGER,
  ) {
    this.coordinator = new BackgroundEnsureCoordinator({
      logKey: "town_plan_task",
      logger,
      async loadPending() {
        const loaded = await deps.repository.getCurrentGame();
        if (!loaded.ok || loaded.status !== "active") {
          return { ok: false, result: "unavailable" };
        }
        const { record } = loaded;
        if (record.state.townGeneration.status !== "pending") {
          return { ok: false, result: "not_pending" };
        }
        return { ok: true, key: String(record.gameId) };
      },
      run: (traceId) => generatePendingTownPlan({ ...deps, traceId }),
    });
  }

  ensure(traceId?: string): Promise<TownEnsureResult> {
    return this.coordinator.ensure(traceId);
  }
}
