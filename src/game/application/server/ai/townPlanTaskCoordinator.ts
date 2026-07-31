import {
  generatePendingTownPlan,
  type GeneratePendingTownPlanDependencies,
} from "../../generatePendingTownPlan";
import { NOOP_GAME_LOGGER, type GameLogger } from "@/game/logging";

export type TownEnsureResult =
  | "queued"
  | "already_running"
  | "not_pending"
  | "unavailable";

/**
 * Process-local de-duplication only（镜像 RuntimeNarrativeTaskCoordinator）。
 * pending 本身持久化在 game state 中，进程重启后同一 ensure 调用可恢复。
 */
export class TownPlanTaskCoordinator {
  private readonly running = new Map<string, Promise<void>>();
  // 不用 TS parameter property：Node strip-types（phase4b smoke 脚本）无法加载该语法。
  private readonly deps: GeneratePendingTownPlanDependencies;
  private readonly logger: GameLogger;

  constructor(
    deps: GeneratePendingTownPlanDependencies,
    logger: GameLogger = NOOP_GAME_LOGGER,
  ) {
    this.deps = deps;
    this.logger = logger;
  }

  async ensure(): Promise<TownEnsureResult> {
    const loaded = await this.deps.repository.getCurrentGame();
    if (!loaded.ok || loaded.status !== "active") return "unavailable";
    const { record } = loaded;
    if (record.state.townGeneration.status !== "pending") return "not_pending";
    const key = String(record.gameId);
    if (this.running.has(key)) return "already_running";
    const task = Promise.resolve()
      .then(() => generatePendingTownPlan(this.deps))
      .then((result) => {
        if (result === "unavailable") this.logger.warn("town_plan_task", { result });
      })
      .catch(() => {
        this.logger.error("town_plan_task", { result: "unavailable" });
      })
      .finally(() => {
        this.running.delete(key);
      });
    this.running.set(key, task);
    return "queued";
  }
}
