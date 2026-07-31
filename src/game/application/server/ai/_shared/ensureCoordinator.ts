import { NOOP_GAME_LOGGER, type GameLogger } from "@/game/logging";

// ---------------------------------------------------------------------------
// AI source 共享基础设施：后台 ensure 去重调度器。
// runtime narrative 与 town plan 的"快速启动/恢复后台生成，绝不等待 provider"
// 逻辑完全同构——差异只在"是否 pending 的判定谓词"与"执行体 + 日志 event 名"。
// 这里收敛通用部分：进程内按 key 去重（同一存档并发 ensure 只跑一次）、
// Promise 调度与 warn/error 收尾。pending 判定与执行体由调用方注入。
//
// pending 工作本身持久化在 game state 中，进程重启后同一 ensure 调用可恢复。
// ---------------------------------------------------------------------------

export type EnsureResult = "queued" | "already_running" | "not_pending" | "unavailable";

/** loadPending 结果：ok 时给出去重 key；否则直接返回终态。 */
export type EnsurePending =
  | Readonly<{ ok: true; key: string }>
  | Readonly<{ ok: false; result: EnsureResult }>;

export type BackgroundEnsureConfig = {
  /** 读取当前存档并判定是否有 pending 工作；ok 时给出去重 key。 */
  loadPending(): Promise<EnsurePending>;
  /** 执行 pending 工作；返回 "unavailable" 记 warn，抛错记 error。 */
  run(): Promise<unknown>;
  /** 结构化日志 event 名（如 runtime_narrative_task / town_plan_task）。 */
  logKey: string;
  logger?: GameLogger;
};

export class BackgroundEnsureCoordinator {
  private readonly running = new Map<string, Promise<void>>();
  // 不用 TS parameter property：Node strip-types（smoke 脚本）无法加载该语法。
  private readonly config: BackgroundEnsureConfig;
  private readonly logger: GameLogger;

  constructor(config: BackgroundEnsureConfig) {
    this.config = config;
    this.logger = config.logger ?? NOOP_GAME_LOGGER;
  }

  async ensure(): Promise<EnsureResult> {
    const pending = await this.config.loadPending();
    if (!pending.ok) return pending.result;
    const { key } = pending;
    if (this.running.has(key)) return "already_running";
    const task = Promise.resolve()
      .then(() => this.config.run())
      .then((result) => {
        if (result === "unavailable") this.logger.warn(this.config.logKey, { result });
      })
      .catch(() => {
        this.logger.error(this.config.logKey, { result: "unavailable" });
      })
      .finally(() => {
        this.running.delete(key);
      });
    this.running.set(key, task);
    return "queued";
  }
}
