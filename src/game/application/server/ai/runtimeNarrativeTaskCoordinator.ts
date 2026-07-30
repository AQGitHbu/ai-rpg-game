import {
  generatePendingNarrativeScene,
  type GeneratePendingNarrativeSceneDependencies,
} from "../../generatePendingNarrativeScene";
import { NOOP_GAME_LOGGER, type GameLogger } from "@/game/logging";

export type NarrativeEnsureResult =
  | "queued"
  | "already_running"
  | "not_pending"
  | "unavailable";

/**
 * Process-local de-duplication only. Pending work itself is persisted in the
 * game state, so a fresh process can resume it through the same ensure call.
 */
export class RuntimeNarrativeTaskCoordinator {
  private readonly running = new Map<string, Promise<void>>();

  constructor(
    private readonly deps: GeneratePendingNarrativeSceneDependencies,
    private readonly logger: GameLogger = NOOP_GAME_LOGGER,
  ) {}

  async ensure(): Promise<NarrativeEnsureResult> {
    const loaded = await this.deps.repository.getCurrentGame();
    if (!loaded.ok || loaded.status !== "active") return "unavailable";
    const { record } = loaded;
    if (
      record.state.narrative.generation.status !== "pending" ||
      record.state.narrative.currentScene !== null ||
      record.state.ending !== null ||
      record.state.battle.status === "active"
    ) {
      return "not_pending";
    }
    const key = String(record.gameId);
    if (this.running.has(key)) return "already_running";
    const task = Promise.resolve()
      .then(() => generatePendingNarrativeScene(this.deps))
      .then((result) => {
        if (result === "unavailable") this.logger.warn("runtime_narrative_task", { result });
      })
      .catch(() => {
        this.logger.error("runtime_narrative_task", { result: "unavailable" });
      })
      .finally(() => {
        this.running.delete(key);
      });
    this.running.set(key, task);
    return "queued";
  }
}
